/**
 * Customer Form Handler — public-facing ticket evidence submission.
 * Replaces Baserow Ticket Form (table 893037).
 *
 * Routes:
 *   GET  /forms/after-sales/:token  — serve public form HTML
 *   POST /api/forms/submit/:token    — handle form submission
 */

import { getSupabaseClient } from "../repositories/supabase";
import type { Env } from "../types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ticketFormValidityCopy } from "../logic/ticketform-validity";

export const CUSTOMER_FORM_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_COUNT = 5;
const SUPPORTED_EVIDENCE_MIME_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/heic", "image/heif", "image/avif",
  "video/mp4", "video/quicktime", "video/webm",
]);

// ── Helpers ──

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function errorJson(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

// ── Form HTML (Japanese, mobile-first) ──

function formHtml(token: string, context: FormContext, error?: string): string {
  const { platform, orderId, shopName, expiresAt } = context;
  const orderLabel = orderId ? `ご注文 #${esc(orderId)}` : "";
  const shopLabel = shopName ? `${esc(shopName)}` : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>ホムブリスカスタマサポート</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f5f5f5;--surface:#fff;--accent:#0f3460;--accent-light:#1a4a8a;--danger:#dc2626;--success:#16a34a;--border:#e5e7eb;--text:#1f2937;--text-muted:#6b7280;--radius:8px}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP","Hiragino Kaku Gothic ProN",sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;line-height:1.6}
.container{max-width:600px;margin:0 auto;padding:20px 16px 40px}
.header{background:var(--accent);color:#fff;padding:16px 20px;text-align:center;border-radius:0 0 var(--radius) var(--radius);margin-bottom:20px}
.header h1{font-size:1.1rem;font-weight:700}
.header p{font-size:.8rem;opacity:.85;margin-top:4px}
.card{background:var(--surface);border-radius:var(--radius);padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h2{font-size:.95rem;font-weight:700;margin-bottom:12px;color:var(--text)}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:.8rem;font-weight:600;color:var(--text-muted);margin-bottom:4px}
.form-group label .required{color:var(--danger);margin-left:2px}
.form-group textarea,.form-group input[type="text"]{width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:.9rem;font-family:inherit;line-height:1.5;resize:vertical;-webkit-appearance:none}
.form-group textarea:focus,.form-group input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px rgba(15,52,96,.1)}
.form-group textarea{min-height:100px}
.form-group input[type="file"]{width:100%;padding:10px 12px;border:1.5px dashed var(--border);border-radius:var(--radius);font-size:.85rem;background:#fafafa;cursor:pointer}
.form-group input[type="file"]:hover{border-color:var(--accent)}
.file-hint{font-size:.7rem;color:var(--text-muted);margin-top:4px}
.error-msg{background:#fef2f2;color:var(--danger);padding:12px;border-radius:var(--radius);font-size:.85rem;margin-bottom:16px;border:1px solid #fecaca}
.success-msg{background:#f0fdf4;color:var(--success);padding:16px;border-radius:var(--radius);font-size:.9rem;text-align:center;border:1px solid #bbf7d0}
.success-msg h2{font-size:1rem;margin-bottom:8px}
.submit-btn{width:100%;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);font-size:.95rem;font-weight:700;cursor:pointer;transition:background .15s;font-family:inherit}
.submit-btn:hover{background:var(--accent-light)}
.submit-btn:disabled{opacity:.5;cursor:not-allowed}
.submit-btn .spinner{display:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle}
.submit-btn.loading .spinner{display:inline-block}
.submit-btn.loading .btn-text{display:none}
.footer{text-align:center;font-size:.7rem;color:var(--text-muted);margin-top:24px}
.order-badge{display:inline-block;background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600;margin:4px 0}
.validity-notice{background:#eff6ff;color:#1e3a5f;border:1px solid #bfdbfe;border-radius:var(--radius);padding:10px 12px;margin-bottom:16px;font-size:.78rem}
.error-page{text-align:center;padding:60px 20px}
.error-page h2{font-size:1.2rem;color:var(--danger);margin-bottom:8px}
.error-page p{color:var(--text-muted);font-size:.9rem}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:480px){.container{padding:12px 10px 32px}.header{padding:14px 16px;border-radius:0}.card{padding:16px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>ホムブリスカスタマサポート</h1>
    ${orderLabel ? `<p>${orderLabel}</p>` : ""}
    ${shopLabel ? `<p>${shopLabel}</p>` : ""}
  </div>
  ${error ? `<div class="error-msg">${esc(error)}</div>` : ""}
  <form id="submission-form" class="card" enctype="multipart/form-data">
    <h2>&#x1F4DD; ご状況をお知らせください</h2>

    <p class="validity-notice">${esc(ticketFormValidityCopy(expiresAt))}</p>

    <div class="form-group">
      <label for="description">問題の詳細 <span class="required">*</span></label>
      <textarea id="description" name="description" required autofocus></textarea>
    </div>

    <div class="form-group">
      <label for="expected">ご希望の対応</label>
      <textarea id="expected" name="expected"></textarea>
    </div>

    <div class="form-group">
      <label for="files">&#x1F4F7; 写真・動画（最大5個、1個100MBまで）</label>
      <input type="file" id="files" name="files" accept="image/*,video/*" multiple />
      <p class="file-hint">傷や破損の状況がわかる写真または動画を添付してください</p>
    </div>

    <div id="upload-progress" style="display:none;margin-bottom:12px;font-size:.8rem;color:var(--text-muted)"></div>

    <button type="submit" class="submit-btn" id="submit-btn">
      <span class="spinner"></span>
      <span class="btn-text">送信する</span>
    </button>
  </form>
  <div class="footer">
    Homebliss カスタマーサポート &middot; ${esc(platform || "Mercari")}
  </div>
</div>
<script>
var TOKEN = ${JSON.stringify(token)};
var form = document.getElementById("submission-form");
var btn = document.getElementById("submit-btn");
var progress = document.getElementById("upload-progress");
var pendingFinalization = null;

function uploadDirect(signedUrl, file, index, total) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = function(event) {
      if (!event.lengthComputable) return;
      var percent = Math.round((event.loaded / event.total) * 100);
      progress.textContent = "アップロード " + (index + 1) + "/" + total + ": " + percent + "%";
    };
    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("upload_failed_" + xhr.status));
    };
    xhr.onerror = function() { reject(new Error("upload_network_error")); };
    xhr.send(file);
  });
}

async function uploadDirectWithRetry(signedUrl, file, index, total) {
  var lastError;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await uploadDirect(signedUrl, file, index, total);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        progress.textContent = "アップロード " + (index + 1) + "/" + total + " を再試行中 (" + attempt + "/2)...";
        await new Promise(function(resolve) { setTimeout(resolve, attempt * 750); });
      }
    }
  }
  throw lastError;
}

