import { getConfig } from "../_lib/config";

/** GET /api/config — public dashboard config (CF Access still applies via _middleware) */
export async function onRequestGet(context: {
  request: Request;
  env: Record<string, string>;
}) {
  const config = getConfig(context.env);

  return new Response(
    JSON.stringify({
      mutationsEnabled: config.mutationsEnabled,
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}
