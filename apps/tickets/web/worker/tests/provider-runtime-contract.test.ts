import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import type { TicketDetail, TicketMessage } from "../src/repositories/ticketRepository";
import { SendError } from "../src/services/messageSendService";
import { PROVIDER_CONTRACT_VERSION, ServiceBindingSendAdapter, parseProviderSendRequest } from "../src/runtimes/providerContract";
import { runtimeHealthFetch } from "../src/runtimes/runtimeHealth";

const ticket = { id: "ticket-rakuten", platform: "rakuten" } as TicketDetail;
const releaseSha = "1111111111111111111111111111111111111111";
const command = {
  ticket,
  message: "approved body",
  clientOperationId: "11111111-1111-4111-8111-111111111111",
  replyIntent: "holding" as const,
  reviewed: {},
  sentBy: "portal_operator",
};

test("service binding routes to exactly one provider and validates its identity", async () => {
  const calls: string[] = [];
  const binding = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) return Response.json({ status: "ready", platform: "rakuten", role: "send", contract_version: PROVIDER_CONTRACT_VERSION, release_sha: releaseSha });
      return Response.json({
        ok: true,
        contract_version: PROVIDER_CONTRACT_VERSION,
        platform: "rakuten",
        platform_message_id: "native-1",
        sent_at: "2026-09-09T00:00:00Z",
        ticket_message: { id: "message-1" } as TicketMessage,
        replayed: false,
        release_sha: releaseSha,
      });
    },
    connect() { throw new Error("unused"); },
  } as unknown as Fetcher;
  const adapter = new ServiceBindingSendAdapter("rakuten", binding, releaseSha);
  await adapter.preflight(ticket);
  const result = await adapter.send(command);
  assert.equal(result.platform, "rakuten");
  assert.deepEqual(calls, ["https://provider.internal/health", "https://provider.internal/health", "https://provider.internal/v1/send"]);
});

test("cross-platform health and send response spoofing fail closed", async () => {
  const spoofedHealth = { fetch: async () => Response.json({ status: "ready", platform: "amazon", role: "send", contract_version: PROVIDER_CONTRACT_VERSION, release_sha: releaseSha }) } as unknown as Fetcher;
  await assert.rejects(new ServiceBindingSendAdapter("rakuten", spoofedHealth, releaseSha).preflight(ticket), (error: unknown) =>
    error instanceof SendError && error.code === "PLATFORM_RESULT_MISMATCH");

  const spoofedSend = {
    fetch: async (input: RequestInfo | URL) => String(input).endsWith("/health")
      ? Response.json({ status: "ready", platform: "rakuten", role: "send", contract_version: PROVIDER_CONTRACT_VERSION, release_sha: releaseSha })
      : Response.json({ ok: true, contract_version: PROVIDER_CONTRACT_VERSION, platform: "amazon" }),
  } as unknown as Fetcher;
  await assert.rejects(new ServiceBindingSendAdapter("rakuten", spoofedSend, releaseSha).send(command), (error: unknown) =>
    error instanceof SendError && error.code === "PLATFORM_RESULT_MISMATCH");
});

test("provider preflight rejects an unpinned or unexpected release", async () => {
  const binding = { fetch: async () => Response.json({ status: "ready", platform: "rakuten", role: "send", contract_version: PROVIDER_CONTRACT_VERSION, release_sha: releaseSha }) } as unknown as Fetcher;
  await assert.rejects(new ServiceBindingSendAdapter("rakuten", binding).preflight(ticket), (error: unknown) =>
    error instanceof SendError && error.code === "PROVIDER_RELEASE_MISMATCH");
  await assert.rejects(new ServiceBindingSendAdapter("rakuten", binding, "2222222222222222222222222222222222222222").preflight(ticket), (error: unknown) =>
    error instanceof SendError && error.code === "PROVIDER_RELEASE_MISMATCH");
});

test("provider request rejects unknown fields and wrong platform", () => {
  const base = {
    contract_version: PROVIDER_CONTRACT_VERSION,
    platform: "mercari",
    ticket_id: "ticket-1",
    message: "body",
    client_operation_id: "11111111-1111-4111-8111-111111111111",
    reply_intent: "holding",
    reviewed: {},
    actor_id: "portal_operator",
    expected_release_sha: releaseSha,
  };
  assert.throws(() => parseProviderSendRequest({ ...base, injected: true }, "mercari"), /Unknown provider contract field/);
  assert.throws(() => parseProviderSendRequest(base, "rakuten"), /Provider platform mismatch/);
});

