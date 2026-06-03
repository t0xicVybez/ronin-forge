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
    // Derives approximate download % from free-space delta on the install drive.
    // Works even when SteamCMD stdout is silent (WriteConsoleW bypass on Windows).
    //
    // Two safeguards against false readings:
    //   1. 15 s grace period — lets SteamCMD initialize and self-update before
    //      we take a baseline, so those writes don't count as game download.
    //   2. 20 % cap per poll — prevents a single anomalous measurement from
    //      jumping the bar to an unrealistic value.
    let diskTimer        = null;
    let stateCodeWorking = false; // true once SteamCMD stdout gives real progress
    const expectedBytes  = expectedGB * 1024 * 1024 * 1024;

    if (expectedGB > 0) {
        try {
            const root        = path.parse(installDir).root || installDir;
            const GRACE_MS    = 15_000;
            const startAt     = Date.now() + GRACE_MS;
            let freeBefore    = 0;
            let baselineTaken = false;

            diskTimer = setInterval(async () => {
                if (stateCodeWorking)     return; // state-code path is more accurate
                if (Date.now() < startAt) return; // still in grace period

                try {
                    const s    = await fs.promises.statfs(root);
                    const free = s.bavail * s.bsize;

                    if (!baselineTaken) {
                        // First tick after grace — capture post-init baseline
                        freeBefore    = free;
                        baselineTaken = true;
                        return;
                    }

                    const usedBytes = freeBefore - free;
                    if (usedBytes < 25 * 1024 * 1024) return; // ignore < 25 MB noise

                    const rawPct    = Math.min(95, Math.round((usedBytes / expectedBytes) * 100));
                    // Cap single-poll jump to 20 % to guard against measurement spikes
                    const reportPct = Math.min(lastPct + 20, rawPct);

                    if (reportPct > lastPct) {
                        lastPct     = reportPct;
                        downloading = true;
                        onProgress('download', reportPct, `Downloading... ~${reportPct}%`);
                    }
                } catch {}
            }, 5000);
        } catch {}
    }

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
            downloading      = true;
            stateCodeWorking = true;
            const isRetry    = pct < lastPct;
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
