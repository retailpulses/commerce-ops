import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseClient } from "../repositories/supabase";
import type { Env } from "../types";

export const TICKETFORM_STAGING_BUCKET = "ticket-attachments";
export const TICKETFORM_STAGING_PREFIX = "customer-submissions";
// Legacy TicketForm tokens can remain active for 30 days. Keep the 45-day
// window while those age out; new tokens use the shorter shared validity.
export const TICKETFORM_STAGING_RETENTION_DAYS = 45;

const PAGE_SIZE = 100;
const MAX_FOLDERS_PER_RUN = 200;
const MAX_DELETIONS_PER_RUN = 100;
const LINK_LOOKUP_BATCH_SIZE = 50;
const UUID_PATH_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StagingStorageEntry {
  id: string | null;
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TicketFormStagingCleanupStore {
  list(prefix: string, offset: number, limit: number): Promise<StagingStorageEntry[]>;
  findLinked(paths: string[]): Promise<Set<string>>;
  remove(paths: string[]): Promise<string[]>;
}

export interface TicketFormStagingCleanupReport {
  retention_days: number;
  cutoff: string;
  folders_scanned: number;
  objects_scanned: number;
  stale_candidates: number;
  linked_excluded: number;
  recent_excluded: number;
  invalid_timestamp_excluded: number;
  deleted: number;
  deleted_paths: string[];
  deletion_limit_reached: boolean;
  errors: string[];
}

interface CleanupOptions {
  now?: Date;
  retentionDays?: number;
  maxFolders?: number;
  maxDeletions?: number;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function linkedPaths(
  store: TicketFormStagingCleanupStore,
  paths: string[],
): Promise<Set<string>> {
  const linked = new Set<string>();
  for (const batch of batches(paths, LINK_LOOKUP_BATCH_SIZE)) {
    const found = await store.findLinked(batch);
    for (const path of found) linked.add(path);
  }
  return linked;
}

/**
 * Removes only old, unlinked TicketForm staging objects. The function never
 * deletes ticket_attachments rows and rechecks linkage immediately before each
 * Storage API removal batch. File bodies are therefore removed through the
 * supported Storage API while finalized evidence remains authoritative.
 */
export async function cleanupAbandonedTicketFormUploads(
  store: TicketFormStagingCleanupStore,
  options: CleanupOptions = {},
): Promise<TicketFormStagingCleanupReport> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? TICKETFORM_STAGING_RETENTION_DAYS;
  const maxFolders = options.maxFolders ?? MAX_FOLDERS_PER_RUN;
  const maxDeletions = options.maxDeletions ?? MAX_DELETIONS_PER_RUN;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const report: TicketFormStagingCleanupReport = {
    retention_days: retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    folders_scanned: 0,
    objects_scanned: 0,
    stale_candidates: 0,
    linked_excluded: 0,
    recent_excluded: 0,
    invalid_timestamp_excluded: 0,
    deleted: 0,
    deleted_paths: [],
    deletion_limit_reached: false,
    errors: [],
  };

  const folders: string[] = [];
  try {
    for (let offset = 0; folders.length < maxFolders; offset += PAGE_SIZE) {
      const entries = await store.list(TICKETFORM_STAGING_PREFIX, offset, PAGE_SIZE);
      for (const entry of entries) {
        if (UUID_PATH_SEGMENT.test(entry.name)) folders.push(entry.name);
        if (folders.length >= maxFolders) break;
      }
      if (entries.length < PAGE_SIZE) break;
    }
  } catch (cause) {
    report.errors.push(`folder_list:${cause instanceof Error ? cause.message : String(cause)}`);
    return report;
  }

  const stalePaths: string[] = [];
  for (const folder of folders) {
    report.folders_scanned += 1;
    const prefix = `${TICKETFORM_STAGING_PREFIX}/${folder}`;
    try {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const entries = await store.list(prefix, offset, PAGE_SIZE);
        for (const entry of entries) {
          // Nested directories and malformed names are not part of the staging
          // contract and are deliberately left for manual review.
          if (!entry.id || entry.name.includes("/")) continue;
          report.objects_scanned += 1;
          const timestamps = [entry.created_at, entry.updated_at]
            .filter((value): value is string => Boolean(value))
            .map((value) => Date.parse(value))
            .filter(Number.isFinite);
          const latestObjectMs = timestamps.length ? Math.max(...timestamps) : Number.NaN;
          if (!Number.isFinite(latestObjectMs)) {
            report.invalid_timestamp_excluded += 1;
          } else if (latestObjectMs > cutoffMs) {
            report.recent_excluded += 1;
          } else {
            stalePaths.push(`${prefix}/${entry.name}`);
          }
        }
        if (entries.length < PAGE_SIZE) break;
      }
    } catch (cause) {
      report.errors.push(`object_list:${prefix}:${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  report.stale_candidates = stalePaths.length;
  if (!stalePaths.length || maxDeletions <= 0) return report;

  try {
    const initiallyLinked = await linkedPaths(store, stalePaths);
    report.linked_excluded += initiallyLinked.size;
    const unlinked = stalePaths.filter((path) => !initiallyLinked.has(path));

    for (const candidateBatch of batches(unlinked, LINK_LOOKUP_BATCH_SIZE)) {
      if (report.deleted >= maxDeletions) break;
      // A second read narrows the finalization race window. The 45-day minimum
      // retention also exceeds the longest legacy token lifetime.
      const recheckedLinked = await store.findLinked(candidateBatch);
      report.linked_excluded += recheckedLinked.size;
      const eligible = candidateBatch.filter((path) => !recheckedLinked.has(path));
      const capacity = maxDeletions - report.deleted;
      if (eligible.length > capacity) report.deletion_limit_reached = true;
      const remaining = eligible.slice(0, capacity);
      if (!remaining.length) continue;
      const deletedPaths = await store.remove(remaining);
      report.deleted_paths.push(...deletedPaths);
      report.deleted += deletedPaths.length;
    }
  } catch (cause) {
    report.errors.push(`cleanup:${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return report;
}

export class SupabaseTicketFormStagingCleanupStore implements TicketFormStagingCleanupStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(prefix: string, offset: number, limit: number): Promise<StagingStorageEntry[]> {
    const { data, error } = await this.supabase.storage
      .from(TICKETFORM_STAGING_BUCKET)
      .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    return (data ?? []).map((entry) => ({
      id: entry.id ?? null,
      name: entry.name,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    }));
  }

  async findLinked(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const { data, error } = await this.supabase
      .from("ticket_attachments")
      .select("storage_path")
      .eq("storage_bucket", TICKETFORM_STAGING_BUCKET)
      .in("storage_path", paths);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((row) => String(row.storage_path)));
  }

  async remove(paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    const { error } = await this.supabase.storage
      .from(TICKETFORM_STAGING_BUCKET)
      .remove(paths);
    if (error) throw new Error(error.message);
    return paths;
  }
}

export async function runTicketFormStagingCleanup(env: Env): Promise<TicketFormStagingCleanupReport> {
  const store = new SupabaseTicketFormStagingCleanupStore(getSupabaseClient(env));
  const report = await cleanupAbandonedTicketFormUploads(store);
  const level = report.errors.length ? "error" : "info";
  console[level](`[TicketFormCleanup] ${JSON.stringify(report)}`);
  return report;
}
