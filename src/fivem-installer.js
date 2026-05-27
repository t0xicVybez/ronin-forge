const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sevenZip = require('7zip-min');
const { downloadFile } = require('./downloader');

const CHANNEL_API = 'https://changelogs-live.fivem.net/api/cookbook/channel/live';

async function getLatestBuild() {
    const resp = await axios.get(CHANNEL_API, { timeout: 15000 });
    // Returns something like: { "recommended": "1234-abcdef", "critical": "..." }
    const data = resp.data;
    return data.recommended || data.critical || data.latest_recommended;
}

async function install(game, installDir, onProgress, signal) {
    fs.mkdirSync(installDir, { recursive: true });

    onProgress('fetch', 3, `Fetching latest ${game === 'fivem' ? 'FiveM' : 'RedM'} build...`);
    const build = await getLatestBuild();
    if (!build) throw new Error('Could not determine latest build from cfx.re API');

    const archiveUrl = `https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/${build}/server.7z`;

    onProgress('download', 5, `Downloading server files (build ${build})...`);
    const archivePath = path.join(installDir, '_server.7z');
    await downloadFile(archiveUrl, archivePath, (p) => {
        onProgress('download', 5 + Math.round(p * 0.75), `Downloading... ${p}%`);
    });

    onProgress('extract', 82, 'Extracting server files...');
    await extract7z(archivePath, installDir, signal);
    try { fs.unlinkSync(archivePath); } catch {}

    onProgress('config', 97, 'Writing server.cfg...');
    return { exePath: path.join(installDir, 'FXServer.exe'), build };
}

function writeServerCfg(installDir, opts) {
    const cfg = [
        `sv_hostname "${opts.serverName || 'My FiveM Server'}"`,
        `sv_projectName "${opts.serverName || 'My FiveM Server'}"`,
        '',
        `# Get your license key from: https://keymaster.fivem.net`,
        `sv_licenseKey "${opts.licenseKey || 'REPLACE_WITH_YOUR_LICENSE_KEY'}"`,
        '',
        `endpoint_add_tcp "0.0.0.0:${opts.port || 30120}"`,
        `endpoint_add_udp "0.0.0.0:${opts.port || 30120}"`,
        '',
        `sv_maxclients ${opts.maxClients || 32}`,
        '',
        '# Default resources',
        'ensure mapmanager',
        'ensure chat',
        'ensure spawnmanager',
        'ensure sessionmanager',
        'ensure basic-gamemode',
        'ensure hardcap',
        'ensure rconlog',
    ].join('\n');

    const cfgDir = path.join(installDir, 'server-data');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'server.cfg'), cfg, 'utf8');
    return cfgDir;
}

function extract7z(archivePath, destDir, signal) {
    return new Promise((resolve, reject) => {
        const proc = sevenZip.unpack(archivePath, destDir, (err) => {
            if (err) reject(err);
            else resolve();
        });

        if (signal && proc && proc.kill) {
            signal.addEventListener('abort', () => {
                proc.kill('SIGKILL');
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
            });
        }
    });
}

module.exports = { install, writeServerCfg };
