import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTicketFormExpiryJst,
  ticketFormValidityCopy,
  ticketFormExpiresAt,
  TICKETFORM_MESSAGE_VALIDITY_NOTICE,
  TICKETFORM_TOKEN_VALIDITY_DAYS,
} from "../src/logic/ticketform-validity";
import {
  FOLLOWUP_FORM_HELPER,
  FUGUAI_LITE_TEMPLATE,
  FUGUAI_TEMPLATE,
} from "../src/logic/templates";

test("new TicketForm links expire exactly seven days after creation", () => {
  const createdAt = Date.parse("2026-07-16T01:23:45.000Z");
  assert.equal(TICKETFORM_TOKEN_VALIDITY_DAYS, 7);
  assert.equal(ticketFormExpiresAt(createdAt), "2026-07-23T01:23:45.000Z");
});

test("buyer-facing form copy shows the actual JST expiry and single-use rule", () => {
  const expiresAt = "2026-07-23T01:23:45.000Z";
  assert.equal(formatTicketFormExpiryJst(expiresAt), "2026年7月23日 10:23");
  assert.match(ticketFormValidityCopy(expiresAt), /有効期限：2026年7月23日 10:23（日本時間）/);
  assert.match(ticketFormValidityCopy(expiresAt), /一度送信すると再利用できません/);
});

test("all customer form-request templates disclose seven-day single-use validity", () => {
  assert.match(TICKETFORM_MESSAGE_VALIDITY_NOTICE, /7日間有効/);
  assert.match(TICKETFORM_MESSAGE_VALIDITY_NOTICE, /一度送信すると再利用できません/);
  for (const template of [FUGUAI_TEMPLATE, FUGUAI_LITE_TEMPLATE, FOLLOWUP_FORM_HELPER]) {
    assert.ok(template.includes(TICKETFORM_MESSAGE_VALIDITY_NOTICE));
  }
});

test("both issuance paths and the active form use the shared validity policy", async () => {
  const { readFile } = await import("node:fs/promises");
  const copywriting = await readFile(new URL("../src/handlers/copywriting.ts", import.meta.url), "utf8");
  const automation = await readFile(new URL("../src/services/ticketFormRequestService.ts", import.meta.url), "utf8");
  const form = await readFile(new URL("../src/handlers/customer-form.ts", import.meta.url), "utf8");

  assert.match(copywriting, /expiresAt = ticketFormExpiresAt\(\)/);
  assert.match(automation, /expiresAt: ticketFormExpiresAt\(\)/);
  assert.match(form, /ticketFormValidityCopy\(expiresAt\)/);
  assert.match(form, /\? "送信済み"/);
  assert.match(form, /\? "期限切れ"/);
});
