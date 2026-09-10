/** Inbound message queue domain service.
 *  Business logic for webhook message triage — status transitions,
 *  auto-linking, ticket conversion, classification parsing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMercariOrderUrl } from "../config/shops";
import type {
  InboundMessageRepository,
  InboundMessage,
  InboundMessageListRow,
  CreateInboundMessageInput,
  UpdateInboundMessageInput,
  QueueFilters,
  UnreadCount,
} from "../repositories/inboundMessageRepository";
import type { TicketRepository, CreateTicketInput, AddTicketEventInput } from "../repositories/ticketRepository";
import { TicketService } from "./ticketService";

// ── Types ──

export interface QueueListResult {
  items: InboundMessageListRow[];
  total: number;
}

export interface ConvertToTicketResult {
  ticket: import("../repositories/ticketRepository").Ticket;
  queueItem: InboundMessage;
}

export interface ClassificationMeta {
  classification: string;
  workflow_route: string;
  recommended_operator_action: string;
  recommended_for_manual_creation: boolean;
  /** @deprecated External compatibility alias; never grants creation authority. */
  should_convert_to_ticket: boolean;
  suggested_ticket_type: string | null;
  suggested_category: string | null;
  suggested_priority: string;
  confidence: number;
  reasoning_summary: string;
  automation_eligible: boolean;
  automation_blockers: string[];
  model: string;
  prompt_version: string;
  raw_classifier_response: Record<string, unknown>;
}

interface QueueSummaryProduct {
  sku: string;
  quantity: number | null;
}

interface ResolvedQueueProduct {
  productId: string | null;
  variantId: string | null;
  listingId: string | null;
  listingSkuId: string | null;
  resolvedSku: string;
}

export class InboundMessageService {
  constructor(
    private repo: InboundMessageRepository,
    private ticketRepo: TicketRepository,
    private supabase: SupabaseClient
  ) {}

  // ── Queue Operations ──

  async listQueue(filters: QueueFilters): Promise<QueueListResult> {
    const { rows, total } = await this.repo.list(filters);
    return { items: rows, total };
  }

  async getQueueItem(id: string): Promise<InboundMessageListRow | null> {
    return this.repo.getById(id);
  }

  async updateQueueItem(id: string, input: UpdateInboundMessageInput): Promise<InboundMessage> {
    const existing = await this.repo.getById(id);
    if (!existing) throw new Error("Queue item not found");

    // Timestamp side effects for status transitions
    if (input.queue_status === "read" && existing.queue_status === "unread") {
      input.read_at = new Date().toISOString();
    }
    if (input.review_status === "reviewed" && existing.review_status === "needs_review") {
      input.reviewed_at = new Date().toISOString();
    }

    return this.repo.update(id, input);
  }

  async markRead(id: string): Promise<InboundMessage> {
    return this.updateQueueItem(id, { queue_status: "read" });
  }

  async markUnread(id: string): Promise<InboundMessage> {
    return this.updateQueueItem(id, { queue_status: "unread", read_at: null });
  }

  async markReviewed(id: string): Promise<InboundMessage> {
    return this.updateQueueItem(id, { review_status: "reviewed" });
  }

  async ignoreMessage(id: string): Promise<InboundMessage> {
    return this.updateQueueItem(id, {
      queue_status: "ignored",
      review_status: "reviewed",
    });
  }

  async linkToTicket(id: string, ticketId: string): Promise<InboundMessage> {
    return this.repo.linkMercariToTicket(id, ticketId, "portal_operator");
  }

