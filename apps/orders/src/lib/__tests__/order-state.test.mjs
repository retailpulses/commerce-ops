import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_STATUS,
  RAKUTEN_ORDER_STATUS,
  GIGA_SYNC_STATUS,
  REVIEW_STATUS,
  SHOP_CLOSE_STATUS,
  MERCARI_API_STATUS,
  PIPELINE_STATE,
  getPipelineState,
  isActivePipelineState,
  isTerminalPipelineState,
  PIPELINE_STATE_TRANSITIONS,
  ORDER_STATUS_TRANSITIONS,
  REVIEW_STATUS_TRANSITIONS,
  GIGA_SYNC_STATUS_TRANSITIONS,
  RAKUTEN_ORDER_STATUS_TRANSITIONS,
  PIPELINE_APPROVED_REVIEW_STATUSES,
  BLOCKED_REVIEW_STATUSES,
  TERMINAL_GIGA_SYNC_STATUSES,
  RETRYABLE_GIGA_SYNC_STATUSES,
  readSelectValue,
  statusEquals,
  validateTransition,
  isValidReviewMutation,
} from "../order-state.mjs";

// ============================================================================
// Display constants
// ============================================================================

describe("ORDER_STATUS", () => {
  it("WAITING_FOR_PAYMENT", () => assert.equal(ORDER_STATUS.WAITING_FOR_PAYMENT, "WAITING_FOR_PAYMENT"));
  it("WAITING_FOR_SHIPPING", () => assert.equal(ORDER_STATUS.WAITING_FOR_SHIPPING, "WAITING_FOR_SHIPPING"));
  it("COMPLETED", () => assert.equal(ORDER_STATUS.COMPLETED, "COMPLETED"));
  it("CANCELED", () => assert.equal(ORDER_STATUS.CANCELED, "CANCELED"));
});

describe("RAKUTEN_ORDER_STATUS", () => {
  it("PENDING_CONFIRMATION", () => assert.equal(RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION, "PENDING_CONFIRMATION"));
  it("CONFIRMED", () => assert.equal(RAKUTEN_ORDER_STATUS.CONFIRMED, "CONFIRMED"));
  it("RMS_CONFIRMED", () => assert.equal(RAKUTEN_ORDER_STATUS.RMS_CONFIRMED, "RMS_CONFIRMED"));
  it("CANCELED", () => assert.equal(RAKUTEN_ORDER_STATUS.CANCELED, "CANCELED"));
});

describe("GIGA_SYNC_STATUS", () => {
  it("SYNCED", () => assert.equal(GIGA_SYNC_STATUS.SYNCED, "Synced"));
  it("ALREADY_EXISTS", () => assert.equal(GIGA_SYNC_STATUS.ALREADY_EXISTS, "Already Exists"));
  it("INVALID", () => assert.equal(GIGA_SYNC_STATUS.INVALID, "Invalid"));
  it("ERROR", () => assert.equal(GIGA_SYNC_STATUS.ERROR, "Error"));
  it("ATTEMPTED", () => assert.equal(GIGA_SYNC_STATUS.ATTEMPTED, "Attempted"));
});

describe("REVIEW_STATUS", () => {
  it("PENDING_REVIEW", () => assert.equal(REVIEW_STATUS.PENDING_REVIEW, "Pending Review"));
  it("APPROVED", () => assert.equal(REVIEW_STATUS.APPROVED, "Approved"));
  it("AUTO_APPROVED", () => assert.equal(REVIEW_STATUS.AUTO_APPROVED, "Auto-Approved"));
  it("ON_HOLD", () => assert.equal(REVIEW_STATUS.ON_HOLD, "On Hold"));
  it("CANCELED", () => assert.equal(REVIEW_STATUS.CANCELED, "Canceled"));
});

describe("SHOP_CLOSE_STATUS", () => {
  it("COMPLETED", () => assert.equal(SHOP_CLOSE_STATUS.COMPLETED, "Completed"));
});

describe("MERCARI_API_STATUS", () => {
  it("WAITING_FOR_PAYMENT", () => assert.equal(MERCARI_API_STATUS.WAITING_FOR_PAYMENT, "WAITING_FOR_PAYMENT"));
  it("WAITING_FOR_SHIPPING", () => assert.equal(MERCARI_API_STATUS.WAITING_FOR_SHIPPING, "WAITING_FOR_SHIPPING"));
  it("COMPLETING", () => assert.equal(MERCARI_API_STATUS.COMPLETING, "COMPLETING"));
  it("COMPLETED", () => assert.equal(MERCARI_API_STATUS.COMPLETED, "COMPLETED"));
  it("CANCELING", () => assert.equal(MERCARI_API_STATUS.CANCELING, "CANCELING"));
  it("CANCELED", () => assert.equal(MERCARI_API_STATUS.CANCELED, "CANCELED"));
});

