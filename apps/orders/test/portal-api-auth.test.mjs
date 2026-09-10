import test from "node:test";
import assert from "node:assert/strict";

import { validatePortalAuth } from "../portal-api/src/auth.mjs";

const env = {
  ORDER_MGMT_ADMIN_SECRET: "direct-secret",
  GIGA_SYNC_ADMIN_SECRET: "",
  OPS_PORTAL_PROXY_SECRET: "proxy-secret",
};

test("accepts the existing direct bearer token", () => {
  const request = new Request("https://order.example/api/portal/summary", {
    headers: { Authorization: "Bearer direct-secret" },
  });

  assert.equal(validatePortalAuth(request, env), true);
});

test("accepts the Ops proxy secret only with a Cloudflare Access assertion", () => {
  const request = new Request("https://order.example/api/portal/summary", {
    headers: {
      "X-Ops-Portal-Proxy-Secret": "proxy-secret",
      "Cf-Access-Jwt-Assertion": "signed-access-assertion",
    },
  });

  assert.equal(validatePortalAuth(request, env), true);
});

test("rejects proxy authentication without the Access assertion", () => {
  const request = new Request("https://order.example/api/portal/summary", {
    headers: { "X-Ops-Portal-Proxy-Secret": "proxy-secret" },
  });

  assert.equal(validatePortalAuth(request, env), false);
});

test("rejects an invalid proxy secret", () => {
  const request = new Request("https://order.example/api/portal/summary", {
    headers: {
      "X-Ops-Portal-Proxy-Secret": "wrong-secret",
      "Cf-Access-Jwt-Assertion": "signed-access-assertion",
    },
  });

  assert.equal(validatePortalAuth(request, env), false);
});