  async convertToTicket(id: string, overrides?: Partial<CreateTicketInput>): Promise<ConvertToTicketResult> {
    const item = await this.repo.getById(id);
    if (!item) throw new Error("Queue item not found");
    if (item.source === "amazon_zoho_mail" || !item.shop_name || !item.order_transaction_id) {
      throw new Error("Amazon mail must use the validated Convert transaction");
    }

    // Resolve account_id from shop_name (Shop1..Shop4 → platform_accounts.id)
    let accountId = overrides?.account_id ?? null;
    if (!accountId && item.shop_name) {
      const { data: acct } = await this.supabase
        .from("platform_accounts")
        .select("id")
        .ilike("shop_code", item.shop_name)
        .eq("platform", "mercari")
        .eq("status", "active")
        .maybeSingle();
      accountId = (acct?.id as string) ?? null;
    }

    const ticketInput: CreateTicketInput = {
      platform: "mercari",
      account_id: accountId,
      external_order_id: item.order_transaction_id,
      external_thread_id: item.external_thread_id,
      customer_display_name: overrides?.customer_display_name ?? item.customer_display_name,
      subject: overrides?.subject ?? this.buildSubject(item),
      description: overrides?.description ?? this.buildDescription(item),
      status: overrides?.status ?? "open",
      priority: overrides?.priority ?? this.inferPriority(item),
      issue_types: overrides?.issue_types ?? this.inferIssueTypes(item),
      external_url: getMercariOrderUrl(item.shop_name, item.order_transaction_id),
    };

    const { data, error } = await this.supabase.rpc("convert_mercari_inbound_message_to_ticket_v1", {
      p_inbound_message_id: id,
      p_subject: ticketInput.subject ?? null,
      p_description: ticketInput.description ?? null,
      p_priority: ticketInput.priority ?? null,
      p_customer_display_name: ticketInput.customer_display_name ?? null,
      p_issue_types: ticketInput.issue_types ?? [],
      p_external_url: ticketInput.external_url ?? null,
      p_actor_id: "portal_operator",
    });
    if (error) throw new Error(error.message || "mercari_queue_convert_failed");
    const result = data as Record<string, unknown> | null;
    const ticketId = typeof result?.ticket_id === "string" ? result.ticket_id : null;
    if (!ticketId) throw new Error("mercari_queue_convert_failed");
    const ticket = await this.ticketRepo.getTicket(ticketId);
    if (!ticket) throw new Error("mercari_queue_convert_readback_failed");

    await this.autoLinkSummaryProducts(
      ticket.id,
      id,
      item.product_summary,
      accountId,
      ticket.products.some((product) => product.role === "primary"),
    );

    const queueItem = await this.repo.getById(id);
    if (!queueItem || queueItem.linked_ticket_id !== ticket.id || queueItem.queue_status !== "converted") {
      throw new Error("mercari_queue_convert_readback_failed");
    }

    return { ticket, queueItem };
  }

  private extractSummaryProducts(productSummary: Record<string, unknown>): QueueSummaryProduct[] {
    const products = productSummary.products;
    if (!Array.isArray(products)) return [];

    const uniqueProducts = new Map<string, QueueSummaryProduct>();
    for (const value of products) {
      if (!value || typeof value !== "object") continue;
      const product = value as Record<string, unknown>;
      const sku = typeof product.sku === "string" ? product.sku.trim() : "";
      if (!sku || uniqueProducts.has(sku)) continue;
      const quantity = typeof product.purchased_quantity === "number" &&
        Number.isFinite(product.purchased_quantity)
        ? product.purchased_quantity
        : null;
      uniqueProducts.set(sku, { sku, quantity });
    }
    return [...uniqueProducts.values()];
  }

