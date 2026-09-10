import assert from "node:assert/strict";
import test from "node:test";

import {
  createEgressMetricsCollector,
  decodedJsonByteLength,
} from "../src/lib/egress-metrics.mjs";

test("egress collector separates transport header bytes and decoded JSON bytes", () => {
  const collector = createEgressMetricsCollector({
    workloadId: "build_giga_shipments",
    releaseVersion: "abc123",
  });
  const rows = [{ id: 1, name: "商品" }, { id: 2, name: "B" }];
  collector.recordResponse({
    url: "https://example.supabase.co/rest/v1/sales_orders?select=id",
    status: 200,
    contentLength: "42",
  });
  collector.recordRows({
    resource: "sales_orders",
    rows: rows.length,
    decodedJsonBytes: decodedJsonByteLength(rows),
  });

  const snapshot = collector.snapshot();
  assert.equal(snapshot.workload_id, "build_giga_shipments");
  assert.equal(snapshot.release_version, "abc123");
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.successful_requests, 1);
  assert.equal(snapshot.response_content_length_bytes, 42);
  assert.equal(snapshot.response_content_length_samples, 1);
  assert.equal(snapshot.rows_returned, 2);
  assert.equal(snapshot.decoded_json_bytes, decodedJsonByteLength(rows));
  assert.deepEqual(snapshot.by_resource.sales_orders, {
    requests: 1,
    response_content_length_bytes: 42,
    rows_returned: 2,
    decoded_json_bytes: decodedJsonByteLength(rows),
  });
});

test("egress collector records missing content-length without inventing bytes", () => {
  const collector = createEgressMetricsCollector({ workloadId: "sync_mercari_messages" });
  collector.recordResponse({
    url: "https://example.supabase.co/rest/v1/sales_order_message_state",
    status: 500,
    contentLength: null,
  });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.failed_requests, 1);
  assert.equal(snapshot.response_content_length_bytes, 0);
  assert.equal(snapshot.response_content_length_samples, 0);
});
