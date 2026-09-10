/**
 * Centralized order state definitions and utilities.
 *
 * This module is the single source of truth for all status display values,
 * composite pipeline states, transition documentation, and shared status
 * comparison helpers.
 *
 * IMPORTANT:
 * - Display constants are NOT Baserow single-select option IDs.
 *   Continue using `BASEROW_OPTION.*` from `baserow.mjs` for server-side
 *   `single_select_equal` / `single_select_not_equal` filters.
 * - The composite `PIPELINE_STATE` derives from `order_status` + `review_status`
 *   on Mercari sales rows. It does NOT replace the underlying Baserow columns.
 * - Rakuten has its own lifecycle; do not force Rakuten rows into Mercari
 *   `PIPELINE_STATE`.
 *
 * Used by:
 *   - review-gate.mjs         (pipeline-approved / blocked predicates)
 *   - outbound-sync.mjs       (giga sync status lifecycle)
 *   - pipeline-health.mjs     (health snapshot)
 *   - tracking-reconciler.mjs (tracking reconciliation)
 *   - cancellation-reconciler.mjs (cancel detection)
 *   - shipment-projector.mjs  (projection eligibility)
 *   - auto-approval.mjs       (auto-approval rules)
 *   - portal/order-list.mjs   (portal rendering)
 *   - product-resolver.mjs    (risk badges)
 *   - worker/index.js         (portal endpoints, tracking backlog)
 */

// ============================================================================
// DISPLAY VALUE CONSTANTS
// ============================================================================

/** Mercari sales order_status display values (Baserow table 903318). */
export const ORDER_STATUS = Object.freeze({
  WAITING_FOR_PAYMENT: "WAITING_FOR_PAYMENT",
  WAITING_FOR_SHIPPING: "WAITING_FOR_SHIPPING",
  COMPLETED: "COMPLETED",
  CANCELED: "CANCELED",
});

/** Rakuten sales order_status display values (Baserow table 1015675). */
export const RAKUTEN_ORDER_STATUS = Object.freeze({
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  CONFIRMED: "CONFIRMED",
  RMS_CONFIRMED: "RMS_CONFIRMED",
  CANCELED: "CANCELED",
});

/**
 * Giga shipment giga_sync_status display values (Baserow table 903319).
 *
 * NOTE: "Attempted" currently has NO Baserow single-select option ID.
 * It is written as a display value via `user_field_names=true` in
 * outbound-sync.mjs before the Giga API call. Do NOT use ATTEMPTED in
 * `single_select_equal` / `single_select_not_equal` Baserow filters
 * until a corresponding option ID exists in BASEROW_OPTION.GIGA_SYNC_STATUS.
 */
export const GIGA_SYNC_STATUS = Object.freeze({
  SYNCED: "Synced",
  ALREADY_EXISTS: "Already Exists",
  INVALID: "Invalid",
  ERROR: "Error",
  ATTEMPTED: "Attempted",
});

/** Mercari sales review_status display values (Baserow table 903318). */
export const REVIEW_STATUS = Object.freeze({
  PENDING_REVIEW: "Pending Review",
  APPROVED: "Approved",
  AUTO_APPROVED: "Auto-Approved",
  ON_HOLD: "On Hold",
  CANCELED: "Canceled",
});

/** Shop close status values (free-text field on Mercari sales table). */
export const SHOP_CLOSE_STATUS = Object.freeze({
  COMPLETED: "Completed",
});

/**
 * Mercari GraphQL API order transaction statuses.
 * These come from the Mercari Shop API, not from Baserow.
 * Some values (e.g. CANCELING, COMPLETING) are transient Mercari states
 * that may not appear as final Baserow order_status values.
 */
export const MERCARI_API_STATUS = Object.freeze({
  WAITING_FOR_PAYMENT: "WAITING_FOR_PAYMENT",
  WAITING_FOR_SHIPPING: "WAITING_FOR_SHIPPING",
  COMPLETING: "COMPLETING",
  COMPLETED: "COMPLETED",
  CANCELING: "CANCELING",
  CANCELED: "CANCELED",
});

// ============================================================================
// COMPOSITE PIPELINE STATE (Mercari order_status × review_status)
// ============================================================================

/**
 * Derived pipeline state enum for Mercari sales rows.
 *
 * Computed from the combination of `order_status` and `review_status`.
 * This is a READ-ONLY derivation — it does not replace the underlying
 * Baserow columns, which remain independently owned by their respective
 * pipeline phases.
 */
