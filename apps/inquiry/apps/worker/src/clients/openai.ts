import type { Config } from "../config";
import { withRetry } from "../utils/retry";

const KNOWN_CATEGORIES = [
  "Okinawa inquiry",
  "Bulk purchase",
  "Price negotiation",
  "Scheduled delivery",
  "Product availability",
  "Shipping related",
  "Assembly",
  "Product Spec",
  "Find a product",
  "Others",
];

const CLASSIFY_SYSTEM_PROMPT = `You are an inquiry classification assistant for a Japanese e-commerce furniture seller. Classify customer messages into exactly one of the following categories:

- Okinawa inquiry: inquiries about shipping to Okinawa or remote islands
- Bulk purchase: inquiries about buying multiple items, bulk discounts, coupons, wholesale
- Price negotiation: inquiries about discounts, price reduction, dedicated pages
- Scheduled delivery: inquiries about delivery date/time specification
- Product availability: inquiries about stock status, restock timing
- Shipping related: inquiries about shipping fees, delivery methods
- Assembly: inquiries about assembly, tools required, installation
- Product Spec: inquiries about size, dimensions, weight, material
- Find a product: inquiries about color variations, other product availability
- Others: anything that doesn't fit the above categories

Reply with ONLY the category name from the list above, nothing else.`;

export function createOpenAIClient(config: Config) {
  const apiKey = config.openai.apiKey;
  const baseUrl = "https://api.openai.com/v1/chat/completions";

  async function chatCompletion(
    systemPrompt: string,
    userMessage: string,
    temperature: number,
    timeoutMs: number,
  ): Promise<string | null> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
          }),
          signal: controller.signal,
        });

        if (!res.ok) return null;

        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };

        const content = data.choices?.[0]?.message?.content;
        return content?.trim() ?? null;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    async classifyInquiry(msg: string): Promise<string | null> {
      try {
        const result = await chatCompletion(
          CLASSIFY_SYSTEM_PROMPT,
          msg,
          0.1,
          10000,
        );
        if (!result) return null;
        const trimmed = result.trim();
        for (const cat of KNOWN_CATEGORIES) {
          if (trimmed === cat) return cat;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
