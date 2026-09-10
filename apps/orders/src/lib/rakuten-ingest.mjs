import { createBaserowClient, createRow, listAllRows, patchRow, clientForRakuten, FIELD, OPTION, validateExpectedFields, SALES_COLUMNS } from "./db.mjs";
import { RAKUTEN_ORDER_STATUS, ORDER_STATUS, readSelectValue } from "./order-state.mjs";
import {
  hasRmsCustomerRemarksBlock,
  mapRmsShippingTerm,
  mergeRmsOrderComments,
} from "./rakuten-order-fields.mjs";

/**
 * Normalize raw RMS order items into Baserow row payloads and upsert them
 * into the Rakuten Sales Orders table.
 *
 * @param {object} env - Worker env or process.env
 * @param {object[]} rmsOrders - Array of order objects from RMS searchOrder/getOrder response
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - If true, return payloads without writing
 * @returns {object} summary { ok, created, updated, unchanged, skipped, results }
 */
/**
 * Map RMS orderProgress value to internal order_status.
 *
 * RMS getOrder returns numeric codes:
 *   100 — ORDER_ACCEPTED → PENDING_CONFIRMATION
 *   200 — 楽天処理中 → WAITING_FOR_PAYMENT (fail closed while Rakuten processes payment)
 *   300 — 発送待ち → RMS_CONFIRMED (shipment-ready)
 *   400 — 変更確定待ち → PENDING_CONFIRMATION
 *   500 — 発送済 → COMPLETED
 *   600 — 支払手続き中 → WAITING_FOR_PAYMENT
 *   700 — 支払手続き済 → CONFIRMED (payment-complete, non-shippable)
 *   800 — キャンセル確定待ち → CANCELED (fail closed)
 *   900 — ORDER_CANCELED → CANCELED
 *
 * String codes (RMS v2 / backward compatibility):
 *   ORDER_ACCEPTED / ORDER_IN_PROGRESS / ORDER_START → PENDING_CONFIRMATION
 *   ORDER_COMPLETED / ORDER_SHIPPED → COMPLETED
 *   ORDER_CANCELED → CANCELED
 *   Unknown/null → null (don't map)
 *
 * @param {number|string|null} orderProgress - raw orderProgress from RMS getOrder
 * @returns {string|null} mapped order_status, or null if unmappable
 */
export function normalizeRmsOrderProgress(orderProgress) {
  const observedAt = new Date().toISOString();
  if (orderProgress == null || String(orderProgress).trim() === "") {
    return { raw: null, status: null, mappingState: "MISSING", observedAt, shipmentReady: false };
  }

  const raw = String(orderProgress).trim();
  let status = null;
  let shipmentReady = false;

  // ── Numeric codes (RMS es/2.0 REST API v3) ──────────────
  if (typeof orderProgress === "number" || /^\d+$/.test(String(orderProgress))) {
    const code = Number(orderProgress);
    switch (code) {
      case 100: // ORDER_ACCEPTED
      case 400: // 変更確定待ち (non-terminal)
        status = RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION;
        break;
      case 300: // 発送待ち — authoritative shipment-ready state
        status = RAKUTEN_ORDER_STATUS.RMS_CONFIRMED;
        shipmentReady = true;
        break;
      case 700: // 支払手続き済 — payment complete, not shipment-ready
        status = RAKUTEN_ORDER_STATUS.CONFIRMED;
        break;
      case 200: // 楽天処理中 — not operator-actionable; payment may not be settled
      case 600: // 支払手続き中
        status = ORDER_STATUS.WAITING_FOR_PAYMENT;
        break;
      case 500: // 発送済
        status = ORDER_STATUS.COMPLETED;
        break;
      case 800: // キャンセル確定待ち — block approval/fulfilment immediately
      case 900: // ORDER_CANCELED
        status = RAKUTEN_ORDER_STATUS.CANCELED;
        break;
      default:
        console.warn(JSON.stringify({
          event: "rakuten_unknown_order_progress",
          orderProgress: code,
        }));
        return { raw, status: null, mappingState: "UNKNOWN", observedAt, shipmentReady: false };
    }
    return { raw, status, mappingState: "MAPPED", observedAt, shipmentReady };
  }

  // ── String codes (RMS v2 / backward compatibility) ──────
  const MAP = {
    ORDER_ACCEPTED: RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION,
    ORDER_IN_PROGRESS: RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION,
    ORDER_START: RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION,
    ORDER_COMPLETED: ORDER_STATUS.COMPLETED,
    ORDER_SHIPPED: ORDER_STATUS.COMPLETED,
    ORDER_CANCELED: RAKUTEN_ORDER_STATUS.CANCELED,
  };
  status = MAP[raw] ?? null;
  return {
    raw,
    status,
    mappingState: status ? "MAPPED" : "UNKNOWN",
    observedAt,
    shipmentReady: false,
  };
}

