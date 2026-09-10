import { runSalesBrief } from "./sales-brief.js";
import { sendWeCom } from "./wecom.js";

const CRON_SALES_BRIEF = "0 23,2,5,8,11,13 * * *";
const RUN_SECRET_HEADER = "x-run-secret";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET") {
      return json({
        ok: true,
        service: "rp-order-mgmt-reporting",
        ts: new Date().toISOString(),
        schedulesJst: ["08:00", "11:00", "14:00", "17:00", "20:00", "22:00"],
      });
    }

    if (path === "/run/sales-brief" && method === "POST") {
      if (!isAuthorized(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const dryRun = isDryRun(url);
      const result = await runSalesBrief(env, { dryRun, trigger: "manual" });
      const status = result.ok ? 200 : (result.statusCode || 500);
      if (dryRun) {
        return json({ ...result, send: { ok: true, skipped: true } }, status);
      }
      if (result.ok) {
        const send = await sendWeCom(env, result.preview);
        return json({ ...result, send }, status);
      }
      return json(result, status);
    }

    return json({
      ok: true,
      service: "rp-order-mgmt-reporting",
      endpoints: ["/health", "/run/sales-brief"],
    });
  },

  async scheduled(controller, env, ctx) {
    const cron = (controller && controller.cron || "").trim();
    if (cron === CRON_SALES_BRIEF) {
      ctx.waitUntil(runAndSend(env, { trigger: "scheduled", cron }));
      return;
    }
    console.log(JSON.stringify({ ts: new Date().toISOString(), ok: false, action: "ignored_cron", cron }));
  },
};

async function runAndSend(env, options) {
  const result = await runSalesBrief(env, options);
  if (result.ok) {
    const send = await sendWeCom(env, result.preview);
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: "rp-order-mgmt-reporting", ...result, send }));
  } else {
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: "rp-order-mgmt-reporting", ...result }));
  }
}

function isAuthorized(request, env) {
  const secret = (env.RUN_SECRET || "").trim();
  if (!secret) return false;
  const header = (request.headers.get(RUN_SECRET_HEADER) || "").trim();
  const auth = (request.headers.get("authorization") || "").trim();
  if (header === secret) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim() === secret) return true;
  return false;
}

function isDryRun(url) {
  const v = (url.searchParams.get("dry_run") || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
