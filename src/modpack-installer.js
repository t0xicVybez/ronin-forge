const path = require('path');
const fs = require('fs');
const os = require('os');
const extract = require('extract-zip');
const { downloadFile } = require('./downloader');

async function installModpack(source, installDir, onProgress, signal) {
    const tmpDir = path.join(os.tmpdir(), `ronin-mods-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        let mrpackPath;

        if (/^https?:\/\//i.test(source)) {
            onProgress(0, 'Downloading modpack...');
            mrpackPath = path.join(tmpDir, 'modpack.mrpack');
            await downloadFile(source, mrpackPath, (p) => {
                onProgress(Math.round(p * 0.2), `Downloading modpack... ${p}%`);
            }, signal);
        } else {
            mrpackPath = source;
        }

        onProgress(22, 'Reading modpack index...');
        const extractDir = path.join(tmpDir, 'extracted');
        await extract(mrpackPath, { dir: extractDir });

        const indexPath = path.join(extractDir, 'modrinth.index.json');
        if (!fs.existsSync(indexPath)) throw new Error('Invalid modpack: missing modrinth.index.json');

        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

        // Only install mods that are server-compatible
        const serverFiles = (index.files || []).filter(f => f.env?.server !== 'unsupported');

        let done = 0;
        for (const file of serverFiles) {
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });

            const url = file.downloads?.[0];
            if (!url) { done++; continue; }

            const destPath = path.join(installDir, file.path.replace(/\//g, path.sep));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });

            const pct = 22 + Math.round((done / serverFiles.length) * 72);
            onProgress(pct, `Installing mods... (${done + 1} / ${serverFiles.length})`);

            await downloadFile(url, destPath, null, signal);
            done++;
        }

        // Copy server-side override files bundled inside the mrpack
        for (const overrideDir of ['overrides', 'server-overrides']) {
            const src = path.join(extractDir, overrideDir);
            if (fs.existsSync(src)) copyDirSync(src, installDir);
        }

        onProgress(100, `Installed ${done} mod${done !== 1 ? 's' : ''}`);
        return { modCount: done };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

module.exports = { installModpack };
