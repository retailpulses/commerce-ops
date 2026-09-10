import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";
import { ZohoMailClient, type ZohoMailConfig, type ZohoMessageSummary } from "../clients/zoho-mail";

export type AmazonMailMode = "off" | "shadow" | "active";

export interface AmazonMailSyncReport {
  mode: AmazonMailMode;
  pages: number;
  scanned: number;
  candidates: number;
  authenticated: number;
  untrusted: number;
  persisted: number;
  deduplicated: number;
  failed: number;
  responseBytes: number;
  continuation: boolean;
  checkpointAdvanced: boolean;
  attachmentsClaimed: number;
  attachmentsStored: number;
  attachmentsRejected: number;
  attachmentErrors: number;
}

interface SyncState {
  generation: number;
  watermark_received_at: string | null;
  watermark_message_id: string | null;
  window_start: string | null;
  run_to: string | null;
  continuation: string | null;
}

interface SyncOptions {
  mode?: AmazonMailMode;
  now?: Date;
  targetOrderNumber?: string;
  maxPages?: number;
  pageSize?: number;
  client?: ZohoMailClient;
}

const ORDER_PATTERN = /\b\d{3}-\d{7}-\d{7}\b/;
const AMAZON_SENDER_PATTERN = /@marketplace\.amazon\.co\.jp$/i;

function modeFromEnv(env: Env): AmazonMailMode {
  const mode = String(env.AMAZON_MAIL_INGESTION_MODE || "off").toLowerCase();
  return mode === "active" || mode === "shadow" ? mode : "off";
}

function requiredConfig(env: Env): ZohoMailConfig {
  const values = {
    accountsBase: env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.com",
    apiBase: env.ZOHO_MAIL_API_BASE || "https://mail.zoho.com/api",
    accountId: env.ZOHO_MAIL_ACCOUNT_ID || "",
    clientId: env.ZOHO_CLIENT_ID || "",
    clientSecret: env.ZOHO_CLIENT_SECRET || "",
    refreshToken: env.ZOHO_REFRESH_TOKEN || "",
    fromAddress: env.AMAZON_MAIL_FROM_ADDRESS || "amazon@retailpulses.com",
  };
  if (!values.accountId || !values.clientId || !values.clientSecret || !values.refreshToken) {
    throw new Error("amazon_mail_provider_not_configured");
  }
  return values;
}

function isoFromZohoMillis(value: string): string {
  const millis = Number(value);
  if (!Number.isFinite(millis)) throw new Error("amazon_mail_received_time_invalid");
  return new Date(millis).toISOString();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageTuple(message: ZohoMessageSummary): [number, string] {
  return [Number(message.receivedTime), message.messageId];
}

function compareMessages(a: ZohoMessageSummary, b: ZohoMessageSummary): number {
  const [aTime, aId] = messageTuple(a);
  const [bTime, bId] = messageTuple(b);
  return aTime === bTime ? aId.localeCompare(bId) : aTime - bTime;
}

function searchKey(windowStart: Date, runTo: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = (value: Date) => `${String(value.getUTCDate()).padStart(2, "0")}-${months[value.getUTCMonth()]}-${value.getUTCFullYear()}`;
  return `sender:@marketplace.amazon.co.jp::in:Inbox::fromDate:${date(windowStart)}::toDate:${date(runTo)}`;
}

function continuationSegmentDate(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { segment_date?: unknown };
    return typeof parsed.segment_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.segment_date)
      ? parsed.segment_date
      : null;
  } catch {
    return null;
  }
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function loadState(
  supabase: SupabaseClient,
  providerAccountId: string,
  providerFolderId: string,
): Promise<SyncState | null> {
  const { data, error } = await supabase.rpc("seed_amazon_mail_sync_state_v2_from_legacy", {
    p_provider_account_id: providerAccountId,
    p_provider_folder_id: providerFolderId,
  });
  if (error) throw new Error(`amazon_mail_sync_state_v2_seed_failed:${error.code || "unknown"}`);
  return data as SyncState;
}

