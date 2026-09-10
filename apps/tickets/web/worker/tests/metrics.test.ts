import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveWindow } from "../src/handlers/metrics";

test("metrics current month starts at JST midnight", () => {
  assert.equal(resolveWindow("current_month", new Date("2026-08-31T06:00:00Z")).start, "2026-07-31T15:00:00.000Z");
});

test("metrics rejects unknown windows", () => {
  assert.throws(() => resolveWindow("year"), /invalid_metrics_window/);
});

test("ticket list accepts the urgent drill-through query", () => {
  const page = readFileSync(new URL("../src/handlers/ticketing.ts", import.meta.url), "utf8");
  assert.match(page, /function initializeListFiltersFromQuery\(\)/);
  assert.match(page, /params\.get\("status"\)/);
  assert.match(page, /params\.get\("priority"\)/);
  assert.match(page, /\["urgent","high","normal","low"\]/);
});

test("the production React ticket list initializes Metrics URL filters", () => {
  const frontend = readFileSync(new URL("../../frontend/src/components/tickets/ListPane.tsx", import.meta.url), "utf8");
  const drillthrough = readFileSync(new URL("../../frontend/src/lib/ticket-drillthrough.ts", import.meta.url), "utf8");
  assert.match(frontend, /ticketFiltersFromSearch\(window\.location\.search\)/);
  assert.match(drillthrough, /ALLOWED_PRIORITIES/);
  assert.match(drillthrough, /"urgent"/);
  assert.match(drillthrough, /status_group/);
  assert.match(drillthrough, /!statusGroup/);
});
