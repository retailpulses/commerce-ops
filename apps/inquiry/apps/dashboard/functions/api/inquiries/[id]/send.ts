import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import {
  bodyHash,
  createFollowUpClient,
  outboundIdempotencyKey,
} from "../../../_lib/follow-ups";
import { createMercariRelayClient } from "../../../_lib/mercari-relay";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

/**
 * POST /api/inquiries/:id/send — controlled operator Send.
 *
 * Contract: authorize -> kill switch -> claim (single active lease) -> relay
 * mutation (idempotency key) -> authoritative readback -> atomic finalize.
 * Ambiguous relay results are surfaced and never blindly retried.
 */
export async function onRequestPost(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const actor = await requireAuth(context.request, context.env).catch(() => null);
  if (!actor) return jsonError(401, "Unauthorized");

  const config = getConfig(context.env);
  if (!config.outboundSendEnabled) {
    return jsonError(503, "Outbound send is currently disabled");
  }

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) return jsonError(400, "Invalid inquiry ID");

  let payload: {
    body?: string;
    followUpCycleId?: string | null;
    followUpDueDate?: string | null;
  };
  try {
    payload = (await context.request.json()) as typeof payload;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const body = (payload.body ?? "").trim();
  if (!body) return jsonError(400, "Message body is required");
  if (body.length > 5000) return jsonError(400, "Message body is too long");

  const client = createFollowUpClient(config);
  const ctx = await client.getOutboundContext(inquiryId);
  if (!ctx) return jsonError(404, "Inquiry not found");
  if (!ctx.shop_key || !ctx.external_inquiry_id) {
    return jsonError(409, "Inquiry is not API-canonical; cannot send");
  }
  if (
    ctx.external_target_type === "InquiryOrderTransactionTarget" ||
    ctx.external_order_transaction_id
  ) {
    return jsonError(409, "Order-target inquiries are not routable through inquiry outbound");
  }

  // Only an explicit queue action is a follow-up. A normal reply must not
  // inherit a stale/superseded cycle from the inquiry row.
  const cycleId = payload.followUpCycleId ?? null;
  if (cycleId && cycleId !== ctx.follow_up_cycle_id) {
    return jsonError(409, "Follow-up cycle is stale; refresh the inquiry");
  }
  if (cycleId && ctx.follow_up_state !== "scheduled") {
    return jsonError(409, "Follow-up cycle is no longer active");
  }
  // A normal reply is keyed to the latest canonical platform message. This
  // creates a new stable reply opportunity after every inbound message while
  // retries against the same thread state reuse the identical key.
  const canonicalMessages = await client.getMessages(inquiryId);
  const canonicalLatest = [...canonicalMessages]
    .filter((message) => !message.deleted_at)
    .sort((a, b) => `${a.sent_at ?? ""}:${a.id}`.localeCompare(`${b.sent_at ?? ""}:${b.id}`))
    .at(-1);
  if (!canonicalLatest) {
    return jsonError(409, "Conversation has no canonical message evidence; refresh before sending");
  }
  const idempotencyCycle = cycleId ?? `reply:${canonicalLatest.external_message_id}`;
  const idempotencyKey = await outboundIdempotencyKey({
    shopKey: ctx.shop_key,
    externalInquiryId: ctx.external_inquiry_id,
    cycleId: idempotencyCycle,
    operationVersion: 1,
  });

  // 1. Claim (single active lease per inquiry/cycle).
  let claim: Record<string, unknown>;
  try {
    claim = await client.claimOutbound(inquiryId, cycleId, idempotencyKey, actor.email, body);
  } catch (err) {
    return jsonError(409, err instanceof Error ? err.message : "Unable to claim inquiry");
  }

  if (claim.claimed === false) {
    return jsonError(409, "Another send is already in progress for this inquiry");
  }
  const operationId = claim.operationId as number;

  const relay = createMercariRelayClient(config);

  // 2. Fresh authoritative thread read after claim. A stale canonical thread
  // must never authorize a send.
  try {
    const platformMessages = await relay.inquiryMessages(ctx.shop_key, ctx.external_inquiry_id);
    const platformLatest = [...platformMessages]
      .filter((message) => message.status !== "DELETED")
      .sort((a, b) => `${a.sentAt ?? ""}:${a.messageId}`.localeCompare(`${b.sentAt ?? ""}:${b.messageId}`))
      .at(-1);
    if (!canonicalLatest || !platformLatest || canonicalLatest.external_message_id !== platformLatest.messageId) {
      await client.markOutboundResult(operationId, "failed", "stale_thread_before_send");
      return jsonError(409, "Conversation changed; refresh before sending");
    }
  } catch (err) {
    await client.markOutboundResult(operationId, "failed", "fresh_read_failed").catch(() => undefined);
    return jsonError(502, err instanceof Error ? err.message : "Fresh thread read failed");
  }

  // 3. Relay mutation (single attempt; ambiguous => no blind retry).
  let mutationResult;
  try {
    mutationResult = await relay.addInquiryMessage(ctx.shop_key, {
      inquiryId: ctx.external_inquiry_id,
      body,
      idempotencyKey,
    });
    await client.markOutboundResult(operationId, "sent");
  } catch (err) {
    await client.markOutboundResult(operationId, "ambiguous", err instanceof Error ? err.message : "mutation_failed").catch(() => undefined);
    const message = err instanceof Error ? err.message : "Mercari send failed";
    return jsonError(502, `${message}; result is ambiguous and will not be retried automatically`);
  }

  // 4. Authoritative post-mutation readback. Mutation payload alone is not
  // delivery proof.
  try {
    const messages = await relay.inquiryMessages(ctx.shop_key, ctx.external_inquiry_id);
    const readback = messages.find((message) =>
      message.messageId === mutationResult.messageId &&
      message.from === "SELLER" &&
      message.status !== "DELETED",
    );
    if (!readback) {
      await client.markOutboundResult(operationId, "ambiguous", "message_not_found_in_readback");
      return jsonError(502, "Message was not confirmed by authoritative readback; it will not be retried automatically");
    }
    const finalized = await client.finalizeOutbound(
      operationId,
      {
        mercariMessageId: readback.messageId,
        body: readback.body ?? body,
        sentAt: readback.sentAt,
        bodyHash: await bodyHash(readback.body ?? body),
      },
      { actor: actor.email, followUpDueDate: payload.followUpDueDate ?? null },
    );
    return new Response(JSON.stringify({ success: true, ...finalized }), {
      headers: JSON_HEADERS,
    });
  } catch (err) {
    await client.markOutboundResult(operationId, "ambiguous", err instanceof Error ? err.message : "finalize_failed").catch(() => undefined);
    const message = err instanceof Error ? err.message : "Finalize failed";
    return jsonError(502, message);
  }
}
