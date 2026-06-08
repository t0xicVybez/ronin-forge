'use strict';

// Forge REST API — allows the Ronin Citadel portal (or other tools) to
// trigger game server installs remotely and track their progress.
// Authentication: x-api-key request header (constant-time comparison).
// All requests / responses are application/json.

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const path   = require('path');
const vm     = require('vm');
const fs     = require('fs');

const MAX_BODY = 1 * 1024 * 1024; // 1 MB request body cap

// ── Rate limiting ──────────────────────────────────────────────────────────
const _failedAuth      = new Map(); // ip → { count, lastFailure, blockedUntil }
const RATE_LIMIT_MAX   = 5;
const RATE_LIMIT_MS    = 60_000;   // block duration
const RATE_LIMIT_DECAY = 300_000;  // clear stale entries after 5 minutes

function _isRateLimited(ip) {
    const now   = Date.now();
    const entry = _failedAuth.get(ip);
    if (!entry) return false;
    if (now - entry.lastFailure > RATE_LIMIT_DECAY) { _failedAuth.delete(ip); return false; }
    return entry.blockedUntil && now < entry.blockedUntil;
}

function _recordFailure(ip) {
    const now   = Date.now();
    const entry = _failedAuth.get(ip) || { count: 0, lastFailure: 0 };
    entry.count++;
    entry.lastFailure = now;
    if (entry.count >= RATE_LIMIT_MAX) {
        entry.blockedUntil = now + RATE_LIMIT_MS;
        console.warn(`[FORGE-API] Rate limit triggered for ${ip} — blocked for ${RATE_LIMIT_MS / 1000}s`);
    }
    _failedAuth.set(ip, entry);
}

function _clearFailure(ip) { _failedAuth.delete(ip); }

// ── Injected dependencies ──────────────────────────────────────────────────
let _performInstall;
let _writeGameConfig;

// ── Runtime state ──────────────────────────────────────────────────────────
let _server      = null;
let _apiKey      = '';
let _port        = 3003;
let _cleanupTimer = null;

// In-memory job tracker
// jobId → { jobId, status, stage, percent, message, logs, result, error, abort, startedAt }
const _jobs = new Map();

// Completed jobs expire after 1 hour
const JOB_TTL_MS = 60 * 60 * 1000;

// ── Games list (loaded once, rsm/postInstall function props stripped) ───────
let _games = null;

function _loadGames() {
    if (_games) return _games;
    try {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'configs', 'games.js'),
            'utf8'
        );
        // Run games.js in a sandboxed vm context so window.GAMES is populated
        // without polluting Node globals. Functions inside rsm/postInstall are
        // created but never called — they get stripped below before serialisation.
        const ctx = { window: { GAMES: [] } };
        vm.createContext(ctx);
        vm.runInContext(src, ctx);
        _games = ctx.window.GAMES.map(({ rsm, postInstall, ...rest }) => rest);
    } catch (e) {
        console.error('[FORGE-API] Failed to load games list:', e.message);
        _games = [];
    }
    return _games;
}

// ── Public interface ────────────────────────────────────────────────────────

function init(deps) {
    _performInstall  = deps.performInstall;
    _writeGameConfig = deps.writeGameConfig;
}

// tlsOpts: { key, cert } — omit for plain HTTP (Citadel portal is on localhost)
function start(port, apiKey, tlsOpts) {
    const newPort = port   || 3003;
    const newKey  = apiKey || '';

    if (_server && _port === newPort && _apiKey === newKey) return;

    _port   = newPort;
    _apiKey = newKey;

    if (_server) { _server.close(); _server = null; }

    _server = tlsOpts
        ? https.createServer(tlsOpts, onRequest)
        : http.createServer(onRequest);

    // Bind to localhost only — the portal calls this machine-to-machine
    _server.listen(_port, '127.0.0.1', () => {
        console.log(`[FORGE-API] Listening on 127.0.0.1:${_port} (${tlsOpts ? 'HTTPS' : 'HTTP'})`);
    });
    _server.on('error', err => console.error(`[FORGE-API] Server error: ${err.message}`));

    // Prune completed/errored/cancelled jobs older than JOB_TTL_MS every 15 minutes
    if (_cleanupTimer) clearInterval(_cleanupTimer);
    _cleanupTimer = setInterval(_pruneJobs, 15 * 60 * 1000);
}

function stop() {
    if (_server) { _server.close(); _server = null; console.log('[FORGE-API] Stopped'); }
    if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; }
}

function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

// ── Core request dispatcher ─────────────────────────────────────────────────

function onRequest(req, res) {
    if (req.method === 'POST' || req.method === 'DELETE') {
        let raw = '';
        req.on('data', chunk => {
            if (raw.length + chunk.length > MAX_BODY) { req.destroy(); return; }
            raw += chunk.toString();
        });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch {}
            dispatch(req, res, body);
        });
        req.on('error', () => send(res, 400, { error: 'Bad request' }));
    } else {
        req.resume();
        req.on('end', () => dispatch(req, res, {}));
    }
}

