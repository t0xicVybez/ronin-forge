const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
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

// ── Network stats ─────────────────────────────────────────────────────────────
// Returns total bytes received across all adapters since adapter init.
// Queried via PowerShell Get-NetAdapterStatistics which is always available
// on Windows 10/11 and reflects real NIC counters regardless of SteamCMD
// internal staging behaviour.
function getNetBytesReceived() {
    try {
        const r = spawnSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command',
             '(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum'],
            { encoding: 'utf8', timeout: 4000, windowsHide: true }
        );
        return parseInt((r.stdout || '').trim()) || 0;
    } catch { return 0; }
}

// ── ACF reader ────────────────────────────────────────────────────────────────
// SteamCMD writes {installDir}/steamapps/appmanifest_{appId}.acf with
// BytesToDownload and BytesDownloaded. Used for percentage only — it may
// not be available or updated on all setups, so it is optional.
function readACF(acfPath) {
    try {
        const content   = fs.readFileSync(acfPath, 'utf8');
        const toMatch   = content.match(/"BytesToDownload"\s+"(\d+)"/);
        const doneMatch = content.match(/"BytesDownloaded"\s+"(\d+)"/);
        if (!toMatch || !doneMatch) return null;
        const total = parseInt(toMatch[1]);
        const done  = parseInt(doneMatch[1]);
        return total > 0 ? { total, done } : null;
    } catch { return null; }
}

// ── Format helpers ────────────────────────────────────────────────────────────
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

    // Snapshot network bytes before SteamCMD touches anything.
    // All bytes received after this point are attributed to the download.
    const netBaseline = getNetBytesReceived();

    const args = [
        '+force_install_dir', installDir,
        '+login', 'anonymous',
        '+app_update', String(appId), 'validate',
        '+quit'
    ];

    let lastPct        = 0;
    let downloading    = false;
    let lastLabel      = 'Downloading';  // updated by stdout state codes
    let lastMsg        = 'Starting Steam...';

    // ── Elapsed-time counter (connect phase) ─────────────────────────────────
    let elapsedSec = 0;
    const elapsedTimer = setInterval(() => {
        elapsedSec++;
        if (downloading) return;
        const t = elapsedSec < 60
            ? `${elapsedSec}s`
            : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
        onProgress('connect', 20, `${lastMsg} (${t})`);
    }, 1000);

    // ── Network-based progress polling ───────────────────────────────────────
    // Sole source of truth for % and speed. Polls every 1 s regardless of
    // what SteamCMD stdout says. Speed = delta/interval; % = cumBytes/acfTotal.
    // ACF provides the total; network bytes provide the consumed amount.
    // This never goes stale: a tick always fires and always emits an update.
    const acfPaths = [
        path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`),
        path.join(STEAMCMD_DIR, 'steamapps', `appmanifest_${appId}.acf`),
    ];

    let prevNetBytes   = netBaseline;
    let prevPollTime   = Date.now();
    let smoothSpeedBps = 0;  // EMA — drives the speed display only
    let acfTotal       = 0;

    // Rolling 30-second window of {bytes, ts} samples — drives ETA only.
    // Using total bytes at each sample point so the window is self-contained:
    // windowBps = (newest.bytes - oldest.bytes) / (newest.ts - oldest.ts)
    const WINDOW_SEC  = 30;
    const speedWindow = []; // { bytes: cumulative NIC bytes, ts: ms }

    const netTimer = setInterval(() => {
        const netNow  = getNetBytesReceived();
        const now     = Date.now();
        const delta   = Math.max(0, netNow - prevNetBytes);
        const elapsed = Math.max(1, now - prevPollTime) / 1000;

        // EMA (α=0.35) — responsive, used for speed label display only
        if (delta > 0) {
            const instantBps = delta / elapsed;
            smoothSpeedBps = smoothSpeedBps === 0
                ? instantBps
                : 0.35 * instantBps + 0.65 * smoothSpeedBps;
        } else {
            smoothSpeedBps *= 0.7; // decay when idle so display clears
        }

        prevNetBytes = netNow;
        prevPollTime = now;

        const downloadedBytes = Math.max(0, netNow - netBaseline);

        // Wait for at least 2 MB before switching to download phase
        if (downloadedBytes < 2 * 1024 * 1024) return;
        downloading = true;

        // Maintain rolling window — push current sample, evict anything older
        // than WINDOW_SEC seconds so the window always reflects recent history
        speedWindow.push({ bytes: netNow, ts: now });
        while (speedWindow.length > 1 && (now - speedWindow[0].ts) > WINDOW_SEC * 1000) {
            speedWindow.shift();
        }

        // Window speed = total bytes across the window / window duration.
        // With ≥2 samples this is a true time-average; before that fall back
        // to the EMA so ETA appears immediately rather than waiting 30 s.
        let windowBps = smoothSpeedBps;
        if (speedWindow.length >= 2) {
            const oldest   = speedWindow[0];
            const newest   = speedWindow[speedWindow.length - 1];
            const winBytes = newest.bytes - oldest.bytes;
            const winSec   = Math.max(1, newest.ts - oldest.ts) / 1000;
            windowBps = winBytes / winSec;
        }

        // Refresh ACF total on every tick until we have it (file may appear late)
        if (acfTotal === 0) {
            for (const p of acfPaths) {
                const acf = readACF(p);
                if (acf && acf.total > 0) { acfTotal = acf.total; break; }
            }
        }

        const spd = smoothSpeedBps > 1024 ? formatSpeed(smoothSpeedBps) : null;

        if (acfTotal > 0) {
            const pct = Math.min(95, Math.round((downloadedBytes / acfTotal) * 100));
            lastPct = Math.max(lastPct, pct); // never go backwards

            const remaining = Math.max(0, acfTotal - downloadedBytes);
            const etaSec    = windowBps > 0 ? Math.round(remaining / windowBps) : 0;

            let msg = `${lastLabel}... ${lastPct}%`;
            if (spd)                          msg += ` · ${spd}`;
            if (etaSec > 30 && lastPct < 95) msg += ` · ${formatETA(etaSec)}`;

            onProgress('download', lastPct, msg);
        } else {
            const msg = spd ? `${lastLabel}... ${spd}` : `${lastLabel}...`;
            onProgress('download', lastPct, msg);
        }
    }, 1000);

    // ── SteamCMD stdout parsing ──────────────────────────────────────────────
    // Only used for: (a) connect-phase labels, (b) non-download phase labels
    // (Preallocating, Verifying, Committing). Does NOT drive the progress bar.
    await runSteamCMD(args, signal, (text) => {
        if (onLog && !text.trimStart().startsWith('Update state')) onLog(text);

        if (!downloading) {
            for (const { match, pct, msg } of CONNECT_MESSAGES) {
                if (text.includes(match)) {
                    lastMsg = msg;
                    onProgress('connect', pct, msg);
                    return;
                }
            }
        }

        const stateMatch = text.match(/Update state \((0x[\da-f]+)\)\s+([^,\n]+)/i);
        if (!stateMatch) return;

        const code  = stateMatch[1].toLowerCase();
        const label = STATE_LABELS[code] || stateMatch[2].trim();

        // Keep lastLabel fresh so the network timer uses the right verb
        lastLabel = label;
    });

    clearInterval(elapsedTimer);
    clearInterval(netTimer);
    onProgress('download', 100, 'Download complete');
}

module.exports = { ensureSteamCMD, installApp, STEAMCMD_EXE, STEAMCMD_DIR };
