/** Ticket domain service — business logic for ticket operations.
 *  Validation, status transitions, event logging, dedup.
 *  Depends on TicketRepository (interface), never directly on Supabase.
 */

import type {
  TicketRepository,
  CreateTicketInput,
  UpdateTicketInput,
  LinkProductInput,
  Ticket,
  TicketDetail,
  TicketListRow,
  TicketEvent,
  TicketProduct,
  TicketMessage,
  TicketNote,
  AddMessageInput,
  AddNoteInput,
  UpdateNoteInput,
  TicketListFilters,
  TicketAttachment,
  TicketResolutionAction,
  CreateResolutionActionInput,
  ManualTicketCreationAuthority,
} from "../repositories/ticketRepository";

const ATTACHMENT_BUCKET = "ticket-attachments";
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
]);
const RESOLUTION_TYPES = new Set([
  "full_refund", "partial_refund", "replacement", "return_request",
  "address_change", "cancel_order", "information_only", "seller_escalation",
  "platform_escalation", "no_action",
]);

// ── Status Transitions ──

const VALID_TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress", "pending_customer", "pending_third_party", "closed", "canceled"],
  in_progress: ["pending_customer", "pending_third_party", "resolved", "closed", "canceled"],
  pending_customer: ["in_progress", "resolved", "closed", "canceled"],
  pending_third_party: ["in_progress", "resolved", "closed", "canceled"],
  resolved: ["closed", "open"], // reopen
  closed: ["open"], // reopen
  canceled: ["open"], // reopen
};

// ── Required Fields ──

const REQUIRED_CREATE_FIELDS: (keyof CreateTicketInput)[] = ["platform"];

export class TicketService {
  constructor(private repo: TicketRepository) {}

  // ── Validation ──

  private validateCreate(input: CreateTicketInput): string[] {
    const errors: string[] = [];

    for (const field of REQUIRED_CREATE_FIELDS) {
      if (!input[field]) {
        errors.push(`${field} is required`);
      }
    }

    const validPlatforms = ["mercari", "amazon", "rakuten", "other"];
    if (input.platform && !validPlatforms.includes(input.platform)) {
      errors.push(`platform must be one of: ${validPlatforms.join(", ")}`);
    }

    if (input.priority) {
      const validPriorities = ["low", "normal", "high", "urgent"];
      if (!validPriorities.includes(input.priority)) {
        errors.push(`priority must be one of: ${validPriorities.join(", ")}`);
      }
    }

    if (input.status) {
      const validStatuses = Object.keys(VALID_TRANSITIONS);
      if (!validStatuses.includes(input.status)) {
        errors.push(`status must be one of: ${validStatuses.join(", ")}`);
      }
    }

    return errors;
  }

