// Matches the Supabase inquiry_statuses.key TEXT values
export const STATUS_RECEIVED = "received";
export const STATUS_FOLLOWED_UP = "followed_up";
export const STATUS_ANSWERED = "answered";
export const STATUS_CLOSED_WON = "closed_won";
export const STATUS_CLOSED_LOSE = "closed_lose";

export const STATUS_TABS = [
  { id: STATUS_RECEIVED, label: "Needs reply" },
  { id: STATUS_FOLLOWED_UP, label: "Followed-up" },
  { id: STATUS_ANSWERED, label: "Answered" },
  { id: STATUS_CLOSED_WON, label: "Closed Won" },
  { id: STATUS_CLOSED_LOSE, label: "Closed Lose" },
  { id: "_all", label: "All" },
] as const;

export const SHOP_OPTIONS = [
  { id: "_all", label: "All shops" },
  { id: "shop1", label: "Shop1" },
  { id: "shop2", label: "Shop2" },
  { id: "shop3", label: "Shop3" },
  { id: "shop4", label: "Shop4" },
] as const;

export const INQUIRY_TYPE_OPTIONS = [
  { id: "_all", label: "All types" },
  { id: "okinawa_inquiry", label: "Okinawa inquiry" },
  { id: "bulk_purchase", label: "Bulk purchase" },
  { id: "price_negotiation", label: "Price negotiation" },
  { id: "scheduled_delivery", label: "Scheduled delivery" },
  { id: "product_availability", label: "Product availability" },
  { id: "shipping_related", label: "Shipping related" },
  { id: "assembly", label: "Assembly" },
  { id: "product_spec", label: "Product Spec" },
  { id: "find_a_product", label: "Find a product" },
  { id: "others", label: "Others" },
] as const;
