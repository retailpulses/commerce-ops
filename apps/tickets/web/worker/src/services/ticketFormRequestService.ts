/** Message-to-TicketForm automation.
 *
 * Hard boundary: this module may classify, create submission tokens, persist
 * reply outcomes, and send a TicketForm request. It must never import a ticket
 * repository or write to the tickets table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSellerRepliedAfterLastBuyer, sendReply } from "../clients/mercari";
import { fuguaiAlreadySent, FUGUAI_LITE_TEMPLATE, AFTERSALES_FORM_PLACEHOLDER } from "../logic/templates";
import { ticketFormExpiresAt } from "../logic/ticketform-validity";
import type { Env, MercariTransaction } from "../types";
import type { ClassificationMeta } from "./inboundMessageService";

export type AutomationDecision = "no_action" | "operator_review" | "non_form_reply" | "ticketform_request";
export type ReplyStatus = "not_attempted" | "blocked" | "sending" | "sent" | "failed";

export interface AutomationOutcome {
  decision: AutomationDecision;
  reason: string;
  replyStatus: ReplyStatus;
  retryable: boolean;
}

export interface TicketFormContext {
  inboundId: string;
  shopName: string;
  platform: "mercari";
  accountId: string;
  externalOrderId: string;
  productName: string;
  productSku: string;
}

export interface AutomationStore {
  resolveAccountId(shopName: string): Promise<string | null>;
  resolveProduct(sku: string): Promise<{ name: string; sku: string } | null>;
  hasActiveCase(caseKey: string, inboundId: string): Promise<boolean>;
  createToken(input: {
    tokenHash: string;
    context: TicketFormContext;
    caseKey: string;
    expiresAt: string;
  }): Promise<string>;
  claimSend(inboundId: string, tokenId: string): Promise<boolean>;
  persist(inboundId: string, patch: {
    decision: AutomationDecision;
    reason: string;
    replyStatus: ReplyStatus;
    platformMessageId?: string | null;
    error?: string | null;
  }): Promise<void>;
}

export function decideTicketFormAction(meta: ClassificationMeta): { decision: AutomationDecision; reason: string } {
  if (meta.classification.startsWith("greeting_only") || meta.classification.startsWith("information-only")) {
    return { decision: "no_action", reason: "conversation_closeable" };
  }
  if (meta.classification.startsWith("delivery_request")) {
    return { decision: "non_form_reply", reason: "delivery_request_requires_non_form_response" };
  }
  if (meta.classification === "real_ticket/quality_issue") {
    if (meta.confidence < 0.85) return { decision: "operator_review", reason: "low_confidence" };
    if (meta.automation_blockers.includes("classifier_manual_review")) {
      return { decision: "operator_review", reason: "classifier_manual_review" };
    }
    return { decision: "ticketform_request", reason: "high_confidence_quality_issue" };
  }
  return { decision: "operator_review", reason: "classification_requires_operator_review" };
}

export function automationModeAllowsShop(env: Env, shopName: string): boolean {
  const mode = env.TICKETFORM_AUTOMATION_MODE || "shadow";
  if (mode === "active") return true;
  if (mode !== "limited") return false;
  const allowed = (env.TICKETFORM_AUTOMATION_SHOPS || "")
    .split(",")
    .map((shop) => shop.trim())
    .filter(Boolean);
  return allowed.includes(shopName);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function block(
  store: AutomationStore,
  inboundId: string,
  decision: AutomationDecision,
  reason: string
): Promise<AutomationOutcome> {
  await store.persist(inboundId, { decision, reason, replyStatus: "blocked" });
  return { decision, reason, replyStatus: "blocked", retryable: false };
}

export async function runTicketFormRequestAutomation(input: {
  env: Env;
  inboundId: string;
  shopName: string;
  transaction: MercariTransaction;
  classification: ClassificationMeta;
  mercariToken: string;
  store: AutomationStore;
  sendPlatformReply?: typeof sendReply;
}): Promise<AutomationOutcome> {
  const { env, inboundId, shopName, transaction: tx, classification, mercariToken, store } = input;
  const sendPlatformReply = input.sendPlatformReply || sendReply;
  const decision = decideTicketFormAction(classification);

  if (decision.decision !== "ticketform_request") {
    await store.persist(inboundId, { ...decision, replyStatus: "not_attempted" });
    return { ...decision, replyStatus: "not_attempted", retryable: false };
  }
  if (!automationModeAllowsShop(env, shopName)) {
    await store.persist(inboundId, { ...decision, reason: "shadow_mode", replyStatus: "not_attempted" });
    return { ...decision, reason: "shadow_mode", replyStatus: "not_attempted", retryable: false };
  }
  if (!env.TICKETFORM_TOKEN_SIGNING_SECRET) return block(store, inboundId, decision.decision, "missing_token_signing_secret");
  if (!env.TICKETFORM_PUBLIC_BASE_URL) return block(store, inboundId, decision.decision, "missing_public_base_url");
  if (!tx.id) return block(store, inboundId, decision.decision, "missing_order_id");
  if (tx.status !== "COMPLETED") return block(store, inboundId, decision.decision, "order_status_not_completed");

  const messages = [...(tx.messages || [])].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "BUYER") return block(store, inboundId, decision.decision, "latest_message_not_buyer");
  if (fuguaiAlreadySent(messages)) {
    // The platform thread is authoritative when a prior send committed but
    // persisting its response failed. Recover as sent instead of blocked.
    await store.persist(inboundId, {
      decision: decision.decision,
      reason: "ticketform_request_confirmed_in_thread",
      replyStatus: "sent",
      platformMessageId: null,
    });
    return {
      decision: decision.decision,
      reason: "ticketform_request_confirmed_in_thread",
      replyStatus: "sent",
      retryable: false,
    };
  }
  if (hasSellerRepliedAfterLastBuyer(messages)) return block(store, inboundId, decision.decision, "seller_already_replied");

  const accountId = await store.resolveAccountId(shopName);
  if (!accountId) return block(store, inboundId, decision.decision, "platform_account_not_found");
  const sku = tx.products?.map((product) => product.variant?.skuCode).find(Boolean);
  if (!sku) return block(store, inboundId, decision.decision, "product_sku_missing");
  const product = await store.resolveProduct(sku);
  if (!product?.name) return block(store, inboundId, decision.decision, "product_context_not_found");

  const context: TicketFormContext = {
    inboundId,
    shopName,
    platform: "mercari",
    accountId,
    externalOrderId: tx.id,
    productName: product.name,
    productSku: product.sku,
  };
  const caseKey = `mercari:${accountId}:${tx.id}`;
  if (await store.hasActiveCase(caseKey, inboundId)) {
    return block(store, inboundId, decision.decision, "active_ticketform_already_exists");
  }

  const plainToken = await hmacHex(env.TICKETFORM_TOKEN_SIGNING_SECRET, `ticketform:${inboundId}`);
  const tokenHash = await sha256Hex(plainToken);
  let tokenId: string;
  try {
    tokenId = await store.createToken({
      tokenHash,
      context,
      caseKey,
      expiresAt: ticketFormExpiresAt(),
    });
  } catch (error) {
    const duplicate = String(error).includes("23505");
    const reason = duplicate ? "active_ticketform_already_exists" : "token_creation_failed";
    const replyStatus = duplicate ? "blocked" : "failed";
    await store.persist(inboundId, { decision: decision.decision, reason, replyStatus, error: String(error) });
    return { decision: decision.decision, reason, replyStatus, retryable: !duplicate };
  }

  if (!(await store.claimSend(inboundId, tokenId))) {
    // Keep webhook processing retryable until a stale claim can be reclaimed
    // or the sent message becomes visible in the platform thread.
    return { decision: decision.decision, reason: "send_claim_in_progress", replyStatus: "failed", retryable: true };
  }

  const baseUrl = env.TICKETFORM_PUBLIC_BASE_URL.replace(/\/$/, "");
  const formUrl = `${baseUrl}/forms/after-sales/${plainToken}`;
  const message = FUGUAI_LITE_TEMPLATE.replace(AFTERSALES_FORM_PLACEHOLDER, formUrl);
  try {
    const sent = await sendPlatformReply(mercariToken, tx.id, message);
    await store.persist(inboundId, {
      decision: decision.decision,
      reason: "ticketform_request_sent",
      replyStatus: "sent",
      platformMessageId: sent.id,
    });
    return { decision: decision.decision, reason: "ticketform_request_sent", replyStatus: "sent", retryable: false };
  } catch (error) {
    await store.persist(inboundId, {
      decision: decision.decision,
      reason: "platform_send_failed",
      replyStatus: "failed",
      error: String(error),
    });
    return { decision: decision.decision, reason: "platform_send_failed", replyStatus: "failed", retryable: true };
  }
}

export class SupabaseTicketFormAutomationStore implements AutomationStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async resolveAccountId(shopName: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("platform_accounts")
      .select("id")
      .eq("platform", "mercari")
      .or(`shop_code.eq.${shopName},display_name.eq.${shopName}`)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`account lookup failed: ${error.message}`);
    return (data?.id as string) || null;
  }

  async resolveProduct(sku: string): Promise<{ name: string; sku: string } | null> {
    const { data, error } = await this.supabase
      .from("platform_listing_skus")
      .select("seller_sku, sku_code, variant:product_variants(product:products(title))")
      .or(`seller_sku.eq.${sku},sku_code.eq.${sku}`)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`product lookup failed: ${error.message}`);
    const variant = data?.variant as unknown as { product?: { title?: string } | Array<{ title?: string }> } | null;
    const nestedProduct = Array.isArray(variant?.product) ? variant?.product[0] : variant?.product;
    const name = nestedProduct?.title;
    return name ? { name, sku: (data?.sku_code as string) || (data?.seller_sku as string) || sku } : null;
  }

  async hasActiveCase(caseKey: string, inboundId: string): Promise<boolean> {
    const { error: expiryError } = await this.supabase
      .from("submission_tokens")
      .update({ status: "expired" })
      .eq("automation_case_key", caseKey)
      .eq("status", "active")
      .lt("expires_at", new Date().toISOString());
    if (expiryError) throw new Error(`expired case sweep failed: ${expiryError.message}`);

    const { data, error } = await this.supabase
      .from("submission_tokens")
      .select("id")
      .eq("automation_case_key", caseKey)
      .in("status", ["active", "used"])
      .neq("source_inbound_message_id", inboundId)
      .limit(1);
    if (error) throw new Error(`active case lookup failed: ${error.message}`);
    return (data?.length || 0) > 0;
  }

  async createToken(input: {
    tokenHash: string;
    context: TicketFormContext;
    caseKey: string;
    expiresAt: string;
  }): Promise<string> {
    const { data: existing, error: existingError } = await this.supabase
      .from("submission_tokens")
      .select("id,token_hash,status")
      .eq("source_inbound_message_id", input.context.inboundId)
      .maybeSingle();
    if (existingError) throw new Error(`TOKEN_LOOKUP: ${existingError.message}`);
    if (existing) {
      if (existing.status === "active" && existing.token_hash === input.tokenHash) {
        return existing.id as string;
      }
      throw new Error("TOKEN_IMMUTABLE: previously issued token cannot be reactivated or re-signed");
    }

    const { data, error } = await this.supabase.from("submission_tokens").insert({
      token_hash: input.tokenHash,
      ticket_id: null,
      platform: input.context.platform,
      account_id: input.context.accountId,
      external_order_id: input.context.externalOrderId,
      allowed_submission_type: "damage_evidence",
      status: "active",
      expires_at: input.expiresAt,
      max_upload_count: 5,
      created_by: "message_to_ticketform_automation",
      source_inbound_message_id: input.context.inboundId,
      product_name: input.context.productName,
      product_sku: input.context.productSku,
      automation_case_key: input.caseKey,
    }).select("id").single();
    if (error || !data) throw new Error(`${error?.code || "TOKEN_INSERT"}: ${error?.message || "no token returned"}`);
    return data.id as string;
  }

  async claimSend(inboundId: string, tokenId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const staleSendingBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data, error } = await this.supabase
      .from("inbound_ticket_messages")
      .update({ reply_status: "sending", reply_attempted_at: now, submission_token_id: tokenId, reply_error: null })
      .eq("id", inboundId)
      .or(`reply_status.in.(not_attempted,failed),and(reply_status.eq.sending,reply_attempted_at.lt.${staleSendingBefore})`)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`send claim failed: ${error.message}`);
    return !!data;
  }

  async persist(inboundId: string, patch: {
    decision: AutomationDecision;
    reason: string;
    replyStatus: ReplyStatus;
    platformMessageId?: string | null;
    error?: string | null;
  }): Promise<void> {
    const update: Record<string, unknown> = {
      automation_decision: patch.decision,
      automation_reason: patch.reason,
      reply_status: patch.replyStatus,
    };
    if (patch.platformMessageId !== undefined) update.reply_platform_message_id = patch.platformMessageId;
    if (patch.error !== undefined) update.reply_error = patch.error;
    if (patch.replyStatus === "sent") update.reply_sent_at = new Date().toISOString();
    const { error } = await this.supabase.from("inbound_ticket_messages").update(update).eq("id", inboundId);
    if (error) throw new Error(`reply outcome persistence failed: ${error.message}`);
  }
}
