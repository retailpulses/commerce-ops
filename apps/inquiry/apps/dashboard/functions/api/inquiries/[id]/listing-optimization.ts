import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { resolveExactListing } from "../../../_lib/listing-optimization";
import { createSupabaseClient } from "../../../_lib/supabase";

export async function onRequestGet(context: { request: Request; env: Record<string, string>; params: { id: string } }) {
  try { await requireAuth(context.request, context.env); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = Number(context.params.id);
  if (!Number.isInteger(id)) return Response.json({ error: "Invalid inquiry ID" }, { status: 400 });
  const config = getConfig(context.env);
  const inquiry = await createSupabaseClient(config).getInquiryDetail(id);
  if (!inquiry) return Response.json({ error: "Inquiry not found" }, { status: 404 });
  try { return Response.json(await resolveExactListing(config, inquiry)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Listing lookup failed" }, { status: 502 }); }
}
