import { getConfig } from "../../../_lib/config";
import { createFollowUpClient } from "../../../_lib/follow-ups";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** GET /api/inquiries/:id/messages — normalized message timeline (tombstoned hidden) */
export async function onRequestGet(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  try {
    const config = getConfig(context.env);
    const client = createFollowUpClient(config);
    const rows = await client.getMessages(inquiryId);

    const messages = rows
      .filter((m) => m.deleted_at === null)
      .map((m) => ({
        id: m.id,
        externalMessageId: m.external_message_id,
        from: m.external_from,
        direction: m.direction,
        body: m.body ?? "",
        sentAt: m.sent_at,
        status: m.external_status,
        sourcePayloadHash: m.source_payload_hash,
        outboundOperationId: m.outbound_operation_id,
      }));

    return new Response(JSON.stringify({ data: messages }), {
      headers: JSON_HEADERS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch messages";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}
