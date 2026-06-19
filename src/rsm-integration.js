'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

const CANDIDATE_DIRS = [
    path.join(APPDATA, 'Ronin-Server-Manager'),
    path.join(APPDATA, 'Ronin Server Manager'),
    path.join(APPDATA, 'ronin-server-manager'),
];

// ── Directory helpers ────────────────────────────────────────────────────────

function findRSMDir() {
    return CANDIDATE_DIRS.find(d => fs.existsSync(d)) || null;
}

function isInstalled() {
    return findRSMDir() !== null;
}

// ── Config auto-detection ────────────────────────────────────────────────────

function findRSMConfig() {
    const dir = findRSMDir();
    if (!dir) return null;
    const cfgPath = path.join(dir, 'api-config.json');
    if (!fs.existsSync(cfgPath)) return null;
    try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg.enabled && cfg.port && cfg.apiKey) {
            return { port: cfg.port, apiKey: cfg.apiKey };
        }
    } catch {}
    return null;
}

// ── Live API calls ───────────────────────────────────────────────────────────

function httpGet(url, apiKey) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers: { 'x-api-key': apiKey } }, (res) => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, data: null }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function httpPost(url, apiKey, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const opts = {
            method:  'POST',
            headers: {
                'x-api-key':     apiKey,
                'Content-Type':  'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = http.request(url, opts, (res) => {
            let data = '';
            res.on('data', d => { data += d; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data: null }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(payload);
        req.end();
    });
}

async function isRSMApiReachable(port) {
    try {
        const r = await httpGet(`http://127.0.0.1:${port}/api/health`, '');
        return r.status < 500;
    } catch {
        return false;
    }
}

async function getServersViaApi({ port, apiKey }) {
    const r = await httpGet(`http://127.0.0.1:${port}/api/servers`, apiKey);
    return Array.isArray(r.data) ? r.data : (r.data?.servers || []);
}

async function addServerViaApi(serverEntry, { port, apiKey }) {
    const r = await httpPost(`http://127.0.0.1:${port}/api/servers`, apiKey, serverEntry);
    if (r.status >= 200 && r.status < 300) {
        return { success: true, id: r.data?.id };
    }
    throw new Error(`RSM API returned ${r.status}`);
}

// ── File-based fallback ──────────────────────────────────────────────────────

function readServers() {
    const dir = findRSMDir();
    if (!dir) return [];
    const p = path.join(dir, 'servers.json');
    if (!fs.existsSync(p)) return [];
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function addServerViaFile(serverEntry) {
    const dir    = findRSMDir() || CANDIDATE_DIRS[0];
    const p      = path.join(dir, 'servers.json');
    const list   = readServers();
    const idx    = list.findIndex(s => s.id === serverEntry.id);
    if (idx >= 0) list[idx] = serverEntry;
    else          list.push(serverEntry);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf8');
    return { success: true };
}

// ── Main export: addServer ───────────────────────────────────────────────────
// Tries live API first; falls back to servers.json write.

async function addServer(serverEntry) {
    const cfg = findRSMConfig();
    if (cfg) {
        const reachable = await isRSMApiReachable(cfg.port);
        if (reachable) {
            try {
                const result = await addServerViaApi(serverEntry, cfg);
                return { success: true, method: 'api', ...result };
            } catch (e) {
                console.warn('[RSM] Live API push failed, falling back to file:', e.message);
            }
        }
    }
    const result = addServerViaFile(serverEntry);
    return { ...result, method: 'file' };
}

// ── Get status + server list ─────────────────────────────────────────────────

async function getRSMStatus() {
    const cfg = findRSMConfig();
    if (!cfg) {
        return { online: false, url: null, servers: [], serverCount: 0 };
    }
    const url = `http://127.0.0.1:${cfg.port}`;
    try {
        const reachable = await isRSMApiReachable(cfg.port);
        if (!reachable) return { online: false, url, servers: [], serverCount: 0 };
        const servers = await getServersViaApi(cfg);
        return { online: true, url, servers, serverCount: servers.length };
    } catch {
        return { online: false, url, servers: [], serverCount: 0 };
    }
}

module.exports = { isInstalled, findRSMDir, findRSMConfig, readServers, addServer, getRSMStatus };
