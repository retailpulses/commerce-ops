import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { publishListingText, resolveExactListing } from "../../../_lib/listing-optimization";
import { createSupabaseClient } from "../../../_lib/supabase";

export async function onRequestPost(context: { request: Request; env: Record<string, string>; params: { id: string } }) {
  try { await requireAuth(context.request, context.env); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const config = getConfig(context.env);
  if (!config.mutationsEnabled) return Response.json({ error: "Dashboard mutations are currently disabled" }, { status: 503 });
  const inquiryId = Number(context.params.id);
  const inquiry = await createSupabaseClient(config).getInquiryDetail(inquiryId);
  if (!inquiry) return Response.json({ error: "Inquiry not found" }, { status: 404 });
  const resolved = await resolveExactListing(config, inquiry);
  if (resolved.status !== "ready" || !resolved.listing) return Response.json(resolved, { status: 409 });
  let body: { fields?: unknown; title?: unknown; description?: unknown; expectedContentRevision?: unknown };
  try { body = await context.request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body.expectedContentRevision !== resolved.listing.contentRevision) return Response.json({ error: "Listing changed; reload before publishing" }, { status: 409 });
  const fields = Array.isArray(body.fields) ? body.fields.filter((field) => field === "title" || field === "description") : [];
  if (!fields.length) return Response.json({ error: "Select title and/or description" }, { status: 400 });
  const requestBody: Record<string, unknown> = {
    operator_confirmed: true, fields, expected_content_revision: resolved.listing.contentRevision,
    idempotency_key: `inquiry-${inquiryId}-listing-${resolved.listing.id}-r${resolved.listing.contentRevision}-${fields.sort().join("-")}`,
  };
  if (fields.includes("title")) requestBody.title = body.title;
  if (fields.includes("description")) requestBody.description = body.description;
  try { return Response.json(await publishListingText(config, resolved.listing.id, requestBody)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Publish failed" }, { status: 502 }); }
}
