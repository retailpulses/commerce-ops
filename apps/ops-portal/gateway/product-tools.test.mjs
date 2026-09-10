import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { createProductTools, createAccessVerifier, validatePatch } from './product-tools.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test' };
const env = {
  OPS_ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
  OPS_ACCESS_AUD: 'ops-audience',
  OPS_CATALOG_API_TOKEN: 'server-only',
  OPS_PRODUCT_OPERATOR_SUBJECTS: '*',
  OPS_PRODUCT_WRITES_ENABLED: 'true'
};
function jwt(changes = {}, key = privateKey) {
  const claims = {
    iss: env.OPS_ACCESS_ISSUER,
    aud: [env.OPS_ACCESS_AUD],
    sub: 'real-operator',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...changes
  };
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

test('Access verifies signature, issuer, audience, expiry and subject', async () => {
  const verify = createAccessVerifier(env, async () => Response.json({ keys: [jwk] }));
  assert.equal(await verify(jwt()), 'real-operator');
  for (const token of [
    undefined,
    jwt({ aud: ['wrong'] }),
    jwt({ iss: 'https://bad.test' }),
    jwt({ exp: 1 }),
    jwt({ sub: '' }),
    jwt({ nbf: 9999999999 }),
    jwt({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)
  ]) {
    await assert.rejects(() => verify(token));
  }
});

test('three field contract rejects invalid values rather than clearing', () => {
  for (const body of [
    {},
    { price: 5 },
    { manual_cost_price: 0 },
    { manual_cost_price: 'abc' },
    { manual_cost_price: Infinity },
    { manual_presale_arrival_date: '2026-02-30' }
  ])
    assert.equal(validatePatch(body), false);
  assert.equal(
    validatePatch({ manual_cost_price: null, presale_info_protect_until: '2026-09-09' }),
    true
  );
});

async function harness(t, overrides = {}, ownerStatus = 200) {
  const calls = [];
  const handler = createProductTools({ ...env, ...overrides }, async (url, init) => {
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    calls.push({ url, ...init });
    return Response.json(
      ownerStatus === 200
        ? {
            item_code: 'ABC',
            manual_cost_price: 10,
            effective_cost_price: 10,
            ...(init.method === 'GET' ? { effective_restock_date: '2026-09-30' } : {})
          }
        : { error: 'unauthorized' },
      { status: ownerStatus }
    );
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/tools/products/ABC/manual-fields`;
  const request = (options = {}) =>
    fetch(url, {
      ...options,
      headers: {
        'cf-access-jwt-assertion': jwt(),
        origin: 'https://ops.homesbliss.net',
        'content-type': 'application/json',
        ...options.headers
      }
    });
  return { calls, request };
}

test('independent GET/PATCH send server identity, exact dirty body, no caller headers', async (t) => {
  const { request, calls } = await harness(t);
  assert.equal((await request()).status, 200);
  const response = await request({
    method: 'PATCH',
    body: JSON.stringify({ manual_cost_price: null }),
    headers: { authorization: 'Bearer evil', 'x-ops-actor-sub': 'fake', 'x-ops-request-id': 'fake' }
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['x-ops-actor-sub'], 'real-operator');
  assert.notEqual(calls[1].headers['x-ops-request-id'], 'fake');
  assert.equal(calls[1].headers.authorization, 'Bearer server-only');
  assert.equal(calls[1].body, '{"manual_cost_price":null}');
  assert.match(
    calls[1].url,
    /^https:\/\/rpagentos.pages.dev\/api\/internal\/catalog\/sku\/ABC\/manual-fields$/
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const patchProduct = (await response.json()).product;
  assert.equal(patchProduct.effective_cost_price, 10);
  assert.equal(Object.hasOwn(patchProduct, 'effective_restock_date'), false);
  const getProduct = (await (await request()).json()).product;
  assert.equal(getProduct.effective_restock_date, '2026-09-30');
});

test('owner auth failure does not prompt human login', async (t) => {
  for (const status of [401, 403]) {
    const { request } = await harness(t, {}, status);
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'catalog_service_unavailable');
  }
});

test('invalid Access, capability, origin, kill switch and body fail before owner', async (t) => {
  const { request, calls } = await harness(t);
  assert.equal((await request({ headers: { 'cf-access-jwt-assertion': 'fake' } })).status, 401);
  assert.equal(
    (await request({ method: 'PATCH', body: '{}', headers: { origin: 'https://evil.test' } }))
      .status,
    403
  );
  assert.equal((await request({ method: 'PATCH', body: '{"manual_cost_price":0}' })).status, 400);
  assert.equal(calls.length, 0);
  const denied = await harness(t, { OPS_PRODUCT_OPERATOR_SUBJECTS: 'someone-else' });
  assert.equal((await denied.request()).status, 403);
  assert.equal(denied.calls.length, 0);
  const disabled = await harness(t, { OPS_PRODUCT_WRITES_ENABLED: 'false' });
  assert.equal(
    (await disabled.request({ method: 'PATCH', body: '{"manual_cost_price":1}' })).status,
    403
  );
  assert.equal(disabled.calls.length, 0);
});
