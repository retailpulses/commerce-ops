/** Copywriting service — orchestrates AI reply generation and logging.
 *  Depends on CopywritingRepository + TicketRepository (interfaces).
 *  Uses the OpenAI copywrite client (platform-agnostic).
 */

import type { CopywritingRepository, TicketDetail } from "../repositories/ticketRepository";
import type { TicketRepository } from "../repositories/ticketRepository";
import {
  generateReply,
  COPYWRITE_MODEL,
  COPYWRITE_PROMPT_VERSION,
} from "../clients/openai_copywrite";

export class CopywritingService {
  constructor(
    private copyRepo: CopywritingRepository,
    private ticketRepo: TicketRepository,
    private openaiApiKey: string,
  ) {}

  /** Generate an AI reply for a ticket.
   *  Uses real Mercari thread messages (last buyer message) when available.
   *  Falls back to ticket description only if no messages are available.
   */
  async generateReply(
    ticket: TicketDetail,
    resolutionGuide?: string,
    operatorName?: string,
  ): Promise<{
    reply: string;
    model: string;
    prompt_version: string;
  }> {
    // Extract context from ticket
    const customerName = ticket.customer_display_name ?? undefined;
    const productName = this.extractPrimaryProductName(ticket);
    const description = ticket.description ?? undefined;

    // Use last buyer message from ticket messages (which should include platform messages)
    const messages = (ticket.messages ?? []).map((m) => ({
      role: m.sender_type === "customer" || m.sender_type === "buyer" ? "BUYER" : "SELLER",
      message: m.body,
      created_at: m.sent_at ?? m.created_at,
    }));

    const startTime = Date.now();

    try {
      const result = await generateReply(this.openaiApiKey, {
        customerName,
        productName,
        description,
        messages: messages.length > 0 ? messages : undefined,
        resolutionGuide,
        promptVersion: COPYWRITE_PROMPT_VERSION,
      });

      const latencyMs = Date.now() - startTime;

      // Log success (non-blocking)
      this.copyRepo.logCopywriting({
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        model: result.model,
        prompt_version: result.prompt_version,
        resolution_guide: resolutionGuide ?? null,
        generated_reply: result.reply,
        reply_char_count: result.reply.length,
        latency_ms: latencyMs,
        status: "success",
        customer_message: ticket.latest_customer_message ?? null,
        ticket_description: description ?? null,
        created_by: operatorName ?? null,
      }).catch((e) => console.error(`Copywrite log failed: ${e}`));

      return result;
    } catch (e) {
      const latencyMs = Date.now() - startTime;

      // Log failure (non-blocking)
      this.copyRepo.logCopywriting({
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        model: COPYWRITE_MODEL,
        prompt_version: COPYWRITE_PROMPT_VERSION,
        resolution_guide: resolutionGuide ?? null,
        status: "error",
        error_message: String(e).slice(0, 500),
        customer_message: ticket.latest_customer_message ?? null,
        ticket_description: description ?? null,
        created_by: operatorName ?? null,
      }).catch((e2) => console.error(`Copywrite error log failed: ${e2}`));

      throw e;
    }
  }

  private extractPrimaryProductName(ticket: TicketDetail): string | undefined {
    const products = ticket.products ?? [];
    const primary = products.find((p) => p.role === "primary");
    if (primary?.product_name) return primary.product_name;
    if (primary?.variant_name) return primary.variant_name;
    if (products[0]?.product_name) return products[0].product_name;
    return undefined;
  }
}
