import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { createFollowUpClient } from "../../../_lib/follow-ups";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

const VALID_STATES = new Set(["scheduled", "do_not_follow_up", "cleared"]);

/**
 * PATCH /api/inquiries/:id/follow-up — operator schedule override / clear.
 * Changing the date never sends a message; it only re-projects the queue.
 */
export async function onRequestPatch(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const actor = await requireAuth(context.request, context.env).catch(() => null);
  if (!actor) return jsonError(401, "Unauthorized");

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) return jsonError(400, "Invalid inquiry ID");

  let payload: {
    dueDate?: string | null;
    state?: string;
    reason?: string;
  };
  try {
    payload = (await context.request.json()) as typeof payload;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const state = payload.state ?? "scheduled";
  if (!VALID_STATES.has(state)) {
    return jsonError(400, `Invalid state. Must be one of: ${[...VALID_STATES].join(", ")}`);
  }

  if (state === "scheduled" && !payload.dueDate) {
    return jsonError(400, "dueDate is required when state is scheduled");
  }

  const dueDate = payload.dueDate ? payload.dueDate.slice(0, 10) : null;
  if (dueDate && isNaN(Date.parse(dueDate))) {
    return jsonError(400, "Invalid dueDate; expected YYYY-MM-DD");
  }

  try {
    const config = getConfig(context.env);
    const client = createFollowUpClient(config);
    const result = await client.scheduleFollowUp(inquiryId, {
      dueDate,
      state,
      actor: actor.email,
      reason: payload.reason ?? null,
    });
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: JSON_HEADERS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update follow-up";
    return jsonError(500, message);
  }
}
