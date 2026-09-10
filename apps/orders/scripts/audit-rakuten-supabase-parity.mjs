#!/usr/bin/env node
/**
 * Read-only Baserow vs Supabase parity audit for Rakuten orders.
 *
 * Compares legacy Baserow Rakuten rows against Supabase Rakuten rows by
 * normalized order_id. Produces categorized diff artifacts.
 *
 * THIS SCRIPT IS READ-ONLY. It does not write, delete, or remediate any data.
 * Review the output before executing any separately approved remediation.
 *
 * Usage:
 *   # Full audit (reads both backends):
 *   BASEROW_DATABASE_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/audit-rakuten-supabase-parity.mjs
 *
 *   # Dry-run (structure check only):
 *   node scripts/audit-rakuten-supabase-parity.mjs --dry-run
 *
 *   # Limit rows for testing:
 *   node scripts/audit-rakuten-supabase-parity.mjs --limit 10
 *
 * Output:
 *   outputs/rakuten-supabase-parity/<timestamp>/
 *     summary.json          — aggregate counts
 *     row-diff.csv          — per-row comparison
 *     prewrite-snapshot.json — raw data snapshot (no PII in logs)
 *     proposed-remediation.json — suggested actions (review before applying)
 *     README.md             — operator instructions
 */

import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ============================================================================
// Config
// ============================================================================

const OWNED_COMPARISON_FIELDS = [
  "order_id", "order_status", "purchase_date", "product_name",
  "manage_number", "b2b_item_code", "quantity", "product_price",
  "shipping_name", "shipping_postal_code", "shipping_state",
  "shipping_city", "shipping_address_1", "shipping_phone_number",
  "confirm_in_progress",
  "last_synced_at", "sync_error",
  "rms_confirm_result", "rms_confirmed_at",
  "rms_close_result", "rms_close_completed_at",
];

const PII_FIELDS = new Set([
  "shipping_name", "shipping_phone_number", "shipping_address_1",
  "shipping_address_2", "shipping_postal_code",
  "shipping_city", "shipping_state",
]);

const PAGE_SIZE = 1000;

// Missing lifecycle fields gated by order_status.
// Empty Set = expected for ALL statuses.
// Export so tests can verify state-appropriate requirements.
const LIFECYCLE_STATE_GATES = {
  last_synced_at: new Set(),  // expected for ALL orders
  rms_confirm_result: new Set(["RMS_CONFIRMED", "COMPLETED"]),
  rms_confirmed_at: new Set(["RMS_CONFIRMED", "COMPLETED"]),
  rms_close_result: new Set(["COMPLETED"]),
  rms_close_completed_at: new Set(["COMPLETED"]),
};

// ============================================================================
// CLI arg parsing
// ============================================================================

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a, i) => a === "--limit" && i + 1 < args.length);
const limit = limitArg ? parseInt(args[args.indexOf("--limit") + 1], 10) : 0;

function log(...msg) {
  console.log(`[audit] ${msg.join(" ")}`);
}

function maskPii(value, field) {
  if (value == null || value === "") return value;
  if (!PII_FIELDS.has(field)) return value;
  const s = String(value);
  if (s.length <= 3) return "***";
  return s.slice(0, 2) + "***" + s.slice(-1);
}

// ============================================================================
// Data loading
// ============================================================================

async function loadBaserowRakutenRows() {
  const token = process.env.BASEROW_DATABASE_TOKEN;
  if (!token) {
    throw new Error("BASEROW_DATABASE_TOKEN not set — cannot audit Baserow");
  }

  // Use Baserow API directly for the legacy Rakuten table
  const baserowApiBase = process.env.BASEROW_API_BASE || "https://api.baserow.io";
  const rakutenTableId = process.env.BASEROW_RAKUTEN_TABLE_ID || "";
  if (!rakutenTableId) {
    throw new Error("BASEROW_RAKUTEN_TABLE_ID not set — cannot audit Baserow");
  }

  log(`Loading Baserow Rakuten rows (table ${rakutenTableId})...`);
  const rows = [];
  let page = 1;
  const pageSize = 200; // Baserow max page size

  while (true) {
    const url = `${baserowApiBase}/api/database/rows/table/${rakutenTableId}/?user_field_names=true&size=${pageSize}&page=${page}`;
    const response = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Baserow API error (page ${page}): ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    rows.push(...results);

    log(`  page ${page}: ${results.length} rows (total: ${rows.length})`);
    if (results.length < pageSize) break;
    if (limit > 0 && rows.length >= limit) break;
    page += 1;
  }

  return limit > 0 ? rows.slice(0, limit) : rows;
}

