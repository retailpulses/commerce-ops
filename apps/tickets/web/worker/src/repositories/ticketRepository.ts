/** Ticket repository interface — domain types and repository contract.
 *  Business logic depends on this interface, never directly on Supabase.
 */

// ── Domain Types ──

export interface Ticket {
  id: string;
  ticket_number: string;
  platform: string;
  account_id: string | null;
  external_order_id: string | null;
  external_thread_id: string | null;
  origin: string;
  customer_display_name: string | null;
  customer_contact: string | null;
  subject: string | null;
  description: string | null;
  status: string;
  priority: string;
  issue_types: string[];
  assigned_user_id: string | null;
  assigned_display_name: string | null;
  latest_message_at: string | null;
  latest_customer_message: string | null;
  needs_reply: boolean;
  external_url: string | null;
  raw_source_payload: Record<string, unknown>;
  started_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TicketListRow {
  id: string;
  ticket_number: string;
  platform: string;
  account_id: string | null;
  account_display_name: string | null;
  external_order_id: string | null;
  status: string;
  priority: string;
  issue_types: string[];
  customer_display_name: string | null;
  subject: string | null;
  description: string | null;
  latest_message_at: string | null;
  latest_customer_message: string | null;
  needs_reply: boolean;
  external_url: string | null;
  product_name: string | null;
  primary_sku: string | null;
  seller_name: string | null;
  attachment_count: number;
  note_count: number;
  started_at: string | null;
  created_at: string;
}

export interface TicketDetail extends Ticket {
  products: TicketProduct[];
  messages: TicketMessage[];
  notes: TicketNote[];
  events: TicketEvent[];
  resolution_actions: TicketResolutionAction[];
  customer_submissions?: CustomerSubmission[];
}

export interface CustomerSubmission {
  id: string;
  ticket_id: string | null;
  submission_type: string;
  customer_display_name: string | null;
  customer_contact: string | null;
  issue_description: string | null;
  expected_solution: string | null;
  source: string;
  processing_status: string;
  submitted_at: string;
}

export interface TicketAttachment {
  id: string;
  ticket_id: string | null;
  customer_submission_id: string | null;
  storage_bucket: string;
  storage_path: string;
  filename: string | null;
  mime_type: string | null;
  media_type: string;
  size_bytes: number | null;
  source: string;
  reference_url?: string | null;
  signed_url: string | null;
  created_at: string;
}

export interface TicketProduct {
  id: string;
  ticket_id: string;
  product_id: string | null;
  variant_id: string | null;
  listing_id: string | null;
  listing_sku_id: string | null;
  sku: string;
  quantity: number | null;
  role: string;
  created_at: string;
  product_name?: string | null;
  variant_name?: string | null;
  item_code?: string | null;
  platform?: string | null;
  platform_sku?: string | null;
  seller_name?: string | null;
  unit_price?: string | null;
  unit_fulfillment_price?: string | null;
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  platform: string;
  external_message_id: string | null;
  sender_type: string;
  sender_display_name: string | null;
  body: string;
  sent_at: string;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

export interface TicketNote {
  id: string;
  ticket_id: string;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface TicketResolutionAction {
  id: string;
  ticket_id: string;
  action_type: string;
  amount: number | null;
  currency: string;
  replacement_sku: string | null;
  quantity: number | null;
  reason: string | null;
  approved_by: string | null;
  external_reference: string | null;
  operation_id: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface CreateResolutionActionInput {
  ticket_id: string;
  operation_id: string;
  action_type: string;
  amount?: number | null;
  currency?: string;
  replacement_sku?: string | null;
  quantity?: number | null;
  reason?: string | null;
  external_reference?: string | null;
  actor?: string | null;
  close_ticket?: boolean;
}

// ── Input Types ──

export interface CreateTicketInput {
  platform: string;
  account_id?: string | null;
  external_order_id?: string | null;
  external_thread_id?: string | null;
  customer_display_name?: string | null;
  customer_contact?: string | null;
  subject?: string | null;
  description?: string | null;
  status?: string;
  priority?: string;
  issue_types?: string[];
  assigned_user_id?: string | null;
  assigned_display_name?: string | null;
  external_url?: string | null;
  /** Low-level persistence value. Runtime creation commands only authorize manual. */
  origin?: "manual";
  raw_source_payload?: Record<string, unknown>;
}

export type ManualTicketCreationSource =
  | "manual_operator_creation"
  | "manual_queue_conversion";

export interface ManualTicketCreationAuthority {
  source: ManualTicketCreationSource;
  actor_id: string;
  provenance?: Record<string, unknown>;
}

export interface UpdateTicketInput {
  status?: string;
  priority?: string;
  issue_types?: string[];
  assigned_user_id?: string | null;
  assigned_display_name?: string | null;
  account_id?: string | null;
  subject?: string | null;
  description?: string | null;
  customer_display_name?: string | null;
  customer_contact?: string | null;
  external_url?: string | null;
  needs_reply?: boolean;
  started_at?: string | null;
}

export interface LinkProductInput {
  ticket_id: string;
  product_id?: string | null;
  variant_id?: string | null;
  listing_id?: string | null;
  listing_sku_id?: string | null;
  sku: string;
  quantity?: number | null;
  role?: string;
}

export interface AddMessageInput {
  ticket_id: string;
  platform: string;
  external_message_id?: string | null;
  sender_type: string;
  sender_display_name?: string | null;
  body: string;
  sent_at?: string;
  raw_payload?: Record<string, unknown>;
}

export interface AddNoteInput {
  ticket_id: string;
  body: string;
  created_by?: string | null;
}

export interface UpdateNoteInput {
  ticket_id: string;
  note_id: string;
  body: string;
}

export interface AddTicketEventInput {
  ticket_id: string;
  event_type: string;
  actor_type: string;
  actor_id?: string | null;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface TicketListFilters {
  platform?: string;
  account_id?: string;
  status?: string;
  status_group?: "non_terminal";
  priority?: string;
  issue_type?: string;
  needs_reply?: boolean;
  assigned_user_id?: string;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface ProductSearchResult {
  variant_id: string | null;
  product_id: string | null;
  sku: string;
  item_code: string | null;
  product_name: string;
  variant_name: string | null;
  listing_id: string | null;
  listing_sku_id: string | null;
  platform: string | null;
  seller_name: string | null;
}

export interface IssueType {
  key: string;
  display_name: string;
  sort_order: number;
  is_active: boolean;
}

export interface TicketStatus {
  key: string;
  display_name: string;
  category: string;
  sort_order: number;
  is_active: boolean;
}

// ── Phase 1 Copywriting Types ──

export interface MessageDraft {
  id: string;
  ticket_id: string;
  body: string;
  resolution_guide: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SentMessage {
  id: string;
  ticket_id: string;
  platform: string;
  platform_message_id: string | null;
  body: string;
  reply_intent: "terminal" | "holding";
  sent_by: string | null;
  sent_at: string;
  created_at: string;
  client_operation_id: string | null;
  delivery_status: "sending" | "sent" | "ambiguous" | "confirmed_not_sent";
  delivery_error: string | null;
  platform_message_ids_before_send: string[] | null;
  provider_mutation_started_at: string | null;
  lease_generation: number;
}

export interface OutboundMessageClaim {
  sentMessage: SentMessage;
  ticketMessage: TicketMessage | null;
  claimed: boolean;
}

export interface CopywritingLog {
  id: string;
  ticket_id: string | null;
  ticket_number: string | null;
  model: string;
  prompt_version: string;
  resolution_guide: string | null;
  generated_reply: string | null;
  reply_char_count: number | null;
  latency_ms: number | null;
  status: "success" | "error";
  error_message: string | null;
  customer_message: string | null;
  ticket_description: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SaveDraftInput {
  ticket_id: string;
  body: string;
  resolution_guide?: string;
  created_by?: string | null;
}

export interface SendReplyInput {
  ticket_id: string;
  message: string;
  reply_intent: "terminal" | "holding";
  last_seen_message_at?: string;
  sent_by?: string | null;
}

export interface SendReplyResult {
  platform_message_id: string;
  sent_at: string;
  warning?: string;
  warning_code?: string;
}

export interface PlatformThread {
  messages: PlatformThreadMessage[];
  orderId: string;
}

export interface PlatformThreadMessage {
  id: string;
  body: string;
  role: "BUYER" | "SELLER";
  sentAt: string;
}

// ── Repository Interface ──

export interface TicketRepository {
  // Slice 1A
  createTicket(input: CreateTicketInput): Promise<Ticket>;
  getTicket(ticketId: string): Promise<TicketDetail | null>;
  listTickets(filters: TicketListFilters): Promise<{ rows: TicketListRow[]; total: number }>;
  updateTicket(ticketId: string, input: UpdateTicketInput): Promise<Ticket>;
  linkTicketProduct(input: LinkProductInput): Promise<TicketProduct>;
  unlinkTicketProduct(ticketId: string, productId: string): Promise<void>;
  getTicketEvents(ticketId: string): Promise<TicketEvent[]>;
  addTicketEvent(input: AddTicketEventInput): Promise<TicketEvent>;
  searchProducts(query: string, platform?: string): Promise<ProductSearchResult[]>;

  // Slice 1B
  addMessage(input: AddMessageInput): Promise<TicketMessage>;
  addNote(input: AddNoteInput): Promise<TicketNote>;
  updateNote(input: UpdateNoteInput): Promise<TicketNote | null>;
  getTicketMessages(ticketId: string): Promise<TicketMessage[]>;
  getTicketNotes(ticketId: string): Promise<TicketNote[]>;
  getTicketProducts(ticketId: string): Promise<TicketProduct[]>;
  getIssueTypes(): Promise<IssueType[]>;
  getStatuses(): Promise<TicketStatus[]>;
  listAttachments(ticketId: string): Promise<TicketAttachment[]>;
  createAttachment(input: Omit<TicketAttachment, "id" | "signed_url" | "created_at">): Promise<{
    attachment: TicketAttachment;
    created: boolean;
  }>;
  getAttachment(ticketId: string, attachmentId: string): Promise<TicketAttachment | null>;
  deleteAttachment(ticketId: string, attachmentId: string): Promise<TicketAttachment | null>;
  createSignedAttachmentUpload(bucket: string, path: string): Promise<{ signed_url: string; token: string }>;
  getAttachmentObjectInfo(bucket: string, path: string): Promise<{ size: number; mime_type: string | null } | null>;
  deleteAttachmentObject(bucket: string, path: string): Promise<void>;
  listResolutionActions(ticketId: string): Promise<TicketResolutionAction[]>;
  recordResolutionAction(input: CreateResolutionActionInput): Promise<TicketResolutionAction>;
}

// ── Copywriting Repository Interface (Phase 1) ──

export interface CopywritingRepository {
  // Drafts
  getDraft(ticketId: string): Promise<MessageDraft | null>;
  saveDraft(input: SaveDraftInput): Promise<MessageDraft>;

  // Sent messages
  claimPlatformSentMessage(input: {
    ticket_id: string;
    platform: "mercari" | "rakuten";
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    sent_by?: string | null;
  }): Promise<OutboundMessageClaim>;
  claimAmazonMailSentMessage(input: {
    ticket_id: string;
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    sent_by?: string | null;
    source_inbound_message_id: string;
    reviewed_customer_message_id: string;
    reviewed_customer_message_at: string;
    reviewed_customer_revision: string;
    reviewed_thread_revision: string;
  }): Promise<OutboundMessageClaim>;
  finalizeSentMessage(input: {
    ticket_id: string;
    platform: "mercari" | "rakuten";
    client_operation_id: string;
    body: string;
    reply_intent: "terminal" | "holding";
    platform_message_id: string;
    platform_sent_at: string;
    sent_by?: string | null;
  }): Promise<{ sentMessage: SentMessage; ticketMessage: TicketMessage; replayed: boolean }>;
  finalizeAmazonMailSend(input: {
    ticket_id: string;
    client_operation_id: string;
    platform_message_id: string;
    platform_sent_at: string;
    sent_by?: string | null;
  }): Promise<{
    sentMessage: SentMessage;
    ticketMessage: TicketMessage;
    replayed: boolean;
    newerCustomerMessage: boolean;
  }>;
  releasePlatformSentMessageClaim(
    ticketId: string,
    clientOperationId: string,
    platform: "mercari" | "rakuten",
    body: string,
    replyIntent: "terminal" | "holding",
  ): Promise<void>;
  recordPlatformSentMessagePreflight(ticketId: string, clientOperationId: string, platform: "mercari" | "rakuten", platformMessageIds: string[]): Promise<void>;
  markPlatformSentMessageAmbiguous(ticketId: string, clientOperationId: string, platform: "mercari" | "rakuten", error: string): Promise<void>;
  releaseAmazonMailSentMessageClaim(ticketId: string, clientOperationId: string, leaseGeneration: number): Promise<void>;
  recordAmazonMailSentMessagePreflight(ticketId: string, clientOperationId: string, platformMessageIds: string[], leaseGeneration: number): Promise<void>;
  markAmazonMailSentMessageAmbiguous(ticketId: string, clientOperationId: string, error: string, leaseGeneration: number): Promise<void>;
  markSentMessageProviderMutationStarted(ticketId: string, clientOperationId: string, leaseGeneration: number): Promise<string>;

  // Copywriting logs
  logCopywriting(input: {
    ticket_id: string;
    ticket_number?: string | null;
    model: string;
    prompt_version?: string;
    resolution_guide?: string | null;
    generated_reply?: string | null;
    reply_char_count?: number | null;
    latency_ms?: number | null;
    status: "success" | "error";
    error_message?: string | null;
    customer_message?: string | null;
    ticket_description?: string | null;
    created_by?: string | null;
  }): Promise<CopywritingLog>;
}
