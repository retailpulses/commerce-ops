import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const TARGETS = Object.freeze({
  inquiry: "/inquiry/",
  tickets: "/tickets/",
  order: "/order/",
  "ticket-health": "/tickets/api/ticketing/health",
  "inquiry-release": "/inquiry/api/release",
  "tickets-release": "/tickets/api/release",
  "order-release": "/order/api/release",
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || "3010");
const upstreamOrigin = "https://ops.homesbliss.net";
const expectedToken = process.env.RELAY_AUTH_TOKEN || "";
const accessClientId = process.env.CF_ACCESS_CLIENT_ID || "";
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET || "";
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || "60000");
const requestLimit = Number(process.env.RATE_LIMIT_REQUESTS || "30");
const rateBuckets = new Map();

if (!expectedToken || !accessClientId || !accessClientSecret) {
  throw new Error("Required relay credentials are missing");
}

function tokenMatches(value) {
  const supplied = Buffer.from(value || "");
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function callerKey(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = forwarded || request.socket.remoteAddress || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function rateLimited(key, now = Date.now()) {
  const current = rateBuckets.get(key);
  if (!current || now >= current.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > requestLimit;
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function audit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const caller = callerKey(request);

  try {
    const requestUrl = new URL(request.url || "/", "http://relay.local");
    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      return respond(response, 200, "ok\n");
    }
    if (request.method !== "GET" || requestUrl.pathname !== "/accept") {
      return respond(response, 404, "Not found\n");
    }
    if (!tokenMatches(request.headers.authorization)) {
      audit({ request_id: requestId, caller, result: "unauthorized" });
      return respond(response, 401, "Unauthorized\n");
    }
    if (rateLimited(caller)) {
      audit({ request_id: requestId, caller, result: "rate_limited" });
      return respond(response, 429, "Rate limited\n", { "retry-after": "60" });
    }

    const targetName = requestUrl.searchParams.get("target");
    const targetPath = TARGETS[targetName];
    if (!targetPath || requestUrl.searchParams.size !== 1) {
      return respond(response, 400, "Invalid target\n");
    }

    const upstream = await fetch(`${upstreamOrigin}${targetPath}`, {
      method: "GET",
      headers: {
        "CF-Access-Client-Id": accessClientId,
        "CF-Access-Client-Secret": accessClientSecret,
        "User-Agent": "Homesbliss-VPS-Portal-Acceptance/1.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });

    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-portal-acceptance-target": targetPath,
      "x-request-id": requestId,
    };
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    response.writeHead(upstream.status, headers);
    response.end(Buffer.from(await upstream.arrayBuffer()));
    audit({
      request_id: requestId,
      caller,
      target: targetName,
      upstream_status: upstream.status,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    audit({ request_id: requestId, caller, result: "upstream_error", error: error?.name || "Error" });
    respond(response, 502, "Upstream failure\n", { "x-request-id": requestId });
  }
});

server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.listen(port, host, () => audit({ event: "started", host, port }));