export function mapRmsOrderProgressToStatus(orderProgress) {
  return normalizeRmsOrderProgress(orderProgress).status;
}

export async function ingestRakutenOrders(env, rmsOrders, options = {}) {
  const client = createBaserowClient(env);
  const baserow = clientForRakuten(client);
  const dryRun = options.dryRun === true;

  // ── Dependency injection (test-only) ──
  const _listAllRows = options._inject?.listAllRows || listAllRows;
  const _patchRow   = options._inject?.patchRow   || patchRow;
  const _createRow   = options._inject?.createRow   || createRow;

  // Load existing rows for dedup — channel-scoped to prevent cross-channel collisions
  const existingRows = await _listAllRows(baserow, baserow.salesOrderTableId, {
    [`filter__field_${FIELD.RAKUTEN_SALES.SALES_CHANNEL}__equal`]: "rakuten",
  });
  const existingByOrderId = new Map();
  for (const row of existingRows) {
    const oid = normalizeOrderId(text(row.order_id));
    if (oid) existingByOrderId.set(oid, row);
  }

  const summary = {
    ok: true,
    input_count: Array.isArray(rmsOrders) ? rmsOrders.length : 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    persistence_failures: 0,
    results: [],
  };

  if (!Array.isArray(rmsOrders) || rmsOrders.length === 0) return summary;

  for (const order of rmsOrders) {
    const orderId = normalizeOrderId(extractOrderNumber(order));
    if (!orderId) {
      summary.skipped += 1;
      summary.results.push({ action: "skipped", reason: "missing_order_number" });
      continue;
    }

    const existing = existingByOrderId.get(orderId);
    const payload = buildRakutenSalesPayload(order);
    await preserveOrResolveB2BItemCode(payload, existing);
    // Map RMS orderProgress to internal order_status
    const mapping = normalizeRmsOrderProgress(order.orderProgress);
    const mappedStatus = mapping.status;
    const currentStatus = existing ? readSelectValue(existing.order_status) : null;
    const previousRaw = text(existing?.rakuten_order_progress) || null;
    const previousMappingState = text(existing?.rakuten_status_mapping_state) || null;
    const mappingEvidenceChanged = previousRaw !== mapping.raw || previousMappingState !== mapping.mappingState;
    payload.rakuten_order_progress = mapping.raw;
    payload.rakuten_status_mapping_state = mapping.mappingState;
    payload.rakuten_order_progress_observed_at = mappingEvidenceChanged
      ? mapping.observedAt
      : existing?.rakuten_order_progress_observed_at || mapping.observedAt;

    // Transition-aware guard: ingest must not regress local forward progress.
    // An operator-confirmed order (CONFIRMED or RMS_CONFIRMED) must not be
    // reverted to PENDING_CONFIRMATION by a non-terminal RMS status.
    // Terminal RMS states (COMPLETED, CANCELED) always win.
    const isRegressiveDowngrade =
      (currentStatus === RAKUTEN_ORDER_STATUS.CONFIRMED ||
        currentStatus === RAKUTEN_ORDER_STATUS.RMS_CONFIRMED) &&
      mappedStatus === RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION;

    const statusChanged = mappedStatus !== null &&
      mappedStatus !== currentStatus &&
      !isRegressiveDowngrade;

    const purchaseDateMissing = existing && !existing.purchase_date && payload.purchase_date;

    const resultItem = { order_id: orderId, manage_number: payload.manage_number };

    try {
      // On update: restore operator-owned delivery fields BEFORE equivalence
      // check so rows that only differ in delivery prefs (operator already set
      // them) are correctly classified as unchanged.
      if (existing) {
        // Merge only the ingest-owned RMS block and warning. Operator memos and
        // Portal audit entries outside those markers remain untouched.
        payload.order_comments = mergeRmsOrderComments(
          existing.order_comments,
          order.remarks,
          mapRmsShippingTerm(order.shippingTerm),
        );

        // Do NOT overwrite confirm_in_progress on existing rows. This flag
        // is owned by the confirmer (rakuten-confirmer.mjs). Writing false
        // on every ingest update would race with an active confirmation and
        // also resets last_synced_at, breaking stuck-flag timeout detection.
        delete payload.confirm_in_progress;

        // Preserve operator-owned delivery fields on update. These fields are
        // operator-managed per field-ownership.mjs. Only set them on create;
        // on re-ingest, keep existing operator values.
        //
        // DESIGN NOTE: Preservation is conditional (non-empty only). This
        // means if an operator intentionally clears a delivery field, the
        // next re-ingest will restore the RMS value — a known limitation.
        // The alternative (unconditional preservation) would prevent initial
        // backfill of legacy rows that have NULL delivery fields. We accept
        // the re-population edge case because:
        //   1. It's the safer failure mode (over-populate vs under-populate)
        //   2. Operator-clear is very rare in practice
        //   3. Operator can always re-clear if needed
        // A future fix would add a delivery_prefs_reviewed boolean flag
        // to distinguish "never set" from "intentionally cleared".
        if (text(existing.requested_delivery_date)) {
          payload.requested_delivery_date = text(existing.requested_delivery_date);
        }
        if (text(existing.requested_delivery_time)) {
          payload.requested_delivery_time = text(existing.requested_delivery_time);
        }
      }

      if (existing && !statusChanged && !purchaseDateMissing && rowsEquivalentForIngest(existing, payload)) {
        summary.unchanged += 1;
        summary.results.push({ ...resultItem, action: "unchanged", row_id: Number(existing.id) });
        continue;
      }

      if (existing) {
        if (dryRun) {
          summary.results.push({ ...resultItem, action: "would_update", row_id: Number(existing.id) });
          continue;
        }
        // Include order_status only when RMS orderProgress changed AND not regressive
        if (statusChanged) {
          payload.order_status = mappedStatus;
        }
        // Add sync audit fields for update path
        payload.last_synced_at = new Date().toISOString();
        payload.sync_error = "";
        const validation = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-ingest");
        if (!validation.ok) {
          throw new Error(`rakuten_ingest_validation_failed:${validation.discarded.join(",")}`);
        }
        const res = await _patchRow(baserow, baserow.salesOrderTableId, existing.id, payload);
        if (!res.ok) {
          // Persist sync_error on the existing row so the failure is observable
          const errRes = await _patchRow(baserow, baserow.salesOrderTableId, existing.id, {
            sync_error: (res.error || `patch_failed_${res.status}`).slice(0, 500),
            last_synced_at: new Date().toISOString(),
          }).catch((e) => ({ ok: false, error: e.message }));
          if (!errRes.ok) {
            summary.persistence_failures += 1;
            console.log(JSON.stringify({
              warning: "rakuten_ingest_sync_error_persistence_failed",
              order_id: orderId,
              reason: errRes.error || "unknown",
            }));
          }
          throw new Error(res.error || `patch_failed_${res.status}`);
        }
        if (text(order.remarks) && !hasRmsCustomerRemarksBlock(existing.order_comments)) {
          console.log(JSON.stringify({
            event: "rakuten_rms_remarks_backfilled",
            order_id: orderId,
            remarks_length: text(order.remarks).length,
          }));
        }
        summary.updated += 1;
        summary.results.push({ ...resultItem, action: "updated", row_id: Number(existing.id) });
      } else {
        if (dryRun) {
          summary.results.push({ ...resultItem, action: "would_create" });
          continue;
        }
        // Unknown/missing source values remain visible but fail closed through
        // rakuten_status_mapping_state. They never unlock downstream actions.
        payload.order_status = mappedStatus || RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION;
        payload.last_synced_at = new Date().toISOString();
        payload.sync_error = "";
        const validation = validateExpectedFields(payload, SALES_COLUMNS, "rakuten-ingest");
        if (!validation.ok) {
          throw new Error(`rakuten_ingest_validation_failed:${validation.discarded.join(",")}`);
        }
        const res = await _createRow(baserow, baserow.salesOrderTableId, payload);
        if (!res.ok) throw new Error(res.error || `create_failed_${res.status}`);
        const newRowId = Number(res.body && res.body.id ? res.body.id : 0) || null;
        summary.created += 1;
        summary.results.push({ ...resultItem, action: "created", row_id: newRowId });
      }
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        ...resultItem,
        action: "failed",
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  summary.ok = summary.failed === 0;
  return summary;
}

/**
 * Build a Baserow row payload from a raw RMS getOrder response.
 *
 * RMS getOrder (version=3) response structure:
 *   OrderModelList[].orderNumber, orderDatetime, orderProgress, carrierCode,
 *     goodsPrice, totalPrice, postagePrice,
 *     OrdererModel (billing customer),
 *     SettlementModel.settlementMethod, deliveryDate, shippingTerm, remarks,
 *     PackageModelList[].{
 *       ItemModelList[].{ itemName, manageNumber, price, units },
 *       SenderModel.{ zipCode1, zipCode2, prefecture, city, subAddress,
 *                      familyName, firstName, phoneNumber1-3 }
 *     }
 */
export function buildRakutenSalesPayload(order) {
  const firstPkg = Array.isArray(order.PackageModelList) ? order.PackageModelList[0] : null;
  const firstItem = firstPkg && Array.isArray(firstPkg.ItemModelList) ? firstPkg.ItemModelList[0] : null;
  const rmsSku = extractRakutenMerchantDefinedSkuId(firstItem);
  const sender = firstPkg && firstPkg.SenderModel ? firstPkg.SenderModel : null;
  const orderDate = text(order.orderDatetime || order.orderDate);

  // Build full name from sender (shipping address) or fall back to orderer
  const shippingName = sender
    ? `${text(sender.familyName)}${text(sender.firstName)}`.trim()
    : text(order.OrdererModel
      ? `${text(order.OrdererModel.familyName)}${text(order.OrdererModel.firstName)}`
      : "");

  // Build phone from parts
  const phone = sender
    ? [text(sender.phoneNumber1), text(sender.phoneNumber2), text(sender.phoneNumber3)]
        .filter(Boolean).join("-")
    : "";

  // Build postal code
  const postalCode = sender
    ? `${text(sender.zipCode1)}-${text(sender.zipCode2)}`
    : "";

  // RMS getOrder v3 exposes delivery preferences at OrderModel top level.
  const requestedDeliveryDate = toDateOnly(order.deliveryDate);
  const shippingTermMapping = mapRmsShippingTerm(order.shippingTerm);
  if (!shippingTermMapping.known) {
    console.log(JSON.stringify({
      event: "rakuten_unknown_shipping_term",
      order_id: normalizeOrderId(extractOrderNumber(order)),
      shipping_term: shippingTermMapping.normalizedTerm,
    }));
  }

  return {
    order_id: normalizeOrderId(extractOrderNumber(order)),
    purchase_date: orderDate ? toDateOnly(orderDate) : null,
    product_name: text(firstItem && firstItem.itemName) || "",
    manage_number: text(firstItem && firstItem.manageNumber) || "",
    b2b_item_code: rmsSku,
    quantity: parsePositiveInteger(firstItem && firstItem.units),
    // 購買額 = 合計金額 - クーポン利用総額. RMS reports couponAllTotalPrice
    // as a positive discount amount. Item price remains the compatibility
    // fallback for older/partial payloads without an order-level total.
    product_price: calculateRakutenPurchaseAmount(order, firstItem),
    payment_method: text(order.SettlementModel && order.SettlementModel.settlementMethod),
    shipping_name: shippingName,
    shipping_postal_code: formatPostalCode(postalCode),
    shipping_state: text(sender && sender.prefecture),
    shipping_city: text(sender && sender.city),
    shipping_address_1: text(sender && sender.subAddress),
    shipping_address_2: "",
    shipping_phone_number: normalizePhone(phone),
    requested_delivery_date: requestedDeliveryDate || "",
    requested_delivery_time: shippingTermMapping.requestedDeliveryTime,
    order_comments: mergeRmsOrderComments("", order.remarks, shippingTermMapping),
    confirm_in_progress: false,
    sync_error: "",
  };
}

/**
 * Read the exact SKU selected by the buyer from Rakuten getOrder v7.
 * A single ItemModel must resolve to exactly one distinct SKU.
 */
export function extractRakutenMerchantDefinedSkuId(item) {
  const skuModels = Array.isArray(item?.SkuModelList) ? item.SkuModelList : [];
  const codes = [...new Set(skuModels
    .map((model) => text(model?.merchantDefinedSkuId || model?.variantId))
    .filter(Boolean))];
  return codes.length === 1 ? codes[0] : "";
}

/**
 * Use the authoritative RMS v7 SKU when present. If RMS omits the SKU, keep
 * an existing operator-maintained value or leave the order unresolved while
 * allowing normal ingest to continue.
 */
export async function preserveOrResolveB2BItemCode(payload, existing) {
  const rmsCode = text(payload?.b2b_item_code);
  if (rmsCode) {
    payload.b2b_item_code = rmsCode;
    return { source: "rms_sku", code: rmsCode };
  }
  const existingCode = text(existing?.b2b_item_code) || text(existing?.B2BItemCode);
  if (existingCode) {
    payload.b2b_item_code = existingCode;
    return { source: "existing", code: existingCode };
  }
  return { source: "unresolved", code: "" };
}

function extractOrderNumber(order) {
  return text(order && (order.orderNumber || order.orderNo || order.orderId));
}

/**
 * Compare existing row with incoming payload for "no change" detection.
 * We only compare the fields relevant to the ingest — not status fields.
 */
function rowsEquivalentForIngest(existing, payload) {
  const keys = [
    "purchase_date", "product_name", "manage_number", "quantity",
    "product_price", "payment_method", "shipping_name", "shipping_postal_code",
    "shipping_state", "shipping_city", "shipping_address_1",
    "shipping_address_2", "shipping_phone_number", "b2b_item_code",
    "requested_delivery_date", "requested_delivery_time", "order_comments",
    "rakuten_order_progress", "rakuten_status_mapping_state",
    "rakuten_order_progress_observed_at",
  ];
  for (const key of keys) {
    if (text(existing[key]) !== text(payload[key])) return false;
  }
  // Also check numeric fields
  if (Number(existing.quantity) !== Number(payload.quantity)) return false;
  if (Number(existing.product_price) !== Number(payload.product_price)) return false;
  return true;
}

// ── Helpers (same conventions as shipment-projector.mjs) ──────────

function text(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order[_-\s]*/i, "");
}

function toDateOnly(value) {
  // Accept ISO 8601 or JST date strings, return YYYY-MM-DD
  const t = text(value);
  if (!t) return null;
  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // Try parsing ISO
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parsePositiveInteger(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseDecimalNumber(value) {
  const n = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function calculateRakutenPurchaseAmount(order, firstItem) {
  const totalPrice = Number.parseFloat(String(order?.totalPrice ?? "").trim());
  const baseAmount = Number.isFinite(totalPrice)
    ? totalPrice
    : parseDecimalNumber(firstItem && firstItem.price);
  const couponAmount = Number.parseFloat(String(order?.couponAllTotalPrice ?? "").trim());
  if (!Number.isFinite(couponAmount)) return baseAmount;
  // Accept either the documented positive amount or a signed discount from a
  // compatibility payload without double-negating it.
  return baseAmount - Math.abs(couponAmount);
}

function formatPostalCode(value) {
  const t = text(value).replace(/[〒\-\s]/g, "");
  if (t.length === 7) return `${t.slice(0, 3)}-${t.slice(3)}`;
  return t;
}

function normalizePhone(value) {
  return text(value).replace(/[^\d+\-]/g, "");
}
