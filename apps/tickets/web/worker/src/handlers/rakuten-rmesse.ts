import type { Env } from "../types";
import { validateSession } from "../middleware/auth";
import { getSupabaseClient } from "../repositories/supabase";
import { syncRakutenRmesse, type RakutenRmesseMode } from "../services/rakutenRmesseSyncService";

export async function handleRakutenRmesseSync(request: Request, env: Env): Promise<Response> {
  if (!(await validateSession(request, env.MERCARI_REPORTS))) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }
  let requestedMode: RakutenRmesseMode | undefined;
  try {
    const body = await request.json() as { mode?: string };
    if (body.mode === "shadow" || body.mode === "active" || body.mode === "off") requestedMode = body.mode;
  } catch { /* default to configured mode */ }
  const report = await syncRakutenRmesse(env, getSupabaseClient(env), { mode: requestedMode });
  return Response.json({ ok: true, report });
}
