import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const forbiddenPaths = [
  'functions/_middleware.js',
  'functions/api/portal/[[path]].js',
  'functions/order/[[path]].js',
  'functions/inquiry',
  'static/inquiry'
];

test('obsolete copied and proxy delivery paths stay removed', () => {
  for (const path of forbiddenPaths) {
    assert.equal(existsSync(path), false, `${path} must remain absent`);
  }

  const wrangler = readFileSync('wrangler.toml', 'utf8');
  assert.doesNotMatch(wrangler, /TEMPLATES_KV|kv_namespaces/);
});
