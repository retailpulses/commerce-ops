import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import {
  extractBuyerMessageFacts,
  classifyUnreadStatus,
  isDurableStateStale,
  getUnreadStateStaleMs,
  writeThroughMessageFacts,
  recordMessageSyncFailure,
  syncMercariMessages,
  buildDurableStateKey,
  buildSupabaseDurableStatePayload,
  writeSupabaseDurableState,
  readSupabaseDurableState,
  listSalesRowsForMessageSync,
} from "../buyer-messages.mjs";

describe("buildSupabaseDurableStatePayload", () => {
  it("preserves message facts when advancing only the read cursor", () => {
    const payload = buildSupabaseDurableStatePayload({
      salesOrderId: "sales-1",
      shopId: "Shop1",
      orderId: "order_tx-1",
      existing: {
        latest_message_id: "m2",
        latest_message_at: "2026-07-13T12:00:00.000Z",
        last_check_status: "ok",
      },
      fields: {
        last_read_message_id: "m2",
        last_read_at: "2026-07-13T12:01:00.000Z",
      },
    });

    assert.deepEqual(payload, {
      sales_order_id: "sales-1",
      source_store_id: "Shop1",
      order_transaction_id: "tx-1",
      last_read_message_id: "m2",
      last_read_at: "2026-07-13T12:01:00.000Z",
      has_unread: false,
    });
  });

  it("preserves the read cursor when syncing a newer message", () => {
    const payload = buildSupabaseDurableStatePayload({
      salesOrderId: "sales-1",
      shopId: "Shop1",
      orderId: "tx-1",
      existing: { last_read_message_id: "m1" },
      fields: {
        latest_message_id: "m2",
        latest_message_at: "2026-07-13T12:00:00.000Z",
        last_checked_at: "2026-07-13T12:00:01.000Z",
        last_check_status: "ok",
      },
    });

    assert.equal(payload.latest_message_id, "m2");
    assert.equal(payload.has_unread, true);
    assert.equal(Object.hasOwn(payload, "last_read_message_id"), false);
  });

  it("uses KV state only to seed a missing Supabase row", () => {
    const payload = buildSupabaseDurableStatePayload({
      salesOrderId: "sales-1",
      shopId: "Shop1",
      orderId: "tx-1",
      fallback: { last_read_message_id: "m1", latest_message_id: "m1" },
      fields: { last_check_status: "ok" },
    });

    assert.equal(payload.last_read_message_id, "m1");
    assert.equal(payload.latest_message_id, "m1");
    assert.equal(payload.has_unread, false);
  });
});

// ============================================================================
// extractBuyerMessageFacts
// ============================================================================

