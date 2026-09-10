import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TicketService, MAX_ATTACHMENT_BYTES } from "../src/services/ticketService";
import type { TicketDetail, TicketRepository } from "../src/repositories/ticketRepository";

const ticket: TicketDetail = {
  id: "11111111-1111-1111-1111-111111111111",
  ticket_number: "T-1",
  platform: "mercari",
  account_id: null,
  external_order_id: null,
  external_thread_id: null,
  origin: "manual",
  customer_display_name: null,
  customer_contact: null,
  subject: null,
  description: null,
  status: "open",
  priority: "normal",
  issue_types: [],
  assigned_user_id: null,
  assigned_display_name: null,
  latest_message_at: null,
  latest_customer_message: null,
  needs_reply: true,
  external_url: null,
  raw_source_payload: {},
  started_at: null,
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
  closed_at: null,
  products: [], messages: [], notes: [], events: [], resolution_actions: [],
};

function repo(overrides: Record<string, unknown> = {}): TicketRepository {
  return {
    getTicket: async () => ticket,
    createSignedAttachmentUpload: async () => ({ signed_url: "https://storage.test/upload", token: "token" }),
    getAttachmentObjectInfo: async () => ({ size: 10, mime_type: "video/mp4" }),
    createAttachment: async (input: Record<string, unknown>) => ({
      attachment: {
        id: "attachment-1", ...input, signed_url: "https://storage.test/read", created_at: "2026-07-15T00:00:00Z",
      },
      created: true,
    }),
    addTicketEvent: async (input: Record<string, unknown>) => ({ id: "event-1", actor_id: null, created_at: "2026-07-15T00:00:00Z", ...input }),
    deleteAttachmentObject: async () => undefined,
    ...overrides,
  } as unknown as TicketRepository;
}

describe("Ticket-to-Resolution evidence", () => {
  it("authorizes the exact 100 MB boundary using a server-selected ticket path", async () => {
    const service = new TicketService(repo());
    const result = await service.prepareAttachmentUpload(ticket.id, {
      name: "proof.mp4", size: MAX_ATTACHMENT_BYTES, type: "video/mp4",
    });
    assert.equal(result.error, null);
    assert.match(result.upload?.path ?? "", new RegExp(`^tickets/${ticket.id}/`));
    assert.equal(result.upload?.signed_url, "https://storage.test/upload");
  });

  it("rejects oversized and unsupported evidence before issuing an upload", async () => {
    let authorizations = 0;
    const service = new TicketService(repo({
      createSignedAttachmentUpload: async () => {
        authorizations += 1;
        return { signed_url: "", token: "" };
      },
    }));
    assert.match((await service.prepareAttachmentUpload(ticket.id, {
      name: "large.mp4", size: MAX_ATTACHMENT_BYTES + 1, type: "video/mp4",
    })).error ?? "", /100 MB/);
    assert.match((await service.prepareAttachmentUpload(ticket.id, {
      name: "payload.exe", size: 10, type: "application/octet-stream",
    })).error ?? "", /Unsupported/);
    assert.equal(authorizations, 0);
  });

  it("refuses finalization when stored object size differs from the grant", async () => {
    let deleted = false;
    const service = new TicketService(repo({
      getAttachmentObjectInfo: async () => ({ size: 11, mime_type: "video/mp4" }),
      deleteAttachmentObject: async () => { deleted = true; },
    }));
    const result = await service.finalizeAttachmentUpload(ticket.id, {
      path: `tickets/${ticket.id}/proof.mp4`, name: "proof.mp4", size: 10, type: "video/mp4",
    });
    assert.match(result.error ?? "", /size does not match/);
    assert.equal(deleted, true);
  });
});

describe("structured resolution actions", () => {
  it("requires an explicit reason when closure is waived as no action", async () => {
    let writes = 0;
    const service = new TicketService(repo({
      recordResolutionAction: async () => { writes += 1; return {}; },
    }));
    const result = await service.recordResolution({
      ticket_id: ticket.id,
      operation_id: "33333333-3333-4333-8333-333333333333",
      action_type: "no_action",
    });
    assert.match(result.error ?? "", /requires a reason/);
    assert.equal(writes, 0);
  });

  it("requires a resolution outcome before a generic terminal status update", async () => {
    let updates = 0;
    const service = new TicketService(repo({
      updateTicket: async () => { updates += 1; return ticket; },
    }));
    const result = await service.updateTicket(ticket.id, { status: "closed" });
    assert.match(result.error ?? "", /Record a resolution outcome/);
    assert.equal(updates, 0);
  });

  it("does not reopen a terminal ticket for an operator message", async () => {
    let updates = 0;
    const closed = { ...ticket, status: "closed" };
    const service = new TicketService(repo({
      getTicket: async () => closed,
      addMessage: async (input: Record<string, unknown>) => ({
        id: "message-1", ...input, created_at: "2026-07-15T00:00:00Z",
      }),
      updateTicket: async () => { updates += 1; return closed; },
    }));
    const result = await service.addMessage({
      ticket_id: ticket.id,
      platform: "mercari",
      sender_type: "operator",
      body: "Operator follow-up",
    });
    assert.equal(result.error, null);
    assert.equal(updates, 0);
  });

  it("reopens a terminal ticket only for customer-originated contact", async () => {
    let updates = 0;
    const closed = { ...ticket, status: "closed" };
    const service = new TicketService(repo({
      getTicket: async () => closed,
      addMessage: async (input: Record<string, unknown>) => ({
        id: "message-1", ...input, created_at: "2026-07-15T00:00:00Z",
      }),
      updateTicket: async () => { updates += 1; return { ...closed, status: "open" }; },
    }));
    await service.addMessage({
      ticket_id: ticket.id,
      platform: "mercari",
      sender_type: "customer",
      body: "The issue persists",
    });
    assert.equal(updates, 1);
  });
});
