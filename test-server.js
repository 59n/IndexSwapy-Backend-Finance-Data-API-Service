const http = require('http');
const { handler } = require('./functions/indexswapy');

const PORT = 8888;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4096;

function sendJson(res, statusCode, payload) {
    if (res.headersSent) return;
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let rejected = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES && !rejected) {
                rejected = true;
                const error = new Error('Payload too large');
                error.statusCode = 413;
                reject(error);
                req.resume();
                return;
            }
            if (!rejected) chunks.push(chunk);
        });
        req.on('end', () => {
            if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
            sendJson(res, 413, { status: 'error', message: 'Payload too large' });
            req.resume();
            return;
        }

        const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
            ? await readBody(req)
            : undefined;

        const event = {
            httpMethod: req.method,
            path: req.url,
            headers: {
                ...req.headers,
                'x-forwarded-for': req.socket.remoteAddress,
            },
            body,
        };

        const result = await handler(event);
        Object.entries(result.headers || {}).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.statusCode = result.statusCode;
        res.end(result.body || '');
    } catch (error) {
        sendJson(res, error.statusCode || 500, {
            status: 'error',
            message: error.statusCode === 413 ? 'Payload too large' : 'Internal server error',
        });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
    console.log('Test endpoints:');
    console.log(`http://${HOST}:${PORT}/`);
    console.log(`http://${HOST}:${PORT}/api/ratios`);
    console.log(`http://${HOST}:${PORT}/ratios`);
    console.log(`http://${HOST}:${PORT}/data`);
});
