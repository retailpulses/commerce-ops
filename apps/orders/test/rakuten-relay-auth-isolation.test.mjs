import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { relaySecretMatches, requireRelaySecret } from "../relay/relay-auth.mjs";

const request = (secret) => ({ headers: { "x-relay-secret": secret } });

test("Rakuten ingestion and send relay secrets are independent", () => {
  const ingestion = "ingestion-secret";
  const send = "send-secret";

  assert.doesNotThrow(() => requireRelaySecret(request(ingestion), ingestion));
  assert.doesNotThrow(() => requireRelaySecret(request(send), send));
  assert.throws(() => requireRelaySecret(request(ingestion), send), /unauthorized/);
  assert.throws(() => requireRelaySecret(request(send), ingestion), /unauthorized/);
});

test("missing scoped secret fails closed", () => {
  assert.throws(() => requireRelaySecret(request("anything"), ""), /relay_secret_not_configured/);
  assert.equal(relaySecretMatches("", ""), false);
});

test("missing and incorrect request secrets are rejected", () => {
  assert.throws(() => requireRelaySecret(request(""), "configured"), /unauthorized/);
  assert.throws(() => requireRelaySecret(request("wrong"), "configured"), /unauthorized/);
});

test("Rakuten inquiry routes are wired to exactly one capability secret", () => {
  const source = readFileSync(new URL("../relay/server.mjs", import.meta.url), "utf8");
  for (const route of ["/admin/rakuten-inquiries", "/admin/rakuten-inquiry", "/admin/rakuten-inquiry-attachment"]) {
    const start = source.indexOf(`url.pathname === "${route}"`);
    const block = source.slice(start, source.indexOf("\n    }", start));
    assert.ok(start >= 0);
    assert.match(block, /requireRakutenIngestionRelaySecret\(req\)/);
    assert.doesNotMatch(block, /requireRakutenSendRelaySecret|requireRelaySecret\(req\)/);
  }

  const replyStart = source.indexOf('url.pathname === "/admin/rakuten-inquiry-reply"');
  const replyBlock = source.slice(replyStart, source.indexOf("\n    }", replyStart));
  assert.ok(replyStart >= 0);
  assert.match(replyBlock, /requireRakutenSendRelaySecret\(req\)/);
  assert.doesNotMatch(replyBlock, /requireRakutenIngestionRelaySecret|requireRelaySecret\(req\)/);
});
