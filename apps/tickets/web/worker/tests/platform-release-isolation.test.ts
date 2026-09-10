import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowUrl = new URL("../../../.github/workflows/deploy.yml", import.meta.url);
const workflowAvailable = existsSync(workflowUrl);
const workflow = workflowAvailable ? readFileSync(workflowUrl, "utf8") : "";
const installer = readFileSync(
  new URL("../../../scripts/apply_mercari_ingestion_source_fence.sh", import.meta.url),
  "utf8",
);
const verifier = readFileSync(
  new URL("../../../scripts/verify_platform_isolation_capabilities.sh", import.meta.url),
  "utf8",
);
const amazonInstaller = readFileSync(
  new URL("../../../scripts/apply_amazon_queue_capabilities.sh", import.meta.url),
  "utf8",
);

describe("platform-isolated release gates", {
  skip: workflowAvailable
    ? false
    : "legacy deploy workflows are intentionally omitted from the Phase 1 monorepo snapshot",
}, () => {
  it("does not implicitly push every pending Supabase migration during Worker deployment", () => {
    assert.doesNotMatch(workflow, /db push[^\n]*--include-all/);
    assert.match(workflow, /install_platform_isolation_bundle/);
    assert.match(workflow, /install_rakuten_migrations/);
    assert.match(workflow, /install_amazon_queue_migrations/);
    assert.match(workflow, /SUPABASE_MIGRATION_APPROVED_SHA/);
    assert.match(workflow, /SUPABASE_BACKUP_VERIFIED/);
    assert.match(workflow, /verify_platform_isolation_capabilities\.sh/);
  });

  it("installs and verifies Amazon queue capabilities as an independently approved unit", () => {
    assert.match(amazonInstaller, /20260908182200_amazon_mail_isolated_persistence\.sql/);
    assert.match(amazonInstaller, /20260909011500_amazon_mail_ingestion_v3\.sql/);
    assert.match(amazonInstaller, /20260909024000_amazon_mail_queue_actions\.sql/);
    assert.match(amazonInstaller, /SUPABASE_MIGRATION_APPROVED_SHA/);
    assert.match(amazonInstaller, /SUPABASE_BACKUP_VERIFIED/);
    assert.match(verifier, /transition_amazon_mail_queue_v1/);
    assert.match(verifier, /count_amazon_mail_queue_unread_v1/);
  });

  it("the Mercari installer applies its fence and only conditionally repairs an installed Amazon constraint", () => {
    assert.match(installer, /20260908180000_mercari_inbound_retry_source_fence\.sql/);
    assert.match(installer, /20260908180500_platform_send_finalize_fence\.sql/);
    assert.doesNotMatch(installer, /20260907160000_amazon_zoho_mail_pipeline\.sql/);
    assert.match(installer, /20260908181000_amazon_mercari_constraint_compatibility\.sql/);
    assert.match(installer, /source_scoped/);
    assert.match(installer, /null_bounded/);
  });

  it("blocks production deployment when required hosted capabilities are absent", () => {
    assert.match(verifier, /claim_pending_mercari_webhook_messages\(integer\)/);
    assert.match(verifier, /finalize_platform_operator_message_send/);
    assert.match(verifier, /to_regprocedure/);
    assert.doesNotMatch(verifier, /'public\.[^']+'::regprocedure/);
    assert.match(verifier, /mercari_constraint_compatible/);
    assert.match(verifier, /exit 1/);
  });
});
