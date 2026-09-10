/**
 * Auto-approval module for Mercari sales orders.
 *
 * Evaluates "Pending Review" orders against configurable whitelist rules
 * and promotes qualifying orders to "Auto-Approved" so they pass through
 * the existing review gate without manual operator intervention.
 *
 * Rules are defined in getAutoApprovalRules() and can be toggled or
 * threshold-adjusted via the AUTO_APPROVAL_RULES_CONFIG env var (JSON).
 *
 * Evaluation is order-level: all non-fee lines in an order must pass
 * for the order to be auto-approved.
 */

import { createBaserowClient, FIELD, OPTION, listAllRows, patchRow, setOrderReviewStatusViaRpc } from "./db.mjs";
import { getJstDateParts } from "./timezone.mjs";
import { isPipelineApprovedReviewStatus } from "./review-gate.mjs";
import {
  resolveProductFields,
  batchResolveProducts,
  readProductNumber,
  computeMargin,
} from "./product-resolver.mjs";
import { REVIEW_STATUS, statusEquals, readSelectValue } from "./order-state.mjs";
import { toJstIso } from "./timezone.mjs";
import { runMercariOrderReplyViaRelay } from "./mercari-relay.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";
import { findTemplateByTitle } from "./portal-templates.mjs";
import { findLinkedFeeOrder, checkBuyerMessages, isFeeRow } from "./safety.mjs";
import { readDurableState, isDurableStateStale } from "./buyer-messages.mjs";
import { setIdempotencyGuard } from "./idempotency.mjs";
import { resolveCandidateLimit } from "./phase-limit.mjs";

// ── Helpers (same pattern as other src/lib modules) ──────────────────

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function hasIdempotencyBackend(env) {
  if (env?.PORTAL_KV) return true;
  return String(env?.DATABASE_BACKEND || "").trim().toLowerCase() === "supabase";
}

function parseCommissionRate(env) {
  const raw = String(env && env.PORTAL_COMMISSION_RATE_MERCARI || "0.10").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.10;
}

function parsePositiveInt(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : 0;
}

/**
 * Reverse-scan MERCARI_CHANNEL.shopIds to resolve an opaque shop_id
 * (e.g. "2JMLHBxjiFHDr55jMwA7fs") to a human label (e.g. "Shop4").
 * Returns null when the shop_id is unknown or empty.
 *
 * @param {string} shopId — opaque Mercari shop ID from row.shop_id
 * @returns {string|null} — e.g. "Shop4", or null
 */
export function resolveShopLabel(shopId) {
  const id = String(shopId || "").trim();
  if (!id) return null;
  for (const [label, mappedId] of Object.entries(MERCARI_CHANNEL.shopIds)) {
    if (mappedId === id) return label;
  }
  return null;
}

// ── Working hours gate ──────────────────────────────────────────────

/**
 * Check whether the given time falls within shop working hours in JST.
 *
 * Working hours are defined as 09:00 inclusive through before 18:00 JST.
 * Outside that window (18:00–08:59 JST), auto-approval is skipped entirely
 * — no patches, no messages, no evaluation.
 *
 * @param {Date|string} [now] — injectable timestamp for deterministic testing
 * @returns {boolean} true when 09:00 ≤ hour < 18:00 JST
 */
export function isWithinWorkingHours(now) {
  const parts = getJstDateParts(now || new Date());
  return parts.hour >= 9 && parts.hour < 18;
}

// ── Geographic exclusion (hard block — never auto-approve these prefectures) ──

/**
 * Japanese prefecture names that are permanently excluded from auto-approval.
 *
 * Orders shipping to these prefectures must always be reviewed manually because
 * of elevated shipping costs, longer transit times, and/or carrier surcharges
 * that make the standard margin thresholds unreliable.
 *
 * Values are matched via case-insensitive substring against the Mercari
 * `shippingAddress.state.name` stored in the `shipping_state` column.
 */
const EXCLUDED_PREFECTURE_PATTERNS = Object.freeze(["沖縄", "北海道", "okinawa", "hokkaido"]);

/**
 * Returns true when `shippingState` is empty/missing/whitespace (fail closed)
 * or matches an excluded prefecture (Okinawa or Hokkaido). These orders
 * cannot be auto-approved regardless of margin or stock conditions.
 *
 * @param {string|null|undefined} shippingState — row.shipping_state value
 * @returns {boolean}
 */
export function isExcludedShippingState(shippingState) {
  const s = String(shippingState || "").trim();
  if (!s) return true;
  return EXCLUDED_PREFECTURE_PATTERNS.some((pattern) =>
    s.toLowerCase().includes(pattern),
  );
}

/**
 * Send a template message to the customer for an auto-approved order.
 * Non-blocking — failures are returned, never thrown.
 *
 * Includes a permanent KV idempotency guard per approval transition.
 * Message delivery fails closed when the guard cannot be persisted.
 *
 * @param {Object} env — Worker env or process.env
 * @param {{ orderId: string, shopId: string, templateBody: string, transitionId?: string }} params
 * @returns {Promise<{sent: boolean, skipped: boolean, error?: string}>}
 */
