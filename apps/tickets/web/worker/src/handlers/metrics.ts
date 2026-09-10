import { getSupabaseClient } from "../repositories/supabase";
import type { Env } from "../types";

const ZERO_SHA = "0000000000000000000000000000000000000000";

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

export async function handleTicketMetrics(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const window = resolveWindow(url.searchParams.get("window") || "last_30_days");
    const sb = getSupabaseClient(env);
    const nonTerminal = ["open", "in_progress", "pending_customer", "pending_third_party"];
    const terminal = ["resolved", "closed", "canceled"];
    const [openWindow, openCurrent, urgentOpenCurrent, closedWindow] = await Promise.all([
      sb.from("tickets").select("id", { count: "exact", head: true }).in("status", nonTerminal).gte("created_at", window.start).lt("created_at", window.end),
      sb.from("tickets").select("id", { count: "exact", head: true }).in("status", nonTerminal),
      sb.from("tickets").select("id", { count: "exact", head: true }).in("status", nonTerminal).eq("priority", "urgent"),
      sb.from("tickets").select("id", { count: "exact", head: true }).in("status", terminal).gte("closed_at", window.start).lt("closed_at", window.end),
    ]);
    const error = openWindow.error || openCurrent.error || urgentOpenCurrent.error || closedWindow.error;
    if (error) throw error;
    const injected = String(env.RELEASE_SHA || "").trim();
    return Response.json({
      contract_version: "1.1", domain: "tickets", window,
      metrics: {
        open: { kind: "window_stock", window_count: openWindow.count || 0, current_count: openCurrent.count || 0, status: "available", warnings: [] },
        urgent_open: { kind: "current_stock", window_count: null, current_count: urgentOpenCurrent.count || 0, status: "available", warnings: [] },
        closed: { kind: "window_flow", window_count: closedWindow.count || 0, current_count: null, status: "available", warnings: [] },
      },
      generated_at: new Date().toISOString(),
      release_sha: /^[0-9a-f]{40}$/.test(injected) ? injected : ZERO_SHA,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "invalid_metrics_window" ? 400 : 500 });
  }
}