async function loadSupabaseRakutenRows() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — cannot audit Supabase");
  }

  // Dynamic import to avoid Node 18 WebSocket issues
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, { realtime: { enabled: false } });

  log("Loading Supabase Rakuten rows...");
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("sales_orders")
      .select("*")
      .eq("sales_channel", "rakuten")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);

    log(`  offset ${from}: ${page.length} rows (total: ${rows.length})`);
    if (page.length < PAGE_SIZE) break;
    if (limit > 0 && rows.length >= limit) break;
    from += PAGE_SIZE;
  }

  return limit > 0 ? rows.slice(0, limit) : rows;
}

// ============================================================================
// Normalization
// ============================================================================

function normalizeOrderId(value) {
  return String(value ?? "").trim().replace(/^order[_-\s]*/i, "");
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizeRow(row, source) {
  const rawOrderId = row.order_id || row.OrderId || row.orderId || "";
  const orderId = normalizeOrderId(rawOrderId);

  const normalized = { _source: source, _raw_order_id: rawOrderId, order_id: orderId };

  for (const field of OWNED_COMPARISON_FIELDS) {
    if (field === "order_id") continue; // already normalized above
    normalized[field] = row[field] ?? null;
  }

  // Also capture row-level metadata
  normalized._row_id = row.id ?? null;
  normalized._created_at = row.created_at ?? null;

  return normalized;
}

// ============================================================================
// Comparison
// ============================================================================

function compareRows(baserowRow, supabaseRow) {
  const diffs = [];
  for (const field of OWNED_COMPARISON_FIELDS) {
    const bVal = baserowRow?.[field] ?? null;
    const sVal = supabaseRow?.[field] ?? null;
    if (text(bVal) !== text(sVal)) {
      diffs.push({
        field,
        baserow: maskPii(bVal, field),
        supabase: maskPii(sVal, field),
      });
    }
  }
  return diffs;
}

function classifyRow(orderId, baserowRow, supabaseRow) {
  const hasBaserow = baserowRow != null;
  const hasSupabase = supabaseRow != null;

  // Invalid identity rows — check raw (pre-normalization) order_id
  const rawOrderId = text(baserowRow?._raw_order_id || supabaseRow?._raw_order_id || "");
  if (rawOrderId === "order_id") {
    return "invalid_identity";
  }

  if (hasBaserow && hasSupabase) {
    const diffs = compareRows(baserowRow, supabaseRow);
    return diffs.length === 0 ? "both_equivalent" : "field_differences";
  }

  if (hasBaserow && !hasSupabase) return "baserow_only";
  if (!hasBaserow && hasSupabase) return "supabase_only";
  return "unknown";
}

// ============================================================================
// Shipment linkage check
// ============================================================================

async function checkShipmentLinkage(supabaseRows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || supabaseRows.length === 0) return [];

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, { realtime: { enabled: false } });

  const orderIds = supabaseRows.map((r) => r.order_id).filter(Boolean);
  if (orderIds.length === 0) return [];

  log(`Checking shipment linkage for ${orderIds.length} orders...`);
  const issues = [];

  // Load shipment rows in batches
  for (let i = 0; i < orderIds.length; i += 200) {
    const batch = orderIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from("giga_shipment_projections")
      .select("order_id, sales_channel, giga_sync_status, tracking_number, tracking_carrier")
      .in("order_id", batch)
      .eq("sales_channel", "rakuten");

    if (error) {
      throw new Error(`Shipment linkage check error: ${error.message}`);
    }

    const shipmentByOrderId = new Map();
    for (const row of (Array.isArray(data) ? data : [])) {
      shipmentByOrderId.set(normalizeOrderId(row.order_id), row);
    }

    for (const orderId of batch) {
      const nid = normalizeOrderId(orderId);
      const hasShipment = shipmentByOrderId.has(nid);
      if (!hasShipment) {
        issues.push({ order_id: nid, issue: "no_shipment_projection" });
      }
    }
  }

  return issues;
}

// ============================================================================
// Main
// ============================================================================

