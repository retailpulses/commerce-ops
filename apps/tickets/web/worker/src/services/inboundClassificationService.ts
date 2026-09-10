/** Supabase-native inbound message classification.
 *
 * This deliberately has no Baserow, template, reply-send, or ticket-write
 * dependency. Webhook enrichment must remain safe when the legacy system is
 * unavailable or its credentials have been revoked.
 */

import { llmClassifyMessage } from "../logic/classifier";
import { initTicketProcessingRuntime } from "../logic/runtime-config";
import type { Env, MercariTransaction } from "../types";
import type { ClassificationMeta } from "./inboundMessageService";

function suggestedTicketType(cls: string, subcls: string): string | null {
  if (subcls === "quality_issue") return "quality_issue";
  if (subcls === "request") return "others";
  if (subcls === "inquiry") return "others";
  if (cls === "delivery_request") return "logistic_issue";
  if (cls === "greeting_only") return null;
  return "others";
}

export async function classifyInboundTransaction(
  env: Env,
  tx: MercariTransaction
): Promise<ClassificationMeta> {
  initTicketProcessingRuntime(true);

  const messages = [...(tx.messages || [])].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  const latestBuyer = [...messages].reverse().find((message) => message.role === "BUYER");
  const transcript = messages
    .map((message) => {
      const marker = message.id === latestBuyer?.id ? " LATEST_BUYER" : "";
      return `[${message.createdAt || "unknown"}] ${message.role}${marker}: ${message.message || ""}`;
    })
    .join("\n");

  const result = await llmClassifyMessage(
    env.DEEPSEEK_API_KEY || "",
    env.OPENAI_API_KEY || "",
    transcript,
    { calls: 0, cache: {} }
  );

  const confidence = typeof result.meta.confidence === "number" ? result.meta.confidence : 0;
  const closeable = result.cls === "greeting_only" || result.cls === "information-only";
  const recommendedForManualCreation = !closeable;
  const automationBlockers: string[] = [];
  if (!closeable) automationBlockers.push("requires_operator_review");
  if (confidence < 0.8) automationBlockers.push("low_confidence");
  if (result.meta.manual_review_required === true) automationBlockers.push("classifier_manual_review");

  return {
    classification: result.subcls ? `${result.cls}/${result.subcls}` : result.cls,
    workflow_route: "ticket_handling",
    recommended_operator_action: closeable ? "no_action" : "review_for_manual_ticket_creation",
    recommended_for_manual_creation: recommendedForManualCreation,
    // Retained only because historical queue JSON and external consumers may
    // still deserialize this field. It is advisory and never authoritative.
    should_convert_to_ticket: recommendedForManualCreation,
    suggested_ticket_type: suggestedTicketType(result.cls, result.subcls),
    suggested_category: null,
    suggested_priority: result.subcls === "quality_issue" ? "high" : "normal",
    confidence,
    reasoning_summary: String(result.meta.reasons || ""),
    automation_eligible: closeable && confidence >= 0.85,
    automation_blockers: automationBlockers,
    model: String(result.meta.model || "classifier-unavailable"),
    prompt_version: "mercari-classifier-v3-supabase",
    raw_classifier_response: {
      cls: result.cls,
      subcls: result.subcls,
      ...result.meta,
    },
  };
}
