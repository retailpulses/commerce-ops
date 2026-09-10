import { mapInquiry, mapMessage } from "./mappers";
import type { MercariPersistence } from "./persistence";
import type { MercariTransport } from "./relay";
import { routeInquiryTarget, isPresalesInquiry } from "./router";

/**
 * Bounded daily completeness audit. Recovers missing/changed delta that webhook
 * delivery may have dropped, for a single shop, over a bounded lookback window.
 *
 * It is NOT a second real-time reader: it uses cursor pagination over
 * `inquiries` and idempotently upserts readback facts. `unchanged` writes are
 * naturally zero because the persistence layer only counts created rows.
 *
 * `auditWritesEnabled` is the daily-audit repair write kill switch, independent
 * of webhook ingest and outbound send.
 */

export interface AuditConfig {
  auditWritesEnabled: boolean;
  lookbackHours?: number;
  maxDiscoveryPages?: number;
  maxThreadPages?: number;
}

export interface AuditResult {
  runId: string;
  shopKey: string;
  deliverySource: "daily_audit";
  scanned: number;
  compared: number;
  recovered: number;
  rowsWritten: number;
  errors: number;
  errorSamples: string[];
  paused?: boolean;
}

const DEFAULT_LOOKBACK_HOURS = 72;
const DEFAULT_MAX_DISCOVERY_PAGES = 20;
const DEFAULT_MAX_THREAD_PAGES = 10;

export async function runDailyAudit(
  shopKey: string,
  config: AuditConfig,
  persistence: MercariPersistence,
  transport: MercariTransport,
): Promise<AuditResult> {
  const runId = `audit-${shopKey}-${Date.now()}`;
  const lookbackHours = config.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxDiscoveryPages = config.maxDiscoveryPages ?? DEFAULT_MAX_DISCOVERY_PAGES;
  const maxThreadPages = config.maxThreadPages ?? DEFAULT_MAX_THREAD_PAGES;
  const windowStart = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  const result: AuditResult = {
    runId,
    shopKey,
    deliverySource: "daily_audit",
    scanned: 0,
    compared: 0,
    recovered: 0,
    rowsWritten: 0,
    errors: 0,
    errorSamples: [],
  };

  if (!config.auditWritesEnabled) {
    return { ...result, paused: true };
  }

  const addError = (err: unknown) => {
    result.errors++;
    const message = err instanceof Error ? err.message : String(err);
    if (result.errorSamples.length < 5) result.errorSamples.push(message);
  };

  try {
    let after: string | null = null;
    for (let page = 0; page < maxDiscoveryPages; page++) {
      const res = await transport.inquiries(shopKey, { first: 50, after });
      result.scanned += res.inquiries.length;

      for (const inquiry of res.inquiries) {
        // Only reconcile threads whose last activity falls inside the window.
        if (
          inquiry.lastActivityAt &&
          Date.parse(inquiry.lastActivityAt) < Date.parse(windowStart)
        ) {
          continue;
        }

        const decision = routeInquiryTarget(inquiry.target, null);
        if (!isPresalesInquiry(decision)) continue; // order targets never enter the cohort

        const allMessages: import("./types").MercariMessage[] = [];
        let cursor: string | null = null;
        let threadComplete = false;
        for (let mp = 0; mp < maxThreadPages; mp++) {
          const mr = await transport.inquiryMessages(shopKey, inquiry.id, {
            first: 50,
            after: cursor,
          });
          allMessages.push(...mr.messages);
          if (!mr.pageInfo.hasNextPage) {
            threadComplete = true;
            break;
          }
          cursor = mr.pageInfo.endCursor ?? null;
          if (!cursor) throw new Error("message pagination returned hasNextPage without endCursor");
        }
        if (!threadComplete) throw new Error(`message pagination exceeded ${maxThreadPages} pages for ${inquiry.id}`);
        const latestBuyerMessage = [...allMessages]
          .filter((message) => message.from === "BUYER" && message.status !== "DELETED")
          .sort((a, b) => `${a.sentAt ?? ""}:${a.id}`.localeCompare(`${b.sentAt ?? ""}:${b.id}`))
          .at(-1) ?? null;
        const canonical = await mapInquiry(inquiry, shopKey, "daily_audit", null, latestBuyerMessage);
        const canonicalMessages = [];
        for (const message of allMessages) {
            const mapped = await mapMessage(message, 0, shopKey, inquiry.id, "daily_audit");
            if (!mapped) continue;
            canonicalMessages.push(mapped);
        }
        const reconciled = await persistence.reconcileApiThread(canonical, canonicalMessages);
        result.compared += 1 + canonicalMessages.length;
        result.recovered += reconciled.rowsWritten;
      }

      if (!res.pageInfo.hasNextPage) break;
      after = res.pageInfo.endCursor ?? null;
      if (!after) throw new Error("inquiry pagination returned hasNextPage without endCursor");
    }
  } catch (err) {
    addError(err);
  }

  result.rowsWritten = result.recovered;

  // Persist run metrics regardless of success (bounded best-effort).
  try {
    await persistence.recordIngestionRun({
      shop_key: shopKey,
      run_id: runId,
      delivery_source: "daily_audit",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      window_start_at: windowStart,
      window_end_at: new Date().toISOString(),
      scanned: result.scanned,
      compared: result.compared,
      recovered: result.recovered,
      rows_written: result.rowsWritten,
      errors: result.errors,
      status: result.errors > 0 ? "partial" : "completed",
      error_samples: result.errorSamples,
    });
  } catch {
    // Metrics write failure must not fail the audit result itself.
  }

  return result;
}
