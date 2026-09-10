export async function sendWeCom(env, markdown) {
  const url = (env.WECOM_WEBHOOK_URL || "").trim();
  if (!url) throw new Error("Missing WECOM_WEBHOOK_URL");

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: markdown },
        }),
      });
      const body = await parseBody(resp);
      const ok = resp.ok && body && Number(body.errcode) === 0;
      return {
        ok,
        skipped: false,
        status: resp.status,
        body,
        error: ok ? null : extractError(body, resp.status),
      };
    } catch (err) {
      lastError = err;
      if (attempt < 4) await sleep(Math.min(10000, 700 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError || new Error("wecom_failed");
}

async function parseBody(resp) {
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function extractError(body, status) {
  if (typeof body === "string") return `${status}:${body.slice(0, 300)}`;
  if (body && typeof body === "object") {
    return String(body.errmsg || body.error || body.detail || body.message || status);
  }
  return String(status);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
