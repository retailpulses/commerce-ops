export interface PortalTicketState {
  id: number;
  status: string;
  [key: string]: unknown;
}

/** Return a new sidebar list after a successful status update. */
export function syncTicketListStatus<T extends PortalTicketState>(
  tickets: T[],
  ticketId: number,
  newStatus: string,
  excludeClosed = true
): T[] {
  if (excludeClosed && (newStatus === "Closed Resolved" || newStatus === "Closed Unresolved")) {
    return tickets.filter((ticket) => ticket.id !== ticketId);
  }
  return tickets.map((ticket) => ticket.id === ticketId ? { ...ticket, status: newStatus } : ticket);
}
