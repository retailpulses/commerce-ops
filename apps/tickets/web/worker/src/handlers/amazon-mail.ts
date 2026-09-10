import type { Env } from "../types";
import { validateSession } from "../middleware/auth";
import { getSupabaseClient } from "../repositories/supabase";
import { syncAmazonMail, type AmazonMailMode } from "../services/amazonMailSyncService";

export async function handleAmazonMailSync(request: Request, env: Env): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }
  let mode: AmazonMailMode = "shadow";
  let targetOrderNumber: string | undefined;
  try {
    const body = await request.json() as { mode?: string; target_order_number?: string };
    if (body.mode === "off" || body.mode === "shadow" || body.mode === "active") mode = body.mode;
    if (typeof body.target_order_number === "string" && /^\d{3}-\d{7}-\d{7}$/.test(body.target_order_number)) {
      targetOrderNumber = body.target_order_number;
    }
  } catch { /* safe shadow default */ }

  if (mode === "active" && String(env.AMAZON_MAIL_INGESTION_MODE || "off").toLowerCase() !== "active") {
    return Response.json({ error: { code: "AMAZON_INGESTION_DISABLED", message: "Amazon mail ingestion is disabled" } }, { status: 503 });
  }
  const report = await syncAmazonMail(env, getSupabaseClient(env), { mode, targetOrderNumber });
  return Response.json({ ok: true, report });
}
