import test from "node:test";
import assert from "node:assert/strict";
import { manualMemoLines, parseTimestampedMemo } from "../src/components/detail/manualMemos.ts";

test("keeps operator memos and hides customer-message audit entries", () => {
  const input = [
    "[2026-08-31T10:02:00.000+09:00] operator: Customer requested a redelivery",
    "",
    "[2026-08-31T10:01:58.432+09:00] PORTAL_OPERATOR: sent reply to customer (160 chars) — see Messages",
    "",
    "[2026-08-31T10:01:48.694+09:00] PORTAL_OPERATOR: AI-polished reply draft (160 chars, gpt-4o-2024-08-06, 488 tokens) [see AI copywrite log]",
  ].join("\n");

  assert.deepEqual(manualMemoLines(input), [
    "[2026-08-31T10:02:00.000+09:00] operator: Customer requested a redelivery",
  ]);
});

test("does not hide free-form operator text that merely mentions replies", () => {
  assert.deepEqual(manualMemoLines("[2026-08-31] operator: sent reply after confirming address"), [
    "[2026-08-31] operator: sent reply after confirming address",
  ]);
});

test("keeps a multiline RMS customer remarks block as one memo", () => {
  const input = [
    "[ingest] RMSお客様備考:",
    "[配送日時指定:]",
    "2026-09-04(金)",
    "14:00-16:00",
    "[ingest] RMSお客様備考ここまで",
  ].join("\n");

  assert.deepEqual(manualMemoLines(input), [input]);
});

test("keeps surrounding operator memos separate from an RMS remarks block", () => {
  const rmsBlock = [
    "[ingest] RMSお客様備考:",
    "[配送日時指定:]",
    "2026-09-04(金)",
    "14:00-16:00",
    "[ingest] RMSお客様備考ここまで",
  ].join("\n");
  const before = "[2026-09-01] operator: Check delivery request";
  const after = "[2026-09-01] operator: Confirmed";

  assert.deepEqual(manualMemoLines([before, "", rmsBlock, "", after].join("\n")), [
    before,
    rmsBlock,
    after,
  ]);
});

test("does not swallow later memos when an RMS end marker is missing", () => {
  const start = "[ingest] RMSお客様備考:";
  const body = "delivery note";
  const operatorMemo = "[2026-09-01] operator: Confirmed";

  assert.deepEqual(manualMemoLines([start, body, operatorMemo].join("\n")), [
    start,
    body,
    operatorMemo,
  ]);
});

test("does not parse a multiline RMS block as a timestamped operator memo", () => {
  const input = [
    "[ingest] RMSお客様備考:",
    "[配送日時指定:]",
    "2026-09-04(金)",
    "14:00-16:00",
    "[ingest] RMSお客様備考ここまで",
  ].join("\n");

  assert.equal(parseTimestampedMemo(input), null);
  assert.equal(manualMemoLines(input)[0], input);
});

test("parses a normal single-line timestamped operator memo", () => {
  assert.deepEqual(parseTimestampedMemo("[2026-09-01T12:00:00+09:00] operator: Confirmed"), {
    timestamp: "2026-09-01T12:00:00+09:00",
    author: "operator",
    body: "Confirmed",
  });
});
