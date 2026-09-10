import { readSelectValue } from "./order-state.mjs";

export const RAKUTEN_MAPPING_STATE = Object.freeze({
  MAPPED: "MAPPED",
  UNKNOWN: "UNKNOWN",
  MISSING: "MISSING",
});

export function normalizedRakutenProgress(row) {
  return String(row?.rakuten_order_progress ?? "").trim();
}

export function rakutenMappingState(row) {
  return String(readSelectValue(row?.rakuten_status_mapping_state) || "").trim().toUpperCase();
}

export function hasMappedRakutenProgress(row) {
  return rakutenMappingState(row) === RAKUTEN_MAPPING_STATE.MAPPED;
}

export function isRakutenShipmentReady(row) {
  return hasMappedRakutenProgress(row) && normalizedRakutenProgress(row) === "300";
}

export function canConfirmRakutenOnRms(row) {
  if (!hasMappedRakutenProgress(row)) return false;
  return new Set(["100", "200", "400", "600", "ORDER_ACCEPTED", "ORDER_IN_PROGRESS"])
    .has(normalizedRakutenProgress(row));
}

export function rakutenBlockingReason(row) {
  if (String(row?.sales_channel || "").trim().toLowerCase() !== "rakuten") return null;
  if (!hasMappedRakutenProgress(row)) {
    return `RMS orderProgress mapping is ${rakutenMappingState(row) || "MISSING"}`;
  }
  const raw = normalizedRakutenProgress(row);
  if (raw === "200" || raw === "600") return "Payment pending; RMS confirmation is allowed but fulfillment is blocked";
  if (raw === "700") return "Payment complete; waiting for fresh RMS orderProgress 300 before fulfillment";
  if (!isRakutenShipmentReady(row)) return `RMS orderProgress ${raw || "missing"} is not shipment-ready`;
  return null;
}

export function planRakutenConfirmation(row) {
  const currentStatus = String(readSelectValue(row?.order_status) || "").trim();
  if (String(row?.sales_channel || "").trim().toLowerCase() !== "rakuten") {
    return { ok: false, error: "only_rakuten_orders_can_be_confirmed" };
  }
  if (!canConfirmRakutenOnRms(row)) {
    return { ok: false, error: "rakuten_status_blocks_confirmation", reason: rakutenBlockingReason(row) };
  }
  if (currentStatus === "WAITING_FOR_PAYMENT") {
    return { ok: true, nextStatus: "WAITING_FOR_PAYMENT" };
  }
  if (currentStatus === "PENDING_CONFIRMATION") {
    return { ok: true, nextStatus: "CONFIRMED" };
  }
  return { ok: false, error: "order_not_confirmable", currentStatus };
}
