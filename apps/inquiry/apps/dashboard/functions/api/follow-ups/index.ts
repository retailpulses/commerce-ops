import { getConfig } from "../../_lib/config";
import { createFollowUpClient, type FollowUpBucket } from "../../_lib/follow-ups";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const BUCKETS = new Set<FollowUpBucket>(["due", "overdue", "upcoming", "history"]);

/**
 * GET /api/follow-ups?bucket=due|overdue|upcoming|history&shop=...
 * Read-only follow-up queue projection.
 */
export async function onRequestGet(context: {
  request: Request;
  env: Record<string, string>;
}) {
  const url = new URL(context.request.url);
  const bucketRaw = url.searchParams.get("bucket") ?? "due";
  const bucket = BUCKETS.has(bucketRaw as FollowUpBucket)
    ? (bucketRaw as FollowUpBucket)
    : "due";
  const shop = url.searchParams.get("shop") || null;

  try {
    const config = getConfig(context.env);
    const client = createFollowUpClient(config);
    const rows = await client.listFollowUps(bucket, shop);

    const data = rows.map((row) => ({
      id: row.id,
      shopKey: row.shop_key,
      externalInquiryId: row.external_inquiry_id,
      customerNickname: row.customer_nickname || "",
      productName: row.product_name_snapshot || "",
      targetType: row.external_target_type,
      followUpState: row.follow_up_state,
      followUpDueDate: row.follow_up_due_date,
      followUpDateSource: row.follow_up_date_source,
      followUpCycleId: row.follow_up_cycle_id,
      lastConfirmedOutboundMessageId: row.last_confirmed_outbound_message_id,
      lastConfirmedOutboundAt: row.last_confirmed_outbound_at,
      status: row.status,
      daysOverdue: row.days_overdue ?? null,
      daysUntilDue: row.days_until_due ?? null,
      bucket: row.bucket ?? bucket,
      latestMessageFrom: row.latest_message_from ?? null,
    }));

    return new Response(JSON.stringify({ data }), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch follow-ups";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}
