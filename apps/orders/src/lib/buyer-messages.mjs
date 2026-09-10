/**
 * Extract buyer-message facts from a Mercari transaction messages array.
 *
 * Filters to BUYER-role messages, sorts deterministically (primary by
 * createdAt, tiebreaker by id), and returns the latest buyer message
 * identity plus a boolean presence flag.
 *
 * Message ID is the primary cursor. Timestamp is only a fallback.
 *
 * @param {Array} messages — transaction messages from Mercari GraphQL
 * @returns {{ latest_buyer_message_id: string, latest_buyer_message_at: string|null, has_buyer_messages: boolean }}
 */
export function extractBuyerMessageFacts(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    };
  }

  const buyerMessages = messages.filter((m) => {
    const role = String(m && m.role || "").toUpperCase();
    return role === "BUYER" && (m.id || m.createdAt);
  });

  if (buyerMessages.length === 0) {
    return {
      latest_buyer_message_id: "",
      latest_buyer_message_at: null,
      has_buyer_messages: false,
    };
  }

  const sorted = [...buyerMessages].sort((a, b) => {
    const aTime = String(a.createdAt || "");
    const bTime = String(b.createdAt || "");
    const timeCmp = aTime.localeCompare(bTime);
    if (timeCmp !== 0) return timeCmp;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  const latest = sorted[sorted.length - 1];

  return {
    latest_buyer_message_id: String(latest.id || ""),
    latest_buyer_message_at: latest.createdAt || null,
    has_buyer_messages: true,
  };
}

/**
 * Classify the unread status for a sales order row.
 *
 * Three-state classification:
 *   - unread:  buyer messages exist and last-read cursor is behind or missing
 *   - read:    buyer messages exist and last-read cursor covers the latest
 *   - unknown: message state is incomplete or unhealthy. Unknown is surfaced
 *              separately and never treated as unread.
 *
 * @param {Object} row — enriched portal sales row (must include
 *   has_buyer_messages, latest_buyer_message_at, latest_buyer_message_id)
 * @param {Object|null} kvReadState — parsed KV record for read-state, or null
 * `has_unread` is true only for a persisted buyer message that is ahead of
 * the read cursor (or has no read cursor). Health failures never fabricate it.
 *
 * @returns {{ classification: "unread"|"read"|"unknown", has_unread: boolean }}
 */
export function classifyUnreadStatus(row, kvReadState) {
  const hasBuyerMessages =
    row.has_buyer_messages === true ||
    row.has_buyer_messages === "true" ||
    row.has_buyer_messages === 1 ||
    row.has_buyer_messages === "1";

  if (!hasBuyerMessages) {
    const checkIsUnknown = !kvReadState
      || String(kvReadState.last_check_status || "").trim().toLowerCase() === "failed"
      || isDurableStateStale(row, kvReadState);
    return checkIsUnknown
      ? { classification: "unknown", has_unread: false }
      : { classification: "read", has_unread: false };
  }

  const latestId = String(row.latest_buyer_message_id || "");
  const lastReadId = String(kvReadState && kvReadState.last_read_message_id || "");

  // A persisted latest buyer-message ID is authoritative. A missing read
  // cursor means that confirmed buyer message has never been read.
  if (latestId && lastReadId) {
    return latestId === lastReadId
      ? { classification: "read", has_unread: false }
      : { classification: "unread", has_unread: true };
  }

  // Fallback: timestamp comparison when message IDs are not available.
  const latestAt = String(row.latest_buyer_message_at || "");
  const lastReadAt = String(kvReadState && kvReadState.last_read_at || "");

  if (!latestAt) {
    return latestId
      ? { classification: "unread", has_unread: true }
      : { classification: "unknown", has_unread: false };
  }

  if (!lastReadAt || latestAt > lastReadAt) {
    return { classification: "unread", has_unread: true };
  }

  return { classification: "read", has_unread: false };
}

export function isDurableStateStale(row, kvReadState, now = Date.now()) {
  if (!kvReadState) return true;

  const lastCheckStatus = String(kvReadState.last_check_status || "").trim().toLowerCase();
  if (lastCheckStatus === "failed") return true;

  const lastCheckedAt = String(kvReadState.last_checked_at || "");
  if (!lastCheckedAt) {
    const hasLegacyCursor = !!String(kvReadState.last_read_message_id || kvReadState.last_read_at || "");
    return !hasLegacyCursor;
  }

  const lastCheckedMs = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastCheckedMs)) return true;

  const syncedAt = String(row && row.message_last_synced_at || "");
  const syncedMs = syncedAt ? Date.parse(syncedAt) : NaN;
  const effectiveMs = Number.isFinite(syncedMs) ? Math.max(lastCheckedMs, syncedMs) : lastCheckedMs;
  return (now - effectiveMs) > getUnreadStateStaleMs();
}

