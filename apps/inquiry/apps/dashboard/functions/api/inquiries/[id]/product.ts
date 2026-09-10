import { createSupabaseClient } from "../../../_lib/supabase";
import { requireAuth } from "../../../_lib/auth";
import { getConfig } from "../../../_lib/config";
import { getProductInventory } from "../../../_lib/product-pricing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** POST /api/inquiries/:id/product — link a product */
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

  let body: { productVariantId?: string };
  try {
    body = (await context.request.json()) as { productVariantId?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (typeof body.productVariantId !== "string" || !UUID_RE.test(body.productVariantId)) {
    return new Response(JSON.stringify({ error: "A canonical productVariantId UUID is required" }), {
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
    const product = await supabase.lookupProduct(
      body.productVariantId,
      inquiry.shop_key,
    );
    if (!product) {
      return new Response(JSON.stringify({ error: "Product variant not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    await supabase.operatorSetPrimaryLink({
      inquiryId,
      productVariantId: body.productVariantId,
      itemCodeSnapshot: product.item_code || "",
      productNameSnapshot: product.variant_name || "",
    });
    const inventory = getProductInventory(product);

    return new Response(
      JSON.stringify({
        success: true,
        product: {
          id: product.id,
          itemCode: product.item_code || "",
          productName: product.variant_name || "",
          storeName: inventory.storeName || "",
          qtyAvailable: inventory.qtyAvailable,
          ownedQty: inventory.ownedQty,
          mercariQty: inventory.mercariQty,
          restockDate: inventory.restockDate,
        },
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to link product";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** DELETE /api/inquiries/:id/product — remove a linked product by linkRowId or productVariantId */
export async function onRequestDelete(context: {
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
  if (isNaN(inquiryId) || inquiryId < 1 || !Number.isSafeInteger(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { linkId?: number; productVariantId?: string };
  try {
    body = (await context.request.json()) as { linkId?: number; productVariantId?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    if (typeof body.linkId !== "number" || !Number.isInteger(body.linkId) || body.linkId <= 0) {
      return new Response(
        JSON.stringify({ error: "linkId (positive integer) is required — use the linkRowId from the inquiry detail" }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } },
      );
    }

    await supabase.operatorUnlinkProduct(inquiryId, body.linkId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlink product";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
