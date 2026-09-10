export interface ZohoMailConfig {
  accountsBase: string;
  apiBase: string;
  accountId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fromAddress: string;
}

export interface ZohoMessageSummary {
  messageId: string;
  folderId: string;
  threadId?: string;
  receivedTime: string;
  sentDateInGMT?: string;
  subject: string;
  summary?: string;
  fromAddress: string;
  toAddress?: string;
  hasAttachment: boolean;
  hasInline: boolean;
  size: number | null;
}

export interface ZohoAttachmentInfo {
  attachmentId: string;
  attachmentName?: string;
  attachmentSize?: number;
  contentType?: string;
  isInline?: boolean;
}

export interface MailAuthenticationResult {
  status: "pass" | "failed" | "unavailable";
  domain: string | null;
  dkim: string | null;
  dmarc: string | null;
  spf: string | null;
}

export class ZohoMailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ZohoMailError";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function boolValue(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function headerValues(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    result[key.toLowerCase()] = values;
  }
  return result;
}

function authToken(value: string, name: "dkim" | "dmarc" | "spf"): string | null {
  return value.match(new RegExp(`(?:^|[;\\s])${name}=([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? null;
}

function alignedDomain(value: string): string | null {
  const from = value.match(/header\.from=([^\s;]+)/i)?.[1]
    ?.replace(/[>'"]/g, "")
    .split("@")
    .pop()
    ?.toLowerCase();
  const dkim = value.match(/header\.d=([a-z0-9._-]+)/i)?.[1]?.toLowerCase();
  return from || dkim || null;
}

export function parseAuthenticationResults(rawHeaders: unknown): MailAuthenticationResult {
  const headers = headerValues(rawHeaders);
  const auth = [...(headers["authentication-results"] || []), ...(headers["arc-authentication-results"] || [])].join("; ");
  if (!auth) return { status: "unavailable", domain: null, dkim: null, dmarc: null, spf: null };
  const dkim = authToken(auth, "dkim");
  const dmarc = authToken(auth, "dmarc");
  const spf = authToken(auth, "spf");
  const domain = alignedDomain(auth);
  const amazonAligned = domain === "amazon.co.jp" || domain?.endsWith(".amazon.co.jp") === true;
  const passed = dkim === "pass" && dmarc === "pass" && amazonAligned;
  return { status: passed ? "pass" : "failed", domain, dkim, dmarc, spf };
}

export class ZohoMailClient {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: ZohoMailConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async searchMessages(input: {
    searchKey: string;
    start: number;
    limit: number;
    receivedTime?: string;
  }): Promise<ZohoMessageSummary[]> {
    const params = new URLSearchParams({
      searchKey: input.searchKey,
      start: String(input.start),
      limit: String(input.limit),
      includeto: "true",
    });
    if (input.receivedTime) params.set("receivedTime", input.receivedTime);
    const payload = await this.requestJson(`/accounts/${this.config.accountId}/messages/search?${params}`);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return rows.map((row) => this.mapSummary(row as Record<string, unknown>));
  }

  async getMessageDetails(folderId: string, messageId: string): Promise<ZohoMessageSummary> {
    const payload = await this.requestJson(
      `/accounts/${this.config.accountId}/folders/${folderId}/messages/${messageId}/details`,
    );
    return this.mapSummary((payload.data || payload) as Record<string, unknown>);
  }

  async getMessageContent(folderId: string, messageId: string): Promise<string> {
    const payload = await this.requestJson(
      `/accounts/${this.config.accountId}/folders/${folderId}/messages/${messageId}/content`,
    );
    const data = (payload.data || {}) as Record<string, unknown>;
    return stringValue(data.content);
  }

  async getAuthentication(folderId: string, messageId: string): Promise<MailAuthenticationResult> {
    const payload = await this.requestJson(
      `/accounts/${this.config.accountId}/folders/${folderId}/messages/${messageId}/header?raw=false`,
    );
    const raw = payload.headerContent || (payload.data as Record<string, unknown> | undefined)?.headerContent;
    return parseAuthenticationResults(raw);
  }

  async getAttachmentInfo(folderId: string, messageId: string): Promise<ZohoAttachmentInfo[]> {
    const payload = await this.requestJson(
      `/accounts/${this.config.accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo?includeInline=false`,
    );
    const data = payload.data as unknown;
    const rows = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).attachments)
        ? (data as Record<string, unknown>).attachments as unknown[]
        : [];
    return rows.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        attachmentId: stringValue(row.attachmentId || row.attachId),
        attachmentName: stringValue(row.attachmentName || row.fileName) || undefined,
        attachmentSize: Number.isFinite(Number(row.attachmentSize || row.size)) ? Number(row.attachmentSize || row.size) : undefined,
        contentType: stringValue(row.contentType || row.mimeType) || undefined,
        isInline: boolValue(row.isInline),
      };
    }).filter((item) => item.attachmentId);
  }

  async downloadAttachment(folderId: string, messageId: string, attachmentId: string): Promise<Response> {
    return this.request(
      `/accounts/${this.config.accountId}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`,
    );
  }

  async reply(input: {
    messageId: string;
    toAddress: string;
    subject: string;
    content: string;
  }): Promise<{ messageId: string; sentTime: string }> {
    const payload = await this.requestJson(
      `/accounts/${this.config.accountId}/messages/${input.messageId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAddress: this.config.fromAddress,
          toAddress: input.toAddress,
          subject: input.subject,
          content: input.content,
          action: "reply",
          mailFormat: "plaintext",
          encoding: "UTF-8",
        }),
      },
    );
    const data = (payload.data || payload) as Record<string, unknown>;
    const messageId = stringValue(data.messageId || data.mailId);
    if (!messageId) throw new ZohoMailError("Zoho reply returned no message ID", "REPLY_ID_MISSING", 502);
    return { messageId, sentTime: new Date().toISOString() };
  }

  private mapSummary(row: Record<string, unknown>): ZohoMessageSummary {
    return {
      messageId: stringValue(row.messageId),
      folderId: stringValue(row.folderId),
      threadId: stringValue(row.threadId) || undefined,
      receivedTime: stringValue(row.receivedTime),
      sentDateInGMT: stringValue(row.sentDateInGMT) || undefined,
      subject: stringValue(row.subject),
      summary: stringValue(row.summary) || undefined,
      fromAddress: stringValue(row.fromAddress || row.sender),
      toAddress: stringValue(row.toAddress) || undefined,
      hasAttachment: boolValue(row.hasAttachment),
      hasInline: boolValue(row.hasInline),
      size: Number.isFinite(Number(row.size)) ? Number(row.size) : null,
    };
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const body = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.fetchImpl(`${normalizeBase(this.config.accountsBase)}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const token = stringValue(payload.access_token);
    if (!response.ok || !token) throw new ZohoMailError("Zoho OAuth refresh failed", "OAUTH_REFRESH_FAILED", 503);
    this.accessToken = { value: token, expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3600)) * 1000 };
    return token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    const response = await this.fetchImpl(`${normalizeBase(this.config.apiBase)}${path}`, {
      ...init,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(init.headers || {}) },
    });
    if (!response.ok) throw new ZohoMailError("Zoho Mail request failed", `ZOHO_HTTP_${response.status}`, response.status);
    return response;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.request(path, init);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) throw new ZohoMailError("Zoho Mail returned invalid JSON", "ZOHO_INVALID_JSON", 502);
    const status = payload.status as Record<string, unknown> | undefined;
    if (status && Number(status.code || 200) >= 400) {
      throw new ZohoMailError("Zoho Mail API returned an error", `ZOHO_API_${stringValue(status.code)}`, 502);
    }
    return payload;
  }
}
