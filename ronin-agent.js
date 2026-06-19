'use strict';

// Ronin Forge — Citadel Agent
// Maintains an outbound WebSocket tunnel to the Ronin Citadel portal.
// Architecture mirrors RSM's ronin-agent.js: call init() with injected deps,
// then start() / stop() to connect / disconnect.

// ── Injected deps ──────────────────────────────────────────────────────────
let _performInstall;
let _getMainWindow;
let _getAppVersion;

// ── Runtime state ──────────────────────────────────────────────────────────
let _ws         = null;
let _enabled    = false;
let _portalUrl  = '';
let _agentToken = '';
let _retryDelay = 1000;
let _retryTimer = null;
let _pingTimer  = null;
let _stopping   = false;
let _status     = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

const MAX_RETRY = 60_000;

// ── Active install tracking for progress forwarding ────────────────────────
let _activeJobId    = null;
let _activeGameName = null;

// ── Public API ─────────────────────────────────────────────────────────────

function init(deps) {
    _performInstall = deps.performInstall;
    _getMainWindow  = deps.getMainWindow;
    _getAppVersion  = deps.getAppVersion || (() => '?');
}

function start(portalUrl, agentToken) {
    _stopping    = false;
    _portalUrl   = (portalUrl  || '').trim();
    _agentToken  = (agentToken || '').trim();

    if (!_portalUrl || !_agentToken) {
        console.warn('[CitadelForge] Cannot start: portalUrl or agentToken not set');
        return;
    }
    _connect();
}

function stop() {
    _stopping = true;
    _clearTimers();
    if (_ws) {
        try { _ws.close(1000, 'Forge shutdown'); } catch {}
        _ws = null;
    }
    _setStatus('disconnected');
}

function isConnected() {
    return _status === 'connected';
}

// Called by main.js when an install job starts
function notifyJobStart(jobId, gameId, gameName) {
    _activeJobId    = jobId;
    _activeGameName = gameName;
    _send({ type: 'job_start', jobId, gameId, gameName });
}

// Called by main.js on progress ticks (forwarded from install-progress IPC)
function notifyJobProgress(jobId, stage, percent, message) {
    _send({ type: 'job_progress', jobId, stage, percent, message });
}

// Called by main.js when an install finishes
function notifyJobComplete(jobId, success, gameName, installDir, rsmMethod, error) {
    _activeJobId    = null;
    _activeGameName = null;
    _send({ type: 'job_complete', jobId, success, gameName, installDir, rsmMethod, error: error || null });
}

// ── Connection ─────────────────────────────────────────────────────────────

function _connect() {
    if (_stopping) return;

    let url = _portalUrl.replace(/^http/, 'ws');
    const wsUrl = url.replace(/\/+$/, '') + '/api/agent/connect';

    _setStatus('connecting');
    console.log(`[CitadelForge] Connecting to ${wsUrl}…`);

    let WebSocket;
    try {
        WebSocket = require('ws');
    } catch {
        console.error('[CitadelForge] ws package not installed — run npm install');
        _setStatus('disconnected');
        return;
    }

    const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${_agentToken}` },
        handshakeTimeout: 10_000,
    });

    _ws = ws;

    ws.on('open', () => {
        console.log('[CitadelForge] Connected to portal');
        _retryDelay = 1000;
        _setStatus('connected');

        _send({
            type:    'announce',
            app:     'ronin-forge',
            version: _getAppVersion(),
        });

        _pingTimer = setInterval(() => {
            if (ws.readyState === ws.OPEN) ws.ping();
        }, 30_000);
    });

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        _handleMessage(msg);
    });

    ws.on('pong', () => {});

    ws.on('close', (code) => {
        _clearTimers();
        _ws = null;
        if (!_stopping) {
            console.log(`[CitadelForge] Disconnected (${code}). Reconnecting in ${_retryDelay / 1000}s…`);
            _setStatus('disconnected');
            _scheduleReconnect();
        }
    });

    ws.on('error', (err) => {
        console.error('[CitadelForge] WebSocket error:', err.message);
    });
}

function _scheduleReconnect() {
    if (_stopping) return;
    _retryTimer = setTimeout(() => {
        _retryDelay = Math.min(_retryDelay * 2, MAX_RETRY);
        _connect();
    }, _retryDelay);
}

function _clearTimers() {
    if (_pingTimer)  { clearInterval(_pingTimer);  _pingTimer  = null; }
    if (_retryTimer) { clearTimeout(_retryTimer);  _retryTimer = null; }
}

// ── Command handling ───────────────────────────────────────────────────────

function _handleMessage(msg) {
    const { type, msgId } = msg;
    console.log(`[CitadelForge] Received: ${type}`);

    const respond = (data, error) => {
        _send({ type: 'response', msgId, success: !error, data, error: error || undefined });
    };

    switch (type) {
        case 'status': {
            respond({ app: 'ronin-forge', status: 'idle' });
            break;
        }

        case 'install': {
            const { gameId, installDir, formData, gameName } = msg;
            if (!gameId || !installDir) { respond(null, 'gameId and installDir are required'); break; }

            const jobId = Date.now().toString();
            respond({ message: `Install started`, jobId });

            // Run install asynchronously without blocking the WebSocket
            (async () => {
                notifyJobStart(jobId, gameId, gameName || gameId);
                try {
                    const noop = () => {};
                    const onProgress = (stage, percent, message) => {
                        notifyJobProgress(jobId, stage, percent, message);
                    };
                    const result = await _performInstall(gameId, installDir, formData || {}, onProgress, noop, new AbortController().signal, 0);
                    notifyJobComplete(jobId, true, gameName || gameId, installDir, null);
                } catch (err) {
                    notifyJobComplete(jobId, false, gameName || gameId, installDir, null, err.message);
                }
            })();
            break;
        }

        default:
            console.warn(`[CitadelForge] Unknown command: ${type}`);
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _send(msg) {
    if (!_ws || _ws.readyState !== _ws.OPEN) return;
    try { _ws.send(JSON.stringify(msg)); } catch (e) {
        console.error('[CitadelForge] Send error:', e.message);
    }
}

function _setStatus(status) {
    _status = status;
    const win = _getMainWindow ? _getMainWindow() : null;
    if (win && !win.isDestroyed()) {
        win.webContents.send('citadel-status', status);
    }
}

module.exports = { init, start, stop, isConnected, notifyJobStart, notifyJobProgress, notifyJobComplete };