  private async resolveSummaryProducts(
    products: QueueSummaryProduct[],
    accountId: string | null,
  ): Promise<Map<string, ResolvedQueueProduct>> {
    const skus = products.map((product) => product.sku);
    const resolved = new Map<string, ResolvedQueueProduct>();

    const [itemCodeResult, skuResult] = await Promise.all([
      this.supabase
        .from("product_variants")
        .select("id, product_id, sku, item_code")
        .in("item_code", skus)
        .eq("status", "active"),
      this.supabase
        .from("product_variants")
        .select("id, product_id, sku, item_code")
        .in("sku", skus)
        .eq("status", "active"),
    ]);

    if (itemCodeResult.error || skuResult.error) {
      console.warn("[InboundMessage] Product variant lookup partially failed", {
        itemCodeError: itemCodeResult.error?.message,
        skuError: skuResult.error?.message,
      });
    }

    const addVariantMatches = (rows: unknown[] | null, field: "item_code" | "sku") => {
      for (const value of rows ?? []) {
        const row = value as Record<string, unknown>;
        const matchedSku = typeof row[field] === "string" ? row[field] : "";
        if (!matchedSku || resolved.has(matchedSku)) continue;
        resolved.set(matchedSku, {
          productId: typeof row.product_id === "string" ? row.product_id : null,
          variantId: typeof row.id === "string" ? row.id : null,
          listingId: null,
          listingSkuId: null,
          resolvedSku: typeof row.sku === "string" ? row.sku : matchedSku,
        });
      }
    };

    // Match the TicketForm RPC's deterministic preference: item_code, then sku.
    addVariantMatches(itemCodeResult.data, "item_code");
    addVariantMatches(skuResult.data, "sku");

    const unresolvedSkus = skus.filter((sku) => !resolved.has(sku));
    if (unresolvedSkus.length === 0) return resolved;

    const listingQuery = (field: "seller_sku" | "sku_code") => {
      let query = this.supabase
        .from("platform_listing_skus")
        .select(`
          id, listing_id, seller_sku, sku_code, variant_id,
          listing:platform_listings!inner(platform, platform_account_id)
        `)
        .in(field, unresolvedSkus)
        .eq("listing.platform", "mercari");
      if (accountId) query = query.eq("listing.platform_account_id", accountId);
      return query;
    };

    const [sellerSkuResult, skuCodeResult] = await Promise.all([
      listingQuery("seller_sku"),
      listingQuery("sku_code"),
    ]);

    if (sellerSkuResult.error || skuCodeResult.error) {
      console.warn("[InboundMessage] Platform listing SKU lookup partially failed", {
        sellerSkuError: sellerSkuResult.error?.message,
        skuCodeError: skuCodeResult.error?.message,
      });
    }

    const listingMatches = new Map<string, Record<string, unknown>>();
    const addListingMatches = (rows: unknown[] | null, field: "seller_sku" | "sku_code") => {
      for (const value of rows ?? []) {
        const row = value as Record<string, unknown>;
        const matchedSku = typeof row[field] === "string" ? row[field] : "";
        if (matchedSku && !listingMatches.has(matchedSku)) listingMatches.set(matchedSku, row);
      }
    };
    addListingMatches(sellerSkuResult.data, "seller_sku");
    addListingMatches(skuCodeResult.data, "sku_code");

    const variantIds = [...new Set(
      [...listingMatches.values()]
        .map((row) => row.variant_id)
        .filter((id): id is string => typeof id === "string"),
    )];
    const variantsById = new Map<string, Record<string, unknown>>();
    if (variantIds.length > 0) {
      const { data, error } = await this.supabase
        .from("product_variants")
        .select("id, product_id, sku")
        .in("id", variantIds)
        .eq("status", "active");
      if (error) {
        console.warn("[InboundMessage] Listing variant lookup failed", { error: error.message });
      }
      for (const value of data ?? []) {
        const row = value as Record<string, unknown>;
        if (typeof row.id === "string") variantsById.set(row.id, row);
      }
    }

    for (const [sourceSku, listing] of listingMatches) {
      const requestedVariantId = typeof listing.variant_id === "string" ? listing.variant_id : null;
      const variant = requestedVariantId ? variantsById.get(requestedVariantId) : undefined;
      resolved.set(sourceSku, {
        productId: typeof variant?.product_id === "string" ? variant.product_id : null,
        variantId: typeof variant?.id === "string" ? variant.id : null,
        listingId: typeof listing.listing_id === "string" ? listing.listing_id : null,
        listingSkuId: typeof listing.id === "string" ? listing.id : null,
        resolvedSku: typeof variant?.sku === "string"
          ? variant.sku
          : typeof listing.seller_sku === "string"
            ? listing.seller_sku
            : typeof listing.sku_code === "string"
              ? listing.sku_code
              : sourceSku,
      });
    }

    return resolved;
  }

