const assert = require('assert');
const { handler, _internal } = require('../functions/indexswapy');

const SAMPLE_SCRIPT = `
    let es_spy_ratio = /* ES_SPY_RATIO */ 10.059244391207226;
    let nq_qqq_ratio = /* NQ_QQQ_RATIO */ 41.24465000690322;
    let ndx_qqq_ratio = /* NDX_QQQ_RATIO */ 41.10098439872981;
`;

const CACHED = {
    'NDX/QQQ Ratio': 40,
    'NQ/QQQ Ratio': 41,
    'ES/SPY Ratio': 10,
};

function event(overrides) {
    return {
        httpMethod: 'GET',
        path: '/ratios',
        headers: {},
        ...overrides,
    };
}

async function run() {
    _internal.resetState();

    assert.strictEqual(
        _internal.parseRatio(SAMPLE_SCRIPT, 'ES/SPY Ratio', _internal.RATIO_PATTERNS['ES/SPY Ratio']),
        10.059244391207226
    );
    assert.strictEqual(
        _internal.parseRatio(SAMPLE_SCRIPT, 'NQ/QQQ Ratio', _internal.RATIO_PATTERNS['NQ/QQQ Ratio']),
        41.24465000690322
    );
    assert.strictEqual(
        _internal.parseRatio(SAMPLE_SCRIPT, 'NDX/QQQ Ratio', _internal.RATIO_PATTERNS['NDX/QQQ Ratio']),
        41.10098439872981
    );

    assert.throws(() => {
        _internal.parseRatio('let es_spy_ratio = 9999;', 'ES/SPY Ratio', _internal.RATIO_PATTERNS['ES/SPY Ratio']);
    }, /Invalid/);

    assert.strictEqual(_internal.requestPath({ path: '/.netlify/functions/indexswapy/api/ratios' }), '/api/ratios');
    assert.strictEqual(_internal.requestPath({ path: '/ratios?x=1' }), '/ratios');
    assert.strictEqual(_internal.requestPath({ path: '/.netlify/functions/indexswapy/' }), '/');

    const allowed = _internal.corsHeaders({ headers: { origin: 'https://indexswapy.netlify.app' } });
    assert.strictEqual(allowed['Access-Control-Allow-Origin'], 'https://indexswapy.netlify.app');
    const local = _internal.corsHeaders({ headers: { origin: 'http://localhost:60257' } });
    assert.strictEqual(local['Access-Control-Allow-Origin'], 'http://localhost:60257');
    const denied = _internal.corsHeaders({ headers: { origin: 'https://evil.example' } });
    assert.strictEqual(denied['Access-Control-Allow-Origin'], undefined);
    assert.ok(denied['X-Content-Type-Options']);

    const parsed = _internal.parseConversionBody({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'qqq_to_ndx', value: 400 }),
    });
    assert.deepStrictEqual(parsed, { type: 'qqq_to_ndx', value: 400 });

    assert.throws(() => {
        _internal.parseConversionBody({
            headers: { 'content-type': 'text/plain' },
            body: '{}',
        });
    }, (err) => err.statusCode === 415);

    assert.throws(() => {
        _internal.parseConversionBody({
            headers: { 'content-type': 'application/json' },
            body: '{not json',
        });
    }, (err) => err.statusCode === 400 && err.message === 'Invalid JSON');

    assert.throws(() => {
        _internal.parseConversionBody({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'hack', value: 1 }),
        });
    }, (err) => err.statusCode === 400);

    assert.throws(() => {
        _internal.parseConversionBody({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'qqq_to_ndx', value: -1 }),
        });
    }, (err) => err.statusCode === 400);

    assert.throws(() => {
        _internal.parseConversionBody({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'qqq_to_ndx', value: 9_999_999 }),
        });
    }, (err) => err.statusCode === 400);

    _internal.setCache(CACHED, Date.now());

    const options = await handler(event({ httpMethod: 'OPTIONS' }));
    assert.strictEqual(options.statusCode, 204);

    const put = await handler(event({ httpMethod: 'PUT' }));
    assert.strictEqual(put.statusCode, 405);

    const missing = await handler(event({ path: '/nope' }));
    assert.strictEqual(missing.statusCode, 404);

    const ratios = await handler(event({ path: '/api/ratios' }));
    assert.strictEqual(ratios.statusCode, 200);
    const ratioBody = JSON.parse(ratios.body);
    assert.strictEqual(ratioBody.status, 'ok');
    assert.strictEqual(ratioBody.ratios['NDX/QQQ Ratio'], 40);

    const converted = await handler(event({
        httpMethod: 'POST',
        path: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'qqq_to_ndx', value: 400 }),
    }));
    assert.strictEqual(converted.statusCode, 200);
    assert.strictEqual(JSON.parse(converted.body).result, 16000);

    const badPost = await handler(event({
        httpMethod: 'POST',
        path: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'hack', value: 1 }),
    }));
    assert.strictEqual(badPost.statusCode, 400);
    assert.ok(!/stack|SyntaxError/i.test(badPost.body));

    _internal.resetState();
    _internal.setCache(CACHED, Date.now());
    let limited = 0;
    for (let i = 0; i < 65; i += 1) {
        const res = await handler(event({
            path: '/ratios',
            headers: { 'x-nf-client-connection-ip': '203.0.113.9' },
        }));
        if (res.statusCode === 429) limited += 1;
    }
    assert.ok(limited >= 5, `expected rate limit 429s, got ${limited}`);

    console.log('backend tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