describe("PIPELINE_STATE", () => {
  it("PAYMENT_PENDING", () => assert.equal(PIPELINE_STATE.PAYMENT_PENDING, "PAYMENT_PENDING"));
  it("AWAITING_REVIEW", () => assert.equal(PIPELINE_STATE.AWAITING_REVIEW, "AWAITING_REVIEW"));
  it("READY_TO_SHIP", () => assert.equal(PIPELINE_STATE.READY_TO_SHIP, "READY_TO_SHIP"));
  it("OPERATOR_HOLD", () => assert.equal(PIPELINE_STATE.OPERATOR_HOLD, "OPERATOR_HOLD"));
  it("COMPLETED", () => assert.equal(PIPELINE_STATE.COMPLETED, "COMPLETED"));
  it("CANCELLED", () => assert.equal(PIPELINE_STATE.CANCELLED, "CANCELLED"));
  it("UNKNOWN", () => assert.equal(PIPELINE_STATE.UNKNOWN, "UNKNOWN"));
});

// ============================================================================
// readSelectValue
// ============================================================================

describe("readSelectValue", () => {
  it("null returns empty string", () => assert.equal(readSelectValue(null), ""));
  it("undefined returns empty string", () => assert.equal(readSelectValue(undefined), ""));
  it("plain string returns as-is", () => assert.equal(readSelectValue("Waiting for Payment"), "Waiting for Payment"));
  it("object with .value", () => assert.equal(readSelectValue({ id: 1, value: "Approved" }), "Approved"));
  it("object with .name (no .value)", () => assert.equal(readSelectValue({ id: 1, name: "foo" }), "foo"));
  it("object with .label (no .value or .name)", () => assert.equal(readSelectValue({ id: 1, label: "bar" }), "bar"));
  it("number returns string", () => assert.equal(readSelectValue(42), "42"));
  it("empty object returns empty string", () => assert.equal(readSelectValue({}), ""));
  it("object with null .value falls back to .name", () => assert.equal(readSelectValue({ value: null, name: "baz" }), "baz"));
  it("empty string returns empty string", () => assert.equal(readSelectValue(""), ""));
});

// ============================================================================
// statusEquals
// ============================================================================

describe("statusEquals", () => {
  it("exact match", () => assert.equal(statusEquals("Synced", "Synced"), true));
  it("case-insensitive match", () => assert.equal(statusEquals("synced", "Synced"), true));
  it("case-insensitive match (reversed)", () => assert.equal(statusEquals("Synced", "synced"), true));
  it("whitespace trimmed", () => assert.equal(statusEquals(" Synced ", "Synced"), true));
  it("whitespace trimmed (both)", () => assert.equal(statusEquals("  Synced  ", "  Synced  "), true));
  it("different values", () => assert.equal(statusEquals("Synced", "Error"), false));
  it("null vs string", () => assert.equal(statusEquals(null, "Synced"), false));
  it("undefined vs string", () => assert.equal(statusEquals(undefined, ""), true));
  it("both null", () => assert.equal(statusEquals(null, null), true));
  it("object vs string", () => assert.equal(statusEquals({ value: "Synced" }, "Synced"), true));
  it("object vs object", () => assert.equal(statusEquals({ value: "Synced" }, { value: "synced" }), true));
  it("empty string vs empty string", () => assert.equal(statusEquals("", ""), true));
});

// ============================================================================
// getPipelineState
// ============================================================================

