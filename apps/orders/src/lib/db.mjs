// Database backend facade.
//
// Backend selection must happen from the runtime env object, not only from
// process.env at module load. Cloudflare Workers provide vars on `env`, while
// local CLI scripts usually use process.env.

import * as baserow from "./baserow.mjs";
import * as supabase from "./supabase.mjs";

export { FIELD, OPTION, BASEROW_FIELD, BASEROW_OPTION } from "./db-fields.mjs";

function backendNameFromEnv(env) {
  return String(
    env?.DATABASE_BACKEND ??
    (typeof process !== "undefined" ? process.env?.DATABASE_BACKEND : "") ??
    "baserow",
  ).trim().toLowerCase();
}

function backendForName(name) {
  return name === "supabase" ? supabase : baserow;
}

function backendForClient(client) {
  return client?.type === "supabase" ? supabase : baserow;
}

export function createBaserowClient(env = {}) {
  return backendForName(backendNameFromEnv(env)).createBaserowClient(env);
}

export function clientForRakuten(client) {
  return backendForClient(client).clientForRakuten(client);
}

export function listAllRows(client, tableId, filterParams = {}, options = {}) {
  return backendForClient(client).listAllRows(client, tableId, filterParams, options);
}

export function listRowsWithLimit(client, tableId, filterParams = {}, maxRows = 100, options = {}) {
  return backendForClient(client).listRowsWithLimit(client, tableId, filterParams, maxRows, options);
}

export function patchRow(client, tableId, rowId, payload, options = {}) {
  return backendForClient(client).patchRow(client, tableId, rowId, payload, options);
}

export function createRow(client, tableId, payload) {
  return backendForClient(client).createRow(client, tableId, payload);
}

export function deleteRow(client, tableId, rowId) {
  return backendForClient(client).deleteRow(client, tableId, rowId);
}

export function setOrderReviewStatusViaRpc(client, params) {
  return supabase.setOrderReviewStatusViaRpc(client, params);
}

/**
 * Resolve product data for B2B item codes. Only supported on the Supabase
 * backend (Baserow product resolution uses the legacy path in product-resolver.mjs).
 *
 * @param {Object} client — from createBaserowClient()
 * @param {string[]} itemCodes
 * @returns {Promise<Map<string, Object>>} Map<itemCode, productRow>
 */
export function resolveProductsByItemCodes(client, itemCodes) {
  if (client?.type !== "supabase") {
    throw new Error("resolveProductsByItemCodes requires DATABASE_BACKEND=supabase");
  }
  return supabase.resolveProductsByItemCodes(client, itemCodes);
}

/**
 * Return hardcoded product field metadata for the Supabase backend.
 *
 * @returns {Object} field metadata with itemCodeFieldId, effectiveTcogsFieldId, etc.
 */
export function getSupabaseProductFields() {
  return supabase.getSupabaseProductFields();
}

// Re-export adapter utilities for modules that need column allow-list awareness.
export { validateExpectedFields, SALES_COLUMNS } from "./supabase.mjs";
