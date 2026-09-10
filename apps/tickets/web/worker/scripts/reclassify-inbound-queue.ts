#!/usr/bin/env tsx

import { llmClassifyMessage } from "../src/logic/classifier";
import { initTicketProcessingRuntime } from "../src/logic/runtime-config";
import { deriveWorkflowTransition } from "../src/logic/ticket-state";
import { InboundMessageService } from "../src/services/inboundMessageService";
import type { LogEntry, MercariMessage } from "../src/types";
import fs from "node:fs";

type QueueRow = {
  id: string;
  shop_name: string;
  order_transaction_id: string;
  order_summary: Record<string, unknown> | null;
  full_payload: Record<string, unknown> | null;
  classification: Record<string, unknown> | null;
};

const CREDENTIALS_PATH =
  process.env.MASTER_CREDENTIALS_PATH ||
  "/Users/user/Documents/Retailpulses/20_REPOS/master_credentials.md";

function readCredential(name: string): string {
  const text = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  const match = text.match(new RegExp(`^${name}=(.+)$`, "m"));
  return (match?.[1] || process.env[name] || "").trim().replace(/^['"]|['"]$/g, "");
}

function argValue(name: string): string | null {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
}

function isApply(): boolean {
  return process.argv.includes("--apply");
}

async function supabaseFetch<T>(
  url: string,
  key: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

async function listQueueRows(baseUrl: string, key: string): Promise<QueueRow[]> {
  const rows: QueueRow[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const url =
      `${baseUrl}/rest/v1/inbound_ticket_messages` +
      `?select=id,shop_name,order_transaction_id,order_summary,full_payload,classification` +
      `&order=received_at.asc&limit=${limit}&offset=${offset}`;
    const page = await supabaseFetch<QueueRow[]>(url, key);
    rows.push(...page);
    if (page.length < limit) break;
  }
  return rows;
}

function extractMessages(row: QueueRow): MercariMessage[] {
  const payload = row.full_payload || {};
  const tx = (payload.transaction || {}) as Record<string, unknown>;
  const messages = (payload.messages || tx.messages || []) as MercariMessage[];
  return [...messages].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

function extractOrderStatus(row: QueueRow): string | null {
  const payload = row.full_payload || {};
  const tx = (payload.transaction || {}) as Record<string, unknown>;
  return String(tx.status || row.order_summary?.order_status || "") || null;
}

function buildTranscript(messages: MercariMessage[]): {
  transcript: string;
  latestBuyer: MercariMessage | null;
  lastMessage: MercariMessage | null;
} {
  const lastMessage = messages[messages.length - 1] || null;
  const latestBuyer = [...messages].reverse().find((m) => m.role === "BUYER") || lastMessage;
  const transcript = messages
    .map((m) => {
      const marker = latestBuyer && m.id === latestBuyer.id ? " LATEST_BUYER" : "";
      return `[${m.createdAt || "unknown"}] ${m.role}${marker}: ${m.message || ""}`;
    })
    .join("\n");
  return { transcript: transcript || latestBuyer?.message || "", latestBuyer, lastMessage };
}

function isProviderCall(source: unknown): boolean {
  return source === "llm_deepseek" || source === "llm_openai_fallback";
}

async function main(): Promise<void> {
  const apply = isApply();
  const limitArg = argValue("limit");
  const limit = limitArg ? Number(limitArg) : null;
  const supabaseUrl = readCredential("SUPABASE_PROJECT_URL");
  const supabaseKey = readCredential("SUPABASE_SERVICE_ROLE_KEY");
  const deepseekKey = readCredential("DEEPSEEK_API_KEY");
  const openaiKey = readCredential("OPENAI_API_KEY");

  if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase credentials");
  if (!deepseekKey && !openaiKey) throw new Error("Missing LLM credentials");

  initTicketProcessingRuntime(true);
  const queueService = new InboundMessageService({} as never, {} as never, {} as never);
  const llmState = { calls: 0, cache: {} as Record<string, Record<string, unknown>> };
  const rows = (await listQueueRows(supabaseUrl, supabaseKey)).slice(0, limit ?? undefined);

  const stats: Record<string, number> = {
    found: rows.length,
    updated: 0,
    skipped_no_messages: 0,
    skipped_no_buyer_message: 0,
    errors: 0,
  };
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};

  for (const row of rows) {
    const currentLabel = String(row.classification?.classification || "unclassified");
    before[currentLabel] = (before[currentLabel] || 0) + 1;

    try {
      const messages = extractMessages(row);
      if (!messages.length) {
        stats.skipped_no_messages++;
        continue;
      }
      const { transcript, latestBuyer, lastMessage } = buildTranscript(messages);
      if (!latestBuyer || latestBuyer.role !== "BUYER") {
        stats.skipped_no_buyer_message++;
        continue;
      }

      const { cls, subcls, meta } = await llmClassifyMessage(
        deepseekKey,
        openaiKey,
        transcript,
        llmState
      );
      const orderStatus = extractOrderStatus(row);
      const isFugai = subcls === "quality_issue" || cls === "suspicious";
      const operatorActionRequired = meta.operator_action_required === true;
      const workflowTransition = deriveWorkflowTransition({
        orderStatus,
        existingStatus: null,
        cls,
        subcls,
        isFugai,
        operatorActionRequired,
        sellerRepliedAfterLatestBuyer: false,
      });
      const baserowAction =
        workflowTransition.shouldCreateTicket
          ? "created"
          : workflowTransition.route === "ticket_handling"
            ? "skipped_no_ticket"
            : "skipped_no_mutation";
      const llmSource = String(meta.source || "");
      const logEntry: LogEntry = {
        run_id: "run-once-inbound-queue-reclassify",
        timestamp: new Date().toISOString(),
        transaction_id: row.order_transaction_id,
        shop: row.shop_name,
        sku: null,
        message_snippet: (latestBuyer.message || "").slice(0, 80),
        message_id: lastMessage?.id || latestBuyer.id,
        classification: subcls ? `${cls}/${subcls}` : cls,
        needs_reply: false,
        auto_reply_sent: false,
        baserow_action: baserowAction,
        ticket_status: workflowTransition.status,
        fugai_form_sent: false,
        llm_called: isProviderCall(llmSource),
        llm_source: llmSource || null,
        confidence: typeof meta.confidence === "number" ? meta.confidence : null,
        reasoning_summary: typeof meta.reasons === "string" ? meta.reasons : null,
        operator_action_required: operatorActionRequired,
        operator_action_reason: (meta.operator_action_reason as string) || null,
        workflow_route: workflowTransition.route,
        workflow_reason: workflowTransition.reason,
        skip_reason:
          workflowTransition.route !== "ticket_handling"
            ? `Out of Ticket Handling scope: ${workflowTransition.reason}`
            : null,
      };
      const classificationMeta = queueService.parseClassification(
        logEntry as unknown as Record<string, unknown>
      );
      after[classificationMeta.classification] = (after[classificationMeta.classification] || 0) + 1;

      if (apply) {
        const url = `${supabaseUrl}/rest/v1/inbound_ticket_messages?id=eq.${row.id}`;
        await supabaseFetch<unknown[]>(url, supabaseKey, {
          method: "PATCH",
          body: JSON.stringify({
            classification: classificationMeta,
            classifier_version: `${classificationMeta.model}::${classificationMeta.prompt_version}`,
          }),
        });
      }
      stats.updated++;
    } catch (error) {
      stats.errors++;
      console.error(
        JSON.stringify({
          row_id: row.id,
          order_transaction_id: row.order_transaction_id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", stats, before, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