describe("getPipelineState", () => {
  it("WAITING_FOR_PAYMENT → PAYMENT_PENDING", () => {
    assert.equal(getPipelineState("WAITING_FOR_PAYMENT", "Pending Review"), PIPELINE_STATE.PAYMENT_PENDING);
    assert.equal(getPipelineState("WAITING_FOR_PAYMENT", "Approved"), PIPELINE_STATE.PAYMENT_PENDING);
    assert.equal(getPipelineState("WAITING_FOR_PAYMENT", ""), PIPELINE_STATE.PAYMENT_PENDING);
  });

  it("WAITING_FOR_PAYMENT + Canceled → CANCELLED (Canceled wins over lifecycle)", () => {
    assert.equal(getPipelineState("WAITING_FOR_PAYMENT", "Canceled"), PIPELINE_STATE.CANCELLED);
  });

  it("WAITING_FOR_SHIPPING + Pending Review → AWAITING_REVIEW", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "Pending Review"), PIPELINE_STATE.AWAITING_REVIEW);
  });

  it("WAITING_FOR_SHIPPING + Approved → READY_TO_SHIP", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "Approved"), PIPELINE_STATE.READY_TO_SHIP);
  });

  it("WAITING_FOR_SHIPPING + Auto-Approved → READY_TO_SHIP", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "Auto-Approved"), PIPELINE_STATE.READY_TO_SHIP);
  });

  it("WAITING_FOR_SHIPPING + On Hold → OPERATOR_HOLD", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "On Hold"), PIPELINE_STATE.OPERATOR_HOLD);
  });

  it("WAITING_FOR_SHIPPING + Canceled → CANCELLED", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "Canceled"), PIPELINE_STATE.CANCELLED);
  });

  it("WAITING_FOR_SHIPPING + unknown review → UNKNOWN", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", "SomeUnknown"), PIPELINE_STATE.UNKNOWN);
  });

  it("WAITING_FOR_SHIPPING + empty review → UNKNOWN", () => {
    assert.equal(getPipelineState("WAITING_FOR_SHIPPING", ""), PIPELINE_STATE.UNKNOWN);
  });

  it("COMPLETED → COMPLETED (regardless of review)", () => {
    assert.equal(getPipelineState("COMPLETED", "Approved"), PIPELINE_STATE.COMPLETED);
    assert.equal(getPipelineState("COMPLETED", "Pending Review"), PIPELINE_STATE.COMPLETED);
    assert.equal(getPipelineState("COMPLETED", ""), PIPELINE_STATE.COMPLETED);
  });

  it("CANCELED → CANCELLED (regardless of review)", () => {
    assert.equal(getPipelineState("CANCELED", "Approved"), PIPELINE_STATE.CANCELLED);
    assert.equal(getPipelineState("CANCELED", ""), PIPELINE_STATE.CANCELLED);
  });

  it("CANCELING → CANCELLED (transient Mercari state)", () => {
    assert.equal(getPipelineState("CANCELING", "Pending Review"), PIPELINE_STATE.CANCELLED);
    assert.equal(getPipelineState("CANCELING", ""), PIPELINE_STATE.CANCELLED);
  });

  it("unknown order_status → UNKNOWN", () => {
    assert.equal(getPipelineState("SomeUnknown", "Approved"), PIPELINE_STATE.UNKNOWN);
  });

  it("case-insensitive matching", () => {
    assert.equal(getPipelineState("waiting_for_payment", "pending review"), PIPELINE_STATE.PAYMENT_PENDING);
    assert.equal(getPipelineState("waiting_for_shipping", "approved"), PIPELINE_STATE.READY_TO_SHIP);
    assert.equal(getPipelineState("completed", ""), PIPELINE_STATE.COMPLETED);
    assert.equal(getPipelineState("canceled", ""), PIPELINE_STATE.CANCELLED);
  });

  it("object values", () => {
    assert.equal(
      getPipelineState({ value: "WAITING_FOR_SHIPPING" }, { value: "Approved" }),
      PIPELINE_STATE.READY_TO_SHIP,
    );
  });
});

// ============================================================================
// isActivePipelineState / isTerminalPipelineState
// ============================================================================

