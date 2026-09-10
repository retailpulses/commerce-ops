import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { createSupabaseClient, type InquiryDetailRow } from "../../../_lib/supabase";
import {
  getMainImageContext,
  proxyMainImageAction,
  MainImageError,
} from "../../../_lib/main-image";

type HandlerContext = { request: Request; env: Record<string, string>; params: { id: string } };

function toErrorResponse(error: unknown): Response {
  if (error instanceof MainImageError) {
    const payload = error.body ?? {
      error: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
    return Response.json(payload, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : "Image request failed" }, { status: 502 });
}

export async function onRequestGet(context: HandlerContext) {
  try { await requireAuth(context.request, context.env); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = Number(context.params.id);
  if (!Number.isInteger(id)) return Response.json({ error: "Invalid inquiry ID" }, { status: 400 });
  const config = getConfig(context.env);
  let inquiry: InquiryDetailRow | null;
  try {
    inquiry = await createSupabaseClient(config).getInquiryDetail(id);
  } catch (error) {
    console.warn("main_image_inquiry_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "Unable to load inquiry for image optimization" }, { status: 502 });
  }
  if (!inquiry) return Response.json({ error: "Inquiry not found" }, { status: 404 });
  try {
    const result = await getMainImageContext(config, inquiry);
    if (result.status !== "ready") return Response.json(result, { status: 409 });
    return Response.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function onRequestPost(context: HandlerContext) {
  try { await requireAuth(context.request, context.env); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const config = getConfig(context.env);
  if (!config.mutationsEnabled) return Response.json({ error: "Dashboard mutations are currently disabled" }, { status: 503 });
  const inquiryId = Number(context.params.id);
  if (!Number.isInteger(inquiryId)) return Response.json({ error: "Invalid inquiry ID" }, { status: 400 });
  const inquiry = await createSupabaseClient(config).getInquiryDetail(inquiryId);
  if (!inquiry) return Response.json({ error: "Inquiry not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await context.request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    const result = await proxyMainImageAction(config, inquiry, inquiryId, body);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