export const PIPELINE_STATE = Object.freeze({
  PAYMENT_PENDING: "PAYMENT_PENDING",
  AWAITING_REVIEW: "AWAITING_REVIEW",
  READY_TO_SHIP: "READY_TO_SHIP",
  OPERATOR_HOLD: "OPERATOR_HOLD",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

/**
 * Returns the derived pipeline state for a Mercari sales row.
 *
 * @param {*} orderStatus - raw `order_status` field value from Baserow
 * @param {*} reviewStatus - raw `review_status` field value from Baserow
 * @returns {string} one of PIPELINE_STATE.* values
 */
export function getPipelineState(orderStatus, reviewStatus) {
  const os = readSelectValue(orderStatus);
  const rs = readSelectValue(reviewStatus);

  // Operator-owned terminal review status takes precedence over the ingest-owned
  // lifecycle: a locally-cancelled order is CANCELLED even while it is still
  // WAITING_FOR_PAYMENT / WAITING_FOR_SHIPPING, so it is never counted as active
  // and never re-approved.
  if (statusEquals(rs, REVIEW_STATUS.CANCELED)) {
    return PIPELINE_STATE.CANCELLED;
  }

  if (statusEquals(os, ORDER_STATUS.WAITING_FOR_PAYMENT)) {
    return PIPELINE_STATE.PAYMENT_PENDING;
  }

  if (statusEquals(os, ORDER_STATUS.WAITING_FOR_SHIPPING)) {
    if (statusEquals(rs, REVIEW_STATUS.PENDING_REVIEW)) return PIPELINE_STATE.AWAITING_REVIEW;
    if (statusEquals(rs, REVIEW_STATUS.APPROVED)) return PIPELINE_STATE.READY_TO_SHIP;
    if (statusEquals(rs, REVIEW_STATUS.AUTO_APPROVED)) return PIPELINE_STATE.READY_TO_SHIP;
    if (statusEquals(rs, REVIEW_STATUS.ON_HOLD)) return PIPELINE_STATE.OPERATOR_HOLD;
    return PIPELINE_STATE.UNKNOWN;
  }

  if (statusEquals(os, ORDER_STATUS.COMPLETED)) {
    return PIPELINE_STATE.COMPLETED;
  }

  if (statusEquals(os, ORDER_STATUS.CANCELED) || statusEquals(os, MERCARI_API_STATUS.CANCELING)) {
    return PIPELINE_STATE.CANCELLED;
  }

  return PIPELINE_STATE.UNKNOWN;
}

/**
 * Returns true when `state` is a non-terminal pipeline state (orders still
 * moving through the active pipeline).
 *
 * @param {string} state - a PIPELINE_STATE value
 * @returns {boolean}
 */
export function isActivePipelineState(state) {
  return (
    state === PIPELINE_STATE.PAYMENT_PENDING ||
    state === PIPELINE_STATE.AWAITING_REVIEW ||
    state === PIPELINE_STATE.READY_TO_SHIP ||
    state === PIPELINE_STATE.OPERATOR_HOLD
  );
}

/**
 * Returns true when `state` is a terminal pipeline state.
 *
 * @param {string} state - a PIPELINE_STATE value
 * @returns {boolean}
 */
export function isTerminalPipelineState(state) {
  return (
    state === PIPELINE_STATE.COMPLETED ||
    state === PIPELINE_STATE.CANCELLED
  );
}

// ============================================================================
// STATUS SETS
// ============================================================================

/** Review statuses that pass the review gate (eligible for projection/sync). */
export const PIPELINE_APPROVED_REVIEW_STATUSES = Object.freeze(new Set([
  REVIEW_STATUS.APPROVED,
  REVIEW_STATUS.AUTO_APPROVED,
]));

/** Review statuses that block pipeline progress (need operator attention). */
export const BLOCKED_REVIEW_STATUSES = Object.freeze(new Set([
  REVIEW_STATUS.PENDING_REVIEW,
  REVIEW_STATUS.ON_HOLD,
  REVIEW_STATUS.CANCELED,
]));

/** Giga sync statuses that are terminal (no further processing expected). */
export const TERMINAL_GIGA_SYNC_STATUSES = Object.freeze(new Set([
  GIGA_SYNC_STATUS.SYNCED,
  GIGA_SYNC_STATUS.ALREADY_EXISTS,
  GIGA_SYNC_STATUS.INVALID,
]));

/** Giga sync statuses that are safe to retry in the outbound sync phase. */
export const RETRYABLE_GIGA_SYNC_STATUSES = Object.freeze(new Set([
  GIGA_SYNC_STATUS.ERROR,
  GIGA_SYNC_STATUS.ATTEMPTED,
  // empty string represents rows that have never been attempted
  "",
]));

// ============================================================================
// STATE MACHINE TRANSITION MAPS (documentation-first; not enforced at write time)
// ============================================================================

/** Allowed transitions for Mercari `order_status`. */
export const ORDER_STATUS_TRANSITIONS = Object.freeze({
  [ORDER_STATUS.WAITING_FOR_PAYMENT]: [ORDER_STATUS.WAITING_FOR_SHIPPING, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.WAITING_FOR_SHIPPING]: [ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.CANCELED]: [],
});

/** Allowed transitions for Mercari `review_status`. */
export const REVIEW_STATUS_TRANSITIONS = Object.freeze({
  [REVIEW_STATUS.PENDING_REVIEW]: [
    REVIEW_STATUS.APPROVED,
    REVIEW_STATUS.ON_HOLD,
    REVIEW_STATUS.AUTO_APPROVED,
    REVIEW_STATUS.CANCELED,
  ],
  [REVIEW_STATUS.APPROVED]: [REVIEW_STATUS.PENDING_REVIEW, REVIEW_STATUS.ON_HOLD, REVIEW_STATUS.CANCELED],
  [REVIEW_STATUS.ON_HOLD]: [REVIEW_STATUS.PENDING_REVIEW, REVIEW_STATUS.APPROVED, REVIEW_STATUS.CANCELED],
  [REVIEW_STATUS.AUTO_APPROVED]: [REVIEW_STATUS.ON_HOLD, REVIEW_STATUS.CANCELED],
  [REVIEW_STATUS.CANCELED]: [],
});

/** Allowed transitions for Giga shipment `giga_sync_status`. */
export const GIGA_SYNC_STATUS_TRANSITIONS = Object.freeze({
  "": [GIGA_SYNC_STATUS.ATTEMPTED],
  [GIGA_SYNC_STATUS.ATTEMPTED]: [
    GIGA_SYNC_STATUS.SYNCED,
    GIGA_SYNC_STATUS.ALREADY_EXISTS,
    GIGA_SYNC_STATUS.ERROR,
    GIGA_SYNC_STATUS.INVALID,
  ],
  [GIGA_SYNC_STATUS.SYNCED]: [],
  [GIGA_SYNC_STATUS.ALREADY_EXISTS]: [],
  [GIGA_SYNC_STATUS.ERROR]: [GIGA_SYNC_STATUS.ATTEMPTED],
  [GIGA_SYNC_STATUS.INVALID]: [],
});

/** Allowed transitions for Rakuten `order_status`. */
export const RAKUTEN_ORDER_STATUS_TRANSITIONS = Object.freeze({
  [RAKUTEN_ORDER_STATUS.PENDING_CONFIRMATION]: [RAKUTEN_ORDER_STATUS.CONFIRMED],
  [RAKUTEN_ORDER_STATUS.CONFIRMED]: [RAKUTEN_ORDER_STATUS.RMS_CONFIRMED],
  [RAKUTEN_ORDER_STATUS.RMS_CONFIRMED]: [],
  [RAKUTEN_ORDER_STATUS.CANCELED]: [],
});

/** Allowed transitions between composite pipeline states. */
export const PIPELINE_STATE_TRANSITIONS = Object.freeze({
  [PIPELINE_STATE.PAYMENT_PENDING]: [
    PIPELINE_STATE.AWAITING_REVIEW,
    PIPELINE_STATE.READY_TO_SHIP,
    PIPELINE_STATE.CANCELLED,
  ],
  [PIPELINE_STATE.AWAITING_REVIEW]: [
    PIPELINE_STATE.READY_TO_SHIP,
    PIPELINE_STATE.OPERATOR_HOLD,
  ],
  [PIPELINE_STATE.READY_TO_SHIP]: [
    PIPELINE_STATE.AWAITING_REVIEW,
    PIPELINE_STATE.OPERATOR_HOLD,
    PIPELINE_STATE.COMPLETED,
    PIPELINE_STATE.CANCELLED,
  ],
  [PIPELINE_STATE.OPERATOR_HOLD]: [
    PIPELINE_STATE.AWAITING_REVIEW,
    PIPELINE_STATE.READY_TO_SHIP,
    PIPELINE_STATE.COMPLETED,
    PIPELINE_STATE.CANCELLED,
  ],
  [PIPELINE_STATE.COMPLETED]: [],
  [PIPELINE_STATE.CANCELLED]: [],
  [PIPELINE_STATE.UNKNOWN]: [],
});

// ============================================================================
// SHARED UTILITIES
// ============================================================================

/**
 * Extract the display value from a Baserow single-select field response.
 *
 * Baserow returns `{ id, value, color }` objects for single-select fields
 * when `user_field_names=true`. This helper normalises all the shapes the
 * codebase has historically received into a plain string.
 *
 * Fallback order: `.value` → `.name` → `.label` → empty string.
 *
 * @param {*} value - raw field value from Baserow
 * @returns {string} display value, or "" for null/undefined/empty
 */
export function readSelectValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return String(value.value ?? value.name ?? value.label ?? "").trim();
  }
  return String(value).trim();
}