  private validateStatusTransition(
    currentStatus: string,
    newStatus: string,
  ): string | null {
    if (currentStatus === newStatus) return null;

    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed) {
      return `Unknown current status: ${currentStatus}`;
    }
    if (!allowed.includes(newStatus)) {
      return `Cannot transition from '${currentStatus}' to '${newStatus}'. Allowed: ${allowed.join(", ")}`;
    }
    return null;
  }

  // ── Slice 1A Operations ──

  async createTicket(
    input: CreateTicketInput,
    authority: ManualTicketCreationAuthority,
  ): Promise<{
    ticket: Ticket;
    errors: string[];
  }> {
    const errors = this.validateCreate(input);
    if (errors.length > 0) {
      return { ticket: null as unknown as Ticket, errors };
    }

    if (!authority.actor_id) {
      return {
        ticket: null as unknown as Ticket,
        errors: ["authenticated operator actor is required"],
      };
    }

    // TicketForm finalization has its own transactional database command.
    // Every runtime TypeScript creation path is an explicit operator command.
    const authorizedInput: CreateTicketInput = {
      ...input,
      origin: "manual",
      raw_source_payload: {
        ...(input.raw_source_payload ?? {}),
        ...(authority.provenance ?? {}),
        source: authority.source,
        actor: authority.actor_id,
      },
    };
    const ticket = await this.repo.createTicket(authorizedInput);

    // Log creation event
    await this.repo.addTicketEvent({
      ticket_id: ticket.id,
      event_type: "ticket_created",
      actor_type: "operator",
      actor_id: authority.actor_id,
      payload: {
        source: authority.source,
        input: { ...authorizedInput },
      },
    });

    return { ticket, errors: [] };
  }

  async getTicket(
    ticketId: string,
  ): Promise<{ ticket: TicketDetail | null; events: TicketEvent[] }> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return { ticket: null, events: [] };

    const events = await this.repo.getTicketEvents(ticketId);
    return { ticket, events };
  }

  async listTickets(filters: TicketListFilters): Promise<{
    rows: TicketListRow[];
    total: number;
  }> {
    return this.repo.listTickets(filters);
  }

  async updateTicket(
    ticketId: string,
    input: UpdateTicketInput,
  ): Promise<{ ticket: Ticket | null; error: string | null }> {
    const current = await this.repo.getTicket(ticketId);
    if (!current) {
      return { ticket: null, error: "Ticket not found" };
    }

    // Validate status transition if status is being changed
    if (input.status) {
      const transitionError = this.validateStatusTransition(
        current.status,
        input.status,
      );
      if (transitionError) {
        return { ticket: null, error: transitionError };
      }
      if (
        ["resolved", "closed", "canceled"].includes(input.status) &&
        input.status !== current.status &&
        current.resolution_actions.length === 0
      ) {
        return {
          ticket: null,
          error: "Record a resolution outcome or explicit no-action waiver before closing the ticket",
        };
      }
    }

    const ticket = await this.repo.updateTicket(ticketId, input);

    // Log events for changed fields
    if (input.status && input.status !== current.status) {
      await this.repo.addTicketEvent({
        ticket_id: ticketId,
        event_type: "status_changed",
        actor_type: "operator",
        payload: {
          from: current.status,
          to: input.status,
        },
      });
    }

    if (input.priority && input.priority !== current.priority) {
      await this.repo.addTicketEvent({
        ticket_id: ticketId,
        event_type: "priority_changed",
        actor_type: "operator",
        payload: {
          from: current.priority,
          to: input.priority,
        },
      });
    }

    // If reopening, log a dedicated event
    if (
      input.status &&
      (current.status === "closed" || current.status === "resolved") &&
      input.status === "open"
    ) {
      await this.repo.addTicketEvent({
        ticket_id: ticketId,
        event_type: "ticket_reopened",
        actor_type: "operator",
        payload: { previous_status: current.status },
      });
    }

    return { ticket, error: null };
  }

  async linkProduct(
    input: LinkProductInput,
  ): Promise<{ product: TicketProduct | null; error: string | null }> {
    const current = await this.repo.getTicket(input.ticket_id);
    if (!current) {
      return { product: null, error: "Ticket not found" };
    }

    const product = await this.repo.linkTicketProduct(input);

    await this.repo.addTicketEvent({
      ticket_id: input.ticket_id,
      event_type: "product_linked",
      actor_type: "operator",
      payload: { sku: input.sku, role: input.role ?? "related" },
    });

    return { product, error: null };
  }

  async unlinkProduct(
    ticketId: string,
    productId: string,
  ): Promise<{ error: string | null }> {
    const current = await this.repo.getTicket(ticketId);
    if (!current) {
      return { error: "Ticket not found" };
    }

    await this.repo.unlinkTicketProduct(ticketId, productId);

    await this.repo.addTicketEvent({
      ticket_id: ticketId,
      event_type: "product_unlinked",
      actor_type: "operator",
      payload: { product_id: productId },
    });

    return { error: null };
  }

  // ── Slice 1B Operations ──

  async addMessage(
    input: AddMessageInput,
  ): Promise<{ message: TicketMessage | null; error: string | null }> {
    const ticket = await this.repo.getTicket(input.ticket_id);
    if (!ticket) {
      return { message: null, error: "Ticket not found" };
    }

    const message = await this.repo.addMessage(input);

    await this.repo.addTicketEvent({
      ticket_id: input.ticket_id,
      event_type: "message_added",
      actor_type: "operator",
      payload: {
        sender_type: input.sender_type,
        body_preview: input.body.slice(0, 100),
      },
    });

    // Only verified customer-originated contact reopens a terminal ticket.
    // Operator messages and internal actions must not silently reopen it.
    if (
      input.sender_type === "customer" &&
      (ticket.status === "closed" ||
        ticket.status === "resolved" ||
        ticket.status === "canceled")
    ) {
      await this.repo.updateTicket(input.ticket_id, { status: "open" });
      await this.repo.addTicketEvent({
        ticket_id: input.ticket_id,
        event_type: "ticket_reopened",
        actor_type: "system",
        payload: {
          reason: "new_message",
          previous_status: ticket.status,
        },
      });
    }

    return { message, error: null };
  }

  async addNote(
    input: AddNoteInput,
  ): Promise<{ note: TicketNote | null; error: string | null }> {
    const ticket = await this.repo.getTicket(input.ticket_id);
    if (!ticket) {
      return { note: null, error: "Ticket not found" };
    }

    const note = await this.repo.addNote(input);

    await this.repo.addTicketEvent({
      ticket_id: input.ticket_id,
      event_type: "note_added",
      actor_type: "operator",
      payload: {
        created_by: input.created_by ?? null,
        body_preview: input.body.slice(0, 100),
      },
    });

    return { note, error: null };
  }

  async updateNote(
    input: UpdateNoteInput,
  ): Promise<{ note: TicketNote | null; error: string | null }> {
    if (!input.body.trim()) return { note: null, error: "Note body is required" };
    const ticket = await this.repo.getTicket(input.ticket_id);
    if (!ticket) return { note: null, error: "Ticket not found" };

    const note = await this.repo.updateNote({ ...input, body: input.body.trim() });
    if (!note) return { note: null, error: "Note not found" };

    await this.repo.addTicketEvent({
      ticket_id: input.ticket_id,
      event_type: "note_updated",
      actor_type: "operator",
      payload: { note_id: input.note_id },
    });
    return { note, error: null };
  }

  async listAttachments(ticketId: string): Promise<{
    attachments: TicketAttachment[];
    error: string | null;
  }> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return { attachments: [], error: "Ticket not found" };
    return { attachments: await this.repo.listAttachments(ticket.id), error: null };
  }

  async prepareAttachmentUpload(ticketId: string, file: { name: string; size: number; type: string }): Promise<{
    upload: { path: string; signed_url: string; token: string } | null;
    error: string | null;
  }> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return { upload: null, error: "Ticket not found" };
    if (!file.name || file.size === 0) {
      return { upload: null, error: "A non-empty file is required" };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { upload: null, error: "File exceeds the 100 MB limit" };
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      return { upload: null, error: `Unsupported file type: ${file.type || "unknown"}` };
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-160);
    const path = `tickets/${ticket.id}/${crypto.randomUUID()}-${safeName}`;
    const authorization = await this.repo.createSignedAttachmentUpload(ATTACHMENT_BUCKET, path);
    return { upload: { path, ...authorization }, error: null };
  }

  async finalizeAttachmentUpload(
    ticketId: string,
    upload: { path: string; name: string; size: number; type: string },
  ): Promise<{ attachment: TicketAttachment | null; error: string | null }> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return { attachment: null, error: "Ticket not found" };
    if (!upload.path.startsWith(`tickets/${ticket.id}/`)) {
      return { attachment: null, error: "Upload path does not belong to this ticket" };
    }
    const object = await this.repo.getAttachmentObjectInfo(ATTACHMENT_BUCKET, upload.path);
    if (!object) return { attachment: null, error: "Uploaded object was not found" };
    if (object.size !== upload.size || object.size > MAX_ATTACHMENT_BYTES) {
      await this.repo.deleteAttachmentObject(ATTACHMENT_BUCKET, upload.path).catch(() => undefined);
      return { attachment: null, error: "Uploaded object size does not match the authorization" };
    }
    if (object.mime_type && object.mime_type !== upload.type) {
      await this.repo.deleteAttachmentObject(ATTACHMENT_BUCKET, upload.path).catch(() => undefined);
      return { attachment: null, error: "Uploaded object type does not match the authorization" };
    }
    try {
      const { attachment, created } = await this.repo.createAttachment({
        ticket_id: ticket.id,
        customer_submission_id: null,
        storage_bucket: ATTACHMENT_BUCKET,
        storage_path: upload.path,
        filename: upload.name,
        mime_type: upload.type,
        media_type: upload.type.startsWith("video/") ? "video" : "image",
        size_bytes: upload.size,
        source: "operator_upload",
      });
      await this.repo.addTicketEvent({
        ticket_id: ticket.id,
        event_type: "attachment_added",
        actor_type: "operator",
        idempotency_key: `attachment:${attachment.id}:added`,
        payload: {
          attachment_id: attachment.id,
          filename: upload.name,
          size_bytes: upload.size,
          replayed: !created,
        },
      });
      return { attachment, error: null };
    } catch (cause) {
      // The database response may be ambiguous after commit. Preserve the
      // private object for idempotent retry/reconciliation instead of risking
      // deletion of evidence already linked by a concurrent request.
      throw cause;
    }
  }

  async deleteAttachment(ticketId: string, attachmentId: string): Promise<{
    attachment: TicketAttachment | null;
    error: string | null;
  }> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return { attachment: null, error: "Ticket not found" };
    const attachment = await this.repo.deleteAttachment(ticket.id, attachmentId);
    if (!attachment) return { attachment: null, error: "Attachment not found" };

    let storageDeleteError: string | null = null;
    if (!attachment.storage_bucket.startsWith("r2:")) {
      try {
        await this.repo.deleteAttachmentObject(attachment.storage_bucket, attachment.storage_path);
      } catch (cause) {
        storageDeleteError = cause instanceof Error ? cause.message : "Storage cleanup failed";
      }
    }
    await this.repo.addTicketEvent({
      ticket_id: ticket.id,
      event_type: "attachment_removed",
      actor_type: "operator",
      payload: {
        attachment_id: attachment.id,
        filename: attachment.filename,
        storage_delete_error: storageDeleteError,
      },
    });
    return { attachment, error: null };
  }

  async recordResolution(input: CreateResolutionActionInput): Promise<{
    action: TicketResolutionAction | null;
    error: string | null;
  }> {
    const ticket = await this.repo.getTicket(input.ticket_id);
    if (!ticket) return { action: null, error: "Ticket not found" };
    if (!RESOLUTION_TYPES.has(input.action_type)) {
      return { action: null, error: "Invalid resolution action type" };
    }
    if (input.action_type === "partial_refund" && (!input.amount || input.amount <= 0)) {
      return { action: null, error: "Partial refunds require a positive amount" };
    }
    if (input.action_type === "replacement" && !input.replacement_sku?.trim()) {
      return { action: null, error: "Replacements require a replacement SKU" };
    }
    if (input.action_type === "no_action" && !input.reason?.trim()) {
      return { action: null, error: "No-action closure requires a reason" };
    }
    const action = await this.repo.recordResolutionAction({
      ...input,
      ticket_id: ticket.id,
      actor: input.actor ?? "portal_operator",
    });
    return { action, error: null };
  }
}
