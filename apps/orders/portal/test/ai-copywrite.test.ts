import assert from "node:assert/strict";
import test from "node:test";

import { buildAiCopywriteRequest, canRunAiCopywrite } from "../src/lib/ai-copywrite.ts";

test("AI Copywrite uses the main reply text as its draft", () => {
  assert.deepEqual(buildAiCopywriteRequest("  rough reply  "), { draft: "rough reply" });
});

test("AI Copywrite requires reply text and is disabled while pending", () => {
  assert.equal(canRunAiCopywrite("", false), false);
  assert.equal(canRunAiCopywrite("   ", false), false);
  assert.equal(canRunAiCopywrite("rough reply", true), false);
  assert.equal(canRunAiCopywrite("rough reply", false), true);
});