export async function sendAutoApprovalMessage(env, { orderId, shopId, templateBody, transitionId = "" }) {
  const trimmedOrderId = String(orderId || "").trim();
  const trimmedShopId = String(shopId || "").trim();
  const trimmedBody = String(templateBody || "").trim();

  // Pre-flight: resolve shop label
  const shopLabel = resolveShopLabel(trimmedShopId);
  if (!shopLabel) {
    return { sent: false, skipped: true, error: "unresolvable_shop_id" };
  }

  // Pre-flight: body must be non-empty
  if (!trimmedBody) {
    return { sent: false, skipped: true, error: "empty_template_body" };
  }

  const normalizedTransitionId = String(transitionId || "").trim();
  const guardKey = normalizedTransitionId
    ? `auto-msg:v2:${trimmedOrderId}:${normalizedTransitionId}`
    : `auto-msg:${trimmedOrderId}`;

  // Require at least one idempotency backend (KV or Supabase)
  if (!hasIdempotencyBackend(env)) {
    return { sent: false, skipped: true, error: "idempotency_store_unavailable" };
  }

  // Atomically acquire guard before delivery. On ambiguous delivery failures,
  // suppressing an automatic retry is safer than messaging the buyer twice.
  const acquired = await setIdempotencyGuard(env, guardKey);
  if (acquired === "duplicate") {
    return { sent: false, skipped: true, error: "duplicate_guard" };
  }
  if (acquired === "backend_error") {
    return { sent: false, skipped: true, error: "idempotency_store_unavailable" };
  }

  // Send via relay
  try {
    const result = await runMercariOrderReplyViaRelay(env, {
      shopLabel,
      transactionId: trimmedOrderId,
      text: trimmedBody,
    });

    if (result.ok) {
      console.log(`auto_approval: message sent for order ${trimmedOrderId} (shop ${shopLabel})`);

      // Invalidate KV message cache so the portal fetches fresh from
      // Mercari on next load (instead of serving stale cached messages).
      if (env && env.PORTAL_KV) {
        const msgKvKey = `messages:${trimmedShopId}:${trimmedOrderId}`;
        try {
          await env.PORTAL_KV.delete(msgKvKey);
        } catch (_) {
          /* non-fatal — portal will serve stale cache until TTL expiry */
        }
      }

      return { sent: true, skipped: false };
    }

    const errMsg =
      (result.body && result.body.error) ||
      `relay_status_${result.status}`;
    console.warn(`auto_approval: message failed for order ${trimmedOrderId}: ${errMsg}`);
    return { sent: false, skipped: false, error: errMsg };
  } catch (err) {
    const msg = err && (err.message || String(err)) || "relay_call_failed";
    console.error(`auto_approval: message error for order ${trimmedOrderId}: ${msg}`);
    return { sent: false, skipped: false, error: msg };
  }
}

// ── Default rules ────────────────────────────────────────────────────

/**
 * Check whether payment_date is strictly before today in JST.
 * Returns true only when a payment_date exists and its JST date
 * is before the current JST date.
 *
 * @param {string|null|undefined} paymentDate — row.payment_date value
 * @returns {boolean}
 */
function isPaymentDateEligible(paymentDate) {
  const raw = text(paymentDate);
  if (!raw) return false;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return false;

  const { year: py, month: pm, day: pd } = getJstDateParts(d);
  const { year: ny, month: nm, day: nd } = getJstDateParts(new Date());

  // payment_date must be strictly before today in JST
  if (py < ny) return true;
  if (py > ny) return false;
  if (pm < nm) return true;
  if (pm > nm) return false;
  return pd < nd;
}

/**
 * Check whether purchase_date is strictly before today in JST.
 * Returns true only when a purchase_date exists and its JST date
 * is before the current JST date.
 *
 * @param {string|null|undefined} purchaseDate — row.purchase_date value
 * @returns {boolean}
 */
function isPurchaseDateEligible(purchaseDate) {
  const raw = text(purchaseDate);
  if (!raw) return false;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return false;

  const { year: py, month: pm, day: pd } = getJstDateParts(d);
  const { year: ny, month: nm, day: nd } = getJstDateParts(new Date());

  if (py < ny) return true;
  if (py > ny) return false;
  if (pm < nm) return true;
  if (pm > nm) return false;
  return pd < nd;
}

const DEFAULT_RULES = [
  {
    name: "low_stock_good_margin",
    enabled: true,
    paymentDateGate: false,
    description: "Own stock depleted, limited supplier stock, healthy margin",
    thresholds: {
      maxOwnedQty: 0,
      maxQtyAvailable: 5,
      minMarginPercent: 8,
    },
  },
  {
    name: "standard_order_approval",
    enabled: true,
    description: "Standard order approval: waiting for shipping, prior purchase, sufficient margin",
    thresholds: {
      minMarginPercent: 11,
    },
  },
];

