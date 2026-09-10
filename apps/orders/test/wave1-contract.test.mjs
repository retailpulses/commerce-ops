import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createBaserowClient,
  FIELD,
  OPTION,
} from "../src/lib/db.mjs";

const migrationSql = readFileSync(
  new URL("../supabase/migrations/20260710000000_order_mgmt_core.sql", import.meta.url),
  "utf8",
);

const migrationSqlBuyerMessages = readFileSync(
  new URL("../supabase/migrations/20260713000000_add_buyer_message_columns.sql", import.meta.url),
  "utf8",
);

const migrationScript = readFileSync(
  new URL("../scripts/migrate-to-supabase.mjs", import.meta.url),
  "utf8",
);

function tableBlock(tableName) {
  const match = migrationSql.match(new RegExp(`create table if not exists ${tableName} \\(([^;]+)\\);`, "is"));
  return match ? match[1] : "";
}

test("db facade selects Supabase from runtime env, not module-load process env only", () => {
  const client = createBaserowClient({
    DATABASE_BACKEND: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  });

  assert.equal(client.type, "supabase");
  assert.equal(client.salesOrderTableId, "sales_orders");
  assert.equal(client.shipmentOrderTableId, "giga_shipment_projections");
});

test("db facade defaults to Baserow when DATABASE_BACKEND is unset", () => {
  const client = createBaserowClient({
    BASEROW_DATABASE_TOKEN: "test-token",
  });

  assert.equal(client.type, undefined);
  assert.equal(client.salesOrderTableId, 903318);
  assert.equal(client.shipmentOrderTableId, 903319);
});

// Load later migration SQLs that add columns to existing tables
let salesAdditions = migrationSqlBuyerMessages;
try {
  salesAdditions += "\n" + readFileSync(
    new URL("../supabase/migrations/20260804134155_add_confirm_started_at.sql", import.meta.url),
    "utf8",
  );
} catch (_) { /* migration file not present in all branches */ }
try {
  salesAdditions += "\n" + readFileSync(
    new URL("../supabase/migrations/20260831000000_add_component_line_columns.sql", import.meta.url),
    "utf8",
  );
} catch (_) { /* migration file not present in all branches */ }

test("db field constants map to columns created by the Wave 1 + later migrations", () => {
  const sales = tableBlock("sales_orders") + "\n" + salesAdditions;
  const shipment = tableBlock("giga_shipment_projections");

  for (const column of Object.values(FIELD.SALES)) {
    assert.match(sales, new RegExp(`\\b${column}\\b`), `missing sales column: ${column}`);
  }

  for (const column of Object.values(FIELD.RAKUTEN_SALES)) {
    assert.match(sales, new RegExp(`\\b${column}\\b`), `missing Rakuten sales column: ${column}`);
  }

  for (const column of Object.values(FIELD.SHIPMENT)) {
    assert.match(shipment, new RegExp(`\\b${column}\\b`), `missing shipment column: ${column}`);
  }
});

test("buyer message migration extends the canonical durable state table", () => {
  for (const column of ["latest_message_id", "last_checked_at", "last_check_status", "last_check_error"]) {
    assert.match(migrationSqlBuyerMessages, new RegExp(`\\b${column}\\b`), `missing message state column: ${column}`);
  }
});

test("giga sync options include all database check-constraint statuses", () => {
  assert.equal(OPTION.GIGA_SYNC_STATUS.PENDING, "PENDING");
  assert.equal(OPTION.GIGA_SYNC_STATUS.ATTEMPTED, "ATTEMPTED");
  assert.equal(OPTION.GIGA_SYNC_STATUS.SYNCED, "SYNCED");
  assert.equal(OPTION.GIGA_SYNC_STATUS.ALREADY_EXISTS, "ALREADY_EXISTS");
  assert.equal(OPTION.GIGA_SYNC_STATUS.ERROR, "ERROR");
  assert.equal(OPTION.GIGA_SYNC_STATUS.INVALID, "INVALID");
});

test("sales order uniqueness is null-safe for product_name", () => {
  assert.match(
    migrationSql,
    /constraint uq_sales_order_line unique nulls not distinct \(sales_channel, order_id, source_store_id, product_name\)/i,
  );
  assert.doesNotMatch(migrationSql, /ux_sales_order_line[\s\S]+coalesce\(product_name, ''\)/i);
});

test("data migration defaults to dry-run and requires explicit write confirmation", () => {
  assert.match(migrationScript, /"dry-run":\s+\{\s+type:\s+"string",\s+short:\s+"d",\s+default:\s+"true"\s+\}/i);
  assert.match(migrationScript, /parseBooleanOption\(cli\["dry-run"\], true\)/i);
  assert.match(migrationScript, /Refusing to write without --confirm/i);
  assert.match(migrationScript, /--dry-run=false and --confirm/i);
});

test("data migration preserves existing Supabase sales rows by default", () => {
  assert.match(migrationScript, /overwrite-existing-sales/);
  assert.match(migrationScript, /ignoreDuplicates:\s*!overwriteExisting/);
  assert.match(migrationScript, /overwriteExisting:\s*OVERWRITE_EXISTING_SALES/);
});

test("platform account mapping can use existing Supabase account identifiers", () => {
  assert.match(migrationScript, /\.select\("id, seller_account_id, shop_code, platform"\)/i);
  assert.match(migrationScript, /map\.set\(sellerId, row\.id\)/i);
  assert.match(migrationScript, /map\.set\(shopCode, row\.id\)/i);
});

test("OrderMgmt tables grant no anon access", () => {
  assert.doesNotMatch(migrationSql, /grant\s+select\s+on\s+%I\s+to\s+anon/i);
  assert.doesNotMatch(migrationSql, /create policy .* to anon/i);
});

test("operator RLS is read-only; writes must use backend service role", () => {
  assert.match(migrationSql, /on sales_orders for select to authenticated using \(true\)/i);
  assert.doesNotMatch(migrationSql, /for update to authenticated/i);
  assert.doesNotMatch(migrationSql, /for insert to authenticated/i);
  assert.doesNotMatch(migrationSql, /for delete to authenticated/i);
});