/**
 * Null-safe, trim-safe, case-insensitive status comparison.
 *
 * Use this for ALL status comparisons instead of `===` or `.toLowerCase()`.
 * It handles the Baserow single-select object shape automatically.
 *
 * @param {*} actual - raw value read from Baserow (string, object, null, etc.)
 * @param {*} expected - expected display value (string or constant)
 * @returns {boolean}
 */
export function statusEquals(actual, expected) {
  return readSelectValue(actual).trim().toLowerCase() === readSelectValue(expected).trim().toLowerCase();
}

/**
 * Check whether a status transition is valid according to a transition map.
 *
 * @param {Object} transitionMap - e.g. ORDER_STATUS_TRANSITIONS
 * @param {string} from - current display value
 * @param {string} to - target display value
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTransition(transitionMap, from, to) {
  const allowed = transitionMap[from];
  if (!allowed) {
    return { valid: false, reason: `no_transitions_defined_from:${from}` };
  }
  if (allowed.includes(to)) {
    return { valid: true };
  }
  return { valid: false, reason: `transition_not_allowed:${from}->${to}` };
}

/**
 * Returns true when the review mutation from currentReview to targetReview
 * is valid for the given order lifecycle.
 *
 * Enforces:
 * - Terminal lifecycle orders cannot be mutated.
 * - Auto-Approved → On Hold / Pending Review is allowed.
 * - All other transitions must be in REVIEW_STATUS_TRANSITIONS.
 *
 * @param {string} currentOrderStatus - current order_status value
 * @param {string} currentReview - current review_status value
 * @param {string} targetReview - target review_status value
 * @returns {{ valid: boolean, reason?: string }}
 */
