export interface Ticket {
  id: string;
  ticket_number: string;
  platform: string;
  account_id: string | null;
  external_order_id: string | null;
  external_url: string | null;
  status: string;
  priority: string;
  issue_types: string[];
  needs_reply: boolean;
  subject: string | null;
  description: string | null;
  customer_display_name: string | null;
  customer_contact: string | null;
  started_at: string | null;
  latest_message_at: string | null;
  latest_customer_message: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
  // Joined fields from list view
  account_display_name?: string;
  product_name?: string;
  primary_sku?: string;
  attachment_count?: number;
  note_count?: number;
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

export interface TicketProduct {
  id: string;
  ticket_id: string;
  product_id: string | null;
  variant_id: string | null;
  listing_id: string | null;
  listing_sku_id: string | null;
  sku: string;
  role: string;
  product_name?: string;
  variant_name?: string;
  platform_sku?: string;
  platform?: string;
  item_code?: string;
  seller_name?: string;
  unit_price?: number;
  unit_fulfillment_price?: number;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_type: string;
  sender_display_name: string | null;
  body: string;
  external_message_id: string | null;
  sent_at: string;
}

export interface TicketNote {
  id: string;
  ticket_id: string;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface TicketDetail extends Ticket {
  messages?: TicketMessage[];
  notes?: TicketNote[];
  products?: TicketProduct[];
  resolution_actions?: TicketResolutionAction[];
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

export interface IssueType {
  key: string;
  display_name: string;
}

export interface TicketStatus {
  key: string;
  display_name: string;
  category: string;
  sort_order: number;
  is_active: boolean;
}

export interface Draft {
  id?: string;
  ticket_id: string;
  body: string;
  resolution_guide?: string;
  updated_at?: string;
}

export interface ThreadMessage {
  id: string;
  role: string;
  body: string;
  sentAt: string;
  source: "platform" | "supabase";
  displayName?: string;
  externalMessageId?: string;
}

export interface SendResponse {
  success: boolean;
  reply_id?: string;
  platform_message_id?: string;
  sent_at?: string;
  warning?: string;
  warning_code?: string;
  ticket_message?: TicketMessage;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface TicketFilters {
  platform?: string;
  account_id?: string;
  status?: string;
  status_group?: "non_terminal";
  priority?: string;
  issue_type?: string;
  needs_reply?: boolean;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface CreateTicketInput {
  platform: string;
  account_id?: string | null;
  external_order_id?: string | null;
  external_url?: string | null;
  customer_display_name?: string | null;
  customer_contact?: string | null;
  subject?: string | null;
  description?: string | null;
  status?: string;
  priority?: string;
  issue_types?: string[];
}

export interface PlatformAccount {
  id: string;
  display_name: string;
  platform: string;
  shop_code: string;
}

export interface TicketAttachment {
  id: string;
  ticket_id: string;
  storage_bucket: string;
  storage_path: string;
  filename: string | null;
  mime_type: string | null;
  media_type: string;
  size_bytes: number | null;
  source: string;
  reference_url?: string | null;
  signed_url?: string | null;
  created_at: string;
}

export interface OrderContext {
  order_id: string;
  sales_channel: string;
  order_status: string;
  review_status: string;
  pipeline_state: string;
  purchase_date_jst: string;
  buyer_name: string;
  shipping_name: string;
  shipping_postal_code: string;
  shipping_state: string;
  shipping_city: string;
  shipping_address_1: string;
  shipping_address_2: string;
  shipping_method: string;
  shipping_carrier: string;
  tracking_number: string;
  payment_method: string;
  rakuten_order_progress: string | null;
  rakuten_status_mapping_state: string | null;
  rms_confirmed_at: string | null;
  lines: Array<{ product_name: string; platform_sku: string; b2b_item_code: string; quantity: number }>;
}

export type TicketShareStatus = "active" | "expired" | "revoked";

export interface TicketShare {
  id: string;
  ticket_id: string;
  status: TicketShareStatus;
  url: string;
  expires_at: string;
  created_at: string;
  access_count: number;
  last_accessed_at: string | null;
  seller_description: string;
  attachment_ids: string[];
  pii_reviewed_at: string;
}

export interface CreateTicketShareInput {
  client_operation_id: string;
  seller_description: string;
  attachment_ids: string[];
  pii_confirmed: true;
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

export interface CreateResolutionInput {
  operation_id: string;
  action_type: string;
  amount?: number | null;
  currency?: string;
  replacement_sku?: string | null;
  quantity?: number | null;
  reason?: string | null;
  external_reference?: string | null;
  close_ticket?: boolean;
}

export interface AfterSalesLink {
  url: string;
  expires_at: string;
  ticket_id: string;
  external_order_id: string | null;
  platform: string;
}

export interface ProductSearchResult {
  product_id: string | null;
  variant_id: string | null;
  listing_id: string | null;
  listing_sku_id: string | null;
  sku: string;
  product_name: string;
  variant_name?: string;
  platform?: string;
}
