#!/usr/bin/env node
/**
 * Multi-Platform Sales Brief — VPS systemd timer
 *
 * Queries Supabase sales_orders for Mercari + Rakuten + Amazon,
 * aggregates by platform and sales group, formats a markdown report,
 * and pushes to WeCom.
 *
 * Usage:
 *   node scripts/sales-brief-report.mjs --dry-run    # format + print, no WeCom
 *   node scripts/sales-brief-report.mjs               # full run
 *
 * Env vars (from /etc/ordermgmt/sales-brief.env):
 *   SUPABASE_URL                  Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     Service role key (bypass RLS)
 *   WECOM_WEBHOOK_URL             WeCom bot webhook URL
 *   SALES_BRIEF_FRESHNESS_SCOPES  Required platform:store scopes
 *   SALES_BRIEF_MAX_FRESHNESS_MINUTES  Maximum authoritative observation age
 *   SALES_BRIEF_DELIVERY_SLOT       Optional approved manual JST hour slot
 *
 * Issue: https://github.com/retailpulses/OrderMgmt/issues/178
 */

import { randomUUID } from "node:crypto";
import { createBaserowClient } from "../src/lib/db.mjs";
import { claimExternalOperation, finalizeExternalOperation, hashExternalOperationPayload } from "../src/lib/external-operation-ledger.mjs";
import { MERCARI_FRESHNESS_SCOPES, requireLifecycleFreshness } from "../src/lib/lifecycle-freshness.mjs";

// ── Constants ──────────────────────────────────────────────────────────────

const TABLE = "sales_orders";
const SELECT = "order_id,sales_channel,order_status,quantity,product_price,shipping_price,source_store_id,purchase_date";

/** Supabase REST API — channels to query */
const CHANNELS = "in.(mercari,rakuten,amazon)";

/** Mercari Shop 4 source_store_id (broken out as separate sales group) */
const SHOP4_ID = "2JMLHBxjiFHDr55jMwA7fs";

/** Platforms in display order */
const PLATFORMS = ["Mercari", "Rakuten", "Amazon"];

/** Sales groups in display order */
const SALES_GROUPS = ["Mercari Shop 4", "Other Mercari", "Rakuten", "Amazon"];
const SALES_BRIEF_HOURS = new Set([8, 11, 14, 17, 20, 22]);

// ── CLI ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

// ── Env ────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function supabaseConfig() {
  return {
    url: requireEnv("SUPABASE_URL").replace(/\/+$/, ""),
    key: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function requireFreshSnapshot() {
  const { url, key } = supabaseConfig();
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    accept: "application/json",
  };
  const client = {
    from(table) {
      return {
        select(columns) {
          return {
            async in(column, values) {
              const params = new URLSearchParams({ select: columns });
              params.set(column, `in.(${values.join(",")})`);
              const response = await fetch(`${url}/rest/v1/${table}?${params}`, { headers });
              const data = await response.json().catch(() => null);
              return response.ok ? { data, error: null } : { data: null, error: { message: `HTTP ${response.status}` } };
            },
          };
        },
      };
    },
  };
  return requireLifecycleFreshness(client, {
    requiredScopes: process.env.SALES_BRIEF_FRESHNESS_SCOPES,
    fallbackScopes: MERCARI_FRESHNESS_SCOPES,
    maxAgeMinutes: process.env.SALES_BRIEF_MAX_FRESHNESS_MINUTES,
  });
}

// ── JST Helpers ────────────────────────────────────────────────────────────

function jstDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const out = {};
  for (const p of parts) {
    if (p.type === "year") out.year = Number(p.value);
    if (p.type === "month") out.month = Number(p.value);
    if (p.type === "day") out.day = Number(p.value);
  }
  return out;
}

export function resolveSalesBriefDeliverySlot(now = new Date(), explicitSlot = "") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  const hour = Number(parts.hour);
  if (!SALES_BRIEF_HOURS.has(hour)) throw new Error("sales_brief_outside_delivery_slot");
  const currentSlot = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00+09:00`;
  const requested = String(explicitSlot || "").trim();
  if (requested) {
    if (!/^\d{4}-\d{2}-\d{2}T(?:08|11|14|17|20|22):00\+09:00$/.test(requested)) throw new Error("invalid_sales_brief_delivery_slot");
    if (requested !== currentSlot) throw new Error("sales_brief_delivery_slot_mismatch");
  }
  return currentSlot;
}

function defaultLedgerClient() {
  return createBaserowClient({ ...process.env, DATABASE_BACKEND: "supabase" }).supabase;
}

/** JST month start as ISO string. JST = UTC+9, so 00:00 JST on 1st = 15:00 UTC on last day of prev month. */
function jstMonthStartUtc() {
  const parts = jstDateParts();
  return new Date(Date.UTC(parts.year, parts.month - 1, 0, 15, 0, 0)).toISOString();
}

/** JST next month start as ISO string. */
function jstNextMonthStartUtc() {
  const parts = jstDateParts();
  return new Date(Date.UTC(parts.year, parts.month, 0, 15, 0, 0)).toISOString();
}

function jstDateStr(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function todayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function jstTimestamp() {
  const d = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${date} ${time} JST`;
}

