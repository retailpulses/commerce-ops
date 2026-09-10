import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InboundMessageService } from "../src/services/inboundMessageService";
import type {
  AddTicketEventInput,
  LinkProductInput,
  Ticket,
  TicketDetail,
  TicketRepository,
} from "../src/repositories/ticketRepository";
import type {
  InboundMessage,
  InboundMessageRepository,
  UpdateInboundMessageInput,
} from "../src/repositories/inboundMessageRepository";
import type { SupabaseClient } from "@supabase/supabase-js";

type QueryResult = { data: unknown[]; error: { message: string } | null };
type QueryFilter = { operator: "in" | "eq"; column: string; value: unknown };

class FakeQuery implements PromiseLike<QueryResult> {
  readonly filters: QueryFilter[] = [];

  constructor(
    readonly table: string,
    private readonly responder: (table: string, filters: QueryFilter[]) => QueryResult,
  ) {}

  select(): this { return this; }
  in(column: string, value: unknown[]): this {
    this.filters.push({ operator: "in", column, value });
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.responder(this.table, this.filters)).then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  readonly queries: FakeQuery[] = [];
  readonly rpcCalls: string[] = [];

  constructor(private readonly responder: (table: string, filters: QueryFilter[]) => QueryResult) {}

  from(table: string): FakeQuery {
    const query = new FakeQuery(table, this.responder);
    this.queries.push(query);
    return query;
  }

  async rpc(name: string): Promise<{ data: unknown; error: null }> {
    this.rpcCalls.push(name);
    return { data: { ticket_id: "ticket-1", ticket_number: "TH-000001", created: true }, error: null };
  }
}

const baseTicket = {
  id: "ticket-1",
  ticket_number: "TH-000001",
  platform: "mercari",
  account_id: "account-1",
  external_order_id: "order-1",
  external_thread_id: null,
  origin: "manual",
  customer_display_name: "Buyer",
  customer_contact: null,
  subject: "Test",
  description: "Test",
  status: "open",
  priority: "normal",
  issue_types: [],
  assigned_user_id: null,
  assigned_display_name: null,
  latest_message_at: null,
  latest_customer_message: null,
  needs_reply: false,
  external_url: null,
  raw_source_payload: {},
  started_at: null,
  created_at: "2026-07-21T00:00:00Z",
  updated_at: "2026-07-21T00:00:00Z",
  closed_at: null,
} satisfies Ticket;

function queueItem(products: unknown[]): InboundMessage {
  return {
    id: "inbound-1",
    shop_name: "Shop1",
    order_transaction_id: "order-1",
    product_summary: { products },
    latest_buyer_message: "Product problem",
  } as InboundMessage;
}

function createService(input: {
  item: InboundMessage;
  existingTicket?: TicketDetail | null;
  responder: (table: string, filters: QueryFilter[]) => QueryResult;
}) {
  const links: LinkProductInput[] = [];
  const events: AddTicketEventInput[] = [];
  const updates: UpdateInboundMessageInput[] = [];
  let createCount = 0;

  let converted = false;
  const queueRepo = {
    getById: async () => converted
      ? { ...input.item, linked_ticket_id: "ticket-1", queue_status: "converted", review_status: "reviewed" }
      : input.item,
    update: async (_id: string, patch: UpdateInboundMessageInput) => {
      updates.push(patch);
      return { ...input.item, ...patch };
    },
  } as unknown as InboundMessageRepository;

  const ticketRepo = {
    getTicket: async (id: string) => id === "ticket-1"
      ? input.existingTicket ?? { ...baseTicket, products: [], messages: [], notes: [], events: [], resolution_actions: [] }
      : null,
    createTicket: async () => {
      createCount += 1;
      return baseTicket;
    },
    linkTicketProduct: async (link: LinkProductInput) => {
      links.push(link);
      return { role: link.role };
    },
    addTicketEvent: async (event: AddTicketEventInput) => {
      events.push(event);
      return {};
    },
  } as unknown as TicketRepository;

  const supabase = new FakeSupabase(input.responder);
  const originalRpc = supabase.rpc.bind(supabase);
  supabase.rpc = async (name: string) => {
    const result = await originalRpc(name);
    converted = true;
    return result;
  };
  const service = new InboundMessageService(
    queueRepo,
    ticketRepo,
    supabase as unknown as SupabaseClient,
  );
  return { service, supabase, links, events, updates, getCreateCount: () => createCount };
}

function hasFilter(filters: QueryFilter[], operator: QueryFilter["operator"], column: string): boolean {
  return filters.some((filter) => filter.operator === operator && filter.column === column);
}

describe("queue conversion product auto-linking", () => {
  it("bulk-resolves variants and listing-only fallbacks with one primary product", async () => {
    const harness = createService({
      item: queueItem([
        { sku: "SKU-A", purchased_quantity: 2 },
        { sku: "SKU-B", purchased_quantity: 1 },
      ]),
      responder: (table, filters) => {
        if (table === "product_variants" && hasFilter(filters, "in", "sku")) {
          return { data: [{ id: "variant-a", product_id: "product-a", sku: "SKU-A", item_code: "ITEM-A" }], error: null };
        }
        if (table === "platform_listing_skus" && hasFilter(filters, "in", "seller_sku")) {
          return {
            data: [{
              id: "listing-sku-b",
              listing_id: "listing-b",
              seller_sku: "SKU-B",
              sku_code: null,
              variant_id: null,
            }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
    });

    await harness.service.convertToTicket("inbound-1", { account_id: "account-1" });

    assert.equal(harness.getCreateCount(), 0);
    assert.deepEqual(harness.supabase.rpcCalls, ["convert_mercari_inbound_message_to_ticket_v1"]);
    assert.deepEqual(harness.links, [
      {
        ticket_id: "ticket-1",
        product_id: "product-a",
        variant_id: "variant-a",
        listing_id: null,
        listing_sku_id: null,
        sku: "SKU-A",
        quantity: 2,
        role: "primary",
      },
      {
        ticket_id: "ticket-1",
        product_id: null,
        variant_id: null,
        listing_id: "listing-b",
        listing_sku_id: "listing-sku-b",
        sku: "SKU-B",
        quantity: 1,
        role: "related",
      },
    ]);
    assert.equal(harness.events.filter((event) => event.event_type === "product_linked").length, 2);
    assert.equal(new Set(harness.events.map((event) => event.idempotency_key).filter(Boolean)).size, 2);
    assert.ok(harness.supabase.queries.every((query) => query.filters.every((filter) => filter.operator === "in" || filter.operator === "eq")));
  });

  it("retries auto-linking when conversion finds an existing ticket", async () => {
    const existingTicket = {
      ...baseTicket,
      products: [],
      messages: [],
      notes: [],
      events: [],
      resolution_actions: [],
    } satisfies TicketDetail;
    const harness = createService({
      item: queueItem([{ sku: "SKU-A", purchased_quantity: 1 }]),
      existingTicket,
      responder: (table, filters) => table === "product_variants" && hasFilter(filters, "in", "sku")
        ? { data: [{ id: "variant-a", product_id: "product-a", sku: "SKU-A", item_code: "ITEM-A" }], error: null }
        : { data: [], error: null },
    });

    const result = await harness.service.convertToTicket("inbound-1", { account_id: "account-1" });

    assert.equal(result.ticket.id, "ticket-1");
    assert.equal(harness.getCreateCount(), 0);
    assert.equal(harness.links.length, 1);
    assert.deepEqual(harness.supabase.rpcCalls, ["convert_mercari_inbound_message_to_ticket_v1"]);
  });
});
