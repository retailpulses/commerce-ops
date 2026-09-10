import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRakutenRmesseClient, normalizeInquiryMessages } from "../src/clients/rakuten-rmesse";
import { syncRakutenRmesse } from "../src/services/rakutenRmesseSyncService";
import { isTimestampAfter, RakutenRmesseSendService } from "../src/services/rakutenRmesseSendService";
import type { Env } from "../src/types";

test("keeps the directionless initial message neutral and normalizes reply direction", () => {
  const messages = normalizeInquiryMessages({
    inquiryNumber: "inq-1", shopId: 440058, orderNumber: "order-1",
    message: "initial", regDate: "2026-08-01T00:00:00+09:00",
    lastUpdateDate: "2026-08-01T01:00:00+09:00",
    replies: [
      { id: 10, message: "customer", regDate: "2026-08-01T00:10:00+09:00", replyFrom: "user" },
      { id: 11, message: "seller", regDate: "2026-08-01T00:20:00+09:00", replyFrom: "merchant" },
    ],
  });
  assert.deepEqual(messages.map((message) => [message.external_message_id, message.sender_type]), [
    ["rakuten:inq-1:initial", "system"],
    ["rakuten:inq-1:reply:10", "customer"],
    ["rakuten:inq-1:reply:11", "seller"],
  ]);
});

test("normalizes R-Messe reply images as platform evidence", () => {
  const [message] = normalizeInquiryMessages({
    inquiryNumber: "inq-1", shopId: 440058, orderNumber: "order-1",
    regDate: "2026-08-01T00:00:00+09:00", lastUpdateDate: "2026-08-01T00:10:00+09:00",
    replies: [{ id: 10, message: "写真を共有します", regDate: "2026-08-01T00:10:00+09:00", replyFrom: "user",
      attachments: [{ label: "damage.jpeg", path: "2026/08/01/440058/object.jpeg" }] }],
  });
  assert.deepEqual(message.attachments, [{ label: "damage.jpeg", path: "2026/08/01/440058/object.jpeg", mime_type: "image/jpeg" }]);
});

