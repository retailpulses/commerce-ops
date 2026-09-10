import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";
import { ZohoMailClient } from "../clients/zoho-mail";

const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BUCKET = "ticket-attachments";

interface AttachmentMetadata {
  attachment_id: string;
  declared_size?: number | null;
  declared_mime?: string | null;
  filename?: string | null;
  state?: string;
  [key: string]: unknown;
}

interface ClaimedInbound {
  id: string;
  linked_ticket_id: string;
  provider_account_id: string;
  provider_folder_id: string;
  provider_message_id: string;
  provider_metadata: { attachments?: AttachmentMetadata[] };
  attachment_processing_attempts: number;
}

export interface AmazonAttachmentReport {
  claimed: number;
  stored: number;
  rejected: number;
  failed: number;
}

interface AttachmentFinalization {
  source_id: string;
  provider_metadata: Record<string, unknown>;
  status: "completed" | "failed";
  next_retry_at: string | null;
  error_code: string | null;
  evidence: Array<Record<string, unknown>>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("attachment_too_large");
  if (!response.body) throw new Error("attachment_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("attachment_too_large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function verifiedImage(contentTypeValue: string, bytes: Uint8Array) {
  const contentType = contentTypeValue.split(";", 1)[0].trim().toLowerCase();
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  const candidates = [
    { mimeType: "image/jpeg", extension: "jpg", matches: bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mimeType: "image/png", extension: "png", matches: bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value) },
    { mimeType: "image/gif", extension: "gif", matches: bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6)) },
    { mimeType: "image/webp", extension: "webp", matches: bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" },
  ];
  const match = candidates.find((candidate) => candidate.mimeType === contentType && candidate.matches);
  if (!match) throw new Error("attachment_image_signature_mismatch");
  return match;
}

function retryDelay(attempts: number): string {
  const minutes = Math.min(360, Math.max(2, 2 ** Math.min(attempts, 8)));
  const jitterMinutes = Math.random() * Math.max(1, minutes * 0.25);
  return new Date(Date.now() + (minutes + jitterMinutes) * 60_000).toISOString();
}

