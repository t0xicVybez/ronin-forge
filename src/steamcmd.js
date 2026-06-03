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
            if (code === 0 || code === 7) resolve();
            else reject(new Error(`SteamCMD exited with code ${code}`));
        });

        proc.on('error', reject);
    });
}

// ── Progress helpers ──────────────────────────────────────────────────────────

function getDirBytes(dir, depth = 3) {
    let total = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            try {
                const full = path.join(dir, entry.name);
                if (entry.isFile()) {
                    total += fs.statSync(full).size;
                } else if (entry.isDirectory() && depth > 0) {
                    total += getDirBytes(full, depth - 1);
                }
            } catch {}
        }
    } catch {}
    return total;
}

function formatSpeed(bps) {
    if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
    return `${Math.round(bps)} B/s`;
}

function formatETA(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return `${sec}s left`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s left`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}

// ── State-code labels ─────────────────────────────────────────────────────────

const STATE_LABELS = {
    '0x3':   'Reconfiguring',
    '0x11':  'Preallocating disk',
    '0x61':  'Downloading',
    '0x65':  'Downloading',
    '0x81':  'Verifying',
    '0x101': 'Committing',
    '0x5':   'Validating',
};

// Connection-phase strings SteamCMD may print to stdout before state codes.
// On Windows, SteamCMD often uses WriteConsoleW (bypasses stdout) when it
// detects no real TTY — these may or may not arrive.
const CONNECT_MESSAGES = [
    { match: 'Loading Steam API',      pct: 3,  msg: 'Loading Steam API...' },
    { match: 'Connecting anonymously', pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Connecting to Steam',    pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Logged in OK',           pct: 14, msg: 'Logged in to Steam' },
    { match: 'Waiting for user info',  pct: 18, msg: 'Fetching server info...' },
];

// ── Installer ─────────────────────────────────────────────────────────────────

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

    let lastPct         = 0;
    let stalledTimer    = null;
    let downloading     = false;
    let stateCodeActive = false; // true once SteamCMD stdout gives real %
    let lastMsg         = 'Starting Steam...';

    // ── Elapsed-time counter ────────────────────────────────────────────────
    // Updates the status label every second so the UI never looks frozen,
    // even when SteamCMD emits nothing via stdout.
    let elapsedSec = 0;
    const elapsedTimer = setInterval(() => {
        elapsedSec++;
        if (downloading) return;
        const t = elapsedSec < 60
            ? `${elapsedSec}s`
            : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
        onProgress('connect', 20, `${lastMsg} (${t})`);
    }, 1000);

    // ── Directory-scan progress ─────────────────────────────────────────────
    // Measures bytes written to installDir directly — more reliable than
    // statfs on Windows (which caches disk-usage figures aggressively).
    // SteamCMD writes game files to installDir progressively as chunks
    // are verified, so the size grows in step with actual download progress.
    let diskTimer   = null;
    let prevBytes   = 0;
    let prevTime    = Date.now();
    let lastSpeedBps = 0;
    const expectedBytes = expectedGB * 1024 * 1024 * 1024;

    if (expectedGB > 0) {
        diskTimer = setInterval(() => {
            if (stateCodeActive) return; // stdout progress is more accurate

            const currentBytes = getDirBytes(installDir);
            const now          = Date.now();
            const elapsedMs    = now - prevTime;
            const byteDelta    = currentBytes - prevBytes;

            if (currentBytes > 25 * 1024 * 1024) { // > 25 MB present in dir
                downloading = true;

                const rawPct = Math.min(95, Math.round((currentBytes / expectedBytes) * 100));
                // Cap single-poll jump to 20 % to guard against anomalies
                const reportPct = Math.min(lastPct + 20, rawPct);

                if (byteDelta > 0) lastSpeedBps = (byteDelta / elapsedMs) * 1000;
                const remaining = Math.max(0, expectedBytes - currentBytes);
                const etaSec    = lastSpeedBps > 0 ? Math.round(remaining / lastSpeedBps) : 0;

                let msg = `Downloading... ~${reportPct}%`;
                if (lastSpeedBps > 0)          msg += ` · ${formatSpeed(lastSpeedBps)}`;
                if (etaSec > 60 && reportPct < 94) msg += ` · ${formatETA(etaSec)}`;

                if (reportPct > lastPct) {
                    lastPct = reportPct;
                    onProgress('download', reportPct, msg);
                }
            }

            prevBytes = currentBytes;
            prevTime  = now;
        }, 5000);
    }

    // ── SteamCMD output parsing ─────────────────────────────────────────────
    await runSteamCMD(args, signal, (text) => {
        if (onLog) onLog(text);

        // Connection-phase messages
        if (!downloading) {
            for (const { match, pct, msg } of CONNECT_MESSAGES) {
                if (text.includes(match)) {
                    lastMsg = msg;
                    onProgress('connect', pct, msg);
                    return;
                }
            }
        }

        // State-code lines: "Update state (0x61) downloading, progress: 58.32 (...)"
        const stateMatch = text.match(/Update state \((0x[\da-f]+)\)\s+([^,\n]+)/i);
        const pctMatch   = text.match(/progress:\s+([\d.]+)/);
        if (!stateMatch) return;

        const code  = stateMatch[1].toLowerCase();
        const label = STATE_LABELS[code] || stateMatch[2].trim();

        if (pctMatch) {
            const pct = Math.min(99, Math.round(parseFloat(pctMatch[1])));

            if (pct === 0) {
                lastMsg = `${label}...`;
                onProgress('connect', 20, `${label}...`);
                return;
            }

            // SteamCMD is giving real percentages — disable dir-scan path
            stateCodeActive = true;
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
    if (diskTimer)   clearInterval(diskTimer);
    if (stalledTimer) clearTimeout(stalledTimer);
    onProgress('download', 100, 'Download complete');
}

module.exports = { ensureSteamCMD, installApp, STEAMCMD_EXE, STEAMCMD_DIR };
