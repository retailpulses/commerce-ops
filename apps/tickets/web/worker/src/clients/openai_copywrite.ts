/** OpenAI API client for Japanese CS reply generation. */

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
export const COPYWRITE_MODEL = "gpt-5.5";
export const COPYWRITE_PROMPT_VERSION = "resolution-fidelity-v1";

export const DEFAULT_SYSTEM_PROMPT = `あなたはHomebliss（ホムブリス）のカスタマーサポート担当者です。
以下のルールを厳守して返信メッセージを作成してください。

【トーン】
- 丁寧な敬語（です・ます調）
- お客様の不安や不満に寄り添う共感的な表現
- 誠実で信頼感のある文体

【構成】
1. 宛名（お客様名が不明な場合は「お世話になっております。ホムブリスカスタマーサポートでございます。」）
2. お詫びと共感（具体的な問題に言及）
3. 対応方針（対応方針があれば、その内容を必ず反映する）
4. 今後の流れ・所要時間の目安
5. 結びの挨拶

【文字数制限】
- 返信メッセージは最大500文字以内を目安に作成してください（メルカリのメッセージ上限を考慮）
- 簡潔かつ必要十分な内容にまとめてください

【禁止事項】
- 対応方針にない金額、期限、補償、条件を推測・創作しない
- 確約できない納期や対応を約束しない
- お客様を責める表現を使わない

【対応方針の忠実性】
- 対応方針は、返信に必ず反映するオペレーター指示です
- 対応方針に記載された金額、補償方法、期限、条件、次のアクションを省略・曖昧化・変更しないでください
- 返金額やギフトカード金額を含む具体的な金額は、対応方針に記載されている場合、そのまま明示してください
- お客様への提案や解決策が記載されている場合、単なるお詫びや確認中の案内だけに置き換えないでください

【署名】
ホムブリスカスタマーサポート`;

interface GenerateReplyInput {
  customerName?: string;
  productName?: string;
  description?: string;
  messages?: Array<{ role: string; message: string; created_at: string }>;
  resolutionGuide?: string;
  systemPrompt?: string;
  promptVersion?: string;
}

export async function generateReply(
  apiKey: string,
  context: GenerateReplyInput
): Promise<{ reply: string; model: string; prompt_version: string }> {
  const systemPrompt = context.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // Build user prompt from ticket context
  const parts: string[] = [];

  if (context.customerName) {
    parts.push(`お客様名: ${context.customerName}`);
  }
  if (context.productName) {
    parts.push(`商品名: ${context.productName}`);
  }
  if (context.description) {
    parts.push(`問題の概要: ${context.description}`);
  }

  // Include only the last customer message
  if (context.messages && context.messages.length > 0) {
    const lastCust = [...context.messages].reverse().find((m) => m.role === "BUYER");
    if (lastCust) {
      parts.push("\n--- 最新のお客様メッセージ ---");
      parts.push(lastCust.message || "");
    }
  }

  // Resolution guide
  if (context.resolutionGuide) {
    parts.push(`\n【対応方針】\n${context.resolutionGuide}`);
  }

  parts.push("\n上記の情報を元に、お客様への返信メッセージを作成してください。");

  const userPrompt = parts.join("\n");

  const resp = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: COPYWRITE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const reply = data.choices[0]?.message?.content || "";
  if (!reply) {
    throw new Error("OpenAI returned empty response");
  }

  return {
    reply,
    model: COPYWRITE_MODEL,
    prompt_version: context.promptVersion || COPYWRITE_PROMPT_VERSION,
  };
}
