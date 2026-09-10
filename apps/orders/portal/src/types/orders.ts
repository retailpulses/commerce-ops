// ── Order Types ───────────────────────────────────────────

export interface Margin {
  revenue: number | null;
  shipping: number | null;
  commission: number | null;
  tcogs: number | null;
  tcogsSource: string | null;
  profit: number | null;
  marginPercent: number | null;
  effectiveTcogsPerUnit?: number | null;
  unitPrice?: number | null;
  cogsEqualsUnitPrice?: boolean;
}

export interface Stock {
  ownedQty: number | null;
  qtyAvailable: number | null;
  status: "owned_ok" | "supplier_ok" | "partial" | "needs_procurement" | null;
  label: string | null;
}

export interface RiskBadge {
  type: string;
  severity: "critical" | "warning" | "info" | "payment" | "fee";
  label: string;
}

export interface OrderRow {
  id: number;
  order_id: string;
  portal_target_id?: string;
  product_name: string;
  original_product_id: string;
  platform_sku: string;
  B2BItemCode: string;
  quantity: number;
  product_price: number;
  shipping_price: number;
  order_status: string;
  shop_id: string;
  review_status: string;
  pipeline_state: string;
  purchase_date: string;
  purchase_date_jst: string;
  buyer_name: string;
  shipping_name: string;
  shipping_postal_code: string;
  shipping_state: string;
  shipping_city: string;
  shipping_address_1: string;
  shipping_address_2: string;
  shipping_phone_number: string;
  shipping_method: string;
  payment_method: string;
  shipping_carrier: string;
  requested_delivery_date: string;
  requested_delivery_time: string;
  order_comments: string;
  review_memo_log: string;
  is_fee_row: boolean;
  sales_channel?: string;
  has_unread: boolean;
  unread_classification: string;
  margin: Margin;
  stock: Stock;
  risk_badges: RiskBadge[];
}

export interface LinkedOrder {
  id: number;
  order_id: string;
  product_name: string;
  order_status: string;
  review_status: string;
  pipeline_state: string;
  is_fee: boolean;
}

export interface ProductInfo {
  effective_tcogs: number | null;
  effective_cogs: number | null;
  source_unit_price: number | null;
  owned_qty: number | null;
  qty_available: number | null;
  seller: string | null;
  manual_fields_available: boolean;
  manual_cost_price: number | null;
  manual_presale_arrival_date: string | null;
  presale_info_protect_until: string | null;
  restock_info: string | null;
}

export interface OrderDetail extends OrderRow {
  shipment_sync_status: string | null;
  rakuten_order_progress?: string | null;
  rakuten_status_mapping_state?: "MAPPED" | "UNKNOWN" | "MISSING" | null;
  rakuten_order_progress_observed_at?: string | null;
  rms_confirm_result?: string | null;
  rms_confirmed_at?: string | null;
  rakuten_shipment_ready?: boolean;
  rakuten_blocking_reason?: string | null;
  linked_orders?: LinkedOrder[];
  product?: ProductInfo | null;
  cogs_price_match_lines?: Array<{
    id: number;
    platform_sku: string;
    source_unit_price: number;
    effective_cogs: number;
  }>;
}

export interface OrderLine {
  id: string | number;
  platform_sku: string;
  product_name: string;
  B2BItemCode: string;
  quantity: number;
  unit_price: number | null;
  effective_tcogs: number | null;
  effective_cogs: number | null;
  source_unit_price: number | null;
  line_origin: string;
  component_index: number | null;
  line_tcogs: number | null;
  stock: { status: string; label: string; ownedQty: number | null; qtyAvailable: number | null };
  cogs_unit_price_equal: boolean;
}

export interface FeeRow {
  id: number;
  order_id: string;
  product_name: string;
  order_status: string;
  review_status: string;
  pipeline_state: string;
  purchase_date: string;
  purchase_date_jst: string;
  shop_id: string;
}

export interface FeeOrderRow {
  fee: FeeRow;
  main: {
    order_id: string;
    product_name: string;
    order_status: string;
    review_status: string;
    shipping_completed_at: string;
    purchase_date: string;
    purchase_date_jst: string;
  } | null;
  main_shipped: boolean;
}

export interface Summary {
  total: number;
  by_review: {
    pending_review: number;
    auto_approved: number;
    approved: number;
    on_hold: number;
    canceled?: number;
    unset?: number;
  };
  degraded?: boolean;
}

export interface ListResponse<T> {
  ok?: boolean;
  count?: number;
  total: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  results: T[];
  note?: string;
}

export interface PresaleGroup {
  B2BItemCode: string;
  product_name: string;
  restock_date: string;
  order_count: number;
  total_quantity: number;
  earliest_order_date: string | null;
  status_breakdown: {
    WAITING_FOR_PAYMENT: number;
    WAITING_FOR_SHIPPING: number;
  };
  owned_qty: number | null;
  qty_available: number | null;
  restock_info: string;
  order_ids: string[];
}

export interface Message {
  id: string | null;
  role: "BUYER" | "SELLER";
  message: string;
  createdAt: string;
}

export interface Template {
  id: string;
  title: string;
  body: string;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface OrderFilters {
  channel?: string;
  shop?: string;
  lifecycle?: string;
  review?: string;
  attention?: string;
  search?: string;
}

export interface PaginationParams {
  limit: number;
  offset: number;
  sort: string;
  order: "asc" | "desc";
}
