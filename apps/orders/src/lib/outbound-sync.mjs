import { createBaserowClient, listAllRows, patchRow, FIELD, OPTION } from "./db.mjs";
import { isPipelineApprovedReviewStatus } from "./review-gate.mjs";
import { getMercariShopOrderFromName } from "./mercari-shops.mjs";
import { GigaClient } from "./giga-client.mjs";
import { toJstIso } from "./timezone.mjs";
import { GIGA_SYNC_STATUS, readSelectValue, statusEquals } from "./order-state.mjs";
import { isRakutenShipmentReady } from "./rakuten-status-gates.mjs";
import { claimExternalOperation, finalizeExternalOperation } from "./external-operation-ledger.mjs";

const SHOP_IDS = {
  Shop1: "WMyisFmhbGWyVAPEwsfirn",
  Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  Shop3: "2JGrmZqojnBMfdWrtP2xk3",
  Shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

const GIGA_FIELDS = {
  salesChannel: "SalesChannel",
  shipFrom: "ShipFrom",
  orderId: "OrderId",
  lineItemNumber: "LineItemNumber",
  b2bItemCode: "B2BItemCode",
  shipToQty: "ShipToQty",
  shipToName: "ShipToName",
  shipToEmail: "ShipToEmail",
  shipToPhone: "ShipToPhone",
  shipToPostalCode: "ShipToPostalCode",
  shipToAddressDetail: "ShipToAddressDetail",
  shipToCity: "ShipToCity",
  shipToState: "ShipToState",
  shipToCountry: "ShipToCountry",
  orderDate: "OrderDate",
  requestedDeliveryDate: "RequestedDeliveryDate",
  buyerSkuDescription: "BuyerSkuDescription",
  buyerSkuCommercialValue: "BuyerSkuCommercialValue",
  orderComments: "OrderComments",
  sourceStoreId: "SourceStoreID",
  gigaSyncStatus: "giga_sync_status",
  gigaSyncAttemptedAt: "giga_sync_attempted_at",
  gigaSyncProcessedAt: "giga_sync_processed_at",
  gigaSyncError: "giga_sync_error",
  gigaSyncRequestId: "giga_sync_request_id",
  gigaSyncPayloadHash: "giga_sync_payload_hash",
  gigaSyncScope: "giga_sync_scope",
};

const OUTBOUND_SALES_SELECT = [
  "id",
  "order_id",
  "order_status",
  "review_status",
  "rakuten_order_progress",
  "rakuten_status_mapping_state",
].join(",");

const GIGA_ALLOWED_SALES_CHANNELS = new Set([
  "Wayfair",
  "Amazon",
  "Walmart",
  "eBay",
  "HomeDepot",
  "Overstock",
  "NewEgg",
  "Macy's",
  "Rakuten",
  "Mercari",
  "Yahoo",
  "QOO10",
  "Shopify",
  "TARGET",
  "AliExpress",
  "Lowes",
  "SHEIN",
  "Tik Tok",
  "OTTO",
  "TEMU",
  "B&Q",
  "Other",
]);

export async function runOutboundSync(env, { shops, limit, orderId = "", platform = "Mercari", dryRun = false }, injected = {}) {
  const results = [];
  let ok = true;
  const collect = injected.collectScopedGroups || collectScopedGroups;
  const preview = injected.runDryRun || runDryRun;
  const syncWriter = injected.runSync || runSync;

  // For Rakuten (single store), use platform as the store key
  const entries = platform === "Rakuten"
    ? [{ label: "Rakuten", storeId: "Rakuten" }]
    : (shops || []).map((shop) => ({ label: shop, storeId: SHOP_IDS[shop] }));

  for (const entry of entries) {
    if (!entry.storeId) continue;
    const body = { platform, store_id: entry.storeId, limit, order_id: orderId || "" };
    const collected = await collect(env, body);
    const dry = await preview(env, body, collected);
    if (dryRun) {
      if (!dry.ok) ok = false;
      results.push({ shop: entry.label, storeId: entry.storeId, dry, sync: null });
      continue;
    }
    const sync = await syncWriter(env, body, collected);
    if (!sync.ok) ok = false;
    results.push({ shop: entry.label, storeId: entry.storeId, dry, sync });
  }
  return { ok, mode: dryRun ? "dry_run" : "sync", results };
}

async function runDryRun(env, body, collectedOverride = null) {
  const collected = collectedOverride || await collectScopedGroups(env, body);
  if (!collected.ok) return collected;
  const { platform, storeId, orderIdFilter, limit, allRows, inScope, filtered, feeExcluded, groups, limitedGroups } = collected;
  const payloads = limitedGroups.map((group) => buildDryRunPayload(group, platform, storeId));
  const warnings = buildWarnings(platform);
  const invalidGroups = payloads.filter((item) => item.validationErrors.length > 0);
  return {
    ok: true,
    mode: "dry_run",
    scope: { platform, store_id: storeId, cursor_key: buildCursorKey(platform, storeId) },
    counts: {
      total_rows_loaded: allRows.length,
      in_scope_rows: inScope.length,
      fee_rows_excluded: feeExcluded.length,
      eligible_rows: filtered.length,
      grouped_orders: groups.length,
      grouped_orders_returned: payloads.length,
      invalid_groups: invalidGroups.length,
    },
    filters: {
      order_id: orderIdFilter || null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    },
    warnings,
    sample_payloads: payloads.slice(0, 5),
  };
}

async function runSync(env, body, collectedOverride = null) {
  const collected = collectedOverride || await collectScopedGroups(env, body);
  if (!collected.ok) return collected;
  const { platform, storeId, orderIdFilter, limit, groups, limitedGroups, client, availableProgressFields } = collected;
  const giga = new GigaClient(env.GIGA_CLIENT_ID, env.GIGA_CLIENT_SECRET, env.GIGA_API_BASE_URL);
  const warnings = buildWarnings(platform);
  const runId = normalizeFieldText(env.ORDERMGMT_RUN_ID) || `giga_outbound_${Date.now()}`;
  const summary = {
    ok: true,
    mode: "sync",
    scope: { platform, store_id: storeId, cursor_key: buildCursorKey(platform, storeId) },
    filters: {
      order_id: orderIdFilter || null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    },
    counts: {
      candidate_groups: groups.length,
      processed_groups: 0,
      synced: 0,
      already_exists: 0,
      invalid: 0,
      failed: 0,
    },
    warnings,
    progress_fields: {
      available: Array.from(availableProgressFields),
      missing: [],
    },
    results: [],
  };

  for (const group of limitedGroups) {
    const preview = buildDryRunPayload(group, platform, storeId);
    const rowIds = preview.source_row_ids;
    const nowIso = toJstIso(new Date());
    const eligibility = await recheckOutboundEligibility(client, platform, storeId, preview.order_id);
    if (!eligibility.ok) {
      summary.counts.failed += 1;
      summary.counts.processed_groups += 1;
      summary.results.push({
        order_id: preview.order_id,
        action: "blocked_by_live_eligibility",
        row_ids: rowIds,
        reason: eligibility.reason,
      });
      continue;
    }
    const payloadHash = await sha256Hex(JSON.stringify(preview.payload));
    if (preview.validationErrors.length > 0) {
      summary.counts.invalid += 1;
      summary.counts.processed_groups += 1;
      const errorText = preview.validationErrors.join("; ");
      await updateRowsProgress(client, rowIds, availableProgressFields, {
        [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.INVALID,
        [GIGA_FIELDS.gigaSyncError]: errorText,
      });
      summary.results.push({ order_id: preview.order_id, action: "invalid", row_ids: rowIds, errors: preview.validationErrors });
      continue;
    }

    if (client.type !== "supabase") {
      summary.counts.failed += 1;
      summary.counts.processed_groups += 1;
      summary.results.push({ order_id: preview.order_id, action: "blocked", reason: "external_operation_ledger_requires_supabase" });
      continue;
    }
    let claim;
    try {
      claim = await claimExternalOperation(client.supabase, {
        capability: "giga_create_order", platform: String(platform).toLowerCase(),
        sourceStoreId: storeId, orderId: preview.order_id, payloadHash, runId,
      });
    } catch (error) {
      summary.counts.failed += 1;
      summary.counts.processed_groups += 1;
      summary.results.push({ order_id: preview.order_id, action: "blocked", reason: error.message });
      continue;
    }
    if (!claim.claimed) {
      const applied = ["CONFIRMED", "ALREADY_APPLIED"].includes(claim.status);
      if (applied) {
        summary.counts.already_exists += 1;
        await updateRowsProgress(client, rowIds, availableProgressFields, {
          [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.ALREADY_EXISTS,
          [GIGA_FIELDS.gigaSyncProcessedAt]: nowIso,
          [GIGA_FIELDS.gigaSyncPayloadHash]: payloadHash,
          [GIGA_FIELDS.gigaSyncScope]: `${platform}::${storeId}`,
        });
      } else {
        summary.counts.failed += 1;
      }
      summary.counts.processed_groups += 1;
      summary.results.push({ order_id: preview.order_id, action: applied ? "ledger_already_applied" : "ledger_blocked", operation_status: claim.status });
      continue;
    }
    try {
      await updateRowsProgress(client, rowIds, availableProgressFields, {
        [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.ATTEMPTED,
        [GIGA_FIELDS.gigaSyncAttemptedAt]: nowIso,
        [GIGA_FIELDS.gigaSyncError]: "",
        [GIGA_FIELDS.gigaSyncRequestId]: "",
        [GIGA_FIELDS.gigaSyncPayloadHash]: payloadHash,
        [GIGA_FIELDS.gigaSyncScope]: `${platform}::${storeId}`,
      });
    } catch (error) {
      await finalizeExternalOperation(client.supabase, {
        operationKey: claim.operationKey, runId, status: "DEFINITIVE_FAILURE",
        errorCode: `local_attempt_persistence_failed:${error.message}`,
      });
      summary.counts.failed += 1;
      summary.counts.processed_groups += 1;
      summary.results.push({ order_id: preview.order_id, action: "blocked", reason: "local_attempt_persistence_failed" });
      continue;
    }

    let providerAccepted = false;
    try {
      const response = await giga.createOrder(preview.payload);
      providerAccepted = true;
      const requestId = normalizeFieldText(response && response.requestId);
      await finalizeExternalOperation(client.supabase, {
        operationKey: claim.operationKey, runId, status: "CONFIRMED",
        providerRequestId: requestId, providerCode: response?.code,
      });
      summary.counts.synced += 1;
      summary.counts.processed_groups += 1;
      await updateRowsProgress(client, rowIds, availableProgressFields, {
        [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.SYNCED,
        [GIGA_FIELDS.gigaSyncProcessedAt]: nowIso,
        [GIGA_FIELDS.gigaSyncRequestId]: requestId,
        [GIGA_FIELDS.gigaSyncError]: "",
      });
      summary.results.push({
        order_id: preview.order_id,
        action: "synced",
        row_ids: rowIds,
        request_id: requestId || null,
        code: response && response.code ? String(response.code) : null,
      });
    } catch (error) {
      const gigaCode = normalizeFieldText(error && error.gigaCode);
      const gigaMessage = normalizeFieldText(error && error.gigaMessage) || normalizeFieldText(error && error.message);
      const gigaResponse = error && error.gigaResponse && typeof error.gigaResponse === "object" ? error.gigaResponse : {};
      const requestId = normalizeFieldText(gigaResponse.requestId);
      const lowerMessage = gigaMessage.toLowerCase();
      const isAlreadyExistsError = lowerMessage.includes("already exists")
        || lowerMessage.includes("already been created")
        || (gigaCode === "B11004" && !gigaMessage);
      if (isAlreadyExistsError) {
        await finalizeExternalOperation(client.supabase, {
          operationKey: claim.operationKey, runId, status: "ALREADY_APPLIED",
          providerRequestId: requestId, providerCode: gigaCode, errorCode: gigaMessage,
        });
        summary.counts.already_exists += 1;
        summary.counts.processed_groups += 1;
        await updateRowsProgress(client, rowIds, availableProgressFields, {
          [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.ALREADY_EXISTS,
          [GIGA_FIELDS.gigaSyncProcessedAt]: nowIso,
          [GIGA_FIELDS.gigaSyncRequestId]: requestId,
          [GIGA_FIELDS.gigaSyncError]: gigaMessage,
        });
        summary.results.push({
          order_id: preview.order_id,
          action: "already_exists",
          row_ids: rowIds,
          request_id: requestId || null,
          code: gigaCode || null,
          message: gigaMessage || null,
        });
        continue;
      }

      const operationStatus = providerAccepted || error?.outcomeUncertain ? "UNKNOWN_RESULT" : "DEFINITIVE_FAILURE";
      try {
        await finalizeExternalOperation(client.supabase, {
          operationKey: claim.operationKey, runId, status: operationStatus,
          providerRequestId: requestId, providerCode: gigaCode,
          errorCode: gigaMessage || "giga_sync_failed",
        });
      } catch (ledgerError) {
        summary.results.push({ order_id: preview.order_id, action: "ledger_finalize_failed", message: ledgerError.message });
      }
      summary.counts.failed += 1;
      summary.counts.processed_groups += 1;
      await updateRowsProgress(client, rowIds, availableProgressFields, {
        [GIGA_FIELDS.gigaSyncStatus]: GIGA_SYNC_STATUS.ERROR,
        [GIGA_FIELDS.gigaSyncRequestId]: requestId,
        [GIGA_FIELDS.gigaSyncError]: `${operationStatus}:${gigaMessage || "giga_sync_failed"}`,
      });
      summary.results.push({
        order_id: preview.order_id,
        action: operationStatus === "UNKNOWN_RESULT" ? "unknown_result" : "error",
        row_ids: rowIds,
        request_id: requestId || null,
        code: gigaCode || null,
        message: gigaMessage || null,
      });
    }
  }
  return summary;
}

async function recheckOutboundEligibility(client, platform, storeId, orderId) {
  if (client.type !== "supabase") return { ok: false, reason: "supabase_required" };
  const normalized = normalizeOrderId(orderId);
  const candidates = [...new Set([normalized, `order_${normalized}`])];
  const { data, error } = await client.supabase.from("sales_orders")
    .select(OUTBOUND_SALES_SELECT)
    .eq("sales_channel", String(platform).toLowerCase())
    .eq("source_store_id", storeId)
    .in("order_id", candidates);
  if (error) return { ok: false, reason: "eligibility_read_failed" };
  if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: "sales_order_not_found" };
  const eligible = data.every((row) => {
    if (platform === "Rakuten") return isRakutenShipmentReady(row);
    const statusReady = statusEquals(row.order_status, OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING);
    const review = normalizeFieldText(row.review_status);
    return statusReady && (isPipelineApprovedReviewStatus(review) || !review);
  });
  return eligible ? { ok: true } : { ok: false, reason: "status_or_review_changed" };
}

async function collectScopedGroups(env, body) {
  const platform = trimAndCollapse(body.platform);
  const storeId = trimAndCollapse(body.store_id || body.storeId);
  const orderIdFilter = trimAndCollapse(body.order_id || body.orderId);
  const limit = normalizePositiveInteger(body.limit);
  const retryAfterMinutes = normalizePositiveInteger(body.retry_after_minutes || body.retryAfterMinutes)
    || normalizePositiveInteger(env.GIGA_OUTBOUND_RETRY_AFTER_MINUTES)
    || 30;
  if (!platform) return { ok: false, statusCode: 400, error: "missing_platform" };
  if (!storeId) return { ok: false, statusCode: 400, error: "missing_store_id" };
  const client = createBaserowClient(env);
  // Filter shipments to this platform+store scope only (not all-scan)
  const allRows = await listAllRows(client, client.shipmentOrderTableId, {
    [`filter__field_${FIELD.SHIPMENT.SALES_CHANNEL}__equal`]: platform,
    [`filter__field_${FIELD.SHIPMENT.SOURCE_STORE_ID}__equal`]: storeId,
  });
  // Fetch sales data needed for both review gate (Mercari) and cancellation detection.
  // Two parallel filtered queries instead of one unfiltered scan.
  // Platform-aware: Rakuten uses rakutenSalesOrderTableId + RMS_CONFIRMED status;
  // Mercari uses salesOrderTableId + WAITING_FOR_SHIPPING.
  const isRakuten = platform === "Rakuten";
  const salesTableId = isRakuten ? client.rakutenSalesOrderTableId : client.salesOrderTableId;
  const wfsStatus = isRakuten
    ? OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED
    : OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING;
  const cancelStatus = isRakuten
    ? OPTION.RAKUTEN_ORDER_STATUS.CANCELED
    : OPTION.ORDER_STATUS.CANCELED;

  const [salesWfs, salesCanceled] = await Promise.all([
    listAllRows(client, salesTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: wfsStatus,
    }, { select: OUTBOUND_SALES_SELECT }),
    listAllRows(client, salesTableId, {
      [`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]: cancelStatus,
    }, { select: OUTBOUND_SALES_SELECT }),
  ]);
  const salesRows = [...salesWfs, ...salesCanceled];

  // Build allowlist: order IDs that are ready for outbound push.
  // Mercari: WAITING_FOR_SHIPPING + Approved (or empty/legacy review_status).
  // Rakuten: RMS_CONFIRMED (confirmation IS the gate; no separate review_status field).
  const approvedOrderIds = new Set(
    salesWfs
      .filter((row) => {
        if (isRakuten) return isRakutenShipmentReady(row);
        const rs = normalizeFieldText(row.review_status);
        const isApproved = isPipelineApprovedReviewStatus(rs);
        const isEmpty = !rs;
        return isApproved || isEmpty;
      })
      .map((row) => normalizeOrderId(row.order_id))
      .filter(Boolean),
  );

  // Build denylist: order IDs that are CANCELING or CANCELED.
  const canceledOrderIds = new Set(
    salesCanceled
      .map((row) => normalizeOrderId(row.order_id))
      .filter(Boolean),
  );
  const availableProgressFields = detectAvailableProgressFields(allRows);
  const inScope = allRows.filter((row) => matchesScope(row, platform, storeId));
  const nowMs = Date.now();
  const orderIdSet = orderIdFilter
    ? new Set(orderIdFilter.split(",").map((s) => normalizeOrderId(s)).filter(Boolean))
    : null;
  const filtered = inScope.filter((row) => {
    if (shouldSkipFeeRow(row)) return false;
    const orderId = normalizeOrderId(row[GIGA_FIELDS.orderId]);
    if (!approvedOrderIds.has(orderId)) return false;
    if (canceledOrderIds.has(orderId)) return false;
    if (orderIdSet && !orderIdSet.has(orderId)) return false;
    if (!orderIdSet && !shouldProcessRow(row, nowMs, retryAfterMinutes)) return false;
    return true;
  });
  const feeExcluded = inScope.filter((row) => shouldSkipFeeRow(row));
  const groups = Array.from(groupRowsByOrderId(filtered).values());
  const limitedGroups = Number.isFinite(limit) && limit > 0 ? groups.slice(0, limit) : groups;
  return {
    ok: true,
    platform,
    storeId,
    orderIdFilter,
    limit,
    client,
    allRows,
    inScope,
    filtered,
    canceledOrderIdsCount: canceledOrderIds.size,
    feeExcluded,
    groups,
    limitedGroups,
    availableProgressFields,
    retryAfterMinutes,
  };
}

export function buildDryRunPayload(group, platform, storeId) {
  const rows = group.rows.slice().sort(compareLineRows);
  const first = rows[0] || {};
  let orderFrom = "";
  let orderFromError = "";
  try {
    orderFrom = resolveOutboundOrderFrom(first[GIGA_FIELDS.shipFrom], first[GIGA_FIELDS.sourceStoreId]);
  } catch (error) {
    orderFromError = normalizeFieldText(error && error.message ? error.message : error);
  }
  const deduped = dedupeOrderLines(rows, group.orderId);
  const payload = {
    orderDate: normalizeDateTimeText(first[GIGA_FIELDS.orderDate]),
    orderNo: normalizeOrderId(first[GIGA_FIELDS.orderId]),
    shipName: normalizeFieldText(first[GIGA_FIELDS.shipToName]),
    shipPhone: normalizeFieldText(first[GIGA_FIELDS.shipToPhone]),
    shipEmail: normalizeFieldText(first[GIGA_FIELDS.shipToEmail]),
    shipAddress1: normalizeFieldText(first[GIGA_FIELDS.shipToAddressDetail]),
    shipAddress2: "",
    shipCity: normalizeFieldText(first[GIGA_FIELDS.shipToCity]),
    shipState: normalizeFieldText(first[GIGA_FIELDS.shipToState]),
    shipCountry: normalizeFieldText(first[GIGA_FIELDS.shipToCountry]) || "JP",
    shipZipCode: normalizeFieldText(first[GIGA_FIELDS.shipToPostalCode]),
    salesChannel: resolveOutboundSalesChannel(platform),
    orderFrom,
    customerComments: normalizeMultilineText(first[GIGA_FIELDS.orderComments]),
    hasOtherLabel: false,
    orderLines: deduped.lines,
  };
  const requestedDeliveryDate = normalizeFieldText(first[GIGA_FIELDS.requestedDeliveryDate]);
  if (requestedDeliveryDate) payload.shippedDate = requestedDeliveryDate;
  const validationErrors = validateDryRunPayload(payload);
  if (orderFromError) validationErrors.push(orderFromError);
  // Warn if shipFrom was truncated for GigaB2B 16-char limit (informational — not a blocker)
  const warnings = [];
  const rawShipFrom = normalizeFieldText(first[GIGA_FIELDS.shipFrom]);
  if (rawShipFrom.length > 16) {
    warnings.push(`shipFrom_truncated:${rawShipFrom.length}>16:${rawShipFrom.slice(0, 16)}`);
  }
  return {
    order_id: group.orderId,
    platform,
    store_id: storeId,
    source_row_ids: deduped.sourceRowIds,
    duplicate_source_row_ids: deduped.duplicateRowIds.length ? deduped.duplicateRowIds : undefined,
    line_count: rows.length,
    deduped_line_count: deduped.lines.length,
    validationErrors,
    warnings,
    payload,
  };
}

/**
 * Deduplicate shipment rows into GigaB2B orderLines, source-line aware.
 *
 * Grouping key: (sourceStoreId, SKU, lineItemNumber).
 *
 * - Same (store, SKU, lineItemNumber) → duplicate logical line → use max(qty).
 *   Log duplicate row IDs for investigation.
 * - Same (store, SKU) but different lineItemNumber → distinct purchases of the
 *   same SKU → sum quantities.
 * - Missing lineItemNumber → conservative max(qty) with a warning; never sum
 *   unknown line identity.
 *
 * Returns { lines, sourceRowIds, duplicateRowIds }.
 */
function dedupeOrderLines(rows, orderIdLabel) {
  // Group by (sourceStoreId, SKU, lineItemNumber)
  const groups = new Map();
  for (const row of rows) {
    const storeId = normalizeFieldText(row[GIGA_FIELDS.sourceStoreId]);
    const sku = normalizeFieldText(row[GIGA_FIELDS.b2bItemCode]);
    const lineNo = normalizeFieldText(row[GIGA_FIELDS.lineItemNumber]);
    const key = `${storeId}::${sku}::${lineNo || "__missing__"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Second-level grouping: merge groups that differ only by missing lineItemNumber
  // within the same (storeId, SKU) scope.
  const scopeGroups = new Map(); // key: storeId::SKU → Map<lineItemNumber, rows[]>
  for (const [key, groupRows] of groups) {
    const parts = key.split("::");
    const storeId = parts[0];
    const sku = parts[1];
    const lineNo = parts.slice(2).join("::"); // restore in case SKU contains ::
    const scopeKey = `${storeId}::${sku}`;
    if (!scopeGroups.has(scopeKey)) scopeGroups.set(scopeKey, new Map());
    scopeGroups.get(scopeKey).set(lineNo, groupRows);
  }

  const lines = [];
  const allRowIds = [];
  const duplicateRowIds = [];

  for (const [scopeKey, lineMap] of scopeGroups) {
    const parts = scopeKey.split("::");
    const storeId = parts[0];
    const sku = parts.slice(1).join("::");
    const lineNumbers = Array.from(lineMap.keys());
    const hasMissing = lineNumbers.includes("__missing__");
    const knownLines = lineNumbers.filter((ln) => ln !== "__missing__");
    const totalKnownLines = knownLines.length;

    if (totalKnownLines === 0) {
      // All rows have missing lineItemNumber — conservative, use max(qty)
      const allRows = [];
      for (const groupRows of lineMap.values()) allRows.push(...groupRows);
      const maxQty = Math.max(...allRows.map((r) => normalizePositiveInteger(r[GIGA_FIELDS.shipToQty]) || 0));
      const canonicalRow = allRows[0];
      if (allRows.length > 1) {
        console.warn(JSON.stringify({
          warning: "outbound_dedup_missing_line_number_conservative_max",
          order_id: orderIdLabel,
          store_id: storeId,
          sku,
          row_count: allRows.length,
          max_qty: maxQty,
          duplicate_row_ids: allRows.slice(1).map((r) => normalizeRowId(r.id)).filter(Boolean),
        }));
        for (let i = 1; i < allRows.length; i++) {
          duplicateRowIds.push(normalizeRowId(allRows[i].id));
        }
      }
      lines.push({
        sku,
        qty: maxQty || 1,
        itemPrice: normalizeDecimal(canonicalRow[GIGA_FIELDS.buyerSkuCommercialValue]),
        productName: normalizeFieldText(canonicalRow[GIGA_FIELDS.buyerSkuDescription]),
      });
      allRowIds.push(normalizeRowId(canonicalRow.id));
      continue;
    }

    if (totalKnownLines === 1 && !hasMissing) {
      // Single known lineItemNumber — use max(qty) for safety
      const groupRows = lineMap.get(knownLines[0]);
      const maxQty = Math.max(...groupRows.map((r) => normalizePositiveInteger(r[GIGA_FIELDS.shipToQty]) || 0));
      const canonicalRow = groupRows[0];
      if (groupRows.length > 1) {
        console.warn(JSON.stringify({
          warning: "outbound_dedup_duplicate_logical_line",
          order_id: orderIdLabel,
          store_id: storeId,
          sku,
          line_item_number: knownLines[0],
          row_count: groupRows.length,
          max_qty: maxQty,
          duplicate_row_ids: groupRows.slice(1).map((r) => normalizeRowId(r.id)).filter(Boolean),
        }));
        for (let i = 1; i < groupRows.length; i++) {
          duplicateRowIds.push(normalizeRowId(groupRows[i].id));
        }
      }
      lines.push({
        sku,
        qty: maxQty || 1,
        itemPrice: normalizeDecimal(canonicalRow[GIGA_FIELDS.buyerSkuCommercialValue]),
        productName: normalizeFieldText(canonicalRow[GIGA_FIELDS.buyerSkuDescription]),
      });
      allRowIds.push(normalizeRowId(canonicalRow.id));
      continue;
    }

    // Multiple distinct lineItemNumbers → sum quantities, each is a distinct purchase
    let sumQty = 0;
    const canonicalRow = lineMap.get(knownLines[0])[0];
    for (const lineNo of knownLines) {
      const groupRows = lineMap.get(lineNo);
      const maxQty = Math.max(...groupRows.map((r) => normalizePositiveInteger(r[GIGA_FIELDS.shipToQty]) || 0));
      sumQty += maxQty;
      for (const row of groupRows) {
        allRowIds.push(normalizeRowId(row.id));
        if (groupRows.length > 1 && row !== groupRows[0]) {
          duplicateRowIds.push(normalizeRowId(row.id));
        }
      }
    }
    lines.push({
      sku,
      qty: sumQty || 1,
      itemPrice: normalizeDecimal(canonicalRow[GIGA_FIELDS.buyerSkuCommercialValue]),
      productName: normalizeFieldText(canonicalRow[GIGA_FIELDS.buyerSkuDescription]),
    });
  }

  return {
    lines,
    sourceRowIds: allRowIds.filter(Boolean),
    duplicateRowIds: duplicateRowIds.filter(Boolean),
  };
}

function normalizeRowId(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return normalized;
}

function validateDryRunPayload(payload) {
  const errors = [];
  if (!trimAndCollapse(payload.orderNo)) errors.push("missing_orderNo");
  if (!trimAndCollapse(payload.orderDate)) errors.push("missing_orderDate");
  if (!trimAndCollapse(payload.shipName)) errors.push("missing_shipName");
  if (!trimAndCollapse(payload.shipPhone)) errors.push("missing_shipPhone");
  if (!trimAndCollapse(payload.shipAddress1)) errors.push("missing_shipAddress1");
  if (!trimAndCollapse(payload.shipCity)) errors.push("missing_shipCity");
  if (!trimAndCollapse(payload.shipState)) errors.push("missing_shipState");
  if (!trimAndCollapse(payload.shipCountry)) errors.push("missing_shipCountry");
  if (!trimAndCollapse(payload.shipZipCode)) errors.push("missing_shipZipCode");
  if (!Array.isArray(payload.orderLines) || payload.orderLines.length === 0) errors.push("missing_orderLines");
  for (const [index, line] of (payload.orderLines || []).entries()) {
    if (!trimAndCollapse(line.sku)) errors.push(`line_${index + 1}_missing_sku`);
    if (!normalizePositiveInteger(line.qty)) errors.push(`line_${index + 1}_invalid_qty`);
    if (normalizeDecimal(line.itemPrice) == null || normalizeDecimal(line.itemPrice) <= 0) errors.push(`line_${index + 1}_invalid_itemPrice`);
  }
  if (payload.shippedDate && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}-\d{2}:\d{2}$/.test(payload.shippedDate)) {
    errors.push(`invalid_shippedDate_format:${payload.shippedDate}`);
  }
  return errors;
}

function matchesScope(row, platform, storeId) {
  return normalizeFieldText(row[GIGA_FIELDS.salesChannel]) === platform
    && normalizeFieldText(row[GIGA_FIELDS.sourceStoreId]) === storeId;
}

function shouldSkipFeeRow(row) {
  const productName = normalizeFieldText(row[GIGA_FIELDS.buyerSkuDescription]);
  return productName.includes("各種手数料") || productName === "追加支払い・追加送料専用";
}

function shouldProcessRow(row, nowMs, retryAfterMinutes) {
  const status = readSelectValue(row[GIGA_FIELDS.gigaSyncStatus]);
  if (!status) return true;
  if (statusEquals(status, OPTION.GIGA_SYNC_STATUS.PENDING)) return true;
  if (statusEquals(status, GIGA_SYNC_STATUS.ERROR) || statusEquals(status, GIGA_SYNC_STATUS.INVALID)) return true;
  if (statusEquals(status, GIGA_SYNC_STATUS.ATTEMPTED)) {
    const attemptedAtMs = parseTimestamp(row[GIGA_FIELDS.gigaSyncAttemptedAt]);
    if (!Number.isFinite(attemptedAtMs)) return true;
    return attemptedAtMs <= (nowMs - (retryAfterMinutes * 60 * 1000));
  }
  return false;
}

function groupRowsByOrderId(rows) {
  const map = new Map();
  for (const row of rows) {
    const orderId = normalizeOrderId(row[GIGA_FIELDS.orderId]);
    if (!orderId) continue;
    if (!map.has(orderId)) map.set(orderId, { orderId, rows: [] });
    map.get(orderId).rows.push(row);
  }
  return map;
}

function compareLineRows(left, right) {
  const leftNo = normalizePositiveInteger(left && left[GIGA_FIELDS.lineItemNumber]) || 999999;
  const rightNo = normalizePositiveInteger(right && right[GIGA_FIELDS.lineItemNumber]) || 999999;
  if (leftNo !== rightNo) return leftNo - rightNo;
  return (Number(left && left.id) || 0) - (Number(right && right.id) || 0);
}

function resolveOutboundSalesChannel(platform) {
  const normalized = trimAndCollapse(platform);
  if (!normalized) return "Other";
  return GIGA_ALLOWED_SALES_CHANNELS.has(normalized) ? normalized : "Other";
}

function resolveOutboundOrderFrom(shipFrom, sourceStoreId) {
  const storeId = normalizeFieldText(sourceStoreId);
  if (!storeId) {
    // For Rakuten/other platforms that may not have a Mercari shop ID,
    // fall back to the ShipFrom value
    const sf = normalizeFieldText(shipFrom);
    if (sf) return truncateOrderFrom(sf);
    throw new Error("Missing sourceStoreId for outbound sync");
  }
  // For known Mercari shop IDs, use the Mercari shop name mapping
  try {
    return getMercariShopOrderFromName(storeId);
  } catch {
    // For non-Mercari stores (Rakuten, Amazon), return the ShipFrom or storeId
    return truncateOrderFrom(normalizeFieldText(shipFrom) || storeId);
  }
}

/**
 * Truncate orderFrom to GigaB2B's 16-character limit (error B11002).
 * The Rakuten projector should be fixed to use a 16-char shipFrom at source.
 */
function truncateOrderFrom(value) {
  if (value.length > 16) return value.slice(0, 16);
  return value;
}

function buildCursorKey(platform, storeId) {
  return `giga_b2b_sync::${String(platform || "").toLowerCase()}::${String(storeId || "")}`;
}

function buildWarnings(platform) {
  const warnings = [];
  if (resolveOutboundSalesChannel(platform) === "Other" && platform !== "Other") warnings.push(`sales_channel_normalized_to_other:${platform}`);
  return warnings;
}

function detectAvailableProgressFields(rows) {
  const fields = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) fields.add(key);
  }
  return fields;
}

async function updateRowsProgress(client, rowIds, availableFields, patch) {
  const safePatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (availableFields.has(key)) safePatch[key] = value;
  }
  if (!Object.keys(safePatch).length) return;
  for (const rowId of rowIds) {
    const res = await patchRow(client, client.shipmentOrderTableId, rowId, safePatch);
    if (!res.ok) {
      throw new Error(`baserow_progress_patch_failed:${rowId}:${res.error || res.status}`);
    }
  }
}

function normalizeOrderId(value) {
  return trimAndCollapse(value);
}

function normalizePositiveInteger(value) {
  const raw = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

function normalizeDecimal(value) {
  const raw = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(raw) ? raw : null;
}

function normalizeDateTimeText(value) {
  const raw = normalizeFieldText(value);
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function parseTimestamp(value) {
  const raw = normalizeFieldText(value);
  if (!raw) return NaN;
  return Date.parse(raw);
}

function normalizeMultilineText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function normalizeFieldText(value) {
  if (value == null) return "";
  if (typeof value === "string") return trimAndCollapse(value);
  if (typeof value === "number" || typeof value === "boolean") return trimAndCollapse(String(value));
  if (Array.isArray(value)) return value.length ? normalizeFieldText(value[0]) : "";
  if (typeof value === "object") {
    for (const key of ["value", "name", "label", "text", "displayName"]) {
      if (typeof value[key] === "string" && trimAndCollapse(value[key])) return trimAndCollapse(value[key]);
    }
    return "";
  }
  return trimAndCollapse(String(value));
}

function trimAndCollapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Exported for tests (not part of the public API surface)
export { dedupeOrderLines, shouldProcessRow, resolveOutboundOrderFrom };