test("shadow sync excludes inquiries without an explicit order number and performs zero DB writes", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith("/admin/rakuten-inquiries")) {
      return Response.json({ ok: true, totalCount: 2, totalPageCount: 1, page: 1, list: [
        { inquiryNumber: "order-inquiry", orderNumber: "order-1" },
        { inquiryNumber: "presale-inquiry", orderNumber: null },
      ] });
    }
    return Response.json({ ok: true, result: {
      inquiryNumber: "order-inquiry", shopId: 440058, orderNumber: "order-1",
      message: "body", regDate: "2026-08-01T00:00:00+09:00",
      lastUpdateDate: "2026-08-01T00:00:00+09:00", replies: [],
    } });
  };
  try {
    const supabase = new Proxy({}, { get: () => { throw new Error("shadow_must_not_touch_db"); } });
    const report = await syncRakutenRmesse({
      RAKUTEN_RMESSE_RELAY_URL: "https://relay.test",
      RAKUTEN_RMESSE_RELAY_SECRET: "secret",
    } as Env, supabase as never, { mode: "shadow", now: new Date("2026-08-01T00:15:00Z") });
    assert.equal(report.qualified, 1);
    assert.equal(report.excludedWithoutOrder, 1);
    assert.equal(report.detailsFetched, 1);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("targeted canary fetches and ingests only the exact order without advancing the shared cursor", async () => {
  const originalFetch = globalThis.fetch;
  const rpcCalls: unknown[] = [];
  let stateUpserts = 0;
  globalThis.fetch = async (url) => String(url).endsWith("/admin/rakuten-inquiries")
    ? Response.json({ ok: true, totalCount: 2, totalPageCount: 1, page: 1, list: [
      { inquiryNumber: "target", orderNumber: "order-target" },
      { inquiryNumber: "other", orderNumber: "order-other" },
    ] })
    : Response.json({ ok: true, result: {
      inquiryNumber: "target", shopId: 440058, orderNumber: "order-target",
      message: "body", regDate: "2026-08-25T00:00:00+09:00",
      lastUpdateDate: "2026-08-25T00:10:00+09:00", replies: [],
    } });
  const query = { select: () => query, eq: () => query, or: () => query, limit: () => query,
    then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: "account-1" }], error: null }),
    maybeSingle: async () => ({ data: { cursor_updated_at: "2026-08-30T00:00:00Z" } }),
    upsert: async () => { stateUpserts += 1; return { error: null }; } };
  const supabase = {
    from: () => query,
    rpc: async (_name: string, params: unknown) => { rpcCalls.push(params); return { data: { messages_inserted: 1 }, error: null }; },
  };
  try {
    const report = await syncRakutenRmesse({
      RAKUTEN_RMESSE_RELAY_URL: "https://relay.test", RAKUTEN_RMESSE_RELAY_SECRET: "secret",
    } as Env, supabase as never, {
      mode: "active", now: new Date("2026-08-30T00:00:00Z"),
      fromDate: new Date("2026-08-24T15:00:00Z"), targetOrderNumber: "order-target",
    });
    assert.equal(report.scanned, 2);
    assert.equal(report.qualified, 1);
    assert.equal(report.detailsFetched, 1);
    assert.equal(rpcCalls.length, 1);
    assert.equal(stateUpserts, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("active sync upgrades one R-Messe image reference to private stored evidence", async () => {
  const originalFetch = globalThis.fetch;
  const uploaded: Array<{ path: string; bytes: number; options: Record<string, unknown> }> = [];
  let updated: Record<string, unknown> | null = null;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/admin/rakuten-inquiries")) {
      return Response.json({ ok: true, totalCount: 1, totalPageCount: 1, page: 1,
        list: [{ inquiryNumber: "inq-1", orderNumber: "order-1" }] });
    }
    if (target.endsWith("/admin/rakuten-inquiry")) {
      return Response.json({ ok: true, result: {
        inquiryNumber: "inq-1", shopId: 440058, orderNumber: "order-1",
        regDate: "2026-08-01T00:00:00+09:00", lastUpdateDate: "2026-08-01T00:10:00+09:00",
        replies: [{ id: 10, message: "photo", regDate: "2026-08-01T00:10:00+09:00", replyFrom: "user",
          attachments: [{ label: "damage.jpeg", path: "2026/object" }] }],
      } });
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
      headers: { "content-type": "image/jpeg", "content-length": "4" },
    });
  };

  const chain = (result: unknown) => {
    const query = { select: () => query, eq: () => query, limit: () => query,
      maybeSingle: async () => result,
      then: (resolve: (value: unknown) => void) => resolve(result) };
    return query;
  };
  const attachmentQuery = {
    select: () => attachmentQuery, eq: () => attachmentQuery,
    maybeSingle: async () => ({ data: { id: "attachment-1", metadata: { content_status: "reference_only" } }, error: null }),
    update: (payload: Record<string, unknown>) => {
      updated = payload;
      return { eq: async () => ({ error: null }) };
    },
  };
  const supabase = {
    from: (table: string) => table === "platform_accounts"
      ? chain({ data: [{ id: "account-1" }], error: null })
      : table === "rakuten_rmesse_sync_state"
        ? chain({ data: { cursor_updated_at: "2026-08-01T00:00:00Z" }, error: null })
        : attachmentQuery,
    rpc: async () => ({ data: { ticket_id: "ticket-1", attachments_inserted: 1 }, error: null }),
    storage: { from: () => ({ upload: async (path: string, bytes: Uint8Array, options: Record<string, unknown>) => {
      uploaded.push({ path, bytes: bytes.byteLength, options });
      return { error: null };
    } }) },
  };

  try {
    const report = await syncRakutenRmesse({
      RAKUTEN_RMESSE_RELAY_URL: "https://relay.test", RAKUTEN_RMESSE_RELAY_SECRET: "secret",
    } as Env, supabase as never, {
      mode: "active", now: new Date("2026-08-01T00:15:00Z"),
      fromDate: new Date("2026-07-31T15:00:00Z"), targetOrderNumber: "order-1",
    });
    assert.equal(report.attachmentsStored, 1);
    assert.equal(report.attachmentErrors, 0);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].bytes, 4);
    assert.match(uploaded[0].path, /^tickets\/ticket-1\/rakuten-rmesse\/[a-f0-9]{64}-[a-f0-9]{64}\.jpeg$/);
    assert.equal(updated!.storage_bucket, "ticket-attachments");
    assert.equal((updated!.metadata as Record<string, unknown>).content_status, "stored");
  } finally { globalThis.fetch = originalFetch; }
});

