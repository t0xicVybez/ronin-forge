const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { downloadFile } = require('./downloader');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_PROMOS = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json';

async function getVersionManifest() {
    const resp = await axios.get(VERSION_MANIFEST, { timeout: 15000 });
    return resp.data.versions
        .filter(v => v.type === 'release')
        .map(v => ({ id: v.id, url: v.url }));
}

async function getServerJarUrl(versionId) {
    const versions = await getVersionManifest();
    const entry = versions.find(v => v.id === versionId);
    if (!entry) throw new Error(`MC version ${versionId} not found`);
    const meta = await axios.get(entry.url, { timeout: 15000 });
    return meta.data.downloads.server.url;
}

async function getForgeVersions(mcVersion) {
    try {
        const resp = await axios.get(FORGE_PROMOS, { timeout: 15000 });
        const promos = resp.data.promos;
        const results = [];
        const rec = promos[`${mcVersion}-recommended`];
        const lat = promos[`${mcVersion}-latest`];
        if (rec) results.push({ id: `${mcVersion}-${rec}`, label: `${mcVersion}-${rec} (Recommended)` });
        if (lat && lat !== rec) results.push({ id: `${mcVersion}-${lat}`, label: `${mcVersion}-${lat} (Latest)` });
        return results;
    } catch {
        return [];
    }
}

async function installVanilla(versionId, installDir, onProgress, signal) {
    fs.mkdirSync(installDir, { recursive: true });

    onProgress('fetch', 3, 'Fetching version metadata...');
    const jarUrl = await getServerJarUrl(versionId);

    onProgress('download', 5, 'Downloading server.jar...');
    await downloadFile(jarUrl, path.join(installDir, 'server.jar'), (p) => {
        onProgress('download', 5 + Math.round(p * 0.9), `Downloading server.jar... ${p}%`);
    });

    onProgress('config', 97, 'Writing initial config...');
    fs.writeFileSync(path.join(installDir, 'eula.txt'), 'eula=true\n', 'utf8');

    onProgress('done', 100, 'Complete');
    return { type: 'jar', jarName: 'server.jar' };
}

async function installForge(mcVersion, forgeFullVersion, installDir, javaPath, onProgress, onLog, signal) {
    fs.mkdirSync(installDir, { recursive: true });

    const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeFullVersion}/forge-${forgeFullVersion}-installer.jar`;

    onProgress('download', 5, `Downloading Forge ${forgeFullVersion} installer...`);
    const installerPath = path.join(installDir, '_forge-installer.jar');
    await downloadFile(installerUrl, installerPath, (p) => {
        onProgress('download', 5 + Math.round(p * 0.45), `Downloading Forge installer... ${p}%`);
    });

    onProgress('install', 52, 'Running Forge installer (this may take a few minutes)...');

    // Slowly advance the bar so the user sees movement during the long install.
    // Asymptotic curve toward 89% — never reaches it, so we never overshoot.
    let forgePct = 52;
    const forgeTimer = setInterval(() => {
        forgePct = Math.min(89, forgePct + Math.max(0.05, (89 - forgePct) * 0.004));
        onProgress('install', Math.round(forgePct), 'Running Forge installer (this may take a few minutes)...');
    }, 1000);

    try {
        await runJava(javaPath, ['-jar', installerPath, '--installServer'], installDir, signal, onLog);
    } finally {
        clearInterval(forgeTimer);
    }
    try { fs.unlinkSync(installerPath); } catch {}

    onProgress('config', 97, 'Writing initial config...');
    fs.writeFileSync(path.join(installDir, 'eula.txt'), 'eula=true\n', 'utf8');

    onProgress('done', 100, 'Complete');

    const files = fs.readdirSync(installDir);
    const runBat = files.find(f => f === 'run.bat');
    const universalJar = files.find(f => /^forge-.+-universal\.jar$/.test(f));
    return { type: runBat ? 'bat' : 'jar', runBat, universalJar };
}

async function installFabric(mcVersion, installDir, javaPath, onProgress, onLog, signal) {
    fs.mkdirSync(installDir, { recursive: true });

    onProgress('fetch', 3, 'Fetching Fabric installer version...');
    const metaResp = await axios.get('https://maven.fabricmc.net/net/fabricmc/fabric-installer/maven-metadata.xml', { timeout: 15000 });
    const verMatch = metaResp.data.match(/<release>(.*?)<\/release>/);
    const fabricVer = verMatch ? verMatch[1] : '1.0.1';

    const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${fabricVer}/fabric-installer-${fabricVer}.jar`;

    onProgress('download', 5, `Downloading Fabric installer ${fabricVer}...`);
    const installerPath = path.join(installDir, '_fabric-installer.jar');
    await downloadFile(installerUrl, installerPath, (p) => {
        onProgress('download', 5 + Math.round(p * 0.45), `Downloading Fabric installer... ${p}%`);
    });

    onProgress('install', 52, 'Installing Fabric server...');

    let fabricPct = 52;
    const fabricTimer = setInterval(() => {
        fabricPct = Math.min(89, fabricPct + Math.max(0.05, (89 - fabricPct) * 0.004));
        onProgress('install', Math.round(fabricPct), 'Installing Fabric server...');
    }, 1000);

    try {
        await runJava(javaPath, ['-jar', installerPath, 'server', '-mcversion', mcVersion, '-downloadMinecraft'], installDir, signal, onLog);
    } finally {
        clearInterval(fabricTimer);
    }
    try { fs.unlinkSync(installerPath); } catch {}

    onProgress('config', 97, 'Writing initial config...');
    fs.writeFileSync(path.join(installDir, 'eula.txt'), 'eula=true\n', 'utf8');

    onProgress('done', 100, 'Complete');
    return { type: 'jar', jarName: 'fabric-server-launch.jar' };
}

function writeServerProperties(installDir, opts) {
    const lines = [
        `server-port=${opts.port || 25565}`,
        `max-players=${opts.maxPlayers || 20}`,
        `motd=${opts.serverName || 'A Minecraft Server'}`,
        `enable-rcon=${opts.rconPassword ? 'true' : 'false'}`,
        `rcon.port=${opts.rconPort || 25575}`,
        `rcon.password=${opts.rconPassword || ''}`,
        'online-mode=true',
        'difficulty=easy',
        'gamemode=survival',
    ];
    fs.writeFileSync(path.join(installDir, 'server.properties'), lines.join('\n'), 'utf8');
}

function runJava(javaPath, args, cwd, signal, onLog) {
    return new Promise((resolve, reject) => {
        const proc = spawn(javaPath, args, { cwd, stdio: 'pipe' });

        if (signal) {
            signal.addEventListener('abort', () => {
                proc.kill('SIGKILL');
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
            });
        }

        // Drain stdout/stderr — required to prevent the OS pipe buffer from
        // filling and deadlocking the Java process. Forward to log if provided.
        proc.stdout.on('data', (d) => { if (onLog) onLog(d.toString()); });
        proc.stderr.on('data', (d) => { if (onLog) onLog(d.toString()); });

        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

module.exports = { getVersionManifest, getForgeVersions, installVanilla, installForge, installFabric, writeServerProperties };
