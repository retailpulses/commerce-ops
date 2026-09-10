#!/usr/bin/env node
/**
 * KV Export Dry-Run — lists all PORTAL_KV keys by prefix, counts records,
 * and estimates total size for migration planning.
 *
 * Usage:
 *   node scripts/kv-export-dry-run.mjs [--json]
 *
 * Prerequisites:
 *   - CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL in env
 *   - CLOUDFLARE_ACCOUNT_ID in env (or in wrangler.toml)
 *
 * The script calls the Cloudflare API directly to list KV keys.
 * It does NOT modify any data.
 *
 * Options:
 *   --json     Output machine-readable JSON instead of table format
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Config ──────────────────────────────────────────────────────────────

const KV_NAMESPACE_ID = "39e4a9a412624893bf0ce59448843a9a";

// Key prefixes used in the codebase
const KNOWN_PREFIXES = [
  { prefix: "template:",        label: "Message Templates",     owner: "portal-templates.mjs / portal/handlers.mjs" },
  { prefix: "message-state:v1:", label: "Durable Message State", owner: "buyer-messages.mjs" },
  { prefix: "messages:",        label: "Message Body Cache",    owner: "portal/handlers.mjs / safety.mjs" },
  { prefix: "auto-msg:",        label: "Auto-Approval Idempotency", owner: "auto-approval.mjs" },
  { prefix: "auto-msg:v2:",     label: "Auto-Approval Idempotency v2", owner: "auto-approval.mjs" },
  { prefix: "reply-sent:",      label: "Reply Idempotency",    owner: "portal/handlers.mjs" },
  { prefix: "msg:cache:",       label: "Message Cache",        owner: "portal/handlers.mjs" },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function loadTomlAccountId() {
  try {
    const toml = readFileSync(resolve(repoRoot, "wrangler.toml"), "utf-8");
    const match = toml.match(/^account_id\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getAuthHeaders() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };

  const key = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (key && email) {
    return {
      "X-Auth-Email": email,
      "X-Auth-Key": key,
    };
  }

  console.error("ERROR: Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL");
  process.exit(1);
}

async function listAllKeys(accountId) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys`;
  const headers = { ...getAuthHeaders(), "Content-Type": "application/json" };
  const allKeys = [];
  let cursor = null;

  do {
    const url = cursor ? `${baseUrl}?cursor=${encodeURIComponent(cursor)}` : baseUrl;
    const resp = await fetch(url, { headers });
    const body = await resp.json();

    if (!body.success) {
      console.error("ERROR: Cloudflare API error:", JSON.stringify(body.errors, null, 2));
      process.exit(1);
    }

    const result = body.result || [];
    allKeys.push(...result);
    cursor = body.result_info?.cursor || null;
  } while (cursor);

  return allKeys;
}

function categorizeKeys(keys) {
  const categories = new Map();

  for (const prefix of KNOWN_PREFIXES) {
    categories.set(prefix.prefix, {
      ...prefix,
      count: 0,
      totalSize: 0,
      keys: [],
    });
  }
  categories.set("__unknown__", {
    prefix: "(unknown)",
    label: "Unknown / Other",
    owner: "—",
    count: 0,
    totalSize: 0,
    keys: [],
  });

  for (const key of keys) {
    const name = key.name || "";
    let matched = false;

    // Match longest prefix first (auto-msg:v2: before auto-msg:)
    const sortedPrefixes = [...KNOWN_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const prefix of sortedPrefixes) {
      if (name.startsWith(prefix.prefix)) {
        const cat = categories.get(prefix.prefix);
        cat.count++;
        // CF API returns metadata including expiration
        cat.totalSize += (key.metadata?.size || 0);
        cat.keys.push(name);
        matched = true;
        break;
      }
    }

    if (!matched) {
      const cat = categories.get("__unknown__");
      cat.count++;
      cat.keys.push(name);
    }
  }

  return [...categories.values()].filter((c) => c.count > 0);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const useJson = process.argv.includes("--json");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || loadTomlAccountId();

  if (!accountId) {
    console.error("ERROR: Set CLOUDFLARE_ACCOUNT_ID or ensure wrangler.toml has account_id");
    process.exit(1);
  }

  if (!useJson) console.error("Fetching KV keys from Cloudflare API...");

  const keys = await listAllKeys(accountId);
  const categories = categorizeKeys(keys);
  const totalKeys = categories.reduce((s, c) => s + c.count, 0);

  if (useJson) {
    const report = {
      namespace_id: KV_NAMESPACE_ID,
      account_id: accountId,
      total_keys: totalKeys,
      fetched_at: new Date().toISOString(),
      categories: categories.map((c) => ({
        prefix: c.prefix,
        label: c.label,
        count: c.count,
        estimated_size_bytes: c.totalSize,
        owner: c.owner,
        sample_keys: c.keys.slice(0, 5),
      })),
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nKV Namespace: ${KV_NAMESPACE_ID}`);
    console.log(`Account:      ${accountId}`);
    console.log(`Total keys:   ${totalKeys}\n`);

    // Table header
    const pad = (s, w) => String(s).padEnd(w);
    console.log(`${pad("Prefix", 22)} ${pad("Count", 8)} ${pad("Size", 10)} ${pad("Category", 28)} Owner`);
    console.log("-".repeat(100));

    for (const cat of categories) {
      console.log(
        `${pad(cat.prefix, 22)} ${pad(String(cat.count), 8)} ${pad(formatBytes(cat.totalSize), 10)} ${pad(cat.label, 28)} ${cat.owner}`,
      );
    }

    console.log(`\n── Sample keys (up to 5 per category) ──\n`);
    for (const cat of categories) {
      if (cat.keys.length === 0) continue;
      console.log(`  ${cat.label} (${cat.prefix}):`);
      for (const key of cat.keys.slice(0, 5)) {
        console.log(`    ${key}`);
      }
      if (cat.keys.length > 5) {
        console.log(`    ... and ${cat.keys.length - 5} more`);
      }
      console.log();
    }

    // Migration checklist
    console.log("── Migration Checklist ──\n");
    const migrationTargets = {
      "template:":        "Supabase order_message_templates — run scripts/migrate-portal-templates.mjs",
      "message-state:v1:": "Supabase sales_order_message_state — adapter ready, verify row counts",
      "auto-msg:":        "Supabase idempotency_guards — import permanent guards before cutover",
      "auto-msg:v2:":     "Supabase idempotency_guards — import permanent guards before cutover",
      "reply-sent:":      "Supabase idempotency_guards (60s TTL) — no migration needed",
      "messages:":        "None (volatile cache, 24h TTL — drops naturally)",
      "msg:cache:":       "None (volatile cache — drops naturally)",
    };

    for (const cat of categories) {
      const target = migrationTargets[cat.prefix] || "Review manually";
      const status = target.includes("no migration") || target.includes("drops naturally") ? "⬜ N/A" : "⬜";
      console.log(`  ${status} ${cat.prefix} → ${target}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
