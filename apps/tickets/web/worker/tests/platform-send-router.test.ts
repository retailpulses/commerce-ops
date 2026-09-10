import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TicketDetail, TicketMessage } from "../src/repositories/ticketRepository";
import {
  PlatformSendRouter,
  type PlatformSendAdapter,
  type PlatformSendCommand,
} from "../src/services/platformSendRouter";
import { AmazonSpApiSendAdapter } from "../src/services/amazonSpApiSendAdapter";
import { MessageSendService, SendError } from "../src/services/messageSendService";
import { MercariSendAdapter } from "../src/services/mercariSendAdapter";

const ticketMessage = { id: "message-1" } as TicketMessage;
const ticket = (platform: string) => ({ id: `ticket-${platform}`, platform }) as TicketDetail;
const command = (platform: string): PlatformSendCommand => ({
  ticket: ticket(platform),
  message: "approved body",
  clientOperationId: "11111111-1111-4111-8111-111111111111",
  replyIntent: "holding",
  reviewed: {},
  sentBy: "operator",
});

describe("PlatformSendRouter", () => {
  it("invokes exactly the authoritative ticket platform adapter", async () => {
    const calls: string[] = [];
    const adapter = (platform: "mercari" | "rakuten" | "amazon"): PlatformSendAdapter => ({
      platform,
      preflight() {},
      async send() {
        calls.push(platform);
        return {
          platform, platformMessageId: `${platform}-message`,
          sentAt: "2026-09-09T00:00:00Z", ticketMessage, replayed: false,
        };
      },
    });
    const router = new PlatformSendRouter([adapter("mercari"), adapter("rakuten"), adapter("amazon")]);
    const result = await router.send(command("rakuten"));
    assert.equal(result.platform, "rakuten");
    assert.deepEqual(calls, ["rakuten"]);
  });

  it("does not fall back when a platform adapter is absent", async () => {
    const router = new PlatformSendRouter([]);
    await assert.rejects(() => router.send(command("other")), (error: unknown) =>
      error instanceof SendError && error.code === "PLATFORM_SEND_UNSUPPORTED");
  });

  it("fails closed when an adapter returns another platform", async () => {
    const router = new PlatformSendRouter([{
      platform: "mercari",
      preflight() {},
      async send() {
        return {
          platform: "rakuten", platformMessageId: "wrong",
          sentAt: "2026-09-09T00:00:00Z", ticketMessage, replayed: false,
        };
      },
    }]);
    await assert.rejects(() => router.send(command("mercari")), (error: unknown) =>
      error instanceof SendError && error.code === "PLATFORM_RESULT_MISMATCH");
  });

  it("keeps generic Amazon replies off the legacy Zoho outbound route", async () => {
    const router = new PlatformSendRouter([new AmazonSpApiSendAdapter()]);
    await assert.rejects(() => router.send(command("amazon")), (error: unknown) =>
      error instanceof SendError && error.code === "AMAZON_SPAPI_ACTION_UNAVAILABLE");

    const handler = readFileSync(fileURLToPath(new URL("../src/handlers/copywriting.ts", import.meta.url)), "utf8");
    const genericSend = handler.slice(
      handler.indexOf("export async function handleSendReply"),
      handler.indexOf("// ── 3. Save/Load Draft"),
    );
    assert.equal(genericSend.includes("AmazonMailSendService"), false);
    assert.equal(genericSend.includes("ZohoMailClient"), false);
    assert.ok(
      genericSend.indexOf("await router.preflight(ticket)") < genericSend.indexOf("containsLegacyFormLink"),
      "platform capability must fail before form-token persistence",
    );
  });

  it("can disable Mercari without resolving credentials or calling its provider", async () => {
    let providerResolutionCalls = 0;
    const adapter = new MercariSendAdapter(
      {} as MessageSendService,
      async () => {
        providerResolutionCalls += 1;
        throw new Error("must not run");
      },
      false,
    );
    assert.throws(() => adapter.preflight(ticket("mercari")), (error: unknown) =>
      error instanceof SendError && error.code === "MERCARI_SEND_DISABLED");
    assert.equal(providerResolutionCalls, 0);
  });
});
