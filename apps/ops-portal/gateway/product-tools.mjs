import { createPublicKey, verify, randomUUID } from 'node:crypto';

const OWNER = 'https://rpagentos.pages.dev';
const ORIGIN = 'https://ops.homesbliss.net';
const fields = ['manual_cost_price', 'manual_presale_arrival_date', 'presale_info_protect_until'];
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function createAccessVerifier(env, fetchFn = fetch) {
  let keys = [];
  let refreshAt = 0;
  let refreshing;
  return async (token) => {
    const issuer = env.OPS_ACCESS_ISSUER;
    const audience = env.OPS_ACCESS_AUD;
    if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience) {
      throw new Error('access_not_configured');
    }
    if (typeof token !== 'string' || token.length > 16000) throw new Error('unauthorized');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('unauthorized');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('unauthorized');
    if (Date.now() >= refreshAt) {
      refreshing ??= (async () => {
        const response = await fetchFn(`${issuer}/cdn-cgi/access/certs`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error'
        });
        if (!response.ok) throw new Error('access_keys_unavailable');
        const body = await response.json();
        if (!Array.isArray(body.keys)) throw new Error('access_keys_unavailable');
        keys = body.keys;
        refreshAt = Date.now() + 60000;
      })().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
    }
    const key = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA');
    if (
      !key ||
      !verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url')
      )
    )
      throw new Error('unauthorized');
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iss !== issuer ||
      !Array.isArray(claims.aud) ||
      !claims.aud.includes(audience) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + 30 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      typeof claims.sub !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(claims.sub)
    )
      throw new Error('unauthorized');
    return claims.sub;
  };
}

export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !fields.includes(key))) return false;
  return keys.every((key) => {
    const value = body[key];
    if (value === null) return true;
    if (key === 'manual_cost_price')
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 99999999;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
}

export function createProductTools(env = process.env, fetchFn = fetch) {
  const verifyAccess = createAccessVerifier(env, fetchFn);
  return async (req, res) => {
    const path = new URL(req.url, ORIGIN).pathname;
    if (!path.startsWith('/api/tools/products/')) return false;
    const requestId = randomUUID();
    const reply = (status, body) => {
      json(res, status, { ...body, request_id: requestId });
      return true;
    };
    const match = path.match(/^\/api\/tools\/products\/([^/]+)\/manual-fields$/);
    if (!match) return reply(404, { ok: false, error: 'route_not_found' });
    if (!['GET', 'PATCH'].includes(req.method))
      return reply(405, { ok: false, error: 'method_not_allowed' });
    let actor;
    try {
      actor = await verifyAccess(req.headers['cf-access-jwt-assertion']);
    } catch (error) {
      const unavailable =
        ['access_not_configured', 'access_keys_unavailable'].includes(error.message) ||
        error.name === 'TimeoutError' ||
        error.name === 'TypeError';
      return reply(unavailable ? 503 : 401, {
        ok: false,
        error: unavailable ? 'access_service_unavailable' : 'access_session_required'
      });
    }
    // Existing Access application policy determines the operator population.
    // '*' explicitly grants its authenticated human subjects these bounded tools.
    const subjects = (env.OPS_PRODUCT_OPERATOR_SUBJECTS || '').split(',').map((s) => s.trim());
    if (!subjects.includes('*') && !subjects.includes(actor))
      return reply(403, { ok: false, error: 'product_permission_denied' });
    if (!env.OPS_CATALOG_API_TOKEN)
      return reply(503, { ok: false, error: 'catalog_service_unavailable' });
    let itemCode;
    try {
      itemCode = decodeURIComponent(match[1]).trim();
    } catch {
      return reply(400, { ok: false, error: 'invalid_item_code' });
    }
    if (!itemCode || itemCode.length > 128 || /[\x00-\x1f\x7f/\\]/.test(itemCode))
      return reply(400, { ok: false, error: 'invalid_item_code' });
    let body;
    if (req.method === 'PATCH') {
      if (env.OPS_PRODUCT_WRITES_ENABLED !== 'true')
        return reply(403, { ok: false, error: 'product_writes_disabled' });
      if (
        req.headers.origin !== ORIGIN ||
        req.headers['content-type']?.split(';')[0].trim() !== 'application/json'
      ) {
        return reply(403, { ok: false, error: 'same_origin_json_required' });
      }
      try {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 4096)
            return reply(413, { ok: false, error: 'request_too_large' });
        }
        body = JSON.parse(raw);
        if (!validatePatch(body)) return reply(400, { ok: false, error: 'invalid_manual_fields' });
      } catch {
        return reply(400, { ok: false, error: 'invalid_json' });
      }
    }
    try {
      const response = await fetchFn(
        `${OWNER}/api/internal/catalog/sku/${encodeURIComponent(itemCode)}${req.method === 'PATCH' ? '/manual-fields' : ''}`,
        {
          method: req.method,
          headers: {
            authorization: `Bearer ${env.OPS_CATALOG_API_TOKEN}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'x-ops-actor-sub': actor,
            'x-ops-request-id': requestId
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(8000),
          redirect: 'error'
        }
      );
      // Service credentials are never repaired by logging the human in again.
      if ([401, 403].includes(response.status)) {
        console.error(
          JSON.stringify({
            event: 'catalog_service_auth_failed',
            request_id: requestId,
            upstream_status: response.status
          })
        );
        return reply(503, { ok: false, error: 'catalog_service_unavailable' });
      }
      const data = await response.json();
      if (!response.ok)
        return reply([400, 404, 409].includes(response.status) ? response.status : 502, {
          ok: false,
          error: [400, 404, 409].includes(response.status)
            ? data.error
            : 'catalog_service_unavailable'
        });
      if (!data || typeof data.item_code !== 'string') throw new Error('invalid_owner_response');
      const product = { item_code: data.item_code };
      for (const key of [...fields, 'effective_cost_price']) product[key] = data[key] ?? null;
      if (req.method === 'GET' && Object.hasOwn(data, 'effective_restock_date'))
        product.effective_restock_date = data.effective_restock_date;
      return reply(200, { ok: true, product });
    } catch {
      return reply(502, {
        ok: false,
        error: req.method === 'PATCH' ? 'save_result_unknown' : 'catalog_service_unavailable'
      });
    }
  };
}
