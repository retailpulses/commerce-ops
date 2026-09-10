import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanupAbandonedTicketFormUploads,
  type StagingStorageEntry,
  type TicketFormStagingCleanupStore,
} from "../src/services/ticketFormStagingCleanupService";

const SUBMISSION = "11111111-1111-4111-8111-111111111111";
const PREFIX = `customer-submissions/${SUBMISSION}`;

class FakeCleanupStore implements TicketFormStagingCleanupStore {
  removed: string[] = [];
  linked = new Set<string>();
  linkChecks = 0;

  constructor(private readonly objects: StagingStorageEntry[]) {}

  async list(prefix: string, offset: number, limit: number): Promise<StagingStorageEntry[]> {
    const entries = prefix === "customer-submissions"
      ? [{ id: null, name: SUBMISSION }]
      : prefix === PREFIX ? this.objects : [];
    return entries.slice(offset, offset + limit);
  }

  async findLinked(paths: string[]): Promise<Set<string>> {
    this.linkChecks += 1;
    return new Set(paths.filter((path) => this.linked.has(path)));
  }

  async remove(paths: string[]): Promise<string[]> {
    this.removed.push(...paths);
    return paths;
  }
}

describe("TicketForm abandoned staging cleanup", () => {
  it("deletes stale unlinked objects while preserving linked and recent evidence", async () => {
    const store = new FakeCleanupStore([
      { id: "object-1", name: "abandoned.mp4", created_at: "2025-11-01T00:00:00.000Z" },
      { id: "object-2", name: "finalized.jpg", created_at: "2025-11-01T00:00:00.000Z" },
      { id: "object-3", name: "recent.mp4", created_at: "2026-01-20T00:00:00.000Z" },
    ]);
    store.linked.add(`${PREFIX}/finalized.jpg`);

    const report = await cleanupAbandonedTicketFormUploads(store, {
      now: new Date("2026-02-01T00:00:00.000Z"),
      retentionDays: 45,
    });

    assert.deepEqual(store.removed, [`${PREFIX}/abandoned.mp4`]);
    assert.equal(report.deleted, 1);
    assert.deepEqual(report.deleted_paths, [`${PREFIX}/abandoned.mp4`]);
    assert.equal(report.linked_excluded, 1);
    assert.equal(report.recent_excluded, 1);
    assert.equal(report.stale_candidates, 2);
    assert.equal(store.linkChecks, 2, "linkage must be checked again immediately before removal");
  });

  it("excludes evidence that becomes linked during the final linkage recheck", async () => {
    const path = `${PREFIX}/racing.mp4`;
    const store = new FakeCleanupStore([
      { id: "object-1", name: "racing.mp4", created_at: "2025-01-01T00:00:00.000Z" },
    ]);
    const originalFindLinked = store.findLinked.bind(store);
    store.findLinked = async (paths: string[]) => {
      if (store.linkChecks === 1) store.linked.add(path);
      return originalFindLinked(paths);
    };

    const report = await cleanupAbandonedTicketFormUploads(store, {
      now: new Date("2026-02-01T00:00:00.000Z"),
      retentionDays: 45,
    });

    assert.deepEqual(store.removed, []);
    assert.equal(report.deleted, 0);
    assert.equal(report.linked_excluded, 1);
  });

  it("keeps objects with missing timestamps for manual review", async () => {
    const store = new FakeCleanupStore([{ id: "object-1", name: "unknown.mp4" }]);
    const report = await cleanupAbandonedTicketFormUploads(store, {
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    assert.deepEqual(store.removed, []);
    assert.equal(report.invalid_timestamp_excluded, 1);
  });
});