export function getUnreadStateStaleMs() {
  return 20 * 60 * 1000;
}

// ── Durable read-state KV helpers (Phase 2) ─────────────────────────

const DURABLE_STATE_PREFIX = "message-state:v1:";

/**
 * Build the durable state KV key for a shop + order.
 * @param {string} shopId
 * @param {string} orderId
 * @returns {string} e.g. "message-state:v1:WMyisFmhbGWyVAPEwsfirn:test-order"
 */
export function buildDurableStateKey(shopId, orderId) {
  return `${DURABLE_STATE_PREFIX}${shopId}:${orderId}`;
}

/**
 * Read durable message state from KV.
 * @param {Object} env — Worker env with PORTAL_KV
 * @param {string} shopId
 * @param {string} orderId
 * @returns {Promise<Object|null>} parsed durable state or null
 */
export async function readDurableState(env, shopId, orderId) {
  if (isSupabaseBackend(env)) {
    try {
      const state = await readSupabaseDurableState(env, shopId, orderId);
      if (state) return state;
    } catch {
      // Fall back to KV during the cutover window.
    }
  }
  if (env?.PORTAL_KV) try {
    const key = buildDurableStateKey(shopId, orderId);
    return await env.PORTAL_KV.get(key, "json");
  } catch {
    return null;
  }
  return null;
}

/**
 * Write durable message state to KV (no TTL).
 * @param {Object} env — Worker env with PORTAL_KV
 * @param {string} shopId
 * @param {string} orderId
 * @param {Object} fields — partial state to merge
 */
export async function writeDurableState(env, shopId, orderId, fields) {
  let kvExisting = null;
  if (env?.PORTAL_KV) try {
    const key = buildDurableStateKey(shopId, orderId);
    kvExisting = await env.PORTAL_KV.get(key, "json").catch(() => null);
    const merged = {
      version: 1,
      order_id: orderId,
      shop_id: shopId,
      last_read_message_id: "",
      last_read_at: "",
      last_checked_at: "",
      last_check_status: "",
      last_check_error: null,
      ...kvExisting,
      ...fields,
    };
    await env.PORTAL_KV.put(key, JSON.stringify(merged));
  } catch {
    /* non-fatal */
  }

  if (isSupabaseBackend(env)) {
    await writeSupabaseDurableState(env, shopId, orderId, fields, kvExisting);
  }
}

/**
 * Mark the given order as read up to the specified buyer message ID.
 *
 * @param {Object} env — Worker env with PORTAL_KV
 * @param {string} shopId
 * @param {string} orderId
 * @param {string} latestBuyerMessageId — the buyer message ID to advance cursor to
 * @returns {Promise<void>}
 */
export async function markAsRead(env, shopId, orderId, latestBuyerMessageId) {
  await writeDurableState(env, shopId, orderId, {
    last_read_message_id: latestBuyerMessageId,
    last_read_at: new Date().toISOString(),
  });
}

function isSupabaseBackend(env) {
  return String(env?.DATABASE_BACKEND || "").trim().toLowerCase() === "supabase";
}

export async function readSupabaseDurableState(env, shopId, orderId, _client) {
  const client = _client || createBaserowClient(env);
  if (client.type !== "supabase") return null;
  const { data, error } = await client.supabase
    .from("sales_order_message_state")
    .select("sales_order_id,last_read_message_id,last_read_at,latest_message_id,latest_message_at,has_unread,last_checked_at,last_check_status,last_check_error")
    .eq("source_store_id", shopId)
    .eq("order_transaction_id", normalizeOrderId(orderId))
    .maybeSingle();
  if (error) throw new Error(`message_state_read_failed:${error.message}`);
  if (!data) return null;
  return {
    sales_order_id: data.sales_order_id || null,
    last_read_message_id: data.last_read_message_id || "",
    last_read_at: data.last_read_at || "",
    latest_message_id: data.latest_message_id || "",
    latest_message_at: data.latest_message_at || "",
    has_unread: data.has_unread === true,
    last_checked_at: data.last_checked_at || "",
    last_check_status: data.last_check_status || "",
    last_check_error: data.last_check_error || null,
  };
}

