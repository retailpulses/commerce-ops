/** JSON-mode chat completions + issue summarization. */

function completionUrlForModel(model: string): string {
  if (model.startsWith("deepseek-")) {
    return "https://api.deepseek.com/chat/completions";
  }
  return "https://api.openai.com/v1/chat/completions";
}

function providerNameForModel(model: string): string {
  return model.startsWith("deepseek-") ? "DeepSeek" : "OpenAI";
}

export async function openaiChatJson(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutSec = 20
): Promise<Record<string, unknown>> {
  const resp = await fetch(completionUrlForModel(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${providerNameForModel(model)} error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(data.choices[0].message.content);
}

export async function llmSummarizeIssue(
  apiKey: string,
  llmState: { calls: number },
  messages: Array<{ role: string; message: string; createdAt: string }>,
  model = "gpt-4o"
): Promise<{ summary: string; startDate: string }> {
  const buyerMsgs = messages
    .filter((m) => m.role === "BUYER")
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  if (!buyerMsgs.length) return { summary: "（无买家消息）", startDate: "N/A" };

  const issueStartDate = (buyerMsgs[0].createdAt || "N/A").slice(0, 10);

  if (!apiKey) {
    return { summary: buyerMsgs[buyerMsgs.length - 1].message || "（无内容）", startDate: issueStartDate };
  }

  const convLines = buyerMsgs.map((m) => {
    const dt = (m.createdAt || "").slice(0, 16);
    const txt = (m.message || "").replace(
      /\b\d{2,4}-\d{2,4}-\d{3,4}\b/g,
      "[PHONE]"
    );
    return `[${dt}] 买家：${txt}`;
  });
  const convText = convLines.join("\n");

  const systemPrompt =
    "你是电商客服问题分析助手。买家消息输入可能为日文。请理解日文内容，用中文输出摘要。\n\n" +
    "要求：\n" +
    "- 清晰说明问题类型（破损、缺件、功能异常、尺寸不符、配送问题、催促发货等）\n" +
    "- 提取具体部位/部件名称（如タイヤ/轮胎、脚垫、ネジ/螺丝、アームレスト/扶手等）\n" +
    "- 提取客户提到的时间线索（如「昨日届いた」「4日前」「今日到着」等）\n" +
    "- 提取客户的诉求（返品、交換、補送、返金、催促等）\n" +
    "- 总长度 60-100 字，信息密度优先\n" +
    "- 如果消息历史中有明确描述，必须提炼具体细节；不要笼统地说「商品有问题」\n" +
    "只输出JSON：{\"summary\": \"...\"}";

  try {
    const out = await openaiChatJson(apiKey, model, systemPrompt, convText);
    llmState.calls++;
    return { summary: (out.summary as string) || convText.slice(0, 80), startDate: issueStartDate };
  } catch {
    llmState.calls++;
    return { summary: buyerMsgs[buyerMsgs.length - 1].message || "", startDate: issueStartDate };
  }
}
