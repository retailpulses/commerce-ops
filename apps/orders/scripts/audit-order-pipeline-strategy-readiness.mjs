#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CANARY_CAPABILITY_MATRIX, ORDER_PIPELINE_DAG } from "../src/orchestrator.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_MIGRATIONS = Object.freeze([
  "20260907090000_add_lifecycle_freshness_watermarks.sql",
  "20260907100000_add_orchestrator_control_plane.sql",
  "20260907110000_add_external_operation_ledger.sql",
  "20260907151000_add_external_operation_resolution.sql",
  "20260907152000_allow_evidence_to_override_operation_failure.sql",
  "20260907153000_add_atomic_rakuten_close_completion.sql",
  "20260907154000_add_atomic_mercari_close_completion.sql",
  "20260907155000_add_scheduler_ownership_registry.sql",
]);

export const REQUIRED_ASSETS = Object.freeze([
  "deploy/systemd/order-mgmt-orchestrator.service",
  "deploy/systemd/order-mgmt-orchestrator.timer",
  "deploy/systemd/pipeline.env",
  "deploy/systemd/order-mgmt-sales-brief.service",
  "deploy/systemd/order-mgmt-sales-brief.timer",
  "scripts/audit-orchestrator-shadow-parity.mjs",
  "scripts/verify-orchestrator-shadow-run.mjs",
  "scripts/verify-workload-quiescence.mjs",
  "scripts/record-scheduler-ownership.mjs",
  "scripts/resolve-external-operation.mjs",
]);

export const CANONICAL_DOCS = Object.freeze([
  "CLAUDE.md",
  "README.md",
  "deploy/README.md",
  "docs/00_CURRENT_STATE.md",
  "docs/05_DECISION_LOG.md",
  "docs/15_DEPLOYMENT_AND_HOUSEKEEPING.md",
  "docs/16_DATABASE_GOVERNANCE.md",
  "docs/16_DATABASE_GOVERNANCE.local.md",
  "docs/17_SYNC_WORKLOAD_GOVERNANCE.md",
  "docs/SYNC_JOB_INVENTORY.md",
  "docs/deployment.md",
  "docs/operations.md",
  "docs/plans/order-pipeline-first-tranche-rollout.md",
  "docs/trd/platform-order-status-reconciliation.md",
  "docs/trd/order-pipeline-orchestration-strategy.md",
  "docs/vps-relay.md",
]);

const TARGET_DEPLOYED_BOUNDARY_DOCS = new Set([
  "CLAUDE.md",
  "README.md",
  "deploy/README.md",
  "docs/00_CURRENT_STATE.md",
  "docs/SYNC_JOB_INVENTORY.md",
  "docs/plans/order-pipeline-first-tranche-rollout.md",
  "docs/trd/order-pipeline-orchestration-strategy.md",
]);

export const EXTERNAL_EVIDENCE_GATES = Object.freeze([
  "hosted_migrations_and_readback",
  "immutable_vps_install",
  "first_shadow_acceptance",
  "seven_complete_jst_days_shadow_parity",
  "mercari_provider_contract_and_canaries",
  "rakuten_provider_contract_and_canaries",
  "giga_provider_contract_and_canaries",
  "sales_brief_delivery_canary_and_readback",
  "disabled_quiescence_ownership_transfer",
  "per_capability_cutover_and_single_owner_readback",
  "legacy_retirement_and_final_document_audit",
]);

async function exists(root, relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function auditStrategyReadiness({ root = REPO_ROOT } = {}) {
  const migrations = await Promise.all(REQUIRED_MIGRATIONS.map(async (name) => ({
    name,
    present: await exists(root, path.join("supabase/migrations", name)),
  })));
  const assets = await Promise.all(REQUIRED_ASSETS.map(async (name) => ({ name, present: await exists(root, name) })));
  const documents = await Promise.all(CANONICAL_DOCS.map(async (name) => {
    if (!(await exists(root, name))) return { name, present: false, target_deployed_boundary: false };
    const content = await readFile(path.join(root, name), "utf8");
    const requiresBoundary = TARGET_DEPLOYED_BOUNDARY_DOCS.has(name);
    return {
      name,
      present: true,
      target_deployed_boundary_required: requiresBoundary,
      target_deployed_boundary: requiresBoundary
        ? /(target|目标|branch-only|未部署|not deployed|current production|当前生产)/i.test(content)
        : null,
    };
  }));
  const capabilities = CANARY_CAPABILITY_MATRIX.map(({ name, exactCanarySupported }) => ({ name, exact_canary_supported: exactCanarySupported }));
  const checks = {
    dag_has_17_capabilities: ORDER_PIPELINE_DAG.length === 17,
    all_capabilities_have_exact_canary: capabilities.length === 17 && capabilities.every((item) => item.exact_canary_supported),
    required_migrations_present: migrations.every((item) => item.present),
    canonical_assets_present: assets.every((item) => item.present),
    canonical_docs_present: documents.every((item) => item.present),
    canonical_docs_preserve_target_deployed_boundary: documents
      .filter((item) => item.target_deployed_boundary_required)
      .every((item) => item.target_deployed_boundary),
  };
  const localImplementationReady = Object.values(checks).every(Boolean);
  const externalEvidence = Object.fromEntries(EXTERNAL_EVIDENCE_GATES.map((gate) => [gate, {
    satisfied: false,
    source: "external_authoritative_readback_required",
  }]));

  return {
    ok: localImplementationReady,
    local_implementation_ready: localImplementationReady,
    strategy_complete: false,
    checks,
    evidence: { capabilities, migrations, assets, documents },
    external_evidence_gates: externalEvidence,
    conclusion: localImplementationReady
      ? "repository_evidence_ready_external_runtime_acceptance_required"
      : "repository_evidence_incomplete",
  };
}

export async function main() {
  const result = await auditStrategyReadiness();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, strategy_complete: false, error: String(error?.message || error) }));
  process.exitCode = 1;
});
