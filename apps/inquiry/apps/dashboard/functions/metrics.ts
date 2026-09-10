import { onRequestGet as metricsResponse } from "./api/metrics";

function authorized(request: Request, expected: string | undefined): boolean {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !expected || token.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < token.length; index++) different |= token.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

export async function onRequestGet(context: { request: Request; env: Record<string, string> }) {
  if (!authorized(context.request, context.env.INQUIRY_METRICS_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return metricsResponse(context);
}
