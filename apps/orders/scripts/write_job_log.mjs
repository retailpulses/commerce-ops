import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function trimAndCollapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEnvKey(key) {
  const normalized = String(key || "").trim();
  if (normalized === "Baserow base URL") return "BASEROW_API_BASE";
  if (normalized === "Baserow database token") return "BASEROW_DATABASE_TOKEN";
  return normalized;
}

function readEnvFile(filePath) {
  const env = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = normalizeEnvKey(trimmed.slice(0, idx).trim());
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!env[key]) env[key] = value;
  }
  return env;
}

function normalizeApiBase(value) {
  const raw = trimAndCollapse(value);
  if (!raw) return "https://api.baserow.io/api";
  if (raw.endsWith("/api")) return raw;
  if (raw.endsWith("/api/")) return raw.slice(0, -1);
  return `${raw.replace(/\/+$/g, "")}/api`;
}

async function baserowRequest(env, url, options = {}) {
  const token = trimAndCollapse(env.BASEROW_DATABASE_TOKEN);
  if (!token) throw new Error("Missing BASEROW_DATABASE_TOKEN");
  const headers = {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/write_job_log.mjs --env-path /path/to/.env --title '...' --status Completed --deliverable /path/to/file --work-report /path/to/work_report.md",
    "",
    "Optional:",
    "  --api-base https://api.baserow.io (defaults to env or baserow.io)",
    "  --table-id 921591 (defaults to 921591)",
    "  --workspace 'order-mgmt' (defaults to order-mgmt)",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = String(args["env-path"] || "").trim();
  const title = String(args.title || "").trim();
  const status = String(args.status || "Completed").trim();
  const deliverable = String(args.deliverable || "").trim();
  const workReportPath = String(args["work-report"] || "").trim();

  if (!envPath || !title || !deliverable || !workReportPath) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const env = readEnvFile(envPath);
  if (args["api-base"]) env.BASEROW_API_BASE = String(args["api-base"]);
  const apiBase = normalizeApiBase(env.BASEROW_API_BASE || "");
  const tableId = Number.parseInt(String(args["table-id"] || "921591"), 10);
  if (!Number.isFinite(tableId) || tableId <= 0) throw new Error("Invalid --table-id");

  const workReport = readFileSync(workReportPath, "utf8").trim();
  const payload = {
    "Log Title": title,
    Status: status,
    "Work report": workReport,
    "Deliverable file path": deliverable,
    "Workspace Name": String(args.workspace || "order-mgmt"),
  };

  const url = `${apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true`;
  const res = await baserowRequest(env, url, { method: "POST", body: payload });
  if (!res.ok) throw new Error(`baserow_job_log_failed:${res.status}`);

  const rowId = res.body && typeof res.body === "object" ? res.body.id : null;
  console.log(JSON.stringify({ ok: true, table_id: tableId, row_id: rowId }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