/**
 * Returns the active rule set, optionally overridden by the
 * AUTO_APPROVAL_RULES_CONFIG env var (JSON string).
 *
 * Legacy rule name paid_n_plus_1_good_margin is automatically normalized to
 * standard_order_approval, with paymentDateGate cleared.
 *
 * Env var format:
 *   {"rules":[{"name":"low_stock_good_margin","enabled":true,"paymentDateGate":false,"thresholds":{"maxOwnedQty":0,"maxQtyAvailable":5,"minMarginPercent":8}},{"name":"standard_order_approval","enabled":true,"thresholds":{"minMarginPercent":11}}]}
 *
 * @param {Object} env
 * @returns {Array<{name: string, enabled: boolean, paymentDateGate: boolean, description: string, thresholds: Object}>}
 */
export function getAutoApprovalRules(env) {
  const raw = text(env && env.AUTO_APPROVAL_RULES_CONFIG);
  if (!raw) return DEFAULT_RULES;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.rules)) {
      return parsed.rules.map((r) => {
        const t = r.thresholds || {};
        const rule = {
          name: String(r.name || ""),
          enabled: r.enabled !== false,
          paymentDateGate: r.paymentDateGate === true,
          description: String(r.description || ""),
          thresholds: {
            minMarginPercent: Number(t.minMarginPercent ?? 11),
          },
        };
        if (t.maxOwnedQty != null) rule.thresholds.maxOwnedQty = Number(t.maxOwnedQty);
        if (t.maxQtyAvailable != null) rule.thresholds.maxQtyAvailable = Number(t.maxQtyAvailable);

        // Normalize legacy rule name — deployed env vars may still use the
        // old paid_n_plus_1_good_margin name. Without normalization the rule
        // would miss the standard_order_approval gate and keep writing the
        // old name into auto_approval_rule output.
        if (rule.name === "paid_n_plus_1_good_margin") {
          rule.name = "standard_order_approval";
          // paymentDateGate is intentionally cleared so the old
          // payment_date check does not apply to the normalized rule;
          // the new standard gate (order_status + purchase_date) is
          // used instead.
          delete rule.paymentDateGate;
        }

        return rule;
      });
    }
  } catch (_) {
    console.warn("auto_approval: failed to parse AUTO_APPROVAL_RULES_CONFIG, using defaults");
  }
  return DEFAULT_RULES;
}

// ── Rule evaluation (pure functions — testable) ──────────────────────

/**
 * Evaluate a single sales row against one rule's thresholds.
 * Returns { passed, reason }.
 *
 * Stock constraints (maxOwnedQty, maxQtyAvailable) are optional:
 * when absent, the corresponding check is skipped.
 *
 * Payment date gate (paymentDateGate) when true requires
 * payment_date to be strictly before today JST.
 *
 * @param {Object} salesRow — row with user_field_names keys
 * @param {Object|null} productData — matched product row, or null
 * @param {{ effectiveTcogsFieldId: number, ownedQtyFieldId: number, qtyAvailableFieldId: number }} productFields
 * @param {number} commissionRate
 * @param {{ name: string, thresholds: { maxOwnedQty?: number, maxQtyAvailable?: number, minMarginPercent: number }, paymentDateGate?: boolean }} rule
 * @returns {{ passed: boolean, reason: string }}
 */
