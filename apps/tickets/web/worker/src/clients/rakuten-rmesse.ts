export interface RakutenRmesseReply {
  id: number | string;
  message: string;
  regDate: string;
  replyFrom: "merchant" | "user" | string;
  isRead?: boolean;
  isMessageDeleted?: boolean;
  attachments?: Array<{ label: string; path: string }>;
}

export interface RakutenRmesseInquiry {
  inquiryNumber: string;
  shopId: number | string;
  orderNumber?: string | null;
  userName?: string | null;
  message?: string | null;
  regDate: string;
  lastUpdateDate: string;
  category?: string | null;
  type?: string | null;
  isCompleted?: boolean;
  readByMerchant?: boolean;
  isMessageDeleted?: boolean;
  replies?: RakutenRmesseReply[];
  attachments?: Array<{ label: string; path: string }>;
}

export interface RakutenRmesseRelayConfig {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

export function createRakutenRmesseClient(config: RakutenRmesseRelayConfig) {
  const baseUrl = config.url.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl || fetch;
  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-secret": config.secret },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as T & { ok?: boolean; error?: string };
    if (!response.ok || payload.ok === false) {
      throw new Error(`rakuten_rmesse_relay_failed:${response.status}`);
    }
    return payload;
  }
  async function postBinary(path: string, body: Record<string, unknown>) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-secret": config.secret },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`rakuten_rmesse_relay_failed:${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > 20 * 1024 * 1024) throw new Error("rakuten_rmesse_attachment_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("rakuten_rmesse_attachment_too_large");
    return {
      bytes,
      contentType: String(response.headers.get("content-type") || "application/octet-stream")
        .split(";", 1)[0].trim().toLowerCase(),
    };
  }
  return {
    list: (input: { fromDate: string; toDate: string; limit?: number; page?: number }) =>
      post<{ ok: true; totalCount: number; totalPageCount: number; page: number; list: RakutenRmesseInquiry[] }>(
        "/admin/rakuten-inquiries", input,
      ),
    get: async (inquiryNumber: string) => {
      const payload = await post<{ ok: true; result: RakutenRmesseInquiry }>(
        "/admin/rakuten-inquiry", { inquiryNumber },
      );
      return payload.result;
    },
    downloadAttachment: (input: { label: string; path: string }) =>
      postBinary("/admin/rakuten-inquiry-attachment", input),
    reply: async (input: { inquiryNumber: string; shopId: string; message: string }) => {
      const payload = await post<{ ok: true; result: { inquiryNumber: string; message: string; regDate: string; replyFrom: string } }>(
        "/admin/rakuten-inquiry-reply", input,
      );
      return payload.result;
    },
  };
}

export function nativeMessageId(inquiryNumber: string, reply?: RakutenRmesseReply): string {
  return reply ? `rakuten:${inquiryNumber}:reply:${reply.id}` : `rakuten:${inquiryNumber}:initial`;
}

export function normalizeInquiryMessages(inquiry: RakutenRmesseInquiry) {
  const messages: Array<{
    external_message_id: string;
    sender_type: "customer" | "seller" | "system";
    body: string;
    sent_at: string;
    attachments: Array<{ label: string; path: string; mime_type: string | null }>;
  }> = [];
  const normalizeAttachments = (attachments: Array<{ label: string; path: string }> | undefined) =>
    (attachments || []).filter((attachment) => attachment.label && attachment.path).map((attachment) => ({
      label: attachment.label,
      path: attachment.path,
      mime_type: mimeTypeFromFilename(attachment.label),
    }));
  if ((inquiry.message || inquiry.attachments?.length) && !inquiry.isMessageDeleted) {
    messages.push({
      external_message_id: nativeMessageId(inquiry.inquiryNumber),
      // InquiryManagementAPI does not expose the origin of the initial
      // message. Treat it as direction-unknown: assigning it to the customer
      // can turn a merchant-initiated notice into a false reply/ticket.
      sender_type: "system",
      body: inquiry.message || "[R-Message attachment]",
      sent_at: inquiry.regDate,
      attachments: normalizeAttachments(inquiry.attachments),
    });
  }
  for (const reply of inquiry.replies || []) {
    if ((!reply.message && !reply.attachments?.length) || reply.isMessageDeleted) continue;
    messages.push({
      external_message_id: nativeMessageId(inquiry.inquiryNumber, reply),
      sender_type: reply.replyFrom === "merchant" ? "seller" : "customer",
      body: reply.message || "[R-Message attachment]",
      sent_at: reply.regDate,
      attachments: normalizeAttachments(reply.attachments),
    });
  }
  return messages.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
}

function mimeTypeFromFilename(filename: string): string | null {
  const extension = filename.toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[extension || ""] || null;
}
