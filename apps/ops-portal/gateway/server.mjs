import http from 'node:http';
import https from 'node:https';
import { createProductTools } from './product-tools.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8090);
const RELEASE_SHA = process.env.RELEASE_SHA || 'unknown';

const routes = [
  { prefix: '/inquiry/', origin: 'https://inquiry-dashboard.pages.dev', strip: '/inquiry' },
  {
    prefix: '/tickets/',
    origin: 'https://mercari-ticket-reports.jim-yang-3c5.workers.dev',
    strip: ''
  },
  { prefix: '/order/', origin: 'http://127.0.0.1:8080', strip: '' },
  { prefix: '/', origin: 'https://ops-portal-39f.pages.dev', strip: '' }
];

const deniedRequestHeaders = new Set([
  'connection',
  'content-length',
  'cf-access-client-id',
  'cf-access-client-secret',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'x-ops-portal-proxy-secret'
]);
const deniedResponseHeaders = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade'
]);

function routeFor(pathname) {
  return routes.find((route) => pathname.startsWith(route.prefix));
}

function upstreamPath(route, requestUrl) {
  const url = new URL(requestUrl, 'http://gateway.local');
  if (route.strip && url.pathname.startsWith(`${route.strip}/`)) {
    url.pathname = url.pathname.slice(route.strip.length) || '/';
  }
  return `${url.pathname}${url.search}`;
}

