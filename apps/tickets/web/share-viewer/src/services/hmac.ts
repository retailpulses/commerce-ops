import crypto from "node:crypto";

export function computeHmacSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  return crypto
    .createHmac("sha256", secret)
    .update(canonicalString)
    .digest("hex");
}

export function generateNonce(): string {
  return crypto.randomUUID();
}

export function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}
