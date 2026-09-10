// Shared field-name and option-value constants for Supabase-native column names.
// These replace Baserow numeric field/option IDs (BASEROW_FIELD, BASEROW_OPTION).
//
// Consumer usage (replace BASEROW_FIELD → FIELD, BASEROW_OPTION → OPTION):
//   import { FIELD, OPTION } from "./db-fields.mjs";
//   const filter = { [`filter__field_${FIELD.SALES.ORDER_ID}__equal`]: value };

// ============================================================================
// Re-export Baserow constants for backward compatibility during transition
// ============================================================================
export { BASEROW_FIELD, BASEROW_OPTION } from "./baserow.mjs";

// ============================================================================
// FIELD — column name constants (Supabase-native, human-readable)
// ============================================================================
// Mirror the BASEROW_FIELD key structure exactly so consumers can
// search-and-replace: BASEROW_FIELD → FIELD.

export const FIELD = {
  SALES: {
    ORDER_ID:             "order_id",
    PRODUCT_NAME:         "product_name",
    ORIGINAL_PRODUCT_ID:  "original_product_id",
    B2B_ITEM_CODE:        "b2b_item_code",
    SHOP_ID:              "source_store_id",
    SALES_CHANNEL:        "sales_channel",
    ORDER_STATUS:         "order_status",
    SHIPPING_COMPLETED_AT:"shipping_completed_at",
    SHIPPING_PHONE_NUMBER:"shipping_phone_number",
    SHIPPING_NAME:        "shipping_name",
    SHIPPING_POSTAL_CODE: "shipping_postal_code",
    REVIEW_STATUS:        "review_status",
    AUTO_APPROVAL_RULE:   "auto_approval_rule",
    AUTO_APPROVED_AT:     "auto_approved_at",
    AI_COPYWRITE_LOG:     "ai_copywrite_log",
    HAS_UNREAD_MESSAGES:      "has_unread_messages",
    LAST_MESSAGE_AT:           "last_message_at",
    LATEST_BUYER_MESSAGE_ID:   "latest_buyer_message_id",
    MESSAGE_LAST_SYNCED_AT:    "message_last_synced_at",
    LINE_ORIGIN:               "line_origin",
    PARENT_LINE_ID:            "parent_line_id",
    COMPONENT_INDEX:           "component_index",
  },
  RAKUTEN_SALES: {
    ORDER_ID:             "order_id",
    SALES_CHANNEL:        "sales_channel",
    ORDER_STATUS:         "order_status",
    MANAGE_NUMBER:        "manage_number",
    CONFIRM_IN_PROGRESS:  "confirm_in_progress",
    CONFIRM_STARTED_AT:   "confirm_started_at",
  },
  SHIPMENT: {
    ORDER_ID:             "order_id",
    SOURCE_STORE_ID:      "source_store_id",
    GIGA_SYNC_STATUS:     "giga_sync_status",
    SALES_CHANNEL:        "sales_channel",
    SHIPPING_COMPLETED_AT:"shipping_completed_at",
    TRACKING_CARRIER:     "tracking_carrier",
    TRACKING_NUMBER:      "tracking_number",
    ORDER_DATE:           "order_date",
    CREATED_ON:           "created_at",
  },
};

// ============================================================================
// OPTION — display-value constants (Supabase-native, plain text)
// ============================================================================
// Mirror BASEROW_OPTION key structure but use display values instead of
// numeric option IDs. Matches the CHECK constraint values in the schema.

export const OPTION = {
  ORDER_STATUS: {
    CANCELED:             "CANCELED",
    WAITING_FOR_SHIPPING: "WAITING_FOR_SHIPPING",
    WAITING_FOR_PAYMENT:  "WAITING_FOR_PAYMENT",
    COMPLETED:            "COMPLETED",
  },
  RAKUTEN_ORDER_STATUS: {
    PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
    CONFIRMED:            "CONFIRMED",
    RMS_CONFIRMED:        "RMS_CONFIRMED",
    CANCELED:             "CANCELED",
  },
  GIGA_SYNC_STATUS: {
    PENDING:       "PENDING",
    ATTEMPTED:     "ATTEMPTED",
    SYNCED:         "SYNCED",
    ALREADY_EXISTS: "ALREADY_EXISTS",
    INVALID:        "INVALID",
    ERROR:          "ERROR",
  },
  REVIEW_STATUS: {
    PENDING_REVIEW: "PENDING_REVIEW",
    APPROVED:       "APPROVED",
    ON_HOLD:        "ON_HOLD",
    AUTO_APPROVED:  "AUTO_APPROVED",
    CANCELED:       "CANCELED",
  },
};