export function evaluateRule(salesRow, productData, productFields, commissionRate, rule) {
  const t = rule.thresholds;
  const orderQty = parsePositiveInt(salesRow && salesRow.quantity);

  // ── Payment date gate (only when rule declares paymentDateGate) ──
  if (rule.paymentDateGate) {
    if (!isPaymentDateEligible(salesRow && salesRow.payment_date)) {
      return { passed: false, reason: "payment_date_not_eligible" };
    }
  }

  // ── Standard order approval gate ────────────────────────────
  if (rule.name === "standard_order_approval") {
    const orderStatus = readSelectValue(salesRow && salesRow.order_status);
    if (orderStatus !== "WAITING_FOR_SHIPPING") {
      return { passed: false, reason: "order_status_not_waiting_for_shipping" };
    }
    if (!isPurchaseDateEligible(salesRow && salesRow.purchase_date)) {
      return { passed: false, reason: "purchase_date_not_eligible" };
    }
  }

  // ── Owned quantity check (only when threshold is defined) ──
  if (t.maxOwnedQty != null) {
    const ownedQty = productData
      ? readProductNumber(productData, productFields.ownedQtyFieldId)
      : null;
    if (ownedQty == null) return { passed: false, reason: "missing_owned_qty" };
    if (ownedQty > t.maxOwnedQty) {
      return { passed: false, reason: `owned_qty=${ownedQty}, need <= ${t.maxOwnedQty}` };
    }
  }

  // ── Quantity available check (only when threshold is defined) ──
  if (t.maxQtyAvailable != null) {
    const qtyAvailable = productData
      ? readProductNumber(productData, productFields.qtyAvailableFieldId)
      : null;
    if (qtyAvailable == null) return { passed: false, reason: "missing_qty_available" };
    if (qtyAvailable < orderQty) {
      return { passed: false, reason: `qty_available=${qtyAvailable}, need >= order_qty=${orderQty}` };
    }
    if (qtyAvailable > t.maxQtyAvailable) {
      return { passed: false, reason: `qty_available=${qtyAvailable}, need <= ${t.maxQtyAvailable}` };
    }
  }

  // ── Margin check ──
  const margin = computeMargin(salesRow, productData, commissionRate, {
    effectiveTcogsFieldId: productFields.effectiveTcogsFieldId,
    effectiveCostPriceFieldId: productFields.effectiveCostPriceFieldId,
    sourceUnitPriceFieldId: productFields.sourceUnitPriceFieldId,
  });
  if (margin.marginPercent == null) {
    return { passed: false, reason: "margin_unavailable (missing TCOGS or price)" };
  }
  if (margin.marginPercent < t.minMarginPercent) {
    return {
      passed: false,
      reason: `margin=${margin.marginPercent}%, need >= ${t.minMarginPercent}%`,
    };
  }

  return {
    passed: true,
    reason: `margin=${margin.marginPercent}%, qty=${orderQty}`,
  };
}

/**
 * Evaluate all non-fee rows in an order against the enabled rules.
 *
 * Uses OR semantics: a row passes if ANY enabled rule matches. A row
 * fails only when ALL enabled rules fail. Fee rows are excluded from
 * evaluation.
 *
 * @param {Object[]} orderRows — all sales rows for one order_id
 * @param {Map<string, Object|null>} productCache — itemCode → productRow
 * @param {Object} productFields
 * @param {number} commissionRate
 * @param {Array} rules — enabled rules from getAutoApprovalRules()
 * @returns {{ passed: boolean, failures: Array<{order_id: string, sku: string, reason: string}> }}
 */