async function main(options = {}) {
  // ── Dependency injection (test-only) ──
  const _loadBaserow      = options._inject?.loadBaserow      || loadBaserowRakutenRows;
  const _loadSupabase     = options._inject?.loadSupabase     || loadSupabaseRakutenRows;
  const _checkShipment    = options._inject?.checkShipment    || checkShipmentLinkage;
  const _outDirOverride   = options._inject?.outDir           || null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = _outDirOverride || resolve(repoRoot, "outputs", "rakuten-supabase-parity", timestamp);
  mkdirSync(outDir, { recursive: true });

  log(`Output directory: ${outDir}`);
  log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  if (limit > 0) log(`Limit: ${limit} rows per backend`);

  if (dryRun) {
    log("Dry run — skipping data load.");
    const summary = {
      mode: "dry_run",
      timestamp,
      note: "No data loaded. Re-run without --dry-run to compare Baserow and Supabase.",
    };
    writeFileSync(resolve(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(resolve(outDir, "README.md"), [
      "# Rakuten Supabase Parity Audit",
      "",
      `**Run:** ${timestamp}`,
      "**Mode:** dry run (no data)",
      "",
      "## How to run a full audit",
      "",
      "```bash",
      "BASEROW_DATABASE_TOKEN=... \\",
      "  BASEROW_RAKUTEN_TABLE_ID=... \\",
      "  SUPABASE_URL=... \\",
      "  SUPABASE_SERVICE_ROLE_KEY=... \\",
      "  node scripts/audit-rakuten-supabase-parity.mjs",
      "```",
      "",
      "## Output files",
      "",
      "- `summary.json` — aggregate category counts",
      "- `row-diff.csv` — per-row field-level differences",
      "- `prewrite-snapshot.json` — raw normalized data (PII redacted)",
      "- `proposed-remediation.json` — suggested actions (review before applying)",
      "- `README.md` — this file",
      "",
      "## Safety",
      "",
      "This audit is READ-ONLY. It does not modify any data.",
      "Remediation must be reviewed and executed separately with explicit hosted-write approval.",
      "",
    ].join("\n"));
    log("Done (dry run).");
    return { ok: true, dryRun: true, outDir };
  }

  // ── Load data ──────────────────────────────────────────────────
  const [baserowRaw, supabaseRaw] = await Promise.all([
    _loadBaserow(),
    _loadSupabase(),
  ]);

  log(`Baserow rows: ${baserowRaw.length}`);
  log(`Supabase rows: ${supabaseRaw.length}`);

  // ── Normalize ──────────────────────────────────────────────────
  const baserowRows = baserowRaw.map((r) => normalizeRow(r, "baserow"));
  const supabaseRows = supabaseRaw.map((r) => normalizeRow(r, "supabase"));

  // Build lookup maps
  const baserowByOrderId = new Map();
  for (const row of baserowRows) {
    if (row.order_id) baserowByOrderId.set(row.order_id, row);
  }

  const supabaseByOrderId = new Map();
  for (const row of supabaseRows) {
    if (row.order_id) supabaseByOrderId.set(row.order_id, row);
  }

  // ── Classify ───────────────────────────────────────────────────
  const allOrderIds = new Set([
    ...baserowByOrderId.keys(),
    ...supabaseByOrderId.keys(),
  ]);

  const categories = {
    both_equivalent: [],
    field_differences: [],
    baserow_only: [],
    supabase_only: [],
    invalid_identity: [],
  };

  const rowDiffs = [];

  for (const orderId of allOrderIds) {
    const bRow = baserowByOrderId.get(orderId) || null;
    const sRow = supabaseByOrderId.get(orderId) || null;
    const category = classifyRow(orderId, bRow, sRow);

    categories[category] = categories[category] || [];
    categories[category].push(orderId);

    const diffs = (bRow && sRow) ? compareRows(bRow, sRow) : [];

    rowDiffs.push({
      order_id: orderId,
      category,
      baserow_row_id: bRow?._row_id ?? null,
      supabase_row_id: sRow?._row_id ?? null,
      baserow_order_status: maskPii(bRow?.order_status, "order_status"),
      supabase_order_status: maskPii(sRow?.order_status, "order_status"),
      differences: diffs.map((d) => d.field),
      diff_count: diffs.length,
    });
  }

  // ── Missing lifecycle fields check (gated by lifecycle state) ──
  // Only flag fields that should exist given the order's current status.
  // e.g., don't flag rms_close_completed_at for PENDING_CONFIRMATION orders.
  const missingLifecycleFields = [];
  for (const row of supabaseRows) {
    const status = text(row.order_status);
    for (const field of ["last_synced_at", "rms_confirm_result", "rms_confirmed_at",
      "rms_close_result", "rms_close_completed_at"]) {
      // Gate: skip fields not yet expected at this lifecycle stage
      const requiredStates = LIFECYCLE_STATE_GATES[field];
      if (requiredStates && requiredStates.size > 0 && !requiredStates.has(status)) {
        continue;
      }
      if (row[field] == null || row[field] === "") {
        missingLifecycleFields.push({
          order_id: row.order_id,
          supabase_row_id: row._row_id,
          missing_field: field,
          order_status: maskPii(row.order_status, "order_status"),
        });
      }
    }
  }

  // ── Shipment linkage ───────────────────────────────────────────
  let shipmentIssues = [];
  let shipmentError = null;
  try {
    shipmentIssues = await _checkShipment(supabaseRows);
  } catch (error) {
    shipmentError = error.message;
    log(`Shipment linkage check failed: ${error.message} (core parity data unaffected — audit is non-authoritative)`);
  }

  // ── Build summary ──────────────────────────────────────────────
  const summary = {
    timestamp,
    baserow_total: baserowRows.length,
    supabase_total: supabaseRows.length,
    unique_order_ids: allOrderIds.size,
    categories: {
      both_equivalent: categories.both_equivalent.length,
      field_differences: categories.field_differences.length,
      baserow_only: categories.baserow_only.length,
      supabase_only: categories.supabase_only.length,
      invalid_identity: categories.invalid_identity.length,
    },
    missing_lifecycle_fields: missingLifecycleFields.length,
    authoritative: !shipmentError,
    partial: limit > 0,

    shipment_linkage_issues: shipmentIssues.length,
    shipment_error: shipmentError,
    read_only: true,
    note: "Review before executing any separately approved remediation.",
  };

  // ── Build proposed remediation ──────────────────────────────────
  const proposedRemediation = {
    note: "PROPOSED ONLY. Do not execute without explicit hosted-write approval.",
    invalid_identity_rows: categories.invalid_identity.map((orderId) => {
      const sRow = supabaseByOrderId.get(orderId);
      return {
        order_id: orderId,
        action: "review_for_bounded_deletion",
        supabase_row_id: sRow?._row_id ?? null,
        reason: "literal 'order_id' value — not a real order",
      };
    }),
    baserow_only_orders: categories.baserow_only.map((orderId) => ({
      order_id: orderId,
      action: "review_before_import_or_ignore",
      baserow_row_id: baserowByOrderId.get(orderId)?._row_id ?? null,
    })),
    supabase_only_orders: categories.supabase_only.map((orderId) => ({
      order_id: orderId,
      action: "review_as_potential_new_orders",
      supabase_row_id: supabaseByOrderId.get(orderId)?._row_id ?? null,
    })),
    shipment_linkage_gaps: shipmentIssues,
  };

  // ── Write artifacts ────────────────────────────────────────────

  // summary.json
  writeFileSync(resolve(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`Wrote summary.json`);

  // row-diff.csv
  const csvHeader = "order_id,category,baserow_row_id,supabase_row_id,baserow_order_status,supabase_order_status,diff_fields,diff_count";
  const csvRows = rowDiffs.map((r) =>
    [r.order_id, r.category, r.baserow_row_id, r.supabase_row_id,
      `"${r.baserow_order_status || ""}"`, `"${r.supabase_order_status || ""}"`,
      `"${r.differences.join("; ")}"`, r.diff_count].join(","));
  writeFileSync(resolve(outDir, "row-diff.csv"), [csvHeader, ...csvRows].join("\n"));
  log(`Wrote row-diff.csv (${rowDiffs.length} rows)`);

  // prewrite-snapshot.json (PII redacted)
  const REDACTED = "[REDACTED]";
  const snapshot = {
    baserow_rows: baserowRows.map((r) => {
      const cleaned = { ...r };
      for (const f of PII_FIELDS) {
        cleaned[f] = REDACTED;
      }
      // Also redact raw identity marker to prevent correlation
      cleaned._raw_order_id = REDACTED;
      return cleaned;
    }),
    supabase_rows: supabaseRows.map((r) => {
      const cleaned = { ...r };
      for (const f of PII_FIELDS) {
        cleaned[f] = REDACTED;
      }
      cleaned._raw_order_id = REDACTED;
      return cleaned;
    }),
  };
  writeFileSync(resolve(outDir, "prewrite-snapshot.json"), JSON.stringify(snapshot, null, 2));
  log(`Wrote prewrite-snapshot.json`);

  // proposed-remediation.json
  writeFileSync(resolve(outDir, "proposed-remediation.json"), JSON.stringify(proposedRemediation, null, 2));
  log(`Wrote proposed-remediation.json`);

  // README.md
  writeFileSync(resolve(outDir, "README.md"), [
    "# Rakuten Supabase Parity Audit",
    "",
    `**Run:** ${timestamp}`,
    "",
    "## Summary",
    "",
    `| Category | Count |`,
    `|----------|-------|`,
    `| Baserow rows | ${summary.baserow_total} |`,
    `| Supabase rows | ${summary.supabase_total} |`,
    `| Unique order IDs | ${summary.unique_order_ids} |`,
    `| Both equivalent | ${summary.categories.both_equivalent} |`,
    `| Field differences | ${summary.categories.field_differences} |`,
    `| Baserow only | ${summary.categories.baserow_only} |`,
    `| Supabase only | ${summary.categories.supabase_only} |`,
    `| Invalid identity | ${summary.categories.invalid_identity} |`,
    `| Missing lifecycle fields | ${summary.missing_lifecycle_fields} |`,
    `| Shipment linkage issues | ${summary.shipment_linkage_issues} |`,
    "",
    "## Files",
    "",
    "- `summary.json` — aggregate counts",
    "- `row-diff.csv` — per-row field-level differences",
    "- `prewrite-snapshot.json` — raw normalized data (PII redacted)",
    "- `proposed-remediation.json` — suggested actions (DO NOT EXECUTE WITHOUT REVIEW)",
    "- `README.md` — this file",
    "",
    "## Safety",
    "",
    "**This audit is READ-ONLY.** It reads from both Baserow and Supabase but",
    "writes NOTHING to either backend. Remediation must be reviewed and executed",
    "separately with explicit hosted-write approval.",
    "",
    "**Never combine audit and remediation in a single automated step.**",
    "",
  ].join("\n"));
  log(`Wrote README.md`);

  // ── Console report ─────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log("RAKUTEN SUPABASE PARITY AUDIT");
  console.log("=".repeat(60));
  console.log(`Baserow rows:      ${summary.baserow_total}`);
  console.log(`Supabase rows:     ${summary.supabase_total}`);
  console.log(`Unique order IDs:  ${summary.unique_order_ids}`);
  console.log(`---`);
  console.log(`Both equivalent:   ${summary.categories.both_equivalent}`);
  console.log(`Field differences: ${summary.categories.field_differences}`);
  console.log(`Baserow only:      ${summary.categories.baserow_only}`);
  console.log(`Supabase only:     ${summary.categories.supabase_only}`);
  console.log(`Invalid identity:  ${summary.categories.invalid_identity}`);
  console.log(`Missing lifecycle: ${summary.missing_lifecycle_fields}`);
  console.log(`Shipment gaps:     ${summary.shipment_linkage_issues}`);
  console.log(`---`);
  console.log(`Output: ${outDir}`);
  console.log(`${"=".repeat(60)}\n`);

  const shipmentOk = !shipmentError;
  const runOk = shipmentOk;
  if (!runOk) {
    log(`Parity audit is NON-AUTHORITATIVE: shipment linkage check failed.`);
  }
  return { ok: runOk, authoritative: runOk, dryRun: false, summary, outDir };
}

// Only run main() when executed directly, not when imported
const scriptPath = resolve(process.argv[1]);
const thisFile = fileURLToPath(import.meta.url);
if (scriptPath === thisFile) {
  main().then((result) => {
    if (!result.ok) process.exit(1);
  }).catch((error) => {
    console.error(`FATAL: ${error.message}`);
    process.exit(1);
  });
}

// Exported for testing
export {
  normalizeOrderId,
  normalizeRow,
  classifyRow,
  compareRows,
  maskPii,
  PII_FIELDS,
  OWNED_COMPARISON_FIELDS,
  LIFECYCLE_STATE_GATES,
  main,
};
