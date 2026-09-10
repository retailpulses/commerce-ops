import { getConfig } from "../_lib/config";
import { RELEASE_METADATA } from "../_generated/release";

export function resolveWindow(key: string, now = new Date()) {
  if (!["last_7_days", "last_30_days", "current_month"].includes(key)) throw new Error("invalid_metrics_window");
  const end = new Date(now);
  let start: Date;
  if (key === "current_month") {
    const jst = new Date(end.getTime() + 9 * 3600000);
    start = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600000);
  } else {
    start = new Date(end.getTime() - (key === "last_7_days" ? 7 : 30) * 86400000);
  }
  return { key, start: start.toISOString(), end: end.toISOString(), timezone: "Asia/Tokyo" };
}

async function count(restBase: string, key: string, query: URLSearchParams): Promise<number> {
  const response = await fetch(`${restBase}/inquiries?${query}`, {
    method: "HEAD",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
  });
  if (!response.ok) throw new Error(`inquiry_metrics_query_failed:${response.status}`);
  const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export async function onRequestGet(context: { request: Request; env: Record<string, string> }) {
  try {
    const config = getConfig(context.env);
    const window = resolveWindow(new URL(context.request.url).searchParams.get("window") || "last_30_days");
    const restBase = (config.supabase.restUrl || `${config.supabase.url.replace(/\/$/, "")}/rest/v1`).replace(/\/$/, "");
    const current = new URLSearchParams({ select: "id", status: "eq.received", deleted_at: "is.null" });
    const selected = new URLSearchParams(current);
    selected.set("and", `(inquiry_date.gte.${window.start},inquiry_date.lt.${window.end})`);
    const [windowCount, currentCount] = await Promise.all([
      count(restBase, config.supabase.serviceRoleKey, selected),
      count(restBase, config.supabase.serviceRoleKey, current),
    ]);
    return Response.json({
      contract_version: "1.1", domain: "inquiries", window,
      metrics: {
        not_answered: { kind: "window_stock", window_count: windowCount, current_count: currentCount, status: "available", warnings: [] },
        closed_won: { kind: "window_flow", window_count: null, current_count: null, status: "unavailable", warnings: ["durable_transition_history_missing"] },
        followed_up: { kind: "window_flow", window_count: null, current_count: null, status: "unavailable", warnings: ["durable_transition_history_missing"] },
      },
      generated_at: new Date().toISOString(), release_sha: RELEASE_METADATA.release_sha,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "invalid_metrics_window" ? 400 : 500 });
  }
}
