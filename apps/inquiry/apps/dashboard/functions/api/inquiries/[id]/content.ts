import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";

const MAX_CONTENT_LENGTH = 50_000;

export async function onRequestPatch(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const config = getConfig(context.env);
  try {
    await requireAuth(context.request, context.env);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
  if (!config.mutationsEnabled) {
    return Response.json(
      { error: "Dashboard mutations are currently disabled" },
      { status: 503 },
    );
  }
  const inquiryId = Number(context.params.id);
  if (!Number.isSafeInteger(inquiryId) || inquiryId < 1) {
    return Response.json({ error: "Invalid inquiry ID" }, { status: 400 });
  }
  let body: { content?: unknown };
  try {
    body = (await context.request.json()) as { content?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return Response.json(
      { error: "content must be a string" },
      { status: 400 },
    );
  }
  const content = body.content.trim();
  if (!content)
    return Response.json(
      { error: "Inquiry content cannot be empty" },
      { status: 400 },
    );
  if (content.length > MAX_CONTENT_LENGTH) {
    return Response.json(
      {
        error: `Inquiry content must be ${MAX_CONTENT_LENGTH} characters or fewer`,
      },
      { status: 400 },
    );
  }
  try {
    await createSupabaseClient(config).updateInquiry(inquiryId, {
      inquiry_body: content,
    });
    return Response.json({ success: true, content });
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to save inquiry content",
      },
      { status: 500 },
    );
  }
}