export async function reconcileAmazonMailAttachments(
  env: Env,
  supabase: SupabaseClient,
  client: ZohoMailClient,
): Promise<AmazonAttachmentReport> {
  const report = { claimed: 0, stored: 0, rejected: 0, failed: 0 };
  const limit = Math.min(100, Math.max(1, Number(env.AMAZON_MAIL_RECONCILIATION_LIMIT || 25)));
  const { data, error } = await supabase.rpc("claim_amazon_mail_attachments", { p_limit: limit });
  if (error) throw new Error(`amazon_attachment_claim_failed:${error.code || "unknown"}`);
  const rows = (Array.isArray(data) ? data : []) as ClaimedInbound[];
  report.claimed = rows.length;
  const finalizations: AttachmentFinalization[] = [];

  for (const row of rows) {
    const recoveryOnly = row.attachment_processing_attempts >= 5;
    const original = Array.isArray(row.provider_metadata?.attachments)
      ? row.provider_metadata.attachments
      : [];
    const updated: AttachmentMetadata[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    let retryableFailure = false;
    let terminalFailure = false;
    const attachmentNames = new Map<string, string>();
    try {
      const providerAttachments = await client.getAttachmentInfo(row.provider_folder_id, row.provider_message_id);
      for (const item of providerAttachments) {
        if (item.attachmentName) attachmentNames.set(item.attachmentId, item.attachmentName);
      }
    } catch {
      if (recoveryOnly) {
        // Filename recovery is optional in the final Storage-only recovery pass.
      } else {
      for (const attachment of original) {
        updated.push({ ...attachment, filename: undefined, state: "failed", error_code: "attachment_info_failed" });
        report.failed += 1;
      }
      retryableFailure = true;
      }
    }

    const messagePathHash = await sha256Hex(new TextEncoder().encode(
      `${row.provider_account_id}:${row.provider_message_id}`,
    ));
    const storagePrefix = `tickets/${row.linked_ticket_id}/amazon-zoho/${messagePathHash}`;
    let recoveryObjects: Array<{ name: string }> = [];
    if (recoveryOnly) {
      const { data: listed, error: listError } = await supabase.storage.from(BUCKET)
        .list(storagePrefix, { limit: MAX_ATTACHMENTS_PER_MESSAGE * 2 });
      if (listError) terminalFailure = true;
      else recoveryObjects = (Array.isArray(listed) ? listed : []) as Array<{ name: string }>;
    }

    for (const [index, attachment] of retryableFailure ? [] : original.entries()) {
      if (attachment.state === "stored" || attachment.state === "rejected") {
        updated.push({ ...attachment, filename: undefined });
        continue;
      }
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE || !attachment.attachment_id ||
          Number(attachment.declared_size || 0) > MAX_IMAGE_BYTES) {
        updated.push({ ...attachment, filename: undefined, state: "rejected", error_code: "attachment_policy_rejected" });
        report.rejected += 1;
        continue;
      }
      try {
        const referenceHash = await sha256Hex(new TextEncoder().encode(
          `${row.provider_account_id}:${row.provider_message_id}:${attachment.attachment_id}`,
        ));
        if (recoveryOnly) {
          const object = recoveryObjects.find((candidate) => candidate.name.includes(`-${referenceHash}.`));
          if (!object) throw new Error("attachment_recovery_object_missing");
          const storagePath = `${storagePrefix}/${object.name}`;
          const { data: blob, error: downloadError } = await supabase.storage.from(BUCKET).download(storagePath);
          if (downloadError || !blob) throw new Error("attachment_recovery_read_failed");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("attachment_too_large");
          const image = verifiedImage(blob.type || attachment.declared_mime || "", bytes);
          const contentHash = await sha256Hex(bytes);
          evidence.push({
            ticket_id: row.linked_ticket_id,
            storage_bucket: BUCKET,
            storage_path: storagePath,
            filename: attachmentNames.get(attachment.attachment_id) || null,
            mime_type: image.mimeType,
            media_type: "image",
            size_bytes: bytes.byteLength,
            source: "platform_message",
            metadata: {
              platform: "amazon", source: "amazon_zoho_mail",
              inbound_message_id: row.id, provider_attachment_id: attachment.attachment_id,
              sha256: contentHash, content_status: "stored",
            },
          });
          updated.push({ ...attachment, filename: undefined, state: "stored", mime_type: image.mimeType, size_bytes: bytes.byteLength, sha256: contentHash });
          report.stored += 1;
          continue;
        }
        const response = await client.downloadAttachment(
          row.provider_folder_id, row.provider_message_id, attachment.attachment_id,
        );
        const bytes = await readBounded(response);
        const image = verifiedImage(response.headers.get("content-type") || attachment.declared_mime || "", bytes);
        const contentHash = await sha256Hex(bytes);
        const storagePath = `${storagePrefix}/${contentHash}-${referenceHash}.${image.extension}`;
        const { error: uploadError } = await supabase.storage.from(BUCKET)
          .upload(storagePath, bytes, { contentType: image.mimeType, upsert: false });
        if (uploadError && !/already exists|duplicate/i.test(uploadError.message || "")) throw uploadError;

        evidence.push({
          ticket_id: row.linked_ticket_id,
          storage_bucket: BUCKET,
          storage_path: storagePath,
          filename: attachmentNames.get(attachment.attachment_id) || null,
          mime_type: image.mimeType,
          media_type: "image",
          size_bytes: bytes.byteLength,
          source: "platform_message",
          metadata: {
            platform: "amazon", source: "amazon_zoho_mail",
            inbound_message_id: row.id, provider_attachment_id: attachment.attachment_id,
            sha256: contentHash, content_status: "stored",
          },
        });
        updated.push({ ...attachment, filename: undefined, state: "stored", mime_type: image.mimeType, size_bytes: bytes.byteLength, sha256: contentHash });
        report.stored += 1;
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "attachment_processing_failed";
        if (code === "attachment_too_large" || code === "attachment_image_signature_mismatch") {
          updated.push({ ...attachment, filename: undefined, state: "rejected", error_code: code });
          report.rejected += 1;
        } else {
          updated.push({ ...attachment, filename: undefined, state: "failed", error_code: "attachment_processing_failed" });
          if (recoveryOnly) terminalFailure = true;
          else retryableFailure = true;
          report.failed += 1;
        }
      }
    }

    finalizations.push({
      source_id: row.id,
      provider_metadata: { ...(row.provider_metadata || {}), attachments: updated },
      status: retryableFailure || terminalFailure ? "failed" : "completed",
      next_retry_at: retryableFailure ? retryDelay(row.attachment_processing_attempts) : null,
      error_code: terminalFailure ? "attachment_retries_exhausted" : retryableFailure ? "attachment_processing_failed" : null,
      evidence,
    });
  }
  if (finalizations.length > 0) {
    const { error: finalizeError } = await supabase.rpc("finalize_amazon_mail_attachment_batch", {
      p_results: finalizations,
    });
    if (finalizeError) throw new Error(`amazon_attachment_finalize_failed:${finalizeError.code || "unknown"}`);
  }
  return report;
}
