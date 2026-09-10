/**
 * Centralized review-gate predicate.
 *
 * All pipeline modules that check whether an order has passed the review gate
 * MUST use `isPipelineApprovedReviewStatus()` instead of comparing against
 * literal "Approved" strings. This ensures that adding a new
 * pipeline-eligible status (e.g., "Auto-Approved") only requires a change
 * in ONE place.
 *
 * Used by:
 *   - shipment-projector.mjs   (server-side + client-side filter)
 *   - outbound-sync.mjs        (allowlist builder)
 *   - pipeline-health.mjs      (missing-shipment detection)
 *   - portal/order-list.mjs    ("Active" filter merge)
 *   - worker/index.js          (portal summary counts)
 */

import { OPTION } from "./db.mjs";
import {
  PIPELINE_APPROVED_REVIEW_STATUSES,
  BLOCKED_REVIEW_STATUSES,
  statusEquals,
} from "./order-state.mjs";

/**
 * Set of Baserow single-select option IDs that map to pipeline-approved
 * review statuses. Use these when building server-side `single_select_equal`
 * filters on the sales table.
 */
export const PIPELINE_APPROVED_OPTION_IDS = new Set([
  OPTION.REVIEW_STATUS.APPROVED,
  OPTION.REVIEW_STATUS.AUTO_APPROVED,
]);

/**
 * Set of Baserow single-select option IDs that map to blocked
 * review statuses (need operator attention before projection/sync).
 */
export const BLOCKED_OPTION_IDS = new Set([
  OPTION.REVIEW_STATUS.PENDING_REVIEW,
  OPTION.REVIEW_STATUS.ON_HOLD,
  OPTION.REVIEW_STATUS.CANCELED,
]);

/**
 * Returns true when `value` (the display text or option value of a
 * review_status single-select field) represents a pipeline-approved state.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isPipelineApprovedReviewStatus(value) {
  for (const approved of PIPELINE_APPROVED_REVIEW_STATUSES) {
    if (statusEquals(value, approved)) return true;
  }
  return false;
}

/**
 * Returns true when `value` represents a blocked review status
 * (Pending Review or On Hold) that needs operator attention before
 * the order can proceed through the pipeline.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isBlockedReviewStatus(value) {
  for (const blocked of BLOCKED_REVIEW_STATUSES) {
    if (statusEquals(value, blocked)) return true;
  }
  return false;
}
