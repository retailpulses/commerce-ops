/** Session validation middleware — extracted from index.ts for reuse across handlers. */

const SESSION_PREFIX = "session:";

export async function validateSession(request: Request, KV: KVNamespace): Promise<boolean> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return false;
  const val = await KV.get(`${SESSION_PREFIX}${token}`);
  return val === "valid";
}
