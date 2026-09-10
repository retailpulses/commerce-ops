import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { createOpenAIClient, COPYWRITE_DEFAULT_PROMPT } from "../../../_lib/openai";
import { getConfig } from "../../../_lib/config";
import { getActivePrompt } from "../../../_lib/prompts";

type Env = Record<string, string> & {
  TEMPLATES_KV?: KVNamespace;
};

/** POST /api/inquiries/:id/copywrite — LLM copywrite of operator draft */
export async function onRequestPost(context: {
  request: Request;
  env: Env;
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
  const openai = createOpenAIClient(config);

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { rawText?: string };
  try {
    body = (await context.request.json()) as { rawText?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!body.rawText || typeof body.rawText !== "string") {
    return new Response(JSON.stringify({ error: "rawText (string) is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    // Load inquiry context via Supabase
    const inquiry = await supabase.getInquiryDetail(inquiryId);
    if (!inquiry) {
      return new Response(JSON.stringify({ error: "Inquiry not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Read active prompt from KV store (falls back to default)
    let systemPrompt = COPYWRITE_DEFAULT_PROMPT;
    let promptVersion = 0;
    try {
      const activePrompt = context.env.TEMPLATES_KV
        ? await getActivePrompt(context.env.TEMPLATES_KV)
        : null;
      if (activePrompt?.text) {
        systemPrompt = activePrompt.text;
        promptVersion = activePrompt.version;
      }
    } catch {
      // Non-fatal: use default prompt if store is unavailable
    }

    // Gather product info from linked products
    let productName: string | undefined;
    let productInfo: string | undefined;
    const linkedProducts = inquiry.linked_products || [];
    if (linkedProducts.length > 0) {
      productName = linkedProducts[0].productName || "";
      const parts: string[] = [];
      if (linkedProducts[0].itemCode) parts.push(`SKU: ${linkedProducts[0].itemCode}`);
      productInfo = parts.join(", ") || undefined;
    }

    // Call OpenAI
    const result = await openai.copywriteDraft({
      rawText: body.rawText,
      // Marketplace payloads sometimes put "メルカリShops" in the nickname
      // column. It is a platform label, not the customer, so customer-facing
      // copy always uses the neutral salutation.
      customerNickname: "お客様",
      inquiryBody: inquiry.last_custom_message || inquiry.inquiry_body || "",
      productName: productName || inquiry.product_name_snapshot || "",
      productInfo,
      systemPrompt,
    });

    if (!result) {
      return new Response(JSON.stringify({ error: "LLM copywrite failed. Please try again." }), {
        status: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Save to Supabase: separate text and timestamp
    try {
      await supabase.updateInquiry(inquiryId, {
        ai_copywritten_reply: result,
        ai_copywritten_at: new Date().toISOString(),
      });
    } catch {
      console.error("Failed to save copywrite result to Supabase");
    }

    return new Response(
      JSON.stringify({ success: true, result, promptVersion }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Copywrite failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