describe("isActivePipelineState", () => {
  it("PAYMENT_PENDING is active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.PAYMENT_PENDING), true));
  it("AWAITING_REVIEW is active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.AWAITING_REVIEW), true));
  it("READY_TO_SHIP is active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.READY_TO_SHIP), true));
  it("OPERATOR_HOLD is active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.OPERATOR_HOLD), true));
  it("COMPLETED is not active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.COMPLETED), false));
  it("CANCELLED is not active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.CANCELLED), false));
  it("UNKNOWN is not active", () => assert.equal(isActivePipelineState(PIPELINE_STATE.UNKNOWN), false));
});

describe("isTerminalPipelineState", () => {
  it("COMPLETED is terminal", () => assert.equal(isTerminalPipelineState(PIPELINE_STATE.COMPLETED), true));
  it("CANCELLED is terminal", () => assert.equal(isTerminalPipelineState(PIPELINE_STATE.CANCELLED), true));
  it("READY_TO_SHIP is not terminal", () => assert.equal(isTerminalPipelineState(PIPELINE_STATE.READY_TO_SHIP), false));
  it("UNKNOWN is not terminal", () => assert.equal(isTerminalPipelineState(PIPELINE_STATE.UNKNOWN), false));
});

// ============================================================================
// Status sets
// ============================================================================

describe("PIPELINE_APPROVED_REVIEW_STATUSES", () => {
  it("contains Approved", () => assert.equal(PIPELINE_APPROVED_REVIEW_STATUSES.has(REVIEW_STATUS.APPROVED), true));
  it("contains Auto-Approved", () => assert.equal(PIPELINE_APPROVED_REVIEW_STATUSES.has(REVIEW_STATUS.AUTO_APPROVED), true));
  it("does NOT contain Pending Review", () => assert.equal(PIPELINE_APPROVED_REVIEW_STATUSES.has(REVIEW_STATUS.PENDING_REVIEW), false));
});

describe("BLOCKED_REVIEW_STATUSES", () => {
  it("contains Pending Review", () => assert.equal(BLOCKED_REVIEW_STATUSES.has(REVIEW_STATUS.PENDING_REVIEW), true));
  it("contains On Hold", () => assert.equal(BLOCKED_REVIEW_STATUSES.has(REVIEW_STATUS.ON_HOLD), true));
  it("contains Canceled", () => assert.equal(BLOCKED_REVIEW_STATUSES.has(REVIEW_STATUS.CANCELED), true));
  it("does NOT contain Approved", () => assert.equal(BLOCKED_REVIEW_STATUSES.has(REVIEW_STATUS.APPROVED), false));
});

describe("TERMINAL_GIGA_SYNC_STATUSES", () => {
  it("contains Synced", () => assert.equal(TERMINAL_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.SYNCED), true));
  it("contains Already Exists", () => assert.equal(TERMINAL_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.ALREADY_EXISTS), true));
  it("contains Invalid", () => assert.equal(TERMINAL_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.INVALID), true));
  it("does NOT contain Error", () => assert.equal(TERMINAL_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.ERROR), false));
});

describe("RETRYABLE_GIGA_SYNC_STATUSES", () => {
  it("contains Error", () => assert.equal(RETRYABLE_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.ERROR), true));
  it("contains Attempted", () => assert.equal(RETRYABLE_GIGA_SYNC_STATUSES.has(GIGA_SYNC_STATUS.ATTEMPTED), true));
  it("contains empty string", () => assert.equal(RETRYABLE_GIGA_SYNC_STATUSES.has(""), true));
});

// ============================================================================
// Transition maps
// ============================================================================

describe("ORDER_STATUS_TRANSITIONS", () => {
  it("Waiting for Payment → Waiting for Shipping", () => {
    assert.equal(ORDER_STATUS_TRANSITIONS[ORDER_STATUS.WAITING_FOR_PAYMENT].includes(ORDER_STATUS.WAITING_FOR_SHIPPING), true);
  });
  it("Waiting for Payment → Canceled", () => {
    assert.equal(ORDER_STATUS_TRANSITIONS[ORDER_STATUS.WAITING_FOR_PAYMENT].includes(ORDER_STATUS.CANCELED), true);
  });
  it("Completed has no transitions", () => {
    assert.equal(ORDER_STATUS_TRANSITIONS[ORDER_STATUS.COMPLETED].length, 0);
  });
});

describe("REVIEW_STATUS_TRANSITIONS", () => {
  it("Pending Review → Approved", () => {
    assert.equal(REVIEW_STATUS_TRANSITIONS[REVIEW_STATUS.PENDING_REVIEW].includes(REVIEW_STATUS.APPROVED), true);
  });
  it("Auto-Approved → On Hold", () => {
    assert.equal(REVIEW_STATUS_TRANSITIONS[REVIEW_STATUS.AUTO_APPROVED].includes(REVIEW_STATUS.ON_HOLD), true);
  });
  it("Pending Review → Canceled", () => {
    assert.equal(REVIEW_STATUS_TRANSITIONS[REVIEW_STATUS.PENDING_REVIEW].includes(REVIEW_STATUS.CANCELED), true);
  });
  it("Canceled is terminal (no outgoing transitions)", () => {
    assert.equal(REVIEW_STATUS_TRANSITIONS[REVIEW_STATUS.CANCELED].length, 0);
  });
});

describe("GIGA_SYNC_STATUS_TRANSITIONS", () => {
  it("empty → Attempted", () => {
    assert.equal(GIGA_SYNC_STATUS_TRANSITIONS[""].includes(GIGA_SYNC_STATUS.ATTEMPTED), true);
  });
  it("Synced has no transitions", () => {
    assert.equal(GIGA_SYNC_STATUS_TRANSITIONS[GIGA_SYNC_STATUS.SYNCED].length, 0);
  });
});

describe("RAKUTEN_ORDER_STATUS_TRANSITIONS", () => {
  it("PENDING_CONFIRMATION → CONFIRMED", () => {
    assert.equal(RAKUTEN_ORDER_STATUS_TRANSITIONS[RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION].includes(RAKUTEN_ORDER_STATUS.CONFIRMED), true);
  });
});

describe("PIPELINE_STATE_TRANSITIONS", () => {
  it("PAYMENT_PENDING → AWAITING_REVIEW", () => {
    assert.equal(PIPELINE_STATE_TRANSITIONS[PIPELINE_STATE.PAYMENT_PENDING].includes(PIPELINE_STATE.AWAITING_REVIEW), true);
  });
  it("PAYMENT_PENDING → READY_TO_SHIP or CANCELLED", () => {
    assert.equal(PIPELINE_STATE_TRANSITIONS[PIPELINE_STATE.PAYMENT_PENDING].includes(PIPELINE_STATE.READY_TO_SHIP), true);
    assert.equal(PIPELINE_STATE_TRANSITIONS[PIPELINE_STATE.PAYMENT_PENDING].includes(PIPELINE_STATE.CANCELLED), true);
  });
  it("AWAITING_REVIEW → READY_TO_SHIP", () => {
    assert.equal(PIPELINE_STATE_TRANSITIONS[PIPELINE_STATE.AWAITING_REVIEW].includes(PIPELINE_STATE.READY_TO_SHIP), true);
  });
  it("COMPLETED has no transitions", () => {
    assert.equal(PIPELINE_STATE_TRANSITIONS[PIPELINE_STATE.COMPLETED].length, 0);
  });
});

// ============================================================================
// validateTransition
// ============================================================================

// ============================================================================
// isValidReviewMutation
// ============================================================================

describe("isValidReviewMutation", () => {
  it("Pending Review → Approved is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "Approved");
    assert.equal(result.valid, true);
  });

  it("Pending Review → On Hold is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "On Hold");
    assert.equal(result.valid, true);
  });

  it("Auto-Approved → On Hold is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Auto-Approved", "On Hold");
    assert.equal(result.valid, true);
  });

  it("Approved → On Hold is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Approved", "On Hold");
    assert.equal(result.valid, true);
  });

  it("On Hold → Approved is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "On Hold", "Approved");
    assert.equal(result.valid, true);
  });

  it("legacy empty review status can be classified", () => {
    assert.equal(isValidReviewMutation("WAITING_FOR_SHIPPING", "", "Approved").valid, true);
    assert.equal(isValidReviewMutation("WAITING_FOR_SHIPPING", "", "On Hold").valid, true);
  });

  it("legacy empty review status can be cancelled", () => {
    assert.equal(isValidReviewMutation("WAITING_FOR_SHIPPING", "", "Canceled").valid, true);
  });

  it("active review → Canceled is valid", () => {
    assert.equal(isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "Canceled").valid, true);
    assert.equal(isValidReviewMutation("WAITING_FOR_SHIPPING", "Approved", "Canceled").valid, true);
  });

  it("terminal lifecycle rejects mutation", () => {
    const result = isValidReviewMutation("COMPLETED", "On Hold", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("terminal"));
  });

  it("CANCELING order_status blocks review mutation", () => {
    const result = isValidReviewMutation("CANCELING", "Pending Review", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("terminal"));
  });

  it("CANCELED review is terminal — approve is rejected", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Canceled", "Approved");
    assert.equal(result.valid, false);
    assert.equal(result.reason, "terminal_review_canceled");
  });

  it("CANCELED review is terminal — On Hold is rejected", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Canceled", "On Hold");
    assert.equal(result.valid, false);
    assert.equal(result.reason, "terminal_review_canceled");
  });

  it("unknown target rejects", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "Unknown");
    assert.equal(result.valid, false);
  });

  it("same target rejects", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Approved", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("already_in_target"));
  });
});

describe("validateTransition", () => {
  const map = { A: ["B", "C"], B: [] };

  it("valid transition", () => {
    assert.deepEqual(validateTransition(map, "A", "B"), { valid: true });
  });

  it("invalid transition", () => {
    const result = validateTransition(map, "A", "D");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("transition_not_allowed"));
  });

  it("unknown from state", () => {
    const result = validateTransition(map, "X", "B");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("no_transitions_defined_from"));
  });

  it("terminal state has no valid transitions", () => {
    const result = validateTransition(map, "B", "A");
    assert.equal(result.valid, false);
  });
});