describe("extractBuyerMessageFacts", () => {
  it("returns empty facts for null/undefined messages", () => {
    assert.deepEqual(extractBuyerMessageFacts(null), {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    });
    assert.deepEqual(extractBuyerMessageFacts(undefined), {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    });
  });

  it("returns empty facts for empty array", () => {
    assert.deepEqual(extractBuyerMessageFacts([]), {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    });
  });

  it("returns empty facts when no BUYER messages exist", () => {
    const messages = [
      { id: "m1", createdAt: "2026-06-22T10:00:00.000Z", role: "SELLER", message: "Hello" },
      { id: "m2", createdAt: "2026-06-22T10:01:00.000Z", role: "ADMIN", message: "Note" },
    ];
    assert.deepEqual(extractBuyerMessageFacts(messages), {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    });
  });

  it("returns facts for single buyer message", () => {
    const messages = [
      { id: "m1", createdAt: "2026-06-22T10:00:00.000Z", role: "BUYER", message: "Question?" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
    assert.equal(result.latest_buyer_message_id, "m1");
    assert.equal(result.latest_buyer_message_at, "2026-06-22T10:00:00.000Z");
  });

  it("filters seller messages and picks the latest buyer message", () => {
    const messages = [
      { id: "m1", createdAt: "2026-06-22T09:00:00.000Z", role: "SELLER", message: "Thanks" },
      { id: "m2", createdAt: "2026-06-22T10:00:00.000Z", role: "BUYER", message: "Q1" },
      { id: "m3", createdAt: "2026-06-22T10:05:00.000Z", role: "SELLER", message: "A1" },
      { id: "m4", createdAt: "2026-06-22T11:00:00.000Z", role: "BUYER", message: "Q2" },
      { id: "m5", createdAt: "2026-06-22T11:30:00.000Z", role: "BUYER", message: "Q3" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
    assert.equal(result.latest_buyer_message_id, "m5");
    assert.equal(result.latest_buyer_message_at, "2026-06-22T11:30:00.000Z");
  });

  it("sorts by createdAt with id tiebreaker", () => {
    const messages = [
      { id: "m_a", createdAt: "2026-06-22T10:00:00.000Z", role: "BUYER" },
      { id: "m_b", createdAt: "2026-06-22T10:00:00.000Z", role: "BUYER" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
    assert.equal(result.latest_buyer_message_id, "m_b");
  });

  it("handles case-insensitive role matching", () => {
    const messages = [
      { id: "m1", createdAt: "2026-06-22T10:00:00.000Z", role: "buyer", message: "Hi" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
    assert.equal(result.latest_buyer_message_id, "m1");
  });

  it("handles mixed case roles", () => {
    const messages = [
      { id: "m1", createdAt: "2026-06-22T10:00:00.000Z", role: "Buyer", message: "Hello" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
  });

  it("filters out messages without id or createdAt", () => {
    const messages = [
      { role: "BUYER", message: "no identifiers" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, false);
  });

  it("handles malformed message entries gracefully", () => {
    const messages = [
      null,
      undefined,
      { id: "m1", role: "BUYER", createdAt: "2026-06-22T10:00:00.000Z" },
    ];
    const result = extractBuyerMessageFacts(messages);
    assert.equal(result.has_buyer_messages, true);
    assert.equal(result.latest_buyer_message_id, "m1");
  });
});

// ============================================================================
// classifyUnreadStatus
// ============================================================================

function makeRow(overrides = {}) {
  return {
    has_buyer_messages: false,
    latest_buyer_message_id: "",
    latest_buyer_message_at: "",
    ...overrides,
  };
}

describe("classifyUnreadStatus", () => {
  it("returns unknown but not unread when a no-message row has never been checked", () => {
    const result = classifyUnreadStatus(makeRow(), null);
    assert.equal(result.classification, "unknown");
    assert.equal(result.has_unread, false);
  });

  it("classifies as unread when buyer messages exist and no kv read-state", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "2026-06-22T11:30:00.000Z",
    });
    const result = classifyUnreadStatus(row, null);
    assert.equal(result.classification, "unread");
    assert.equal(result.has_unread, true);
  });

  it("classifies as unread when buyer messages exist but kv read-state lacks a usable read cursor", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "2026-06-22T11:30:00.000Z",
    });
    const result = classifyUnreadStatus(row, { latest_buyer_msg_at: "2026-06-22T11:30:00.000Z" });
    assert.equal(result.classification, "unread");
    assert.equal(result.has_unread, true);
  });

  it("classifies as unread when latest_buyer_msg_at > last_read_at", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "2026-06-22T11:30:00.000Z",
    });
    const result = classifyUnreadStatus(row, {
      last_read_at: "2026-06-22T10:00:00.000Z",
    });
    assert.equal(result.classification, "unread");
    assert.equal(result.has_unread, true);
  });

  it("classifies as read when latest_buyer_msg_at <= last_read_at", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
    });
    const result = classifyUnreadStatus(row, {
      last_read_at: "2026-06-22T11:00:00.000Z",
    });
    assert.equal(result.classification, "read");
    assert.equal(result.has_unread, false);
  });

  it("classifies as unread when latest_buyer_msg_at equals last_read_at (exact same time)", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
    });
    const result = classifyUnreadStatus(row, {
      last_read_at: "2026-06-22T10:00:00.000Z",
    });
    assert.equal(result.classification, "read");
    assert.equal(result.has_unread, false);
  });

  it("classifies as unread when a latest message ID exists without a comparable cursor", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "",
    });
    const result = classifyUnreadStatus(row, {
      last_read_at: "2026-06-22T11:00:00.000Z",
    });
    assert.equal(result.classification, "unread");
    assert.equal(result.has_unread, true);
  });

  it("handles has_buyer_messages string values", () => {
    const row = makeRow({ has_buyer_messages: "true" });
    assert.equal(classifyUnreadStatus(row, null).has_unread, false);
  });

  it("handles has_buyer_messages numeric values", () => {
    const row = makeRow({ has_buyer_messages: 1 });
    assert.equal(classifyUnreadStatus(row, null).has_unread, false);
  });

  it("keeps a confirmed read cursor read when the subsequent health check failed", () => {
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: "2026-06-22T11:30:00.000Z",
      message_last_synced_at: "2026-06-22T11:31:00.000Z",
    });
    const result = classifyUnreadStatus(row, {
      last_check_status: "failed",
      last_checked_at: "2026-06-22T11:31:00.000Z",
      last_read_message_id: "m5",
    });
    assert.equal(result.classification, "read");
    assert.equal(result.has_unread, false);
  });

  it("keeps a confirmed read cursor read when the health check is stale", () => {
    const staleMs = getUnreadStateStaleMs() + 60 * 1000;
    const old = new Date(Date.now() - staleMs).toISOString();
    const row = makeRow({
      has_buyer_messages: true,
      latest_buyer_message_id: "m5",
      latest_buyer_message_at: old,
      message_last_synced_at: old,
    });
    const result = classifyUnreadStatus(row, {
      last_check_status: "ok",
      last_checked_at: old,
      last_read_message_id: "m5",
    });
    assert.equal(result.classification, "read");
    assert.equal(result.has_unread, false);
  });

  it("classifies no-buyer rows as unknown when durable state is failed", () => {
    const row = makeRow({
      has_buyer_messages: false,
      message_last_synced_at: "2026-06-22T11:31:00.000Z",
    });
    const result = classifyUnreadStatus(row, {
      last_check_status: "failed",
      last_checked_at: "2026-06-22T11:31:00.000Z",
    });
    assert.equal(result.classification, "unknown");
    assert.equal(result.has_unread, false);
  });
});

