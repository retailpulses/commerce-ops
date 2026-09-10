const DEFAULT_BASE = "https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api";

export function createRakutenInquiryClient({
  serviceSecret,
  licenseKey,
  baseUrl = DEFAULT_BASE,
  fetchImpl = fetch,
}) {
  const secret = String(serviceSecret || "").trim();
  const license = String(licenseKey || "").trim();
  if (!secret || !license) throw new Error("rakuten_rms_credentials_missing");
  const authorization = `ESA ${Buffer.from(`${secret}:${license}`).toString("base64")}`;

  async function request(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 300) }; }
    if (!response.ok) {
      const error = new Error(`rakuten_inquiry_api_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function requestBinary(path) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Authorization: authorization, Accept: "*/*" },
    });
    if (!response.ok) {
      const error = new Error(`rakuten_inquiry_api_${response.status}`);
      error.status = response.status;
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: String(response.headers.get("content-type") || "application/octet-stream")
        .split(";", 1)[0].trim().toLowerCase(),
    };
  }

  return {
    async listInquiries({ fromDate, toDate, limit = 100, page = 1, noMerchantReply }) {
      const params = new URLSearchParams({
        fromDate: String(fromDate),
        toDate: String(toDate),
        limit: String(Math.min(100, Math.max(1, Number(limit) || 100))),
        page: String(Math.max(1, Number(page) || 1)),
      });
      if (typeof noMerchantReply === "boolean") params.set("noMerchantReply", String(noMerchantReply));
      return request(`/inquiries?${params.toString()}`);
    },

    async getInquiry(inquiryNumber) {
      const id = String(inquiryNumber || "").trim();
      if (!id) throw new Error("inquiry_number_required");
      return request(`/inquiry/${encodeURIComponent(id)}`);
    },

    async downloadAttachment({ label, path }) {
      // InquiryManagementAPI requires both values returned by inquiry.get;
      // neither the filename nor the opaque path is sufficient by itself.
      const attachmentLabel = String(label || "").trim();
      const attachmentPath = String(path || "").trim();
      if (!attachmentLabel) throw new Error("attachment_label_required");
      if (!attachmentPath) throw new Error("attachment_path_required");
      const params = new URLSearchParams({ label: attachmentLabel, path: attachmentPath });
      return requestBinary(`/attachment?${params.toString()}`);
    },

    async reply({ inquiryNumber, shopId, message, attachments = [] }) {
      const id = String(inquiryNumber || "").trim();
      const body = String(message || "").trim();
      const numericShopId = Number(shopId);
      if (!id) throw new Error("inquiry_number_required");
      if (!body) throw new Error("reply_message_required");
      if (!Number.isSafeInteger(numericShopId) || numericShopId <= 0) {
        throw new Error("shop_id_required");
      }
      const requestBody = { inquiryNumber: id, shopId: numericShopId, message: body };
      if (Array.isArray(attachments) && attachments.length > 0) {
        requestBody.attachments = attachments;
      }
      return request("/inquiry/reply", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });
    },
  };
}
