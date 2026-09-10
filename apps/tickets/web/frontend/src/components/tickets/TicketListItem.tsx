import { useCallback } from "react";
import type { Ticket } from "@/api/types";
import { PlatformBadge, StatusBadge, PriorityBadge } from "@/components/ui/Badge";
import { fmtDate } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TicketListItemProps {
  ticket: Ticket;
  isSelected: boolean;
  onClick: () => void;
}

/* ------------------------------------------------------------------ */
/*  TicketListItem                                                     */
/* ------------------------------------------------------------------ */

export function TicketListItem({
  ticket,
  isSelected,
  onClick,
}: TicketListItemProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={`
        flex flex-col gap-1 px-3 py-2.5 border-l-[3px] cursor-pointer
        transition-colors duration-100
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-0
        ${isSelected
          ? "border-l-accent bg-accent-bg"
          : "border-l-transparent hover:bg-gray-50"
        }
      `.trim()}
    >
      {/* Top row: ticket number + badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[11px] leading-none text-accent font-semibold shrink-0">
          #{ticket.ticket_number}
        </span>
        <PlatformBadge platform={ticket.platform} />
        {ticket.account_display_name && (
          <span className="text-[10px] text-text-muted bg-gray-100 px-1.5 py-0.5 rounded">
            {ticket.account_display_name}
          </span>
        )}
        <StatusBadge status={ticket.status} />
        <div className="ml-auto">
          <PriorityBadge priority={ticket.priority} />
        </div>
      </div>

      {/* Subject — clamp to 2 lines */}
      <p className="text-sm font-semibold text-text leading-snug line-clamp-2">
        {ticket.subject ?? "(no subject)"}
      </p>

      {/* Product name + SKU */}
      {(ticket.product_name || ticket.primary_sku) && (
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
          {ticket.product_name && (
            <span className="truncate max-w-[200px]">{ticket.product_name}</span>
          )}
          {ticket.primary_sku && (
            <span className="font-mono text-[10px] text-text-xs">{ticket.primary_sku}</span>
          )}
        </div>
      )}

      {/* Customer + order + latest message date */}
      <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
        {ticket.customer_display_name && (
          <span className="truncate max-w-[120px]">
            {ticket.customer_display_name}
          </span>
        )}
        {ticket.external_order_id && (
          <>
            <span className="text-text-xs/50">&middot;</span>
            {ticket.external_url ? (
              <a
                href={ticket.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate max-w-[100px] text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {ticket.external_order_id}
              </a>
            ) : (
              <span className="truncate max-w-[100px]">
                {ticket.external_order_id}
              </span>
            )}
          </>
        )}
        {ticket.customer_display_name && ticket.latest_message_at && (
          <span className="text-text-xs/50">&middot;</span>
        )}
        {ticket.latest_message_at && (
          <span className="shrink-0">{fmtDate(ticket.latest_message_at)}</span>
        )}
      </div>
    </div>
  );
}
