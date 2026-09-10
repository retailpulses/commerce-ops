import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requireTicketOrderContextAuth } from "../src/lib/portal/handlers.mjs";

test("ticket order context uses a dedicated bearer secret", () => {
  const request = new Request("https://order.test/internal/ticket-order/order-1", {
    headers: { Authorization: "Bearer dedicated-secret" },
  });
  assert.equal(requireTicketOrderContextAuth(request, { TICKET_ORDER_CONTEXT_SECRET: "dedicated-secret" }), true);
  assert.equal(requireTicketOrderContextAuth(request, { WEBHOOK_FORWARD_SECRET: "dedicated-secret" }), false);
});

test("worker exposes a read-only scoped ticket order capability", () => {
  const source = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.match(source, /\/internal\/ticket-order\/:id/);
  assert.match(source, /request\.method === "GET"/);
  assert.match(source, /platform: url\.searchParams\.get\("platform"\)/);
  assert.match(source, /accountId: url\.searchParams\.get\("account_id"\)/);
});
