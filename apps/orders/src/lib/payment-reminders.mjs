/**
 * Mercari payment reminders — day 2 and day 3 automatic messages for
 * orders stuck in WAITING_FOR_PAYMENT.
 *
 * Cron: 0 23 * * * = 08:00 JST
 * Phase: send_payment_reminders
 *
 * Guardrails (all fail closed):
 *   R5 — Product stock filter (owned_qty >= 1 OR qty_available >= 1,
 *         checked for ALL line items on the order)
 *   R6 — Buyer-contact guard (skip if latest message is from BUYER)
 *   R7 — Idempotency (reserve slot BEFORE sending; release on failure)
 *   R8 — Live status check (recheck transaction status via relay
 *         immediately before sending)
 *
 * See: docs/trd/mercari-payment-reminder.md
 */

import { createBaserowClient } from "./db.mjs";
import { OPTION } from "./db-fields.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";
import { findProductByItemCode } from "./product-resolver.mjs";
import { runMercariOrderMessagesViaRelay, runMercariOrderReplyViaRelay } from "./mercari-relay.mjs";
import { findTemplateByTitle } from "./portal-templates.mjs";
import { formatJstDate } from "./timezone.mjs";
import { text } from "./worker-helpers.mjs";
import { MERCARI_FRESHNESS_SCOPES, requireLifecycleFreshness } from "./lifecycle-freshness.mjs";
import {
  getReminderDay,
  isProductInStock,
  renderTemplate,
  getDeadlineDate,
  getEligiblePurchaseWindow,
  isWaitingForPaymentStatus,
} from "./payment-reminders-pure.mjs";

// Re-export pure functions for testability
export { getReminderDay, isProductInStock, renderTemplate, getDeadlineDate, getEligiblePurchaseWindow, isWaitingForPaymentStatus };

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const DAY2_TEMPLATE_TITLE = "payment_reminder_day2";
const DAY3_TEMPLATE_TITLE = "payment_reminder_day3";

const CANDIDATE_PAGE_SIZE = 200;
const MAX_CANDIDATE_PAGES = 25;

// Default template bodies — used as fallback when no template row exists.
// Variables: {{product_name}}, {{purchase_date}}, {{deadline_date}}
const DEFAULT_DAY2_TEMPLATE =
  `この度はご購入いただきありがとうございます。\n商品の在庫を確保しておりますので、お早めにお支払いをお願いいたします。\n\nなお、コンビニ・ATM払いの場合、購入日を含めて3日目の23:59までにお支払いいただけないと、4日目の0:00に自動キャンセルとなりますのでご注意ください。\n\nご不明な点がございましたら、お気軽にメッセージにてお問い合わせください。`;

const DEFAULT_DAY3_TEMPLATE =
  `お支払い期限が本日23:59までとなっております。\n商品の在庫は本日終了時点まで確保しておりますので、お早めにお支払いください。\n\n期限内にお支払いいただけない場合、注文は明日0:00に自動的にキャンセルされますので、ご注意ください。\n\nご不明な点がございましたら、お気軽にメッセージにてお問い合わせください。`;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Main entry point for the send_payment_reminders Worker phase.
 *
 * Query flow:
 *   1. Server-side filter by Mercari channel + WAITING_FOR_PAYMENT status
 *      + purchase_date in window. Ordered by purchase_date, order_id.
 *   2. Deduplicate by (order_id, source_store_id) — one reminder per
 *      transaction, not per line item.
 *   3. Apply client-side limit after dedup.
 *   4. For each order: check reminder day, check ALL line items' stock,
 *      atomically reserve idempotency slot, fetch live transaction state
 *      (status + latest message role), then send and confirm or release.
 *
 * @param {Object} env — Worker env (Supabase, relay URL, secrets)
 * @param {{ limit?: number, shops?: string[], orderId?: string, dryRun?: boolean }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   orders_checked: number,
 *   day2_sent: number,
 *   day3_sent: number,
 *   skipped_out_of_stock: number,
 *   skipped_buyer_contact: number,
 *   skipped_already_sent: number,
 *   skipped_not_waiting: number,
 *   skipped_no_product: number,
 *   skipped_wrong_day: number,
 *   failed: number,
 *   note?: string,
 * }>}
 */
