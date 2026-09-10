import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseArgs,
  repairStaleReviewStatuses,
  updateReviewStatusBatch,
} from "../scripts/repair-stale-review-status.mjs";

const client = { type: "supabase", salesOrderTableId: "sales_orders" };

function row(id, orderStatus, reviewStatus = "Pending Review") {
  return { id, order_status: orderStatus, review_status: reviewStatus };
}

function createStatefulDependencies(initialRows) {
  const rows = initialRows.map((value) => ({ ...value }));
  const batchSizes = [];
  return {
    rows,
    batchSizes,
    async listRows(_client, tableName, filters) {
      assert.equal(tableName, "sales_orders");
      const status = Object.entries(filters).find(([key]) => key.endsWith("order_status__single_select_equal"))?.[1];
      const reviewNotEmpty = Object.keys(filters).some((key) => key.endsWith("review_status__not_empty"));
      const reviewEmpty = Object.keys(filters).some((key) => key.endsWith("review_status__empty"));
      assert.equal(reviewNotEmpty || reviewEmpty, true);
      if (reviewEmpty) return rows.filter((value) => value.review_status == null);
      return rows.filter((value) => value.order_status === status && value.review_status != null);
    },
    async updateBatch(_client, batch) {
      batchSizes.push(batch.length);
      for (const candidate of batch) {
        assert.ok(["COMPLETED", "CANCELED"].includes(candidate.order_status));
        assert.notEqual(candidate.review_status, null);
        rows.find((value) => value.id === candidate.id).review_status = null;
      }
      return batch.length;
    },
  };
}

test("defaults to dry-run and performs no updates", async () => {
  const dependencies = createStatefulDependencies([
    row("row-1", "COMPLETED"),
    row("row-2", "CANCELED", "Approved"),
    row("row-3", "WAITING_FOR_SHIPPING"),
  ]);

  const result = await repairStaleReviewStatuses({
    client,
    listRows: dependencies.listRows,
    updateBatch: dependencies.updateBatch,
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "dry_run",
    counts: { completed: 1, canceled: 1, terminal: 2, stale: 2, active_null: 0, updated: 0, batches: 0 },
  });
  assert.deepEqual(dependencies.batchSizes, []);
  assert.equal(dependencies.rows[0].review_status, "Pending Review");
});

test("confirmed repair requires the exact audited count before updating", async () => {
  const dependencies = createStatefulDependencies([row("row-1", "COMPLETED")]);

  await assert.rejects(
    repairStaleReviewStatuses({
      client,
      confirm: true,
      expectedCount: 2,
      listRows: dependencies.listRows,
      updateBatch: dependencies.updateBatch,
    }),
    /expected_count_mismatch/,
  );
  assert.deepEqual(dependencies.batchSizes, []);
});

test("confirmed repair updates only audited terminal rows in bounded batches", async () => {
  const dependencies = createStatefulDependencies([
    row("row-1", "COMPLETED"),
    row("row-2", "COMPLETED", "Approved"),
    row("row-3", "CANCELED", "On Hold"),
    row("row-4", "WAITING_FOR_SHIPPING"),
  ]);

  const result = await repairStaleReviewStatuses({
    client,
    confirm: true,
    expectedCount: 3,
    batchSize: 2,
    listRows: dependencies.listRows,
    updateBatch: dependencies.updateBatch,
  });

  assert.deepEqual(result.counts, {
    completed: 2,
    canceled: 1,
    terminal: 3,
    stale: 3,
    active_null: 0,
    updated: 3,
    batches: 2,
  });
  assert.deepEqual(dependencies.batchSizes, [2, 1]);
  assert.equal(dependencies.rows[3].review_status, "Pending Review");
});

test("confirmed repair is idempotent after stale values are cleared", async () => {
  const dependencies = createStatefulDependencies([
    row("row-1", "COMPLETED"),
    row("row-2", "CANCELED"),
  ]);

  const first = await repairStaleReviewStatuses({
    client,
    confirm: true,
    expectedCount: 2,
    listRows: dependencies.listRows,
    updateBatch: dependencies.updateBatch,
  });
  const second = await repairStaleReviewStatuses({
    client,
    confirm: true,
    expectedCount: 0,
    listRows: dependencies.listRows,
    updateBatch: dependencies.updateBatch,
  });

  assert.equal(first.counts.updated, 2);
  assert.deepEqual(second.counts, {
    completed: 0,
    canceled: 0,
    terminal: 0,
    stale: 0,
    active_null: 0,
    updated: 0,
    batches: 0,
  });
  assert.deepEqual(dependencies.batchSizes, [2]);
});

test("dry-run reports active rows with null review status", async () => {
  const dependencies = createStatefulDependencies([
    row("active-null", "WAITING_FOR_SHIPPING", null),
    row("terminal-null", "COMPLETED", null),
    row("active-reviewed", "WAITING_FOR_PAYMENT"),
  ]);

  const result = await repairStaleReviewStatuses({
    client,
    listRows: dependencies.listRows,
    updateBatch: dependencies.updateBatch,
  });

  assert.equal(result.counts.active_null, 1);
  assert.equal(result.counts.stale, 0);
  assert.deepEqual(dependencies.batchSizes, []);
});

test("Supabase batch update retains terminal and non-null guards", async () => {
  const calls = [];
  const query = {
    update(payload) {
      calls.push(["update", payload]);
      return this;
    },
    in(column, values) {
      calls.push(["in", column, values]);
      return this;
    },
    not(column, operator, value) {
      calls.push(["not", column, operator, value]);
      return this;
    },
    async select(columns) {
      calls.push(["select", columns]);
      return { data: [{ id: "row-1" }], error: null };
    },
  };
  const supabaseClient = {
    ...client,
    supabase: {
      from(tableName) {
        calls.push(["from", tableName]);
        return query;
      },
    },
  };

  assert.equal(await updateReviewStatusBatch(supabaseClient, [row("row-1", "COMPLETED")]), 1);
  assert.deepEqual(calls, [
    ["from", "sales_orders"],
    ["update", { review_status: null }],
    ["in", "id", ["row-1"]],
    ["in", "order_status", ["COMPLETED", "CANCELED"]],
    ["not", "review_status", "is", null],
    ["select", "id"],
  ]);
});

test("CLI parsing requires explicit confirmation and an integer expected count", () => {
  assert.deepEqual(parseArgs([]), {
    confirm: false,
    expectedCount: undefined,
    batchSize: 100,
    envPath: "",
    help: false,
  });
  assert.deepEqual(parseArgs(["--confirm", "--expected-count", "1229", "--batch-size", "50"]), {
    confirm: true,
    expectedCount: 1229,
    batchSize: 50,
    envPath: "",
    help: false,
  });
  assert.throws(() => parseArgs(["--expected-count", "1.5"]), /invalid_expected_count/);
});

test("migration only relaxes nullability and retains default/check definitions", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260715074201_allow_null_terminal_review_status.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /alter column review_status drop not null/i);
  assert.doesNotMatch(migration, /drop constraint|drop default|set default/i);
  assert.match(migration, /Domain: order_management/);
  assert.match(migration, /Hosted write required: yes/);
});
