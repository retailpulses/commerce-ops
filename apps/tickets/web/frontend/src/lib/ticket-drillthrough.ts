import type { TicketFilters } from "@/api/types";

const ALLOWED_STATUSES = new Set([
  "open",
  "in_progress",
  "pending_customer",
  "pending_third_party",
  "resolved",
  "closed",
  "canceled",
]);
const ALLOWED_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

/**
 * Accept only the documented Metrics queue filters from the Ticket URL.
 * Unknown values must not change the default operator queue.
 */
export function ticketFiltersFromSearch(search: string): TicketFilters {
  const params = new URLSearchParams(search);
  const status = params.get("status") || "";
  const statusGroup = params.get("status_group") || "";
  const priority = params.get("priority") || "";
  const hasExplicitStatus = ALLOWED_STATUSES.has(status);

  return {
    sort: "created_at.desc",
    limit: 50,
    ...(hasExplicitStatus ? { status } : {}),
    ...(!hasExplicitStatus && (statusGroup === "non_terminal" || !statusGroup)
      ? { status_group: "non_terminal" as const }
      : {}),
    ...(ALLOWED_PRIORITIES.has(priority) ? { priority } : {}),
  };
}