function requestHeaders(req, upstream, route) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!deniedRequestHeaders.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  headers.host = upstream.host;
  if (route.prefix === '/tickets/') headers['accept-encoding'] = 'identity';
  headers['x-forwarded-host'] = req.headers.host || 'ops.homesbliss.net';
  headers['x-forwarded-proto'] = 'https';
  if (
    upstream.protocol === 'https:' &&
    process.env.CF_ACCESS_CLIENT_ID &&
    process.env.CF_ACCESS_CLIENT_SECRET
  ) {
    headers['cf-access-client-id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['cf-access-client-secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  if (route.prefix === '/tickets/' && process.env.TICKETS_PROXY_TOKEN) {
    headers.authorization = `Bearer ${process.env.TICKETS_PROXY_TOKEN}`;
  }
  if (route.prefix === '/order/' && process.env.OPS_PORTAL_PROXY_SECRET) {
    headers['x-ops-portal-proxy-secret'] = process.env.OPS_PORTAL_PROXY_SECRET;
  }
  return headers;
}

const OPS_NAV_HEIGHT = 44;
const OPS_NAV_SPACER = '<div data-ops-navigation-spacer aria-hidden="true"></div>';

export function ticketPortalNavigation() {
  const items = [
    ['Inquiry', '/inquiry/'],
    ['Orders', '/order/'],
    ['Tickets', '/tickets/'],
    ['Tools', '/tools']
  ]
    .map(([label, href]) => {
      const active = href === '/tickets/';
      return `<a href="${href}"${active ? ' aria-current="page"' : ''} style="color:${active ? '#fff' : '#dbeafe'};background:${active ? '#2563eb' : 'transparent'};border-radius:6px;padding:6px 10px;text-decoration:none;font-weight:600">${label}</a>`;
    })
    .join('');
  return `<nav data-ops-navigation data-ops-nav-version="1" aria-label="Operations portals"><span>Ops</span>${items}</nav>${OPS_NAV_SPACER}`;
}

export function injectTicketPortalLayout(html) {
  const contract = `<style data-ops-ticket-layout>
[data-ops-navigation],nav[aria-label="Operations portals"]{position:fixed!important;inset:0 0 auto 0!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:6px!important;height:${OPS_NAV_HEIGHT}px!important;min-height:${OPS_NAV_HEIGHT}px!important;box-sizing:border-box!important;padding:0 12px!important;background:#0f172a!important;background-color:#0f172a!important;color:#fff!important;font:600 14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important;box-shadow:0 1px 4px rgba(0,0,0,.25)!important;isolation:isolate}
[data-ops-navigation]>span{margin-right:6px!important;font-weight:700!important}
[data-ops-navigation-spacer]{height:${OPS_NAV_HEIGHT}px!important;min-height:${OPS_NAV_HEIGHT}px!important;flex:none!important}
#root{height:calc(100dvh - ${OPS_NAV_HEIGHT}px)!important;min-height:0!important}
#root>div>header{display:none!important}
</style>`;
  let rewritten = html;
  if (!rewritten.includes('data-ops-ticket-layout')) {
    const navigation = rewritten.includes('aria-label="Operations portals"')
      ? ''
      : ticketPortalNavigation();
    rewritten = rewritten.replace(/<body([^>]*)>/i, `<body$1>${contract}${navigation}`);
  }
  if (!rewritten.includes('<div data-ops-navigation-spacer')) {
    rewritten = rewritten.replace(
      /<div\b[^>]*\bid=(["'])root\1[^>]*>/i,
      (root) => `${OPS_NAV_SPACER}${root}`
    );
  }
  return rewritten;
}

function ownerMetricsTargets(windowKey) {
  const query = `?window=${encodeURIComponent(windowKey)}`;
  return {
    inquiries: {
      url: `https://inquiry-dashboard.pages.dev/metrics${query}`,
      headers: process.env.INQUIRY_METRICS_TOKEN
        ? { authorization: `Bearer ${process.env.INQUIRY_METRICS_TOKEN}` }
        : {}
    },
    tickets: {
      url: `https://mercari-ticket-reports.jim-yang-3c5.workers.dev/api/ticketing/metrics${query}`,
      headers: process.env.TICKETS_PROXY_TOKEN
        ? { authorization: `Bearer ${process.env.TICKETS_PROXY_TOKEN}` }
        : {}
    },
    orders: {
      url: `http://127.0.0.1:8080/order/api/portal/metrics${query}`,
      headers: process.env.OPS_PORTAL_PROXY_SECRET
        ? {
            'x-ops-portal-proxy-secret': process.env.OPS_PORTAL_PROXY_SECRET,
            'cf-access-jwt-assertion': 'ops-gateway-service'
          }
        : {}
    }
  };
}

async function fetchOwnerMetric(target) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const headers = { ...target.headers };
    if (
      target.url.startsWith('https://') &&
      process.env.CF_ACCESS_CLIENT_ID &&
      process.env.CF_ACCESS_CLIENT_SECRET
    ) {
      headers['cf-access-client-id'] = process.env.CF_ACCESS_CLIENT_ID;
      headers['cf-access-client-secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
    }
    const response = await fetch(target.url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`owner_http_${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function aggregateMetrics(windowKey) {
  if (!['last_7_days', 'last_30_days', 'current_month'].includes(windowKey)) {
    return { status: 400, body: { ok: false, error: 'invalid_metrics_window' } };
  }
  const entries = await Promise.all(
    Object.entries(ownerMetricsTargets(windowKey)).map(async ([domain, target]) => {
      try {
        return [domain, { ok: true, data: await fetchOwnerMetric(target) }];
      } catch (error) {
        return [
          domain,
          { ok: false, error: error instanceof Error ? error.message : 'owner_unavailable' }
        ];
      }
    })
  );
  return {
    status: 200,
    body: {
      contract_version: '1.1',
      window: windowKey,
      owners: Object.fromEntries(entries),
      generated_at: new Date().toISOString(),
      gateway_release_sha: RELEASE_SHA
    }
  };
}

function proxy(req, res, route) {
  const upstream = new URL(route.origin);
  const transport = upstream.protocol === 'https:' ? https : http;
  const outgoing = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: upstreamPath(route, req.url || '/'),
      headers: requestHeaders(req, upstream, route),
      timeout: 30_000
    },
    (upstreamRes) => {
      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!deniedResponseHeaders.has(name.toLowerCase()) && value !== undefined)
          headers[name] = value;
      }
      headers['x-ops-gateway-release'] = RELEASE_SHA;
      const isTicketHtml =
        route.prefix === '/tickets/' &&
        String(upstreamRes.headers['content-type'] || '').includes('text/html') &&
        !upstreamRes.headers['content-encoding'];
      if (!isTicketHtml) {
        res.writeHead(upstreamRes.statusCode || 502, headers);
        return upstreamRes.pipe(res);
      }
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const body = injectTicketPortalLayout(Buffer.concat(chunks).toString('utf8'));
        headers['content-length'] = Buffer.byteLength(body);
        res.writeHead(upstreamRes.statusCode || 502, headers);
        res.end(body);
      });
    }
  );
  outgoing.on('timeout', () => outgoing.destroy(new Error('upstream timeout')));
  outgoing.on('error', () => {
    if (!res.headersSent)
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'upstream_unavailable' }));
  });
  req.pipe(outgoing);
}

export function createGateway() {
  const productTools = createProductTools();
  return http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid_request_target' }));
    }
    const pathname = new URL(req.url || '/', 'http://gateway.local').pathname;
    if (pathname === '/_gateway/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({ ok: true, service: 'ops-portal-gateway', release_sha: RELEASE_SHA })
      );
    }
    if (pathname === '/_gateway/metrics' && req.method === 'GET') {
      const windowKey =
        new URL(req.url || '/', 'http://gateway.local').searchParams.get('window') ||
        'last_30_days';
      const result = await aggregateMetrics(windowKey);
      res.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'private, max-age=60'
      });
      return res.end(JSON.stringify(result.body));
    }
    if (await productTools(req, res)) return;
    const route = routeFor(pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'route_not_found' }));
    }
    proxy(req, res, route);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  for (const name of [
    'CF_ACCESS_CLIENT_ID',
    'CF_ACCESS_CLIENT_SECRET',
    'TICKETS_PROXY_TOKEN',
    'OPS_PORTAL_PROXY_SECRET'
  ]) {
    if (!process.env[name]) throw new Error(`Required gateway credential is missing: ${name}`);
  }
  createGateway().listen(PORT, HOST, () =>
    console.log(`[ops-gateway] listening on ${HOST}:${PORT}`)
  );
}

export { routeFor, upstreamPath };
