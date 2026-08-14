const axios = require('axios');
const cheerio = require('cheerio');

const RATIO_SOURCE_URL = 'https://spyconverter.com/converter.html';
const FETCH_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SCRAPE_BYTES = 512 * 1024;
const SCRAPE_TIMEOUT_MS = 8000;
const MAX_POST_BYTES = 4096;
const MAX_CONVERSION_VALUE = 1_000_000;
const MIN_RATIO = 0.5;
const MAX_RATIO = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_MAX_KEYS = 5000;

const ALLOWED_ORIGINS = new Set([
    'https://indexswapy.netlify.app',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:5500',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:8080',
]);

const CONVERSIONS = {
    qqq_to_ndx: (value, ratios) => value * ratios['NDX/QQQ Ratio'],
    qqq_to_nq: (value, ratios) => value * ratios['NQ/QQQ Ratio'],
    nq_to_qqq: (value, ratios) => value / ratios['NQ/QQQ Ratio'],
    ndx_to_qqq: (value, ratios) => value / ratios['NDX/QQQ Ratio'],
    es_to_spy: (value, ratios) => value / ratios['ES/SPY Ratio'],
    spy_to_es: (value, ratios) => value * ratios['ES/SPY Ratio'],
};

const RATIO_PATTERNS = {
    'ES/SPY Ratio': /let es_spy_ratio\s*=(?:\s|\/\*[\s\S]*?\*\/)*(\d+(?:\.\d+)?)\s*;/,
    'NQ/QQQ Ratio': /let nq_qqq_ratio\s*=(?:\s|\/\*[\s\S]*?\*\/)*(\d+(?:\.\d+)?)\s*;/,
    'NDX/QQQ Ratio': /let ndx_qqq_ratio\s*=(?:\s|\/\*[\s\S]*?\*\/)*(\d+(?:\.\d+)?)\s*;/,
};

let cachedRatios = null;
let lastFetchTime = 0;
let inFlightFetch = null;
const rateLimitHits = new Map();

function header(headers, name) {
    if (!headers) return undefined;
    const lower = name.toLowerCase();
    const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
    return key ? headers[key] : undefined;
}

function clientIp(event) {
    const netlifyIp = header(event.headers, 'x-nf-client-connection-ip');
    if (netlifyIp) return String(netlifyIp).split(',')[0].trim();
    const forwarded = header(event.headers, 'x-forwarded-for');
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return 'unknown';
}

function pruneRateLimits(now) {
    if (rateLimitHits.size < RATE_LIMIT_MAX_KEYS) {
        for (const [ip, rec] of rateLimitHits) {
            if (now - rec.start > RATE_LIMIT_WINDOW_MS) rateLimitHits.delete(ip);
        }
        return;
    }
    rateLimitHits.clear();
}

function isRateLimited(ip) {
    const now = Date.now();
    pruneRateLimits(now);
    const rec = rateLimitHits.get(ip);
    if (!rec || now - rec.start > RATE_LIMIT_WINDOW_MS) {
        rateLimitHits.set(ip, { count: 1, start: now });
        return false;
    }
    rec.count += 1;
    return rec.count > RATE_LIMIT_MAX;
}

function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    try {
        const url = new URL(origin);
        return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    } catch {
        return false;
    }
}

function corsHeaders(event) {
    const origin = header(event.headers, 'origin');
    const allowed = isAllowedOrigin(origin) ? origin : null;
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin',
    };
    if (allowed) {
        headers['Access-Control-Allow-Origin'] = allowed;
    }
    return headers;
}

function json(event, statusCode, payload, extraHeaders) {
    return {
        statusCode,
        headers: { ...corsHeaders(event), ...(extraHeaders || {}) },
        body: JSON.stringify(payload),
    };
}

function parseRatio(scriptContent, label, pattern) {
    const match = scriptContent.match(pattern);
    if (!match) {
        throw new Error(`Missing ${label}`);
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < MIN_RATIO || value > MAX_RATIO) {
        throw new Error(`Invalid ${label}`);
    }
    return value;
}

async function scrapeRatios() {
    const response = await axios.get(RATIO_SOURCE_URL, {
        timeout: SCRAPE_TIMEOUT_MS,
        maxRedirects: 3,
        maxContentLength: MAX_SCRAPE_BYTES,
        maxBodyLength: MAX_SCRAPE_BYTES,
        responseType: 'text',
        transitional: { clarifyTimeoutError: true },
        validateStatus: (status) => status === 200,
        headers: {
            Accept: 'text/html',
            'Accept-Language': 'en',
        },
    });

    const $ = cheerio.load(String(response.data || ''), { xmlMode: false });
    let scriptContent = '';
    for (const script of $('script').toArray()) {
        const content = $(script).text();
        if (
            content.includes('es_spy_ratio') &&
            content.includes('nq_qqq_ratio') &&
            content.includes('ndx_qqq_ratio')
        ) {
            scriptContent = content;
            break;
        }
    }
    if (!scriptContent) {
        throw new Error('Ratio script not found');
    }

    return {
        'NDX/QQQ Ratio': parseRatio(scriptContent, 'NDX/QQQ Ratio', RATIO_PATTERNS['NDX/QQQ Ratio']),
        'NQ/QQQ Ratio': parseRatio(scriptContent, 'NQ/QQQ Ratio', RATIO_PATTERNS['NQ/QQQ Ratio']),
        'ES/SPY Ratio': parseRatio(scriptContent, 'ES/SPY Ratio', RATIO_PATTERNS['ES/SPY Ratio']),
    };
}

