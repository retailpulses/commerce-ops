import { TicketShareDTO } from "../types.js";
import { Config } from "../config.js";
import {
  computeHmacSignature,
  generateNonce,
  generateTimestamp,
} from "./hmac.js";
import { log } from "./logger.js";
import { isValidAttachmentId } from "../utils/validation.js";

const MAX_BRIDGE_RESPONSE_BYTES = 256 * 1024;

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isTicketShareDto(value: unknown): value is TicketShareDTO {
  if (!value || typeof value !== "object") return false;
  const dto = value as Record<string, unknown>;
  const stringsValid = [
    dto.ticketNumber,
    dto.platform,
    dto.shopName,
    dto.externalOrderId,
    dto.status,
    dto.priority,
    dto.startedDate,
    dto.sellerDescription,
    dto.expiry,
  ].every((entry) => boundedString(entry, 5000));
  if (!stringsValid
      || !Array.isArray(dto.issueTypes)
      || dto.issueTypes.length > 50
      || !dto.issueTypes.every((entry) => boundedString(entry, 200))
      || !Array.isArray(dto.products)
      || dto.products.length > 100
      || !Array.isArray(dto.evidence)
      || dto.evidence.length > 50
      || Number.isNaN(Date.parse(dto.expiry as string))) {
    return false;
  }
  const productsValid = dto.products.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const product = entry as Record<string, unknown>;
    return [product.sku, product.name, product.variant, product.role, product.seller, product.unitPrice]
      .every((field) => boundedString(field, 1000));
  });
  const evidenceValid = dto.evidence.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const evidence = entry as Record<string, unknown>;
    return typeof evidence.attachmentId === "string"
      && isValidAttachmentId(evidence.attachmentId)
      && boundedString(evidence.fileName, 1000)
      && boundedString(evidence.mimeType, 200)
      && typeof evidence.size === "number"
      && Number.isSafeInteger(evidence.size)
      && evidence.size >= 0;
  });
  return productsValid && evidenceValid;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export class BridgeClient {
  constructor(
    private readonly config: Config,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private signAndPost(
    path: string,
    body: unknown,
  ): { headers: Record<string, string>; body: string } {
    const timestamp = generateTimestamp();
    const nonce = generateNonce();
    const bodyStr = JSON.stringify(body);
    const signature = computeHmacSignature(
      this.config.bridgeHmacSecret,
      "POST",
      path,
      timestamp,
      nonce,
      bodyStr,
    );

    return {
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
      },
      body: bodyStr,
    };
  }

  private async readBoundedJson(response: Response, path: string): Promise<unknown> {
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BRIDGE_RESPONSE_BYTES) {
      log.error("bridge response exceeded size limit", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BRIDGE_RESPONSE_BYTES) {
      log.error("bridge response exceeded size limit", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      log.error("bridge returned invalid JSON", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }
  }

  async resolveToken(token: string): Promise<TicketShareDTO> {
    const path = "/api/internal/ticket-shares/resolve";
    const { headers, body } = this.signAndPost(path, { token });

    const url = `${this.config.workerBaseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.bridgeTimeoutMs),
      });
    } catch (err) {
      log.error("bridge resolve request failed", {
        path,
        error: String(err),
      });
      throw new BridgeError(
        "Service temporarily unavailable",
        502,
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new BridgeError("Not found", 404);
      }
      if (response.status === 410) {
        throw new BridgeError("Not found", 404);
      }
      log.error("bridge resolve returned error", {
        path,
        status: String(response.status),
      });
      throw new BridgeError(
        "Service temporarily unavailable",
        response.status >= 500 ? 502 : 502,
      );
    }

    const data = await this.readBoundedJson(response, path);
    if (!isTicketShareDto(data)) {
      log.error("bridge resolve returned unexpected shape", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }

    return data as TicketShareDTO;
  }

  async getEvidenceUrl(
    token: string,
    attachmentId: string,
  ): Promise<{ url: string; fileName: string; mimeType: string; size: number }> {
    const path = "/api/internal/ticket-shares/evidence";
    const { headers, body } = this.signAndPost(path, { token, attachmentId });

    const url = `${this.config.workerBaseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.bridgeTimeoutMs),
      });
    } catch (err) {
      log.error("bridge evidence request failed", {
        path,
        error: String(err),
      });
      throw new BridgeError("Service temporarily unavailable", 502);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new BridgeError("Not found", 404);
      }
      if (response.status === 410) {
        throw new BridgeError("Not found", 404);
      }
      log.error("bridge evidence returned error", {
        path,
        status: String(response.status),
      });
      throw new BridgeError(
        "Service temporarily unavailable",
        response.status >= 500 ? 502 : 502,
      );
    }

    const data = await this.readBoundedJson(response, path);
    if (!data || typeof data !== "object") {
      log.error("bridge evidence returned unexpected shape", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }

    const d = data as Record<string, unknown>;
    if (!boundedString(d.url, 8192)
        || !boundedString(d.fileName, 1000)
        || !boundedString(d.mimeType, 200)
        || typeof d.size !== "number"
        || !Number.isSafeInteger(d.size)
        || d.size < 0
        || typeof d.upstreamExpiresIn !== "number"
        || !Number.isSafeInteger(d.upstreamExpiresIn)
        || d.upstreamExpiresIn <= 0
        || d.upstreamExpiresIn > this.config.evidenceUrlTtlSeconds) {
      log.error("bridge evidence returned unexpected shape", { path });
      throw new BridgeError("Service temporarily unavailable", 502);
    }
    return {
      url: d.url,
      fileName: d.fileName,
      mimeType: d.mimeType,
      size: d.size,
    };
  }
}
