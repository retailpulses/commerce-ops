/** WeCom (企业微信) webhook client. */

/**
 * Send a WeCom supplier notification via webhook.
 * Falls back to logging if no webhook URL is configured.
 */
export async function sendWecomSupplierReport(args: {
  transaction_id: string;
  shop: string;
  sku_codes: string[];
  issue_summary: string | null;
  expected_solution?: string | null;
  seller: string;
  attachments?: unknown[];
  event: string;
}): Promise<void> {
  const webhookUrl = (globalThis as unknown as { WECOM_WEBHOOK_URL?: string }).WECOM_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log(`  [WeCom] No webhook configured — skipping notification for ${args.transaction_id}`);
    return;
  }

  const skusStr = args.sku_codes?.join(", ") || "Unknown";

  let content: string;
  if (args.event === "new_ticket") {
    content =
      `【供应商反馈 - 客诉异常】\n` +
      `店铺：${args.shop}\n` +
      `订单号：order_${args.transaction_id}\n` +
      `SKU：${skusStr}\n` +
      `供应商：${args.seller}\n` +
      `问题描述：${args.issue_summary || "N/A"}`;
  } else if (args.event === "form_received") {
    content =
      `【フォーム受領通知】\n` +
      `店铺：${args.shop}\n` +
      `订单号：order_${args.transaction_id}\n` +
      `SKU：${skusStr}\n` +
      `供应商：${args.seller}\n` +
      `问题描述：${args.issue_summary || "N/A"}`;
  } else if (args.event === "runtime_failure") {
    content =
      `【SYSTEM ALERT - Runtime Failure】\n` +
      `${args.issue_summary}\n` +
      `Transaction: ${args.transaction_id}`;
  } else {
    content =
      `【供应商反馈信息】\n` +
      `订单号：order_${args.transaction_id}\n` +
      `SKU：${skusStr}\n` +
      `问题描述：${args.issue_summary || "N/A"}`;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.error(`  [WeCom] Webhook failed: ${resp.status}`);
    }
  } catch (e) {
    console.error(`  [WeCom] Webhook error: ${e}`);
  }
}

/** Convenience: send a WeCom message from handler context with env. */
export function sendWecomWithEnv(env: { WECOM_WEBHOOK_URL?: string }) {
  return async function send(args: Parameters<typeof sendWecomSupplierReport>[0]): Promise<void> {
    // Temporarily expose webhook URL to the module-level function
    const prev = (globalThis as unknown as { WECOM_WEBHOOK_URL?: string }).WECOM_WEBHOOK_URL;
    (globalThis as unknown as { WECOM_WEBHOOK_URL?: string }).WECOM_WEBHOOK_URL = env.WECOM_WEBHOOK_URL;
    try {
      await sendWecomSupplierReport(args);
    } finally {
      (globalThis as unknown as { WECOM_WEBHOOK_URL?: string }).WECOM_WEBHOOK_URL = prev;
    }
  };
}
