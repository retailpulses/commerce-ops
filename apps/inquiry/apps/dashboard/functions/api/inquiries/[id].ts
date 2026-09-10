import { createSupabaseClient } from "../../_lib/supabase";
import { getConfig } from "../../_lib/config";
import {
  getProductInventory,
  getProductPricing,
} from "../../_lib/product-pricing";
import { resolveInquiryBody } from "../../_lib/inquiry-messages";
import { createMercariRelayClient } from "../../_lib/mercari-relay";
import {
  InquiryFreshReadError,
  isMercariApiInquiry,
  refreshMercariInquiry,
} from "../../_lib/inquiry-fresh-read";
import {
  buildMercariSellerInquiryUrl,
  validatedLegacyMercariUrl,
} from "../../_lib/mercari-seller-link";
import { createFollowUpClient } from "../../_lib/follow-ups";

/** GET /api/inquiries/:id — full inquiry detail with linked products/knowledge */
export async function onRequestGet(context: {
  request: Request;
  env: Record<string, string>;
  params: { id: string };
}) {
  const config = getConfig(context.env);
  const supabase = createSupabaseClient(config);

  const inquiryId = parseInt(context.params.id, 10);
  if (isNaN(inquiryId)) {
    return new Response(JSON.stringify({ error: "Invalid inquiry ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    let row = await supabase.getInquiryDetail(inquiryId);
    if (!row) {
      return new Response(JSON.stringify({ error: "Inquiry not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Canonical contract: an operator-visible Mercari detail is never served
    // as "fresh" from the database projection alone. Reconcile the one thread
    // through the existing canonical RPC, then re-read the projection.
    if (isMercariApiInquiry(row)) {
      await refreshMercariInquiry(
        { relay: createMercariRelayClient(config), supabase },
        row.shop_key!,
        row.external_inquiry_id!,
      );
      row = await supabase.getInquiryDetail(inquiryId);
      if (!row) {
        return new Response(JSON.stringify({ error: "Inquiry not found after refresh" }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    // inquiry_detail_vw includes linked_products and linked_knowledge as JSONB arrays
    const productLinks = row.linked_products || [];
    const catalogProducts = await Promise.all(
      productLinks.map((p) =>
        p.id ? supabase.lookupProduct(p.id, row.shop_key) : null,
      ),
    );
    const linkedProducts = productLinks.map((p, index) => {
      const product = catalogProducts[index];
      const inventory = product ? getProductInventory(product) : null;
      return {
        id: p.id,
        linkRowId: p.linkRowId ?? null,
        itemCode: p.itemCode || "",
        productName: p.productName || "",
        isPrimary: p.isPrimary ?? false,
        linkSource: p.linkSource || null,
        confidence: p.confidence ?? null,
        storeName: inventory?.storeName ?? null,
        qtyAvailable: inventory?.qtyAvailable ?? null,
        ownedQty: inventory?.ownedQty ?? null,
        mercariQty: inventory?.mercariQty ?? null,
        restockDate: inventory?.restockDate ?? null,
      };
    });

    const primaryProduct =
      (row.linked_products || []).find((p) => p.isPrimary) ??
      row.linked_products?.[0];
    let catalogPricing = null;
    if (primaryProduct?.id) {
      const primaryIndex = productLinks.indexOf(primaryProduct);
      const catalogProduct =
        primaryIndex >= 0 ? catalogProducts[primaryIndex] : null;
      if (catalogProduct) catalogPricing = getProductPricing(catalogProduct);
    }

    const effectivePriceExclShipping =
      row.effective_price_excl_shipping ??
      catalogPricing?.effectivePriceExclShipping ??
      null;
    const effectivePriceInclShipping =
      row.effective_price_incl_shipping ??
      catalogPricing?.effectivePriceInclShipping ??
      null;
    const effectiveTCOGS =
      row.effective_tcogs ?? catalogPricing?.effectiveTCOGS ?? null;
    const units = row.units ?? 1;
    const expectedValue =
      row.expected_value ??
      (effectivePriceInclShipping !== null
        ? units * effectivePriceInclShipping
        : null);
    const followUpContext = await createFollowUpClient(config).getOutboundContext(inquiryId);

    const inquiry = {
      id: row.id,
      shopKey: row.shop_key || null,
      status: {
        id: row.status || "",
        label: row.status || "Unknown",
      },
      inquiryType: row.inquiry_type
        ? { id: row.inquiry_type, label: row.inquiry_type }
        : null,
      customerNickname: row.customer_nickname || "",
      productName: row.product_name_snapshot || "",
      inquiryBody: resolveInquiryBody(
        row.inquiry_body,
        row.message_log_raw,
        row.last_custom_message,
      ),
      lastCustomMessage: row.last_custom_message || "",
      inquiryDate: row.inquiry_date || null,
      lastInboundTime: row.last_inbound_time || null,
      url:
        buildMercariSellerInquiryUrl(row.shop_key, row.external_inquiry_id) ??
        validatedLegacyMercariUrl(row.url) ??
        "",
      orderId: row.order_id || "",
      seller:
        linkedProducts.find((product) => product.isPrimary)?.storeName ??
        linkedProducts[0]?.storeName ??
        "",
      messageLog: row.message_log_raw || "",
      draftReply: row.draft_reply || "",
      inquirySkillReply: row.inquiry_skill_reply || "",
      aiReplyCopywrited: row.ai_copywritten_reply || "",
      replyStrategy: row.reply_strategy || "",
      linkedProducts,
      units,
      effectivePriceExclShipping,
      effectivePriceInclShipping,
      effectiveTCOGS,
      expectedValue,
      followUpState: followUpContext?.follow_up_state || null,
      followUpDueDate: followUpContext?.follow_up_due_date || null,
      followUpDateSource: followUpContext?.follow_up_date_source || null,
    };

    return new Response(JSON.stringify(inquiry), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    if (err instanceof InquiryFreshReadError) {
      return new Response(JSON.stringify({ error: err.message, code: err.code }), {
        status: err.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const message =
      err instanceof Error ? err.message : "Failed to fetch inquiry";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
