import type {
  InquirySummary,
  InquiryDetail,
  Pagination,
  StatusInfo,
  CopywritePromptState,
  MessageTemplate,
  ListingOptimizationState,
  MainImageContextState,
  MainImageSchemaResult,
  MainImageCandidateResult,
  MainImageSavedAsset,
  InquiryMessage,
  FollowUpBucket,
  FollowUpQueueItem,
} from "../types/inquiry";
import type { ProductSearchResult, ProductDetail } from "../types/product";

const API_BASE = "/inquiry/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(
      `Unexpected API response: ${res.status} ${contentType || "unknown content type"}`,
    );
  }
  const data = (await res.json()) as T & { error?: string };

  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return data;
}

/** GET /api/inquiries */
export async function getInquiries(params: {
  status?: string;
  search?: string;
  shop?: string;
  inquiryType?: string;
  pageSize?: number;
  cursor?: number;
  minExpectedValue?: number | null;
  maxExpectedValue?: number | null;
}): Promise<{ data: InquirySummary[]; pagination: Pagination }> {
  const searchParams = new URLSearchParams({
    pageSize: String(params.pageSize || 20),
  });
  if (params.status && params.status !== "_all") {
    searchParams.set("status", params.status);
  }
  if (params.search) {
    searchParams.set("search", params.search);
  }
  if (params.shop && params.shop !== "_all") {
    searchParams.set("shop", params.shop);
  }
  if (params.inquiryType && params.inquiryType !== "_all") {
    searchParams.set("inquiryType", params.inquiryType);
  }
  if (params.cursor != null) {
    searchParams.set("cursor", String(params.cursor));
  }
  if (params.minExpectedValue != null) {
    searchParams.set("minExpectedValue", String(params.minExpectedValue));
  }
  if (params.maxExpectedValue != null) {
    searchParams.set("maxExpectedValue", String(params.maxExpectedValue));
  }
  return request(`/inquiries?${searchParams.toString()}`);
}

/** GET /api/inquiries/:id */
export async function getInquiry(id: number): Promise<InquiryDetail> {
  return request(`/inquiries/${id}`);
}

/** PATCH /api/inquiries/:id/status */
export async function updateStatus(
  id: number,
  statusKey: string,
): Promise<{ success: boolean; status: StatusInfo }> {
  return request(`/inquiries/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ statusKey }),
  });
}

/** PATCH /api/inquiries/:id/inquiry-type */
export async function updateInquiryType(
  id: number,
  inquiryTypeKey: string,
): Promise<{
  success: boolean;
  inquiryType: import("../types/inquiry").InquiryTypeInfo;
}> {
  return request(`/inquiries/${id}/inquiry-type`, {
    method: "PATCH",
    body: JSON.stringify({ inquiryTypeKey }),
  });
}

/** POST /api/inquiries/:id/product */
export async function linkProduct(
  inquiryId: number,
  productVariantId: string,
): Promise<{ success: boolean; product: ProductDetail | null }> {
  return request(`/inquiries/${inquiryId}/product`, {
    method: "POST",
    body: JSON.stringify({ productVariantId }),
  });
}

/** DELETE /api/inquiries/:id/product */
export async function unlinkProduct(
  inquiryId: number,
  linkId: number,
): Promise<{ success: boolean }> {
  return request(`/inquiries/${inquiryId}/product`, {
    method: "DELETE",
    body: JSON.stringify({ linkId }),
  });
}

/** GET /api/config */
export async function getMutationConfig(): Promise<{
  mutationsEnabled: boolean;
}> {
  return request("/config");
}

/** POST /api/inquiries/:id/draft-reply */
export async function saveDraft(
  id: number,
  draft: string,
): Promise<{ success: boolean }> {
  return request(`/inquiries/${id}/draft-reply`, {
    method: "POST",
    body: JSON.stringify({ draft }),
  });
}

/** POST /api/inquiries/:id/copywrite */
export async function copywriteDraft(
  id: number,
  rawText: string,
): Promise<{ success: boolean; result: string; promptVersion: number }> {
  return request(`/inquiries/${id}/copywrite`, {
    method: "POST",
    body: JSON.stringify({ rawText }),
  });
}

/** GET /api/prompts/copywrite — get active prompt and version history */
export async function getCopywritePrompt(): Promise<CopywritePromptState> {
  return request("/prompts/copywrite");
}

/** PUT /api/prompts/copywrite — save a new prompt version */
export async function updateCopywritePrompt(
  text: string,
): Promise<{
  success: boolean;
  active: { version: number; text: string };
  versions: CopywritePromptState["versions"];
}> {
  return request("/prompts/copywrite", {
    method: "PUT",
    body: JSON.stringify({ text }),
  });
}

/** GET /api/products/search */
export async function searchProducts(
  query: string,
  shopKey?: string | null,
): Promise<{ data: ProductSearchResult[]; pagination: Pagination }> {
  const params = new URLSearchParams({ q: query });
  if (shopKey) params.set("shop", shopKey);
  return request(`/products/search?${params.toString()}`);
}

/** GET /api/templates */
export async function getTemplates(): Promise<{
  templates: MessageTemplate[];
}> {
  return request("/templates");
}

/** POST /api/templates */
export async function createTemplate(
  title: string,
  body: string,
): Promise<{ ok: boolean; template: MessageTemplate }> {
  return request("/templates", {
    method: "POST",
    body: JSON.stringify({ title, body }),
  });
}

/** PUT /api/templates/:id */
export async function updateTemplate(
  id: string,
  title: string,
  body: string,
): Promise<{ ok: boolean; template: MessageTemplate }> {
  return request(`/templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ title, body }),
  });
}