// ── Supabase Query ─────────────────────────────────────────────────────────

async function fetchOrders() {
  const { url: supabaseUrl, key: supabaseKey } = supabaseConfig();
  const monthStart = jstMonthStartUtc();
  const nextMonthStart = jstNextMonthStartUtc();
  const apiBase = `${supabaseUrl}/rest/v1/${TABLE}`;

  const rows = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      select: SELECT,
      sales_channel: CHANNELS,
      order: "purchase_date.asc",
      limit: String(limit),
      offset: String(offset),
    });
    params.append("purchase_date", `gte.${monthStart}`);
    params.append("purchase_date", `lt.${nextMonthStart}`);

    const url = `${apiBase}?${params.toString()}`;
    const resp = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Supabase ${resp.status}: ${text.slice(0, 500)}`);
    }

    const page = await resp.json();
    if (!Array.isArray(page)) break;
    rows.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return rows;
}

// ── Classification ─────────────────────────────────────────────────────────

export function revenue(row) {
  const productPrice = Number(row.product_price) || 0;
  const shippingPrice = Number(row.shipping_price) || 0;
  const quantity = Math.max(1, Number(row.quantity) || 1);
  return row.sales_channel === "rakuten"
    ? productPrice * quantity + shippingPrice
    : productPrice + shippingPrice;
}

/**
 * Classify a sales_orders row.
 * Returns null for excluded rows (CANCELED on any platform).
 */
export function classify(row) {
  const channel = (row.sales_channel || "").trim();
  const status = (row.order_status || "").trim();
  const rev = revenue(row);

  if (channel === "mercari") {
    if (status === "CANCELED") return null;
    return {
      platform: "Mercari",
      group: row.source_store_id === SHOP4_ID ? "Mercari Shop 4" : "Other Mercari",
      isPaid: status !== "WAITING_FOR_PAYMENT",
      isWaiting: status === "WAITING_FOR_PAYMENT",
      revenue: rev,
    };
  }

  if (channel === "rakuten") {
    if (status === "CANCELED") return null;
    return {
      platform: "Rakuten",
      group: "Rakuten",
      // PENDING_CONFIRMATION means the paid RMS order is waiting for the
      // shop's acknowledgement. It is not a customer-payment-pending state.
      isPaid: status === "PENDING_CONFIRMATION" || status === "CONFIRMED" || status === "RMS_CONFIRMED",
      isWaiting: false,
      revenue: rev,
    };
  }

  if (channel === "amazon") {
    if (status === "CANCELED") return null;
    return {
      platform: "Amazon",
      group: "Amazon",
      isPaid: status !== "PENDING",
      isWaiting: status === "PENDING",
      revenue: rev,
    };
  }

  return null;
}

// ── Aggregation ────────────────────────────────────────────────────────────

function zeroBucket() {
  return { paidCount: 0, paidRevenue: 0, waitingCount: 0, waitingRevenue: 0 };
}

export function buildSummary(rows) {
  const todayKey = todayJst();

  const total = { ...zeroBucket(), paidTodayCount: 0, paidTodayRevenue: 0, waitingTodayRevenue: 0 };
  const byPlatform = Object.fromEntries(PLATFORMS.map(p => [p, { ...zeroBucket(), paidTodayCount: 0, paidTodayRevenue: 0 }]));
  const byGroup = Object.fromEntries(SALES_GROUPS.map(g => [g, { ...zeroBucket(), paidTodayCount: 0, paidTodayRevenue: 0 }]));

  for (const row of rows) {
    const c = classify(row);
    if (!c) continue;

    const rowDate = jstDateStr(row.purchase_date);
    const isToday = rowDate === todayKey;

    if (c.isPaid) {
      total.paidCount += 1;
      total.paidRevenue += c.revenue;
      byPlatform[c.platform].paidCount += 1;
      byPlatform[c.platform].paidRevenue += c.revenue;
      byGroup[c.group].paidCount += 1;
      byGroup[c.group].paidRevenue += c.revenue;

      if (isToday) {
        total.paidTodayCount += 1;
        total.paidTodayRevenue += c.revenue;
        byPlatform[c.platform].paidTodayCount += 1;
        byPlatform[c.platform].paidTodayRevenue += c.revenue;
        byGroup[c.group].paidTodayCount += 1;
        byGroup[c.group].paidTodayRevenue += c.revenue;
      }
    }

    if (c.isWaiting) {
      total.waitingCount += 1;
      total.waitingRevenue += c.revenue;
      byPlatform[c.platform].waitingCount += 1;
      byPlatform[c.platform].waitingRevenue += c.revenue;
      byGroup[c.group].waitingCount += 1;
      byGroup[c.group].waitingRevenue += c.revenue;

      if (isToday) {
        total.waitingTodayRevenue += c.revenue;
      }
    }
  }

  return {
    monthLabel: todayKey.slice(0, 7),
    timestampJst: jstTimestamp(),
    total,
    byPlatform,
    byGroup,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

function fmtYen(v) {
  return `¥${Math.round(v || 0).toLocaleString("en-US")}`;
}

function formatBrief(s) {
  const t = s.total;
  const todayPaid = t.paidTodayCount;
  const todayRev = t.paidTodayRevenue;
  const todayAov = todayPaid ? Math.round(todayRev / todayPaid) : 0;
  const todayWaiting = t.waitingTodayRevenue;

  const mtdPaid = t.paidCount;
  const mtdRev = t.paidRevenue;
  const mtdAov = mtdPaid ? Math.round(mtdRev / mtdPaid) : 0;

  const lines = [
    "### Multi-Platform Sales Brief",
    `Push time: ${s.timestampJst}`,
    `Month: ${s.monthLabel}`,
    "",
    "#### Total",
    `- Paid/completed orders: ${todayPaid}`,
    `- Paid/completed sales: ${fmtYen(todayRev)}`,
    `- Paid/completed AOV: ${fmtYen(todayAov)}`,
    `- Waiting payment: ${fmtYen(todayWaiting)}`,
    "",
    "##### Month To Date",
    `- Paid/completed orders: ${mtdPaid}`,
    `- Paid/completed sales: ${fmtYen(mtdRev)}`,
    `- Paid/completed AOV: ${fmtYen(mtdAov)}`,
    `- Waiting payment: ${fmtYen(t.waitingRevenue)}`,
    "",
    "#### By Platform Today",
    ...PLATFORMS.map(p => {
      const bp = s.byPlatform[p];
      return `- ${p}: ${bp.paidTodayCount} orders / ${fmtYen(bp.paidTodayRevenue)}`;
    }),
    "",
    "#### By Platform Month To Date",
    ...PLATFORMS.map(p => {
      const bp = s.byPlatform[p];
      return `- ${p}: ${bp.paidCount} orders / ${fmtYen(bp.paidRevenue)}`;
    }),
    "",
    "#### By Sales Group Today",
    ...SALES_GROUPS.map(g => {
      const bg = s.byGroup[g];
      return `- ${g}: ${bg.paidTodayCount} orders / ${fmtYen(bg.paidTodayRevenue)}`;
    }),
    "",
    "#### By Sales Group Month To Date",
    ...SALES_GROUPS.map(g => {
      const bg = s.byGroup[g];
      return `- ${g}: ${bg.paidCount} orders / ${fmtYen(bg.paidRevenue)}`;
    }),
    "",
    "#### Scope",
    "- Paid/completed excludes `CANCELED` on all platforms and `WAITING_FOR_PAYMENT` on Mercari. Rakuten `PENDING_CONFIRMATION` is included because payment is complete and only shop acknowledgement remains.",
    "- Waiting payment includes only a genuine customer-payment-pending status.",
  ];
  return lines.join("\n");
}

// ── WeCom Push ─────────────────────────────────────────────────────────────

async function sendWeCom(markdown) {
  const resp = await fetch(requireEnv("WECOM_WEBHOOK_URL"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content: markdown },
    }),
  });

  const body = await resp.json().catch(() => null);
  const ok = resp.ok && body && Number(body.errcode) === 0;
  return { ok, status: resp.status, body, error: ok ? null : (body?.errmsg || `HTTP ${resp.status}`) };
}

export function classifySalesBriefSendFailure(send) {
  const errcode = Number(send?.body?.errcode);
  if (send?.body && Number.isFinite(errcode) && errcode !== 0) {
    return { status: "DEFINITIVE_FAILURE", completionState: "send_failed", errorCode: "wecom_rejected_delivery" };
  }
  return { status: "UNKNOWN_RESULT", completionState: "unknown_delivery_result", errorCode: "wecom_response_ambiguous" };
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function runSalesBrief({
  dryRun = DRY_RUN,
  checkFreshness = requireFreshSnapshot,
  loadOrders = fetchOrders,
  sendReport = sendWeCom,
  ledgerClient,
  claimOperation = claimExternalOperation,
  finalizeOperation = finalizeExternalOperation,
  hashPayload = hashExternalOperationPayload,
  now = new Date(),
  deliverySlot = process.env.SALES_BRIEF_DELIVERY_SLOT,
  log = console,
} = {}) {
  log.error(`[sales-brief] Starting at ${jstTimestamp()}${dryRun ? " (DRY RUN)" : ""}`);

  const freshness = await checkFreshness();
  if (!freshness.ok) {
    log.error(`[sales-brief] BLOCKED_BY_FRESHNESS ${JSON.stringify(freshness.failures)}`);
    return { ok: false, completion_state: "blocked_by_freshness", freshness, orders_read: 0, reports_sent: 0 };
  }

  // 1. Fetch
  log.error("[sales-brief] Fetching orders from Supabase...");
  const rows = await loadOrders();
  log.error(`[sales-brief] Fetched ${rows.length} rows`);

  // 2. Aggregate
  const summary = buildSummary(rows);
  log.error(`[sales-brief] MTD: ${summary.total.paidCount} paid, ${fmtYen(summary.total.paidRevenue)} | Waiting: ${summary.total.waitingCount} orders, ${fmtYen(summary.total.waitingRevenue)}`);
  log.error(`[sales-brief] Today: ${summary.total.paidTodayCount} paid, ${fmtYen(summary.total.paidTodayRevenue)} | Waiting: ${fmtYen(summary.total.waitingTodayRevenue)}`);

  // 3. Format
  const markdown = formatBrief(summary);

  if (dryRun) {
    log.log(markdown);
    log.error(`\n[sales-brief] Dry run complete. Not pushed to WeCom.`);
    return { ok: true, completion_state: "preview_complete", orders_read: rows.length, reports_sent: 0, summary };
  }

  // 4. Persist a stable delivery-slot intent before the external send.
  const slot = resolveSalesBriefDeliverySlot(now, deliverySlot);
  const payloadHash = await hashPayload({ report: "multi-platform-sales-brief-v1", slot });
  const runId = `sales-brief:${slot}:${randomUUID()}`;
  const client = ledgerClient || defaultLedgerClient();
  const claim = await claimOperation(client, {
    capability: "sales_brief_delivery",
    platform: "internal",
    sourceStoreId: "all",
    orderId: slot,
    payloadHash,
    runId,
  });
  if (!claim.claimed) {
    const completed = ["CONFIRMED", "ALREADY_APPLIED"].includes(claim.status);
    return {
      ok: completed,
      completion_state: completed ? "already_delivered" : "blocked_by_delivery_intent",
      orders_read: rows.length,
      reports_sent: 0,
      delivery_slot: slot,
      operation_status: claim.status,
      summary,
    };
  }

  // 5. Push once. Any ambiguous result remains blocked in the ledger.
  log.error("[sales-brief] Pushing to WeCom...");
  let send;
  try {
    send = await sendReport(markdown);
  } catch (error) {
    await finalizeOperation(client, {
      operationKey: claim.operationKey, runId, status: "UNKNOWN_RESULT",
      errorCode: "wecom_transport_ambiguous",
    });
    return { ok: false, completion_state: "unknown_delivery_result", orders_read: rows.length, reports_sent: 0, delivery_slot: slot, summary, error: String(error?.message || error) };
  }
  if (!send.ok) {
    const failure = classifySalesBriefSendFailure(send);
    await finalizeOperation(client, {
      operationKey: claim.operationKey, runId, status: failure.status,
      providerCode: send.body?.errcode ?? send.status, errorCode: failure.errorCode,
    });
    log.error(`[sales-brief] WeCom push FAILED: ${send.error}`);
    return { ok: false, completion_state: failure.completionState, orders_read: rows.length, reports_sent: 0, delivery_slot: slot, summary, error: send.error };
  }
  await finalizeOperation(client, {
    operationKey: claim.operationKey, runId, status: "CONFIRMED",
    providerCode: send.status,
  });
  log.error(`[sales-brief] WeCom push OK (status ${send.status})`);
  log.error(`[sales-brief] Done at ${jstTimestamp()}`);
  return { ok: true, completion_state: "completed", orders_read: rows.length, reports_sent: 1, delivery_slot: slot, summary };
}

async function main() {
  const result = await runSalesBrief();
  if (!result.ok) process.exitCode = result.completion_state === "blocked_by_freshness" ? 2 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`[sales-brief] FATAL: ${err.stack || err}`);
    process.exit(1);
  });
}