async function getRatios() {
    const now = Date.now();
    if (cachedRatios && now - lastFetchTime < FETCH_INTERVAL_MS) {
        return cachedRatios;
    }
    if (!inFlightFetch) {
        inFlightFetch = scrapeRatios()
            .then((ratios) => {
                cachedRatios = ratios;
                lastFetchTime = Date.now();
                return cachedRatios;
            })
            .catch((error) => {
                if (cachedRatios) {
                    console.error('Using stale ratios after fetch failure');
                    return cachedRatios;
                }
                throw error;
            })
            .finally(() => {
                inFlightFetch = null;
            });
    }
    return inFlightFetch;
}

function requestPath(event) {
    const raw = String(event.path || '/');
    const stripped = raw.replace(/^\/\.netlify\/functions\/indexswapy/, '') || '/';
    const pathname = stripped.split('?')[0];
    return pathname.replace(/\/+$/, '') || '/';
}

function parseConversionBody(event) {
    const contentType = String(header(event.headers, 'content-type') || '');
    if (!contentType.toLowerCase().includes('application/json')) {
        throw Object.assign(new Error('Unsupported content type'), { statusCode: 415 });
    }

    if (event.body == null) {
        throw Object.assign(new Error('Missing request body'), { statusCode: 400 });
    }

    const rawBody = typeof event.body === 'string'
        ? event.body
        : JSON.stringify(event.body);
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_POST_BYTES) {
        throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
    }

    let parsed;
    try {
        parsed = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
        throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw Object.assign(new Error('Invalid request body'), { statusCode: 400 });
    }

    const { type, value } = parsed;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(CONVERSIONS, type)) {
        throw Object.assign(new Error('Invalid conversion type'), { statusCode: 400 });
    }

    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_CONVERSION_VALUE) {
        throw Object.assign(new Error('Invalid value'), { statusCode: 400 });
    }

    return { type, value: numeric };
}

exports._internal = {
    parseConversionBody,
    parseRatio,
    requestPath,
    corsHeaders,
    RATIO_PATTERNS,
    resetState() {
        cachedRatios = null;
        lastFetchTime = 0;
        inFlightFetch = null;
        rateLimitHits.clear();
    },
    setCache(ratios, fetchedAt) {
        cachedRatios = ratios;
        lastFetchTime = fetchedAt || Date.now();
    },
};

exports.handler = async (event) => {
    const method = String(event.httpMethod || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(event), body: '' };
    }

    if (method !== 'GET' && method !== 'POST') {
        return json(event, 405, { status: 'error', message: 'Method not allowed' }, { Allow: 'GET, POST, OPTIONS' });
    }

    if (isRateLimited(clientIp(event))) {
        return json(event, 429, { status: 'error', message: 'Too many requests' }, { 'Retry-After': '60' });
    }

    if (method === 'POST') {
        let parsed;
        try {
            parsed = parseConversionBody(event);
        } catch (error) {
            const statusCode = error.statusCode || 400;
            return json(event, statusCode, {
                status: 'error',
                message: error.statusCode ? error.message : 'Invalid request',
            });
        }

        try {
            const ratios = await getRatios();
            const result = CONVERSIONS[parsed.type](parsed.value, ratios);
            if (!Number.isFinite(result)) {
                return json(event, 500, { status: 'error', message: 'Conversion failed' });
            }
            return json(event, 200, {
                status: 'ok',
                result: Number(result.toFixed(2)),
            });
        } catch (error) {
            console.error('Unable to load ratios:', error && error.message);
            return json(event, 503, {
                status: 'error',
                message: 'Service temporarily unavailable',
            });
        }
    }

    const path = requestPath(event);
    if (path !== '/ratios' && path !== '/api/ratios' && path !== '/data' && path !== '/') {
        return json(event, 404, { status: 'error', message: 'Endpoint not found' });
    }

    try {
        const ratios = await getRatios();
        return json(event, 200, {
            status: 'ok',
            timestamp: new Date().toISOString(),
            ratios,
            ...(path === '/' ? { endpoints: ['/ratios', '/api/ratios', '/data'] } : {}),
        });
    } catch (error) {
        console.error('Unable to load ratios:', error && error.message);
        return json(event, 503, {
            status: 'error',
            message: 'Service temporarily unavailable',
        });
    }
};
