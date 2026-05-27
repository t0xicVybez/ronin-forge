const path = require('path');
const fs = require('fs');
const os = require('os');

const RSM_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Ronin Server Manager');
const RSM_SERVERS_PATH = path.join(RSM_DIR, 'servers.json');

function isInstalled() {
    return fs.existsSync(RSM_DIR);
}

function readServers() {
    if (!fs.existsSync(RSM_SERVERS_PATH)) return [];
    try {
        return JSON.parse(fs.readFileSync(RSM_SERVERS_PATH, 'utf8'));
    } catch {
        return [];
    }
}

function addServer(serverEntry) {
    const servers = readServers();
    const existing = servers.findIndex(s => s.id === serverEntry.id);
    if (existing >= 0) {
        servers[existing] = serverEntry;
    } else {
        servers.push(serverEntry);
    }
    fs.mkdirSync(RSM_DIR, { recursive: true });
    fs.writeFileSync(RSM_SERVERS_PATH, JSON.stringify(servers, null, 2), 'utf8');
    return { success: true };
}

module.exports = { isInstalled, readServers, addServer, RSM_SERVERS_PATH };
