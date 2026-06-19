const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');


const apiServer = require('./src/api-server');
const agent     = require('./ronin-agent');

app.setAppUserModelId('Ronin Forge');

let mainWindow;
let currentAbort = null;

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:     1100,
        height:    720,
        minWidth:  900,
        minHeight: 600,
        frame:     false,
        backgroundColor: '#080808',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
        icon: path.join(__dirname, 'icon.png'),
    });
    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(async () => {
    createWindow();

    // REST API
    apiServer.init({ performInstall, writeGameConfig });
    const apiCfg = await loadApiConfig();
    if (apiCfg.enabled) apiServer.start(apiCfg.port, apiCfg.apiKey);

    // Citadel agent
    agent.init({
        performInstall,
        getMainWindow:  () => mainWindow,
        getAppVersion:  () => app.getVersion(),
    });
    const agentCfg = await loadAgentConfig();
    if (agentCfg.enabled && agentCfg.portalUrl && agentCfg.agentToken) {
        agent.start(agentCfg.portalUrl, agentCfg.agentToken);
    }

    // Auto-updater (packaged builds only)
    if (app.isPackaged) {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.on('update-available',  () => mainWindow?.webContents.send('update-available'));
        autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update-downloaded'));
        autoUpdater.on('error', err => console.error('Updater:', err.message));
        autoUpdater.checkForUpdates();
    }
});

app.on('window-all-closed', () => { agent.stop(); app.quit(); });

ipcMain.on('install-update', () => {
    if (app.isPackaged) require('electron-updater').autoUpdater.quitAndInstall();
});

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close',    () => mainWindow?.close());

// ── Folder / file pickers ────────────────────────────────────────────────────
ipcMain.handle('select-folder', async (_, { title, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
        title:      title || 'Select Folder',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openDirectory', 'createDirectory'],
    });
    return r.filePaths[0] || null;
});

ipcMain.handle('select-file', async (_, { title, filters } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
        title:   title || 'Select File',
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
    });
    return r.filePaths[0] || null;
});

ipcMain.handle('open-folder', async (_, folderPath) => {
    shell.openPath(folderPath);
});

// ── RSM ──────────────────────────────────────────────────────────────────────
ipcMain.handle('check-rsm-installed', async () => {
    const rsm = require('./src/rsm-integration');
    return rsm.isInstalled();
});

ipcMain.handle('get-rsm-status', async () => {
    const rsm = require('./src/rsm-integration');
    return rsm.getRSMStatus();
});

// ── Minecraft version lists ──────────────────────────────────────────────────
ipcMain.handle('get-minecraft-versions', async () => {
    const mc = require('./src/minecraft-installer');
    const versions = await mc.getVersionManifest();
    return versions.map(v => v.id);
});

ipcMain.handle('get-forge-versions', async (_, mcVersion) => {
    const mc = require('./src/minecraft-installer');
    return mc.getForgeVersions(mcVersion);
});

// ── Disk space ───────────────────────────────────────────────────────────────
ipcMain.handle('check-disk-space', async (_, { installDir, requiredGB }) => {
    try {
        const root  = path.parse(installDir).root || installDir;
        const stats = await fs.promises.statfs(root);
        const freeGB = (stats.bavail * stats.bsize) / (1024 ** 3);
        return { freeGB: Math.round(freeGB * 10) / 10, sufficient: freeGB >= requiredGB };
    } catch {
        return { freeGB: null, sufficient: true };
    }
});

// ── Port check ────────────────────────────────────────────────────────────────
ipcMain.handle('check-port', async (_, { port }) => {
    const net   = require('net');
    const dgram = require('dgram');

    const checkTCP = () => new Promise(resolve => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', () => resolve(true));
        srv.listen({ port, host: '0.0.0.0' }, () => srv.close(() => resolve(false)));
    });

    const checkUDP = () => new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.on('error', () => resolve(true));
        sock.bind(port, '0.0.0.0', () => sock.close(() => resolve(false)));
    });

    const [tcp, udp] = await Promise.all([checkTCP(), checkUDP()]);
    return { inUse: tcp || udp };
});

