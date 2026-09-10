import test from "node:test";
import assert from "node:assert/strict";
import { resolveCandidateLimit } from "../phase-limit.mjs";

test("null is the only explicit unbounded workload limit", () => {
  assert.equal(resolveCandidateLimit(null, 50), Number.POSITIVE_INFINITY);
  assert.equal(resolveCandidateLimit(0, 50), 50);
  assert.equal(resolveCandidateLimit(undefined, 50), 50);
});

test("positive manual limits retain workload safety caps", () => {
  assert.equal(resolveCandidateLimit(7, 50, 50), 7);
  assert.equal(resolveCandidateLimit(70, 50, 50), 50);
});
