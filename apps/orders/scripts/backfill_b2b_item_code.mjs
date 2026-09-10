#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// Inline the resolver to avoid depending on env vars for module resolution
function normalizeText(value) {
  return String(value ?? "").trim();
}

function mercariResolveItemCode(sku) {
  const normalized = normalizeText(sku);
  if (!normalized) {
    return { resolved: false, code: null, reason: "empty_sku" };
  }
  if (/^RP/i.test(normalized)) {
    return { resolved: false, code: null, reason: "rp_fee_adjustment" };
  }
  if (normalized.includes("-")) {
    return { resolved: false, code: null, reason: "ambiguous_hyphen" };
  }
  return { resolved: true, code: normalized, reason: null };
}

// ── Parse args ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const result = { _: [], dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") result.dryRun = true;
    else if (t === "--confirm") result.dryRun = false;
    else if (t === "--limit") { result.limit = parseInt(argv[++i], 10); }
    else if (!t.startsWith("--")) result._.push(t);
  }
  return result;
}

// ── Baserow helpers ──────────────────────────────────────────────────
async function baserowRequest(url, token, { method = "GET", body = null } = {}) {
  const opts = {
    method,
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
  };
  if (body) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  return fetch(url, opts);
}

async function listRows(apiBase, tableId, token) {
  const rows = [];
  let url = `${apiBase}/database/rows/table/${tableId}/?user_field_names=true&size=200`;
  while (url) {
    const res = await baserowRequest(url, token);
    if (!res.ok) throw new Error(`list_failed:${res.status}`);
    const body = await res.json();
    rows.push(...(body.results || []));
    url = body.next || null;
  }
  return rows;
}

async function patchRow(apiBase, tableId, rowId, payload, token) {
  const url = `${apiBase}/database/rows/table/${tableId}/${rowId}/?user_field_names=true`;
  const res = await baserowRequest(url, token, { method: "PATCH", body: payload });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.error, status: res.status, error: body.error || null };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.dryRun;
  const limit = args.limit || 0;

  // Load env from known paths
  const envPaths = [
    path.join(REPO_ROOT, "env", "dev.env"),
    "/opt/rp-order-mgmt/env/dev.env",
    "/Users/user/Documents/ERP/Techstack/catalog research tool/dev.env",
  ];
  for (const ep of envPaths) {
    try {
      if (process.env.BASEROW_DATABASE_TOKEN) break;
      const text = fs.readFileSync(ep, "utf8");
      for (const line of text.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !process.env[key]) process.env[key] = val;
      }
      console.error(`Loaded env from ${ep}`);
    } catch { /* skip */ }
  }

  const apiBase = process.env.BASEROW_API_BASE || "https://api.baserow.io/api";
  const token = process.env.BASEROW_DATABASE_TOKEN;
  const tableId = parseInt(process.env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID || "903318", 10);

  if (!token) {
    console.error("Missing BASEROW_DATABASE_TOKEN");
    process.exit(1);
  }

  console.error(`Loading all Mercari sales rows from table ${tableId}...`);
  const rows = await listRows(apiBase, tableId, token);
  console.error(`Loaded ${rows.length} rows`);

  // Filter: rows with original_product_id set but b2b_item_code empty/null
  const candidates = rows.filter((row) => {
    const sku = normalizeText(row.original_product_id);
    const existing = normalizeText(row.b2b_item_code);
    return sku && !existing;
  });

  console.error(`Candidates (empty b2b_item_code): ${candidates.length}`);

  const limited = limit > 0 ? candidates.slice(0, limit) : candidates;
  if (limited.length === 0) {
    console.log(JSON.stringify({ ok: true, total_rows: rows.length, candidates: 0, updated: 0, dry_run: dryRun }));
    return;
  }

  console.error(`Processing ${limited.length} rows${dryRun ? " [DRY RUN]" : ""}...`);

  let updated = 0, skipped = 0, failed = 0;
  const results = [];

  for (const row of limited) {
    const sku = normalizeText(row.original_product_id);
    const result = mercariResolveItemCode(sku);
    const entry = { row_id: row.id, original_product_id: sku, resolved: result.resolved, reason: result.reason || "" };

    if (!result.resolved) {
      skipped++;
      results.push({ ...entry, action: "skipped", code: "" });
      console.error(`  SKIP row ${row.id}: "${sku}" → ${result.reason}`);
      continue;
    }

    entry.code = result.code;

    if (dryRun) {
      updated++;
      results.push({ ...entry, action: "would_update" });
      console.error(`  DRY  row ${row.id}: "${sku}" → "${result.code}"`);
      continue;
    }

    const patch = await patchRow(apiBase, tableId, row.id, { b2b_item_code: result.code }, token);
    if (!patch.ok) {
      failed++;
      results.push({ ...entry, action: "failed", error: String(patch.error) });
      console.error(`  FAIL row ${row.id}: ${patch.error}`);
    } else {
      updated++;
      results.push({ ...entry, action: "updated" });
      console.error(`  OK   row ${row.id}: "${sku}" → "${result.code}"`);
    }
  }

  const summary = {
    ok: failed === 0,
    dry_run: dryRun,
    total_rows: rows.length,
    candidates: candidates.length,
    processed: limited.length,
    updated,
    skipped,
    failed,
    results,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
