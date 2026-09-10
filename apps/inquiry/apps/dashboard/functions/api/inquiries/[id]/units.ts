import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { getProductPricing } from "../../../_lib/product-pricing";

/**
 * PATCH /api/inquiries/:id/units.
 *
 * Expected value follows the dashboard contract: effective price including
 * shipping multiplied by units. Catalog pricing is used when the imported
 * inquiry snapshot is empty.
 */
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
      headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }

  const supabase = createSupabaseClient(config);

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { units?: number };
  try {
    body = (await context.request.json()) as { units?: number };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (body.units === undefined || body.units === null) {
    return new Response(JSON.stringify({ error: "Missing units field" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (typeof body.units !== "number" || isNaN(body.units) || body.units < 0) {
    return new Response(JSON.stringify({ error: "Units must be a non-negative number" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const inquiry = await supabase.getInquiryDetail(inquiryId);
    if (!inquiry) {
      return new Response(JSON.stringify({ error: "Inquiry not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const primaryProduct = (inquiry.linked_products || []).find((p) => p.isPrimary)
      ?? inquiry.linked_products?.[0];
    let effectivePriceInclShipping = inquiry.effective_price_incl_shipping;
    if (effectivePriceInclShipping === null && primaryProduct?.id) {
      const product = await supabase.lookupProduct(primaryProduct.id);
      if (product) {
        effectivePriceInclShipping = getProductPricing(product)
          .effectivePriceInclShipping;
      }
    }
    const expectedValue = effectivePriceInclShipping === null
      ? null
      : body.units * effectivePriceInclShipping;

    await supabase.updateInquiry(inquiryId, {
      units: body.units,
      expected_value: expectedValue,
    });

    return new Response(JSON.stringify({ success: true, expectedValue }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update units";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
