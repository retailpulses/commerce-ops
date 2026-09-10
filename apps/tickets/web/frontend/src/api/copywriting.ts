import { api } from "./client";
import type { Draft, ThreadMessage, SendResponse } from "./types";

interface CopywriteResponse {
  reply: string;
  model: string;
  prompt_version: string;
}

export async function copywrite(
  ticketId: string,
  resolutionGuide?: string,
): Promise<CopywriteResponse> {
  return api<CopywriteResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/copywrite`,
    {
      method: "POST",
      body: JSON.stringify(
        resolutionGuide ? { resolution_guide: resolutionGuide } : {},
      ),
    },
  );
}

export async function sendReply(
  ticketId: string,
  message: string,
  intent: "terminal" | "holding",
  clientOperationId: string,
  lastSeenAt?: string,
  reviewedCustomerMessageId?: string,
  reviewedCustomerRevision?: string,
  reviewedThreadRevision?: string,
): Promise<SendResponse> {
  return api<SendResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/send`,
    {
      method: "POST",
      body: JSON.stringify({
        message,
        reply_intent: intent,
        client_operation_id: clientOperationId,
        ...(lastSeenAt ? { last_seen_message_at: lastSeenAt } : {}),
        ...(reviewedCustomerMessageId ? { reviewed_customer_message_id: reviewedCustomerMessageId } : {}),
        ...(reviewedCustomerRevision ? { reviewed_customer_revision: reviewedCustomerRevision } : {}),
        ...(reviewedThreadRevision ? { reviewed_thread_revision: reviewedThreadRevision } : {}),
      }),
    },
  );
}

export async function saveDraft(
  ticketId: string,
  body: string,
  resolutionGuide?: string,
): Promise<void> {
  await api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/draft`, {
    method: "POST",
    body: JSON.stringify(
      resolutionGuide
        ? { body, resolution_guide: resolutionGuide }
        : { body },
    ),
  });
}

interface GetDraftResponse {
  draft: Draft | null;
}

export async function getDraft(ticketId: string): Promise<GetDraftResponse> {
  return api<GetDraftResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/draft`,
  );
}

interface GetThreadResponse {
  messages: ThreadMessage[];
  latest_buyer_message_at: string | null;
  latest_buyer_message_id: string | null;
  latest_thread_revision: string | null;
  latest_customer_revision: string | null;
  reply_context?: {
    from_address: string;
    to_address_masked: string;
    subject: string;
  } | null;
  fetch_error?: string;
}

export async function getThread(ticketId: string): Promise<GetThreadResponse> {
  return api<GetThreadResponse>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/thread`,
  );
}

export interface AmazonSendCandidate {
  platformMessageId: string;
  sentAt: string;
}

export interface AmazonSendInspection {
  clientOperationId: string;
  deliveryStatus: string;
  providerMutationStartedAt: string | null;
  noSendFirstObservedAt: string | null;
  noSendLastObservedAt: string | null;
  noSendObservationCount: number;
  candidates: AmazonSendCandidate[];
}

export async function inspectAmazonSend(ticketId: string, clientOperationId: string): Promise<AmazonSendInspection> {
  return api<AmazonSendInspection>(
    `/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/amazon-send-resolution?client_operation_id=${encodeURIComponent(clientOperationId)}`,
  );
}

export async function resolveAmazonSend(
  ticketId: string,
  clientOperationId: string,
  resolution: "confirmed_sent" | "confirmed_not_sent",
  platformMessageId?: string,
): Promise<{ resolution: string; eligibleAfter?: string | null; nextObservationAfter?: string | null }> {
  return api(`/tickets/api/ticketing/tickets/${encodeURIComponent(ticketId)}/amazon-send-resolution`, {
    method: "POST",
    body: JSON.stringify({
      client_operation_id: clientOperationId,
      resolution,
      ...(platformMessageId ? { platform_message_id: platformMessageId } : {}),
    }),
  });
}
