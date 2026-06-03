const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        const valid = ['cancel-install', 'window-minimize', 'window-close', 'install-update'];
        if (valid.includes(channel)) ipcRenderer.send(channel, data);
    },
    receive: (channel, func) => {
        const valid = ['install-progress', 'install-log', 'update-available', 'update-downloaded'];
        if (valid.includes(channel)) ipcRenderer.on(channel, (_, ...args) => func(...args));
    },
    invoke: (channel, data) => {
        const valid = [
            'select-folder', 'select-file',
            'check-rsm-installed',
            'check-disk-space',
            'check-port',
            'validate-java',
            'get-minecraft-versions',
            'get-forge-versions',
            'start-install',
            'write-to-rsm',
            'export-server-json',
            'open-folder',
            'find-java',
        ];
        if (valid.includes(channel)) return ipcRenderer.invoke(channel, data);
    }
});
