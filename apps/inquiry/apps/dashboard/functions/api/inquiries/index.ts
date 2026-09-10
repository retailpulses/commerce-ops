import { createSupabaseClient } from "../../_lib/supabase";
import { getConfig, STATUS_LABELS, SHOP_LABELS } from "../../_lib/config";

type BoundResult = { ok: true; value?: number } | { ok: false; error: string };

/** Parse an optional expected-value bound. Blank/absent is unset. */
function parseExpectedValueBound(raw: string | null): BoundResult {
  if (raw === null || raw.trim() === "") return { ok: true };
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `Invalid expected value bound: "${raw}"` };
  }
  if (value < 0) {
    return { ok: false, error: "Expected value bounds must be non-negative" };
  }
  return { ok: true, value };
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** GET /api/inquiries — list inquiries with filters, search, pagination */
export async function onRequestGet(context: {
  request: Request;
  env: Record<string, string>;
}) {
  const config = getConfig(context.env);
  const supabase = createSupabaseClient(config);

  const url = new URL(context.request.url);
  const statusFilter = url.searchParams.get("status") || "";
  const search = url.searchParams.get("search") || "";
  const shopFilter = url.searchParams.get("shop") || "";
  const inquiryTypeFilter = url.searchParams.get("inquiryType") || "";
  const requestedPageSize = parseInt(
    url.searchParams.get("pageSize") || "20",
    10,
  );
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.min(Math.max(requestedPageSize, 1), 100)
    : 20;
  const cursorRaw = url.searchParams.get("cursor");
  const cursor =
    cursorRaw && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : undefined;

  const minResult = parseExpectedValueBound(
    url.searchParams.get("minExpectedValue"),
  );
  const maxResult = parseExpectedValueBound(
    url.searchParams.get("maxExpectedValue"),
  );
  if (!minResult.ok) return badRequest(minResult.error);
  if (!maxResult.ok) return badRequest(maxResult.error);
  const minExpectedValue = minResult.value;
  const maxExpectedValue = maxResult.value;
  if (
    minExpectedValue !== undefined &&
    maxExpectedValue !== undefined &&
    minExpectedValue > maxExpectedValue
  ) {
    return badRequest(
      "minExpectedValue must be less than or equal to maxExpectedValue",
    );
  }

  try {
    const { data, hasMore, nextCursor } = await supabase.listInquiries({
      status: statusFilter || undefined,
      search: search || undefined,
      shop: shopFilter || undefined,
      inquiryType: inquiryTypeFilter || undefined,
      pageSize,
      cursor,
      minExpectedValue,
      maxExpectedValue,
    });

    // Map Supabase rows to frontend shape
    const rows = data.map((row) => ({
      id: row.id,
      status: {
        id: row.status || "",
        label: STATUS_LABELS[row.status || ""] || row.status || "Unknown",
      },
      account: row.shop_key
        ? { id: row.shop_key, label: SHOP_LABELS[row.shop_key] || row.shop_key }
        : null,
      customerNickname: row.customer_nickname || "",
      productName: row.product_name_snapshot || "",
      inquiryType: row.inquiry_type
        ? { id: row.inquiry_type, label: row.inquiry_type }
        : null,
      inquiryDate: row.inquiry_date || null,
      url: row.url || "",
      hasDraft: row.has_draft,
      hasCopywrite: row.has_copywrite,
      hasProduct: row.has_product,
      units: row.units ?? 1,
      effectivePriceExclShipping: row.effective_price_excl_shipping ?? null,
      effectivePriceInclShipping: row.effective_price_incl_shipping ?? null,
      effectiveTCOGS: row.effective_tcogs ?? null,
      expectedValue: row.expected_value ?? null,
    }));

    return new Response(
      JSON.stringify({
        data: rows,
        pagination: { hasMore, nextCursor },
      }),
      {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch inquiries";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