export function evaluateOrderRules(orderRows, productCache, productFields, commissionRate, rules) {
  const failures = [];
  const enabledRules = rules.filter((r) => r.enabled);

  if (enabledRules.length === 0) return { passed: true, failures };

  for (const row of orderRows) {
    const productName = text(row.product_name);
    const b2bCode = text(row.B2BItemCode);

    if (isFeeRow(productName)) continue;

    if (!b2bCode) {
      failures.push({
        order_id: normalizeOrderId(row.order_id),
        sku: text(row.original_product_id),
        reason: "missing_b2b_item_code",
      });
      continue;
    }

    const productData = productCache.get(b2bCode) ?? null;

    if (!productData) {
      failures.push({
        order_id: normalizeOrderId(row.order_id),
        sku: text(row.original_product_id),
        reason: "product_not_found",
      });
      continue;
    }

    // Fulfillment is a hard requirement regardless of which rule passes.
    // Either owned stock or supplier stock must cover the full line quantity.
    const orderQty = parsePositiveInt(row.quantity);
    const ownedQty = readProductNumber(productData, productFields.ownedQtyFieldId);
    const qtyAvailable = readProductNumber(productData, productFields.qtyAvailableFieldId);
    const ownedCanFulfill = ownedQty != null && ownedQty >= orderQty;
    const supplierCanFulfill = qtyAvailable != null && qtyAvailable >= orderQty;

    if (!ownedCanFulfill && !supplierCanFulfill && (ownedQty == null || qtyAvailable == null)) {
      const missingFields = [
        ownedQty == null ? "owned_qty" : null,
        qtyAvailable == null ? "qty_available" : null,
      ].filter(Boolean).join(",");
      failures.push({
        order_id: normalizeOrderId(row.order_id),
        sku: text(row.original_product_id),
        reason: `missing_stock_data: ${missingFields}`,
      });
      continue;
    }

    if (!ownedCanFulfill && !supplierCanFulfill) {
      failures.push({
        order_id: normalizeOrderId(row.order_id),
        sku: text(row.original_product_id),
        reason: `insufficient_stock: owned_qty=${ownedQty}, qty_available=${qtyAvailable}, need either >= order_qty=${orderQty}`,
      });
      continue;
    }

    // OR semantics: pass if ANY enabled rule passes; fail only if ALL fail
    let anyPassed = false;
    const ruleFailures = [];

    for (const rule of enabledRules) {
      const result = evaluateRule(row, productData, productFields, commissionRate, rule);
      if (result.passed) {
        anyPassed = true;
        break;
      }
      ruleFailures.push(`${rule.name}: ${result.reason}`);
    }

    if (!anyPassed) {
      failures.push({
        order_id: normalizeOrderId(row.order_id),
        sku: text(row.original_product_id),
        reason: ruleFailures.join("; "),
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * For each non-fee row, find the first enabled rule that passes (OR match).
 * Returns a deduplicated array of matching rule names.
 */
function collectMatchedRuleNames(orderRows, productCache, productFields, commissionRate, enabledRules) {
  const matched = new Set();
  for (const row of orderRows) {
    if (isFeeRow(text(row.product_name))) continue;
    const b2bCode = text(row.B2BItemCode);
    if (!b2bCode) continue;
    const productData = productCache.get(b2bCode) ?? null;
    if (!productData) continue;
    for (const rule of enabledRules) {
      const result = evaluateRule(row, productData, productFields, commissionRate, rule);
      if (result.passed) {
        matched.add(rule.name);
        break;
      }
    }
  }
  return [...matched];
}

// ── Main entry point ─────────────────────────────────────────────────

const MAX_ORDERS = 50;
const PRODUCTS_TABLE_ID = 886994;

export function selectAutoApprovalOrderScopes(orderScopes, limit) {
  const effectiveLimit = limit === null
    ? orderScopes.length
    : resolveCandidateLimit(limit, MAX_ORDERS, MAX_ORDERS);
  return orderScopes.slice(0, effectiveLimit);
}

/**
 * Auto-approve qualifying Mercari orders.
 *
 * Only operates during shop working hours (09:00–17:59 JST).
 * Outside that window the function returns immediately with no patches
 * and no messages.
 *
 * 1. Working hours gate (09:00–17:59 JST).
 * 2. Loads all Pending Review + WAITING_FOR_SHIPPING sales rows.
 * 3. Groups them by order_id.
 * 4. Resolves product data for all unique B2BItemCodes.
 * 5. Evaluates each order against enabled rules.
 * 6. PATCHes qualifying orders to "Auto-Approved".
 *
 * @param {Object} env — Worker env or process.env
 * @param {{ limit?: number, shops?: string[], orderId?: string, dryRun?: boolean, now?: Date|string }} options
 * @returns {Promise<Object>} summary
 */
export async function autoApproveMercariOrders(env, { limit = MAX_ORDERS, shops = [], orderId = "", dryRun = false, now } = {}) {
  const baserow = createBaserowClient(env);
  const commissionRate = parseCommissionRate(env);
  const rules = getAutoApprovalRules(env);
  const enabledRules = rules.filter((r) => r.enabled);

  const summary = {
    ok: true,
    dryRun: !!dryRun,
    candidates_loaded: 0,
    orders_evaluated: 0,
    orders_approved: 0,
    rows_approved: 0,
    skipped_missing_b2b: 0,
    skipped_missing_product: 0,
    skipped_by_rule: [],
    skipped_mixed_eligibility: 0,
    skipped_geographic_exclusion: 0,
    skipped_empty_shipping_state: 0,
    skipped_fee_order: 0,
    skipped_buyer_message: 0,
    skipped_message_check_failed: 0,
    skipped_by_safety: {
      total: 0,
      details: {
        fee_row_in_order: [],
        linked_fee_order_exists: [],
        buyer_message_exists: [],
        message_check_failed: [],
        message_state_unknown: [],
      },
    },
    skipped_status_changed: 0,
    patch_failures: 0,
    messages_sent: 0,
    messages_skipped: 0,
    message_failures: 0,
  };

  if (enabledRules.length === 0) {
    summary.note = "no_enabled_rules";
    return summary;
  }

  // Step 1: Working hours gate — only 09:00–17:59 JST
  // Must come before any message-template lookup or Baserow/product work.
  if (!isWithinWorkingHours(now)) {
    const parts = getJstDateParts(now || new Date());
    const hourStr = String(parts.hour).padStart(2, "0");
    const minStr = String(parts.minute).padStart(2, "0");
    summary.note = `outside_working_hours (${hourStr}:${minStr} JST, need 09:00–17:59)`;
    return summary;
  }

  // Resolve message config once per invocation (not per order)
  const messageEnabled = !dryRun && String(env && env.AUTO_APPROVAL_MESSAGE_ENABLED || "true").trim() !== "false";
  const messageTemplateTitle = String(env && env.AUTO_APPROVAL_MESSAGE_TEMPLATE || "Order processed notice").trim();
  let messageTemplate = null;
  if (messageEnabled) {
    messageTemplate = await findTemplateByTitle(env, messageTemplateTitle);
    if (!messageTemplate) {
      console.warn(`auto_approval: message template "${messageTemplateTitle}" not found, skipping messages`);
    } else if (!String(messageTemplate.body || "").trim()) {
      console.warn(`auto_approval: message template "${messageTemplateTitle}" has empty body, skipping messages`);
      messageTemplate = null;
    }
  }

  // Step 2: Load pending review rows
  let pendingRows;
  try {
    pendingRows = await listAllRows(baserow, baserow.salesOrderTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]:
        OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING,
      [`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]:
        OPTION.REVIEW_STATUS.PENDING_REVIEW,
    });
  } catch (error) {
    summary.ok = false;
    summary.error = `baserow_list_failed: ${error && error.message ? error.message : String(error)}`;
    return summary;
  }

  summary.candidates_loaded = pendingRows.length;
  const exactOrderId = normalizeOrderId(orderId);
  if (exactOrderId) {
    const selectedShops = (shops || []).filter((shop) => MERCARI_CHANNEL.shopIds[shop]);
    if (selectedShops.length !== 1) {
      summary.ok = false;
      summary.error = "scoped_auto_approval_requires_single_shop";
      return summary;
    }
    pendingRows = filterAutoApprovalScope(pendingRows, {
      orderId: exactOrderId,
      sourceStoreId: MERCARI_CHANNEL.shopIds[selectedShops[0]],
    });
    summary.candidates_loaded = pendingRows.length;
    summary.exact_scope = true;
    if (pendingRows.length === 0) {
      summary.ok = false;
      summary.error = "scoped_auto_approval_target_not_found";
      return summary;
    }
  }
  if (pendingRows.length === 0) {
    summary.note = "no_pending_review_rows";
    return summary;
  }

  // Step 3: Discover product table fields (one-time per invocation)
  let productFields;
  try {
    productFields = await resolveProductFields(env, PRODUCTS_TABLE_ID);
  } catch (error) {
    summary.ok = false;
    summary.error = `product_fields_failed: ${error && error.message ? error.message : String(error)}`;
    return summary;
  }

  // Step 4: Group rows by order_id
  const orderGroups = groupOrderRowsByScope(pendingRows);

  // Step 5: Collect unique B2BItemCodes for batch lookup
  const allCodes = new Set();
  for (const { rows } of orderGroups.values()) {
    for (const row of rows) {
      if (isFeeRow(text(row.product_name))) continue;
      const code = text(row.B2BItemCode);
      if (code) allCodes.add(code);
    }
  }

  // Step 6: Batch-resolve product data
  let productCache = new Map();
  if (allCodes.size > 0) {
    try {
      productCache = await batchResolveProducts(
        env,
        PRODUCTS_TABLE_ID,
        productFields.itemCodeFieldId,
        [...allCodes],
        10,
      );
    } catch (error) {
      summary.ok = false;
      summary.error = `product_lookup_failed: ${error && error.message ? error.message : String(error)}`;
      return summary;
    }
  }

  // Step 7: Evaluate each order (capped at limit)
  const orderScopes = [...orderGroups.values()];
  // null is the orchestrator's explicit full-accounting contract. Positive
  // limits remain capped for manual/canary invocations.
  const cappedOrderScopes = selectAutoApprovalOrderScopes(orderScopes, limit);

  for (const group of cappedOrderScopes) {
    const { orderId: oid, sourceStoreId, rows } = group;
    summary.orders_evaluated += 1;

    // Pre-checks: line-level gates (B2BItemCode, product data) skip fee rows;
    // order-level gates (shipping address) inspect all rows.

    // Check for missing B2BItemCode on non-fee rows
    const hasMissingB2b = rows.some(
      (r) => !isFeeRow(text(r.product_name)) && !text(r.B2BItemCode),
    );
    if (hasMissingB2b) {
      summary.skipped_missing_b2b += 1;
      continue;
    }

    // Check for missing product data on non-fee rows
    const hasMissingProduct = rows.some((r) => {
      if (isFeeRow(text(r.product_name))) return false;
      const code = text(r.B2BItemCode);
      return code && !productCache.has(code);
    });
    if (hasMissingProduct) {
      summary.skipped_missing_product += 1;
      continue;
    }

    // Geographic exclusion: Okinawa and Hokkaido orders can never be auto-approved.
    // Elevated shipping costs and longer transit times make margin thresholds
    // unreliable for these remote prefectures.
    const hasExcludedState = rows.some((r) =>
      isExcludedShippingState(r.shipping_state),
    );
    if (hasExcludedState) {
      const states = rows
        .map((r) => String(r.shipping_state || "").trim())
        .filter(Boolean);
      const uniqueStates = [...new Set(states)].join(",");
      const hasEmptyState = rows.some((r) => !String(r.shipping_state || "").trim());
      if (hasEmptyState) {
        summary.skipped_empty_shipping_state += 1;
      } else {
        summary.skipped_geographic_exclusion += 1;
      }
      console.log(
        `auto_approval: order ${oid} skipped (${hasEmptyState ? "empty shipping state" : "geographic exclusion"}): ${uniqueStates}`,
      );
      continue;
    }

    // ── Fee safety gates (before rule evaluation) ────────────────────
    // These require no external API calls and are cheap to evaluate.

    // Check 1: Block if the same grouped order contains a fee row
    const hasFeeRow = rows.some((r) => isFeeRow(r.product_name));
    if (hasFeeRow) {
      summary.skipped_fee_order += 1;
      summary.skipped_by_safety.total += 1;
      summary.skipped_by_safety.details.fee_row_in_order.push(oid);
      console.log(`auto_approval: order ${oid} skipped (safety: fee row in order group)`);
      continue;
    }

    // Check 2: Block if a linked non-canceled fee order exists for the same
    // customer key/shop (using existing portal semantics).
    const linkedFeeOrder = await findLinkedFeeOrder(env, rows);
    if (linkedFeeOrder) {
      summary.skipped_fee_order += 1;
      summary.skipped_by_safety.total += 1;
      summary.skipped_by_safety.details.linked_fee_order_exists.push(oid);
      console.log(`auto_approval: order ${oid} skipped (safety: linked fee order ${text(linkedFeeOrder.order_id)})`);
      continue;
    }

    // Evaluate all non-fee rows against rules (OR semantics)
    const evaluation = evaluateOrderRules(rows, productCache, productFields, commissionRate, enabledRules);

    if (!evaluation.passed) {
      summary.skipped_by_rule.push(...evaluation.failures);
      const hasStructural = evaluation.failures.some(
        (f) => f.reason.includes("missing_b2b") || f.reason.includes("product_not_found"),
      );
      if (hasStructural) {
        summary.skipped_mixed_eligibility += 1;
      }
      continue;
    }

    // ── Buyer-message safety gate (after rule evaluation) ─────────────
    // Phase 1: Check Baserow row has_buyer_messages as an early durable
    // block signal. Any buyer message, read or unread, blocks auto-approval.
    const rowHasBuyerMessages = rows.some((r) => {
      const v = r.has_buyer_messages;
      return v === true || v === "true" || v === 1 || v === "1";
    });
    if (rowHasBuyerMessages) {
      summary.skipped_buyer_message += 1;
      summary.skipped_by_safety.total += 1;
      summary.skipped_by_safety.details.buyer_message_exists.push(oid);
      console.log(`auto_approval: order ${oid} skipped (safety: row has_buyer_messages=true)`);
      continue;
    }

    // Live relay is called only for otherwise-eligible orders to avoid
    // unnecessary API calls. Must run before any patch or Order processed
    // notice. Remains authoritative — fail-closed.
    const firstRow = rows[0];
    let durableStateReason = "";
    try {
      const durableState = await readDurableState(env, sourceStoreId, firstRow.order_id);
      if (!durableState) {
        durableStateReason = "missing";
      } else if (String(durableState.last_check_status || "").trim().toLowerCase() === "failed") {
        durableStateReason = "failed";
      } else if (isDurableStateStale(firstRow, durableState)) {
        durableStateReason = "stale";
      }
    } catch (_) {
      durableStateReason = "missing";
    }
    if (durableStateReason) {
      console.log(`auto_approval: order ${oid} durable message state ${durableStateReason}; live relay check required`);
    }

    const msgCheck = await checkBuyerMessages(env, firstRow.order_id, sourceStoreId);
    if (msgCheck.hasBuyerMessages) {
      if (msgCheck.error) {
        summary.skipped_message_check_failed += 1;
        summary.skipped_by_safety.total += 1;
        summary.skipped_by_safety.details.message_check_failed.push(oid);
        if (durableStateReason) {
          summary.skipped_by_safety.details.message_state_unknown.push(oid);
        }
        console.log(`auto_approval: order ${oid} skipped (safety: buyer message check failed: ${msgCheck.error}${durableStateReason ? `; durable_state=${durableStateReason}` : ""})`);
      } else {
        summary.skipped_buyer_message += 1;
        summary.skipped_by_safety.total += 1;
        summary.skipped_by_safety.details.buyer_message_exists.push(oid);
        console.log(`auto_approval: order ${oid} skipped (safety: buyer messages exist)`);
      }
      continue;
    }

    // Determine which enabled rule(s) matched each non-fee row (for audit)
    const matchedRuleNames = collectMatchedRuleNames(
      rows, productCache, productFields, commissionRate, enabledRules,
    );
    const matchedRuleLabel = matchedRuleNames.length
      ? matchedRuleNames.join(",")
      : enabledRules.map((r) => r.name).join(",");
    const nowJstIso = toJstIso(new Date());

    // Step 7: Patch qualifying rows
    if (dryRun) {
      summary.orders_approved += 1;
      summary.rows_approved += rows.length;
      continue;
    }

    const auditEntry = `[AUTO-APPROVED] ${nowJstIso} | ${matchedRuleLabel}`;
    let allPatched = true;
    let anyRowActuallyPatched = false;

    if (baserow.type === "supabase") {
      // Single write path for all review mutations (TRD: every review mutation
      // routes through the transactional RPC). The review_status flip, the
      // order_comments audit entry, and the auto-approval metadata are written
      // atomically under an order-scoped lock so Cancel always wins over a
      // concurrent auto-approve. The RPC updates all non-fee lines (rows already
      // exclude fee rows via the fee-order safety gates above).
      const rpcResult = await setOrderReviewStatusViaRpc(baserow, {
        p_sales_channel: text(firstRow.sales_channel).toLowerCase(),
        p_source_store_id: sourceStoreId,
        p_order_id: oid,
        p_target: OPTION.REVIEW_STATUS.AUTO_APPROVED,
        p_audit: auditEntry,
        p_auto_approval_rule: matchedRuleLabel,
        p_auto_approved_at: nowJstIso,
      });
      if (rpcResult.ok) {
        summary.rows_approved +=
          typeof rpcResult.updated === "number" ? rpcResult.updated : rows.length;
        anyRowActuallyPatched = true;
      } else if (rpcResult.error === "review_status_changed") {
        // Operator changed the review state concurrently (e.g. On Hold) after the
        // long eligibility checks. Auto-approval must not override it — treat as
        // a skip, not a failure, so the order is not counted as approved and no
        // buyer message is sent.
        summary.skipped_status_changed += rows.length;
      } else {
        // Includes already_canceled (guard 3), terminal_lifecycle (guard 1),
        // order_not_found (zero-row update), and unexpected RPC failures.
        summary.patch_failures += 1;
        allPatched = false;
      }
    } else {
      // Baserow fallback: per-row CAS patch (legacy path).
      for (const row of rows) {
        try {
          const currentReviewStatus = readSelectValue(row.review_status);
          if (!statusEquals(currentReviewStatus, REVIEW_STATUS.PENDING_REVIEW)) {
            summary.skipped_status_changed += 1;
            continue;
          }

          const existingLog = text(row.order_comments);
          const updatedLog = existingLog ? `${auditEntry}\n${existingLog}` : auditEntry;

          const result = await patchRow(
            baserow,
            baserow.salesOrderTableId,
            row.id,
            {
              review_status: REVIEW_STATUS.AUTO_APPROVED,
              order_comments: updatedLog,
              auto_approval_rule: matchedRuleLabel,
              auto_approved_at: nowJstIso,
            },
            { match: { review_status: OPTION.REVIEW_STATUS.PENDING_REVIEW } },
          );

          const confirmedReviewStatus = readSelectValue(result.body && result.body.review_status);
          const writeConfirmed = result.ok && (
            baserow.type !== "supabase" ||
            statusEquals(confirmedReviewStatus, REVIEW_STATUS.AUTO_APPROVED)
          );
          if (writeConfirmed) {
            summary.rows_approved += 1;
            anyRowActuallyPatched = true;
          } else {
            summary.patch_failures += 1;
            allPatched = false;
          }
        } catch (error) {
          summary.patch_failures += 1;
          allPatched = false;
        }
      }
    }

    // Only count an order as approved and send a message when at least one
    // row was actually patched. Prevents false orders_approved and automatic
    // buyer messages when all rows were already in the target state
    // (skipped_status_changed) from a concurrent run.
    if (allPatched && anyRowActuallyPatched) {
      summary.orders_approved += 1;

      if (messageTemplate) {
        const firstRow = rows[0];
        const msgResult = await sendAutoApprovalMessage(env, {
          orderId: firstRow.order_id,
          shopId: sourceStoreId,
          templateBody: messageTemplate.body,
          transitionId: nowJstIso,
        });
        if (msgResult.sent) {
          summary.messages_sent += 1;
        } else if (msgResult.skipped) {
          summary.messages_skipped += 1;
        } else {
          summary.message_failures += 1;
        }
      } else if (messageEnabled) {
        summary.messages_skipped += 1;
      }
    }
  }

  summary.ok = summary.patch_failures === 0;
  if (cappedOrderScopes.length < orderScopes.length) {
    summary.note = `capped at ${cappedOrderScopes.length}/${orderScopes.length} orders`;
  }

  return summary;
}

export function groupOrderRowsByScope(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const orderId = normalizeOrderId(row && row.order_id);
    if (!orderId) continue;
    const sourceStoreId = text(row && (row.source_store_id || row.shop_id));
    const scopeKey = `${sourceStoreId}::${orderId}`;
    if (!groups.has(scopeKey)) groups.set(scopeKey, { orderId, sourceStoreId, rows: [] });
    groups.get(scopeKey).rows.push(row);
  }
  return groups;
}

export function filterAutoApprovalScope(rows, { orderId, sourceStoreId }) {
  const normalizedOrderId = normalizeOrderId(orderId);
  const normalizedStoreId = text(sourceStoreId);
  if (!normalizedOrderId || !normalizedStoreId) return [];
  return (rows || []).filter((row) => normalizeOrderId(row?.order_id) === normalizedOrderId
    && text(row?.source_store_id || row?.shop_id) === normalizedStoreId);
}
