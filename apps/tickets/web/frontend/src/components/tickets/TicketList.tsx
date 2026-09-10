import { useNavigate } from "react-router-dom";
import type { Ticket } from "@/api/types";
import { TicketListItem } from "./TicketListItem";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TicketListProps {
  tickets: Ticket[];
  selectedTicketId: string | null;
  onTicketSelect: (id: string) => void;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}

/* ------------------------------------------------------------------ */
/*  Skeleton row                                                       */
/* ------------------------------------------------------------------ */

function SkeletonRow() {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 border-l-[3px] border-l-transparent">
      {/* Top row */}
      <div className="flex items-center gap-2">
        <Skeleton width={60} height={14} />
        <Skeleton width={50} height={18} rounded />
        <Skeleton width={70} height={18} rounded />
        <div className="ml-auto">
          <Skeleton width={50} height={14} />
        </div>
      </div>
      {/* Subject line */}
      <Skeleton width="85%" height={14} />
      {/* Bottom row */}
      <div className="flex items-center gap-2">
        <Skeleton width={80} height={12} />
        <span className="text-text-xs/50">&middot;</span>
        <Skeleton width={60} height={12} />
        <span className="text-text-xs/50">&middot;</span>
        <Skeleton width={70} height={12} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TicketList                                                         */
/* ------------------------------------------------------------------ */

export function TicketList({
  tickets,
  selectedTicketId,
  onTicketSelect,
  isLoading,
  error,
  onRetry,
}: TicketListProps) {
  const navigate = useNavigate();
  /* ---- Loading state ---- */
  if (isLoading) {
    return (
      <div className="flex flex-col divide-y divide-border" aria-label="Loading tickets">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }

  /* ---- Error state ---- */
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 px-4">
        <p className="text-sm text-danger text-center">
          Failed to load tickets
        </p>
        <p className="text-xs text-text-muted text-center max-w-sm">
          {error.message}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  /* ---- Empty state ---- */
  if (tickets.length === 0) {
    return (
      <EmptyState
        message="No tickets found"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate("/new")}
          >
            Create your first ticket
          </Button>
        }
      />
    );
  }

  /* ---- Normal state ---- */
  return (
    <div className="flex flex-col divide-y divide-border">
      {tickets.map((ticket) => (
        <TicketListItem
          key={ticket.id}
          ticket={ticket}
          isSelected={selectedTicketId === ticket.id}
          onClick={() => onTicketSelect(ticket.id)}
        />
      ))}
    </div>
  );
}
