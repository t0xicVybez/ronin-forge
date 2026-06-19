const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        const valid = [
            'cancel-install',
            'window-minimize',
            'window-close',
            'install-update',
        ];
        if (valid.includes(channel)) ipcRenderer.send(channel, data);
    },

    receive: (channel, func) => {
        const valid = [
            'install-progress',
            'install-log',
            'update-available',
            'update-downloaded',
            'citadel-status',
        ];
        if (valid.includes(channel)) ipcRenderer.on(channel, (_, ...args) => func(...args));
    },

    invoke: (channel, data) => {
        const valid = [
            'select-folder',
            'select-file',
            'open-folder',
            'check-rsm-installed',
            'get-rsm-status',
            'check-disk-space',
            'check-port',
            'validate-java',
            'find-java',
            'get-minecraft-versions',
            'get-forge-versions',
            'start-install',
            'write-to-rsm',
            'export-server-json',
            'get-api-config',
            'save-api-config',
            'generate-api-key',
            'get-agent-config',
            'save-agent-config',
        ];
        if (valid.includes(channel)) return ipcRenderer.invoke(channel, data);
    },
});
