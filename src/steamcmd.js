const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const extract = require('extract-zip');
const { downloadFile } = require('./downloader');

const STEAMCMD_DIR = path.join(os.homedir(), 'AppData', 'Local', 'RoninForge', 'SteamCMD');
const STEAMCMD_EXE = path.join(STEAMCMD_DIR, 'steamcmd.exe');
const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

async function ensureSteamCMD(onProgress) {
    if (fs.existsSync(STEAMCMD_EXE)) return STEAMCMD_EXE;

    onProgress('steamcmd', 0, 'Downloading SteamCMD...');
    fs.mkdirSync(STEAMCMD_DIR, { recursive: true });

    const zipPath = path.join(STEAMCMD_DIR, 'steamcmd.zip');
    await downloadFile(STEAMCMD_URL, zipPath, (p) => {
        onProgress('steamcmd', Math.round(p * 0.5), `Downloading SteamCMD... ${p}%`);
    });

    onProgress('steamcmd', 55, 'Extracting SteamCMD...');
    await extract(zipPath, { dir: STEAMCMD_DIR });
    fs.unlinkSync(zipPath);

    onProgress('steamcmd', 70, 'Initializing SteamCMD (first run)...');
    await runSteamCMD(['+quit'], null, () => {});

    onProgress('steamcmd', 100, 'SteamCMD ready');
    return STEAMCMD_EXE;
}

function runSteamCMD(args, signal, onLine) {
    return new Promise((resolve, reject) => {
        const proc = spawn(STEAMCMD_EXE, args, { cwd: STEAMCMD_DIR });

        if (signal) {
            signal.addEventListener('abort', () => {
                proc.kill('SIGKILL');
                const err = new Error('Install cancelled');
                err.name = 'AbortError';
                reject(err);
            });
        }

        proc.stdout.on('data', (data) => onLine(data.toString()));
        proc.stderr.on('data', (data) => onLine(data.toString()));

        proc.on('close', (code) => {
            // SteamCMD exits 7 when app is already up to date — treat as success
            if (code === 0 || code === 7) resolve();
            else reject(new Error(`SteamCMD exited with code ${code}`));
        });

        proc.on('error', reject);
    });
}

const STATE_LABELS = {
    '0x3':   'Reconfiguring',
    '0x11':  'Preallocating disk',
    '0x61':  'Downloading',
    '0x65':  'Downloading',
    '0x81':  'Verifying',
    '0x101': 'Committing',
    '0x5':   'Validating',
};

async function installApp(appId, installDir, onProgress, onLog, signal) {
    await ensureSteamCMD(onProgress);

    fs.mkdirSync(installDir, { recursive: true });
    onProgress('download', 0, 'Connecting to Steam...');

    const args = [
        '+force_install_dir', installDir,
        '+login', 'anonymous',
        '+app_update', String(appId), 'validate',
        '+quit'
    ];

    let lastPct = 0;
    let stalledTimer = null;

    await runSteamCMD(args, signal, (text) => {
        if (onLog) onLog(text);

        // "Update state (0x61) downloading, progress: 58.32 (1234 / 5678)"
        const stateMatch = text.match(/Update state \((0x[\da-f]+)\)\s+([^,\n]+)/i);
        const pctMatch   = text.match(/progress:\s+([\d.]+)/);

        if (stateMatch) {
            const code  = stateMatch[1].toLowerCase();
            const label = STATE_LABELS[code] || stateMatch[2].trim();

            if (pctMatch) {
                const pct    = Math.min(99, Math.round(parseFloat(pctMatch[1])));
                const isRetry = pct < lastPct;
                lastPct = pct;
                onProgress('download', pct, isRetry ? `Retrying... ${pct}%` : `${label}... ${pct}%`);
            } else {
                onProgress('download', lastPct, `${label}...`);
            }

            // If no new output for 5 s, show a waiting message
            if (stalledTimer) clearTimeout(stalledTimer);
            stalledTimer = setTimeout(() => {
                onProgress('download', lastPct, `Waiting for Steam CDN... ${lastPct}%`);
            }, 5000);
        }
    });

    if (stalledTimer) clearTimeout(stalledTimer);
    onProgress('download', 100, 'Download complete');
}

module.exports = { ensureSteamCMD, installApp, STEAMCMD_EXE, STEAMCMD_DIR };