export async function sendPaymentReminders(env, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const dryRun = options.dryRun === true;
  const fetchMessages = options.fetchOrderMessages || runMercariOrderMessagesViaRelay;
  const sendReply = options.sendOrderReply || runMercariOrderReplyViaRelay;

  const summary = {
    ok: true,
    orders_checked: 0,
    day2_sent: 0,
    day3_sent: 0,
    skipped_out_of_stock: 0,
    skipped_buyer_contact: 0,
    skipped_already_sent: 0,
    skipped_not_waiting: 0,
    skipped_no_product: 0,
    skipped_wrong_day: 0,
    blocked_by_freshness: 0,
    ambiguous_checked: 0,
    ambiguous_reconciled_sent: 0,
    ambiguous_released: 0,
    ambiguous_failed: 0,
    failed: 0,
  };
  const exactOrderId = normalizeReminderOrderId(options.orderId);
  const selectedShops = (options.shops || []).filter((shop) => MERCARI_CHANNEL.shopIds[shop]);
  if (exactOrderId && selectedShops.length !== 1) {
    summary.ok = false;
    summary.note = "scoped_payment_reminder_requires_single_shop";
    return summary;
  }
  const exactStoreId = exactOrderId ? MERCARI_CHANNEL.shopIds[selectedShops[0]] : "";

  const baserow = options.client || createBaserowClient(env);
  if (baserow.type !== "supabase") {
    summary.ok = false;
    summary.note = "payment_reminders_require_supabase_backend";
    return summary;
  }

  const tableId = baserow.salesOrderTableId;
  if (!tableId) {
    summary.ok = false;
    summary.note = "missing_sales_order_table_id";
    return summary;
  }

  const shadowFreshness = acceptShadowLifecycleEvidence(options);
  const freshness = shadowFreshness || await requireLifecycleFreshness(baserow.supabase, {
      requiredScopes: exactStoreId ? [`mercari:${exactStoreId}`] : env.PAYMENT_REMINDER_FRESHNESS_SCOPES,
      fallbackScopes: MERCARI_FRESHNESS_SCOPES,
      maxAgeMinutes: env.PAYMENT_REMINDER_MAX_FRESHNESS_MINUTES,
    });
  if (!freshness.ok) {
    summary.ok = false;
    summary.blocked_by_freshness = freshness.failures.length;
    summary.note = "blocked_by_freshness";
    summary.freshness = freshness;
    return summary;
  }

  if (!dryRun) {
    const ambiguous = await reconcileAmbiguousReminders(env, baserow, {
      limit, fetchMessages, orderId: exactOrderId, sourceStoreId: exactStoreId,
    });
    summary.ambiguous_checked = ambiguous.checked;
    summary.ambiguous_reconciled_sent = ambiguous.reconciledSent;
    summary.ambiguous_released = ambiguous.released;
    summary.ambiguous_failed = ambiguous.failed;
    if (!ambiguous.ok) {
      summary.ok = false;
      summary.note = "ambiguous_reconciliation_failed";
      return summary;
    }
  }

  // ── 1. Query candidate orders with server-side filters ──────────────
  const waitStatus = OPTION.ORDER_STATUS.WAITING_FOR_PAYMENT;

  const nowJst = new Date();
  const purchaseWindow = getEligiblePurchaseWindow(nowJst);

  let rows;
  try {
    // Fetch candidate rows with server-side filters + deterministic ordering.
    // We fetch up to 3× limit because dedup reduces count.
    rows = await fetchCandidateOrders(baserow, tableId, {
      orderStatus: waitStatus,
      salesChannel: "mercari",
      purchaseDateStart: purchaseWindow.start,
      purchaseDateEnd: purchaseWindow.end,
      transactionLimit: limit,
      orderId: exactOrderId,
      sourceStoreId: exactStoreId,
    });
  } catch (err) {
    summary.ok = false;
    summary.note = `query_failed:${(err && err.message) || String(err)}`;
    return summary;
  }

  if (!rows || rows.length === 0) {
    if (exactOrderId) {
      summary.ok = false;
      summary.note = "scoped_payment_reminder_target_not_found";
    }
    return summary;
  }

  // ── 2. Group by transaction & validate ─────────────────────────────

  // Group all rows by (order_id, source_store_id), keeping all rows per
  // group so we can check stock across every line item.
  const orderGroups = new Map();
  for (const row of rows) {
    const oid = text(row.order_id);
    const sid = text(row.source_store_id || row.shop_id);
    if (!oid || !sid) continue;
    const key = `${oid}::${sid}`;
    if (!orderGroups.has(key)) {
      orderGroups.set(key, { orderId: oid, sourceStoreId: sid, lineItems: [] });
    }
    orderGroups.get(key).lineItems.push(row);
  }

  // Deduplicate to limit after grouping
  const orders = [...orderGroups.values()].slice(0, limit);
  summary.orders_checked = orders.length;

  // ── 3. Process each order ──────────────────────────────────────────
  for (const { orderId, sourceStoreId, lineItems } of orders) {
    try {
      const firstRow = lineItems[0];

      // a. Calculate reminder day
      const reminderDay = getReminderDay(firstRow.purchase_date, nowJst);
      if (!reminderDay) {
        summary.skipped_wrong_day++;
        continue;
      }

      // b. Resolve shop label
      const shopLabel = resolveMercariShopLabel(sourceStoreId);
      if (!shopLabel) {
        summary.failed++;
        continue;
      }

      // c. Check product stock (R5) — check ALL line items
      const stockResult = await checkAllProductsInStock(env, lineItems);
      if (stockResult === "out_of_stock") {
        summary.skipped_out_of_stock++;
        continue;
      }
      if (stockResult === "no_product") {
        summary.skipped_no_product++;
        continue;
      }

      // d. Fetch live transaction state (R6 + R8 combined in one relay call)
      //    Returns: { status?, latestRole, messages }
      const txState = await fetchTransactionState(env, shopLabel, orderId, fetchMessages);
      if (txState === "error") {
        summary.failed++;
        continue;
      }

      // R8: Live status check — recheck the order is still waiting for payment
      if (!isWaitingForPaymentStatus(txState.status)) {
        summary.skipped_not_waiting++;
        continue;
      }

      // R6: Buyer-contact guard — skip if latest message is from buyer
      if (txState.latestRole === "BUYER") {
        summary.skipped_buyer_contact++;
        continue;
      }

      // e. Render the exact intent before reservation so an ambiguous result
      // can be reconciled against authoritative Mercari message history.
      const templateBody = await loadReminderTemplate(env, reminderDay);
      const rendered = renderTemplate(templateBody, {
        product_name: text(firstRow.product_name),
        purchase_date: firstRow.purchase_date ? formatJstDate(new Date(firstRow.purchase_date)) : "",
        deadline_date: getDeadlineDate(firstRow.purchase_date),
      });

      // f. Dry-run must not mutate the reservation table.
      if (dryRun) {
        console.log(`[dry-run] payment_reminder: would send ${reminderDay} to ${orderId} (${shopLabel})`);
        summary[`${reminderDay}_sent`]++;
        continue;
      }

      // g. Idempotency (R7) — atomically reserve slot BEFORE sending
      const reservation = await reserveReminderSlot(baserow, {
        orderId,
        sourceStoreId,
        reminderType: reminderDay,
        messageText: rendered,
      });
      if (!reservation.ok) {
        if (reservation.alreadyReserved) {
          summary.skipped_already_sent++;
        } else {
          summary.failed++;
        }
        continue;
      }

      // h. Send. Keep the reservation on every failure because delivery may
      // have succeeded even when the relay response was lost or timed out.
      const sendResult = await sendReminder(env, shopLabel, orderId, rendered, sendReply);
      if (!sendResult.ok) {
        await markReminderUnknown(baserow, reservation.id, sendResult.error);
        console.warn(`payment_reminder: send failed for ${orderId}: ${sendResult.error}`);
        summary.failed++;
        continue;
      }

      // i. Confirm reservation with send details
      const confirmed = await confirmReminderSlot(baserow, reservation.id, {
        messageText: rendered,
        mercariMessageId: sendResult.mercariMessageId || null,
      });
      if (!confirmed) {
        summary.failed++;
        continue;
      }

      console.log(`payment_reminder: sent ${reminderDay} reminder for ${orderId} (${shopLabel})`);
      summary[`${reminderDay}_sent`]++;

    } catch (err) {
      console.error(`payment_reminder: unexpected error for ${orderId}: ${(err && err.message) || String(err)}`);
      summary.failed++;
    }
  }

  return summary;
}

