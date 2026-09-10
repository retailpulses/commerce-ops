const TOKEN_RE = /^[0-9a-f]{64}$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function isValidAttachmentId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}