/** DELETE /api/templates/:id */
export async function deleteTemplate(id: string): Promise<{ ok: boolean }> {
  return request(`/templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** PATCH /api/inquiries/:id/units */
export async function updateUnits(
  id: number,
  units: number,
): Promise<{ success: boolean; expectedValue: number | null }> {
  return request(`/inquiries/${id}/units`, {
    method: "PATCH",
    body: JSON.stringify({ units }),
  });
}

export async function updateInquiryContent(
  id: number,
  content: string,
): Promise<{ success: boolean; content: string }> {
  return request(`/inquiries/${id}/content`, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export function getListingOptimization(
  id: number,
): Promise<ListingOptimizationState> {
  return request(`/inquiries/${id}/listing-optimization`);
}

export function suggestListingOptimization(
  id: number,
): Promise<{ title: string; description: string; contentRevision: number }> {
  return request(`/inquiries/${id}/listing-optimization-suggest`, {
    method: "POST",
  });
}

export function publishListingOptimization(
  id: number,
  body: {
    fields: Array<"title" | "description">;
    title: string;
    description: string;
    expectedContentRevision: number;
  },
): Promise<{ outcome: string; warnings: string[]; content_revision: number }> {
  return request(`/inquiries/${id}/listing-optimization-publish`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getMainImageContext(
  id: number,
): Promise<MainImageContextState> {
  return request(`/inquiries/${id}/main-image`);
}

export function runMainImageAction<T>(
  id: number,
  body: Record<string, unknown>,
): Promise<T> {
  return request(`/inquiries/${id}/main-image`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type {
  MainImageSchemaResult,
  MainImageCandidateResult,
  MainImageSavedAsset,
};

/** GET /api/inquiries/:id/messages — normalized message timeline */
export async function getInquiryMessages(
  id: number,
): Promise<{ data: InquiryMessage[] }> {
  return request(`/inquiries/${id}/messages`);
}

/** GET /api/follow-ups?bucket=... */
export async function getFollowUps(
  bucket: FollowUpBucket,
  shop?: string | null,
): Promise<{ data: FollowUpQueueItem[] }> {
  const params = new URLSearchParams({ bucket });
  if (shop) params.set("shop", shop);
  return request(`/follow-ups?${params.toString()}`);
}

/** PATCH /api/inquiries/:id/follow-up — schedule override / clear */
export async function scheduleFollowUp(
  id: number,
  opts: { dueDate?: string | null; state?: string; reason?: string },
): Promise<{ success: boolean }> {
  return request(`/inquiries/${id}/follow-up`, {
    method: "PATCH",
    body: JSON.stringify(opts),
  });
}

/** POST /api/inquiries/:id/send — controlled operator Send */
export async function sendReply(
  id: number,
  opts: { body: string; followUpCycleId?: string | null; followUpDueDate?: string | null },
): Promise<{
  success: boolean;
  mercariMessageId?: string;
  followUpDueDate?: string;
  followUpState?: string;
  followUpDateSource?: string;
}> {
  return request(`/inquiries/${id}/send`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}
