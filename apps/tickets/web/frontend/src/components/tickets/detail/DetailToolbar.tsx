import type { Ticket } from "@/api/types";
import { PlatformBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface DetailToolbarProps {
  ticket: Ticket;
  onBack?: () => void;
  onShare?: () => void;
  onGenerateFormLink?: () => void;
}

export function DetailToolbar({ ticket, onBack, onShare, onGenerateFormLink }: DetailToolbarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface shrink-0 flex-wrap">
      {/* Mobile back button — visible below 900px */}
      {onBack !== undefined && (
        <button
          onClick={onBack}
          className="max-[900px]:inline-flex hidden items-center justify-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-accent hover:bg-gray-100 transition-colors"
          aria-label="Back to ticket list"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="size-5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          Back to tickets
        </button>
      )}

      {/* Ticket number */}
      <span className="font-mono font-bold text-sm text-accent shrink-0">
        #{ticket.ticket_number}
      </span>

      {/* Platform badge */}
      <PlatformBadge platform={ticket.platform} />

      <span className="shrink-0 text-xs text-text-muted">
        Order ID:{" "}
        <span className="font-mono font-semibold text-text">
          {ticket.external_order_id ?? "—"}
        </span>
      </span>

      {/* External link stays visible while Details are collapsed. */}
      {ticket.external_url && (
        <a
          href={ticket.external_url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded border border-border bg-white px-2 py-1 text-xs font-medium text-accent hover:bg-gray-50 hover:underline"
          aria-label={ticket.external_order_id ? `Open external order ${ticket.external_order_id}` : "Open external ticket link"}
          title={ticket.external_order_id ?? "Open external ticket link"}
        >
          Open external ↗
        </a>
      )}

      {/* Subject — truncated, right-aligned */}
      <span className="text-sm text-text truncate text-right ml-auto min-w-0 max-w-[45%]">
        {ticket.subject ?? "(No subject)"}
      </span>

      {onGenerateFormLink && (
        <Button variant="outline" size="sm" onClick={onGenerateFormLink} aria-label="Generate buyer form link">
          Form Link
        </Button>
      )}
      {onShare && (
        <Button variant="outline" size="sm" onClick={onShare} aria-label="Share with seller">
          Share
        </Button>
      )}
    </div>
  );
}