test("active sync reconciles a known old inquiry even when the recent discovery list is empty", async () => {
  const originalFetch = globalThis.fetch;
  const rpcCalls: Array<Record<string, unknown>> = [];
  let detailReads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/admin/rakuten-inquiries")) {
      return Response.json({ ok: true, totalCount: 0, totalPageCount: 1, page: 1, list: [] });
    }
    detailReads += 1;
    return Response.json({ ok: true, result: {
      inquiryNumber: "old-inquiry", shopId: 440058, orderNumber: "order-old",
      message: "initial", regDate: "2026-08-27T00:00:00+09:00",
      lastUpdateDate: "2026-08-30T14:55:00+09:00",
      replies: [{ id: 22, message: "new customer reply", regDate: "2026-08-30T14:55:00+09:00", replyFrom: "user" }],
    } });
  };

  const chain = (result: unknown) => {
    const query = {
      select: () => query, eq: () => query, lte: () => query, order: () => query,
      limit: () => query, maybeSingle: async () => result,
      upsert: async () => ({ error: null }),
      then: (resolve: (value: unknown) => void) => resolve(result),
    };
    return query;
  };
  const supabase = {
    from: (table: string) => table === "platform_accounts"
      ? chain({ data: [{ id: "account-1" }], error: null })
      : table === "rakuten_rmesse_sync_state"
        ? chain({ data: { cursor_updated_at: "2026-09-01T00:00:00Z" }, error: null })
        : chain({ data: [{
          account_id: "account-1", inquiry_number: "old-inquiry", shop_id: "440058",
          order_number: "order-old", last_ingested_at: "2026-08-29T00:00:00Z",
        }], error: null }),
    rpc: async (_name: string, params: Record<string, unknown>) => {
      rpcCalls.push(params);
      return { data: { messages_inserted: 1, customer_messages_inserted: 1 }, error: null };
    },
  };

  try {
    const report = await syncRakutenRmesse({
      RAKUTEN_RMESSE_RELAY_URL: "https://relay.test", RAKUTEN_RMESSE_RELAY_SECRET: "secret",
      RAKUTEN_RMESSE_RECONCILIATION_LIMIT: "25", RAKUTEN_RMESSE_RECONCILIATION_INTERVAL_MINUTES: "2",
    } as Env, supabase as never, { mode: "active", now: new Date("2026-09-01T00:15:00Z") });
    assert.equal(report.scanned, 0);
    assert.equal(report.reconciliationCandidates, 1);
    assert.equal(report.reconciliationFetched, 1);
    assert.equal(report.reconciliationErrors, 0);
    assert.equal(report.messagesInserted, 1);
    assert.equal(detailReads, 1);
    assert.equal(rpcCalls[0].p_inquiry_number, "old-inquiry");
    assert.equal((rpcCalls[0].p_messages as Array<{ external_message_id: string }>)[1].external_message_id,
      "rakuten:old-inquiry:reply:22");
  } finally { globalThis.fetch = originalFetch; }
});

test("order-qualified migration creates one conflict-safe ticket and keeps append idempotent", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260829110000_rakuten_rmesse_order_qualified_ticket_creation.sql", import.meta.url), "utf8");
  assert.match(sql, /rakuten_order_qualification_required/);
  assert.match(sql, /INSERT INTO tickets/i);
  assert.match(sql, /ON CONFLICT DO NOTHING/i);
  assert.match(sql, /origin <> 'migrated_baserow'/);
  assert.match(sql, /ORDER BY last_update_date DESC, inquiry_number DESC/);
  assert.match(sql, /ON CONFLICT \(platform, external_message_id\)/);
  assert.match(sql, /sender_type' = 'customer'/);
});

test("attachment migration creates idempotent platform evidence references", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260830090000_rakuten_rmesse_attachment_evidence.sql", import.meta.url), "utf8");
  assert.match(sql, /INSERT INTO ticket_attachments/i);
  assert.match(sql, /'platform_message'/);
  assert.match(sql, /ON CONFLICT\(storage_bucket,storage_path\) DO NOTHING/i);
  assert.match(sql, /attachments_inserted/);
});

test("hosted pgcrypto search path remediation keeps attachment ingestion executable", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260901023000_rakuten_rmesse_pgcrypto_search_path.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER FUNCTION public\.ingest_rakuten_rmesse_inquiry/i);
  assert.match(sql, /SET search_path TO public, extensions/i);
});

test("production migration allowlist applies and verifies the pgcrypto remediation", () => {
  const script = readFileSync(new URL("../../../scripts/apply_rakuten_rmesse_order_ticket_creation.sh", import.meta.url), "utf8");
  assert.match(script, /20260901023000_rakuten_rmesse_pgcrypto_search_path\.sql/);
  assert.match(script, /pgcrypto_search_path_installed/);
});

test("relay client keeps secret in the header and sends no query credentials", async () => {
  let captured: { url: string; headers: HeadersInit } | null = null;
  const client = createRakutenRmesseClient({
    url: "https://relay.test", secret: "top-secret",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), headers: init?.headers || {} };
      return Response.json({ ok: true, result: { inquiryNumber: "inq" } });
    },
  });
  await client.get("inq");
  assert.equal(captured!.url.includes("top-secret"), false);
  assert.equal((captured!.headers as Record<string, string>)["x-relay-secret"], "top-secret");
});