export async function writeSupabaseDurableState(env, shopId, orderId, fields, kvExisting, _client) {
  const client = _client || createBaserowClient(env);
  if (client.type !== "supabase") return;
  const normalizedOrderId = normalizeOrderId(orderId);
  const existing = await readSupabaseDurableState(env, shopId, normalizedOrderId, client);

  // Reuse the sales_order_id already persisted on the message-state row, so a
  // first-time or malformed state (missing the FK) still falls back to the
  // sales_orders lookup. Skip the extra query whenever existing state has it.
  let salesOrderId = existing && existing.sales_order_id ? existing.sales_order_id : null;
  if (!salesOrderId) {
    const { data: salesOrder, error: salesError } = await client.supabase
      .from("sales_orders")
      .select("id")
      .eq("sales_channel", "mercari")
      .eq("source_store_id", shopId)
      .eq("order_id", normalizedOrderId)
      .limit(1)
      .maybeSingle();
    if (salesError || !salesOrder?.id) {
      throw new Error(`message_state_sales_order_not_found:${salesError?.message || normalizedOrderId}`);
    }
    salesOrderId = salesOrder.id;
  }

  const payload = buildSupabaseDurableStatePayload({
    salesOrderId,
    shopId,
    orderId: normalizedOrderId,
    fields,
    existing,
    fallback: kvExisting,
  });
  const { error } = await client.supabase
    .from("sales_order_message_state")
    .upsert(payload, { onConflict: "source_store_id,order_transaction_id" });
  if (error) throw new Error(`message_state_write_failed:${error.message}`);
}

export function buildSupabaseDurableStatePayload({
  salesOrderId,
  shopId,
  orderId,
  fields = {},
  existing = null,
  fallback = null,
}) {
  const seed = existing ? {} : (fallback || {});
  const changes = { ...seed, ...fields };
  const payload = {
    sales_order_id: salesOrderId,
    source_store_id: shopId,
    order_transaction_id: normalizeOrderId(orderId),
  };
  const nullableFields = [
    "last_read_message_id",
    "last_read_at",
    "latest_message_id",
    "latest_message_at",
    "last_checked_at",
    "last_check_status",
    "last_check_error",
  ];
  for (const field of nullableFields) {
    if (Object.hasOwn(changes, field)) payload[field] = changes[field] || null;
  }

  if (
    Object.hasOwn(changes, "latest_message_id") ||
    Object.hasOwn(changes, "last_read_message_id")
  ) {
    const latestMessageId = String(
      changes.latest_message_id ?? existing?.latest_message_id ?? fallback?.latest_message_id ?? "",
    );
    const lastReadMessageId = String(
      changes.last_read_message_id ?? existing?.last_read_message_id ?? fallback?.last_read_message_id ?? "",
    );
    payload.has_unread = Boolean(latestMessageId) && latestMessageId !== lastReadMessageId;
  } else if (Object.hasOwn(changes, "has_unread")) {
    payload.has_unread = changes.has_unread === true;
  }

  return payload;
}

function normalizeOrderId(value) {
  return String(value || "").trim().replace(/^order_/, "");
}

// ── Phase 3: Scheduled message sync & write-through ─────────────────

import { createBaserowClient, listAllRows, listRowsWithLimit, patchRow, FIELD, OPTION } from "./db.mjs";
import { runMercariOrderMessagesViaRelay } from "./mercari-relay.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";

/**
 * List sales rows for the message-sync path, narrowing the Supabase SELECT to
 * only the columns the caller actually needs. Baserow (no column projection)
 * keeps the legacy full-row read through the db facade.
 *
 * @param {Object} baserow — client from createBaserowClient()
 * @param {string} tableId
 * @param {Object} filterParams
 * @param {number} maxRows
 * @param {string} selectColumns — Supabase comma-separated projection (ignored for Baserow)
 * @returns {Promise<Array>}
 */
export function listSalesRowsForMessageSync(baserow, tableId, filterParams, maxRows, selectColumns) {
  const options = baserow && baserow.type === "supabase"
    ? { select: selectColumns }
    : {};
  if (maxRows === null) return listAllRows(baserow, tableId, filterParams, options);
  return listRowsWithLimit(baserow, tableId, filterParams, maxRows, options);
}

