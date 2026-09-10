/** Supabase implementation of TicketRepository.
 *  Uses @supabase/supabase-js for all database operations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TicketRepository,
  Ticket,
  TicketDetail,
  TicketListRow,
  TicketListFilters,
  TicketEvent,
  TicketProduct,
  TicketMessage,
  TicketNote,
  CreateTicketInput,
  UpdateTicketInput,
  LinkProductInput,
  AddMessageInput,
  AddNoteInput,
  UpdateNoteInput,
  AddTicketEventInput,
  ProductSearchResult,
  IssueType,
  TicketStatus,
  TicketAttachment,
  TicketResolutionAction,
  CreateResolutionActionInput,
  CustomerSubmission,
} from "./ticketRepository";

export class SupabaseTicketRepository implements TicketRepository {
  constructor(private supabase: SupabaseClient) {}

  // ── Slice 1A ──

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    if (input.origin !== "manual") {
      throw new Error(
        "Unauthorized ticket creation: runtime repository inserts require the manual domain command",
      );
    }
    const { data, error } = await this.supabase
      .from("tickets")
      .insert({
        platform: input.platform,
        account_id: input.account_id ?? null,
        external_order_id: input.external_order_id ?? null,
        external_thread_id: input.external_thread_id ?? null,
        origin: input.origin,
        customer_display_name: input.customer_display_name ?? null,
        customer_contact: input.customer_contact ?? null,
        subject: input.subject ?? null,
        description: input.description ?? null,
        status: input.status ?? "open",
        priority: input.priority ?? "normal",
        issue_types: input.issue_types ?? [],
        assigned_user_id: input.assigned_user_id ?? null,
        assigned_display_name: input.assigned_display_name ?? null,
        external_url: input.external_url ?? null,
        raw_source_payload: input.raw_source_payload ?? {},
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new Error(
          `Duplicate ticket: a ticket already exists for this platform order`
        );
      }
      throw new Error(`Failed to create ticket: ${error.message}`);
    }

    return this.mapTicket(data);
  }

  async getTicket(ticketId: string): Promise<TicketDetail | null> {
    const { data, error } = await this.supabase
      .from("tickets")
      .select("*")
      .or(`id.eq.${ticketId},ticket_number.eq.${ticketId},external_order_id.eq.${ticketId}`)
      .single();

    if (error || !data) return null;

    const [products, messages, notes, events, resolutionActions, customerSubmissions] = await Promise.all([
      this.getTicketProducts(data.id),
      this.getTicketMessages(data.id),
      this.getTicketNotes(data.id),
      this.getTicketEvents(data.id),
      this.listResolutionActions(data.id),
      this.listCustomerSubmissions(data.id),
    ]);

    return {
      ...this.mapTicket(data),
      products,
      messages,
      notes,
      events,
      resolution_actions: resolutionActions,
      customer_submissions: customerSubmissions,
    };
  }

  private async listCustomerSubmissions(ticketId: string): Promise<CustomerSubmission[]> {
    const { data, error } = await this.supabase
      .from("customer_submissions")
      .select(
        "id,ticket_id,submission_type,customer_display_name,customer_contact,issue_description,expected_solution,source,processing_status,submitted_at",
      )
      .eq("ticket_id", ticketId)
      .order("submitted_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to list customer submissions: ${error.message}`);
    }
    return (data ?? []) as CustomerSubmission[];
  }

  async listTickets(filters: TicketListFilters): Promise<{
    rows: TicketListRow[];
    total: number;
  }> {
    let query = this.supabase.from("ticket_list_view").select("*", {
      count: "exact",
    });

    if (filters.platform) {
      query = query.eq("platform", filters.platform);
    }
    if (filters.account_id) {
      query = query.eq("account_id", filters.account_id);
    }
    if (filters.status) {
      query = query.eq("status", filters.status);
    }
    if (filters.status_group === "non_terminal") {
      query = query.in("status", ["open", "in_progress", "pending_customer", "pending_third_party"]);
    }
    if (filters.priority) {
      query = query.eq("priority", filters.priority);
    }
    if (filters.needs_reply !== undefined) {
      query = query.eq("needs_reply", filters.needs_reply);
    }
    if (filters.issue_type) {
      query = query.contains("issue_types", [filters.issue_type]);
    }
    if (filters.q) {
      query = query.or(
        `external_order_id.ilike.%${filters.q}%,subject.ilike.%${filters.q}%,customer_display_name.ilike.%${filters.q}%,ticket_number.ilike.%${filters.q}%`
      );
    }

    // Sorting
    const sort = filters.sort ?? "created_at.desc";
    const [col, dir] = sort.split(".");
    query = query.order(col, { ascending: dir === "asc" });

    // Pagination
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      throw new Error(`Failed to list tickets: ${error.message}`);
    }

    return {
      rows: (data ?? []).map(this.mapListRow),
      total: count ?? 0,
    };
  }

  async updateTicket(
    ticketId: string,
    input: UpdateTicketInput
  ): Promise<Ticket> {
    const patch: Record<string, unknown> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.issue_types !== undefined) patch.issue_types = input.issue_types;
    if (input.assigned_user_id !== undefined)
      patch.assigned_user_id = input.assigned_user_id;
    if (input.assigned_display_name !== undefined)
      patch.assigned_display_name = input.assigned_display_name;
    if (input.account_id !== undefined)
      patch.account_id = input.account_id;
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.description !== undefined) patch.description = input.description;
    if (input.customer_display_name !== undefined)
      patch.customer_display_name = input.customer_display_name;
    if (input.customer_contact !== undefined)
      patch.customer_contact = input.customer_contact;
    if (input.external_url !== undefined)
      patch.external_url = input.external_url;
    if (input.needs_reply !== undefined)
      patch.needs_reply = input.needs_reply;
    if (input.started_at !== undefined)
      patch.started_at = input.started_at;

    if (Object.keys(patch).length === 0) {
      // Nothing to update — fetch and return current
      const current = await this.getTicket(ticketId);
      if (!current) throw new Error("Ticket not found");
      return current;
    }

    patch.updated_at = new Date().toISOString();

    // If status is being set to closed/resolved, set closed_at
    if (
      input.status === "closed" ||
      input.status === "resolved" ||
      input.status === "canceled"
    ) {
      patch.closed_at = new Date().toISOString();
    }

    const { data, error } = await this.supabase
      .from("tickets")
      .update(patch)
      .or(`id.eq.${ticketId},ticket_number.eq.${ticketId},external_order_id.eq.${ticketId}`)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update ticket: ${error.message}`);
    }

    return this.mapTicket(data);
  }

  async linkTicketProduct(input: LinkProductInput): Promise<TicketProduct> {
    const row = {
      ticket_id: input.ticket_id,
      product_id: input.product_id ?? null,
      variant_id: input.variant_id ?? null,
      listing_id: input.listing_id ?? null,
      listing_sku_id: input.listing_sku_id ?? null,
      sku: input.sku,
      quantity: input.quantity ?? null,
      role: input.role ?? "related",
    };

    const { data, error } = await this.supabase
      .from("ticket_products")
      .insert(row)
      .select()
      .single();

    if (error?.code === "23505") {
      const existing = await this.findExistingTicketProduct(row);
      if (existing) return existing;
    }

    if (error) {
      throw new Error(`Failed to link product: ${error.message}`);
    }

    return this.mapTicketProduct(data);
  }

  async unlinkTicketProduct(
    ticketId: string,
    productId: string
  ): Promise<void> {
    const { error } = await this.supabase
      .from("ticket_products")
      .delete()
      .eq("ticket_id", ticketId)
      .eq("id", productId);

    if (error) {
      throw new Error(`Failed to unlink product: ${error.message}`);
    }
  }

  async getTicketEvents(ticketId: string): Promise<TicketEvent[]> {
    const { data, error } = await this.supabase
      .from("ticket_events")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });

    if (error) return [];
    return (data ?? []).map(this.mapTicketEvent);
  }

  async addTicketEvent(input: AddTicketEventInput): Promise<TicketEvent> {
    const findExisting = async (): Promise<TicketEvent | null> => {
      if (!input.idempotency_key) return null;
      const { data, error } = await this.supabase
        .from("ticket_events")
        .select("*")
        .eq("idempotency_key", input.idempotency_key)
        .maybeSingle();
      if (error) throw new Error(`Failed to reconcile event: ${error.message}`);
      return data ? this.mapTicketEvent(data) : null;
    };

    const existing = await findExisting();
    if (existing) return existing;

    const { data, error } = await this.supabase
      .from("ticket_events")
      .insert({
        ticket_id: input.ticket_id,
        event_type: input.event_type,
        actor_type: input.actor_type,
        actor_id: input.actor_id ?? null,
        payload: input.payload ?? {},
        idempotency_key: input.idempotency_key ?? null,
      })
      .select()
      .single();

    if (error) {
      const reconciled = await findExisting();
      if (reconciled) return reconciled;
      throw new Error(`Failed to add event: ${error.message}`);
    }

    return this.mapTicketEvent(data);
  }

  async searchProducts(
    query: string,
    platform?: string
  ): Promise<ProductSearchResult[]> {
    // Search across product_variants and platform_listing_skus
    const variantQuery = this.supabase
      .from("product_variants")
      .select(
        `
        id,
        sku,
        item_code,
        variant_name,
        product_id,
        product:products(id, title)
      `
      )
      .or(
        `sku.ilike.%${query}%,item_code.ilike.%${query}%,shop_sku.ilike.%${query}%`
      )
      .eq("status", "active")
      .limit(10);

    const listingQuery = this.supabase
      .from("platform_listing_skus")
      .select(
        `
        id,
        seller_sku,
        sku_code,
        asin,
        variant_id,
        listing_id,
        variant:product_variants(
          id,
          sku,
          item_code,
          variant_name,
          product_id,
          product:products(id, title)
        ),
        listing:platform_listings!inner(id, platform)
      `
      )
      .or(
        `seller_sku.ilike.%${query}%,sku_code.ilike.%${query}%,asin.ilike.%${query}%`
      )
      .limit(10);

    if (platform) {
      listingQuery.eq("listing.platform", platform);
    }

    const [variantRes, listingRes] = await Promise.all([
      variantQuery,
      listingQuery,
    ]);

    const results: ProductSearchResult[] = [];

    const firstRelation = (
      value: unknown,
    ): Record<string, unknown> | null => {
      if (Array.isArray(value)) {
        return (value[0] as Record<string, unknown> | undefined) ?? null;
      }
      return (value as Record<string, unknown> | null) ?? null;
    };

    if (variantRes.data) {
      for (const row of variantRes.data) {
        const r = row as Record<string, unknown>;
        const product = firstRelation(r.product);
        results.push({
          variant_id: r.id as string,
          product_id:
            (r.product_id as string | undefined) ??
            (product?.id as string | undefined) ??
            null,
          sku: r.sku as string,
          item_code: r.item_code as string | null ?? null,
          product_name: (product?.title as string | undefined) ?? "",
          variant_name: r.variant_name as string | null ?? null,
          listing_id: null,
          listing_sku_id: null,
          platform: null,
          seller_name: null,
        });
      }
    }

    if (listingRes.data) {
      for (const row of listingRes.data) {
        const r = row as Record<string, unknown>;
        const v = firstRelation(r.variant);
        const vProduct = v ? firstRelation(v.product) : null;
        const listing = firstRelation(r.listing);
        results.push({
          variant_id: (v?.id as string | undefined) ?? null,
          product_id:
            (v?.product_id as string | undefined) ??
            (vProduct?.id as string | undefined) ??
            null,
          sku: (r.seller_sku || r.sku_code || v?.sku || r.asin) as string,
          item_code: (v?.item_code as string | null | undefined) ?? null,
          product_name: (vProduct?.title as string | undefined) ?? "",
          variant_name: (v?.variant_name as string | null | undefined) ?? null,
          listing_id: listing?.id as string ?? null,
          listing_sku_id: r.id as string,
          platform: listing?.platform as string ?? null,
          seller_name: null,
        });
      }
    }

    return results;
  }

  async getIssueTypes(): Promise<IssueType[]> {
    const { data, error } = await this.supabase
      .from("ticket_issue_types")
      .select("key, display_name, sort_order, is_active")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw new Error(`getIssueTypes failed: ${error.message}`);
    return (data ?? []) as IssueType[];
  }

  async getStatuses(): Promise<TicketStatus[]> {
    const { data, error } = await this.supabase
      .from("ticket_statuses")
      .select("key, display_name, category, sort_order, is_active")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw new Error(`getStatuses failed: ${error.message}`);
    return (data ?? []) as TicketStatus[];
  }

  async listAttachments(ticketId: string): Promise<TicketAttachment[]> {
    const { data, error } = await this.supabase
      .from("ticket_attachments")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list attachments: ${error.message}`);

    return Promise.all((data ?? []).map(async (row: Record<string, unknown>) => {
      let signedUrl: string | null = null;
      const bucket = row.storage_bucket as string;
      if (!bucket.startsWith("r2:") && bucket !== "rakuten-rmesse-reference") {
        const { data: signed, error: signedError } = await this.supabase.storage
          .from(bucket)
          .createSignedUrl(row.storage_path as string, 600);
        if (!signedError) signedUrl = signed?.signedUrl ?? null;
      }
      return this.mapAttachment(row, signedUrl);
    }));
  }

  async createAttachment(
    input: Omit<TicketAttachment, "id" | "signed_url" | "created_at">,
  ): Promise<{ attachment: TicketAttachment; created: boolean }> {
    const findExisting = async (): Promise<TicketAttachment | null> => {
      const { data, error } = await this.supabase
        .from("ticket_attachments")
        .select("*")
        .eq("storage_bucket", input.storage_bucket)
        .eq("storage_path", input.storage_path)
        .maybeSingle();
      if (error) throw new Error(`Failed to reconcile attachment: ${error.message}`);
      if (!data) return null;
      const { data: signed } = await this.supabase.storage
        .from(input.storage_bucket)
        .createSignedUrl(input.storage_path, 600);
      return this.mapAttachment(data, signed?.signedUrl ?? null);
    };

    const existing = await findExisting();
    if (existing) return { attachment: existing, created: false };

    const { data, error } = await this.supabase
      .from("ticket_attachments")
      .insert(input)
      .select()
      .single();
    if (error) {
      // A concurrent retry or lost response may have committed the row. Read
      // by its unique Storage identity before declaring failure.
      const reconciled = await findExisting();
      if (reconciled) return { attachment: reconciled, created: false };
      throw new Error(`Failed to create attachment: ${error.message}`);
    }
    const { data: signed } = await this.supabase.storage
      .from(input.storage_bucket)
      .createSignedUrl(input.storage_path, 600);
    return { attachment: this.mapAttachment(data, signed?.signedUrl ?? null), created: true };
  }

  async getAttachment(ticketId: string, attachmentId: string): Promise<TicketAttachment | null> {
    const { data, error } = await this.supabase
      .from("ticket_attachments")
      .select("*")
      .eq("ticket_id", ticketId)
      .eq("id", attachmentId)
      .maybeSingle();
    if (error) throw new Error(`Failed to get attachment: ${error.message}`);
    return data ? this.mapAttachment(data, null) : null;
  }

  async deleteAttachment(ticketId: string, attachmentId: string): Promise<TicketAttachment | null> {
    const existing = await this.getAttachment(ticketId, attachmentId);
    if (!existing) return null;
    const { error } = await this.supabase
      .from("ticket_attachments")
      .delete()
      .eq("ticket_id", ticketId)
      .eq("id", attachmentId);
    if (error) throw new Error(`Failed to delete attachment: ${error.message}`);
    return existing;
  }

  async createSignedAttachmentUpload(bucket: string, path: string): Promise<{ signed_url: string; token: string }> {
    const { data, error } = await this.supabase.storage.from(bucket).createSignedUploadUrl(path);
    if (error) throw new Error(`Failed to authorize attachment upload: ${error.message}`);
    return { signed_url: data.signedUrl, token: data.token };
  }

  async getAttachmentObjectInfo(bucket: string, path: string): Promise<{ size: number; mime_type: string | null } | null> {
    const slash = path.lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash) : "";
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    const { data, error } = await this.supabase.storage.from(bucket).list(folder, {
      search: filename,
      limit: 10,
    });
    if (error) throw new Error(`Failed to verify attachment upload: ${error.message}`);
    const object = data?.find((item) => item.name === filename);
    if (!object) return null;
    const metadata = object.metadata as Record<string, unknown> | null;
    return {
      size: Number(metadata?.size ?? 0),
      mime_type: (metadata?.mimetype as string | undefined) ?? null,
    };
  }

  async deleteAttachmentObject(bucket: string, path: string): Promise<void> {
    const { error } = await this.supabase.storage.from(bucket).remove([path]);
    if (error) throw new Error(`Failed to delete attachment object: ${error.message}`);
  }

  async listResolutionActions(ticketId: string): Promise<TicketResolutionAction[]> {
    const { data, error } = await this.supabase
      .from("ticket_resolution_actions")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list resolution actions: ${error.message}`);
    return (data ?? []).map(this.mapResolutionAction);
  }

  async recordResolutionAction(input: CreateResolutionActionInput): Promise<TicketResolutionAction> {
    const { data, error } = await this.supabase.rpc("record_ticket_resolution", {
      p_ticket_id: input.ticket_id,
      p_operation_id: input.operation_id,
      p_action_type: input.action_type,
      p_amount: input.amount ?? null,
      p_currency: input.currency ?? "JPY",
      p_replacement_sku: input.replacement_sku ?? null,
      p_quantity: input.quantity ?? null,
      p_reason: input.reason ?? null,
      p_external_reference: input.external_reference ?? null,
      p_actor: input.actor ?? null,
      p_close_ticket: input.close_ticket ?? true,
    });
    if (error) throw new Error(`Failed to record resolution: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return this.mapResolutionAction(row as Record<string, unknown>);
  }

  // ── Slice 1B ──

  async addMessage(input: AddMessageInput): Promise<TicketMessage> {
    const { data, error } = await this.supabase
      .from("ticket_messages")
      .insert({
        ticket_id: input.ticket_id,
        platform: input.platform,
        external_message_id: input.external_message_id ?? null,
        sender_type: input.sender_type,
        sender_display_name: input.sender_display_name ?? null,
        body: input.body,
        sent_at: input.sent_at ?? new Date().toISOString(),
        raw_payload: input.raw_payload ?? {},
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to add message: ${error.message}`);
    }

    // Update cached fields on ticket
    await this.updateMessageCache(input.ticket_id, input.body, input.sent_at);

    return this.mapMessage(data);
  }

  async addNote(input: AddNoteInput): Promise<TicketNote> {
    const { data, error } = await this.supabase
      .from("ticket_notes")
      .insert({
        ticket_id: input.ticket_id,
        body: input.body,
        created_by: input.created_by ?? null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to add note: ${error.message}`);
    }

    return this.mapNote(data);
  }

  async updateNote(input: UpdateNoteInput): Promise<TicketNote | null> {
    const { data, error } = await this.supabase
      .from("ticket_notes")
      .update({ body: input.body })
      .eq("id", input.note_id)
      .eq("ticket_id", input.ticket_id)
      .select()
      .maybeSingle();

    if (error) throw new Error(`Failed to update note: ${error.message}`);
    return data ? this.mapNote(data) : null;
  }

  async getTicketMessages(ticketId: string): Promise<TicketMessage[]> {
    const { data, error } = await this.supabase
      .from("ticket_messages")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("sent_at", { ascending: true });

    if (error) return [];
    return (data ?? []).map(this.mapMessage);
  }

  async getTicketNotes(ticketId: string): Promise<TicketNote[]> {
    const { data, error } = await this.supabase
      .from("ticket_notes")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });

    if (error) return [];
    return (data ?? []).map(this.mapNote);
  }

  async getTicketProducts(ticketId: string): Promise<TicketProduct[]> {
    const { data, error } = await this.supabase
      .from("ticket_products")
      .select(
        `
        *,
        product:products(title),
        variant:product_variants(sku, item_code, variant_name, raw_payload),
        listing_sku:platform_listing_skus(seller_sku, sku_code, asin),
        listing:platform_listings(platform)
      `
      )
      .eq("ticket_id", ticketId);

    if (error) return [];
    return (data ?? []).map((row: Record<string, unknown>) =>
      this.mapTicketProduct(row)
    );
  }

  // ── Internal helpers ──

  private async updateMessageCache(
    ticketId: string,
    body: string,
    sentAt?: string
  ): Promise<void> {
    await this.supabase
      .from("tickets")
      .update({
        latest_message_at: sentAt ?? new Date().toISOString(),
        latest_customer_message: body.slice(0, 500),
      })
      .eq("id", ticketId);
  }

  private async findExistingTicketProduct(row: {
    ticket_id: string;
    product_id: string | null;
    variant_id: string | null;
    listing_id: string | null;
    listing_sku_id: string | null;
  }): Promise<TicketProduct | null> {
    let query = this.supabase
      .from("ticket_products")
      .select("*")
      .eq("ticket_id", row.ticket_id);

    for (const field of ["product_id", "variant_id", "listing_id", "listing_sku_id"] as const) {
      const value = row[field];
      query = value ? query.eq(field, value) : query.is(field, null);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      throw new Error(`Failed to fetch existing product link: ${error.message}`);
    }
    return data ? this.mapTicketProduct(data) : null;
  }

  // ── Mappers ──

  private mapTicket(row: Record<string, unknown>): Ticket {
    return {
      id: (row.id ?? row.ticket_id) as string,
      ticket_number: row.ticket_number as string,
      platform: row.platform as string,
      account_id: row.account_id as string | null,
      external_order_id: row.external_order_id as string | null,
      external_thread_id: row.external_thread_id as string | null,
      origin: row.origin as string,
      customer_display_name: row.customer_display_name as string | null,
      customer_contact: row.customer_contact as string | null,
      subject: row.subject as string | null,
      description: row.description as string | null,
      status: row.status as string,
      priority: row.priority as string,
      issue_types: (row.issue_types as string[]) ?? [],
      assigned_user_id: row.assigned_user_id as string | null,
      assigned_display_name: row.assigned_display_name as string | null,
      latest_message_at: row.latest_message_at as string | null,
      latest_customer_message: row.latest_customer_message as string | null,
      needs_reply: (row.needs_reply as boolean) ?? false,
      external_url: row.external_url as string | null,
      raw_source_payload:
        (row.raw_source_payload as Record<string, unknown>) ?? {},
      started_at: row.started_at as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      closed_at: row.closed_at as string | null,
    };
  }

  private mapListRow(row: Record<string, unknown>): TicketListRow {
    return {
      id: (row.id ?? row.ticket_id) as string,
      ticket_number: row.ticket_number as string,
      platform: row.platform as string,
      account_id: row.account_id as string | null,
      account_display_name: row.account_display_name as string | null,
      external_order_id: row.external_order_id as string | null,
      status: row.status as string,
      priority: row.priority as string,
      issue_types: (row.issue_types as string[]) ?? [],
      customer_display_name: row.customer_display_name as string | null,
      subject: row.subject as string | null,
      description: row.description as string | null,
      latest_message_at: row.latest_message_at as string | null,
      latest_customer_message: row.latest_customer_message as string | null,
      needs_reply: (row.needs_reply as boolean) ?? false,
      external_url: row.external_url as string | null,
      product_name: row.product_name as string | null,
      primary_sku: row.primary_sku as string | null,
      seller_name: row.seller_name as string | null,
      attachment_count: (row.attachment_count as number) ?? 0,
      note_count: (row.note_count as number) ?? 0,
      started_at: row.started_at as string | null,
      created_at: row.created_at as string,
    };
  }

  private mapTicketProduct(row: Record<string, unknown>): TicketProduct {
    const firstRelation = (
      value: unknown,
    ): Record<string, unknown> | null => {
      if (Array.isArray(value)) {
        return (value[0] as Record<string, unknown> | undefined) ?? null;
      }
      return (value as Record<string, unknown> | null) ?? null;
    };
    const product = firstRelation(row.product);
    const variant = firstRelation(row.variant);
    const listingSku = firstRelation(row.listing_sku);
    const listing = firstRelation(row.listing);
    const variantPayload =
      (variant?.raw_payload as Record<string, unknown> | null) ?? {};

    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      product_id: row.product_id as string | null,
      variant_id: row.variant_id as string | null,
      listing_id: row.listing_id as string | null,
      listing_sku_id: row.listing_sku_id as string | null,
      sku: row.sku as string,
      quantity: row.quantity as number | null,
      role: row.role as string,
      created_at: row.created_at as string,
      product_name:
        (row.product_name as string | null) ??
        (product?.title as string | undefined) ??
        null,
      variant_name:
        (row.variant_name as string | null) ??
        (variant?.variant_name as string | undefined) ??
        null,
      item_code:
        (row.item_code as string | null) ??
        (variant?.item_code as string | undefined) ??
        null,
      platform: (listing?.platform as string | undefined) ?? null,
      platform_sku:
        (listingSku?.seller_sku as string | undefined) ??
        (listingSku?.sku_code as string | undefined) ??
        null,
      seller_name:
        (row.seller_name as string | null) ??
        (variantPayload.store_name as string | undefined) ??
        null,
      unit_price:
        (variantPayload.unit_price as string | undefined) ??
        null,
      unit_fulfillment_price:
        (variantPayload.unit_fulfillment_fee_drop_shipping as string | undefined) ??
        null,
    };
  }

  private mapTicketEvent(row: Record<string, unknown>): TicketEvent {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      event_type: row.event_type as string,
      actor_type: row.actor_type as string,
      actor_id: row.actor_id as string | null,
      payload: (row.payload as Record<string, unknown>) ?? {},
      created_at: row.created_at as string,
    };
  }

  private mapMessage(row: Record<string, unknown>): TicketMessage {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      platform: row.platform as string,
      external_message_id: row.external_message_id as string | null,
      sender_type: row.sender_type as string,
      sender_display_name: row.sender_display_name as string | null,
      body: row.body as string,
      sent_at: row.sent_at as string,
      raw_payload: (row.raw_payload as Record<string, unknown>) ?? {},
      created_at: row.created_at as string,
    };
  }

  private mapNote(row: Record<string, unknown>): TicketNote {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      body: row.body as string,
      created_by: row.created_by as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string | null,
    };
  }

  private mapAttachment(row: Record<string, unknown>, signedUrl: string | null): TicketAttachment {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string | null,
      customer_submission_id: row.customer_submission_id as string | null,
      storage_bucket: row.storage_bucket as string,
      storage_path: row.storage_path as string,
      filename: row.filename as string | null,
      mime_type: row.mime_type as string | null,
      media_type: row.media_type as string,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      source: row.source as string,
      reference_url: row.original_url as string | null,
      signed_url: signedUrl,
      created_at: row.created_at as string,
    };
  }

  private mapResolutionAction(row: Record<string, unknown>): TicketResolutionAction {
    return {
      id: row.id as string,
      ticket_id: row.ticket_id as string,
      action_type: row.action_type as string,
      amount: row.amount === null ? null : Number(row.amount),
      currency: (row.currency as string) ?? "JPY",
      replacement_sku: row.replacement_sku as string | null,
      quantity: row.quantity === null ? null : Number(row.quantity),
      reason: row.reason as string | null,
      approved_by: row.approved_by as string | null,
      external_reference: row.external_reference as string | null,
      operation_id: row.operation_id as string | null,
      executed_at: row.executed_at as string | null,
      created_at: row.created_at as string,
    };
  }
}
