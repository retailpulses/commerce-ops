import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SupabaseTicketRepository } from "../src/repositories/supabaseTicketRepository";

describe("ticket list search", () => {
  it("maps the Metrics non-terminal queue to the owner status set", async () => {
    let statuses: string[] = [];
    const query = {
      select() { return this; },
      in(column: string, values: string[]) {
        if (column === "status") statuses = values;
        return this;
      },
      order() { return this; },
      range() { return this; },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      },
    };
    const repo = new SupabaseTicketRepository({ from: () => query } as never);

    await repo.listTickets({ status_group: "non_terminal" });

    assert.deepEqual(statuses, ["open", "in_progress", "pending_customer", "pending_third_party"]);
  });

  it("searches only columns exposed by ticket_list_view", async () => {
    let orFilter = "";
    const query = {
      select() { return this; },
      or(filter: string) { orFilter = filter; return this; },
      order() { return this; },
      range() { return this; },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      },
    };
    const supabase = { from: () => query };
    const repo = new SupabaseTicketRepository(supabase as never);

    await repo.listTickets({ q: "2JSR9jPjtcuXjXh5zFECfN" });

    assert.match(orFilter, /external_order_id\.ilike/);
    assert.match(orFilter, /ticket_number\.ilike/);
    assert.doesNotMatch(orFilter, /description\.ilike/);
  });
});

describe("customer submissions", () => {
  it("loads linked form answers newest first", async () => {
    let ticketFilter = "";
    let orderColumn = "";
    let orderAscending: boolean | undefined;
    const rows = [{
      id: "submission-1",
      ticket_id: "ticket-1",
      submission_type: "damage_evidence",
      customer_display_name: null,
      customer_contact: null,
      issue_description: "Broken",
      expected_solution: "Replacement",
      source: "public_form",
      processing_status: "linked",
      submitted_at: "2026-07-30T00:00:00Z",
    }];
    const query = {
      select() { return this; },
      eq(column: string, value: string) {
        if (column === "ticket_id") ticketFilter = value;
        return this;
      },
      order(column: string, options: { ascending: boolean }) {
        orderColumn = column;
        orderAscending = options.ascending;
        return Promise.resolve({ data: rows, error: null });
      },
    };
    const repo = new SupabaseTicketRepository({ from: () => query } as never);

    const submissions = await (
      repo as unknown as {
        listCustomerSubmissions(ticketId: string): Promise<typeof rows>;
      }
    ).listCustomerSubmissions("ticket-1");

    assert.equal(ticketFilter, "ticket-1");
    assert.equal(orderColumn, "submitted_at");
    assert.equal(orderAscending, false);
    assert.deepEqual(submissions, rows);
  });
});