/**
 * Write extracted message facts through to both Baserow (all rows for the
 * order) and the durable KV state.
 *
 * Never modifies last_read_message_id or last_read_at (read cursor).
 *
 * @param {Object} env — Worker env
 * @param {string} shopId
 * @param {string} orderId
 * @param {Array} messages — Mercari GraphQL messages array
 * @returns {Promise<{ facts: Object, rows_patched: number }>}
 */
export async function writeThroughMessageFacts(env, shopId, orderId, messages) {
  const facts = extractBuyerMessageFacts(messages);
  let rowsPatched = 0;
  const syncedAt = new Date().toISOString();

  const configuredTableId = env.BASEROW_SALES_TABLE_ID || env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID;
  if (!isSupabaseBackend(env) && !configuredTableId) {
    throw new Error("missing_baserow_sales_table_id");
  }
  const baserow = createBaserowClient(env);
  const tableId = isSupabaseBackend(env) ? baserow.salesOrderTableId : configuredTableId;
  const filterKey = `filter__field_${FIELD.SALES.ORDER_ID}__equal`;
  const rows = await listSalesRowsForMessageSync(baserow, tableId, { [filterKey]: orderId }, 50, "id");
  if (!rows || rows.length === 0) {
    throw new Error(`sales_order_not_found:${orderId}`);
  }
  for (const row of rows) {
    const patched = await patchRow(baserow, tableId, row.id, {
      latest_buyer_message_id: facts.latest_buyer_message_id,
      latest_buyer_message_at: facts.latest_buyer_message_at || null,
      has_buyer_messages: facts.has_buyer_messages,
      message_last_synced_at: syncedAt,
    });
    if (!patched.ok) {
      throw new Error(`buyer_message_facts_patch_failed:${patched.error || patched.status}`);
    }
    rowsPatched++;
  }

  // Write durable KV health fields — never touches read cursor
  await writeDurableState(env, shopId, orderId, {
    latest_message_id: facts.latest_buyer_message_id,
    latest_message_at: facts.latest_buyer_message_at || null,
    has_unread: facts.has_buyer_messages,
    last_checked_at: syncedAt,
    last_check_status: "ok",
    last_check_error: null,
  });

  return { facts, rows_patched: rowsPatched };
}

/**
 * Record a message-sync failure in durable KV state.
 * Failed state must not present as read to the portal.
 *
 * @param {Object} env — Worker env
 * @param {string} shopId
 * @param {string} orderId
 * @param {string} errorMessage
 */
export async function recordMessageSyncFailure(env, shopId, orderId, errorMessage) {
  await writeDurableState(env, shopId, orderId, {
    last_checked_at: new Date().toISOString(),
    last_check_status: "failed",
    last_check_error: String(errorMessage).slice(0, 500),
  });
}

/**
 * Phase 3: Scheduled message sync for active orders.
 *
 * For each active (non-terminal) order, fetches live Mercari messages via
 * relay, derives buyer-message facts, and writes through to both Baserow
 * and durable KV state. The read cursor (last_read_message_id,
 * last_read_at) is never modified.
 *
 * @param {Object} env — Worker env
 * @param {{ limit?: number, dryRun?: boolean }} options
 * @returns {Promise<{ ok: boolean, orders_checked: number, orders_synced: number, orders_failed: number }>}
 */