form.addEventListener("submit", async function(ev) {
  ev.preventDefault();
  var desc = document.getElementById("description").value.trim();
  if (!desc) return;

  btn.classList.add("loading");
  btn.disabled = true;

  var fileInput = document.getElementById("files");
  var files = fileInput.files;
  if (files.length > 5) {
    alert("写真は最大5枚までです");
    btn.classList.remove("loading");
    btn.disabled = false;
    return;
  }
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.size > 100 * 1024 * 1024) {
      alert(f.name + " が100MBを超えています");
      btn.classList.remove("loading");
      btn.disabled = false;
      return;
    }
  }

  try {
    progress.style.display = "block";
    if (!pendingFinalization) {
      progress.textContent = "アップロードを準備中...";
      var prepareResponse = await fetch("/api/forms/uploads/" + TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: Array.from(files).map(function(file) {
          return { filename: file.name, mime_type: file.type, size_bytes: file.size };
        }) })
      });
      var prepared = await prepareResponse.json().catch(function(){ return {}; });
      if (!prepareResponse.ok) throw Object.assign(new Error(prepared.error || "upload_prepare_failed"), { userMessage: prepared.error });

      for (var uploadIndex = 0; uploadIndex < prepared.uploads.length; uploadIndex++) {
        await uploadDirectWithRetry(prepared.uploads[uploadIndex].signed_url, files[uploadIndex], uploadIndex, files.length);
      }
      pendingFinalization = {
        submission_id: prepared.submission_id,
        attachments: prepared.uploads.map(function(upload) {
          return {
            id: upload.id,
            storage_bucket: upload.storage_bucket,
            storage_path: upload.storage_path,
            filename: upload.filename,
            mime_type: upload.mime_type,
            media_type: upload.media_type,
            size_bytes: upload.size_bytes
          };
        })
      };
    }

    progress.textContent = "送信内容を確定中...";
    var r = await fetch("/api/forms/finalize/" + TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submission_id: pendingFinalization.submission_id,
        issue_description: desc,
        expected_solution: document.getElementById("expected").value.trim(),
        attachments: pendingFinalization.attachments
      })
    });
    if (r.ok) {
      form.innerHTML = '<div class="success-msg"><h2>&#x2705; 送信が完了しました</h2><p>ご連絡いただきありがとうございます。<br>内容を確認の上、ご連絡いたします。</p></div>';
    } else {
      var d = await r.json().catch(function(){ return {} });
      if (!d.evidence_preserved) pendingFinalization = null;
      var errEl = document.createElement("div");
      errEl.className = "error-msg";
      errEl.textContent = d.error || "送信に失敗しました。時間をおいて再度お試しください。";
      form.insertBefore(errEl, form.firstChild);
      progress.style.display = "none";
    }
  } catch(e) {
    var errEl2 = document.createElement("div");
    errEl2.className = "error-msg";
    errEl2.textContent = e.userMessage || "アップロード中に通信エラーが発生しました。通信環境をご確認の上、再度お試しください。";
    form.insertBefore(errEl2, form.firstChild);
    progress.style.display = "none";
  }
  btn.classList.remove("loading");
  btn.disabled = false;
});
</script>
</body>
</html>`;
}

function errorPageHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ホムブリスカスタマサポート</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;background:#f5f5f5;color:#1f2937;min-height:100dvh;display:flex;align-items:center;justify-content:center}
.box{background:#fff;border-radius:12px;padding:40px 32px;text-align:center;max-width:400px;width:90%;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.box h2{font-size:1.1rem;margin-bottom:8px}
.box p{color:#6b7280;font-size:.9rem}
</style>
</head>
<body>
<div class="box">
  <h2>${esc(title)}</h2>
  <p>${esc(message)}</p>
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Types ──

interface FormContext {
  platform: string;
  accountId: string | null;
  shopName: string | null;
  orderId: string | null;
  ticketId: string | null;
  expiresAt: string;
}

interface TokenRecord {
  id: string;
  token_hash: string;
  ticket_id: string | null;
  platform: string | null;
  account_id: string | null;
  external_order_id: string | null;
  allowed_submission_type: string;
  status: string;
  expires_at: string;
  max_upload_count: number | null;
  used_count: number;
}

interface FormSubmitDependencies {
  supabase?: SupabaseClient;
  verifyStoredEvidence?: (attachment: UploadedAttachment) => Promise<{
    valid: boolean;
    error?: string;
  }>;
}

interface UploadedAttachment {
  id: string;
  storage_bucket: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  media_type: "image" | "video";
  size_bytes: number;
}

interface PreparedUpload extends UploadedAttachment {
  signed_url: string;
}

type FileValidationResult =
  | { files: File[] }
  | { error: string; status: number };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/** Verify declared evidence type against the stored object's leading bytes. */
export function evidenceSignatureMatches(mimeType: string, bytes: Uint8Array): boolean {
  const mime = mimeType.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value);
  }
  if (mime === "image/gif") return bytes.length >= 6 && /GIF8[79]a/.test(ascii(bytes, 0, 6));
  if (mime === "image/webp") {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  }
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/avif") {
    return bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp";
  }
  if (mime === "video/mp4" || mime === "video/quicktime") {
    return bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp";
  }
  if (mime === "video/webm") {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  return false;
}

async function verifyStoredEvidenceSignature(
  supabase: SupabaseClient,
  attachment: UploadedAttachment,
): Promise<{ valid: boolean; error?: string }> {
  const { data, error } = await supabase.storage
    .from(attachment.storage_bucket)
    .createSignedUrl(attachment.storage_path, 60);
  if (error || !data?.signedUrl) return { valid: false, error: error?.message || "signed_read_failed" };

  try {
    const response = await fetch(data.signedUrl, { headers: { Range: "bytes=0-31" } });
    if (!response.ok || !response.body) return { valid: false, error: `signature_read_http_${response.status}` };
    const reader = response.body.getReader();
    const header = new Uint8Array(32);
    let length = 0;
    while (length < header.length) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = header.length - length;
      const chunk = part.value.slice(0, remaining);
      header.set(chunk, length);
      length += chunk.length;
      if (part.value.length > remaining) break;
    }
    await reader.cancel().catch(() => undefined);
    return { valid: evidenceSignatureMatches(attachment.mime_type, header.slice(0, length)) };
  } catch (cause) {
    return { valid: false, error: String(cause) };
  }
}

/** Validate every selected entry before persisting the submission or consuming its token. */
export function validateCustomerFormFiles(
  rawFiles: unknown[],
  maxUploadCount = DEFAULT_MAX_UPLOAD_COUNT,
): FileValidationResult {
  if (rawFiles.length > maxUploadCount) {
    return { error: `添付ファイルは最大${maxUploadCount}個までです`, status: 422 };
  }

  const files: File[] = [];
  for (const entry of rawFiles) {
    if (!(entry instanceof File)) {
      return { error: "添付ファイルの形式が正しくありません", status: 422 };
    }
    if (!SUPPORTED_EVIDENCE_MIME_TYPES.has(entry.type.toLowerCase())) {
      return { error: `${entry.name} は対応していないファイル形式です`, status: 422 };
    }
    if (entry.size > CUSTOMER_FORM_MAX_FILE_SIZE_BYTES) {
      return { error: `${entry.name} が100MBを超えています`, status: 413 };
    }
    files.push(entry);
  }
  return { files };
}

async function finalizeUploadedEvidence(
  supabase: SupabaseClient,
  record: TokenRecord,
  submissionId: string,
  issueDescription: string,
  expectedSolution: string | null,
  attachments: UploadedAttachment[],
  rollbackObjects: () => Promise<void>,
): Promise<Response> {
  const success = (ticketId: string, replayed: boolean, createdTicket = false): Response => json({
    success: true,
    submission_id: submissionId,
    linked_ticket_id: ticketId,
    attachment_count: attachments.length,
    created_ticket: createdTicket,
    replayed,
    message: "送信が完了しました。ご連絡ありがとうございます。",
  });

  const reconcile = async (reason: string): Promise<Response> => {
    let currentToken: {
      status?: string;
      ticket_id?: string | null;
      customer_submission_id?: string | null;
    } | null = null;
    try {
      const verification = await supabase
        .from("submission_tokens")
        .select("status,ticket_id,customer_submission_id")
        .eq("id", record.id)
        .maybeSingle();
      if (verification.error) {
        console.error(`[CustomerForm] Finalization reconciliation failed (${reason}): ${verification.error.message}`);
        return json({
          error: "送信結果を確認中です。添付ファイルは保持されています。しばらくしてから再送信してください。",
          retryable: true,
          evidence_preserved: true,
        }, 503);
      }
      currentToken = verification.data;
    } catch (error) {
      console.error(`[CustomerForm] Finalization reconciliation threw (${reason}): ${String(error)}`);
      return json({
        error: "送信結果を確認中です。添付ファイルは保持されています。しばらくしてから再送信してください。",
        retryable: true,
        evidence_preserved: true,
      }, 503);
    }

    if (
      currentToken?.status === "used" &&
      currentToken.customer_submission_id === submissionId &&
      currentToken.ticket_id
    ) {
      const expectedPaths = attachments.map((attachment) => attachment.storage_path).sort();
      try {
        const linkedEvidence = await supabase
          .from("ticket_attachments")
          .select("storage_path")
          .eq("customer_submission_id", submissionId);
        if (linkedEvidence.error) {
          console.error(`[CustomerForm] Evidence reconciliation failed (${reason}): ${linkedEvidence.error.message}`);
          return json({
            error: "送信は確定済みですが、添付ファイルの照合中です。ファイルは保持されています。",
            retryable: true,
            evidence_preserved: true,
          }, 503);
        }
        const linkedPaths = (linkedEvidence.data || [])
          .map((row: { storage_path: string }) => row.storage_path)
          .sort();
        if (JSON.stringify(linkedPaths) !== JSON.stringify(expectedPaths)) {
          console.error(`[CustomerForm] Evidence path reconciliation mismatch (${reason})`);
          return json({
            error: "送信は確定済みですが、添付ファイルの内容を照合できませんでした。サポートへお問い合わせください。",
            retryable: false,
            evidence_preserved: true,
          }, 409);
        }
      } catch (error) {
        console.error(`[CustomerForm] Evidence reconciliation threw (${reason}): ${String(error)}`);
        return json({
          error: "送信は確定済みですが、添付ファイルの照合中です。ファイルは保持されています。",
          retryable: true,
          evidence_preserved: true,
        }, 503);
      }
      return success(currentToken.ticket_id, true);
    }

    if (currentToken?.status === "used" && currentToken.customer_submission_id !== submissionId) {
      await rollbackObjects();
      return json({
        error: "このフォームは別の送信で確定済みです。今回選択した添付ファイルは保存されていません。",
        retryable: false,
        evidence_preserved: false,
      }, 409);
    }

    // Only an authoritative active/unlinked read proves that no commit owns
    // this request's unique staging prefix. Otherwise preserve for recovery.
    if (currentToken?.status === "active" && !currentToken.customer_submission_id) {
      await rollbackObjects();
      return json({
        error: "送信の確定に失敗しました。再度お試しください。",
        retryable: true,
        evidence_preserved: false,
      }, 500);
    }

    return json({
      error: "送信結果を確認中です。添付ファイルは保持されています。サポートへお問い合わせください。",
      retryable: true,
      evidence_preserved: true,
    }, 503);
  };

  let finalizedRows: unknown;
  let finalizeError: { message: string } | null;
  try {
    const result = await supabase.rpc("finalize_ticketform_submission", {
      p_token_id: record.id,
      p_submission_id: submissionId,
      p_issue_description: issueDescription,
      p_expected_solution: expectedSolution,
      p_attachments: attachments,
    });
    finalizedRows = result.data;
    finalizeError = result.error;
  } catch (error) {
    console.error(`[CustomerForm] Finalization request threw: ${String(error)}`);
    return reconcile("rpc_threw");
  }

  if (finalizeError) {
    console.error(`[CustomerForm] Finalization failed: ${finalizeError.message}`);
    return reconcile("rpc_error");
  }

  const finalized = (Array.isArray(finalizedRows) ? finalizedRows[0] : finalizedRows) as {
    ticket_id?: string;
    submission_id?: string;
    created_ticket?: boolean;
    replayed?: boolean;
  } | null;
  if (!finalized?.ticket_id || !finalized?.submission_id) {
    console.error("[CustomerForm] Finalization returned no ticket/submission result");
    return reconcile("malformed_result");
  }
  if (finalized.submission_id !== submissionId) {
    console.error("[CustomerForm] Finalization replay belongs to another submission");
    await rollbackObjects();
    return json({
      error: "このフォームは別の送信で確定済みです。今回選択した添付ファイルは保存されていません。",
      retryable: false,
      evidence_preserved: false,
    }, 409);
  }

  return success(finalized.ticket_id, finalized.replayed === true, finalized.created_ticket === true);
}

// ── Token Resolution ──

/** Hash a plain token for DB lookup. Uses SHA-256, hex-encoded. */
async function hashToken(plain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveToken(
  env: Env,
  plainToken: string,
  client?: SupabaseClient,
  options: { allowUsed?: boolean } = {},
): Promise<{ record: TokenRecord; context: FormContext } | { error: string; status: number }> {
  if (!plainToken || plainToken.length < 8) {
    return { error: "URLが正しくありません", status: 400 };
  }

  const supabase = client ?? getSupabaseClient(env);
  const tokenHash = await hashToken(plainToken);

  const { data: record, error: dbErr } = await supabase
    .from("submission_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .single();

  if (dbErr || !record) {
    return { error: "このリンクは無効です。新しいリンクをお問い合わせください。", status: 404 };
  }

  const token = record as unknown as TokenRecord;

  if (token.status !== "active") {
    if (token.status === "used") {
      if (options.allowUsed && token.ticket_id) {
        return {
          record: token,
          context: {
            platform: token.platform ?? "mercari",
            accountId: token.account_id,
            shopName: null,
            orderId: token.external_order_id,
            ticketId: token.ticket_id,
            expiresAt: token.expires_at,
          },
        };
      }
      return { error: "このフォームはすでに送信済みです。", status: 410 };
    }
    if (token.status === "expired") {
      return { error: "このリンクの有効期限が切れています。", status: 410 };
    }
    return { error: "このリンクは現在ご利用いただけません。", status: 410 };
  }

  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    // Mark as expired
    await supabase
      .from("submission_tokens")
      .update({ status: "expired" })
      .eq("id", token.id);
    return { error: "このリンクの有効期限が切れています。", status: 410 };
  }

  // Resolve display context
  let shopName: string | null = null;
  if (token.account_id) {
    const { data: acct } = await supabase
      .from("platform_accounts")
      .select("display_name")
      .eq("id", token.account_id)
      .single();
    shopName = acct?.display_name ?? null;
  }

  return {
    record: token,
    context: {
      platform: token.platform ?? "mercari",
      accountId: token.account_id,
      shopName,
      orderId: token.external_order_id,
      ticketId: token.ticket_id,
      expiresAt: token.expires_at,
    },
  };
}

// ── Exported Handlers ──

/** GET /forms/after-sales/:token — serve the public form HTML */
export async function serveCustomerForm(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const resolved = await resolveToken(env, token);

  if ("error" in resolved) {
    return html(
      errorPageHtml(
        resolved.error === "このフォームはすでに送信済みです。"
          ? "送信済み"
          : resolved.error === "このリンクの有効期限が切れています。"
            ? "期限切れ"
            : "リンクエラー",
        resolved.error,
      ),
      resolved.status >= 400 ? resolved.status : 400,
    );
  }

  return html(formHtml(token, resolved.context));
}

/** POST /api/forms/uploads/:token — authorize direct private Storage uploads. */
export async function prepareCustomerFormUploads(
  request: Request,
  env: Env,
  token: string,
  dependencies: FormSubmitDependencies = {},
): Promise<Response> {
  const supabase = dependencies.supabase ?? getSupabaseClient(env);
  const resolved = await resolveToken(env, token, supabase);
  if ("error" in resolved) return errorJson(resolved.error, resolved.status);

  let body: { files?: Array<{ filename?: string; mime_type?: string; size_bytes?: number }> };
  try {
    body = await request.json();
  } catch {
    return errorJson("アップロード情報が正しくありません", 400);
  }
  const requested = Array.isArray(body.files) ? body.files : [];
  const maxCount = resolved.record.max_upload_count ?? DEFAULT_MAX_UPLOAD_COUNT;
  if (requested.length > maxCount) {
    return errorJson(`添付ファイルは最大${maxCount}個までです`, 422);
  }

  const submissionId = crypto.randomUUID();
  const bucket = "ticket-attachments";
  const uploads: PreparedUpload[] = [];
  for (const file of requested) {
    const filename = String(file.filename || "").trim();
    const mimeType = String(file.mime_type || "").trim().toLowerCase();
    const sizeBytes = Number(file.size_bytes);
    if (!filename || !SUPPORTED_EVIDENCE_MIME_TYPES.has(mimeType)) {
      return errorJson(`${filename || "ファイル"} は対応していないファイル形式です`, 422);
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > CUSTOMER_FORM_MAX_FILE_SIZE_BYTES) {
      return errorJson(`${filename} が100MBを超えています`, 413);
    }

    const id = crypto.randomUUID();
    const rawExtension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "bin";
    const extension = /^[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : "bin";
    const storagePath = `customer-submissions/${submissionId}/${id}.${extension}`;
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data) {
      console.error(`[CustomerForm] Signed upload creation failed: ${error?.message}`);
      return errorJson("アップロードの準備に失敗しました。再度お試しください。", 500);
    }
    uploads.push({
      id,
      storage_bucket: bucket,
      storage_path: storagePath,
      filename,
      mime_type: mimeType,
      media_type: mimeType.startsWith("video/") ? "video" : "image",
      size_bytes: sizeBytes,
      signed_url: data.signedUrl,
    });
  }

  return json({ submission_id: submissionId, uploads });
}

/** POST /api/forms/finalize/:token — verify staged objects and finalize the case. */
export async function finalizeCustomerFormSubmission(
  request: Request,
  env: Env,
  token: string,
  dependencies: FormSubmitDependencies = {},
): Promise<Response> {
  const supabase = dependencies.supabase ?? getSupabaseClient(env);
  const resolved = await resolveToken(env, token, supabase, { allowUsed: true });
  if ("error" in resolved) return errorJson(resolved.error, resolved.status);

  let body: {
    submission_id?: string;
    issue_description?: string;
    expected_solution?: string | null;
    attachments?: UploadedAttachment[];
  };
  try {
    body = await request.json();
  } catch {
    return errorJson("送信情報が正しくありません", 400);
  }

  const submissionId = String(body.submission_id || "");
  const issueDescription = String(body.issue_description || "").trim();
  const expectedSolution = body.expected_solution ? String(body.expected_solution).trim() : null;
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    return errorJson("送信IDが正しくありません", 422);
  }
  if (!issueDescription) return errorJson("問題の詳細は必須です", 422);
  const maxCount = resolved.record.max_upload_count ?? DEFAULT_MAX_UPLOAD_COUNT;
  if (attachments.length > maxCount) return errorJson(`添付ファイルは最大${maxCount}個までです`, 422);

  const prefix = `customer-submissions/${submissionId}/`;
  for (const attachment of attachments) {
    if (
      attachment.storage_bucket !== "ticket-attachments" ||
      !attachment.storage_path?.startsWith(prefix) ||
      !attachment.id ||
      !attachment.filename ||
      (attachment.media_type !== "image" && attachment.media_type !== "video") ||
      !Number.isFinite(attachment.size_bytes) ||
      attachment.size_bytes < 0 ||
      attachment.size_bytes > CUSTOMER_FORM_MAX_FILE_SIZE_BYTES
    ) {
      return errorJson("添付ファイル情報が正しくありません", 422);
    }
  }

  const rollbackObjects = async (): Promise<void> => {
    if (!attachments.length) return;
    const { error } = await supabase.storage
      .from("ticket-attachments")
      .remove(attachments.map((attachment) => attachment.storage_path));
    if (error) console.error(`[CustomerForm] Direct-upload cleanup failed: ${error.message}`);
  };

  const verifyEvidence = dependencies.verifyStoredEvidence
    ?? ((attachment: UploadedAttachment) => verifyStoredEvidenceSignature(supabase, attachment));
  for (const attachment of attachments) {
    const signature = await verifyEvidence(attachment);
    if (signature.error) {
      console.error(`[CustomerForm] Evidence signature verification unavailable: ${signature.error}`);
      return json({
        error: "添付ファイルの内容確認に失敗しました。時間をおいて再度お試しください。",
        evidence_preserved: true,
      }, 503);
    }
    if (!signature.valid) {
      console.error(`[CustomerForm] Evidence signature mismatch: ${attachment.storage_path}`);
      await rollbackObjects();
      return errorJson(`${attachment.filename} の内容とファイル形式が一致しません`, 422);
    }
  }

  return finalizeUploadedEvidence(
    supabase,
    resolved.record,
    submissionId,
    issueDescription,
    expectedSolution,
    attachments,
    rollbackObjects,
  );
}

/** POST /api/forms/submit/:token — handle form submission */
export async function handleFormSubmit(
  request: Request,
  env: Env,
  token: string,
  dependencies: FormSubmitDependencies = {},
): Promise<Response> {
  const supabase = dependencies.supabase ?? getSupabaseClient(env);
  const resolved = await resolveToken(env, token, supabase);
  if ("error" in resolved) {
    return errorJson(resolved.error, resolved.status);
  }

  const { record } = resolved;
  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorJson("フォームデータの解析に失敗しました", 400);
  }

  const issueDescription = (formData.get("issue_description") as string)?.trim() || "";
  const expectedSolution = (formData.get("expected_solution") as string)?.trim() || null;
  // Cloudflare Workers FormData.getAll() returns FormDataEntryValue[] (string | File)
  const rawFiles = formData.getAll("files");

  if (!issueDescription) {
    return errorJson("問題の詳細は必須です", 422);
  }

  const fileValidation = validateCustomerFormFiles(
    rawFiles,
    record.max_upload_count ?? DEFAULT_MAX_UPLOAD_COUNT,
  );
  if ("error" in fileValidation) {
    return errorJson(fileValidation.error, fileValidation.status);
  }
  const files = fileValidation.files;

  // Generate the final submission ID before upload. The transactional RPC
  // verifies that every object belongs to this server-selected staging prefix.
  const submissionId = crypto.randomUUID();

  // ── 1. Upload files to private Supabase Storage ──

  const uploadedAttachments: Array<{
    id: string;
    storage_bucket: string;
    filename: string;
    storage_path: string;
    mime_type: string;
    media_type: "image" | "video";
    size_bytes: number;
  }> = [];
  const uploadedPaths: string[] = [];
  const bucket = "ticket-attachments";

  const rollbackStagedObjects = async (): Promise<void> => {
    if (uploadedPaths.length > 0) {
      const { error: storageCleanupError } = await supabase.storage.from(bucket).remove(uploadedPaths);
      if (storageCleanupError) {
        console.error(`[CustomerForm] Storage cleanup failed: ${storageCleanupError.message}`);
      }
    }
  };

  if (files.length > 0) {
    // Ensure bucket exists (idempotent)
    await supabase.storage.createBucket(bucket, { public: false }).catch(() => {
      // Bucket likely exists — ignore
    });

    for (const file of files) {
      const fileExt = file.name.split(".").pop()?.toLowerCase() || "bin";
      const fileId = crypto.randomUUID();
      const storagePath = `customer-submissions/${submissionId}/${fileId}.${fileExt}`;

      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .upload(storagePath, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

      if (uploadErr) {
        console.error(`[CustomerForm] Upload failed for ${file.name}: ${uploadErr.message}`);
        await rollbackStagedObjects();
        return errorJson(`添付ファイル ${file.name} のアップロードに失敗しました。再度お試しください。`, 502);
      }
      uploadedPaths.push(storagePath);

      // Determine media type
      const mediaType = file.type.startsWith("video/") ? "video" : "image";
      uploadedAttachments.push({
        id: fileId,
        storage_bucket: bucket,
        filename: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        media_type: mediaType,
        size_bytes: file.size,
      });
    }
  }

  if (uploadedAttachments.length !== files.length) {
    console.error("[CustomerForm] Attachment reconciliation failed");
    await rollbackStagedObjects();
    return errorJson("添付ファイルをすべて保存できませんでした。再度お試しください。", 500);
  }

  // ── 2. Atomically finalize submission, ticket, evidence, events, and token ──
  return finalizeUploadedEvidence(
    supabase,
    record,
    submissionId,
    issueDescription,
    expectedSolution,
    uploadedAttachments,
    rollbackStagedObjects,
  );
}