function dispatch(req, res, body) {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    const url      = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') { send(res, 204, null); return; }

    // Health check — unauthenticated so monitors can confirm the server is alive
    if (req.method === 'GET' && url === '/api/health') {
        send(res, 200, { status: 'ok', version: '1.0' });
        return;
    }

    if (_isRateLimited(clientIp)) {
        send(res, 429, { error: 'Too many failed attempts. Try again later.' });
        return;
    }

    if (!_apiKey) { send(res, 503, { error: 'API not configured' }); return; }

    const incoming = Buffer.from(req.headers['x-api-key'] || '', 'utf8');
    const expected = Buffer.from(_apiKey, 'utf8');
    if (incoming.length !== expected.length || !crypto.timingSafeEqual(incoming, expected)) {
        _recordFailure(clientIp);
        send(res, 401, { error: 'Unauthorized' });
        return;
    }
    _clearFailure(clientIp);

    console.log(`[FORGE-API] ${req.method} ${url} — from ${clientIp}`);

    // ── GET /api/games ─────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/games') {
        send(res, 200, { games: _loadGames() });
        return;
    }

    // ── GET /api/install — list all tracked jobs ───────────────────────────
    if (req.method === 'GET' && url === '/api/install') {
        const jobs = [];
        for (const job of _jobs.values()) {
            const { abort, ...safe } = job;
            jobs.push(safe);
        }
        send(res, 200, { jobs });
        return;
    }

    // ── POST /api/install — start a new install job ────────────────────────
    if (req.method === 'POST' && url === '/api/install') {
        const { gameId, installDir, formData, gameName, diskGB } = body;

        if (!gameId || typeof gameId !== 'string') {
            send(res, 400, { error: 'gameId is required' }); return;
        }
        if (!installDir || typeof installDir !== 'string' || !installDir.trim()) {
            send(res, 400, { error: 'installDir must be a non-empty string' }); return;
        }
        if (!formData || typeof formData !== 'object') {
            send(res, 400, { error: 'formData is required' }); return;
        }

        const games = _loadGames();
        if (!games.find(g => g.id === gameId)) {
            send(res, 404, { error: `Unknown game: ${gameId}` }); return;
        }

        const jobId = crypto.randomBytes(8).toString('hex');
        const abort = new AbortController();
        const job   = {
            jobId,
            gameId,
            gameName:  gameName || gameId,
            installDir,
            status:    'running',
            stage:     'starting',
            percent:   0,
            message:   'Starting...',
            logs:      [],
            result:    null,
            error:     null,
            abort,
            startedAt: Date.now(),
        };
        _jobs.set(jobId, job);

        _runInstall(job, gameId, installDir, formData, gameName, diskGB || 0, abort.signal);

        send(res, 202, { jobId });
        return;
    }

    // ── Routes with a job ID ───────────────────────────────────────────────
    const jobMatch = url.match(/^\/api\/install\/([a-f0-9]+)$/);
    if (jobMatch) {
        const jobId = jobMatch[1];
        const job   = _jobs.get(jobId);
        if (!job) { send(res, 404, { error: 'Job not found' }); return; }

        // GET /api/install/:jobId — poll progress
        if (req.method === 'GET') {
            const { abort, ...safe } = job;
            send(res, 200, safe);
            return;
        }

        // DELETE /api/install/:jobId — cancel a running install
        if (req.method === 'DELETE') {
            if (job.status !== 'running') {
                send(res, 409, { error: `Job is already ${job.status}` }); return;
            }
            job.abort.abort();
            job.status  = 'cancelled';
            job.message = 'Cancelled by API request';
            send(res, 200, { jobId, status: 'cancelled' });
            return;
        }
    }

    send(res, 404, { error: 'Not found' });
}

// ── Install runner ──────────────────────────────────────────────────────────

async function _runInstall(job, gameId, installDir, formData, gameName, diskGB, signal) {
    const onProgress = (stage, percent, message) => {
        job.stage   = stage;
        job.percent = percent;
        job.message = message;
    };

    const onLog = (line) => {
        job.logs.push(line);
        if (job.logs.length > 500) job.logs.shift();
    };

    try {
        const result = await _performInstall(gameId, installDir, formData, onProgress, onLog, signal, diskGB);
        await _writeGameConfig(gameId, installDir, formData, result);

        job.status  = 'done';
        job.stage   = 'complete';
        job.percent = 100;
        job.message = `${gameName || gameId} installed successfully`;
        job.result  = result;
    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'Cancelled' || err.message === 'Install cancelled') {
            job.status  = 'cancelled';
            job.message = 'Install cancelled';
        } else {
            job.status  = 'error';
            job.message = err.message;
            job.error   = err.message;
            console.error(`[FORGE-API] Install job ${job.jobId} failed:`, err.message);
        }
    }
}

// ── Job cleanup ─────────────────────────────────────────────────────────────

function _pruneJobs() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of _jobs.entries()) {
        if (job.status !== 'running' && job.startedAt < cutoff) _jobs.delete(id);
    }
}

// ── Response helper ─────────────────────────────────────────────────────────

function send(res, statusCode, body) {
    const payload = body === null ? '' : JSON.stringify(body);
    const buf     = Buffer.from(payload, 'utf8');
    res.writeHead(statusCode, {
        'Content-Type':   'application/json',
        'Content-Length': buf.length,
        'Connection':     'close',
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    });
    res.end(buf);
}

module.exports = { init, start, stop, generateApiKey };
