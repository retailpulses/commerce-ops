import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncTicketListStatus } from "../src/logic/portal-state";

describe("syncTicketListStatus", () => {
  it("updates a non-closed status without mutating the previous list", () => {
    const tickets = [{ id: 1, status: "Awaiting Customer Form", order_id: "order_1" }];
    const updated = syncTicketListStatus(tickets, 1, "In Progress");
    assert.equal(updated[0].status, "In Progress");
    assert.equal(tickets[0].status, "Awaiting Customer Form");
  });

  it("removes a newly resolved or unresolved ticket from an open-only list", () => {
    const tickets = [{ id: 1, status: "Awaiting Customer Form" }, { id: 2, status: "Open" }];
    assert.deepEqual(syncTicketListStatus(tickets, 1, "Closed Resolved").map((t) => t.id), [2]);
    assert.deepEqual(syncTicketListStatus(tickets, 1, "Closed Unresolved").map((t) => t.id), [2]);
  });

  it("retains and updates a closed ticket when closed tickets are included", () => {
    const updated = syncTicketListStatus([{ id: 1, status: "Open" }], 1, "Closed Resolved", false);
    assert.equal(updated[0].status, "Closed Resolved");
  });
});