export async function syncAmazonMail(
  env: Env,
  supabase: SupabaseClient,
  options: SyncOptions = {},
): Promise<AmazonMailSyncReport> {
  const mode = options.mode || modeFromEnv(env);
  const report: AmazonMailSyncReport = {
    mode, pages: 0, scanned: 0, candidates: 0, authenticated: 0,
    untrusted: 0, persisted: 0, deduplicated: 0, failed: 0,
    responseBytes: 0, continuation: false, checkpointAdvanced: false,
    attachmentsClaimed: 0, attachmentsStored: 0, attachmentsRejected: 0, attachmentErrors: 0,
  };
  if (mode === "off") return report;

  const providerAccountId = env.ZOHO_MAIL_ACCOUNT_ID || "";
  const providerFolderId = env.ZOHO_MAIL_INBOX_FOLDER_ID || "";
  const platformAccountId = env.AMAZON_PLATFORM_ACCOUNT_ID || "";
  if (!providerAccountId || !providerFolderId || !platformAccountId) {
    throw new Error("amazon_mail_account_mapping_not_configured");
  }

  const client = options.client || new ZohoMailClient(requiredConfig(env));
  const now = options.now || new Date();
  const pageSize = Math.min(100, Math.max(1, options.pageSize || 100));
  const maxPages = Math.min(20, Math.max(1, options.maxPages || 20));
  const overlapMinutes = Math.min(60, Math.max(5, Number(env.AMAZON_MAIL_OVERLAP_MINUTES || 15)));
  const lookbackHours = Math.min(168, Math.max(1, Number(env.AMAZON_MAIL_INITIAL_LOOKBACK_HOURS || 24)));
  // A targeted canary may persist its matching message, but must never consume
  // the shared folder checkpoint and thereby skip unrelated mail.
  const ownsCheckpoint = mode === "active" && !options.targetOrderNumber;
  const state = ownsCheckpoint ? await loadState(supabase, providerAccountId, providerFolderId) : null;
  const watermark = state?.watermark_received_at ? new Date(state.watermark_received_at) : new Date(now.getTime() - lookbackHours * 3_600_000);
  const windowStart = state?.continuation && state.window_start
    ? new Date(state.window_start)
    : new Date(watermark.getTime() - overlapMinutes * 60_000);
  const runTo = state?.continuation && state.run_to ? new Date(state.run_to) : now;
  const persistedSegmentDate = continuationSegmentDate(state?.continuation);
  const segmentDay = persistedSegmentDate
    ? new Date(`${persistedSegmentDate}T00:00:00.000Z`)
    : utcDayStart(runTo);
  const segmentStart = new Date(Math.max(windowStart.getTime(), segmentDay.getTime()));
  const segmentEnd = new Date(Math.min(runTo.getTime(), segmentDay.getTime() + 86_400_000 - 1));
  let start = 1;
  const collected: ZohoMessageSummary[] = [];
  let segmentComplete = false;

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await client.searchMessages({
      searchKey: searchKey(segmentStart, segmentEnd), start, limit: pageSize,
      receivedTime: String(segmentStart.getTime()),
    });
    report.pages += 1;
    report.scanned += rows.length;
    report.responseBytes += new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    collected.push(...rows.filter((message) => {
      const time = Number(message.receivedTime);
      return Number.isFinite(time) && time >= segmentStart.getTime() && time <= segmentEnd.getTime();
    }));
    if (rows.length < pageSize) { segmentComplete = true; break; }
    start += rows.length;
  }

  const candidates = [...new Map(collected.map((message) => [message.messageId, message])).values()]
    .filter((message) => AMAZON_SENDER_PATTERN.test(message.fromAddress))
    .sort(compareMessages);

  for (const message of candidates) {
    const combined = `${message.subject}\n${message.summary || ""}`;
    const orderNumber = combined.match(ORDER_PATTERN)?.[0] || null;
    if (options.targetOrderNumber && orderNumber !== options.targetOrderNumber) continue;
    report.candidates += 1;
    const authentication = await client.getAuthentication(message.folderId, message.messageId);
    if (authentication.status === "pass") report.authenticated += 1;
    else report.untrusted += 1;
    if (mode === "shadow") continue;

    try {
      const content = authentication.status === "pass"
        ? htmlToText(await client.getMessageContent(message.folderId, message.messageId))
        : "";
      const attachments = authentication.status === "pass" && message.hasAttachment
        ? await client.getAttachmentInfo(message.folderId, message.messageId)
        : [];
      const { data, error } = await supabase.rpc("ingest_amazon_mail_message_v3", {
        p_account_id: platformAccountId,
        p_external_order_id: orderNumber,
        p_subject: message.subject,
        p_body: content,
        p_source_received_at: isoFromZohoMillis(message.receivedTime),
        p_provider_account_id: providerAccountId,
        p_provider_folder_id: message.folderId,
        p_provider_message_id: message.messageId,
        p_provider_thread_id: message.threadId || null,
        p_mail_auth_status: authentication.status,
        p_mail_auth_domain: authentication.domain,
        p_attachment_count: attachments.length,
      });
      if (error) throw new Error(`amazon_mail_ingest_rpc_failed:${error.code || "unknown"}`);
      if ((data as Record<string, unknown> | null)?.evidence_inserted === true) report.persisted += 1;
      else report.deduplicated += 1;
    } catch {
      report.failed += 1;
      throw new Error("amazon_mail_message_persist_failed");
    }
  }

  if (ownsCheckpoint) {
    if (!segmentComplete) throw new Error("amazon_mail_day_segment_overflow");
    const hasEarlierSegment = segmentStart.getTime() > windowStart.getTime();
    const previousDay = new Date(segmentDay.getTime() - 86_400_000);
    const continuation = hasEarlierSegment
      ? JSON.stringify({ segment_date: dateOnly(previousDay) })
      : null;
    const { error } = await supabase.rpc("upsert_amazon_mail_sync_state_v2", {
      p_provider_account_id: providerAccountId,
      p_provider_folder_id: providerFolderId,
      p_expected_generation: state?.generation || 0,
      p_watermark_received_at: hasEarlierSegment ? state?.watermark_received_at || null : runTo.toISOString(),
      p_watermark_message_id: hasEarlierSegment ? state?.watermark_message_id || null : candidates.at(-1)?.messageId || state?.watermark_message_id || null,
      p_window_start: hasEarlierSegment ? windowStart.toISOString() : null,
      p_run_to: hasEarlierSegment ? runTo.toISOString() : null,
      p_continuation: continuation,
      p_last_success_at: new Date().toISOString(),
      p_last_error_code: null,
      p_last_run_metrics: report,
    });
    if (error) throw new Error(`amazon_mail_sync_state_v2_write_failed:${error.code || "unknown"}`);
    report.continuation = hasEarlierSegment;
    report.checkpointAdvanced = !hasEarlierSegment;
  }
  if (ownsCheckpoint && env.AMAZON_MAIL_ATTACHMENTS_ENABLED === "true") {
    // Attachment migration is a separate fault domain. Until its v2 adapter is
    // installed, report unavailable without failing or rolling back ingestion.
    report.attachmentErrors += 1;
  }
  return report;
}
