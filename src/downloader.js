const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const axios = require('axios');

async function downloadFile(url, destPath, onProgress) {
    const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        timeout: 300000,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
    });

    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0;

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);

        response.data.on('data', (chunk) => {
            received += chunk.length;
            if (total && onProgress) onProgress(Math.round((received / total) * 100));
        });

        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

module.exports = { downloadFile };
