/**
 * Pure functions for payment reminder logic — zero dependencies.
 *
 * Extracted from payment-reminders.mjs so tests can import them directly
 * without needing the full dependency chain (Supabase, relay, product-resolver).
 *
 * See: docs/trd/mercari-payment-reminder.md
 */

// ── getReminderDay ────────────────────────────────────────────────────────

/**
 * Determine which reminder day (if any) applies to an order.
 *
 * Day calculation in JST calendar dates (purchase date = day 1):
 *   diffDays = 1 → day2 (next calendar day after purchase)
 *   diffDays = 2 → day3 (2 calendar days after purchase)
 *
 * @param {string|Date|null} purchaseDate — purchase_date from sales_orders
 * @param {Date} [nowJst] — current time (defaults to Date.now(), interpreted as JST)
 * @returns {'day2'|'day3'|null}
 */
export function getReminderDay(purchaseDate, nowJst) {
  if (!purchaseDate) return null;
  const purchaseMs = purchaseDate instanceof Date
    ? purchaseDate.getTime()
    : Date.parse(String(purchaseDate));
  if (!Number.isFinite(purchaseMs)) return null;

  // Convert both to JST calendar dates for comparison.
  // JST = UTC+9 — add 9 hours to get JST time, then extract date parts.
  const toJstDateParts = (ms) => {
    const d = new Date(ms + 9 * 60 * 60 * 1000);
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  };

  const [pY, pM, pD] = toJstDateParts(purchaseMs);
  const nowMs = nowJst instanceof Date ? nowJst.getTime() : Date.now();
  const [tY, tM, tD] = toJstDateParts(nowMs);

  const pDate = new Date(Date.UTC(pY, pM, pD));
  const tDate = new Date(Date.UTC(tY, tM, tD));
  const diffDays = Math.round((tDate.getTime() - pDate.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 1) return "day2";
  if (diffDays === 2) return "day3";
  return null;
}

/**
 * Return the UTC timestamp bounds covering the two eligible JST purchase
 * dates: yesterday (day 2) and two days ago (day 3).
 */
export function getEligiblePurchaseWindow(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return null;

  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const todayJstMidnightAsUtc = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
  ) - 9 * 60 * 60 * 1000;

  return {
    start: new Date(todayJstMidnightAsUtc - 2 * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(todayJstMidnightAsUtc).toISOString(),
  };
}

/** Only the live Mercari payment-pending status is safe to remind. */
export function isWaitingForPaymentStatus(status) {
  return String(status || "").trim().toUpperCase() === "WAITING_FOR_PAYMENT";
}

// ── isProductInStock ──────────────────────────────────────────────────────

/**
 * Check whether a product row has available stock (owned or supplier).
 *
 * Reads field_3 (owned_qty) and field_4 (source_available_qty) from the
 * product row resolved via findProductByItemCode. At least one of these
 * fields must be >= 1 for the product to be considered in stock.
 *
 * @param {Object|null} productData — resolved product row
 * @returns {boolean}
 */
export function isProductInStock(productData) {
  if (!productData || typeof productData !== "object") return false;

  const readNum = (row, fieldId) => {
    const key = `field_${String(fieldId)}`;
    const raw = row[key];
    if (raw == null || raw === "") return null;
    const n = Number(String(raw).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  };

  const ownedQty = readNum(productData, 3);
  const qtyAvailable = readNum(productData, 4);
  return (ownedQty !== null && ownedQty >= 1) || (qtyAvailable !== null && qtyAvailable >= 1);
}

// ── renderTemplate ────────────────────────────────────────────────────────

/**
 * Render a template string with variable substitution.
 *
 * Supported variables:
 *   {{product_name}}  — product name on the order
 *   {{purchase_date}} — purchase date in JST "YYYY-MM-DD" format
 *   {{deadline_date}} — payment deadline date in JST "YYYY-MM-DD" format
 *
 * @param {string} template — template body with {{variables}}
 * @param {{ product_name?: string, purchase_date?: string, deadline_date?: string }} vars
 * @returns {string}
 */
export function renderTemplate(template, vars) {
  let result = String(template || "");
  if (vars.product_name != null) {
    result = result.replace(/\{\{product_name\}\}/g, String(vars.product_name));
  }
  if (vars.purchase_date != null) {
    result = result.replace(/\{\{purchase_date\}\}/g, String(vars.purchase_date));
  }
  if (vars.deadline_date != null) {
    result = result.replace(/\{\{deadline_date\}\}/g, String(vars.deadline_date));
  }
  return result;
}

// ── getDeadlineDate ───────────────────────────────────────────────────────

/**
 * Calculate the payment deadline date in JST.
 *
 * Purchase date is day 1. Mercari auto-cancels at 00:00 on day 4,
 * so the payment deadline is end of day 3 = purchase_date + 2 calendar days.
 *
 * Example: purchased 2026-07-16 → deadline 2026-07-18 (day 3).
 *
 * @param {string|Date|null} purchaseDate
 * @returns {string} JST date in "YYYY-MM-DD" format, or empty string
 */
export function getDeadlineDate(purchaseDate) {
  if (!purchaseDate) return "";
  const ms = purchaseDate instanceof Date
    ? purchaseDate.getTime()
    : Date.parse(String(purchaseDate));
  if (!Number.isFinite(ms)) return "";

  // Convert to JST, add 2 calendar days, format
  const jstMs = ms + 9 * 60 * 60 * 1000;
  const deadlineMs = jstMs + 2 * 24 * 60 * 60 * 1000;
  const d = new Date(deadlineMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
