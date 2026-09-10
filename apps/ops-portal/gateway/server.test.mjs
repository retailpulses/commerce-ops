import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMetrics,
  injectTicketPortalLayout,
  routeFor,
  ticketPortalNavigation,
  upstreamPath
} from './server.mjs';

test('only canonical fixed routes resolve', () => {
  assert.equal(routeFor('/tickets/42').prefix, '/tickets/');
  assert.equal(routeFor('/inquiry/api/release').prefix, '/inquiry/');
  assert.equal(routeFor('/order/api/portal/summary').prefix, '/order/');
  assert.equal(routeFor('/unknown').prefix, '/');
});

test('inquiry owner receives prefix-stripped paths', () => {
  const route = routeFor('/inquiry/assets/app.js');
  assert.equal(upstreamPath(route, '/inquiry/assets/app.js?v=1'), '/assets/app.js?v=1');
});

test('tickets and order retain their native prefixes', () => {
  assert.equal(upstreamPath(routeFor('/tickets/queue'), '/tickets/queue'), '/tickets/queue');
  assert.equal(
    upstreamPath(routeFor('/order/api/release'), '/order/api/release'),
    '/order/api/release'
  );
});

test('ticket portal navigation uses the shared versioned contract and links', () => {
  const navigation = ticketPortalNavigation();
  assert.match(navigation, /aria-label="Operations portals"/);
  assert.match(navigation, /data-ops-nav-version="1"/);
  assert.match(navigation, /href="\/inquiry\/"/);
  assert.match(navigation, /href="\/tickets\/" aria-current="page"/);
  assert.match(navigation, /href="\/order\/"/);
  assert.ok(navigation.indexOf('href="/order/"') < navigation.indexOf('href="/tickets/"'));
  assert.match(navigation, />Orders<\/a>/);

  const html = injectTicketPortalLayout('<html><body><div id="root"></div></body></html>');
  assert.match(html, /background:#0f172a!important/);
  assert.match(html, /height:44px!important/);
  assert.match(html, /padding:0 12px!important/);
  assert.match(html, /font:600 14px\/1.4/);
});

test('ticket portal layout reserves nav height so bottom composer stays in viewport', () => {
  const html = injectTicketPortalLayout('<html><body><div id="root"></div></body></html>');
  assert.match(html, /#root\{height:calc\(100dvh - 44px\)!important;min-height:0!important\}/);
  assert.match(html, /data-ops-navigation-spacer/);
  assert.equal((html.match(/<nav /g) || []).length, 1);
});

test('ticket portal layout removes the redundant native Homebliss Ticketing bar', () => {
  const html = injectTicketPortalLayout('<html><body><div id="root"></div></body></html>');
  assert.match(html, /#root>div>header\{display:none!important\}/);
});

test('ticket portal layout normalizes an existing shared nav without duplicating it', () => {
  const source =
    '<html><body><nav aria-label="Operations portals"><a href="/tickets/">Tickets</a></nav><div id="root"></div></body></html>';
  const html = injectTicketPortalLayout(source);
  assert.equal((html.match(/<nav aria-label="Operations portals"/g) || []).length, 1);
  assert.equal((html.match(/data-ops-navigation-spacer/g) || []).length, 2);
  assert.match(html, /<\/nav><div data-ops-navigation-spacer[^>]*><\/div><div id="root">/);
  assert.match(html, /nav\[aria-label="Operations portals"\]/);
});

test('ticket portal layout repairs an existing contract that is missing its spacer', () => {
  const source =
    '<html><body><style data-ops-ticket-layout></style><nav aria-label="Operations portals"></nav><div class="app" id="root"></div></body></html>';
  const html = injectTicketPortalLayout(source);
  assert.match(
    html,
    /<\/nav><div data-ops-navigation-spacer[^>]*><\/div><div class="app" id="root">/
  );
});

test('metrics rejects an unknown window before owner calls', async () => {
  const result = await aggregateMetrics('year');
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_metrics_window');
});
