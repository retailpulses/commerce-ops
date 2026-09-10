import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Schedule map was extracted to pipeline-schedule.mjs in Phase 1.
// Verify the ordering is preserved there.
const scheduleSource = readFileSync(
  new URL("../src/lib/pipeline-schedule.mjs", import.meta.url),
  "utf8",
);

test("scheduled auto-approval runs after buyer-message sync", () => {
  // The shared cron slot orders sync_mercari_messages → auto_approve_orders → build_giga_shipments.
  // Webhook-event retry is folded into sync_mercari_messages (Issue #131).
  // build must run AFTER auto-approve so newly-approved rows are projected in the same cycle.
  assert.match(
    scheduleSource,
    /"3,13,23,33,43,53 \* \* \* \*": \["sync_mercari_messages", "auto_approve_orders", "build_giga_shipments"\]/,
  );
});
