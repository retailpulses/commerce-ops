import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";
import { createRakutenRmesseClient, normalizeInquiryMessages } from "../clients/rakuten-rmesse";

export type RakutenRmesseMode = "off" | "shadow" | "active";

export interface RakutenRmesseSyncReport {
  mode: RakutenRmesseMode;
  scanned: number;
  qualified: number;
  excludedWithoutOrder: number;
  detailsFetched: number;
  ticketsCreated: number;
  messagesInserted: number;
  attachmentsInserted: number;
  attachmentsStored: number;
  attachmentErrors: number;
  pages: number;
  reconciliationCandidates: number;
  reconciliationFetched: number;
  reconciliationErrors: number;
  targetOrderNumber?: string;
}

function jstApiDate(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

export function rakutenRmesseMode(env: Env): RakutenRmesseMode {
  const mode = String(env.RAKUTEN_RMESSE_INGESTION_MODE || "off").trim().toLowerCase();
  return mode === "active" || mode === "shadow" ? mode : "off";
}

export async function syncRakutenRmesse(
  env: Env,
  supabase: SupabaseClient,
  options: { now?: Date; mode?: RakutenRmesseMode; targetOrderNumber?: string; fromDate?: Date } = {},
): Promise<RakutenRmesseSyncReport> {
  const mode = options.mode || rakutenRmesseMode(env);
  const report: RakutenRmesseSyncReport = {
    mode, scanned: 0, qualified: 0, excludedWithoutOrder: 0,
    detailsFetched: 0, ticketsCreated: 0, messagesInserted: 0, attachmentsInserted: 0,
    attachmentsStored: 0, attachmentErrors: 0, pages: 0,
    reconciliationCandidates: 0, reconciliationFetched: 0, reconciliationErrors: 0,
  };
  if (mode === "off") return report;
  if (!env.RAKUTEN_RMESSE_RELAY_URL || !env.RAKUTEN_RMESSE_RELAY_SECRET) {
    throw new Error(
      `rakuten_rmesse_relay_not_configured:url=${Boolean(env.RAKUTEN_RMESSE_RELAY_URL)}:secret=${Boolean(env.RAKUTEN_RMESSE_RELAY_SECRET)}`,
    );
  }

  const now = options.now || new Date();
  const targetOrderNumber = String(options.targetOrderNumber || "").trim();
  if (targetOrderNumber) report.targetOrderNumber = targetOrderNumber;
  const overlapMinutes = Math.min(60, Math.max(5, Number(env.RAKUTEN_RMESSE_OVERLAP_MINUTES || 10)));
  let cursor = new Date(now.getTime() - 15 * 60 * 1000);
  let accountId: string | null = null;
  if (mode === "active") {
    const { data: candidates, error: candidateError } = await supabase.from("platform_accounts")
      .select("id").eq("platform", "rakuten").eq("status", "active").limit(2);
    if (candidateError) throw new Error(`rakuten_platform_account_lookup_failed:${candidateError.message}`);
    if (candidates?.length === 1) accountId = candidates[0].id;

    let stateQuery = supabase.from("rakuten_rmesse_sync_state")
      .select("cursor_updated_at").limit(1);
    if (accountId) stateQuery = stateQuery.eq("account_id", accountId);
    const { data } = await stateQuery.maybeSingle();
    if (data?.cursor_updated_at) cursor = new Date(data.cursor_updated_at);
  }
  const from = options.fromDate || new Date(cursor.getTime() - overlapMinutes * 60 * 1000);
  const client = createRakutenRmesseClient({
    url: env.RAKUTEN_RMESSE_RELAY_URL,
    secret: env.RAKUTEN_RMESSE_RELAY_SECRET,
  });
  const processedInquiryNumbers = new Set<string>();

  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function verifiedImage(contentType: string, bytes: Uint8Array): { mimeType: string; extension: string } {
    const signatures = [
      { mimeType: "image/jpeg", extension: "jpeg", matches: bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
      { mimeType: "image/png", extension: "png", matches: bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value) },
      { mimeType: "image/gif", extension: "gif", matches: bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null },
      { mimeType: "image/webp", extension: "webp", matches: bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP" },
    ];
    const verified = signatures.find((candidate) => candidate.matches && candidate.mimeType === contentType);
    if (!verified) throw new Error("rakuten_rmesse_attachment_invalid_image");
    return verified;
  }

  async function storeAttachments(
    inquiry: Awaited<ReturnType<typeof client.get>>,
    ticketId: string,
    messages: ReturnType<typeof normalizeInquiryMessages>,
  ) {
    for (const message of messages) {
      for (const attachment of message.attachments) {
        try {
          const referenceDigest = await sha256Hex(new TextEncoder().encode(attachment.path));
          const referencePath = `${inquiry.inquiryNumber}/${message.external_message_id}/${referenceDigest}`;
          const { data: reference, error: referenceError } = await supabase.from("ticket_attachments")
            .select("id,metadata").eq("ticket_id", ticketId)
            .eq("storage_bucket", "rakuten-rmesse-reference").eq("storage_path", referencePath)
            .maybeSingle();
          if (referenceError) throw referenceError;
          if (!reference?.id) continue;

          const downloaded = await client.downloadAttachment({ label: attachment.label, path: attachment.path });
          const image = verifiedImage(downloaded.contentType, downloaded.bytes);
          const contentHash = await sha256Hex(downloaded.bytes);
          const storagePath = `tickets/${ticketId}/rakuten-rmesse/${contentHash}-${referenceDigest}.${image.extension}`;
          const { error: uploadError } = await supabase.storage.from("ticket-attachments")
            .upload(storagePath, downloaded.bytes, { contentType: image.mimeType, upsert: false });
          if (uploadError && !/already exists|duplicate/i.test(uploadError.message || "")) throw uploadError;

          const { error: updateError } = await supabase.from("ticket_attachments").update({
            storage_bucket: "ticket-attachments",
            storage_path: storagePath,
            filename: attachment.label,
            mime_type: image.mimeType,
            media_type: "image",
            size_bytes: downloaded.bytes.byteLength,
            source: "platform_message",
            metadata: {
              ...(reference.metadata || {}), content_status: "stored", sha256: contentHash,
              download_source: "rms_inquiry_management_api",
            },
          }).eq("id", reference.id);
          if (updateError) throw updateError;
          report.attachmentsStored += 1;
        } catch {
          // Preserve reference-only evidence and retry on a later overlap or
          // reconciliation run. Never log customer filenames, paths, or bytes.
          report.attachmentErrors += 1;
        }
      }
    }
  }

  async function ingestInquiry(inquiry: Awaited<ReturnType<typeof client.get>>, resolvedAccountId: string) {
    const messages = normalizeInquiryMessages(inquiry);
    const { data, error } = await supabase.rpc("ingest_rakuten_rmesse_inquiry", {
      p_account_id: resolvedAccountId,
      p_shop_id: String(inquiry.shopId),
      p_inquiry_number: inquiry.inquiryNumber,
      p_order_number: inquiry.orderNumber,
      p_external_url: `https://rmesse.rms.rakuten.co.jp/inquiry/${encodeURIComponent(inquiry.inquiryNumber)}`,
      p_category: inquiry.category || null,
      p_last_update_date: inquiry.lastUpdateDate,
      p_messages: messages,
    });
    if (error) throw new Error(`rakuten_rmesse_ingest_failed:${error.message}`);
    report.ticketsCreated += data?.ticket_created ? 1 : 0;
    report.messagesInserted += Number(data?.messages_inserted || 0);
    report.attachmentsInserted += Number(data?.attachments_inserted || 0);
    if (data?.ticket_id) await storeAttachments(inquiry, String(data.ticket_id), messages);
  }

  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 20) {
    const list = await client.list({ fromDate: jstApiDate(from), toDate: jstApiDate(now), limit: 100, page });
    totalPages = Math.max(1, list.totalPageCount || 1);
    report.pages += 1;
    for (const summary of list.list || []) {
      report.scanned += 1;
      if (targetOrderNumber && String(summary.orderNumber || "").trim() !== targetOrderNumber) continue;
      if (!String(summary.orderNumber || "").trim()) {
        report.excludedWithoutOrder += 1;
        continue;
      }
      report.qualified += 1;
      const inquiry = await client.get(summary.inquiryNumber);
      processedInquiryNumbers.add(inquiry.inquiryNumber);
      report.detailsFetched += 1;
      if (!String(inquiry.orderNumber || "").trim()) {
        report.excludedWithoutOrder += 1;
        continue;
      }
      if (mode === "shadow") continue;

      if (!accountId) {
        const shopId = String(inquiry.shopId);
        const { data: account, error } = await supabase.from("platform_accounts")
          .select("id").eq("platform", "rakuten")
          .or(`seller_account_id.eq.${shopId},shop_code.eq.${shopId}`)
          .limit(1).maybeSingle();
        if (error) throw new Error(`rakuten_platform_account_lookup_failed:${error.message}`);
        if (account?.id) {
          accountId = account.id;
        } else {
          // Current Homebliss row predates seller_account_id. A single active
          // Rakuten account is an unambiguous fallback; multiple rows fail closed.
          const { data: candidates, error: candidateError } = await supabase.from("platform_accounts")
            .select("id").eq("platform", "rakuten").eq("status", "active").limit(2);
          if (candidateError || candidates?.length !== 1) {
            throw new Error(`rakuten_platform_account_not_found:${shopId}`);
          }
          accountId = candidates[0].id;
        }
      }

      if (!accountId) throw new Error("rakuten_platform_account_not_resolved");
      await ingestInquiry(inquiry, accountId);
    }
    page += 1;
  }

  // Inquiry list windows discover new threads, but they are not a durable
  // message watermark: an old inquiry can receive a reply without reappearing
  // in the short list window. Reconcile a bounded, oldest-first set of known
  // inquiries by direct detail reads on every active run (Issue #217).
  if (mode === "active" && !targetOrderNumber) {
    const reconciliationLimit = Math.min(100, Math.max(1,
      Number(env.RAKUTEN_RMESSE_RECONCILIATION_LIMIT || 25)));
    const reconciliationIntervalMinutes = Math.min(1440, Math.max(2,
      Number(env.RAKUTEN_RMESSE_RECONCILIATION_INTERVAL_MINUTES || 2)));
    const dueBefore = new Date(now.getTime() - reconciliationIntervalMinutes * 60 * 1000).toISOString();
    const { data: knownInquiries, error: knownError } = await supabase
      .from("rakuten_rmesse_inquiries")
      .select("account_id,inquiry_number,shop_id,order_number,last_ingested_at")
      .lte("last_ingested_at", dueBefore)
      .order("last_ingested_at", { ascending: true })
      .limit(reconciliationLimit);
    if (knownError) throw new Error(`rakuten_rmesse_reconciliation_lookup_failed:${knownError.message}`);

    report.reconciliationCandidates = knownInquiries?.length || 0;
    for (const known of knownInquiries || []) {
      const inquiryNumber = String(known.inquiry_number || "").trim();
      if (!inquiryNumber || processedInquiryNumbers.has(inquiryNumber)) continue;
      try {
        const inquiry = await client.get(inquiryNumber);
        report.detailsFetched += 1;
        report.reconciliationFetched += 1;
        if (!String(inquiry.orderNumber || "").trim() ||
            String(inquiry.orderNumber).trim() !== String(known.order_number || "").trim()) {
          report.reconciliationErrors += 1;
          continue;
        }
        await ingestInquiry(inquiry, String(known.account_id));
      } catch {
        // A failed inquiry keeps its old last_ingested_at, so oldest-first
        // selection retries it on the next run. Keep error bodies and customer
        // data out of logs; the cron emits only the aggregate count.
        report.reconciliationErrors += 1;
      }
    }
  }

  if (mode === "active" && accountId && !targetOrderNumber) {
    const { error: checkpointError } = await supabase.rpc("upsert_rakuten_rmesse_sync_state_v1", {
      p_account_id: accountId,
      p_cursor_updated_at: now.toISOString(),
      p_last_success_at: now.toISOString(),
    });
    if (checkpointError) {
      throw new Error(`rakuten_rmesse_checkpoint_failed:${checkpointError.message}`);
    }
  }
  return report;
}
