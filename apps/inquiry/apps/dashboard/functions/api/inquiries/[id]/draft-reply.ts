import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";

/** POST /api/inquiries/:id/draft-reply — save operator's raw draft */
export async function onRequestPost(context: {
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

  let body: { draft?: string };
  try {
    body = (await context.request.json()) as { draft?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (typeof body.draft !== "string") {
    return new Response(JSON.stringify({ error: "draft (string) is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    await supabase.updateInquiry(inquiryId, {
      draft_reply: body.draft,
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save draft";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
