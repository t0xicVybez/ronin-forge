const fs = require('fs');
const axios = require('axios');

const MAX_RETRIES = 3;

async function downloadFile(url, dest, onProgress, signal) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw makeAbortError();
        try {
            await attemptDownload(url, dest, onProgress, signal);
            return;
        } catch (err) {
            if (isAbort(err)) throw makeAbortError();
            lastErr = err;
            if (attempt < MAX_RETRIES) await sleep(1000 * attempt); // 1 s, 2 s backoff
        }
    }
    throw lastErr;
}

async function attemptDownload(url, dest, onProgress, signal) {
    // Resume from where a previous attempt left off
    let startByte = 0;
    if (fs.existsSync(dest)) startByte = fs.statSync(dest).size;

    const resp = await axios.get(url, {
        responseType: 'stream',
        timeout: 300000,
        signal: signal || undefined,
        headers: startByte > 0 ? { Range: `bytes=${startByte}-` } : {},
    });

    // 200 means the server ignored the Range header — fall back to full download
    const isResuming = startByte > 0 && resp.status === 206;
    if (!isResuming) startByte = 0;

    const contentLength = parseInt(resp.headers['content-length'] || '0', 10);
    const total = startByte + contentLength;
    let received = startByte;

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest, { flags: isResuming ? 'a' : 'w' });

        resp.data.on('data', chunk => {
            received += chunk.length;
            if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
        });

        resp.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        resp.data.on('error', reject);
    });
}

function isAbort(err) {
    return err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED';
}

function makeAbortError() {
    return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { downloadFile };
