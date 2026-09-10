import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { TicketFilters } from "@/api/types";
import { useTicketList } from "@/hooks/useTickets";
import { ticketFiltersFromSearch } from "@/lib/ticket-drillthrough";
import { FilterBar } from "./FilterBar";
import { TicketList } from "./TicketList";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ListPaneProps {
  selectedTicketId: string | null;
  onTicketSelect: (id: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Default filters                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  ListPane                                                           */
/* ------------------------------------------------------------------ */

export function ListPane({ selectedTicketId, onTicketSelect }: ListPaneProps) {
  const location = useLocation();
  const [filters, setFilters] = useState<TicketFilters>(() => ticketFiltersFromSearch(window.location.search));

  useEffect(() => {
    setFilters(ticketFiltersFromSearch(location.search));
  }, [location.search]);

  const { data, isLoading, error, refetch } = useTicketList(filters);

  const tickets = data?.tickets ?? [];
  const total = data?.total ?? 0;

  const handleFiltersChange = (newFilters: TicketFilters) => {
    setFilters(newFilters);
  };

  return (
    <aside className="flex flex-col bg-white border-r border-border min-h-0 overflow-hidden">
      {/* Filters */}
      <FilterBar filters={filters} onFiltersChange={handleFiltersChange} />

      {/* Ticket count */}
      <div className="px-3 py-2 border-b border-border text-xs text-text-muted font-medium">
        {isLoading ? "Loading..." : `${total} ticket${total !== 1 ? "s" : ""}`}
      </div>

      {/* Scrollable ticket list */}
      <div className="flex-1 overflow-y-auto">
        <TicketList
          tickets={tickets}
          selectedTicketId={selectedTicketId}
          onTicketSelect={onTicketSelect}
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
        />
      </div>
    </aside>
  );
}
