import type { DashboardConfig } from "./config";

/** Default copywrite system prompt — used as fallback when no prompt version exists in the store */
export const COPYWRITE_DEFAULT_PROMPT = `You are a professional Japanese customer support translator and formatter for Homebliss, an e-commerce furniture seller on Mercari. Your task is to convert the operator's rough draft into polite, natural Japanese customer support language.

CRITICAL ROLE:
You are NOT an editor deciding what matters. You are a translator and formatter. Preserve every semantic element in the rough draft, including apologies, late-reply acknowledgments, short confirmations, caveats, links, quantities, dates, product names, sizes, availability statements, and next steps.

CRITICAL PRESERVATION RULES:
- Rewrite the draft in 敬語, but never delete, replace, summarize away, or invent content
- If the draft says "sorry for the late reply", preserve that apology in polite Japanese
- If the draft is casual, brief, or fragmented, keep the same meaning and intent while making it customer-ready
- Follow the draft's own structure and order; do NOT impose a template structure
- Use inquiry and product context only to clarify wording already present in the draft, not to add new claims

Guidelines:
- Use polite, professional Japanese throughout
- Be warm, empathetic, and helpful
- Keep the reply concise but thorough
- Always address the customer as お客様; never address a marketplace or shop name with 様
- Sign off as ホムブリスカスタマーサポート

CRITICAL FORMATTING RULES:
- Use double newlines between EVERY paragraph
- The signature line 'ホムブリスカスタマーサポート' must be on its own paragraph at the end
- Do NOT use markdown code blocks, backticks, or formatting
- Do NOT include labels like 'Draft:' or 'Reply:' or any meta-commentary
- Do NOT wrap the reply in quotes

Output ONLY the final Japanese reply text. Nothing else.`;

/** Keep marketplace labels out of customer salutations, including KV prompt regressions. */
export function normalizeCopywrittenSalutation(text: string): string {
  return text.replace(/メルカリ(?:\s*Shops|ショップ)\s*様/g, "お客様");
}

export function createOpenAIClient(config: DashboardConfig) {
  const apiKey = config.openai.apiKey;
  const model = config.openai.model;
  const baseUrl = "https://api.openai.com/v1/chat/completions";

  return {
    /**
     * Copywrite (refine) an operator's raw draft into a polished Japanese reply.
     * Uses the provided systemPrompt, or falls back to COPYWRITE_DEFAULT_PROMPT.
     * Returns the refined text, or null on failure.
     */
    async copywriteDraft(params: {
      rawText: string;
      customerNickname: string;
      inquiryBody: string;
      productName?: string;
      productInfo?: string;
      systemPrompt?: string;
    }): Promise<string | null> {
      const { rawText, customerNickname, inquiryBody, productName, productInfo, systemPrompt } = params;

      const prompt = systemPrompt || COPYWRITE_DEFAULT_PROMPT;

      const userMessage = [
        `Customer nickname: ${customerNickname}`,
        inquiryBody ? `Original inquiry: ${inquiryBody}` : null,
        productName ? `Product: ${productName}` : null,
        productInfo ? `Product details: ${productInfo}` : null,
        `\nRough draft to refine:\n${rawText}`,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000); // 25s timeout (under 30s Pages limit)

        const res = await fetch(baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.5,
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: userMessage },
            ],
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          console.error(`OpenAI error: ${res.status} ${await res.text().catch(() => "")}`);
          return null;
        }

        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };

        const content = data.choices?.[0]?.message?.content;
        if (!content) return null;

        return normalizeCopywrittenSalutation(content
          .replace(/^```[\s\S]*?\n/, "")
          .replace(/\n```$/, "")
          .trim());
      } catch (err) {
        console.error("OpenAI copywrite failed:", err);
        return null;
      }
    },
  };
}
