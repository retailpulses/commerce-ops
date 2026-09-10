import { SHOP_NAMES } from "@/lib/constants";
import type { OrderFilters } from "@/types/orders";

const LIFECYCLE_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "waiting_for_payment", label: "Waiting for Payment" },
  { value: "waiting_for_shipping", label: "Waiting for Shipping" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
  { value: "all", label: "All" },
];

const REVIEW_OPTIONS = [
  { value: "any", label: "Any Review" },
  { value: "pending_review", label: "Pending Review" },
  { value: "auto_approved", label: "Auto-Approved" },
  { value: "approved", label: "Approved" },
  { value: "on_hold", label: "On Hold" },
  { value: "canceled", label: "Canceled" },
];

const ATTENTION_OPTIONS = [
  { value: "any", label: "Any Issue Type" },
  { value: "unread", label: "Unread" },
  { value: "message_check_pending", label: "Message Check Pending" },
  { value: "low_margin", label: "Low Margin" },
  { value: "price_confirmation_needed", label: "Price confirmation needed" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "none", label: "No Issues" },
];

interface FilterBarProps {
  filters: OrderFilters;
  onChange: (f: OrderFilters) => void;
  onSearch: (q: string) => void;
}

export function FilterBar({ filters, onChange, onSearch }: FilterBarProps) {
  return (
    <div className="flex gap-2 mb-3 flex-wrap items-center">
      <select
        value={filters.channel || "all"}
        onChange={(e) => onChange({ ...filters, channel: e.target.value || undefined, shop: "" })}
        className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-[#1565c0]"
      >
        <option value="all">All</option>
        <option value="mercari">Mercari</option>
        <option value="rakuten">Rakuten</option>
      </select>

      {(filters.channel || "all") !== "all" && (
      <select
        value={filters.shop || ""}
        onChange={(e) => onChange({ ...filters, shop: e.target.value })}
        className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-[#1565c0]"
      >
        <option value="">All Shops</option>
        {SHOP_NAMES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      )}

      <select
        value={filters.lifecycle || "active"}
        onChange={(e) => onChange({ ...filters, lifecycle: e.target.value })}
        className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-[#1565c0]"
      >
        {LIFECYCLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        value={filters.review || "any"}
        onChange={(e) => onChange({ ...filters, review: e.target.value })}
        className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-[#1565c0]"
      >
        {REVIEW_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Issue Type"
        value={filters.attention || "any"}
        onChange={(e) => onChange({ ...filters, attention: e.target.value })}
        className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-[#1565c0]"
      >
        {ATTENTION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1 flex-1 min-w-[200px]">
        <input
          type="search"
          value={filters.search || ""}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search order ID or product..."
          autoComplete="off"
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#1565c0]"
        />
        {(filters.search) && (
          <button
            onClick={() => onSearch("")}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-800 hover:text-[#1565c0] hover:border-[#1565c0]"
            title="Clear search (Esc)"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