test("machine-readable provider contract matches the implemented v1 envelope", () => {
  const descriptor = JSON.parse(readFileSync(new URL("../contracts/provider-send-v1.json", import.meta.url), "utf8")) as {
    contract_version: string;
    request_required: string[];
    reply_intent_values: string[];
    unknown_request_fields: string;
  };
  assert.equal(descriptor.contract_version, PROVIDER_CONTRACT_VERSION);
  assert.deepEqual(descriptor.request_required, [
    "contract_version", "platform", "ticket_id", "message", "client_operation_id",
    "reply_intent", "reviewed", "actor_id", "expected_release_sha",
  ]);
  assert.deepEqual(descriptor.reply_intent_values, ["terminal", "holding"]);
  assert.equal(descriptor.unknown_request_fields, "reject");
});

test("six runtime artifacts are unique and Amazon send has no Zoho client", () => {
  const root = new URL("../", import.meta.url);
  const names = ["mercari-send", "rakuten-send", "amazon-send", "mercari-ingestion", "rakuten-ingestion", "amazon-ingestion"];
  const configs = names.map((name) => readFileSync(new URL(`wrangler.${name}.toml`, root), "utf8"));
  const workerNames = configs.map((config) => config.match(/^name = "([^"]+)"/m)?.[1]);
  const entrypoints = configs.map((config) => config.match(/^main = "([^"]+)"/m)?.[1]);
  assert.equal(new Set(workerNames).size, 6);
  assert.equal(new Set(entrypoints).size, 6);
  const amazonSend = readFileSync(new URL("../src/runtimes/amazonSendWorker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(amazonSend, /Zoho|AmazonMailSendService|zoho-mail/);
});

test("Rakuten send and ingestion artifacts pin the same relay origin in both environments", () => {
  const root = new URL("../", import.meta.url);
  for (const environment of ["production", "staging"] as const) {
    const suffix = environment === "staging" ? ".staging" : "";
    const send = readFileSync(new URL(`wrangler.rakuten-send${suffix}.toml`, root), "utf8");
    const ingestion = readFileSync(new URL(`wrangler.rakuten-ingestion${suffix}.toml`, root), "utf8");
    const expected = 'RAKUTEN_RMESSE_RELAY_URL = "https://rp-relay.homesbliss.net"';
    assert.match(send, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(ingestion, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Amazon ingestion artifacts pin the authoritative platform account mapping", () => {
  const root = new URL("../", import.meta.url);
  const authoritative = 'AMAZON_PLATFORM_ACCOUNT_ID = "8aaa0e95-91a4-45ce-aba0-f3ff0ce9480f"';
  for (const suffix of ["", ".staging"]) {
    const config = readFileSync(new URL(`wrangler.amazon-ingestion${suffix}.toml`, root), "utf8");
    assert.equal(config.includes(authoritative), true);
  }
});

test("Amazon ingestion health fails config readiness when any account mapping is absent", async () => {
  const complete = {
    AMAZON_MAIL_INGESTION_MODE: "active",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "publishable",
    SUPABASE_RUNTIME_KEY: "runtime",
    ZOHO_CLIENT_ID: "client",
    ZOHO_CLIENT_SECRET: "secret",
    ZOHO_REFRESH_TOKEN: "refresh",
    ZOHO_MAIL_ACCOUNT_ID: "mail-account",
    ZOHO_MAIL_INBOX_FOLDER_ID: "inbox",
    AMAZON_PLATFORM_ACCOUNT_ID: "8aaa0e95-91a4-45ce-aba0-f3ff0ce9480f",
    PLATFORM_SCHEMA_READY: "false",
  } as const;
  for (const missing of ["ZOHO_MAIL_ACCOUNT_ID", "ZOHO_MAIL_INBOX_FOLDER_ID", "AMAZON_PLATFORM_ACCOUNT_ID"] as const) {
    const env = { ...complete, [missing]: undefined };
    const response = await runtimeHealthFetch("amazon", "ingestion", new Request("https://runtime.internal/health"), env as never);
    const body = await response.json() as { config_ready: boolean };
    assert.equal(body.config_ready, false, `${missing} must be required`);
  }
});
