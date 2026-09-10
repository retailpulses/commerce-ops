#!/usr/bin/env node

/**
 * Copy legacy Portal templates from the Cloudflare Worker KV-backed API to
 * the Supabase-backed VPS Portal API.
 *
 * Safe default: dry run. Writes require both --dry-run=false and --confirm.
 * The script uses Portal API bearer tokens; it never needs a Supabase
 * service-role key on the operator machine.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_SOURCE_URL = "https://rp-order-mgmt.jim-yang-3c5.workers.dev/api/portal/templates";
const DEFAULT_TARGET_URL = "https://order.homesbliss.net/api/portal/templates";

function text(value) {
  return String(value ?? "").trim();
}

function normalizeTemplate(template) {
  return {
    title: text(template?.title),
    body: text(template?.body),
  };
}

export function planTemplateMigration(sourceTemplates, targetTemplates) {
  const targetByTitle = new Map(
    targetTemplates.map((template) => {
      const normalized = normalizeTemplate(template);
      return [normalized.title, normalized];
    }),
  );

  const create = [];
  const unchanged = [];
  const conflicts = [];

  for (const source of sourceTemplates) {
    const normalized = normalizeTemplate(source);
    if (!normalized.title || !normalized.body) {
      conflicts.push({ title: normalized.title, reason: "invalid_source_template" });
      continue;
    }

    const target = targetByTitle.get(normalized.title);
    if (!target) {
      create.push(normalized);
    } else if (target.body === normalized.body) {
      unchanged.push(normalized.title);
    } else {
      conflicts.push({ title: normalized.title, reason: "same_title_different_body" });
    }
  }

  return { create, unchanged, conflicts };
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`${options.method || "GET"} ${url} failed: ${body.error || `HTTP ${response.status}`}`);
  }
  return body;
}

async function listTemplates(url, token) {
  const body = await requestJson(url, token);
  return Array.isArray(body.templates) ? body.templates : [];
}

async function createTemplate(url, token, template) {
  return requestJson(url, token, {
    method: "POST",
    body: JSON.stringify(template),
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "string", default: "true" },
      confirm: { type: "boolean", default: false },
      "source-url": { type: "string", default: DEFAULT_SOURCE_URL },
      "target-url": { type: "string", default: DEFAULT_TARGET_URL },
      verbose: { type: "boolean", default: false },
    },
  });

  const dryRun = text(values["dry-run"]).toLowerCase() !== "false";
  const sourceUrl = text(values["source-url"]);
  const targetUrl = text(values["target-url"]);
  if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) {
    throw new Error("Source and target template URLs must be present and different.");
  }

  const sharedToken = text(env.PORTAL_ACCESS_TOKEN || env.GIGA_SYNC_ADMIN_SECRET || env.ORDER_MGMT_ADMIN_SECRET);
  const sourceToken = text(env.SOURCE_PORTAL_TOKEN || sharedToken);
  const targetToken = text(env.TARGET_PORTAL_TOKEN || sharedToken);
  if (!sourceToken || !targetToken) {
    throw new Error("Set PORTAL_ACCESS_TOKEN, or both SOURCE_PORTAL_TOKEN and TARGET_PORTAL_TOKEN.");
  }

  if (!dryRun && values.confirm !== true) {
    throw new Error("Writes require both --dry-run=false and --confirm.");
  }

  const [sourceTemplates, targetTemplates] = await Promise.all([
    listTemplates(sourceUrl, sourceToken),
    listTemplates(targetUrl, targetToken),
  ]);
  const plan = planTemplateMigration(sourceTemplates, targetTemplates);

  console.log(JSON.stringify({
    dry_run: dryRun,
    source_count: sourceTemplates.length,
    target_count: targetTemplates.length,
    create_count: plan.create.length,
    unchanged_count: plan.unchanged.length,
    conflict_count: plan.conflicts.length,
  }, null, 2));

  if (values.verbose) {
    console.log(JSON.stringify({
      create_titles: plan.create.map((template) => template.title),
      unchanged_titles: plan.unchanged,
      conflicts: plan.conflicts,
    }, null, 2));
  }

  if (dryRun) return { ...plan, created: 0 };
  if (plan.conflicts.length > 0) {
    throw new Error("Template conflicts detected; resolve them before applying the migration.");
  }

  let created = 0;
  for (const template of plan.create) {
    await createTemplate(targetUrl, targetToken, template);
    created += 1;
  }
  console.log(JSON.stringify({ ok: true, created }, null, 2));
  return { ...plan, created };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
