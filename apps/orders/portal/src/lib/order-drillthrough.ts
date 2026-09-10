import type { OrderFilters } from "@/types/orders";

const DEFAULT_FILTERS: OrderFilters = {
  channel: "all",
  lifecycle: "active",
  review: "any",
  attention: "any",
  shop: "",
  search: "",
};

const LIFECYCLES = new Set([
  "active",
  "waiting_for_payment",
  "waiting_for_shipping",
  "completed",
  "canceled",
  "all",
]);
const REVIEWS = new Set(["any", "pending_review", "auto_approved", "approved", "on_hold", "canceled"]);

/**
 * Accept only documented metrics drill-through filters from the Portal URL.
 * Unknown values intentionally fall back to the normal operator queue.
 */
export function orderFiltersFromSearch(search: string): OrderFilters {
  const params = new URLSearchParams(search);
  const lifecycle = params.get("lifecycle") || "";
  const review = params.get("review") || "";

  return {
    ...DEFAULT_FILTERS,
    ...(LIFECYCLES.has(lifecycle) ? { lifecycle } : {}),
    ...(REVIEWS.has(review) ? { review } : {}),
  };
}
