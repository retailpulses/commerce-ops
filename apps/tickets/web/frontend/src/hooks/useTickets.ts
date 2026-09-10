import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ticketsApi from "../api/tickets";
import type {
  Ticket,
  TicketFilters,
  CreateTicketInput,
  ProductSearchResult,
  CreateResolutionInput,
  CreateTicketShareInput,
} from "../api/types";

export function useTicketList(filters: TicketFilters) {
  return useQuery({
    queryKey: ["tickets", filters],
    queryFn: () => ticketsApi.listTickets(filters),
  });
}

export function useTicketDetail(id: string | null) {
  return useQuery({
    queryKey: ["ticket", id],
    queryFn: () => ticketsApi.getTicket(id!),
    enabled: !!id,
  });
}

export function useOrderContext(ticketId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["ticket-order-context", ticketId],
    queryFn: () => ticketsApi.getOrderContext(ticketId!),
    enabled: Boolean(ticketId && enabled),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTicketInput) => ticketsApi.createTicket(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }),
  });
}

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<Ticket> }) =>
      ticketsApi.updateTicket(id, input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
      if (data.ticket?.id) {
        qc.setQueryData(["ticket", data.ticket.id], (old: unknown) => {
          if (!old) return old;
          const prev = old as { ticket: Record<string, unknown> };
          return { ...prev, ticket: { ...prev.ticket, ...data.ticket } };
        });
      }
    },
  });
}

export function useLinkProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      product,
    }: {
      ticketId: string;
      product: ProductSearchResult;
    }) => ticketsApi.linkProduct(ticketId, product),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] }),
  });
}

export function useUnlinkProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      productId,
    }: {
      ticketId: string;
      productId: string;
    }) => ticketsApi.unlinkProduct(ticketId, productId),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] }),
  });
}

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, body }: { ticketId: string; body: string }) =>
      ticketsApi.addNote(ticketId, body),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] }),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, noteId, body }: { ticketId: string; noteId: string; body: string }) =>
      ticketsApi.updateNote(ticketId, noteId, body),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] }),
  });
}

export function useIssueTypes() {
  return useQuery({
    queryKey: ["issueTypes"],
    queryFn: ticketsApi.getIssueTypes,
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
}

export function useStatuses() {
  return useQuery({
    queryKey: ["statuses"],
    queryFn: ticketsApi.getStatuses,
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
}

export function useAttachments(ticketId: string | null) {
  return useQuery({
    queryKey: ["ticket-attachments", ticketId],
    queryFn: () => ticketsApi.listAttachments(ticketId!),
    enabled: !!ticketId,
  });
}

export function useUploadAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, file }: { ticketId: string; file: File }) =>
      ticketsApi.uploadAttachment(ticketId, file),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["ticket-attachments", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, attachmentId }: { ticketId: string; attachmentId: string }) =>
      ticketsApi.deleteAttachment(ticketId, attachmentId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["ticket-attachments", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] });
    },
  });
}

export function useRecordResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, input }: { ticketId: string; input: CreateResolutionInput }) =>
      ticketsApi.recordResolution(ticketId, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useTicketShares(ticketId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ticket-shares", ticketId],
    queryFn: () => ticketsApi.listTicketShares(ticketId!),
    enabled: !!ticketId && enabled,
  });
}

export function useCreateTicketShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, input }: { ticketId: string; input: CreateTicketShareInput }) =>
      ticketsApi.createTicketShare(ticketId, input),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket-shares", vars.ticketId] }),
  });
}

export function useRotateTicketShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, input }: { ticketId: string; input: CreateTicketShareInput }) =>
      ticketsApi.rotateTicketShare(ticketId, input),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket-shares", vars.ticketId] }),
  });
}

export function useRevokeTicketShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, shareId }: { ticketId: string; shareId: string }) =>
      ticketsApi.revokeTicketShare(ticketId, shareId),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["ticket-shares", vars.ticketId] }),
  });
}

export function useSearchProducts(q: string, platform?: string) {
  return useQuery({
    queryKey: ["productSearch", q, platform],
    queryFn: () => ticketsApi.searchProducts(q, platform),
    enabled: q.length > 0,
    staleTime: 30_000,
  });
}

export function useGenerateAfterSalesLink() {
  return useMutation({
    mutationFn: ({ ticketId }: { ticketId: string }) =>
      ticketsApi.generateAfterSalesLink(ticketId, crypto.randomUUID()),
  });
}