  private async autoLinkSummaryProducts(
    ticketId: string,
    inboundMessageId: string,
    productSummary: Record<string, unknown>,
    accountId: string | null,
    hasPrimaryProduct: boolean,
  ): Promise<void> {
    const products = this.extractSummaryProducts(productSummary);
    if (products.length === 0) return;

    let resolved: Map<string, ResolvedQueueProduct>;
    try {
      resolved = await this.resolveSummaryProducts(products, accountId);
    } catch (error) {
      console.warn("[InboundMessage] Product auto-link lookup failed", { error: String(error) });
      return;
    }

    let primaryAssigned = hasPrimaryProduct;
    for (const product of products) {
      const match = resolved.get(product.sku);
      if (!match) continue;
      const role = primaryAssigned ? "related" : "primary";
      const stableReference = match.variantId ?? match.listingSkuId ?? match.productId ?? match.listingId;
      if (!stableReference) continue;

      try {
        const linkedProduct = await this.ticketRepo.linkTicketProduct({
          ticket_id: ticketId,
          product_id: match.productId,
          variant_id: match.variantId,
          listing_id: match.listingId,
          listing_sku_id: match.listingSkuId,
          sku: match.resolvedSku,
          quantity: product.quantity,
          role,
        });
        const linkedRole = linkedProduct.role || role;
        if (linkedRole === "primary") primaryAssigned = true;

        await this.ticketRepo.addTicketEvent({
          ticket_id: ticketId,
          event_type: "product_linked",
          actor_type: "system",
          payload: {
            sku: match.resolvedSku,
            variant_id: match.variantId,
            product_id: match.productId,
            listing_id: match.listingId,
            listing_sku_id: match.listingSkuId,
            role: linkedRole,
            source: "queue_conversion_auto_link",
            inbound_message_id: inboundMessageId,
          },
          idempotency_key: `queue_conversion_auto_link:${ticketId}:${inboundMessageId}:${stableReference}`,
        });
      } catch (error) {
        // Best-effort: keep the explicit operator conversion valid and make the
        // failed SKU visible in Worker logs for manual follow-up.
        console.warn("[InboundMessage] Product auto-link failed", {
          inboundMessageId,
          sku: product.sku,
          error: String(error),
        });
      }
    }
  }

  async getUnreadCount(shopName?: string): Promise<UnreadCount> {
    return this.repo.getUnreadCount(shopName);
  }

  async getByTicketId(ticketId: string): Promise<InboundMessage[]> {
    return this.repo.getByTicketId(ticketId);
  }

  // ── Inbound Message Creation (called from webhook handler) ──

  async createInboundMessage(input: CreateInboundMessageInput): Promise<InboundMessage> {
    return this.repo.create(input);
  }

  // ── Auto-Link (Phase 2, Team 4) ──

  async autoLink(inboundMessage: InboundMessage): Promise<InboundMessage> {
    if (inboundMessage.queue_status !== "unread") {
      // Already linked/converted — skip
      return inboundMessage;
    }
    if (inboundMessage.source !== "mercari_webhook" || !inboundMessage.order_transaction_id) {
      return inboundMessage;
    }

    // Find existing tickets by external_order_id for the Mercari platform
    // We look up by both account and order_transaction_id
    // The tickets table has idx_tickets_platform_order partial unique index on (platform, account_id, external_order_id)
    // Account lookup: we need to resolve shop_name → account_id
    // Since we don't have a direct FK from shop_name to platform_accounts here,
    // we search tickets that have the same external_order_id and are on mercari platform

    // This is a best-effort match; exact account resolution happens at ticket level
    // We search tickets by order_transaction_id alone (most reliable key for Mercari)
    const { rows } = await this.ticketRepo.listTickets({
      platform: "mercari",
      q: inboundMessage.order_transaction_id,
      limit: 5,
    });

    // Filter to exact external_order_id match
    const exactMatches = rows.filter(
      (t) => t.external_order_id === inboundMessage.order_transaction_id
    );

    if (exactMatches.length === 1) {
      const matchedTicket = exactMatches[0];
      const ticketId = matchedTicket.id;

      // This row represents verified platform/customer contact. Make the
      // existing case actionable; classification alone still has no create
      // authority when no ticket exists.
      const wasTerminal = ["closed", "resolved", "canceled"].includes(matchedTicket.status);
      await this.ticketRepo.updateTicket(ticketId, {
        status: wasTerminal ? "in_progress" : matchedTicket.status,
        needs_reply: true,
      });

      // Add message_received event
      await this.ticketRepo.addTicketEvent({
        ticket_id: ticketId,
        event_type: "message_received",
        actor_type: "platform",
        idempotency_key: `inbound:${inboundMessage.id}:received`,
        payload: {
          source: "mercari_webhook_auto_link",
          inbound_message_id: inboundMessage.id,
          order_transaction_id: inboundMessage.order_transaction_id,
        },
      });

      if (wasTerminal) {
        await this.ticketRepo.addTicketEvent({
          ticket_id: ticketId,
          event_type: "ticket_reopened",
          actor_type: "platform",
          idempotency_key: `inbound:${inboundMessage.id}:reopened`,
          payload: {
            reason: "verified_customer_platform_contact",
            previous_status: matchedTicket.status,
            inbound_message_id: inboundMessage.id,
          },
        });
      }

      return this.repo.update(inboundMessage.id, {
        queue_status: "linked",
        review_status: "reviewed",
        linked_ticket_id: ticketId,
      });
    }

    // No match or multiple matches — leave unread for operator review
    return inboundMessage;
  }

