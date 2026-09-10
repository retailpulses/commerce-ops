import { FIELD, OPTION } from "./db.mjs";
import { mercariResolveItemCode } from "./item-code-resolver.mjs";

// ---------------------------------------------------------------------------
// Channel configuration for tracking reconciliation + item-code resolution
//
// Each channel declares:
//   salesChannel       — Baserow SalesChannel field value (filters shipment rows)
//   shopIds            — shop name → SourceStoreID mapping
//   salesOrderIdField  — field name on the sales row that holds the order ID
//   salesStatusFilters — which sales statuses to load for patching
//   patchSales         — whether to write tracking info back to the sales table
//   itemCodeResolver   — (sku: string) => { resolved, code, reason }
//                        maps platform product ID → Giga B2BItemCode
//
// Shipment table and sales table IDs are read from the Baserow client
// (env vars), NOT hardcoded here — they come from the caller.
//
// For channels where sales data lives in a different Baserow database
// (e.g. Rakuten), pass a separate salesBaserow client to reconcileGigaTracking.
// ---------------------------------------------------------------------------

export const MERCARI_CHANNEL = Object.freeze({
  salesChannel: "Mercari",
  shopIds: Object.freeze({
    Shop1: "WMyisFmhbGWyVAPEwsfirn",
    Shop2: "ZaMyGWzp6hUdgDh5E9ADob",
    Shop3: "2JGrmZqojnBMfdWrtP2xk3",
    Shop4: "2JMLHBxjiFHDr55jMwA7fs",
  }),
  salesOrderIdField: "order_id",
  salesStatusFilters: Object.freeze([
    { field: FIELD.SALES.ORDER_STATUS, optionId: OPTION.ORDER_STATUS.WAITING_FOR_SHIPPING },
    { field: FIELD.SALES.ORDER_STATUS, optionId: OPTION.ORDER_STATUS.COMPLETED },
  ]),
  patchSales: true,
  itemCodeResolver: mercariResolveItemCode,
});

export const RAKUTEN_CHANNEL = Object.freeze({
  salesChannel: "Rakuten",
  shopIds: Object.freeze({
    Rakuten: "Rakuten",
  }),
  salesOrderIdField: "order_id",
  salesStatusFilters: Object.freeze([
    { field: FIELD.RAKUTEN_SALES.ORDER_STATUS, optionId: OPTION.RAKUTEN_ORDER_STATUS.RMS_CONFIRMED },
  ]),
  patchSales: false,
});
