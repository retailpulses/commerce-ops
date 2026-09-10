import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as copyApi from "../api/copywriting";

export function useCopywrite() {
  return useMutation({
    mutationFn: ({
      ticketId,
      guide,
    }: {
      ticketId: string;
      guide?: string;
    }) => copyApi.copywrite(ticketId, guide),
  });
}

export function useSendReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      message,
      intent,
      clientOperationId,
      lastSeenAt,
      reviewedCustomerMessageId,
      reviewedCustomerRevision,
      reviewedThreadRevision,
    }: {
      ticketId: string;
      message: string;
      intent: "terminal" | "holding";
      clientOperationId: string;
      lastSeenAt?: string;
      reviewedCustomerMessageId?: string;
      reviewedCustomerRevision?: string;
      reviewedThreadRevision?: string;
    }) => copyApi.sendReply(ticketId, message, intent, clientOperationId, lastSeenAt, reviewedCustomerMessageId, reviewedCustomerRevision, reviewedThreadRevision),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["thread", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export function useSaveDraft() {
  return useMutation({
    mutationFn: ({
      ticketId,
      body,
      guide,
    }: {
      ticketId: string;
      body: string;
      guide?: string;
    }) => copyApi.saveDraft(ticketId, body, guide),
  });
}

export function useLoadDraft(ticketId: string | null) {
  return useQuery({
    queryKey: ["draft", ticketId],
    queryFn: () => copyApi.getDraft(ticketId!),
    enabled: !!ticketId,
  });
}

export function useThread(ticketId: string | null) {
  return useQuery({
    queryKey: ["thread", ticketId],
    queryFn: () => copyApi.getThread(ticketId!),
    enabled: !!ticketId,
  });
}

export function useInspectAmazonSend(ticketId: string | null, clientOperationId: string | null) {
  return useQuery({
    queryKey: ["amazon-send-resolution", ticketId, clientOperationId],
    queryFn: () => copyApi.inspectAmazonSend(ticketId!, clientOperationId!),
    enabled: !!ticketId && !!clientOperationId,
  });
}

export function useResolveAmazonSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      ticketId: string;
      clientOperationId: string;
      resolution: "confirmed_sent" | "confirmed_not_sent";
      platformMessageId?: string;
    }) => copyApi.resolveAmazonSend(
      input.ticketId, input.clientOperationId, input.resolution, input.platformMessageId,
    ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["ticket", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["thread", vars.ticketId] });
      qc.invalidateQueries({ queryKey: ["tickets"] });
      qc.invalidateQueries({ queryKey: ["amazon-send-resolution", vars.ticketId] });
    },
  });
}