  // ── Classification Parsing (Phase 2, Team 5) ──

  parseClassification(logEntry: Record<string, unknown>): ClassificationMeta {
    const classification = (logEntry.classification as string) ?? "unclassified";
    const mainClass = classification.split("/")[0] || classification;
    const workflow_route = (logEntry.workflow_route as string) ?? "ticket_handling";

    // Prefer the authority-neutral field while accepting the historical
    // classifier property for stored/external payload compatibility.
    const recommendedForManualCreation =
      logEntry.recommended_for_manual_creation === true ||
      (logEntry.recommended_for_manual_creation === undefined &&
        logEntry.should_convert_to_ticket === true);

    const recommendedAction = recommendedForManualCreation
      ? "review_for_manual_ticket_creation"
      : mainClass === "greeting_only"
        ? "no_action"
        : "review_ticket";

    // Infer ticket type from classification
    const suggestedTicketType = this.mapClassificationToTicketType(mainClass);

    // Automation eligibility
    const automationEligible = mainClass === "greeting_only";
    const automationBlockers: string[] = [];
    if (!automationEligible) {
      if (mainClass === "unclassified") automationBlockers.push("classification_uncertain");
      if ((logEntry.confidence as number ?? 0) < 0.8) automationBlockers.push("low_confidence");
      automationBlockers.push("requires_operator_review");
    }

    return {
      classification,
      workflow_route,
      recommended_operator_action: recommendedAction,
      recommended_for_manual_creation: recommendedForManualCreation,
      should_convert_to_ticket: recommendedForManualCreation,
      suggested_ticket_type: suggestedTicketType,
      suggested_category: null,
      suggested_priority: "normal",
      confidence: (logEntry.confidence as number) ?? 0.5,
      reasoning_summary: (logEntry.reasoning_summary as string) ?? "",
      automation_eligible: automationEligible,
      automation_blockers: automationBlockers,
      model: "deepseek-v4-flash", // from handler.ts LLM_MODEL
      prompt_version: "mercari-classifier-v3",
      raw_classifier_response: logEntry as Record<string, unknown>,
    };
  }

  // ── Helpers ──

  private mapClassificationToTicketType(classification: string): string | null {
    const map: Record<string, string> = {
      real_ticket: "quality_issue",
      suspicious: "quality_issue",
      quality_issue: "quality_issue",
      delivery_request: "logistic_issue",
      return_request: "return",
      refund_request: "refund",
      cancellation_request: "others",
      greeting_only: null as unknown as string,
      information_only: "others",
      unclear: "others",
    };
    return map[classification] ?? "others";
  }

  private buildSubject(item: InboundMessageListRow): string {
    const summary = item.product_summary as Record<string, unknown>;
    const productName = summary?.product_name as string | undefined;
    const classification = item.classification as Record<string, unknown>;
    const classLabel = classification?.classification as string | undefined;
    const prefix = classLabel ? `[${classLabel}] ` : "";
    const product = productName ? ` — ${productName}` : "";
    const customer = item.customer_display_name ? ` (${item.customer_display_name})` : "";
    return `${prefix}Mercari inquiry${product}${customer}`;
  }

  private buildDescription(item: InboundMessageListRow): string {
    const classification = item.classification as Record<string, unknown>;
    return [
      item.latest_buyer_message ? `Customer message: ${item.latest_buyer_message}` : null,
      classification?.reasoning_summary ? `AI analysis: ${classification.reasoning_summary}` : null,
      `Source: Mercari webhook (${item.shop_name})`,
      `Transaction: ${item.order_transaction_id}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private inferPriority(item: InboundMessageListRow): string {
    const classification = item.classification as Record<string, unknown>;
    const classLabel = classification?.classification as string | undefined;
    if (classLabel === "real_ticket" || classLabel === "quality_issue") return "high";
    if (classLabel === "suspicious") return "normal";
    return "normal";
  }

  private inferIssueTypes(item: InboundMessageListRow): string[] {
    const classification = item.classification as Record<string, unknown>;
    const ticketType = this.mapClassificationToTicketType(
      (classification?.classification as string) ?? "unclassified"
    );
    return ticketType ? [ticketType] : [];
  }
}
