import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig, INQUIRY_TYPE_BY_KEY } from "../../../_lib/config";

/** PATCH /api/inquiries/:id/inquiry-type — operator correction of auto-classification */
export async function onRequestPatch(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const config = getConfig(context.env);
  try {
    await requireAuth(context.request, context.env);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  if (!config.mutationsEnabled) {
    return Response.json({ error: "Dashboard mutations are currently disabled" }, { status: 503 });
  }

  const inquiryId = Number(context.params.id);
  if (!Number.isInteger(inquiryId) || inquiryId <= 0) {
    return Response.json({ error: "Invalid inquiry ID" }, { status: 400 });
  }

  let body: { inquiryTypeKey?: string };
  try {
    body = (await context.request.json()) as { inquiryTypeKey?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const inquiryTypeKey = body.inquiryTypeKey;
  if (!inquiryTypeKey || !INQUIRY_TYPE_BY_KEY[inquiryTypeKey]) {
    return Response.json(
      { error: `Invalid inquiryTypeKey. Must be one of: ${Object.keys(INQUIRY_TYPE_BY_KEY).join(", ")}` },
      { status: 400 },
    );
  }

  try {
    await createSupabaseClient(config).updateInquiry(inquiryId, { inquiry_type: inquiryTypeKey });
    return Response.json({
      success: true,
      inquiryType: { id: inquiryTypeKey, label: INQUIRY_TYPE_BY_KEY[inquiryTypeKey] },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update inquiry type" },
      { status: 500 },
    );
  }
}