export async function syncMercariMessages(env, options = {}) {
  const { limit = 20, dryRun = false } = options;
  const injected = options._inject || {};
  const listRowsForSync = injected.listSalesRowsForMessageSync || listSalesRowsForMessageSync;
  const fetchMessages = injected.runMercariOrderMessagesViaRelay || runMercariOrderMessagesViaRelay;
  const recordFailure = injected.recordMessageSyncFailure || recordMessageSyncFailure;
  const writeFacts = injected.writeThroughMessageFacts || writeThroughMessageFacts;
  const summary = { ok: true, orders_checked: 0, orders_synced: 0, orders_failed: 0 };
  const exactOrderId = normalizeOrderId(options.orderId);
  const selectedShops = (options.shops || []).filter((shop) => MERCARI_CHANNEL.shopIds[shop]);
  if (exactOrderId && selectedShops.length !== 1) {
    return { ...summary, ok: false, note: "scoped_message_sync_requires_single_shop" };
  }
  const exactStoreId = exactOrderId ? MERCARI_CHANNEL.shopIds[selectedShops[0]] : "";

  const configuredTableId = env.BASEROW_SALES_TABLE_ID || env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID;
  if (!env.PORTAL_KV && !isSupabaseBackend(env)) {
    summary.ok = false;
    summary.note = "missing durable message-state backend";
    return summary;
  }
  if (!isSupabaseBackend(env) && !configuredTableId) {
    summary.ok = false;
    summary.note = "missing Mercari sales table ID";
    return summary;
  }
  const baserow = injected.client || createBaserowClient(env);
  const tableId = isSupabaseBackend(env) ? baserow.salesOrderTableId : configuredTableId;

  // Fetch active (non-terminal) orders that may have buyer messages.
  // We target WAITING_FOR_PAYMENT and WAITING_FOR_SHIPPING — the two
  // statuses where buyer-seller messaging is active.
  const statuses = [
    OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT,
    OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
  ];

  const orderScopes = new Set();
  const orderRows = [];

  for (const status of statuses) {
    try {
      const filters = {
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: status,
      };
      if (exactOrderId) {
        filters[`filter__field_${FIELD.SALES.ORDER_ID}__equal`] = exactOrderId;
        filters[`filter__field_${FIELD.SALES.SHOP_ID}__equal`] = exactStoreId;
      }
      const rows = await listRowsForSync(baserow, tableId, filters,
        exactOrderId ? null : limit, "id,order_id,source_store_id");
      for (const row of rows) {
        const oid = normalizeOrderId(row.order_id);
        const sid = String(row.source_store_id || row.shop_id || "").trim();
        if (exactOrderId && (oid !== exactOrderId || sid !== exactStoreId)) continue;
        const scopeKey = `${sid}::${oid}`;
        if (oid && sid && !orderScopes.has(scopeKey)) {
          orderScopes.add(scopeKey);
          orderRows.push({ orderId: oid, shopId: sid });
        }
      }
    } catch (_) { /* non-fatal per-status */ }
  }

  summary.orders_checked = orderRows.length;
  if (exactOrderId && orderRows.length === 0) {
    summary.ok = false;
    summary.note = "scoped_message_sync_target_not_found";
    return summary;
  }

  // Candidates for webhook coverage checking — collected during the sync loop
  // and processed in bulk afterwards (no per-order N+1 lookups).
  const coverageCandidates = [];

  for (const { orderId, shopId } of orderRows) {
    // Resolve shop label
    let shopLabel = null;
    for (const [label, mappedId] of Object.entries(MERCARI_CHANNEL.shopIds)) {
      if (mappedId === shopId) { shopLabel = label; break; }
    }
    if (!shopLabel) {
      if (!dryRun) await recordFailure(env, shopId, orderId, "unresolvable_shop_id");
      summary.orders_failed++;
      continue;
    }

    try {
      const relayResult = await fetchMessages(env, { shopLabel, orderId });
      if (!relayResult.ok || !relayResult.body || !relayResult.body.ok) {
        const errMsg = (relayResult.body && relayResult.body.error) || "mercari_graphql_error";
        if (!dryRun) await recordFailure(env, shopId, orderId, errMsg);
        summary.orders_failed++;
        continue;
      }

      const messages = relayResult.body.messages || [];

      if (dryRun) {
        summary.orders_synced++;
        continue;
      }

      await writeFacts(env, shopId, orderId, messages);
      summary.orders_synced++;

      // Collect for bulk webhook-coverage checking (below).
      const facts = extractBuyerMessageFacts(messages);
      if (facts.has_buyer_messages && facts.latest_buyer_message_id) {
        coverageCandidates.push({
          shopId,
          orderId: normalizeOrderId(orderId),
          latestBuyerMessageId: facts.latest_buyer_message_id,
        });
      }
    } catch (err) {
      const msg = (err && (err.message || String(err))) || "relay_call_failed";
      if (!dryRun) await recordFailure(env, shopId, orderId, msg);
      summary.orders_failed++;
    }
  }

  // Bulk webhook coverage check — one query + one audit insert + one RPC
  // for all candidates instead of per-order lookups.
  await recordWebhookMissesBulk(env, coverageCandidates);

  return summary;
}

// ── Webhook miss detection (bulk) ──────────────────────────────────────

