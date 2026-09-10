import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { Config } from "../config.js";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "application/pdf",
  "application/octet-stream",
]);

export function isPrivateOrLinkLocal(ip: string): boolean {
  const type = isIP(ip);
  if (!type) return false;

  if (ip === "::1" || ip === "127.0.0.1") return true;

  if (type === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] >= 224) return true;
  }

  if (type === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateOrLinkLocal(mappedIpv4);
    const hextet = normalized.split(":")[0];
    if (hextet.startsWith("fc") || hextet.startsWith("fd")) return true;
    if (hextet.startsWith("fe8") || hextet.startsWith("fe9") || hextet.startsWith("fea") || hextet.startsWith("feb"))
      return true;
    if (hextet.startsWith("ff")) return true;
  }

  return false;
}

async function checkHostIps(hostname: string): Promise<void> {
  const ips: string[] = [];
  try {
    ips.push(...(await resolve4(hostname)));
  } catch {
    /* ignore resolution failures — handled below */
  }
  try {
    ips.push(...(await resolve6(hostname)));
  } catch {
    /* ignore resolution failures */
  }

  if (ips.length === 0) {
    throw new UpstreamError("Cannot resolve upstream host");
  }

  for (const ip of ips) {
    if (isPrivateOrLinkLocal(ip)) {
      throw new UpstreamError("Upstream host resolves to private IP");
    }
  }
}

export function validateUpstreamUrl(
  urlStr: string,
  storageHosts: string[],
): { hostname: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new UpstreamError("Invalid upstream URL");
  }

  if (parsed.protocol !== "https:") {
    throw new UpstreamError("Only HTTPS upstream URLs are allowed");
  }

  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new UpstreamError("Upstream URL contains forbidden authority fields");
  }

  if (!storageHosts.map((host) => host.toLowerCase()).includes(parsed.hostname.toLowerCase())) {
    throw new UpstreamError("Upstream host not in allowlist");
  }

  return { hostname: parsed.hostname };
}

export async function fetchFromUpstream(
  urlStr: string,
  rangeHeader: string | undefined,
  config: Config,
  fetchFn: typeof fetch,
): Promise<{ response: Response; responseHeaders: Record<string, string> }> {
  const { hostname } = validateUpstreamUrl(urlStr, config.storageHosts);

  await checkHostIps(hostname);

  const reqHeaders: Record<string, string> = {};
  if (rangeHeader) {
    if (!/^bytes=\d*-\d*$/.test(rangeHeader)) {
      throw new UpstreamError("Invalid Range request", 416);
    }
    reqHeaders["Range"] = rangeHeader;
  }

  let response: Response;
  try {
    response = await fetchFn(urlStr, {
      headers: reqHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (err) {
    throw new UpstreamError(
      `Upstream request failed: ${String(err)}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Upstream redirects are not allowed");
  }

  if (!response.ok && response.status !== 206) {
    throw new UpstreamError(
      "Upstream returned an error",
      response.status >= 400 && response.status < 500 ? 404 : 502,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!Number.isFinite(len) || len < 0 || len > config.maxFileSize) {
      throw new UpstreamError("File too large");
    }
  }

  const responseHeaders: Record<string, string> = {};

  const ct = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(ct)) {
    throw new UpstreamError("Unsupported upstream content type", 415);
  }
  responseHeaders["Content-Type"] = ct;

  if (contentLength) responseHeaders["Content-Length"] = contentLength;

  if (response.status === 206) {
    const cr = response.headers.get("content-range");
    if (cr) responseHeaders["Content-Range"] = cr;
    responseHeaders["Accept-Ranges"] = "bytes";
  }

  return { response, responseHeaders };
}
