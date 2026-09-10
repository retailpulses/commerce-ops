import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailPaneUrl = new URL(
  "../../frontend/src/components/tickets/detail/DetailPane.tsx",
  import.meta.url,
);

test("Ticket Share discovers capabilities through the Portal-owned API namespace", async () => {
  const source = await readFile(detailPaneUrl, "utf8");

  assert.match(source, /fetch\("\/tickets\/api\/ticketing\/health"/);
  assert.doesNotMatch(source, /fetch\("\/tickets\/api\/health"/);
});
