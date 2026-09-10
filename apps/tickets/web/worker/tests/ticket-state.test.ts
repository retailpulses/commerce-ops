/**
 * Tests for ticket-state.ts — covers all DoD items for Issue #51.
 *
 * DoD 1: Canonical order identity (normalizeOrderTxId)
 * DoD 2: Aftersales scope gate (isTicketScope, deriveWorkflowTransition routing)
 * DoD 3: Workflow transition rules (preserve closed, reopen, form downgrade prevention)
 * DoD 4: Needs Reply (deriveNeedsReply)
 * DoD 5: Regression safety (issue #50 / #41 / #46 / FUGUAI idempotency patterns)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fuguaiAlreadySent } from "../src/logic/templates";
import {
  normalizeOrderTxId,
  isTicketScope,
  deriveWorkflowTransition,
  deriveNeedsReply,
  CLOSED_WORKFLOW_STATUSES,
  STATUS_OPEN,
  STATUS_AWAITING_CUSTOMER_FORM,
  STATUS_CUSTOMER_FORM_RECEIVED,
} from "../src/logic/ticket-state";

// ═══════════════════════════════════════════════════════════════════════════
// DoD 1: Canonical order identity
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeOrderTxId", () => {
  it("accepts raw Mercari tx id unchanged", () => {
    assert.equal(normalizeOrderTxId("abc123"), "abc123");
    assert.equal(normalizeOrderTxId("m10-abc-def"), "m10-abc-def");
    assert.equal(normalizeOrderTxId("1234567890"), "1234567890");
  });

  it("strips order_ prefix", () => {
    assert.equal(normalizeOrderTxId("order_abc123"), "abc123");
    assert.equal(normalizeOrderTxId("order_m10-abc-def"), "m10-abc-def");
  });

  it("strips order- prefix", () => {
    assert.equal(normalizeOrderTxId("order-abc123"), "abc123");
    assert.equal(normalizeOrderTxId("order-m10-abc-def"), "m10-abc-def");
  });

  it("strips ORDER_ prefix (case-insensitive)", () => {
    assert.equal(normalizeOrderTxId("ORDER_abc123"), "abc123");
    assert.equal(normalizeOrderTxId("Order_abc123"), "abc123");
  });

  it("returns null for empty/null/whitespace", () => {
    assert.equal(normalizeOrderTxId(""), null);
    assert.equal(normalizeOrderTxId("   "), null);
    assert.equal(normalizeOrderTxId(null), null);
    assert.equal(normalizeOrderTxId(undefined), null);
  });

  it("all three variants dedupe to same canonical key", () => {
    const raw = "m10-abc-def";
    const withOrderUnderscore = "order_m10-abc-def";
    const withOrderDash = "order-m10-abc-def";

    const a = normalizeOrderTxId(raw);
    const b = normalizeOrderTxId(withOrderUnderscore);
    const c = normalizeOrderTxId(withOrderDash);

    assert.equal(a, raw);
    assert.equal(b, raw);
    assert.equal(c, raw);
    // Dedupe map key equivalence
    const dedup = new Map<string, string>();
    dedup.set(a!, raw);
    dedup.set(b!, raw);
    dedup.set(c!, raw);
    assert.equal(dedup.size, 1);
  });

  it("writes preserve order_ prefix (verified in handler.ts, not in normalizeOrderTxId)", () => {
    // normalizeOrderTxId strips prefix; writes use `order_${txId}` convention.
    // This test confirms normalizeOrderTxId doesn't preserve the prefix.
    const result = normalizeOrderTxId("order_abc123");
    assert.equal(result, "abc123");
    // The canonical form for writes is `order_${normalizeOrderTxId(value)}`
    assert.equal(`order_${result}`, "order_abc123");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 2: Aftersales scope gate
// ═══════════════════════════════════════════════════════════════════════════

describe("isTicketScope", () => {
  it("returns true only for COMPLETED", () => {
    assert.equal(isTicketScope("COMPLETED"), true);
  });

  it("returns false for non-COMPLETED statuses", () => {
    assert.equal(isTicketScope("WAITING_FOR_SHIPMENT"), false);
    assert.equal(isTicketScope("WAITING_FOR_PAYMENT"), false);
    assert.equal(isTicketScope("CANCELED"), false);
    assert.equal(isTicketScope("IN_PROGRESS"), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isTicketScope(null), false);
    assert.equal(isTicketScope(undefined), false);
  });
});

describe("deriveWorkflowTransition — aftersales scope gate", () => {
  const baseArgs = {
    orderStatus: "COMPLETED",
    existingStatus: null as string | null,
    cls: "greeting_only",
    subcls: "",
    isFugai: false,
    operatorActionRequired: false,
    sellerRepliedAfterLatestBuyer: false,
  };

  it("routes COMPLETED actionable work to review without creating a ticket", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "COMPLETED",
      cls: "real_ticket",
      subcls: "",
    });
    assert.equal(result.route, "ticket_handling");
    assert.equal(result.shouldCreateTicket, false);
    assert.equal(result.shouldWriteTicket, false);
  });

  it("routes to order_mgmt for non-COMPLETED + actionable (real_ticket)", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "WAITING_FOR_SHIPMENT",
      cls: "real_ticket",
      subcls: "",
    });
    assert.equal(result.route, "order_mgmt");
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.shouldCreateTicket, false);
  });

  it("routes to order_mgmt for non-COMPLETED + actionable (suspicious)", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "WAITING_FOR_SHIPMENT",
      cls: "suspicious",
      subcls: "",
    });
    assert.equal(result.route, "order_mgmt");
  });

  it("routes to order_mgmt for non-COMPLETED + operator_action_required", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "WAITING_FOR_PAYMENT",
      cls: "greeting_only",
      operatorActionRequired: true,
    });
    assert.equal(result.route, "order_mgmt");
  });

  it("routes to order_mgmt for non-COMPLETED + delivery_request", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "WAITING_FOR_PAYMENT",
      cls: "delivery_request",
    });
    assert.equal(result.route, "order_mgmt");
  });

  it("routes to ignore for non-COMPLETED + non-actionable (greeting_only)", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "WAITING_FOR_SHIPMENT",
      cls: "greeting_only",
      operatorActionRequired: false,
    });
    assert.equal(result.route, "ignore");
  });

  it("non-COMPLETED mutations do not create/reopen/close/update ticket handling workflow state", () => {
    const result = deriveWorkflowTransition({
      ...baseArgs,
      orderStatus: "CANCELED",
      cls: "real_ticket",
    });
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.shouldCreateTicket, false);
    assert.equal(result.shouldReopen, false);
    assert.equal(result.shouldPreserveClosed, false);
    assert.equal(result.route, "order_mgmt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 3: Workflow transition rules
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveWorkflowTransition — closed ticket rules", () => {
  const closedArgs = {
    orderStatus: "COMPLETED",
    existingStatus: "Closed Resolved",
    cls: "real_ticket",
    subcls: "quality_issue",
    isFugai: true,
    operatorActionRequired: false,
    sellerRepliedAfterLatestBuyer: false,
  };

  it("closed tickets stay closed when seller already replied after latest buyer", () => {
    const result = deriveWorkflowTransition({
      ...closedArgs,
      sellerRepliedAfterLatestBuyer: true,
    });
    assert.equal(result.shouldPreserveClosed, true);
    assert.equal(result.shouldReopen, false);
    assert.equal(result.status, "Closed Resolved"); // preserves existing status
    assert.equal(result.route, "ticket_handling");
    // Ticket still gets written (to update fields like Latest Message At etc.)
    assert.equal(result.shouldWriteTicket, true);
  });

  it("closed tickets reopen for newer unanswered buyer message in COMPLETED scope", () => {
    const result = deriveWorkflowTransition({
      ...closedArgs,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldReopen, true);
    assert.equal(result.shouldPreserveClosed, false);
    assert.equal(result.status, STATUS_AWAITING_CUSTOMER_FORM);
  });

  it("closed tickets do NOT reopen for non-actionable message (greeting_only)", () => {
    const result = deriveWorkflowTransition({
      ...closedArgs,
      cls: "greeting_only",
      subcls: "",
      isFugai: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldReopen, false);
    assert.equal(result.shouldPreserveClosed, true);
  });
});

describe("deriveWorkflowTransition — form received downgrade prevention", () => {
  it("Customer Form Received never downgrades to Awaiting Customer Form", () => {
    // When existing status is FORM_RECEIVED and another quality_issue message comes in
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: STATUS_CUSTOMER_FORM_RECEIVED,
      cls: "real_ticket",
      subcls: "quality_issue",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, STATUS_CUSTOMER_FORM_RECEIVED);
    assert.equal(result.reason, "preserve_form_received");
  });

  it("when no ticket exists, quality issue waits for TicketForm or manual creation", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "real_ticket",
      subcls: "quality_issue",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, null);
    assert.equal(result.shouldCreateTicket, false);
  });
});

describe("deriveWorkflowTransition — deep-scan inclusion alone does not imply ticket mutation", () => {
  it("greeting_only without existing ticket → no mutation", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "greeting_only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.shouldCreateTicket, false);
    assert.equal(result.route, "ignore");
    assert.equal(result.status, null);
  });

  it("information-only without existing ticket → no mutation", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "information-only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.shouldCreateTicket, false);
  });

  it("delivery_request in COMPLETED scope → order_mgmt, no mutation", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "delivery_request",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.route, "order_mgmt");
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.shouldCreateTicket, false);
  });
});

describe("deriveWorkflowTransition — existing ticket status preservation", () => {
  it("preserves existing status for greeting_only on existing ticket", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: STATUS_OPEN,
      cls: "greeting_only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, STATUS_OPEN);
    assert.equal(result.shouldWriteTicket, true);
  });

  it("preserves existing status for information-only on existing ticket", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: STATUS_AWAITING_CUSTOMER_FORM,
      cls: "information-only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, STATUS_AWAITING_CUSTOMER_FORM);
    assert.equal(result.shouldWriteTicket, true);
  });
});

describe("deriveWorkflowTransition — operator_action_required", () => {
  it("operator_action_required recommends manual creation for COMPLETED scope", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "greeting_only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: true,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, null);
    assert.equal(result.shouldCreateTicket, false);
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.route, "ticket_handling");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 4: Needs Reply
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveNeedsReply", () => {
  it("returns false for closed tickets regardless of behavior", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: "Closed Resolved", behavior: "holding_ack", wasSent: false, wasSkipped: false }),
      false
    );
    assert.equal(
      deriveNeedsReply({ workflowStatus: "Closed Unresolved", behavior: "holding_ack", wasSent: false, wasSkipped: false }),
      false
    );
    assert.equal(
      deriveNeedsReply({ workflowStatus: "Closed Resolved", behavior: "form_request", wasSent: false, wasSkipped: false }),
      false
    );
  });

  it("returns false for null workflow status", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: null, behavior: "holding_ack", wasSent: false, wasSkipped: false }),
      false
    );
  });

  it("returns false for informational_ack when active", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "informational_ack", wasSent: true, wasSkipped: false }),
      false
    );
  });

  it("returns true for holding_ack", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "holding_ack", wasSent: true, wasSkipped: false }),
      true
    );
  });

  it("returns false for form_request when wasSent (not skipped)", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "form_request", wasSent: true, wasSkipped: false }),
      false
    );
  });

  it("returns true for form_request when wasSkipped", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "form_request", wasSent: false, wasSkipped: true }),
      true
    );
  });

  it("returns true for form_request when neither sent nor skipped (error/unexpected)", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "form_request", wasSent: false, wasSkipped: false }),
      true
    );
  });

  it("returns true for cancel_fee", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "cancel_fee", wasSent: true, wasSkipped: false }),
      true
    );
  });

  it("returns true for custom", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "custom", wasSent: true, wasSkipped: false }),
      true
    );
  });

  it("returns false for none behavior", () => {
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "none", wasSent: false, wasSkipped: false }),
      false
    );
  });

  it("Needs Reply is a queue flag — true only for active workflow statuses", () => {
    // Closed = false
    assert.equal(
      deriveNeedsReply({ workflowStatus: "Closed Resolved", behavior: "holding_ack", wasSent: false, wasSkipped: false }),
      false
    );
    assert.equal(
      deriveNeedsReply({ workflowStatus: "Closed Unresolved", behavior: "holding_ack", wasSent: false, wasSkipped: false }),
      false
    );
    // Active statuses = can be true
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_OPEN, behavior: "holding_ack", wasSent: true, wasSkipped: false }),
      true
    );
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_AWAITING_CUSTOMER_FORM, behavior: "holding_ack", wasSent: true, wasSkipped: false }),
      true
    );
    assert.equal(
      deriveNeedsReply({ workflowStatus: STATUS_CUSTOMER_FORM_RECEIVED, behavior: "holding_ack", wasSent: true, wasSkipped: false }),
      true
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DoD 5: Regression safety — #50, #46, #49, #41, FUGUAI idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe("Regression — strict ticket creation authority", () => {
  it("actionable message in COMPLETED scope recommends review without creating", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "real_ticket",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldCreateTicket, false);
    assert.equal(result.shouldWriteTicket, false);
    assert.equal(result.route, "ticket_handling");
  });

  it("operator_action_required in COMPLETED scope does not create ticket", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "greeting_only",
      subcls: "",
      isFugai: false,
      operatorActionRequired: true,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldCreateTicket, false);
  });

  it("FUGUAI quality issue waits for TicketForm or manual creation", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "real_ticket",
      subcls: "quality_issue",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.shouldCreateTicket, false);
  });
});

describe("Regression — Issue #46 (KV audit log entries)", () => {
  it("LogEntry type no longer carries ticket_visibility_required", () => {
    // ticket_visibility_required was removed from LogEntry in types.ts,
    // replaced by workflow_route + workflow_reason.
    // This test validates that the new fields exist in the ticket-state
    // workflow transition output.
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "real_ticket",
      subcls: "",
      isFugai: false,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.ok(typeof result.route === "string");
    assert.ok(typeof result.reason === "string");
  });
});

describe("Regression — Issue #49 (needs_reply queue flag)", () => {
  it("closed tickets always return needs_reply=false", () => {
    for (const status of CLOSED_WORKFLOW_STATUSES) {
      assert.equal(
        deriveNeedsReply({ workflowStatus: status, behavior: "holding_ack", wasSent: false, wasSkipped: false }),
        false
      );
      assert.equal(
        deriveNeedsReply({ workflowStatus: status, behavior: "form_request", wasSent: false, wasSkipped: true }),
        false
      );
    }
  });
});

describe("Regression — Issue #41 (status transition hardening)", () => {
  it("non-COMPLETED actionable routes to order_mgmt, not ticket_handling", () => {
    // Issue #41 added status-based routing to prevent mutating tickets
    // for orders not in COMPLETED status.
    const nonCompletedStatuses = [
      "WAITING_FOR_PAYMENT",
      "WAITING_FOR_SHIPMENT",
      "WAITING_FOR_PICKUP",
      "IN_TRANSIT",
      "CANCELED",
    ];
    for (const status of nonCompletedStatuses) {
      const result = deriveWorkflowTransition({
        orderStatus: status,
        existingStatus: null,
        cls: "real_ticket",
        subcls: "quality_issue",
        isFugai: true,
        operatorActionRequired: false,
        sellerRepliedAfterLatestBuyer: false,
      });
      assert.notEqual(result.route, "ticket_handling", `expected ${status} to not route to ticket_handling`);
      assert.equal(result.shouldCreateTicket, false);
    }
  });
});

describe("Regression — FUGUAI idempotency patterns", () => {
  it("detects an existing form URL in thread history", () => {
    assert.equal(
      fuguaiAlreadySent([
        {
          id: "m1",
          createdAt: "2026-06-18T01:00:00Z",
          role: "SELLER",
          message: "Please fill this form: https://tickets.homesbliss.net/forms/after-sales/test-token",
        },
      ]),
      true
    );
  });

  it("FORM_RECEIVED never downgrades to AWAITING_FORM via deriveWorkflowTransition", () => {
    // Simulates: ticket already at FORM_RECEIVED → another quality_issue message
    // arrives → status should stay FORM_RECEIVED.
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: STATUS_CUSTOMER_FORM_RECEIVED,
      cls: "real_ticket",
      subcls: "quality_issue",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, STATUS_CUSTOMER_FORM_RECEIVED);
  });

  it("existing AWAITING_FORM persists (doesn't reopen as Open)", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: STATUS_AWAITING_CUSTOMER_FORM,
      cls: "real_ticket",
      subcls: "quality_issue",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, STATUS_AWAITING_CUSTOMER_FORM);
  });

  it("suspicious with isFugai recommends review without creating", () => {
    const result = deriveWorkflowTransition({
      orderStatus: "COMPLETED",
      existingStatus: null,
      cls: "suspicious",
      subcls: "",
      isFugai: true,
      operatorActionRequired: false,
      sellerRepliedAfterLatestBuyer: false,
    });
    assert.equal(result.status, null);
    assert.equal(result.shouldCreateTicket, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLOSED_WORKFLOW_STATUSES
// ═══════════════════════════════════════════════════════════════════════════

describe("CLOSED_WORKFLOW_STATUSES", () => {
  it("contains only Closed Resolved and Closed Unresolved", () => {
    assert.equal(CLOSED_WORKFLOW_STATUSES.size, 2);
    assert.ok(CLOSED_WORKFLOW_STATUSES.has("Closed Resolved"));
    assert.ok(CLOSED_WORKFLOW_STATUSES.has("Closed Unresolved"));
  });

  it("does not contain Open, Awaiting Customer Form, or Customer Form Received", () => {
    assert.ok(!CLOSED_WORKFLOW_STATUSES.has("Open"));
    assert.ok(!CLOSED_WORKFLOW_STATUSES.has("Awaiting Customer Form"));
    assert.ok(!CLOSED_WORKFLOW_STATUSES.has("Customer Form Received"));
  });
});
