import type { TicketMessage } from "../repositories/ticketRepository";
import { SendError } from "../services/sendError";
import type { PlatformSendAdapter, PlatformSendCommand, PlatformSendResult, SendPlatform } from "../services/platformSendRouter";

export const PROVIDER_CONTRACT_VERSION = "2026-09-09.v1";

export interface ProviderSendRequest {
  contract_version: typeof PROVIDER_CONTRACT_VERSION;
  platform: SendPlatform;
  ticket_id: string;
  message: string;
  client_operation_id: string;
  reply_intent: "terminal" | "holding";
  reviewed: unknown;
  actor_id: string;
  expected_release_sha: string;
}

export interface ProviderSendSuccess {
  ok: true;
  contract_version: typeof PROVIDER_CONTRACT_VERSION;
  platform: SendPlatform;
  platform_message_id: string;
  sent_at: string;
  ticket_message: TicketMessage;
  replayed: boolean;
  release_sha: string;
  warning?: string;
  warning_code?: string;
}

export interface ProviderSendFailure {
  ok: false;
  contract_version: typeof PROVIDER_CONTRACT_VERSION;
  platform: SendPlatform;
  error: { code: string; message: string };
}

export type ProviderSendResponse = ProviderSendSuccess | ProviderSendFailure;

export function parseProviderSendRequest(value: unknown, expectedPlatform: SendPlatform): ProviderSendRequest {
  if (!value || typeof value !== "object") throw new SendError("Invalid provider request", "PROVIDER_CONTRACT_INVALID", 400);
  const input = value as Record<string, unknown>;
  if (input.contract_version !== PROVIDER_CONTRACT_VERSION) throw new SendError("Unsupported provider contract version", "PROVIDER_CONTRACT_VERSION_UNSUPPORTED", 409);
  if (input.platform !== expectedPlatform) throw new SendError("Provider platform mismatch", "PLATFORM_MISMATCH", 409);
  if (typeof input.ticket_id !== "string" || !input.ticket_id) throw new SendError("ticket_id is required", "PROVIDER_CONTRACT_INVALID", 400);
  if (typeof input.message !== "string" || !input.message.trim()) throw new SendError("message is required", "PROVIDER_CONTRACT_INVALID", 400);
  if (typeof input.client_operation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.client_operation_id)) throw new SendError("client_operation_id is invalid", "PROVIDER_CONTRACT_INVALID", 400);
  if (input.reply_intent !== "terminal" && input.reply_intent !== "holding") throw new SendError("reply_intent is invalid", "PROVIDER_CONTRACT_INVALID", 400);
  if (typeof input.actor_id !== "string" || !input.actor_id) throw new SendError("actor_id is required", "PROVIDER_CONTRACT_INVALID", 400);
  if (typeof input.expected_release_sha !== "string" || !/^[0-9a-f]{40}$/i.test(input.expected_release_sha)) throw new SendError("expected_release_sha is invalid", "PROVIDER_CONTRACT_INVALID", 400);
  const allowed = new Set(["contract_version", "platform", "ticket_id", "message", "client_operation_id", "reply_intent", "reviewed", "actor_id", "expected_release_sha"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new SendError("Unknown provider contract field", "PROVIDER_CONTRACT_INVALID", 400);
  return input as unknown as ProviderSendRequest;
}

export class ServiceBindingSendAdapter implements PlatformSendAdapter {
  constructor(readonly platform: SendPlatform, private readonly binding: Fetcher | undefined, private readonly expectedReleaseSha?: string) {}

  async preflight(commandTicket: PlatformSendCommand["ticket"]): Promise<void> {
    if (commandTicket.platform !== this.platform) throw new SendError("Ticket platform does not match provider binding", "PLATFORM_MISMATCH", 409);
    if (!this.binding) throw new SendError(`${this.platform} provider binding is unavailable`, "PROVIDER_BINDING_UNAVAILABLE", 503);
    const response = await this.binding.fetch("https://provider.internal/health");
    const health = await response.json().catch(() => null) as { platform?: unknown; role?: unknown; status?: unknown; contract_version?: unknown; release_sha?: unknown } | null;
    if (!health || health.platform !== this.platform || health.role !== "send") throw new SendError("Provider health identity mismatch", "PLATFORM_RESULT_MISMATCH", 502);
    if (health.contract_version !== PROVIDER_CONTRACT_VERSION) throw new SendError("Provider contract version mismatch", "PROVIDER_CONTRACT_VERSION_UNSUPPORTED", 409);
    if (!this.expectedReleaseSha || !/^[0-9a-f]{40}$/i.test(this.expectedReleaseSha) || health.release_sha !== this.expectedReleaseSha) throw new SendError("Provider release version mismatch", "PROVIDER_RELEASE_MISMATCH", 503);
    if (!response.ok || health.status !== "ready") throw new SendError(`${this.platform} provider is unavailable`, "PLATFORM_SEND_UNAVAILABLE", 503);
  }

  async send(command: PlatformSendCommand): Promise<PlatformSendResult> {
    await this.preflight(command.ticket);
    const payload: ProviderSendRequest = {
      contract_version: PROVIDER_CONTRACT_VERSION,
      platform: this.platform,
      ticket_id: command.ticket.id,
      message: command.message,
      client_operation_id: command.clientOperationId,
      reply_intent: command.replyIntent,
      reviewed: command.reviewed,
      actor_id: command.sentBy || "portal_operator",
      expected_release_sha: this.expectedReleaseSha!,
    };
    const response = await this.binding!.fetch("https://provider.internal/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as ProviderSendResponse;
    if (result.contract_version !== PROVIDER_CONTRACT_VERSION || result.platform !== this.platform || (result.ok && result.release_sha !== this.expectedReleaseSha)) {
      throw new SendError("Provider returned a mismatched contract", "PLATFORM_RESULT_MISMATCH", 502);
    }
    if (!result.ok) throw new SendError(result.error.message, result.error.code, response.status);
    return {
      platform: result.platform,
      platformMessageId: result.platform_message_id,
      sentAt: result.sent_at,
      ticketMessage: result.ticket_message,
      replayed: result.replayed,
      warning: result.warning,
      warningCode: result.warning_code,
    };
  }
}

export function providerJson(data: ProviderSendResponse, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