export function isValidReviewMutation(currentOrderStatus, currentReview, targetReview) {
  const os = readSelectValue(currentOrderStatus);
  const rs = readSelectValue(currentReview);
  const ts = readSelectValue(targetReview);

  if (!ts) {
    return { valid: false, reason: "target_review_empty" };
  }

  if (
    statusEquals(os, ORDER_STATUS.COMPLETED)
    || statusEquals(os, ORDER_STATUS.CANCELED)
    || statusEquals(os, MERCARI_API_STATUS.CANCELING)
  ) {
    return { valid: false, reason: "terminal_lifecycle" };
  }

  // CANCELED is a terminal review status — no review mutation may leave it.
  if (statusEquals(rs, REVIEW_STATUS.CANCELED)) {
    return { valid: false, reason: "terminal_review_canceled" };
  }

  if (statusEquals(rs, ts)) {
    return { valid: false, reason: "already_in_target_state" };
  }

  // Legacy rows can have no review status. Preserve the portal's existing
  // ability to classify them explicitly instead of making them uneditable.
  if (!rs && (
    statusEquals(ts, REVIEW_STATUS.APPROVED)
    || statusEquals(ts, REVIEW_STATUS.ON_HOLD)
    || statusEquals(ts, REVIEW_STATUS.CANCELED)
  )) {
    return { valid: true };
  }

  if (!REVIEW_STATUS_TRANSITIONS[rs]) {
    return { valid: false, reason: `no_transitions_defined_from:${rs}` };
  }

  if (REVIEW_STATUS_TRANSITIONS[rs].some((allowed) => statusEquals(allowed, ts))) {
    return { valid: true };
  }

  return { valid: false, reason: `transition_not_allowed:${rs}->${ts}` };
}
