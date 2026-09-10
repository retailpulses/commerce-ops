import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { RunResult } from "../jobs/run-result";
import { MAX_RUN_HISTORY } from "../jobs/run-result";

export interface CompoundCursor {
  inquiryDate: string; // ISO 8601 UTC string
  id: number; // last processed inquiry.id
}

interface JobStateData {
  lockedUntil: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: "ok" | "error" | null;
  /** Legacy single-date cursor. Still read for backward compat; write
   *  applies to compoundCursor exclusively. */
  cursor: string | null;
  lastProcessedRowId: number | null;
  /** Compound (inquiryDate, id) cursor — preferred for lossless pagination. */
  compoundCursor: CompoundCursor | null;
  error: string | null;
  /** Bounded run history (most recent first). Up to `MAX_RUN_HISTORY` entries. */
  runHistory: RunResult[];
  /** Timestamp of the last time lock was blocked (for alert dedup). */
  lastLockBlockedAt: string | null;
  /** Timestamp of the last alert sent (for rate limiting). */
  lastAlertSentAt: string | null;
}

const DEFAULT_STATE: JobStateData = {
  lockedUntil: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastRunStatus: null,
  cursor: null,
  lastProcessedRowId: null,
  compoundCursor: null,
  error: null,
  runHistory: [],
  lastLockBlockedAt: null,
  lastAlertSentAt: null,
};

function getDefaultState(): JobStateData {
  return { ...DEFAULT_STATE };
}

export class JobStateDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async loadState(): Promise<JobStateData> {
    const stored = await this.ctx.storage.get<Partial<JobStateData>>("state");
    if (stored) {
      // Merge stored state over current defaults so new fields added after
      // the stored snapshot (runHistory, compoundCursor, alert timestamps)
      // are always present — prevents undefined.rush() / undefined.push() crashes.
      return { ...getDefaultState(), ...stored };
    }
    return getDefaultState();
  }

  private async saveState(state: JobStateData): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  async acquireLock(ttlMs: number = 300000): Promise<boolean> {
    const state = await this.loadState();

    if (state.lockedUntil) {
      const lockedUntil = new Date(state.lockedUntil).getTime();
      if (lockedUntil > Date.now()) {
        return false;
      }
    }

    state.lockedUntil = new Date(Date.now() + ttlMs).toISOString();
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + ttlMs);
    return true;
  }

  /**
   * Renew an already-held lock by extending its TTL. Does NOT acquire a new
   * lock — the caller must already hold the lock. Used by long-running
   * operations (e.g. replay) that exceed the initial lock TTL.
   */
  async renewLock(ttlMs: number = 300000): Promise<void> {
    const state = await this.loadState();
    state.lockedUntil = new Date(Date.now() + ttlMs).toISOString();
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + ttlMs);
  }

  async releaseLock(): Promise<void> {
    const state = await this.loadState();
    state.lockedUntil = null;
    await this.saveState(state);
    await this.ctx.storage.deleteAlarm();
  }

  async getCursor(): Promise<string | null> {
    const state = await this.loadState();
    return state.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    const state = await this.loadState();
    state.cursor = cursor;
    await this.saveState(state);
  }

  /**
   * Returns the compound cursor if present; otherwise falls back to the legacy
   * single-date cursor with id=0. This ensures one-time backward compatibility
   * without a formal state migration.
   */
  async getCompoundCursor(): Promise<CompoundCursor | null> {
    const state = await this.loadState();
    if (state.compoundCursor) return state.compoundCursor;
    if (state.cursor) {
      return { inquiryDate: state.cursor, id: 0 };
    }
    return null;
  }

  async setCompoundCursor(cursor: CompoundCursor): Promise<void> {
    const state = await this.loadState();
    state.compoundCursor = cursor;
    // Also update legacy fields for admin/debug visibility
    state.cursor = cursor.inquiryDate;
    state.lastProcessedRowId = cursor.id;
    await this.saveState(state);
  }

  async getState(): Promise<JobStateData> {
    return this.loadState();
  }

  /**
   * Prepend a run result to the history, capping at MAX_RUN_HISTORY.
   */
  async appendRunHistory(result: RunResult): Promise<void> {
    const state = await this.loadState();
    state.runHistory.unshift(result);
    if (state.runHistory.length > MAX_RUN_HISTORY) {
      state.runHistory = state.runHistory.slice(0, MAX_RUN_HISTORY);
    }
    await this.saveState(state);
  }

  /**
   * Returns the last N run results.
   */
  async getRecentRunHistory(n: number = 10): Promise<RunResult[]> {
    const state = await this.loadState();
    return state.runHistory.slice(0, n);
  }

  /**
   * Record that the lock was blocked at this time. Returns true if an alert
   * should be sent (first block or last block was > 30 min ago).
   */
  async recordLockBlocked(): Promise<boolean> {
    const state = await this.loadState();
    const now = new Date();
    if (state.lastLockBlockedAt) {
      const last = new Date(state.lastLockBlockedAt);
      if (now.getTime() - last.getTime() < 30 * 60 * 1000) {
        return false; // already alerted within 30 min
      }
    }
    state.lastLockBlockedAt = now.toISOString();
    await this.saveState(state);
    return true;
  }

  /**
   * Rate-limit alerts: returns true if an alert can be sent now
   * (at most one every 5 minutes).
   */
  async trySendAlert(): Promise<boolean> {
    const state = await this.loadState();
    const now = new Date();
    if (state.lastAlertSentAt) {
      const last = new Date(state.lastAlertSentAt);
      if (now.getTime() - last.getTime() < 5 * 60 * 1000) {
        return false;
      }
    }
    state.lastAlertSentAt = now.toISOString();
    await this.saveState(state);
    return true;
  }

  async updateRunMetadata(
    metadata: Partial<
      Pick<
        JobStateData,
        | "lastRunStartedAt"
        | "lastRunFinishedAt"
        | "lastRunStatus"
        | "lastProcessedRowId"
        | "error"
      >
    >,
  ): Promise<void> {
    const state = await this.loadState();
    if (metadata.lastRunStartedAt !== undefined) {
      state.lastRunStartedAt = metadata.lastRunStartedAt;
    }
    if (metadata.lastRunFinishedAt !== undefined) {
      state.lastRunFinishedAt = metadata.lastRunFinishedAt;
    }
    if (metadata.lastRunStatus !== undefined) {
      state.lastRunStatus = metadata.lastRunStatus;
    }
    if (metadata.lastProcessedRowId !== undefined) {
      state.lastProcessedRowId = metadata.lastProcessedRowId;
    }
    if (metadata.error !== undefined) {
      state.error = metadata.error;
    }
    await this.saveState(state);
  }

  async alarm(): Promise<void> {
    const state = await this.loadState();
    state.lockedUntil = null;
    await this.saveState(state);
  }
}

export default { JobStateDO };
