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

// ── Helpers ───────────────────────────────────────────────────────────────────

// Parse BytesDownloaded / BytesToDownload from a SteamCMD appmanifest .acf file.
// SteamCMD updates this file in real-time as chunks are downloaded, making it
// the most reliable progress source regardless of where chunks are staged.
function readACF(acfPath) {
    try {
        const content  = fs.readFileSync(acfPath, 'utf8');
        const toMatch  = content.match(/"BytesToDownload"\s+"(\d+)"/);
        const doneMatch = content.match(/"BytesDownloaded"\s+"(\d+)"/);
        if (!toMatch || !doneMatch) return null;
        const total = parseInt(toMatch[1]);
        const done  = parseInt(doneMatch[1]);
        return total > 0 ? { total, done } : null;
    } catch { return null; }
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

// ── State-code label table ────────────────────────────────────────────────────

const STATE_LABELS = {
    '0x3':   'Reconfiguring',
    '0x11':  'Preallocating disk',
    '0x61':  'Downloading',
    '0x65':  'Downloading',
    '0x81':  'Verifying',
    '0x101': 'Committing',
    '0x5':   'Validating',
};

// Connection-phase strings SteamCMD may print before download begins.
// On Windows, WriteConsoleW bypasses stdout when no real TTY is attached,
// so these may or may not arrive — the ACF poller works regardless.
const CONNECT_MESSAGES = [
    { match: 'Loading Steam API',      pct: 3,  msg: 'Loading Steam API...' },
    { match: 'Connecting anonymously', pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Connecting to Steam',    pct: 6,  msg: 'Connecting to Steam...' },
    { match: 'Logged in OK',           pct: 14, msg: 'Logged in to Steam' },
    { match: 'Waiting for user info',  pct: 18, msg: 'Fetching server info...' },
];

// ── Installer ─────────────────────────────────────────────────────────────────

async function installApp(appId, installDir, onProgress, onLog, signal) {
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
    let stateCodeActive = false;
    let lastMsg         = 'Starting Steam...';

    // ── Elapsed-time counter ─────────────────────────────────────────────────
    // Updates the status label every second in the connect phase so the UI
    // always shows movement even when SteamCMD emits nothing via stdout.
    let elapsedSec = 0;
    const elapsedTimer = setInterval(() => {
        elapsedSec++;
        if (downloading) return;
        const t = elapsedSec < 60
            ? `${elapsedSec}s`
            : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
        onProgress('connect', 20, `${lastMsg} (${t})`);
    }, 1000);

    // ── ACF-based progress polling ───────────────────────────────────────────
    // SteamCMD writes {installDir}/steamapps/appmanifest_{appId}.acf and
    // updates BytesDownloaded inside it as each chunk is confirmed. This gives
    // exact byte-level progress without needing stdout state codes or dir scans.
    // A secondary path inside STEAMCMD_DIR covers edge-case install layouts.
    const acfPaths = [
        path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
        path.join(STEAMCMD_DIR, 'steamapps', `appmanifest_${appId}.acf`),
    ];

    let prevDone     = 0;
    let prevTime     = Date.now();
    let lastSpeedBps = 0;

    const diskTimer = setInterval(() => {
        if (stateCodeActive) return; // stdout state codes are more granular

        let acf = null;
        for (const p of acfPaths) {
            acf = readACF(p);
            if (acf) break;
        }
        if (!acf || acf.done <= 0) return;

        downloading = true;
        const now     = Date.now();
        const delta   = acf.done - prevDone;
        const elapsed = now - prevTime;

        if (delta > 0 && elapsed > 0) lastSpeedBps = (delta / elapsed) * 1000;
        prevDone = acf.done;
        prevTime = now;

        const pct = Math.min(95, Math.round((acf.done / acf.total) * 100));
        if (pct <= lastPct) return; // never go backwards

        lastPct = pct;
        const remaining = acf.total - acf.done;
        const etaSec    = lastSpeedBps > 0 ? Math.round(remaining / lastSpeedBps) : 0;

        let msg = `Downloading... ${pct}%`;
        if (lastSpeedBps > 0)         msg += ` · ${formatSpeed(lastSpeedBps)}`;
        if (etaSec > 60 && pct < 94) msg += ` · ${formatETA(etaSec)}`;

        onProgress('download', pct, msg);
    }, 3000);

    // ── SteamCMD stdout parsing ──────────────────────────────────────────────
    await runSteamCMD(args, signal, (text) => {
        if (onLog) onLog(text);

        // Connection phase
        if (!downloading) {
            for (const { match, pct, msg } of CONNECT_MESSAGES) {
                if (text.includes(match)) {
                    lastMsg = msg;
                    onProgress('connect', pct, msg);
                    return;
                }
            }
        }

        // "Update state (0x61) downloading, progress: 58.32 (1234 / 5678)"
        const stateMatch = text.match(/Update state \((0x[\da-f]+)\)\s+([^,\n]+)/i);
        const pctMatch   = text.match(/progress:\s+([\d.]+)/);
        if (!stateMatch) return;

        const code  = stateMatch[1].toLowerCase();
        const label = STATE_LABELS[code] || stateMatch[2].trim();

        if (pctMatch) {
            const pct = Math.min(99, Math.round(parseFloat(pctMatch[1])));

            if (pct === 0) {
                lastMsg = `${label}...`;
                // Once downloading, stay in download stage — the final
                // Reconfiguring/Committing pass also reports 0% and must not
                // flip the bar back to the animated connect shimmer.
                onProgress(downloading ? 'download' : 'connect', lastPct, `${label}...`);
                return;
            }

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
    clearInterval(diskTimer);
    if (stalledTimer) clearTimeout(stalledTimer);
    onProgress('download', 100, 'Download complete');
}

module.exports = { ensureSteamCMD, installApp, STEAMCMD_EXE, STEAMCMD_DIR };
