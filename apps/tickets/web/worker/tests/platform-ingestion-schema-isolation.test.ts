import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const correctiveMigration = readFileSync(
  new URL("../../../supabase/migrations/20260908181000_amazon_mercari_constraint_compatibility.sql", import.meta.url),
  "utf8",
);
const mercariMigration = readFileSync(
  new URL("../../../supabase/migrations/20260908180000_mercari_inbound_retry_source_fence.sql", import.meta.url),
  "utf8",
);

describe("platform-aware ingestion persistence", () => {
  it("keeps the Mercari source contract independent of Amazon receipt fields", () => {
    const mercariArm = correctiveMigration.match(
      /source = 'mercari_webhook'([\s\S]*?)\)\s*OR\s*\(\s*source = 'amazon_zoho_mail'/,
    )?.[1];

    assert.ok(mercariArm, "Mercari and Amazon constraint arms must be explicit");
    assert.match(mercariArm, /webhook_received_at IS NOT NULL/);
    assert.doesNotMatch(mercariArm, /source_received_at/);
  });

  it("claims only bounded Mercari webhook retry rows", () => {
    const claimFunction = mercariMigration.match(
      /CREATE OR REPLACE FUNCTION public\.claim_pending_mercari_webhook_messages[\s\S]*?\$\$;/,
    )?.[0];

    assert.ok(claimFunction, "source-scoped Mercari claim RPC must exist");
    assert.match(claimFunction, /WHERE source = 'mercari_webhook'/);
    assert.match(claimFunction, /FOR UPDATE SKIP LOCKED/);
    assert.match(claimFunction, /LIMIT LEAST\(GREATEST\(COALESCE\(claim_limit, 10\), 1\), 100\)/);
    assert.doesNotMatch(mercariMigration, /source_received_at|provider_account_id|amazon_zoho_mail/);
  });
});
