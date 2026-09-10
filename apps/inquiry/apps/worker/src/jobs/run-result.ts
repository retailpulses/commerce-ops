/**
 * Structured, durable run result for ingestion and automation jobs.
 *
 * Used by master-handler to report deterministic counters and failure
 * semantics. Also persisted in DO state for
 * authenticated status inspection without Cloudflare log access.
 */

export interface RunResult {
  /** Unique run identifier (correlation ID). */
  runId: string;
  /** Job name, currently "master-handler". */
  job: string;
  /** Integration source, e.g. "zoho". */
  integration: string;
  /** UTC ISO 8601 start timestamp. */
  startedAt: string;
  /** UTC ISO 8601 end timestamp (set on completion). */
  finishedAt: string | null;
  /** Aggregate outcome: "ok" | "error" | "partial_failure". */
  status: "ok" | "error" | "partial_failure";
  /** Cursor value before this run (for audit/replay). */
  cursorBefore: { inquiryDate: string; id: number } | null;
  /** Cursor value after this run. */
  cursorAfter: { inquiryDate: string; id: number } | null;
  /** Total rows fetched from the datastore. */
  rowsFetched: number;
  /** Rows that were processed (classified, linked, or drafted). */
  processed: number;
  /** New writes (created). */
  created: number;
  /** Existing rows updated. */
  updated: number;
  /** Skipped because already present (deduplication). */
  deduplicated: number;
  /** Breakdown of skip reasons → count. */
  skippedByReason: Record<string, number>;
  /** Count of write failures in this run. */
  failed: number;
  /** Bounded error samples (first 5 error messages). */
  errorSamples: string[];
  /** Window parameters used for this run. */
  window: {
    type: "cursor" | "explicit_ids" | "replay";
    sinceHours?: number;
    maxPages?: number;
  };
  /** Page number within this window (for multi-page replay). */
  page: number;
  /** Total pages consumed in this window (for paginated replay). */
  totalPages: number;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** LLM API calls consumed. */
  llmCalls: number;
}

export function createRunResult(
  runId: string,
  job: string,
  overrides?: Partial<RunResult>,
): RunResult {
  return {
    runId,
    job,
    integration: "zoho",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "ok",
    cursorBefore: null,
    cursorAfter: null,
    rowsFetched: 0,
    processed: 0,
    created: 0,
    updated: 0,
    deduplicated: 0,
    skippedByReason: {},
    failed: 0,
    errorSamples: [],
    window: { type: "cursor" },
    page: 1,
    totalPages: 1,
    dryRun: false,
    llmCalls: 0,
    ...overrides,
  };
}

/** Maximum error samples to retain per run. */
export const MAX_ERROR_SAMPLES = 5;

/** Maximum run history entries to persist in DO state. */
export const MAX_RUN_HISTORY = 20;

/**
 * Returns `"partial_failure"` when any write failed but the run itself
 * completed; `"error"` when the run crashed; `"ok"` otherwise.
 */
export function resolveRunStatus(
  failed: number,
  crashError: string | null,
): RunResult["status"] {
  if (crashError) return "error";
  if (failed > 0) return "partial_failure";
  return "ok";
}

/**
 * Add an error sample, bounded to `MAX_ERROR_SAMPLES`.
 */
export function addErrorSample(samples: string[], message: string): string[] {
  if (samples.length >= MAX_ERROR_SAMPLES) return samples;
  return [...samples, message.slice(0, 200)];
}
