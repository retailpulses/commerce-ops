import { statusEquals, REVIEW_STATUS } from "./order-state.mjs";

const ADDRESS_BACKFILL_FIELDS = [
  "shipping_name",
  "shipping_country",
  "shipping_postal_code",
  "shipping_state",
  "shipping_city",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_phone_number",
  "billing_name",
  "billing_country",
  "billing_postal_code",
  "billing_state",
  "billing_city",
  "billing_address_1",
  "billing_address_2",
];

function toTrimmed(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    return String(value.value ?? value.name ?? value.label ?? "").trim();
  }
  return String(value).trim();
}

/**
 * Check whether the backfill should run.
 *
 * Returns true when the incoming order is WAITING_FOR_SHIPPING and either:
 *   a) the existing status was WAITING_FOR_PAYMENT (fresh transition), or
 *   b) the shipping_name is still empty (retry after a previous failure).
 */
export function needsBackfill(existingRow, targetRow) {
  const incomingIsWFS = statusEquals(targetRow.order_status, "WAITING_FOR_SHIPPING");
  if (!incomingIsWFS) return false;

  const prevWasWFP = statusEquals(existingRow.order_status, "WAITING_FOR_PAYMENT");
  const shippingMissing = !toTrimmed(existingRow.shipping_name);

  return prevWasWFP || shippingMissing;
}

/**
 * Build a PATCH payload with review_status and address fields that need
 * backfilling. Returns an empty object when nothing needs updating.
 *
 * Review_status is initialized to Pending Review only when the current value
 * is empty. Any non-empty value is operator-owned and must be preserved.
 *
 * Some shipping methods, including らくらくメルカリ便, intentionally hide the
 * buyer address from the seller because Mercari sends it directly to the
 * shipping partner. A persistently empty address must therefore never be
 * treated as permission to reset an operator's review decision.
 *
 * Address fields are backfilled only when the existing value is empty and
 * the incoming (Mercari) value is present, preserving operator corrections.
 */
export function buildBackfillPayload(existingRow, targetRow) {
  const payload = {};

  const prevReview = toTrimmed(existingRow.review_status);
  if (prevReview === "") {
    payload.review_status = REVIEW_STATUS.PENDING_REVIEW;
  }

  for (const field of ADDRESS_BACKFILL_FIELDS) {
    const existingVal = toTrimmed(existingRow[field]);
    const mercariVal = toTrimmed(targetRow[field]);
    if (existingVal === "" && mercariVal !== "") {
      payload[field] = targetRow[field];
    }
  }

  return payload;
}
