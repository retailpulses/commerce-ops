import type { Config } from "../config";
import { withRetry } from "../utils/retry";

/**
 * DeepSeek client for Bulk Purchase classification hardening.
 *
 * When the keyword classifier returns "Bulk purchase", this runs a
 * second-pass review via DeepSeek (cheaper, faster than GPT-4) to
 * confirm or reject the classification. This prevents false Bulk Purchase
 * classifications from reaching the operator as high-priority cases.
 */

interface BulkReviewResult {
  isBulk: boolean;
  reason: string;
}

interface DeepSeekRawResponse {
  is_bulk: boolean;
  reason: string;
}

const BULK_REVIEW_PROMPT = `あなたはメルカリショップのカスタマーサポートAIです。

以下の顧客メッセージが「まとめ買い（複数購入・大量注文・数量割引・卸売り）」の意図であるかを厳密に判定してください。

【判定基準】
- 顧客が「2個以上」「複数」「まとめて」「セットで」「大量」「〇個ほしい」など、明確に複数購入を意図している → YES
- 顧客が単に値下げ交渉をしているだけ（例：「もっと安くなりますか」「値引き」）→ NO（これはPrice negotiationです）
- 顧客が商品の仕様や在庫について質問しているだけ → NO
- 送料についての質問（例：「2個買ったら送料は？」「まとめて発送」は複数購入だが主目的が送料確認）→ NO（これはShipping relatedです）

【出力形式】
JSONのみを出力: {"is_bulk": true/false, "reason": "日本語で短い理由"}

【顧客メッセージ】`;

export function createDeepSeekClient(config: Config) {
  const apiKey = config.deepseek?.apiKey;
  if (!apiKey) {
    return {
      confirmBulkPurchase: async (_msg: string): Promise<BulkReviewResult> => {
        // No key configured — accept keyword result (don't block pipeline)
        return { isBulk: true, reason: "no DeepSeek key configured — accepting keyword result" };
      },
    };
  }

  const baseUrl = "https://api.deepseek.com";

  async function confirmBulkPurchase(msg: string): Promise<BulkReviewResult> {
    if (!msg || msg.trim().length < 5) {
      return { isBulk: false, reason: "message too short" };
    }

    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            temperature: 0,
            messages: [
              { role: "user", content: BULK_REVIEW_PROMPT + msg },
            ],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // On API error, accept keyword result
          return { isBulk: true, reason: `DeepSeek API error: ${res.status}` };
        }

        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) {
          return { isBulk: true, reason: "empty DeepSeek response" };
        }

        const parsed = JSON.parse(content) as DeepSeekRawResponse;
        return {
          isBulk: typeof parsed.is_bulk === "boolean" ? parsed.is_bulk : !!parsed.is_bulk,
          reason: String(parsed.reason ?? ""),
        };
      } catch (err) {
        // On parse/network error, accept keyword result (don't block pipeline)
        return { isBulk: true, reason: `DeepSeek error: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return { confirmBulkPurchase };
}