/**
 * Compare buyer-message facts discovered by polling against processed webhook
 * events, and record any miss (polling saw a message the webhook path never
 * delivered). Bulk implementation: one coverage query, then one governed RPC
 * that atomically inserts the reconciliation audit event AND increments the
 * miss counter only when the audit row is newly created (idempotent across
 * repeated sync runs — a duplicate never re-increments).
 *
 * A webhook miss means NO webhook event covered the message — it must never
 * touch `last_webhook_received_at` (that field records actual webhook receipt).
 *
 * Only active when DATABASE_BACKEND=supabase and WEBHOOK_INTAKE_ENABLED=true.
 * Logs aggregate counts only — shop/order/message identifiers are never logged.
 *
 * @param {Object} env - Worker env
 * @param {Array<{ shopId: string, orderId: string, latestBuyerMessageId: string }>} candidates
 * @returns {Promise<{ checked: number, misses: number, reconciled: number, covered: number }>}
 */
export async function recordWebhookMissesBulk(env, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { checked: 0, misses: 0, reconciled: 0, covered: 0 };
  }
  if (!isSupabaseBackend(env)) {
    return { checked: candidates.length, misses: 0, reconciled: 0, covered: 0 };
  }
  const enabled = String(env.WEBHOOK_INTAKE_ENABLED || "").trim().toLowerCase();
  if (enabled !== "true" && enabled !== "1") {
    return { checked: candidates.length, misses: 0, reconciled: 0, covered: 0 };
  }

  const client = createBaserowClient(env);
  if (client.type !== "supabase") {
    return { checked: candidates.length, misses: 0, reconciled: 0, covered: 0 };
  }

  // 1. Bulk coverage lookup — one query for all candidates
  const shopIds = [...new Set(candidates.map((c) => c.shopId))];
  const orderIds = [...new Set(candidates.map((c) => c.orderId))];

  const { data: coveredEvents, error } = await client.supabase
    .from("order_management_message_webhook_event")
    .select("shop_id, order_id, buyer_message_id")
    .eq("processing_status", "processed")
    .in("shop_id", shopIds)
    .in("order_id", orderIds);

  if (error) {
    console.warn(`[webhook-miss-check] Coverage query failed: ${truncate(error.message)}`);
    return { checked: candidates.length, misses: 0, reconciled: 0, covered: 0 };
  }

  const covered = new Set(
    (coveredEvents || [])
      .filter((e) => e.buyer_message_id)
      .map((e) => `${e.shop_id}|${e.order_id}|${e.buyer_message_id}`),
  );

  const misses = candidates.filter(
    (c) => !covered.has(`${c.shopId}|${c.orderId}|${c.latestBuyerMessageId}`),
  );

  const summary = {
    checked: candidates.length,
    misses: misses.length,
    reconciled: 0,
    covered: candidates.length - misses.length,
  };
  if (misses.length === 0) return summary;

  // 2. Single governed RPC: inserts audit events (idempotency-key dedup) and
  //    increments webhook_miss_count only for newly created rows. Atomic —
  //    a duplicate reconciliation insert can never double-count a miss.
  try {
    const { data: reconciled, error: rpcError } = await client.supabase.rpc(
      "reconcile_order_msg_webhook_misses",
      {
        events: misses.map((c) => ({
          idempotency_key: `reconciliation:${c.shopId}:${c.orderId}:${c.latestBuyerMessageId}`,
          shop_id: c.shopId,
          order_id: c.orderId,
          buyer_message_id: c.latestBuyerMessageId,
        })),
      },
    );
    if (rpcError) {
      console.warn(`[webhook-miss] Reconcile RPC failed: ${truncate(rpcError.message)}`);
      return summary;
    }
    summary.reconciled = Number(reconciled) || 0;
  } catch (e) {
    console.warn(`[webhook-miss] Reconcile RPC failed: ${truncate(e.message)}`);
    return summary;
  }

  // Aggregate counts only — never log shop/order/message identifiers.
  console.log(JSON.stringify({
    webhook_miss: true,
    checked: summary.checked,
    covered: summary.covered,
    misses: summary.misses,
    reconciled: summary.reconciled,
  }));

  return summary;
}

function truncate(value, maxLength = 300) {
  const s = String(value == null ? "" : value).trim();
  if (s.length <= maxLength) return s;
  return `${s.slice(0, maxLength)}…`;
}
