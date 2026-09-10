/**
 * WeCom notification client for operator alerts.
 *
 * Sends a push notification to a WeCom group webhook when an
 * inquiry requires operator attention (acknowledgement template
 * used, low confidence, missing product match, etc.).
 *
 * Gracefully degrades when WECOM_WEBHOOK_URL is not configured.
 */

export function createWeComClient(webhookUrl: string | undefined) {
  async function sendInquiryAlert(params: {
    inquiryId: number;
    customerName: string;
    inquiryType: string;
    productName: string;
    reason: string;
  }): Promise<boolean> {
    if (!webhookUrl) return false;
    const productLine = params.productName
      ? `> 商品: ${params.productName}`
      : "> 商品: 未特定";

    const markdown = [
      "## 🔔 確認が必要なお問い合わせ",
      `> ID: ${params.inquiryId}`,
      `> お客様: ${params.customerName}`,
      `> 種別: ${params.inquiryType}`,
      productLine,
      `> 理由: ${params.reason}`,
    ].join("\n");

    return sendMarkdown(markdown);
  }

  /**
   * Send an operational alert (pipeline health, failures, lock issues).
   * Rate-limited by the caller via `JobStateDO.trySendAlert()`.
   */
  async function sendOperationalAlert(params: {
    title: string;
    job: string;
    runId?: string;
    details: Record<string, unknown>;
  }): Promise<boolean> {
    if (!webhookUrl) return false;

    const detailLines = Object.entries(params.details)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `> ${k}: ${String(v)}`)
      .join("\n");

    const markdown = [
      `## ⚠️ ${params.title}`,
      `> Job: ${params.job}`,
      params.runId ? `> Run: ${params.runId}` : "",
      detailLines,
    ].filter(Boolean).join("\n");

    return sendMarkdown(markdown);
  }

  async function sendMarkdown(content: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(webhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  return { sendInquiryAlert, sendOperationalAlert };
}
