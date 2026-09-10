import { AuthError, requireAuth } from "../_lib/auth";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CANONICAL_PORTAL_ORIGIN = "https://ops.homesbliss.net";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

/** Protect every dashboard API read and mutation with Cloudflare Access. */
export async function onRequest(context: {
  request: Request;
  env: Record<string, string>;
  next: () => Promise<Response>;
}): Promise<Response> {
  try {
    const method = context.request.method.toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return jsonError(405, "Method not allowed");
    }

    // Release identity is intentionally public at the application origin. The
    // canonical Portal remains protected by Cloudflare Access, while CI and the
    // fixed-target VPS relay can prove the exact deployed owner commit.
    const pathname = new URL(context.request.url).pathname;
    if (method === "GET" && pathname === "/api/release") {
      return context.next();
    }

    await requireAuth(context.request, context.env);

    if (MUTATION_METHODS.has(method)) {
      // Fail-closed: mutations only run when the Pages binding is exactly "true"
      if (context.env.INQUIRY_DASHBOARD_MUTATIONS_ENABLED !== "true") {
        return jsonError(503, "Dashboard mutations are currently disabled");
      }
      const origin = context.request.headers.get("Origin");
      const requestOrigin = new URL(context.request.url).origin;
      // The canonical Portal gateway forwards the browser request to this
      // Pages Function. Its browser Origin remains ops.homesbliss.net while
      // request.url identifies the owner Pages origin.
      if (!origin || (origin !== requestOrigin && origin !== CANONICAL_PORTAL_ORIGIN)) {
        return jsonError(403, "Cross-origin mutation rejected");
      }
      if (method !== "DELETE") {
        const contentType = context.request.headers.get("Content-Type") || "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          return jsonError(415, "Content-Type must be application/json");
        }
      }
    }

    const response = await context.next();
    const contentType = response.headers.get("Content-Type");
    if (!contentType || !contentType.includes("application/json")) {
      const cloned = new Response(response.body, response);
      cloned.headers.set("Content-Type", JSON_HEADERS["Content-Type"]);
      return cloned;
    }
    return response;
  } catch (err) {
    if (err instanceof AuthError) return jsonError(401, "Unauthorized");
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("API error:", message);
    return jsonError(500, "Internal server error");
  }
}