// ── Java ──────────────────────────────────────────────────────────────────────
ipcMain.handle('validate-java', async (_, { javaPath, mcVersion }) => {
    try {
        const { spawnSync } = require('child_process');
        const result = spawnSync(`"${javaPath}"`, ['-version'], {
            shell: true, encoding: 'utf8', timeout: 5000,
        });
        const output = result.stderr || result.stdout || '';
        const match  = output.match(/version "(\d+)(?:\.(\d+))?/);
        if (!match) return { valid: false, error: 'Could not read Java version' };
        const first  = parseInt(match[1]);
        const actual = first === 1 ? parseInt(match[2] || '0') : first;
        const needed = getRequiredJava(mcVersion);
        return {
            valid:  actual >= needed,
            actual,
            needed,
            error: actual < needed ? `Java ${needed}+ required, found Java ${actual}` : null,
        };
    } catch (e) {
        return { valid: false, error: e.message };
    }
});

function getRequiredJava(mcVersion) {
    const parts = (mcVersion || '').split('.').map(Number);
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
}

ipcMain.handle('find-java', async () => {
    const { execSync } = require('child_process');
    const found = [];
    try {
        const out = execSync('where java', { timeout: 3000 }).toString();
        out.split('\n').map(p => p.trim()).filter(p => p.endsWith('.exe')).forEach(p => {
            if (p && !found.includes(p)) found.push(p);
        });
    } catch {}
    const candidates = [
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Microsoft',
        path.join(os.homedir(), '.jdks'),
    ];
    for (const base of candidates) {
        if (!fs.existsSync(base)) continue;
        try {
            for (const sub of fs.readdirSync(base)) {
                const exe = path.join(base, sub, 'bin', 'java.exe');
                if (fs.existsSync(exe) && !found.includes(exe)) found.push(exe);
            }
        } catch {}
    }
    return found;
});

// ── Installation ──────────────────────────────────────────────────────────────
ipcMain.handle('start-install', async (event, { gameId, installDir, formData, diskGB, gameName, mrpackSource }) => {
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    const jobId = Date.now().toString();

    const progress = (stage, percent, message) => {
        try {
            event.sender.send('install-progress', { stage, percent, message });
            agent.notifyJobProgress(jobId, stage, percent, message);
        } catch {}
    };

    const log = (line) => {
        try { event.sender.send('install-log', line); } catch {}
    };

    agent.notifyJobStart(jobId, gameId, gameName || gameId);

    try {
        const result = await performInstall(gameId, installDir, formData, progress, log, signal, diskGB || 0);
        await writeGameConfig(gameId, installDir, formData, result);

        if (mrpackSource) {
            const mods = require('./src/modpack-installer');
            await mods.installModpack(mrpackSource, installDir, (pct, msg) => {
                progress('mods', pct, msg);
            }, signal);
        }

        // Auto-push to RSM
        let rsmMethod = null;
        if (result !== null) {
            try {
                const rsm         = require('./src/rsm-integration');
                const serverEntry = buildRSMEntry(gameId, installDir, formData, result);
                if (serverEntry) {
                    const rsmResult = await rsm.addServer(serverEntry);
                    rsmMethod       = rsmResult.method || null;
                }
            } catch (e) {
                console.warn('[Forge] Auto-RSM push failed:', e.message);
            }
        }

        if (Notification.isSupported()) {
            new Notification({
                title: 'Ronin Forge',
                body:  `${gameName || 'Server'} is ready!`,
            }).show();
        }

        agent.notifyJobComplete(jobId, true, gameName, installDir, rsmMethod);
        return { success: true, installerResult: result, rsmMethod };

    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'Cancelled' || err.message === 'Install cancelled') {
            agent.notifyJobComplete(jobId, false, gameName, installDir, null, 'Cancelled');
            return { success: false, cancelled: true };
        }
        agent.notifyJobComplete(jobId, false, gameName, installDir, null, err.message);
        return { success: false, error: err.message };
    } finally {
        currentAbort = null;
    }
});

ipcMain.on('cancel-install', () => {
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
});

