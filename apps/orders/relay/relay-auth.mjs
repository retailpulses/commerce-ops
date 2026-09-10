import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest();
}

export function relaySecretMatches(provided, expected) {
  const candidate = String(provided || "").trim();
  const configured = String(expected || "").trim();
  if (!candidate || !configured) return false;
  return timingSafeEqual(digest(candidate), digest(configured));
}

export function requireRelaySecret(req, expected) {
  if (!String(expected || "").trim()) throw new Error("relay_secret_not_configured");
  if (relaySecretMatches(req?.headers?.["x-relay-secret"], expected)) return;
  throw new Error("unauthorized");
}
