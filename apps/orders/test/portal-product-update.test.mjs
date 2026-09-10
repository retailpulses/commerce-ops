import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchPortalProductManualFields,
  handlePortalProductManualFields,
  validateManualFields,
} from "../src/lib/portal/product-update.mjs";

const env = {
  CATALOG_OWNER_API_BASE_URL: "https://catalog.test/",
  ORDERMGMT_CATALOG_API_TOKEN: "owner-token",
};

test("manual field validation is strict and supports explicit clears", () => {
  assert.deepEqual(validateManualFields({ manual_cost_price: null }), {
    ok: true,
    payload: { manual_cost_price: null },
  });
  assert.equal(validateManualFields({ manual_cost_price: 0 }).ok, false);
  assert.equal(validateManualFields({ manual_cost_price: "12" }).ok, false);
  assert.equal(validateManualFields({ manual_presale_arrival_date: "2026-02-29" }).ok, false);
  assert.equal(validateManualFields({ unknown: true }).ok, false);
  assert.equal(validateManualFields({}).ok, false);
});

test("manual field update calls only the scoped owner endpoint", async () => {
  let captured;
  const result = await handlePortalProductManualFields(
    env,
    "SKU / 1",
    { manual_cost_price: 1500 },
    async (url, options) => {
      captured = { url, options };
      return Response.json({
        item_code: "SKU / 1",
        variant_id: "variant-1",
        fields: { manual_cost_price: 1500 },
      });
    },
  );

  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://catalog.test/api/internal/catalog/sku/SKU%20%2F%201/manual-fields");
  assert.equal(captured.options.method, "PATCH");
  assert.equal(captured.options.headers.authorization, "Bearer owner-token");
  assert.deepEqual(JSON.parse(captured.options.body), { manual_cost_price: 1500 });
});

test("owner errors are preserved without leaking response bodies", async () => {
  const result = await handlePortalProductManualFields(
    env,
    "SKU-1",
    { manual_cost_price: 1500 },
    async () => Response.json({ error: "commercial_state_missing", detail: "do not expose" }, { status: 404 }),
  );
  assert.deepEqual(result, { ok: false, error: "commercial_state_missing", statusCode: 404 });
});

test("missing owner token and network failures fail closed", async () => {
  assert.equal(
    (await handlePortalProductManualFields({}, "SKU-1", { manual_cost_price: 1 })).statusCode,
    503,
  );
  assert.deepEqual(
    await handlePortalProductManualFields(env, "SKU-1", { manual_cost_price: 1 }, async () => {
      throw new Error("network details");
    }),
    { ok: false, error: "catalog_owner_api_unavailable", statusCode: 502 },
  );
});

test("product detail enrichment uses owner GET contract", async () => {
  const result = await fetchPortalProductManualFields(env, "SKU-1", async (url, options) => {
    assert.equal(url, "https://catalog.test/api/internal/catalog/sku/SKU-1");
    assert.equal(options.headers.authorization, "Bearer owner-token");
    return Response.json({ item_code: "SKU-1", manual_cost_price: 1234 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.product.manual_cost_price, 1234);
});