export function acceptShadowLifecycleEvidence(options = {}) {
  const evidence = options.lifecycleFreshnessEvidence;
  if (options.dryRun !== true || !evidence || !options.runId) return null;
  if (evidence.run_id !== options.runId || evidence.execution_mode !== "shadow") return null;
  if (evidence.platform !== "mercari" || evidence.completion_state !== "accounting_complete") return null;
  return { ok: true, source: "same_run_shadow_lifecycle", failures: [], ...evidence };
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Fetch candidate orders with server-side filters and deterministic ordering.
 *
 * Filters: Mercari sales channel, WAITING_FOR_PAYMENT status,
 * purchase_date >= cutoff.
 * Orders: by purchase_date ASC, order_id ASC (deterministic pagination).
 *
 * @param {Object} baserow
 * @param {string} tableId
 * Pages through the exact eligible purchase window until the requested number
 * of complete transaction groups has been collected. Ordering by transaction
 * keys keeps every selected transaction's line items contiguous.
 * @returns {Promise<Object[]>}
 */
async function fetchCandidateOrders(baserow, tableId, opts) {
  const rows = [];
  const seenTransactions = new Set();

  for (let page = 0; page < MAX_CANDIDATE_PAGES; page += 1) {
    const from = page * CANDIDATE_PAGE_SIZE;
    const to = from + CANDIDATE_PAGE_SIZE - 1;
    let query = baserow.supabase
      .from(tableId)
      .select("*")
      .eq("sales_channel", opts.salesChannel)
      .eq("order_status", opts.orderStatus)
      .gte("purchase_date", opts.purchaseDateStart)
      .lt("purchase_date", opts.purchaseDateEnd);
    query = applyExactPaymentReminderScope(query, opts);
    const { data, error } = await query
      .order("order_id", { ascending: true })
      .order("source_store_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);

    if (error) throw new Error(`supabase_list_failed:${error.message}`);
    const pageRows = Array.isArray(data) ? data : [];
    if (pageRows.length === 0) break;

    for (const row of pageRows) {
      const key = `${text(row.order_id)}::${text(row.source_store_id || row.shop_id)}`;
      if (seenTransactions.size >= opts.transactionLimit && !seenTransactions.has(key)) {
        return rows;
      }
      rows.push(row);
      seenTransactions.add(key);
    }

    if (pageRows.length < CANDIDATE_PAGE_SIZE) break;
  }

  return rows;
}

/**
 * Resolve shop label from source store ID using the Mercari channel config.
 */
function resolveMercariShopLabel(sourceStoreId) {
  const trimmed = String(sourceStoreId || "").trim();
  if (!trimmed) return null;
  for (const [label, mappedId] of Object.entries(MERCARI_CHANNEL.shopIds)) {
    if (mappedId === trimmed) return label;
  }
  return null;
}

/**
 * Check stock for ALL line items on an order (R5).
 *
 * Collects unique B2B item codes across all line items, resolves each,
 * and verifies at least one has stock. If any product is out of stock
 * or unresolvable, the order is skipped.
 *
 * @param {Object} env
 * @param {Object[]} lineItems — all sales_orders rows for this transaction
 * @returns {Promise<'in_stock'|'out_of_stock'|'no_product'>}
 */
async function checkAllProductsInStock(env, lineItems) {
  // Collect unique item codes across all line items
  const itemCodes = [...new Set(
    lineItems
      .map((row) => text(row.b2b_item_code))
      .filter(Boolean)
  )];

  if (itemCodes.length === 0) return "no_product";

  for (const itemCode of itemCodes) {
    try {
      const productData = await findProductByItemCode(env, null, null, itemCode);
      if (!productData) return "no_product";
      if (!isProductInStock(productData)) return "out_of_stock";
    } catch (err) {
      console.warn(`payment_reminder: product lookup failed for ${itemCode}: ${(err && err.message) || String(err)}`);
      return "no_product"; // fail closed
    }
  }

  return "in_stock";
}

/**
 * Fetch live transaction state from Mercari via relay.
 *
 * Combines R6 (buyer-contact guard) and R8 (live status check) into one
 * relay call to `/admin/order-messages`.
 *
 * @param {Object} env
 * @param {string} shopLabel
 * @param {string} orderId
 * @returns {Promise<{status?: string, latestRole?: string}|'error'>}
 */
async function fetchTransactionState(env, shopLabel, orderId, fetchMessages = runMercariOrderMessagesViaRelay) {
  try {
    const result = await fetchMessages(env, { shopLabel, orderId });
    if (!result.ok || !result.body || !result.body.ok) {
      return "error";
    }

    const body = result.body;
    const messages = body.messages || [];

    // Latest message role (R6)
    let latestRole = "seller_or_none";
    if (messages.length > 0) {
      const sorted = [...messages].sort((a, b) => {
        const timeCmp = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        if (timeCmp !== 0) return timeCmp;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
      latestRole = String(sorted[0].role || "").toUpperCase();
    }

    return {
      status: body.status || null, // R8 — may be absent on older relay
      latestRole,
      messages,
    };
  } catch (err) {
    console.warn(`payment_reminder: transaction state fetch failed for ${orderId}: ${(err && err.message) || String(err)}`);
    return "error";
  }
}

/**
 * Check whether a Mercari transaction status indicates the order is still
 * waiting for payment.
 *
 * The existing Mercari ingest and probe paths use WAITING_FOR_PAYMENT for
 * unpaid transactions. Missing or unknown values fail closed.
 */
/**
 * Atomically reserve a reminder slot in payment_reminders.
 *
 * Uses INSERT with the unique constraint on (order_id, source_store_id,
 * reminder_type). If a row already exists, the INSERT fails with a unique
 * violation, which means the reminder was already sent.
 *
 * The row is inserted with placeholder message_text='reserved'.
 * After successful send, confirmReminderSlot() updates the row with the
 * actual message details. On send failure, the reservation remains because
 * delivery may have succeeded before a relay timeout or lost response.
 *
 * @param {Object} baserow — Supabase client wrapper
 * @param {{ orderId: string, sourceStoreId: string, reminderType: 'day2'|'day3' }} params
 * @returns {Promise<{ok: boolean, id?: string, alreadyReserved?: boolean}>}
 */
async function reserveReminderSlot(baserow, params) {
  try {
    const { data, error } = await baserow.supabase
      .rpc("reserve_payment_reminder", {
        p_order_id: params.orderId,
        p_source_store_id: params.sourceStoreId,
        p_reminder_type: params.reminderType,
        p_message_text: params.messageText,
      });

    if (error) {
      console.warn(`payment_reminder: reservation failed for ${params.orderId}: ${error.message}`);
      return { ok: false };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.claimed) return { ok: false, alreadyReserved: true };
    return { ok: true, id: row.id };
  } catch (err) {
    console.warn(`payment_reminder: reservation error for ${params.orderId}: ${(err && err.message) || String(err)}`);
    return { ok: false };
  }
}

/**
 * Confirm a reserved reminder slot with the actual send details.
 *
 * @param {Object} baserow
 * @param {string} reservationId — row ID from reserveReminderSlot
 * @param {{ messageText: string, mercariMessageId: string|null }} details
 */
async function confirmReminderSlot(baserow, reservationId, details) {
  try {
    const { data, error } = await baserow.supabase
      .from("payment_reminders")
      .update({
        message_text: details.messageText,
        mercari_message_id: details.mercariMessageId || null,
        delivery_state: "SENT",
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", reservationId)
      .in("delivery_state", ["RESERVED", "UNKNOWN_RESULT"])
      .select("id")
      .maybeSingle();

    if (error) {
      console.warn(`payment_reminder: confirm failed for reservation ${reservationId}: ${error.message}`);
      return false;
    }
    return Boolean(data?.id);
  } catch (err) {
    console.warn(`payment_reminder: confirm error for reservation ${reservationId}: ${(err && err.message) || String(err)}`);
    return false;
  }
}

async function markReminderUnknown(baserow, reservationId, errorText) {
  await baserow.supabase.from("payment_reminders").update({
    delivery_state: "UNKNOWN_RESULT",
    reconciliation_error: String(errorText || "ambiguous_send").slice(0, 500),
  }).eq("id", reservationId).eq("delivery_state", "RESERVED");
}

export function findMatchingReminderMessage(messages, reminder) {
  const reservedAt = Date.parse(String(reminder.reserved_at || ""));
  if (!Number.isFinite(reservedAt) || !String(reminder.message_text || "").trim()) return null;
  return (messages || []).find((message) => {
    if (String(message.role || "").toUpperCase() !== "SELLER") return false;
    if (String(message.message || "").trim() !== String(reminder.message_text).trim()) return false;
    const createdAt = Date.parse(String(message.createdAt || ""));
    return Number.isFinite(createdAt) && createdAt >= reservedAt;
  }) || null;
}

async function reconcileAmbiguousReminders(env, baserow, { limit, fetchMessages, orderId = "", sourceStoreId = "" }) {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  let query = baserow.supabase.from("payment_reminders")
    .select("id,order_id,source_store_id,message_text,reserved_at,delivery_state")
    .in("delivery_state", ["RESERVED", "UNKNOWN_RESULT"])
    .lte("reserved_at", cutoff);
  query = applyExactPaymentReminderScope(query, { orderId, sourceStoreId });
  const { data, error } = await query.order("reserved_at", { ascending: true }).limit(limit);
  const result = { ok: !error, checked: 0, reconciledSent: 0, released: 0, failed: error ? 1 : 0 };
  if (error) return result;
  for (const reminder of data || []) {
    result.checked++;
    const shopLabel = resolveMercariShopLabel(reminder.source_store_id);
    if (!shopLabel) { result.failed++; result.ok = false; continue; }
    const state = await fetchTransactionState(env, shopLabel, reminder.order_id, fetchMessages);
    if (state === "error") { result.failed++; result.ok = false; continue; }
    const match = findMatchingReminderMessage(state.messages, reminder);
    const nextState = match ? "RECONCILED_SENT" : "RELEASED";
    const { error: updateError } = await baserow.supabase.from("payment_reminders").update({
      delivery_state: nextState,
      mercari_message_id: match?.id || null,
      confirmed_at: match ? (match.createdAt || new Date().toISOString()) : null,
      last_reconciled_at: new Date().toISOString(),
      reconciliation_error: null,
    }).eq("id", reminder.id).eq("delivery_state", reminder.delivery_state);
    if (updateError) { result.failed++; result.ok = false; continue; }
    if (match) result.reconciledSent++; else result.released++;
  }
  return result;
}

function normalizeReminderOrderId(value) {
  return text(value).replace(/^order_/, "");
}

export function applyExactPaymentReminderScope(query, { orderId = "", sourceStoreId = "" } = {}) {
  let scoped = query;
  if (orderId) scoped = scoped.eq("order_id", normalizeReminderOrderId(orderId));
  if (sourceStoreId) scoped = scoped.eq("source_store_id", text(sourceStoreId));
  return scoped;
}

/**
 * Load the reminder template body. Falls back to hardcoded defaults if the
 * template table is unavailable or the template row is missing.
 */
async function loadReminderTemplate(env, reminderDay) {
  const title = reminderDay === "day2" ? DAY2_TEMPLATE_TITLE : DAY3_TEMPLATE_TITLE;
  try {
    const template = await findTemplateByTitle(env, title);
    if (template && template.body) {
      return String(template.body).trim();
    }
  } catch (_) { /* fall through to default */ }
  return reminderDay === "day2" ? DEFAULT_DAY2_TEMPLATE : DEFAULT_DAY3_TEMPLATE;
}

/**
 * Send a reminder message via the VPS relay.
 */
async function sendReminder(env, shopLabel, orderId, body, sendReply = runMercariOrderReplyViaRelay) {
  try {
    const result = await sendReply(env, {
      shopLabel,
      transactionId: orderId,
      text: body,
    });
    if (result.ok && result.body && result.body.ok) {
      const msg = result.body.message;
      return {
        ok: true,
        mercariMessageId: msg && msg.id ? String(msg.id) : null,
      };
    }
    const errMsg = (result.body && result.body.error) || `provider_status_${result.status}`;
    return { ok: false, error: errMsg };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
