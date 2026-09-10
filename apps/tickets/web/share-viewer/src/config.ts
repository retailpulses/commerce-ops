export interface Config {
  port: number;
  host: string;
  bridgeHmacSecret: string;
  workerBaseUrl: string;
  storageHosts: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  maxConcurrentStreams: number;
  maxFileSize: number;
  upstreamTimeoutMs: number;
  bridgeTimeoutMs: number;
  evidenceUrlTtlSeconds: number;
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): Config {
  const missing: string[] = [];

  const bridgeHmacSecret = process.env.TICKET_SHARE_BRIDGE_HMAC_SECRET;
  if (!bridgeHmacSecret) missing.push("TICKET_SHARE_BRIDGE_HMAC_SECRET");

  const workerBaseUrl = process.env.TICKET_SHARE_WORKER_BASE_URL;
  if (!workerBaseUrl) missing.push("TICKET_SHARE_WORKER_BASE_URL");

  const storageHostsRaw = process.env.TICKET_SHARE_STORAGE_HOSTS;
  if (!storageHostsRaw) missing.push("TICKET_SHARE_STORAGE_HOSTS");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (bridgeHmacSecret!.length < 32) throw new Error("TICKET_SHARE_BRIDGE_HMAC_SECRET must be at least 32 characters");
  const workerUrl = new URL(workerBaseUrl!);
  if (workerUrl.protocol !== "https:" || workerUrl.username || workerUrl.password || workerUrl.pathname !== "/") {
    throw new Error("TICKET_SHARE_WORKER_BASE_URL must be an HTTPS origin");
  }
  const storageHosts = storageHostsRaw!.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (storageHosts.length === 0 || storageHosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))) {
    throw new Error("TICKET_SHARE_STORAGE_HOSTS must contain hostnames only");
  }

  return {
    port: positiveInteger("PORT", process.env.PORT, 3000),
    host: process.env.HOST || "127.0.0.1",
    bridgeHmacSecret: bridgeHmacSecret!,
    workerBaseUrl: workerUrl.origin,
    storageHosts,
    rateLimitWindowMs: positiveInteger("RATE_LIMIT_WINDOW_MS", process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: positiveInteger("RATE_LIMIT_MAX", process.env.RATE_LIMIT_MAX, 30),
    maxConcurrentStreams: positiveInteger("MAX_CONCURRENT_STREAMS", process.env.MAX_CONCURRENT_STREAMS, 5),
    maxFileSize: positiveInteger("MAX_FILE_SIZE", process.env.MAX_FILE_SIZE, 100 * 1024 * 1024),
    upstreamTimeoutMs: positiveInteger("UPSTREAM_TIMEOUT_MS", process.env.UPSTREAM_TIMEOUT_MS, 30_000),
    bridgeTimeoutMs: positiveInteger("BRIDGE_TIMEOUT_MS", process.env.BRIDGE_TIMEOUT_MS, 10_000),
    evidenceUrlTtlSeconds: Math.min(60, positiveInteger("EVIDENCE_URL_TTL_SECONDS", process.env.EVIDENCE_URL_TTL_SECONDS, 60)),
  };
}
