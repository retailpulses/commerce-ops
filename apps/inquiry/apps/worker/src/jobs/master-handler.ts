import type { Env } from "../env";
import {
  getConfig,
  INQUIRY_TYPE_KEYS,
  STATUS_RECEIVED,
} from "../config";
import { createLogger } from "../utils/logger";
import { parseToJST, formatCursorUTC } from "../utils/time";
import { createSupabaseAdapter } from "../adapters/supabase";
import type { CompoundCursor } from "../adapters/supabase";
import { createOpenAIClient } from "../clients/openai";
import { createDeepSeekClient } from "../clients/deepseek";
import { createWeComClient } from "../clients/wecom";
import { classifyByKeywords } from "../domain/classify";
import {
  createRunResult,
  resolveRunStatus,
  addErrorSample,
  type RunResult,
} from "./run-result";

const JOB_STATE_ID = "master-handler";
const LOCK_TTL_MS = 300000;

export interface MasterHandlerOptions {
  dryRun?: boolean;
  inquiryIds?: number[];
  limit?: number;
  forceRegenerate?: boolean;
  /** Skip DO lock acquisition — for use within replay or other callers that
   *  already hold the lock. */
  skipLock?: boolean;
}

function generateRunId(): string {
  return `${JOB_STATE_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runMasterHandler(
  env: Env,
  options?: MasterHandlerOptions,
): Promise<RunResult> {
  const runId = generateRunId();
  const log = createLogger(runId, "master-handler");
  const config = getConfig(env);
  const supabase = createSupabaseAdapter(config.supabase);
  const openai = createOpenAIClient(config);
  const deepseek = createDeepSeekClient(config);
  const wecom = createWeComClient(config.wecom.webhookUrl);
  const jobState = env.JOB_STATE.get(env.JOB_STATE.idFromName(JOB_STATE_ID));

  const dryRun = options?.dryRun ?? config.runtime.dryRun;
  const explicitInquiryIds = options?.inquiryIds ?? undefined;
  const limit = options?.limit ?? config.runtime.maxRowsPerRun;
  const forceRegenerate = options?.forceRegenerate ?? config.runtime.forceRegenerate;
  const writesEnabled = config.runtime.writesEnabled;

  // Initialize structured run result
  const cursorBefore = await jobState.getCompoundCursor();
  const result: RunResult = createRunResult(runId, "master-handler", {
    dryRun,
    cursorBefore,
    window: explicitInquiryIds?.length
      ? { type: "explicit_ids" }
      : { type: "cursor" },
  });

  const skipLock = options?.skipLock ?? false;

  let crashError: string | null = null;

  if (!skipLock) {
    const locked = await jobState.acquireLock(LOCK_TTL_MS);
    if (!locked) {
      log.info("Skipping — lock held by another instance");
      const shouldAlert = await jobState.recordLockBlocked();
      if (shouldAlert) {
        await wecom.sendOperationalAlert({
          title: "Lock blocked — run skipped",
          job: "master-handler",
          runId,
          details: { reason: "lock held by another instance" },
        });
      }
      result.status = "error";
      result.errorSamples = addErrorSample(result.errorSamples, "Lock held by another instance");
      result.finishedAt = new Date().toISOString();
      await jobState.appendRunHistory(result);
      return result;
    }
  }

  try {
    await jobState.updateRunMetadata({
      lastRunStartedAt: new Date().toISOString(),
      lastRunStatus: null,
      error: null,
    });

    let inquiries: Awaited<ReturnType<typeof supabase.fetchInquiries>>;

    if (explicitInquiryIds && explicitInquiryIds.length > 0) {
      log.info("Using explicit inquiry IDs", { count: explicitInquiryIds.length });
      inquiries = await supabase.fetchInquiryByIds(explicitInquiryIds);
      log.info("Fetched inquiries by ID", { count: inquiries.length });
    } else {
      const compoundCursor: CompoundCursor | undefined =
        (await jobState.getCompoundCursor()) ?? undefined;
      if (compoundCursor) {
        log.info("Compound cursor applied", {
          date: compoundCursor.inquiryDate,
          id: compoundCursor.id,
        });
      }

      log.info("Fetching inquiries (status: received)");
      inquiries = await supabase.fetchInquiries(
        STATUS_RECEIVED,
        Math.min(limit, 200),
        undefined,
        compoundCursor,
      );
    }

    result.rowsFetched = inquiries.length;
    log.info("Fetched inquiries", { count: inquiries.length, dryRun, writesEnabled });

    // Sort: inquiry_date asc, then id asc (tiebreaker for equal timestamps)
    inquiries.sort((a, b) => {
      const da = String(a.inquiry_date ?? "");
      const db = String(b.inquiry_date ?? "");
      const dateCmp = da.localeCompare(db);
      if (dateCmp !== 0) return dateCmp;
      return (a.id ?? 0) - (b.id ?? 0);
    });

    let cursorPaused = false; // set on first write failure — stops all further cursor advances

    for (const row of inquiries) {
      const rowId = row.id;

      // --- Status check ---
      if (row.status !== STATUS_RECEIVED) {
        log.info("Skipping — status is not Received", {
          rowId,
          currentStatus: row.status,
        });
        result.skippedByReason["wrong_status"] =
          (result.skippedByReason["wrong_status"] ?? 0) + 1;
        continue;
      }

      // --- Classification ---
      const existingTypeKey = row.inquiry_type;
      const msg = String(row.last_custom_message ?? row.inquiry_body ?? "");
      const payload: Record<string, unknown> = {};

      if (existingTypeKey && !forceRegenerate) {
        log.info("Skipping classification — already classified", {
          rowId,
          existingType: existingTypeKey,
        });
        result.skippedByReason["already_classified"] =
          (result.skippedByReason["already_classified"] ?? 0) + 1;
        result.deduplicated++;
        if (row.automation_status === "new") {
          payload.automation_status = "classified";
        }
      } else {
        let newTypeKey: string = classifyByKeywords(msg);
        if (!newTypeKey) newTypeKey = INQUIRY_TYPE_KEYS["Others"];

        if (newTypeKey === INQUIRY_TYPE_KEYS["Bulk purchase"]) {
          const { isBulk, reason } = await deepseek.confirmBulkPurchase(msg);
          if (!isBulk) {
            log.info("DeepSeek rejected Bulk purchase — reclassifying", {
              rowId,
              reason,
            });
            newTypeKey = INQUIRY_TYPE_KEYS["Others"];
          } else {
            log.info("DeepSeek confirmed Bulk purchase", { rowId, reason });
          }
        }

        if (newTypeKey === INQUIRY_TYPE_KEYS["Others"] && !dryRun) {
          const llmMax = config.runtime.llmMaxCallsPerRun;
          if (result.llmCalls < llmMax) {
            const llmType = await openai.classifyInquiry(msg);
            result.llmCalls++;
            if (llmType && INQUIRY_TYPE_KEYS[llmType] !== undefined) {
              newTypeKey = INQUIRY_TYPE_KEYS[llmType];
              log.info("LLM reclassified from Others", {
                rowId,
                reclassifiedTo: llmType,
              });
            }
          }
        }

        payload.inquiry_type = newTypeKey;
        payload.automation_status = "classified";
      }

      // --- Order ID extraction ---
      const orderIdMatch = msg.match(/\b[A-Za-z0-9]{15,}\b/);
      if (orderIdMatch) {
        payload.order_id = orderIdMatch[0];
      }

      // --- Write phase ---
      if (dryRun) {
        log.info("Dry-run — would write", {
          rowId,
          payload: Object.keys(payload),
        });
        result.deduplicated++; // dry-run counts as would-be-processed
      } else if (!writesEnabled) {
        log.info("Writes disabled — skipping patch", {
          rowId,
          payload: Object.keys(payload),
        });
        result.skippedByReason["writes_disabled"] =
          (result.skippedByReason["writes_disabled"] ?? 0) + 1;
      } else {
        try {
          const hadInquiryPatch = Object.keys(payload).length > 0;

          if (hadInquiryPatch) {
            await supabase.patchInquiry(rowId, payload);
          }

          if (hadInquiryPatch) {
            result.updated++;
          }
        } catch (writeErr) {
          const msg2 = writeErr instanceof Error ? writeErr.message : String(writeErr);
          log.error("Write failed for inquiry", { rowId, error: msg2 });
          result.failed++;
          result.errorSamples = addErrorSample(result.errorSamples, msg2);
          // Pause cursor advancement for the rest of this batch —
          // a failed row means we must not advance past it.
          cursorPaused = true;
          result.processed++;
          if (!explicitInquiryIds && result.processed >= limit) break;
          continue;
        }
      }

      // --- Cursor update (compound) ---
      // Skip cursor updates when:
      //  - using explicit inquiry IDs (replay/manual — would corrupt ingestion cursor)
      //  - cursor advancement was paused due to an earlier write failure
      //  - dry run or writes disabled
      if (!explicitInquiryIds && !cursorPaused) {
        const inqDate = parseToJST(String(row.inquiry_date ?? ""));
        if (!dryRun && writesEnabled && inqDate) {
          const cursorDate = formatCursorUTC(inqDate);
          await jobState.setCompoundCursor({
            inquiryDate: cursorDate,
            id: rowId,
          });
        }
      }
      result.processed++;

      if (!explicitInquiryIds && result.processed >= limit) break;
    }

    // Finalize cursor
    result.cursorAfter = await jobState.getCompoundCursor();
    result.status = resolveRunStatus(result.failed, null);

    log.info("Run complete", {
      status: result.status,
      processed: result.processed,
      rowsFetched: result.rowsFetched,
      updated: result.updated,
      failed: result.failed,
      deduplicated: result.deduplicated,
      llmCalls: result.llmCalls,
      skippedByReason: result.skippedByReason,
    });

    await jobState.updateRunMetadata({
      lastRunFinishedAt: new Date().toISOString(),
      lastRunStatus: result.status === "error" ? "error" : "ok",
      error: result.failed > 0
        ? `${result.failed} write failures`
        : null,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    crashError = message;
    log.error("Run failed", { error: message });
    result.errorSamples = addErrorSample(result.errorSamples, message);
    result.status = resolveRunStatus(result.failed, crashError);
    result.cursorAfter = await jobState.getCompoundCursor();

    await jobState.updateRunMetadata({
      lastRunFinishedAt: new Date().toISOString(),
      lastRunStatus: "error",
      error: message,
    });
  } finally {
    result.finishedAt = new Date().toISOString();

    // Persist structured run result
    await jobState.appendRunHistory(result);

    // Alert on partial failure or crash (rate-limited)
    if (result.status !== "ok") {
      const canAlert = await jobState.trySendAlert();
      if (canAlert) {
        await wecom.sendOperationalAlert({
          title: result.status === "error"
            ? "Pipeline run crashed"
            : "Pipeline run had write failures",
          job: "master-handler",
          runId,
          details: {
            status: result.status,
            processed: result.processed,
            failed: result.failed,
            updated: result.updated,
            error: crashError?.slice(0, 150) ?? result.errorSamples[0] ?? "unknown",
          },
        });
      }
    }

    if (!skipLock) {
      await jobState.releaseLock();
    }
  }

  return result;
}
