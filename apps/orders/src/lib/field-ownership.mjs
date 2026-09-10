/**
 * Field ownership registry for order pipeline PATCH operations.
 *
 * Existing-row updates must be allow-listed by phase/table/channel. This
 * prevents automation from overwriting operator-owned fields such as delivery
 * preferences, addresses, B2B item codes, and manual notes.
 */

const MERCARI_SALES_OPERATOR_FIELDS = Object.freeze([
  "review_status",
  "B2BItemCode",
  "requested_delivery_date",
  "requested_delivery_time",
  "shipping_name",
  "shipping_postal_code",
  "shipping_state",
  "shipping_city",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_phone_number",
  "billing_name",
  "billing_postal_code",
  "billing_state",
  "billing_city",
  "billing_address_1",
  "billing_address_2",
  "order_comments",
  "shipping_carrier",
  "shipping_tracking_info",
  "shipping_completed_at",
  "shop_close_status",
  "shop_close_attempted_at",
  "shop_close_completed_at",
  "shop_close_error",
  "cancellation_status",
  "cancellation_detected_at",
  "cancellation_reconciled_at",
  "pipeline_terminal_state",
  "pipeline_terminal_reason",
  "pipeline_terminal_at",
  "pipeline_terminal_classified_by",
  "pipeline_terminal_reviewed_at",
  "ai_copywrite_log",
]);

const SHIPMENT_OPERATOR_FIELDS = Object.freeze([
  "B2BItemCode",
  "BuyerPlatformSku",
  "RequestedDeliveryDate",
  "RequestedDeliveryTime",
  "ShipToName",
  "ShipToPhone",
  "ShipToPostalCode",
  "ShipToState",
  "ShipToCity",
  "ShipToAddressDetail",
  "ShipToCountry",
  "OrderComments",
  "shipping_carrier",
  "shipping_tracking_info",
  "shipping_completed_at",
  "giga_sync_processed_at",
  "giga_sync_request_id",
  "pipeline_terminal_state",
  "pipeline_terminal_reason",
]);

const PHASE_OWNERSHIP = Object.freeze({
  pull_shop_orders: Object.freeze({
    sales: Object.freeze({
      owned: Object.freeze([
        "order_status",
        "payment_date",
        "latest_buyer_message_id",
        "latest_buyer_message_at",
        "has_buyer_messages",
        "message_last_synced_at",
      ]),
    }),
  }),
  auto_approve_orders: Object.freeze({
    sales: Object.freeze({
      owned: Object.freeze([
        "review_status",
        "auto_approved_at",
        "auto_approval_rule",
      ]),
    }),
  }),
  build_giga_shipments: Object.freeze({
    shipment: Object.freeze({
      owned: Object.freeze([]),
    }),
  }),
  push_orders_to_giga: Object.freeze({
    shipment: Object.freeze({
      owned: Object.freeze([
        "giga_sync_status",
        "giga_sync_attempted_at",
        "giga_sync_processed_at",
        "giga_sync_request_id",
        "giga_sync_payload_hash",
        "giga_sync_error",
      ]),
    }),
  }),
  pull_giga_tracking: Object.freeze({
    sales: Object.freeze({
      owned: Object.freeze([
        "shipping_carrier",
        "shipping_tracking_info",
        "shipping_completed_at",
        "shipping_duration",
      ]),
    }),
    shipment: Object.freeze({
      owned: Object.freeze([
        "shipping_carrier",
        "shipping_tracking_info",
        "shipping_completed_at",
        "shipping_duration",
      ]),
    }),
  }),
  close_shop_orders: Object.freeze({
    sales: Object.freeze({
      owned: Object.freeze([
        "shop_close_status",
        "shop_close_attempted_at",
        "shop_close_completed_at",
        "shop_close_error",
      ]),
    }),
  }),
});

const CHANNEL_FIELD_OVERRIDES = Object.freeze({
  Mercari: Object.freeze({
    salesOperatorFields: MERCARI_SALES_OPERATOR_FIELDS,
    shipmentOperatorFields: SHIPMENT_OPERATOR_FIELDS,
  }),
  Rakuten: Object.freeze({
    salesOperatorFields: Object.freeze([
      "review_status",
      "B2BItemCode",
      "requested_delivery_date",
      "requested_delivery_time",
      "order_comments",
      "shipping_carrier",
      "shipping_tracking_info",
      "shipping_completed_at",
    ]),
    shipmentOperatorFields: SHIPMENT_OPERATOR_FIELDS,
  }),
});

export function getOperatorOwnedFields({ table, salesChannel = "Mercari" } = {}) {
  const channel = CHANNEL_FIELD_OVERRIDES[salesChannel] || CHANNEL_FIELD_OVERRIDES.Mercari;
  if (table === "shipment") return [...(channel.shipmentOperatorFields || SHIPMENT_OPERATOR_FIELDS)];
  return [...(channel.salesOperatorFields || MERCARI_SALES_OPERATOR_FIELDS)];
}

export function getOwnedFields({ phase, table } = {}) {
  const phaseDef = PHASE_OWNERSHIP[phase];
  if (!phaseDef) return [];
  const tableDef = phaseDef[table];
  if (!tableDef) return [];
  return [...(tableDef.owned || [])];
}

export function getPreservedFields({ phase, table, salesChannel = "Mercari" } = {}) {
  void phase;
  return new Set(getOperatorOwnedFields({ table, salesChannel }));
}

export function filterPatchToOwnedFields({ phase, table, salesChannel = "Mercari", patch } = {}) {
  void salesChannel;
  if (!patch || typeof patch !== "object") return {};
  const ownedSet = new Set(getOwnedFields({ phase, table }));
  const filtered = {};
  for (const key of Object.keys(patch)) {
    if (ownedSet.has(key)) filtered[key] = patch[key];
  }
  return filtered;
}

export function assertPatchOwnsOnlyAllowedFields({ phase, table, salesChannel = "Mercari", patch } = {}) {
  void salesChannel;
  if (!patch || typeof patch !== "object") return;
  const ownedFields = getOwnedFields({ phase, table });
  const ownedSet = new Set(ownedFields);
  const disallowed = Object.keys(patch).filter((key) => !ownedSet.has(key));
  if (disallowed.length) {
    throw new Error(
      `Phase "${phase}" on table "${table}" attempted to PATCH disallowed fields: ${disallowed.join(", ")}. ` +
      `Owned fields: ${ownedFields.join(", ") || "(none)"}`,
    );
  }
}

export function findOperatorFieldsInPatch({ table, salesChannel = "Mercari", patch } = {}) {
  if (!patch || typeof patch !== "object") return [];
  const operatorFields = new Set(getOperatorOwnedFields({ table, salesChannel }));
  return Object.keys(patch).filter((key) => operatorFields.has(key));
}
