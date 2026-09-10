import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { composeStructuredListingDescription, LISTING_ENRICHMENT_PROMPT, resolveExactListing } from "../../../_lib/listing-optimization";
import { createSupabaseClient } from "../../../_lib/supabase";

export async function onRequestPost(context: { request: Request; env: Record<string, string>; params: { id: string } }) {
  try { await requireAuth(context.request, context.env); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const config = getConfig(context.env);
  if (!config.mutationsEnabled) return Response.json({ error: "Dashboard mutations are currently disabled" }, { status: 503 });
  const inquiry = await createSupabaseClient(config).getInquiryDetail(Number(context.params.id));
  if (!inquiry) return Response.json({ error: "Inquiry not found" }, { status: 404 });
  const resolved = await resolveExactListing(config, inquiry);
  if (resolved.status !== "ready" || !resolved.listing) return Response.json(resolved, { status: 409 });
  const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${config.openai.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({
    model: config.openai.model, temperature: 0.2, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: LISTING_ENRICHMENT_PROMPT },
      { role: "user", content: JSON.stringify({ marketplace: resolved.listing.platform, title: resolved.listing.title, description: resolved.listing.description }) },
    ],
  }) });
  if (!response.ok) return Response.json({ error: "Optimization generation failed" }, { status: 502 });
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  try {
    const proposal = JSON.parse(payload.choices?.[0]?.message?.content || "{}") as Record<string, unknown>;
    const enrichment = typeof proposal.description === "string" ? proposal.description.trim() : "";
    if (!enrichment) return Response.json({ error: "Optimization response was invalid" }, { status: 502 });
    return Response.json({
      title: resolved.listing.title,
      description: composeStructuredListingDescription(resolved.listing.description, enrichment),
      contentRevision: resolved.listing.contentRevision,
    });
  } catch { return Response.json({ error: "Optimization response was invalid" }, { status: 502 }); }
}
