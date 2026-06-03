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

// Connection-phase strings SteamCMD prints before download state codes appear.
// On Windows, SteamCMD often writes progress via WriteConsoleW (not stdout) when
// it detects no real TTY, so these may or may not arrive — the elapsed timer and
// disk-space polling below provide progress regardless.
const CONNECT_MESSAGES = [
    { match: 'Loading Steam API',      pct: 3,  msg: 'Loading Steam API...' },
    { match: 'Connecting anonymously', pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Connecting to Steam',    pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Logged in OK',           pct: 14, msg: 'Logged in to Steam' },
    { match: 'Waiting for user info',  pct: 18, msg: 'Fetching server info...' },
];

async function installApp(appId, installDir, onProgress, onLog, signal, expectedGB = 0) {
    await ensureSteamCMD(onProgress);

    fs.mkdirSync(installDir, { recursive: true });
    onProgress('connect', 1, 'Starting Steam...');

    const args = [
        '+force_install_dir', installDir,
        '+login', 'anonymous',
        '+app_update', String(appId), 'validate',
        '+quit'
    ];

    let lastPct      = 0;
    let stalledTimer = null;
    let downloading  = false; // true once real download bytes are confirmed
    let lastMsg      = 'Starting Steam...';

    // ── Elapsed-time counter ────────────────────────────────────────────────
    // Fires every second so the status text always changes, proving the app
    // isn't hung even when SteamCMD sends no output (WriteConsoleW bypass).
    let elapsedSec = 0;
    const elapsedTimer = setInterval(() => {
        elapsedSec++;
        if (downloading) return;
        const t = elapsedSec < 60
            ? `${elapsedSec}s`
            : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
        onProgress('connect', 20, `${lastMsg} (${t})`);
    }, 1000);

    // ── Disk-space polling ──────────────────────────────────────────────────
    // Measures how much free space has been consumed on the target drive as a
    // proxy for bytes downloaded. Works even when SteamCMD stdout is silent.
    let diskTimer  = null;
    let freeBefore = 0;
    const expectedBytes = expectedGB * 1024 * 1024 * 1024;

    try {
        const root = path.parse(installDir).root || installDir;
        const s = await fs.promises.statfs(root);
        freeBefore = s.bavail * s.bsize;

        diskTimer = setInterval(async () => {
            try {
                const s2 = await fs.promises.statfs(root);
                const usedBytes = freeBefore - s2.bavail * s2.bsize;
                // Ignore sub-10 MB changes (filesystem noise / other apps)
                if (usedBytes < 10 * 1024 * 1024 || expectedBytes <= 0) return;

                const pct = Math.min(95, Math.round((usedBytes / expectedBytes) * 100));
                if (pct > lastPct) {
                    lastPct     = pct;
                    downloading = true;
                    onProgress('download', pct, `Downloading... ~${pct}%`);
                }
            } catch {}
        }, 3000);
    } catch {}

    await runSteamCMD(args, signal, (text) => {
        if (onLog) onLog(text);

        // ── Connection-phase messages ───────────────────────────────────────
        if (!downloading) {
            for (const { match, pct, msg } of CONNECT_MESSAGES) {
                if (text.includes(match)) {
                    lastMsg = msg;
                    onProgress('connect', pct, msg);
                    return;
                }
            }
        }

        // ── State-code lines ────────────────────────────────────────────────
        // "Update state (0x61) downloading, progress: 58.32 (1234 / 5678)"
        const stateMatch = text.match(/Update state \((0x[\da-f]+)\)\s+([^,\n]+)/i);
        const pctMatch   = text.match(/progress:\s+([\d.]+)/);
        if (!stateMatch) return;

        const code  = stateMatch[1].toLowerCase();
        const label = STATE_LABELS[code] || stateMatch[2].trim();

        if (pctMatch) {
            const pct = Math.min(99, Math.round(parseFloat(pctMatch[1])));

            if (pct === 0) {
                // Still preparing (reconfiguring / preallocating) — keep shimmer
                lastMsg = `${label}...`;
                onProgress('connect', 20, `${label}...`);
                return;
            }

            // Real SteamCMD percentage is more accurate than disk polling
            downloading = true;
            const isRetry = pct < lastPct;
            lastPct = pct;
            onProgress('download', pct, isRetry ? `Retrying... ${pct}%` : `${label}... ${pct}%`);
        } else {
            lastMsg = `${label}...`;
            onProgress(downloading ? 'download' : 'connect', lastPct, `${label}...`);
        }

        if (stalledTimer) clearTimeout(stalledTimer);
        stalledTimer = setTimeout(() => {
            onProgress('download', lastPct, `Waiting for Steam CDN... ${lastPct}%`);
        }, 5000);
    });

    clearInterval(elapsedTimer);
    if (diskTimer) clearInterval(diskTimer);
    if (stalledTimer) clearTimeout(stalledTimer);
    onProgress('download', 100, 'Download complete');
}

module.exports = { ensureSteamCMD, installApp, STEAMCMD_EXE, STEAMCMD_DIR };
