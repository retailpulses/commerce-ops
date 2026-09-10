import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig, VALID_STATUS_KEYS } from "../../../_lib/config";

/** PATCH /api/inquiries/:id/status — update inquiry status */
export async function onRequestPatch(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const config = getConfig(context.env);

  // Auth required for mutations
  try {
    await requireAuth(context.request, context.env);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }

  // Kill switch
  if (!config.mutationsEnabled) {
    return new Response(JSON.stringify({ error: "Dashboard mutations are currently disabled" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const supabase = createSupabaseClient(config);

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { statusKey?: string };
  try {
    body = (await context.request.json()) as { statusKey?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!body.statusKey || !VALID_STATUS_KEYS.includes(body.statusKey)) {
    return new Response(
      JSON.stringify({ error: `Invalid statusKey. Must be one of: ${VALID_STATUS_KEYS.join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }

  try {
    await supabase.updateInquiry(inquiryId, { status: body.statusKey });

    return new Response(
      JSON.stringify({ success: true, status: { id: body.statusKey, label: body.statusKey } }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update status";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }
}
