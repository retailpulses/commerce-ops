import { getSupabaseClient } from "../repositories/supabase";
import { SendError } from "../services/sendError";
import type { Env } from "../types";
import type { PlatformSendAdapter, SendPlatform } from "../services/platformSendRouter";
import type { TicketDetail } from "../repositories/ticketRepository";
import { PROVIDER_CONTRACT_VERSION, parseProviderSendRequest, providerJson } from "./providerContract";
import { runtimeHealthFetch, withRuntimeLease } from "./runtimeHealth";

export type ProviderAdapterFactory = (env: Env) => PlatformSendAdapter;

const SAFE_ERRORS: Record<string, string> = {
  NOT_FOUND: "Ticket not found",
  PLATFORM_MISMATCH: "Ticket platform mismatch",
  MERCARI_SEND_DISABLED: "Mercari outbound send is disabled",
  RAKUTEN_SEND_DISABLED: "Rakuten outbound send is disabled",
  AMAZON_SPAPI_ACTION_UNAVAILABLE: "No approved Amazon SP-API action is available",
  PLATFORM_SEND_UNSUPPORTED: "Platform send is unsupported",
  INVALID_ORDER_ID: "Provider transaction identity is invalid",
  NO_ACCOUNT: "Platform account is missing",
  NOT_MERCARI: "Platform account mismatch",
  TOKEN_NOT_SET: "Provider credential is unavailable",
  RAKUTEN_RELAY_NOT_CONFIGURED: "Provider relay is unavailable",
  STALE_THREAD: "The customer thread changed; review again before sending",
  SEND_IN_PROGRESS: "A send operation is already in progress",
  SEND_OUTCOME_AMBIGUOUS: "Provider outcome requires reconciliation",
};

export function createProviderWorker(platform: SendPlatform, factory: ProviderAdapterFactory) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/health" || path === "/version") return runtimeHealthFetch(platform, "send", request, env);
      if (path !== "/v1/send" || request.method !== "POST") return new Response("Not found", { status: 404 });
      return withRuntimeLease(platform, "send", env, async () => {
      try {
        const input = parseProviderSendRequest(await request.json(), platform);
        if (!env.RELEASE_SHA || input.expected_release_sha !== env.RELEASE_SHA) throw new SendError("Provider release mismatch", "PROVIDER_RELEASE_MISMATCH", 409);
        const { data: ticketData, error: ticketError } = await getSupabaseClient(env).rpc(`get_${platform}_send_ticket_v1`, { p_ticket_id: input.ticket_id });
        if (ticketError) throw new SendError("Ticket capability is unavailable", "PLATFORM_SCHEMA_UNAVAILABLE", 503);
        const ticket = ticketData as TicketDetail | null;
        if (!ticket) throw new SendError("Ticket not found", "NOT_FOUND", 404);
        if (ticket.platform !== platform) throw new SendError("Authoritative ticket platform mismatch", "PLATFORM_MISMATCH", 409);
        const result = await factory(env).send({
          ticket,
          message: input.message,
          clientOperationId: input.client_operation_id,
          replyIntent: input.reply_intent,
          reviewed: input.reviewed,
          sentBy: input.actor_id,
        });
        return providerJson({
          ok: true,
          contract_version: PROVIDER_CONTRACT_VERSION,
          platform,
          platform_message_id: result.platformMessageId,
          sent_at: result.sentAt,
          ticket_message: result.ticketMessage,
          replayed: result.replayed,
          release_sha: env.RELEASE_SHA,
          warning: result.warning,
          warning_code: result.warningCode,
        });
      } catch (cause) {
        const original = cause instanceof SendError ? cause : new SendError("Provider send failed", "PROVIDER_SEND_FAILED", 500);
        const safeCode = SAFE_ERRORS[original.code] ? original.code : "PROVIDER_SEND_FAILED";
        const safeMessage = SAFE_ERRORS[safeCode] || "Provider send failed";
        console.error("Provider send failed", { platform, error_code: safeCode, error_type: cause instanceof Error ? cause.constructor.name : "unknown" });
        return providerJson({ ok: false, contract_version: PROVIDER_CONTRACT_VERSION, platform, error: { code: safeCode, message: safeMessage } }, original.status >= 400 && original.status <= 599 ? original.status : 500);
      }
      });
    },
  };
}