async function performInstall(gameId, installDir, formData, onProgress, onLog, signal, diskGB) {
    const steam = require('./src/steamcmd');
    const mc    = require('./src/minecraft-installer');

    switch (gameId) {
        case 'minecraft-java':
            return mc.installVanilla(formData.mcVersion, installDir, onProgress, signal);

        case 'minecraft-forge':
            return mc.installForge(formData.mcVersion, formData.forgeVersion, installDir, formData.javaPath, onProgress, onLog, signal);

        case 'minecraft-fabric':
            return mc.installFabric(formData.mcVersion, installDir, formData.javaPath, onProgress, onLog, signal);

        case 'ark-ase':
            await steam.installApp('376030', installDir, onProgress, onLog, signal);
            scaffoldArkConfigs(installDir, formData.serverName);
            return { configNote: { message: 'Edit your server settings in:', path: path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.ini') }};

        case 'ark-asa':
            await steam.installApp('2430930', installDir, onProgress, onLog, signal);
            scaffoldArkConfigs(installDir, formData.serverName);
            return { configNote: { message: 'Edit your server settings in:', path: path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.ini') }};

        case 'space-engineers':
            await steam.installApp('298740', installDir, onProgress, onLog, signal);
            return { configNote: { message: 'Start your server once to generate its config, then edit:', path: path.join(installDir, 'Instance', 'SpaceEngineers-Dedicated.cfg') }};

        case 'terraria':
            await steam.installApp('105600', installDir, onProgress, onLog, signal);
            return {};

        case 'valheim':
            await steam.installApp('896660', installDir, onProgress, onLog, signal);
            return {};

        case 'rust':
            await steam.installApp('258550', installDir, onProgress, onLog, signal);
            return {};

        case 'project-zomboid':
            await steam.installApp('108600', installDir, onProgress, onLog, signal);
            return {};

        case '7-days-to-die':
            await steam.installApp('294420', installDir, onProgress, onLog, signal);
            return {};

        case 'conan-exiles':
            await steam.installApp('443030', installDir, onProgress, onLog, signal);
            return { configNote: { message: 'Start your server once to generate config, then edit:', path: path.join(installDir, 'ConanSandbox', 'Saved', 'Config', 'WindowsServer') }};

        case 'palworld':
            await steam.installApp('2394010', installDir, onProgress, onLog, signal);
            return {};

        case 'v-rising':
            await steam.installApp('1829350', installDir, onProgress, onLog, signal);
            return {};

        case 'satisfactory':
            await steam.installApp('1690800', installDir, onProgress, onLog, signal);
            return {};

        default:
            throw new Error(`Unknown game: ${gameId}`);
    }
}

function scaffoldArkConfigs(installDir, serverName) {
    const src  = path.join(installDir, 'ShooterGame', 'Config');
    const dest = path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer');
    try {
        fs.mkdirSync(dest, { recursive: true });
        const copies = [
            ['DefaultGame.ini',             'Game.ini'],
            ['DefaultGameUserSettings.ini', 'GameUserSettings.ini'],
        ];
        for (const [srcName, destName] of copies) {
            const srcFile  = path.join(src,  srcName);
            const destFile = path.join(dest, destName);
            if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
                fs.copyFileSync(srcFile, destFile);
            }
        }
        if (serverName) {
            const guiPath = path.join(dest, 'GameUserSettings.ini');
            if (fs.existsSync(guiPath)) {
                let content = fs.readFileSync(guiPath, 'utf8');
                content     = setIniValue(content, 'SessionSettings', 'SessionName', serverName);
                fs.writeFileSync(guiPath, content, 'utf8');
            }
        }
    } catch {}
}

function setIniValue(content, section, key, value) {
    const header  = `[${section}]`;
    const keyLine = new RegExp(`^${key}=.*$`, 'im');
    if (content.includes(header)) {
        if (keyLine.test(content)) return content.replace(keyLine, `${key}=${value}`);
        return content.replace(header, `${header}\r\n${key}=${value}`);
    }
    return `${content.trimEnd()}\r\n\r\n${header}\r\n${key}=${value}\r\n`;
}

async function writeGameConfig(gameId, installDir, formData, installerResult) {
    const mc = require('./src/minecraft-installer');
    if (['minecraft-java','minecraft-forge','minecraft-fabric'].includes(gameId)) {
        mc.writeServerProperties(installDir, {
            serverName:   formData.serverName,
            port:         formData.port,
            maxPlayers:   formData.maxPlayers,
            rconPort:     formData.rconPort,
            rconPassword: formData.rconPassword,
        });
    }
    if (gameId === '7-days-to-die') write7DTDConfig(installDir, formData);
}

function write7DTDConfig(installDir, f) {
    const serverName    = f.serverName    || 'My 7 Days to Die Server';
    const serverPass    = f.serverPass    || '';
    const adminPassword = f.adminPassword || 'admin';
    const maxPlayers    = f.maxPlayers    || 8;
    const port          = parseInt(f.port)        || 26900;
    const telnetPort    = parseInt(f.telnetPort)  || 8081;
    const mapName       = f.mapName       || 'Navezgane';

    const xml = `<?xml version="1.0"?>
<ServerSettings>
  <property name="ServerName"                 value="${serverName}"/>
  <property name="ServerDescription"          value=""/>
  <property name="ServerPassword"             value="${serverPass}"/>
  <property name="ServerPort"                 value="${port}"/>
  <property name="ServerVisibility"           value="2"/>
  <property name="ServerMaxPlayerCount"       value="${maxPlayers}"/>
  <property name="ServerReservedSlots"        value="0"/>
  <property name="ServerAdminSlots"           value="1"/>
  <property name="ServerAdminSlotsPermission" value="0"/>
  <property name="GameWorld"                  value="${mapName}"/>
  <property name="WorldGenSeed"               value="asdf"/>
  <property name="WorldGenSize"               value="6144"/>
  <property name="GameName"                   value="${serverName}"/>
  <property name="GameMode"                   value="GameModeSurvival"/>
  <property name="GameDifficulty"             value="2"/>
  <property name="DayNightLength"             value="60"/>
  <property name="DayLightLength"             value="18"/>
  <property name="BloodMoonFrequency"         value="7"/>
  <property name="BloodMoonEnemyCount"        value="8"/>
  <property name="EnemySpawnMode"             value="true"/>
  <property name="DropOnDeath"                value="1"/>
  <property name="TelnetEnabled"              value="true"/>
  <property name="TelnetPort"                 value="${telnetPort}"/>
  <property name="TelnetPassword"             value="${adminPassword}"/>
  <property name="TerminalWindowEnabled"      value="true"/>
  <property name="AdminFileName"              value="serveradmin.xml"/>
</ServerSettings>`;

    fs.writeFileSync(path.join(installDir, 'serverconfig.xml'), xml, 'utf8');
}

// Build an RSM entry from game config definitions
function buildRSMEntry(gameId, installDir, formData, installerResult) {
    // Load GAMES from the public config file (main process read)
    try {
        const gamesPath = path.join(__dirname, 'public', 'configs', 'games.js');
        const src       = fs.readFileSync(gamesPath, 'utf8');
        // Eval in a scoped context to get GAMES array (games.js sets window.GAMES)
        const scope = { window: {} };
        const fn    = new Function('window', src);
        fn(scope.window);
        const GAMES = scope.window.GAMES || [];
        const game  = GAMES.find(g => g.id === gameId);
        if (!game || !game.rsm) return null;

        const rsm = game.rsm;
        const f   = formData;
        const dir = installDir;
        const ir  = installerResult;
        const ev  = (val) => typeof val === 'function' ? val(f, dir, ir) : val;

        return {
            id:                Date.now().toString(),
            name:              f.serverName || game.displayName,
            type:              rsm.type,
            category:          rsm.category,
            path:              ev(rsm.path),
            workingDir:        ev(rsm.workingDir),
            args:              ev(rsm.args),
            playerListCommand: rsm.playerListCommand || null,
            apiPort:           ev(rsm.apiPort) || '',
            apiPass:           ev(rsm.apiPass) || '',
            logPath:           ev(rsm.logPath) || '',
            status:            'Offline',
            pid:               null,
            logs:              '',
        };
    } catch (e) {
        console.warn('[Forge] buildRSMEntry failed:', e.message);
        return null;
    }
}

// ── Manual RSM write (user-triggered from complete screen) ───────────────────
ipcMain.handle('write-to-rsm', async (_, serverEntry) => {
    const rsm = require('./src/rsm-integration');
    return rsm.addServer(serverEntry);
});

ipcMain.handle('export-server-json', async (_, serverEntry) => {
    const safeName = (serverEntry.name || 'server').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const result   = await dialog.showSaveDialog(mainWindow, {
        title:       'Export Server Configuration',
        defaultPath: path.join(os.homedir(), 'Desktop', `${safeName}_rsm.json`),
        filters:     [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result.filePath) return { success: false };
    fs.writeFileSync(result.filePath, JSON.stringify([serverEntry], null, 2), 'utf8');
    return { success: true, exportPath: result.filePath };
});

// ── API server config ─────────────────────────────────────────────────────────
function getApiConfigPath() {
    return path.join(app.getPath('userData'), 'forge-api-config.json');
}

async function loadApiConfig() {
    try {
        const raw = await fs.promises.readFile(getApiConfigPath(), 'utf8');
        return { enabled: false, port: 3003, apiKey: '', ...JSON.parse(raw) };
    } catch {
        return { enabled: false, port: 3003, apiKey: '' };
    }
}

async function saveApiConfig(cfg) {
    await fs.promises.writeFile(getApiConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

ipcMain.handle('get-api-config', async () => loadApiConfig());

ipcMain.handle('save-api-config', async (_, cfg) => {
    await saveApiConfig(cfg);
    if (cfg.enabled) apiServer.start(cfg.port, cfg.apiKey);
    else             apiServer.stop();
    return { success: true };
});

ipcMain.handle('generate-api-key', () => apiServer.generateApiKey());

// ── Citadel agent config ──────────────────────────────────────────────────────
function getAgentConfigPath() {
    return path.join(app.getPath('userData'), 'citadel-agent.json');
}

async function loadAgentConfig() {
    try {
        const raw = await fs.promises.readFile(getAgentConfigPath(), 'utf8');
        return { enabled: false, portalUrl: '', agentToken: '', ...JSON.parse(raw) };
    } catch {
        return { enabled: false, portalUrl: '', agentToken: '' };
    }
}

ipcMain.handle('get-agent-config', async () => loadAgentConfig());

ipcMain.handle('save-agent-config', async (_, cfg) => {
    await fs.promises.writeFile(getAgentConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
    agent.stop();
    if (cfg.enabled && cfg.portalUrl && cfg.agentToken) {
        agent.start(cfg.portalUrl, cfg.agentToken);
    }
    return { success: true };
});
