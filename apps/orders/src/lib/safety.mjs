import { createBaserowClient, listRowsWithLimit, FIELD, OPTION } from "./db.mjs";
import { PORTAL_FEE_PATTERNS, getCustomerKey } from "./portal/shared.mjs";
import { runMercariOrderMessagesViaRelay } from "./mercari-relay.mjs";
import { MERCARI_CHANNEL } from "./channel-config.mjs";
import { writeThroughMessageFacts } from "./buyer-messages.mjs";

function text(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Check whether a product name matches known fee/adjustment patterns.
 * Shared across auto-approval safety gate and portal.
 */
export function isFeeRow(productName) {
  const normalized = text(productName);
  for (const pattern of PORTAL_FEE_PATTERNS) {
    if (normalized.includes(pattern)) return true;
    if (normalized === pattern) return true;
  }
  return false;
}

/**
 * Look up a non-canceled fee order linked by customer identity.
 * Uses existing portal semantics: phone+shop primary, name+postal+shop fallback.
 *
 * @param {Object} env
 * @param {Object[]} orderRows — all sales rows for one order_id
 * @returns {Promise<Object|null>} fee row if found, null otherwise
 */
export async function findLinkedFeeOrder(env, orderRows) {
  const lookupKeys = new Map();
  for (const row of orderRows) {
    const key = getCustomerKey(row);
    if (key && !lookupKeys.has(key)) {
      lookupKeys.set(key, row);
    }
  }
  if (lookupKeys.size === 0) return null;

  const baserow = createBaserowClient(env);

  for (const [customerKey] of lookupKeys) {
    let filters;
    if (customerKey.startsWith("phone:")) {
      const parts = customerKey.split(":");
      const phone = parts[1] || "";
      const shop = parts[2] || "";
      if (!phone || !shop) continue;
      filters = {
        [`filter__field_${FIELD.SALES.SHIPPING_PHONE_NUMBER}__equal`]: phone,
        [`filter__field_${FIELD.SALES.SHOP_ID}__equal`]: shop,
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_not_equal`]: OPTION.ORDER_STATUS.CANCELED,
      };
    } else if (customerKey.startsWith("name:")) {
      const parts = customerKey.split(":");
      const name = parts[1] || "";
      const postal = parts[2] || "";
      const shop = parts[3] || "";
      if (!name || !postal || !shop) continue;
      filters = {
        [`filter__field_${FIELD.SALES.SHIPPING_NAME}__equal`]: name,
        [`filter__field_${FIELD.SALES.SHIPPING_POSTAL_CODE}__equal`]: postal,
        [`filter__field_${FIELD.SALES.SHOP_ID}__equal`]: shop,
        [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_not_equal`]: OPTION.ORDER_STATUS.CANCELED,
      };
    } else {
      continue;
    }

    try {
      const candidates = await listRowsWithLimit(baserow, baserow.salesOrderTableId, filters, 20);
      const feeCandidates = candidates.filter((c) => isFeeRow(c.product_name));
      if (feeCandidates.length > 0) {
        const matched = feeCandidates.filter((c) => getCustomerKey(c) === customerKey);
        if (matched.length > 0) return matched[0];
      }
    } catch (error) {
      console.warn("safety: linked fee order lookup failed:", customerKey, error.message);
    }
  }
  return null;
}

/**
 * Check whether the given order has any BUYER transaction messages.
 *
 * Live relay is authoritative — always fetches from Mercari via VPS.
 * KV may be used only as an additional block signal: if live relay
 * finds no buyer messages but KV cached data shows buyer messages,
 * the order is still blocked.
 *
 * If live relay is unavailable, fails, or returns a malformed response,
 * the check fails closed (hasBuyerMessages: true, error set).
 * Seller-only cached messages never bypass the live check.
 *
 * @param {Object} env
 * @param {string} orderId — normalized order_id
 * @param {string} shopId — opaque Mercari shop ID
 * @returns {Promise<{hasBuyerMessages: boolean, error?: string}>}
 */
export async function checkBuyerMessages(env, orderId, shopId) {
  // Resolve shop label (fail-closed early if unresolvable)
  let shopLabel = null;
  for (const [label, mappedId] of Object.entries(MERCARI_CHANNEL.shopIds)) {
    if (mappedId === shopId) {
      shopLabel = label;
      break;
    }
  }
  if (!shopLabel) {
    console.warn("safety: cannot check messages, unresolvable shop_id:", shopId);
    return { hasBuyerMessages: true, error: "unresolvable_shop_id" };
  }

  // Step 1: Live relay is authoritative. Always fetch from Mercari via relay.
  let relayHasBuyer = null;
  let messages = [];
  try {
    const relayResult = await runMercariOrderMessagesViaRelay(env, { shopLabel, orderId });
    if (!relayResult.ok || !relayResult.body || !relayResult.body.ok) {
      const errMsg = (relayResult.body && relayResult.body.error) || "mercari_graphql_error";
      console.warn("safety: message fetch relay error for", orderId, errMsg);
      return { hasBuyerMessages: true, error: errMsg };
    }
    messages = relayResult.body.messages || [];
    relayHasBuyer = messages.some(
      (m) => String(m.role || "").toUpperCase() === "BUYER",
    );
  } catch (err) {
    const msg = (err && (err.message || String(err))) || "relay_call_failed";
    console.warn("safety: message fetch relay call failed for", orderId, msg);
    return { hasBuyerMessages: true, error: msg };
  }

  // Write-through: keep Baserow + durable KV converged with live state.
  // This is non-fatal — the safety check result is not affected.
  try {
    await writeThroughMessageFacts(env, shopId, orderId, messages);
  } catch (_) { /* non-fatal */ }

  if (relayHasBuyer) {
    return { hasBuyerMessages: true };
  }

  // Step 2: KV may be used only as additional block signal.
  // If live relay found no buyer messages but stale KV shows buyer
  // messages, still block (KV as supplementary guard).
  if (env && env.PORTAL_KV) {
    try {
      const kvKey = `messages:${shopId}:${orderId}`;
      const cached = await env.PORTAL_KV.get(kvKey, "json");
      if (cached && cached.messages) {
        const kvHasBuyer = cached.messages.some(
          (m) => String(m.role || "").toUpperCase() === "BUYER",
        );
        if (kvHasBuyer) {
          return { hasBuyerMessages: true };
        }
      }
    } catch (_) {
      /* KV read failed — non-fatal, proceed */
    }
  }

  return { hasBuyerMessages: false };
}
