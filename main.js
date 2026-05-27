const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
let currentAbort = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 680,
        minWidth: 860,
        minHeight: 600,
        frame: false,
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, 'icon.png'),
    });

    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ── Window controls ─────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close', () => mainWindow.close());

// ── Folder / file pickers ────────────────────────────────────────────────────
ipcMain.handle('select-folder', async (_, { title, defaultPath } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select Folder',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openDirectory', 'createDirectory'],
    });
    return result.filePaths[0] || null;
});

ipcMain.handle('select-file', async (_, { title, filters } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select File',
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
    });
    return result.filePaths[0] || null;
});

ipcMain.handle('open-folder', async (_, folderPath) => {
    shell.openPath(folderPath);
});

// ── RSM check ────────────────────────────────────────────────────────────────
ipcMain.handle('check-rsm-installed', async () => {
    const rsm = require('./src/rsm-integration');
    return rsm.isInstalled();
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

// ── FiveM/RedM build info ────────────────────────────────────────────────────
ipcMain.handle('get-fivem-build', async () => {
    const fivem = require('./src/fivem-installer');
    const build = await fivem.install; // just verify module loads
    const axios = require('axios');
    const resp = await axios.get('https://changelogs-live.fivem.net/api/cookbook/channel/live', { timeout: 10000 });
    return resp.data.recommended || resp.data.critical || 'unknown';
});

// ── Java detection ───────────────────────────────────────────────────────────
ipcMain.handle('find-java', async () => {
    const candidates = [
        // Common Java install locations on Windows
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Microsoft',
        path.join(os.homedir(), '.jdks'),
    ];
    const found = [];
    for (const base of candidates) {
        if (!fs.existsSync(base)) continue;
        try {
            const subdirs = fs.readdirSync(base);
            for (const sub of subdirs) {
                const javaExe = path.join(base, sub, 'bin', 'java.exe');
                if (fs.existsSync(javaExe)) found.push(javaExe);
            }
        } catch {}
    }
    return found;
});

// ── Installation ─────────────────────────────────────────────────────────────
ipcMain.handle('start-install', async (event, { gameId, installDir, formData }) => {
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    const progress = (stage, percent, message) => {
        try {
            event.sender.send('install-progress', { stage, percent, message });
        } catch {}
    };

    const log = (line) => {
        try {
            event.sender.send('install-log', line);
        } catch {}
    };

    try {
        const result = await performInstall(gameId, installDir, formData, progress, log, signal);

        // Write game-specific config files
        await writeGameConfig(gameId, installDir, formData, result);

        return { success: true, installerResult: result };
    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'Cancelled' || err.message === 'Install cancelled') {
            return { success: false, cancelled: true };
        }
        return { success: false, error: err.message };
    } finally {
        currentAbort = null;
    }
});

ipcMain.on('cancel-install', () => {
    if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
    }
});

async function performInstall(gameId, installDir, formData, onProgress, onLog, signal) {
    const steam = require('./src/steamcmd');
    const mc = require('./src/minecraft-installer');
    const fivem = require('./src/fivem-installer');

    switch (gameId) {
        case 'minecraft-java':
            return mc.installVanilla(formData.mcVersion, installDir, onProgress, signal);

        case 'minecraft-forge':
            return mc.installForge(formData.mcVersion, formData.forgeVersion, installDir, formData.javaPath, onProgress, signal);

        case 'minecraft-fabric':
            return mc.installFabric(formData.mcVersion, installDir, formData.javaPath, onProgress, signal);

        case 'ark-ase':
            await steam.installApp('376030', installDir, onProgress, signal);
            return {};

        case 'ark-asa':
            await steam.installApp('2430930', installDir, onProgress, signal);
            return {};

        case 'space-engineers':
            await steam.installApp('298740', installDir, onProgress, signal);
            return {};

        case 'terraria':
            await steam.installApp('105600', installDir, onProgress, signal);
            return {};

        case 'fivem':
            return fivem.install('fivem', installDir, onProgress, signal);

        case 'redm':
            return fivem.install('redm', installDir, onProgress, signal);

        default:
            throw new Error(`Unknown game: ${gameId}`);
    }
}

async function writeGameConfig(gameId, installDir, formData, installerResult) {
    const mc = require('./src/minecraft-installer');
    const fivem = require('./src/fivem-installer');

    if (gameId === 'minecraft-java' || gameId === 'minecraft-forge' || gameId === 'minecraft-fabric') {
        mc.writeServerProperties(installDir, {
            serverName: formData.serverName,
            port: formData.port,
            maxPlayers: formData.maxPlayers,
            rconPort: formData.rconPort,
            rconPassword: formData.rconPassword,
        });
    }

    if (gameId === 'ark-ase' || gameId === 'ark-asa') {
        writeArkConfig(installDir, formData);
    }

    if (gameId === 'space-engineers') {
        writeSEConfig(installDir, formData);
    }

    if (gameId === 'fivem' || gameId === 'redm') {
        fivem.writeServerCfg(installDir, {
            serverName: formData.serverName,
            licenseKey: formData.licenseKey,
            port: formData.port,
            maxClients: formData.maxClients,
        });
    }
}

function writeArkConfig(installDir, f) {
    const configDir = path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer');
    fs.mkdirSync(configDir, { recursive: true });

    const ini = [
        '[SessionSettings]',
        `SessionName=${f.serverName}`,
        '',
        '[ServerSettings]',
        `ServerPassword=${f.serverPass || ''}`,
        `ServerAdminPassword=${f.adminPassword || 'admin'}`,
        `MaxPlayers=${f.maxPlayers || 70}`,
        'RCONEnabled=True',
        `RCONPort=${f.rconPort || 27020}`,
        '',
        '[/Script/Engine.GameSession]',
        `MaxPlayers=${f.maxPlayers || 70}`,
    ].join('\n');

    fs.writeFileSync(path.join(configDir, 'GameUserSettings.ini'), ini, 'utf8');
}

function writeSEConfig(installDir, f) {
    const cfgDir = path.join(installDir, 'DedicatedServer');
    fs.mkdirSync(cfgDir, { recursive: true });

    const xml = `<?xml version="1.0"?>
<MyConfigDedicated xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ServerName>${f.serverName || 'My Space Engineers Server'}</ServerName>
  <ListenPort>${f.port || 27016}</ListenPort>
  <MaxPlayers>${f.maxPlayers || 16}</MaxPlayers>
  <AutoRestartEnabled>false</AutoRestartEnabled>
</MyConfigDedicated>`;

    fs.writeFileSync(path.join(cfgDir, 'SpaceEngineers-Dedicated.cfg'), xml, 'utf8');
}

// ── RSM export ───────────────────────────────────────────────────────────────
ipcMain.handle('write-to-rsm', async (_, serverEntry) => {
    const rsm = require('./src/rsm-integration');
    return rsm.addServer(serverEntry);
});

ipcMain.handle('export-server-json', async (_, serverEntry) => {
    const safeName = (serverEntry.name || 'server').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Server Configuration',
        defaultPath: path.join(os.homedir(), 'Desktop', `${safeName}_rsm.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result.filePath) return { success: false };
    fs.writeFileSync(result.filePath, JSON.stringify([serverEntry], null, 2), 'utf8');
    return { success: true, exportPath: result.filePath };
});
