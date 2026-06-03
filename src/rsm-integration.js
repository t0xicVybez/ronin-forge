const path = require('path');
const fs = require('fs');
const os = require('os');

// Electron userData is named after productName. Check all known variants so we
// handle different RSM versions and install configurations.
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

const CANDIDATE_DIRS = [
    path.join(APPDATA, 'Ronin-Server-Manager'),  // current productName
    path.join(APPDATA, 'Ronin Server Manager'),   // older/alternate name
    path.join(APPDATA, 'ronin-server-manager'),   // lowercase fallback
];

function findRSMDir() {
    return CANDIDATE_DIRS.find(d => fs.existsSync(d)) || null;
}

function isInstalled() {
    return findRSMDir() !== null;
}

function getServersPath() {
    const dir = findRSMDir();
    return dir ? path.join(dir, 'servers.json') : null;
}

function readServers() {
    const p = getServersPath();
    if (!p || !fs.existsSync(p)) return [];
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return [];
    }
}

function addServer(serverEntry) {
    // Use the found dir, or default to the current productName if RSM isn't installed yet
    const dir = findRSMDir() || CANDIDATE_DIRS[0];
    const serversPath = path.join(dir, 'servers.json');

    const servers = readServers();
    const existing = servers.findIndex(s => s.id === serverEntry.id);
    if (existing >= 0) {
        servers[existing] = serverEntry;
    } else {
        servers.push(serverEntry);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2), 'utf8');
    return { success: true };
}

module.exports = { isInstalled, findRSMDir, readServers, addServer };