test("relay failures do not copy upstream content or customer data into errors", async () => {
  const client = createRakutenRmesseClient({
    url: "https://relay.test",
    secret: "top-secret",
    fetchImpl: async () => Response.json(
      { ok: false, error: "customer@example.test full message body" },
      { status: 502 },
    ),
  });
  await assert.rejects(
    () => client.get("inq-1"),
    (error: Error) => error.message === "rakuten_rmesse_relay_failed:502",
  );
});

test("relay attachment download returns bounded binary without exposing the secret", async () => {
  let captured: { url: string; body: string; headers: HeadersInit } | null = null;
  const client = createRakutenRmesseClient({
    url: "https://relay.test", secret: "top-secret",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), body: String(init?.body), headers: init?.headers || {} };
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        headers: { "content-type": "image/jpeg", "content-length": "4" },
      });
    },
  });
  const result = await client.downloadAttachment({ label: "damage.jpeg", path: "2026/object" });
  assert.equal(captured!.url, "https://relay.test/admin/rakuten-inquiry-attachment");
  assert.equal(captured!.url.includes("top-secret"), false);
  assert.deepEqual(JSON.parse(captured!.body), { label: "damage.jpeg", path: "2026/object" });
  assert.equal((captured!.headers as Record<string, string>)["x-relay-secret"], "top-secret");
  assert.equal(result.contentType, "image/jpeg");
  assert.deepEqual([...result.bytes], [0xff, 0xd8, 0xff, 0xe0]);
});

test("Rakuten freshness compares instants instead of ISO strings with different offsets", () => {
  assert.equal(
    isTimestampAfter("2026-09-01T11:15:23+09:00", "2026-09-01T02:16:00.000Z"),
    false,
  );
  assert.equal(
    isTimestampAfter("2026-09-01T11:15:23+09:00", "2026-09-01T02:14:00.000Z"),
    true,
  );
  assert.equal(isTimestampAfter("invalid", "2026-09-01T02:16:00.000Z"), true);
});

test("outbound send snapshots the thread, posts once, and reconciles the native reply ID", async () => {
  const originalFetch = globalThis.fetch;
  let detailReads = 0;
  let replyPosts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/admin/rakuten-inquiry-reply")) {
      replyPosts += 1;
      return Response.json({ ok: true, result: {
        inquiryNumber: "inq-1", message: "reply", regDate: "2026-08-01T00:01:00+09:00", replyFrom: "merchant",
      } });
    }
    detailReads += 1;
    return Response.json({ ok: true, result: {
      inquiryNumber: "inq-1", shopId: 440058, orderNumber: "order-1",
      message: "initial", regDate: "2026-08-01T00:00:00+09:00",
      lastUpdateDate: "2026-08-01T00:01:00+09:00",
      replies: detailReads === 1 ? [] : [
        { id: 99, message: "reply", regDate: "2026-08-01T00:01:00+09:00", replyFrom: "merchant" },
      ],
    } });
  };
  const preflights: string[][] = [];
  const repo = {
    claimPlatformSentMessage: async () => ({ claimed: true, ticketMessage: null, sentMessage: {
      id: "sent-1", ticket_id: "ticket-1", platform: "rakuten", platform_message_id: null,
      body: "reply", reply_intent: "terminal", sent_by: null, sent_at: "2026-08-01T00:00:00Z",
      created_at: "2026-08-01T00:00:00Z", client_operation_id: "op-1",
      delivery_status: "sending", delivery_error: null, platform_message_ids_before_send: null,
    } }),
    recordPlatformSentMessagePreflight: async (_ticketId: string, _operationId: string, _platform: "mercari" | "rakuten", ids: string[]) => { preflights.push(ids); },
    finalizeSentMessage: async (input: { platform_message_id: string; platform_sent_at: string }) => ({
      replayed: false,
      sentMessage: { platform_message_id: input.platform_message_id, sent_at: input.platform_sent_at },
      ticketMessage: { external_message_id: input.platform_message_id },
    }),
    markPlatformSentMessageAmbiguous: async () => undefined,
    releasePlatformSentMessageClaim: async () => undefined,
  };
  try {
    const result = await new RakutenRmesseSendService(repo as never, {
      relayUrl: "https://relay.test", relaySecret: "secret",
    }).send({
      ticket: { id: "ticket-1", external_thread_id: "inq-1" } as never,
      message: "reply", clientOperationId: "op-1", replyIntent: "terminal",
    });
    assert.equal(replyPosts, 1);
    assert.equal(detailReads, 2);
    assert.deepEqual(preflights, [[]]);
    assert.equal(result.platformMessageId, "rakuten:inq-1:reply:99");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
