#!/usr/bin/env node

import fs from "node:fs";
import { createBaserowClient, deleteRow, listAllRows, patchRow } from "../src/lib/baserow.mjs";
import { getMercariShopName } from "../src/lib/mercari-shops.mjs";

const ENV_PATH = process.env.MERCARI_BASEROW_ENV_PATH || "/Users/user/Documents/April 2026/.env";

loadEnvFile(ENV_PATH);

const client = createBaserowClient(process.env);
const SHIPMENT_FIELDS = {
  orderId: "OrderId",
  lineItemNumber: "LineItemNumber",
  buyerPlatformSku: "BuyerPlatformSku",
  b2bItemCode: "B2BItemCode",
  sourceStoreId: "SourceStoreID",
  shipFrom: "ShipFrom",
};

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const rows = await listAllRows(client, client.shipmentOrderTableId);
  const grouped = new Map();
  for (const row of rows) {
    const key = canonicalKey(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const summary = {
    ok: true,
    rows_loaded: rows.length,
    duplicate_groups: 0,
    patched: 0,
    deleted: 0,
    ship_from_repaired: 0,
    results: [],
  };

  for (const [key, group] of grouped.entries()) {
    if (group.length <= 1) continue;
    summary.duplicate_groups += 1;
    const canonical = chooseCanonical(group);
    const desiredPatch = buildRepairPatch(canonical, group);
    if (Object.keys(desiredPatch).length > 0) {
      const patchResult = await patchRow(client, client.shipmentOrderTableId, canonical.id, desiredPatch);
      if (!patchResult.ok) throw new Error(patchResult.error || `repair_patch_failed_${canonical.id}`);
      Object.assign(canonical, desiredPatch);
      summary.patched += 1;
    }
    for (const row of group) {
      if (Number(row.id) === Number(canonical.id)) continue;
      const deleteResult = await deleteRow(client, client.shipmentOrderTableId, row.id);
      if (!deleteResult.ok) throw new Error(deleteResult.error || `repair_delete_failed_${row.id}`);
      summary.deleted += 1;
      summary.results.push({
        key,
        action: "deleted_duplicate",
        deleted_row_id: Number(row.id),
        canonical_row_id: Number(canonical.id),
      });
    }
  }

  for (const row of rows) {
    const sourceStoreId = text(row && row[SHIPMENT_FIELDS.sourceStoreId]);
    if (!sourceStoreId) continue;
    const desiredShipFrom = getMercariShopName(sourceStoreId);
    const currentShipFrom = text(row && row[SHIPMENT_FIELDS.shipFrom]);
    if (currentShipFrom === desiredShipFrom) continue;
    const patchResult = await patchRow(client, client.shipmentOrderTableId, row.id, { [SHIPMENT_FIELDS.shipFrom]: desiredShipFrom });
    if (!patchResult.ok) throw new Error(patchResult.error || `repair_ship_from_failed_${row.id}`);
    summary.ship_from_repaired += 1;
    summary.results.push({
      key: canonicalKey(row),
      action: "patched_ship_from",
      row_id: Number(row.id),
      previous_ship_from: currentShipFrom || null,
      ship_from: desiredShipFrom,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

function canonicalKey(row) {
  const orderId = normalizeOrderId(row && row[SHIPMENT_FIELDS.orderId]);
  const sku = text(row && (row[SHIPMENT_FIELDS.buyerPlatformSku] || row[SHIPMENT_FIELDS.b2bItemCode]));
  const line = text(row && row[SHIPMENT_FIELDS.lineItemNumber]) || "1";
  if (!orderId) return "";
  return `${orderId}::${sku}::${line}`;
}

function chooseCanonical(rows) {
  return rows
    .slice()
    .sort((left, right) => scoreRow(right) - scoreRow(left) || Number(left.id) - Number(right.id))[0];
}

function scoreRow(row) {
  let score = 0;
  if (text(row && row[SHIPMENT_FIELDS.sourceStoreId])) score += 10;
  if (text(row && row[SHIPMENT_FIELDS.shipFrom])) score += 3;
  if (text(row && row[SHIPMENT_FIELDS.buyerPlatformSku])) score += 2;
  if (text(row && row[SHIPMENT_FIELDS.b2bItemCode])) score += 1;
  return score;
}

function buildRepairPatch(canonical, group) {
  const patch = {};
  if (!text(canonical && canonical[SHIPMENT_FIELDS.sourceStoreId])) {
    const filled = group.map((row) => text(row && row[SHIPMENT_FIELDS.sourceStoreId])).find(Boolean);
    if (filled) patch[SHIPMENT_FIELDS.sourceStoreId] = filled;
  }
  const sourceStoreId = text(patch[SHIPMENT_FIELDS.sourceStoreId] || (canonical && canonical[SHIPMENT_FIELDS.sourceStoreId]));
  if (sourceStoreId) {
    const desiredShipFrom = getMercariShopName(sourceStoreId);
    const currentShipFrom = text(canonical && canonical[SHIPMENT_FIELDS.shipFrom]);
    if (!currentShipFrom || currentShipFrom === "Mercari" || currentShipFrom !== desiredShipFrom) {
      patch[SHIPMENT_FIELDS.shipFrom] = desiredShipFrom;
    }
  }
  return patch;
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function text(value) {
  return String(value ?? "").trim();
}

function loadEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = normalizeEnvKey(trimmed.slice(0, idx).trim());
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function normalizeEnvKey(key) {
  const normalized = String(key || "").trim();
  if (normalized === "Baserow base URL") return "BASEROW_BASE_URL";
  if (normalized === "Baserow database token") return "BASEROW_DATABASE_TOKEN";
  return normalized;
}