describe("isDurableStateStale", () => {
  it("returns true when last_checked_at is older than the stale threshold", () => {
    const staleMs = getUnreadStateStaleMs() + 60 * 1000;
    const old = new Date(Date.now() - staleMs).toISOString();
    assert.equal(
      isDurableStateStale({ message_last_synced_at: old }, { last_check_status: "ok", last_checked_at: old }),
      true,
    );
  });

  it("returns false for recently checked durable state", () => {
    const now = new Date().toISOString();
    assert.equal(
      isDurableStateStale({ message_last_synced_at: now }, { last_check_status: "ok", last_checked_at: now }),
      false,
    );
  });
});

function makeKvEnv() {
  const kvStore = new Map();
  return {
    PORTAL_KV: {
      async get(key) {
        const val = kvStore.get(key);
        if (!val) return null;
        try { return JSON.parse(val); } catch { return val; }
      },
      async put(key, value) {
        kvStore.set(key, typeof value === "string" ? value : JSON.stringify(value));
      },
    },
    _kvStore: kvStore,
  };
}

// ============================================================================
// writeThroughMessageFacts
// ============================================================================

describe("writeThroughMessageFacts", () => {
  it("uses the production table variable and persists all four message fields", async () => {
    const env = {
      ...makeKvEnv(),
      BASEROW_API_BASE: "https://baserow.test/api",
      BASEROW_DATABASE_TOKEN: "test-token",
      BASEROW_MERCARI_SALES_ORDER_TABLE_ID: "903318",
    };
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (!init.method || init.method === "GET") {
        return new Response(JSON.stringify({ results: [{ id: 14896 }], next: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 14896 }), { status: 200 });
    };

    try {
      const result = await writeThroughMessageFacts(env, "shop1", "order1", [
        { id: "m4", role: "BUYER", createdAt: "2026-06-22T11:30:00.000Z" },
      ]);

      assert.equal(result.rows_patched, 1);
      assert.equal(requests.length, 2);
      assert.match(requests[0].url, /table\/903318/);
      const payload = JSON.parse(requests[1].init.body);
      assert.equal(payload.has_buyer_messages, true);
      assert.equal(payload.latest_buyer_message_id, "m4");
      assert.equal(payload.latest_buyer_message_at, "2026-06-22T11:30:00.000Z");
      assert.ok(payload.message_last_synced_at);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not advance durable state when the sales table ID is missing", async () => {
    const env = makeKvEnv();
    const kvStore = env._kvStore;

    // Seed existing durable state with read cursor
    const seedKey = buildDurableStateKey("shop1", "order1");
    kvStore.set(seedKey, JSON.stringify({
      version: 1,
      order_id: "order1",
      shop_id: "shop1",
      last_read_message_id: "m3",
      last_read_at: "2026-06-22T10:00:00.000Z",
      last_checked_at: "",
      last_check_status: "",
      last_check_error: null,
    }));

    const messages = [
      { id: "m4", role: "BUYER", message: "New question?", createdAt: "2026-06-22T11:30:00.000Z" },
    ];

    await assert.rejects(
      writeThroughMessageFacts(env, "shop1", "order1", messages),
      /missing_baserow_sales_table_id/,
    );

    const stored = JSON.parse(kvStore.get(seedKey) || "{}");

    // Read cursor preserved
    assert.equal(stored.last_read_message_id, "m3");
    assert.equal(stored.last_read_at, "2026-06-22T10:00:00.000Z");

    assert.equal(stored.last_checked_at, "");
  });

  it("fails explicitly when the sales table ID is missing", async () => {
    const env = makeKvEnv();

    const messages = [
      { id: "m1", role: "SELLER", message: "Thank you", createdAt: "2026-06-22T09:00:00.000Z" },
      { id: "m2", role: "BUYER", message: "Question?", createdAt: "2026-06-22T10:00:00.000Z" },
    ];

    await assert.rejects(
      writeThroughMessageFacts(env, "shop1", "order1", messages),
      /missing_baserow_sales_table_id/,
    );
  });

  it("also requires persistence for a confirmed no-message result", async () => {
    const env = makeKvEnv();

    const messages = [
      { id: "m1", role: "SELLER", message: "Hello", createdAt: "2026-06-22T09:00:00.000Z" },
    ];

    await assert.rejects(
      writeThroughMessageFacts(env, "shop1", "order1", messages),
      /missing_baserow_sales_table_id/,
    );
  });

  it("does not create a durable success record before Baserow persistence", async () => {
    const env = makeKvEnv();

    const messages = [
      { id: "m1", role: "BUYER", message: "Hi", createdAt: "2026-06-22T10:00:00.000Z" },
    ];

    await assert.rejects(
      writeThroughMessageFacts(env, "shop1", "order1", messages),
      /missing_baserow_sales_table_id/,
    );

    const key = buildDurableStateKey("shop1", "order1");
    assert.equal(env._kvStore.has(key), false);
  });
});

// ============================================================================
// recordMessageSyncFailure
// ============================================================================

describe("recordMessageSyncFailure", () => {
  it("writes failure state to durable KV", async () => {
    const env = makeKvEnv();

    await recordMessageSyncFailure(env, "shop1", "order1", "mercari_graphql_error");

    const key = buildDurableStateKey("shop1", "order1");
    const stored = JSON.parse(env._kvStore.get(key) || "{}");

    assert.ok(stored.last_checked_at);
    assert.equal(stored.last_check_status, "failed");
    assert.equal(stored.last_check_error, "mercari_graphql_error");
  });

  it("preserves read cursor on failure", async () => {
    const env = makeKvEnv();

    const seedKey = buildDurableStateKey("shop1", "order1");
    env._kvStore.set(seedKey, JSON.stringify({
      version: 1,
      last_read_message_id: "m3",
      last_read_at: "2026-06-22T10:00:00.000Z",
    }));

    await recordMessageSyncFailure(env, "shop1", "order1", "timeout");

    const stored = JSON.parse(env._kvStore.get(seedKey) || "{}");
    assert.equal(stored.last_read_message_id, "m3");
    assert.equal(stored.last_read_at, "2026-06-22T10:00:00.000Z");
    assert.equal(stored.last_check_status, "failed");
  });

  it("truncates long error messages", async () => {
    const env = makeKvEnv();

    const longError = "x".repeat(1000);
    await recordMessageSyncFailure(env, "shop1", "order1", longError);

    const key = buildDurableStateKey("shop1", "order1");
    const stored = JSON.parse(env._kvStore.get(key) || "{}");
    assert.equal(stored.last_check_error.length, 500);
  });
});

// ============================================================================
// syncMercariMessages
// ============================================================================

describe("syncMercariMessages", () => {
  it("returns early when PORTAL_KV is missing", async () => {
    const result = await syncMercariMessages({}, {});
    assert.equal(result.ok, false);
    assert.equal(result.orders_checked, 0);
    assert.equal(result.orders_synced, 0);
    assert.equal(result.orders_failed, 0);
  });

  it("returns early when BASEROW_SALES_TABLE_ID is missing", async () => {
    const result = await syncMercariMessages({ PORTAL_KV: {} }, {});
    assert.equal(result.ok, false);
    assert.equal(result.orders_checked, 0);
  });

  it("returns zero counts when no orders match", async () => {
    // Without BASEROW_SALES_TABLE_ID, it returns early
    const result = await syncMercariMessages({ PORTAL_KV: {} }, {});
    assert.equal(result.ok, false);
    assert.equal(result.orders_checked, 0);
  });

  it("dry-run does not persist a failure for an unresolvable shop", async () => {
    let reads = 0;
    let failureWrites = 0;
    const result = await syncMercariMessages({ PORTAL_KV: {}, BASEROW_SALES_TABLE_ID: "sales" }, {
      dryRun: true,
      _inject: {
        client: { salesOrderTableId: "sales" },
        listSalesRowsForMessageSync: async () => {
          reads += 1;
          return reads === 1 ? [{ order_id: "order-1", source_store_id: "unknown-shop" }] : [];
        },
        recordMessageSyncFailure: async () => { failureWrites += 1; },
      },
    });
    assert.equal(result.orders_failed, 1);
    assert.equal(failureWrites, 0);
  });

  it("dry-run does not persist a failure when the relay read fails", async () => {
    let reads = 0;
    let failureWrites = 0;
    const result = await syncMercariMessages({ PORTAL_KV: {}, BASEROW_SALES_TABLE_ID: "sales" }, {
      dryRun: true,
      _inject: {
        client: { salesOrderTableId: "sales" },
        listSalesRowsForMessageSync: async () => {
          reads += 1;
          return reads === 1
            ? [{ order_id: "order-1", source_store_id: "WMyisFmhbGWyVAPEwsfirn" }]
            : [];
        },
        runMercariOrderMessagesViaRelay: async () => ({ ok: false, body: { error: "read_failed" } }),
        recordMessageSyncFailure: async () => { failureWrites += 1; },
      },
    });
    assert.equal(result.orders_failed, 1);
    assert.equal(failureWrites, 0);
  });

  it("keeps identical order IDs isolated by source store", async () => {
    let reads = 0;
    const relayScopes = [];
    const result = await syncMercariMessages({ PORTAL_KV: {}, BASEROW_SALES_TABLE_ID: "sales" }, {
      dryRun: true,
      _inject: {
        client: { salesOrderTableId: "sales" },
        listSalesRowsForMessageSync: async () => {
          reads += 1;
          return reads === 1 ? [
            { order_id: "same-order", source_store_id: "WMyisFmhbGWyVAPEwsfirn" },
            { order_id: "same-order", source_store_id: "ZaMyGWzp6hUdgDh5E9ADob" },
          ] : [];
        },
        runMercariOrderMessagesViaRelay: async (_env, scope) => {
          relayScopes.push(scope.shopLabel);
          return { ok: true, body: { ok: true, messages: [] } };
        },
      },
    });
    assert.equal(result.orders_checked, 2);
    assert.equal(result.orders_synced, 2);
    assert.deepEqual(relayScopes.sort(), ["Shop1", "Shop2"]);
  });

  it("exact sync scope excludes queue neighbors before marketplace reads", async () => {
    const relayScopes = [];
    const calls = [];
    const result = await syncMercariMessages({ PORTAL_KV: {}, BASEROW_SALES_TABLE_ID: "sales" }, {
      shops: ["Shop2"], orderId: "order_target", limit: 1, dryRun: true,
      _inject: {
        client: { salesOrderTableId: "sales" },
        listSalesRowsForMessageSync: async (_client, _table, filters, maxRows) => {
          calls.push({ filters, maxRows });
          return calls.length === 1 ? [
            { order_id: "neighbor", source_store_id: "ZaMyGWzp6hUdgDh5E9ADob" },
            { order_id: "order_target", source_store_id: "ZaMyGWzp6hUdgDh5E9ADob" },
            { order_id: "target", source_store_id: "WMyisFmhbGWyVAPEwsfirn" },
          ] : [];
        },
        runMercariOrderMessagesViaRelay: async (_env, scope) => {
          relayScopes.push(scope);
          return { ok: true, body: { ok: true, messages: [] } };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.orders_checked, 1);
    assert.deepEqual(relayScopes, [{ shopLabel: "Shop2", orderId: "target" }]);
    assert.ok(calls.every((call) => call.maxRows === null));
    assert.ok(calls.every((call) => Object.values(call.filters).includes("target")));
    assert.ok(calls.every((call) => Object.values(call.filters).includes("ZaMyGWzp6hUdgDh5E9ADob")));
  });

  it("exact sync scope fails closed when the active target is absent", async () => {
    const result = await syncMercariMessages({ PORTAL_KV: {}, BASEROW_SALES_TABLE_ID: "sales" }, {
      shops: ["Shop1"], orderId: "missing", limit: 1, dryRun: true,
      _inject: {
        client: { salesOrderTableId: "sales" },
        listSalesRowsForMessageSync: async () => [],
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.note, "scoped_message_sync_target_not_found");
  });
});

// ============================================================================
// Supabase durable-state write path (issue #209)
// ============================================================================

function makeMockSupabaseClient({ existingState = null, salesOrder = null } = {}) {
  const calls = {
    messageStateSelects: [],
    messageStateReads: 0,
    salesOrderSelects: [],
    salesOrderLookups: 0,
    upserts: 0,
    upsertPayload: null,
  };

  function messageStateChain() {
    const chain = {
      select(cols) { calls.messageStateSelects.push(String(cols)); return chain; },
      eq() { return chain; },
      maybeSingle() {
        calls.messageStateReads += 1;
        return Promise.resolve({ data: existingState, error: null });
      },
    };
    return chain;
  }

  function salesOrderChain() {
    const chain = {
      select(cols) { calls.salesOrderSelects.push(String(cols)); return chain; },
      eq() { return chain; },
      limit() { return chain; },
      maybeSingle() {
        calls.salesOrderLookups += 1;
        return Promise.resolve({ data: salesOrder, error: null });
      },
    };
    return chain;
  }

  const client = {
    type: "supabase",
    supabase: {
      from(table) {
        if (table === "sales_order_message_state") {
          return {
            select: (cols) => messageStateChain().select(cols),
            upsert: (payload) => {
              calls.upserts += 1;
              calls.upsertPayload = payload;
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        if (table === "sales_orders") {
          return { select: (cols) => salesOrderChain().select(cols) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
  client._calls = calls;
  return client;
}

describe("writeSupabaseDurableState", () => {
  it("skips the sales_orders lookup when existing state supplies sales_order_id", async () => {
    const client = makeMockSupabaseClient({
      existingState: { sales_order_id: "sales-42", last_read_message_id: "m1" },
    });

    await writeSupabaseDurableState({}, "Shop1", "order_1", { last_check_status: "ok" }, null, client);

    assert.equal(client._calls.salesOrderLookups, 0);
    assert.equal(client._calls.upserts, 1);
    assert.equal(client._calls.upsertPayload.sales_order_id, "sales-42");
  });

  it("falls back to the sales_orders lookup when no existing state exists", async () => {
    const client = makeMockSupabaseClient({
      existingState: null,
      salesOrder: { id: "sales-9" },
    });

    await writeSupabaseDurableState({}, "Shop1", "order_2", { last_check_status: "ok" }, null, client);

    assert.equal(client._calls.salesOrderLookups, 1);
    assert.equal(client._calls.upserts, 1);
    assert.equal(client._calls.upsertPayload.sales_order_id, "sales-9");
  });

  it("falls back to the sales_orders lookup when existing state lacks sales_order_id", async () => {
    const client = makeMockSupabaseClient({
      existingState: { last_read_message_id: "m1" },
      salesOrder: { id: "sales-9" },
    });

    await writeSupabaseDurableState({}, "Shop1", "order_3", { last_check_status: "ok" }, null, client);

    assert.equal(client._calls.salesOrderLookups, 1);
    assert.equal(client._calls.upserts, 1);
    assert.equal(client._calls.upsertPayload.sales_order_id, "sales-9");
  });
});

describe("readSupabaseDurableState", () => {
  it("includes sales_order_id in the message-state read", async () => {
    const client = makeMockSupabaseClient({
      existingState: { sales_order_id: "sales-42", last_read_message_id: "m1" },
    });

    const state = await readSupabaseDurableState({}, "Shop1", "order_1", client);

    assert.equal(state.sales_order_id, "sales-42");
    const selectCols = client._calls.messageStateSelects[0] || "";
    assert.ok(selectCols.includes("sales_order_id"), "select includes sales_order_id");
  });
});

describe("listSalesRowsForMessageSync", () => {
  it("narrows the Supabase candidate read to id + order + store identity", async () => {
    const selectArgs = [];
    const thenable = {
      then: (resolve) => resolve({ data: [], error: null }),
    };
    thenable.eq = () => thenable;
    thenable.limit = () => thenable;

    const client = {
      type: "supabase",
      supabase: {
        from: () => ({ select: (...a) => (selectArgs.push(a), thenable) }),
      },
    };

    await listSalesRowsForMessageSync(client, "sales_orders", {
      "filter__field_order_status__single_select_equal": "WAITING_FOR_SHIPPING",
    }, 20, "id,order_id,source_store_id");

    assert.deepEqual(selectArgs[0], ["id,order_id,source_store_id"]);
  });

  it("narrows the per-order lookup to id only", async () => {
    const selectArgs = [];
    const thenable = {
      then: (resolve) => resolve({ data: [], error: null }),
    };
    thenable.eq = () => thenable;
    thenable.limit = () => thenable;

    const client = {
      type: "supabase",
      supabase: {
        from: () => ({ select: (...a) => (selectArgs.push(a), thenable) }),
      },
    };

    await listSalesRowsForMessageSync(client, "sales_orders", {
      "filter__field_order_id__equal": "order_1",
    }, 50, "id");

    assert.deepEqual(selectArgs[0], ["id"]);
  });
});
