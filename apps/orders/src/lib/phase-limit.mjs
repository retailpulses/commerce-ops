/**
 * Canonical workload limit contract.
 *   null              -> explicit full accounting (unbounded)
 *   positive integer  -> bounded canary/manual execution
 *   missing/invalid   -> workload-specific safe default
 */
export function resolveCandidateLimit(requested, fallback, safetyCap = Number.POSITIVE_INFINITY) {
  if (requested === null) return Number.POSITIVE_INFINITY;
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), safetyCap);
  }
  return Math.min(fallback, safetyCap);
}
