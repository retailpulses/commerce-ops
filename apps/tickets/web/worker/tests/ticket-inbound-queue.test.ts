import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  TicketInboundQueueService,
  compareQueueItems,
  parseQueueRef,
  type TicketInboundQueueItem,
} from "../src/services/ticketInboundQueueService";

function fakeMercari() {
  const calls: string[] = [];
  return {
    calls,
    service: {
      updateQueueItem: async (id: string) => { calls.push(`update:${id}`); },
      ignoreMessage: async (id: string) => { calls.push(`ignore:${id}`); },
      linkToTicket: async (id: string, ticketId: string) => { calls.push(`link:${id}:${ticketId}`); },
      convertToTicket: async (id: string) => {
        calls.push(`convert:${id}`);
        return { ticket: { id: "ticket-1", ticket_number: "T-1" }, queueItem: {} };
      },
    },
  };
}

function emptySupabase() {
  return {
    from() {
      const result = { data: [], error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        or: () => builder,
        order: () => builder,
        range: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
}

test("queue refs are source-qualified and reject source spoofing", () => {
  assert.deepEqual(parseQueueRef("mercari:11111111-1111-4111-8111-111111111111"), { source: "mercari", nativeId: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(parseQueueRef("rakuten:account~inquiry"), { source: "rakuten", nativeId: "account~inquiry" });
  assert.deepEqual(parseQueueRef("amazon%3Av2~22222222-2222-4222-8222-222222222222"), { source: "amazon", nativeId: "v2~22222222-2222-4222-8222-222222222222" });
  assert.throws(() => parseQueueRef("abc-123"), /INVALID_QUEUE_REF/);
  assert.throws(() => parseQueueRef("unknown:abc-123"), /INVALID_QUEUE_REF/);
  assert.throws(() => parseQueueRef("amazon:../secret"), /INVALID_QUEUE_REF/);
});

test("non-Mercari queue mutations fail closed before any legacy mutation", async () => {
  const mercari = fakeMercari();
  const service = new TicketInboundQueueService(emptySupabase() as never, mercari.service as never);
  for (const ref of ["amazon:legacy~22222222-2222-4222-8222-222222222222", "rakuten:account~inquiry"]) {
    await assert.rejects(service.update(ref, { queue_status: "read" }), /ACTION_UNSUPPORTED/);
    await assert.rejects(service.ignore(ref), /ACTION_UNSUPPORTED/);
    await assert.rejects(service.link(ref, "ticket-1"), /ACTION_UNSUPPORTED/);
    await assert.rejects(service.convert(ref, {}), /ACTION_UNSUPPORTED/);
  }
  assert.deepEqual(mercari.calls, []);
});

test("PATCH cannot smuggle linking or arbitrary statuses through the Mercari path", async () => {
  const mercari = fakeMercari();
  const service = new TicketInboundQueueService(emptySupabase() as never, mercari.service as never);
  await assert.rejects(service.update("mercari:11111111-1111-4111-8111-111111111111", { linked_ticket_id: "ticket-1" }), /ACTION_UNSUPPORTED/);
  await assert.rejects(service.update("mercari:11111111-1111-4111-8111-111111111111", { queue_status: "converted" }), /ACTION_UNSUPPORTED/);
  assert.deepEqual(mercari.calls, []);
});

test("authoritative Mercari state blocks replayed actions before mutation", async () => {
  const mercari = fakeMercari();
  const row = {
    id: "11111111-1111-4111-8111-111111111111", source: "mercari_webhook", shop_name: "Shop1", shop_id: "shop-1",
    order_transaction_id: "order-1", queue_status: "linked", review_status: "reviewed",
    received_at: "2026-09-09T00:00:00Z", created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
  };
  const supabase = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return builder;
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  await assert.rejects(service.ignore("mercari:11111111-1111-4111-8111-111111111111"), /QUEUE_STATE_CONFLICT/);
  await assert.rejects(service.link("mercari:11111111-1111-4111-8111-111111111111", "ticket-2"), /QUEUE_STATE_CONFLICT/);
  await assert.rejects(service.convert("mercari:11111111-1111-4111-8111-111111111111", {}), /QUEUE_STATE_CONFLICT/);
  assert.deepEqual(mercari.calls, []);
});

test("global ordering is deterministic by received_at, source, then opaque id", () => {
  const item = (id: string, platform: "mercari" | "rakuten" | "amazon", received_at: string) =>
    ({ id, platform, received_at } as TicketInboundQueueItem);
  const rows = [
    item("mercari:z", "mercari", "2026-09-09T00:00:00Z"),
    item("amazon:b", "amazon", "2026-09-09T00:00:00Z"),
    item("amazon:a", "amazon", "2026-09-09T00:00:00Z"),
    item("rakuten:x", "rakuten", "2026-09-10T00:00:00Z"),
  ].sort(compareQueueItems);
  assert.deepEqual(rows.map((row) => row.id), ["rakuten:x", "amazon:a", "amazon:b", "mercari:z"]);
});

test("one unavailable Amazon generation yields a degraded partial queue instead of a whole-request failure", async () => {
  const mercari = fakeMercari();
  const supabase = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        or: () => builder,
        order: () => builder,
        range: () => Promise.resolve(table === "amazon_mail_messages"
          ? { data: null, error: { message: "schema unavailable" } }
          : { data: [], error: null }),
      };
      return builder;
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  const result = await service.list({ limit: 20 });
  assert.equal(result.partial, true);
  assert.deepEqual(result.source_errors, [{ source: "amazon", code: "SOURCE_DEGRADED" }]);
  assert.deepEqual(result.items, []);
});

test("Amazon dual-read deduplicates provider identity and prefers v2", async () => {
  const mercari = fakeMercari();
  const amazonBase = {
    account_id: "account-id", provider_account_id: "provider-account", provider_message_id: "message-1",
    source_received_at: "2026-09-09T00:00:00Z", mail_auth_status: "pass", review_status: "needs_review",
    processing_status: "completed", created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
  };
  const supabase = {
    from(table: string) {
      let source: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => { if (column === "source") source = value; return builder; },
        is: () => builder,
        or: () => builder,
        order: () => builder,
        range: () => Promise.resolve({
          error: null,
          data: table === "amazon_mail_messages"
            ? [{ ...amazonBase, id: "v2-id", body: "v2 body" }]
            : table === "inbound_ticket_messages" && source === "amazon_zoho_mail"
              ? [{ ...amazonBase, id: "legacy-id", latest_buyer_message: "legacy body" }]
              : [],
        }),
      };
      return builder;
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  const result = await service.list({ limit: 20 });
  assert.equal(result.partial, false);
  assert.deepEqual(result.items.map((item) => item.id), ["amazon:v2~v2-id"]);
  assert.equal(result.items[0]?.latest_buyer_message, "v2 body");
});

test("shop-scoped queue and unread count do not call Amazon or Rakuten", async () => {
  const mercari = fakeMercari();
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      calls.push(`from:${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, is: () => builder, or: () => builder,
        order: () => builder, range: () => Promise.resolve({ data: [], error: null }),
      };
      return builder;
    },
    rpc(name: string) {
      calls.push(`rpc:${name}`);
      return Promise.resolve({ data: [{ shop_name: "Shop1", unread_count: 1201 }], error: null });
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  const list = await service.list({ shop_name: "Shop1", limit: 20 });
  const count = await service.unreadCount("Shop1");
  assert.equal(list.partial, false);
  assert.deepEqual(count, { total: 1201, by_shop: { Shop1: 1201 }, partial: false, source_errors: [] });
  assert.deepEqual(calls, ["from:inbound_ticket_messages", "rpc:count_mercari_queue_unread_v1"]);
});

test("queue pagination reads source ranges beyond the PostgREST row cap", async () => {
  const mercari = fakeMercari();
  const ranges: Array<[number, number]> = [];
  const supabase = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, is: () => builder, or: () => builder, order: () => builder,
        range: (start: number, end: number) => {
          ranges.push([start, end]);
          const data = Array.from({ length: end - start + 1 }, (_, index) => {
            const sequence = start + index;
            return {
              id: `${String(sequence).padStart(8, "0")}-1111-4111-8111-111111111111`,
              source: "mercari_webhook", shop_name: "Shop1", shop_id: "shop-1",
              order_transaction_id: `order-${sequence}`, queue_status: "unread", review_status: "needs_review",
              received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
              created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
            };
          });
          return Promise.resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  const result = await service.list({ shop_name: "Shop1", offset: 1100, limit: 20 });
  assert.deepEqual(ranges, [[0, 999], [1000, 1120]]);
  assert.equal(result.items.length, 20);
  assert.equal(result.has_more, true);
});

test("queue pagination rejects offsets beyond its bounded request budget", async () => {
  const mercari = fakeMercari();
  const service = new TicketInboundQueueService(emptySupabase() as never, mercari.service as never);
  await assert.rejects(service.list({ offset: 5001, limit: 20 }), /INVALID_QUEUE_FILTER/);
});

test("Amazon unread aggregate reports generation degradation without row truncation", async () => {
  const mercari = fakeMercari();
  const supabase = {
    rpc(name: string) {
      if (name === "count_mercari_queue_unread_v1") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { total: 1501, v2_available: true, legacy_available: false }, error: null });
    },
  };
  const service = new TicketInboundQueueService(supabase as never, mercari.service as never);
  const count = await service.unreadCount();
  assert.deepEqual(count, {
    total: 1501,
    by_shop: { amazon: 1501 },
    partial: true,
    source_errors: [{ source: "amazon", code: "SOURCE_DEGRADED" }],
  });
});

test("Mercari queue linking is one platform-owned atomic RPC with account and order fences", () => {
  const sql = readFileSync("../../supabase/migrations/20260909023000_mercari_queue_link_rpc.sql", "utf8");
  assert.match(sql, /source = 'mercari_webhook'/);
  assert.match(sql, /v_ticket\.platform <> 'mercari'/);
  assert.match(sql, /v_ticket\.account_id IS DISTINCT FROM v_account_id/);
  assert.match(sql, /v_ticket\.external_order_id IS DISTINCT FROM v_message\.order_transaction_id/);
  assert.match(sql, /UPDATE public\.inbound_ticket_messages[\s\S]*INSERT INTO public\.ticket_events/);
  assert.match(sql, /ON CONFLICT \(idempotency_key\)[\s\S]*DO NOTHING/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
});
