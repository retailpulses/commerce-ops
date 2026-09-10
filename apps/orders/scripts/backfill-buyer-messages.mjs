#!/usr/bin/env node

/**
 * scripts/backfill-buyer-messages.mjs
 *
 * Backfill buyer-message state from Baserow (source of truth) to Supabase
 * for orders that had messages before the cutover.
 *
 * Reads all Mercari sales rows from Baserow where has_buyer_messages=true,
 * matches them to Supabase sales_orders by (order_id, source_store_id, sales_channel='mercari'),
 * and patches the message state fields.
 *
 * Usage:
 *   export BASEROW_DATABASE_TOKEN=...
 *   export BASEROW_API_BASE=https://api.baserow.io/api
 *   export BASEROW_MERCARI_SALES_ORDER_TABLE_ID=903318
 *   export SUPABASE_URL=https://xxxxx.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=...
 *
 *   node scripts/backfill-buyer-messages.mjs [--dry-run=false] [--limit 50] [--verbose]
 *
 * CLI flags:
 *   --dry-run=true|false   Show what would be updated without writing (default: true)
 *   --limit N              Max rows to process (0 = no limit, default: 0)
 *   --verbose              Show per-row details
 */

import { parseArgs } from "node:util";
import { createBaserowClient as createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";
import { createBaserowClient as createSupabaseClient, patchRow } from "../src/lib/supabase.mjs";

// ============================================================================
// CLI arg parsing
// ============================================================================

const { values: cli } = parseArgs({
  options: {
    "dry-run": { type: "string", default: "true" },
    limit:     { type: "string", default: "0" },
    verbose:   { type: "boolean", short: "v", default: false },
  },
});

function parseBooleanOption(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

const DRY_RUN    = parseBooleanOption(cli["dry-run"], true);
const LIMIT      = (() => { const v = parseInt(cli.limit ?? "0", 10); return Number.isFinite(v) ? Math.max(0, v) : 0; })();
const VERBOSE    = cli.verbose === true;

// ============================================================================
// Helpers
// ============================================================================

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function toTimestamp(raw) {
  if (!raw || raw === "") return null;
  const str = typeof raw === "object" ? (raw.value || raw.text || String(raw)) : String(raw).trim();
  if (!str) return null;
  const d = new Date(str);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toBoolean(raw) {
  if (raw == null) return false;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// ============================================================================
// Main backfill logic
// ============================================================================

async function backfill() {
  console.log("=".repeat(72));
  console.log("Buyer Message Backfill: Baserow → Supabase");
  console.log("=".repeat(72));
  console.log();

  // Validate required env vars
  const env = process.env;
  const requiredVars = [
    "BASEROW_DATABASE_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = requiredVars.filter((v) => !env[v]);
  if (missing.length) {
    console.error("ERROR: Missing required env vars:", missing.join(", "));
    console.error("  Required: BASEROW_DATABASE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log(`  Dry run:  ${DRY_RUN}`);
  console.log(`  Limit:    ${LIMIT > 0 ? LIMIT : "no limit"}`);
  console.log(`  Verbose:  ${VERBOSE}`);
  console.log();

  // Initialize clients
  const baserow = createBaserowClient(env);
  const supabaseClient = createSupabaseClient(env);
  const supabase = supabaseClient.supabase;

  console.log("Backends initialized:");
  console.log(`  Baserow:  ${baserow.apiBase}`);
  console.log(`  Table ID: ${baserow.salesOrderTableId}`);
  console.log(`  Supabase: ${supabaseClient.url}`);
  console.log();

  // ============================================================================
  // Step 1: Read ALL Mercari sales rows from Baserow
  // ============================================================================
  // Baserow queried with user_field_names=true, so field names are the
  // human-readable snake_case keys like has_buyer_messages, shop_id, etc.
  // We read all rows and filter client-side since the has_buyer_messages
  // field is not registered in the FIELD_NAME_TO_ID translation map.

  console.log("Reading all Mercari sales rows from Baserow...");
  let allBaserowRows;
  try {
    allBaserowRows = await listAllRows(baserow, baserow.salesOrderTableId);
  } catch (err) {
    console.error("ERROR reading Baserow sales rows:", err.message);
    process.exit(1);
  }
  console.log(`  Read ${allBaserowRows.length} rows total`);

  // Filter for rows with has_buyer_messages=true
  const rowsWithMessages = allBaserowRows.filter(
    (row) => toBoolean(row.has_buyer_messages),
  );
  console.log(`  Rows with has_buyer_messages=true: ${rowsWithMessages.length}`);

  if (rowsWithMessages.length === 0) {
    console.log("No rows to backfill. Exiting.");
    return;
  }

  // Apply --limit
  const limitedRows = LIMIT > 0 ? rowsWithMessages.slice(0, LIMIT) : rowsWithMessages;
  if (limitedRows.length < rowsWithMessages.length) {
    console.log(`  Processing first ${limitedRows.length} rows (--limit=${LIMIT})`);
  }

  // ============================================================================
  // Step 2: Load Supabase sales_orders lookup map
  // ============================================================================
  // Key: "orderId::sourceStoreId" → Supabase UUID
  // Only load Mercari rows for matching.

  console.log();
  console.log("Loading Supabase sales_orders for matching...");
  const supabaseRows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("sales_orders")
      .select("id, order_id, source_store_id")
      .eq("sales_channel", "mercari")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("ERROR loading Supabase sales_orders:", error.message);
      process.exit(1);
    }
    supabaseRows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  const supabaseLookup = new Map();
  for (const row of supabaseRows || []) {
    const key = `${normalizeOrderId(row.order_id)}::${text(row.source_store_id)}`;
    supabaseLookup.set(key, row);
  }
  console.log(`  Loaded ${supabaseLookup.size} Mercari rows`);

  const stateLookup = new Map();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("sales_order_message_state")
      .select("source_store_id, order_transaction_id, last_read_message_id")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("ERROR loading Supabase message state:", error.message);
      process.exit(1);
    }
    for (const row of data || []) {
      stateLookup.set(
        `${text(row.source_store_id)}::${normalizeOrderId(row.order_transaction_id)}`,
        text(row.last_read_message_id),
      );
    }
    if (!data || data.length < pageSize) break;
  }

  // ============================================================================
  // Step 3: Match and patch
  // ============================================================================
  // Baserow uses shop_id (human-readable with user_field_names=true), which
  // maps to source_store_id in Supabase (see SALES_ALIASES in supabase.mjs).
  // Matching key: (order_id, source_store_id, sales_channel='mercari').
  //
  // The patchRow adapter from supabase.mjs calls toDatabasePayload() internally,
  // which translates field names via SALES_ALIASES:
  //   has_buyer_messages       → has_unread_messages
  //   latest_buyer_message_at  → last_message_at
  //   latest_buyer_message_id  → latest_buyer_message_id  (same name, no alias)
  //   message_last_synced_at   → message_last_synced_at   (same name, no alias)
  // And filters through SALES_COLUMNS so only valid columns are included.

  console.log();
  console.log("Processing rows...");

  const results = {
    total_checked: limitedRows.length,
    matched: 0,
    updated: 0,
    unmatched: 0,
    errors: 0,
  };

  for (const baserowRow of limitedRows) {
    const orderId = normalizeOrderId(baserowRow.order_id);
    // Baserow stores the store/shop identifier in the shop_id field
    // (user_field_names=true exposes it as shop_id).
    const sourceStoreId = text(baserowRow.shop_id) || text(baserowRow.source_store_id);
    const key = `${orderId}::${sourceStoreId}`;
    const supabaseRow = supabaseLookup.get(key);

    if (!supabaseRow) {
      results.unmatched++;
      if (VERBOSE) {
        console.warn(`  UNMATCHED: order_id=${orderId}, source_store_id=${sourceStoreId}`);
      }
      continue;
    }

    results.matched++;

    // Build the payload using Baserow field names (which match the alias keys
    // in SALES_ALIASES so toDatabasePayload() translates them correctly).
    const payload = {};
    payload.has_buyer_messages = toBoolean(baserowRow.has_buyer_messages);
    payload.latest_buyer_message_at = toTimestamp(baserowRow.latest_buyer_message_at);
    payload.latest_buyer_message_id = baserowRow.latest_buyer_message_id != null
      ? String(baserowRow.latest_buyer_message_id).trim() || null
      : null;
    payload.message_last_synced_at = toTimestamp(baserowRow.message_last_synced_at);

    if (DRY_RUN) {
      results.updated++;
      if (VERBOSE) {
        console.log(`  [DRY RUN] Would update row ${supabaseRow.id}:`);
        console.log(`    order_id=${orderId}, source_store_id=${sourceStoreId}`);
        console.log(`    payload:`, JSON.stringify(payload, null, 4));
      }
    } else {
      // patchRow from supabase.mjs handles alias translation and column filtering
      const result = await patchRow(supabaseClient, "sales_orders", supabaseRow.id, payload);
      if (result.ok) {
        const latestMessageId = payload.latest_buyer_message_id || "";
        const lastReadMessageId = stateLookup.get(`${sourceStoreId}::${orderId}`) || "";
        const { error: stateError } = await supabase
          .from("sales_order_message_state")
          .upsert({
            sales_order_id: supabaseRow.id,
            source_store_id: sourceStoreId,
            order_transaction_id: orderId,
            latest_message_id: latestMessageId || null,
            latest_message_at: payload.latest_buyer_message_at,
            has_unread: Boolean(latestMessageId) && latestMessageId !== lastReadMessageId,
            last_checked_at: payload.message_last_synced_at,
            last_check_status: "ok",
            last_check_error: null,
          }, { onConflict: "source_store_id,order_transaction_id" });
        if (stateError) {
          results.errors++;
          console.error(`  ERROR upserting state for ${supabaseRow.id} (order_id=${orderId}): ${stateError.message}`);
        } else {
          results.updated++;
          if (VERBOSE) {
            console.log(`  UPDATED: ${supabaseRow.id} (order_id=${orderId})`);
          }
        }
      } else {
        results.errors++;
        console.error(`  ERROR patching ${supabaseRow.id} (order_id=${orderId}): ${result.error}`);
      }
    }
  }

  // ============================================================================
  // Step 4: Summary
  // ============================================================================

  console.log();
  console.log("=".repeat(72));
  console.log(DRY_RUN ? "DRY RUN Summary" : "Backfill Summary");
  console.log("=".repeat(72));
  console.log();
  console.log(`  Total checked:   ${results.total_checked}`);
  console.log(`  Matched:         ${results.matched}`);
  console.log(`  Updated:         ${results.updated}`);
  console.log(`  Unmatched:       ${results.unmatched}`);
  console.log(`  Errors:          ${results.errors}`);
  console.log();

  if (DRY_RUN) {
    console.log("DRY RUN completed -- no data was written to Supabase.");
    console.log("Run with --dry-run=false to write.");
  } else {
    console.log("Backfill completed.");
    if (results.unmatched > 0) {
      console.log(`  ${results.unmatched} Baserow row(s) had no matching Supabase row.`);
      console.log("  These may be orders that were ingested before the Supabase cutover");
      console.log("  and were not migrated, or their order_id/source_store_id differs.");
    }
    if (results.errors > 0) {
      console.log(`  ${results.errors} error(s) occurred. Review the details above.`);
    }
  }
  console.log();
  console.log("Done.");
}

// ============================================================================
// Execute
// ============================================================================

backfill().catch((err) => {
  console.error("FATAL:", err && err.message ? err.message : String(err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
