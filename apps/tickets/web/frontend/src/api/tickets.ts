import { api } from "./client";
import type {
  Ticket,
  TicketDetail,
  TicketEvent,
  TicketFilters,
  CreateTicketInput,
  ProductSearchResult,
  TicketMessage,
  TicketNote,
  TicketProduct,
  IssueType,
  TicketStatus,
  PlatformAccount,
  TicketAttachment,
  TicketResolutionAction,
  CreateResolutionInput,
  CreateTicketShareInput,
  TicketShare,
  AfterSalesLink,
  OrderContext,
} from "./types";

interface ListTicketsResponse {
  tickets: Ticket[];
  total: number;
}

export async function listTickets(filters: TicketFilters): Promise<ListTicketsResponse> {
  const params = new URLSearchParams();

  if (filters.platform) params.set("platform", filters.platform);
  if (filters.account_id) params.set("account_id", filters.account_id);
  if (filters.status) params.set("status", filters.status);
  if (filters.status_group) params.set("status_group", filters.status_group);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.issue_type) params.set("issue_type", filters.issue_type);
  if (filters.needs_reply !== undefined) params.set("needs_reply", String(filters.needs_reply));
  if (filters.q) params.set("q", filters.q);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));

  const qs = params.toString();
  return api<ListTicketsResponse>(`/tickets/api/ticketing/tickets${qs ? `?${qs}` : ""}`);
}

interface GetTicketResponse {
  ticket: TicketDetail;
  events: TicketEvent[];
}

export async function getTicket(id: string): Promise<GetTicketResponse> {
  return api<GetTicketResponse>(`/tickets/api/ticketing/tickets/${encodeURIComponent(id)}`);
}

export async function getOrderContext(ticketId: string): Promise<{ order: OrderContext }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/order-context`);
}

interface CreateTicketResponse {
  ticket: Ticket;
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketResponse> {
  return api<CreateTicketResponse>("/tickets/api/ticketing/tickets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

interface UpdateTicketResponse {
  ticket: Ticket;
}

export async function updateTicket(
  id: string,
  input: Partial<Ticket>,
): Promise<UpdateTicketResponse> {
  return api<UpdateTicketResponse>(`/tickets/api/ticketing/tickets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

interface LinkProductResponse {
  product: TicketProduct;
}

export async function linkProduct(
  ticketId: string,
  product: ProductSearchResult,
): Promise<LinkProductResponse> {
  return api<LinkProductResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/products`,
    {
      method: "POST",
      body: JSON.stringify(product),
    },
  );
}

interface UnlinkProductResponse {
  success: boolean;
}

export async function unlinkProduct(
  ticketId: string,
  productId: string,
): Promise<UnlinkProductResponse> {
  return api<UnlinkProductResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/products/${encodeURIComponent(productId)}`,
    { method: "DELETE" },
  );
}

interface SearchProductsResponse {
  products: ProductSearchResult[];
}

export async function searchProducts(
  q: string,
  platform?: string,
): Promise<SearchProductsResponse> {
  const params = new URLSearchParams({ q });
  if (platform) params.set("platform", platform);
  return api<SearchProductsResponse>(`/tickets/api/ticketing/products/search?${params.toString()}`);
}

interface AddMessageResponse {
  message: TicketMessage;
}

export async function addMessage(
  ticketId: string,
  body: string,
  platform: string,
): Promise<AddMessageResponse> {
  return api<AddMessageResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body, platform }),
    },
  );
}

interface AddNoteResponse {
  note: TicketNote;
}

export async function addNote(
  ticketId: string,
  body: string,
): Promise<AddNoteResponse> {
  return api<AddNoteResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/notes`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
}

export async function updateNote(ticketId: string, noteId: string, body: string): Promise<AddNoteResponse> {
  return api<AddNoteResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/notes/${encodeURIComponent(noteId)}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
  );
}

interface IssueTypesResponse {
  issue_types: IssueType[];
}

export async function getIssueTypes(): Promise<IssueTypesResponse> {
  return api<IssueTypesResponse>("/tickets/api/ticketing/issue-types");
}

interface StatusesResponse {
  statuses: TicketStatus[];
}

export async function getStatuses(): Promise<StatusesResponse> {
  return api<StatusesResponse>("/tickets/api/ticketing/statuses");
}

interface ListAccountsResponse {
  accounts: PlatformAccount[];
}

export async function listAccounts(platform?: string): Promise<ListAccountsResponse> {
  const params = platform ? `?platform=${encodeURIComponent(platform)}` : "";
  return api<ListAccountsResponse>(`/tickets/api/ticketing/accounts${params}`);
}

export async function listAttachments(ticketId: string): Promise<{ attachments: TicketAttachment[] }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/attachments`);
}

export async function uploadAttachment(
  ticketId: string,
  file: File,
): Promise<{ attachment: TicketAttachment }> {
  const authorization = await api<{ upload_id: string; signed_upload_url: string }>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/attachments`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, size_bytes: file.size, mime_type: file.type }),
  });
  const directBody = new FormData();
  directBody.append("cacheControl", "3600");
  directBody.append("", file);
  const uploadResponse = await fetch(authorization.signed_upload_url, {
    method: "PUT",
    headers: { "x-upsert": "false" },
    body: directBody,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Direct evidence upload failed (${uploadResponse.status})`);
  }
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/attachments/uploads/${encodeURIComponent(authorization.upload_id)}/finalize`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteAttachment(ticketId: string, attachmentId: string): Promise<void> {
  await api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export async function recordResolution(
  ticketId: string,
  input: CreateResolutionInput,
): Promise<{ action: TicketResolutionAction }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/resolutions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ListTicketSharesResponse {
  active_share: TicketShare | null;
  shares: TicketShare[];
}

export async function listTicketShares(ticketId: string): Promise<ListTicketSharesResponse> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/shares`);
}

export async function createTicketShare(
  ticketId: string,
  input: CreateTicketShareInput,
): Promise<{ share: TicketShare }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/shares`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function rotateTicketShare(
  ticketId: string,
  input: CreateTicketShareInput,
): Promise<{ share: TicketShare }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/shares/rotate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeTicketShare(
  ticketId: string,
  shareId: string,
): Promise<{ share: TicketShare }> {
  return api(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/shares/${encodeURIComponent(shareId)}`,
    { method: "DELETE" },
  );
}

export async function generateAfterSalesLink(
  ticketId: string,
  clientOperationId: string,
): Promise<AfterSalesLink> {
  return api(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/after-sales-link`,
    {
      method: "POST",
      body: JSON.stringify({ client_operation_id: clientOperationId }),
    },
  );
}
