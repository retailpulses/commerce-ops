function text(value) {
  return String(value == null ? "" : value).trim();
}

function buildRelayHeaders(relaySecret) {
  const headers = { "content-type": "application/json" };
  if (text(relaySecret)) headers["x-relay-secret"] = text(relaySecret);
  return headers;
}

function resolveBaseUrl(env) {
  const base = text(env.MERCARI_RUNNER_BASE_URL);
  if (base) return base.replace(/\/+$/, "");
  const ingest = text(env.MERCARI_INGEST_RUNNER_URL);
  if (ingest && ingest.endsWith("/admin/ingest")) {
    return ingest.slice(0, -"/admin/ingest".length);
  }
  return "";
}

function deriveCloseRunnerUrl(ingestRunnerUrl) {
  const raw = text(ingestRunnerUrl);
  if (!raw) return "";
  if (raw.endsWith("/admin/ingest")) {
    return `${raw.slice(0, -"/admin/ingest".length)}/admin/close-shipped-orders`;
  }
  return raw;
}

export async function checkRelayHealth(env) {
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) return { ok: false, error: "no_relay_base_url" };
  try {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json().catch(() => null);
    return { ok: res.ok && body && body.ok === true, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err && (err.message || String(err)) || "relay_health_check_failed" };
  }
}

export async function runMercariIngestViaRelay(env, { shops, limit, dryRun, statuses }) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl ? `${baseUrl}/admin/ingest` : text(env.MERCARI_INGEST_RUNNER_URL);
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  if (!url) {
    return {
      ok: false,
      statusCode: 500,
      error: "missing_mercari_ingest_runner_url",
      message: "Mercari API access must go through MERCARI_RUNNER_BASE_URL or MERCARI_INGEST_RUNNER_URL on the VPS relay.",
    };
  }
  return await callRelayEndpoint(url, { shops, limit, dryRun, statuses }, relaySecret, { requireCompletion: true });
}

export async function runMercariShippingCloseViaRelay(env, { shops, limit, dryRun }) {
  const baseUrl = resolveBaseUrl(env);
  const url = baseUrl
    ? `${baseUrl}/admin/close-shipped-orders`
    : text(env.MERCARI_SHIPPING_CLOSE_RUNNER_URL) || deriveCloseRunnerUrl(env.MERCARI_INGEST_RUNNER_URL);
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  if (!url) {
    return {
      ok: false,
      statusCode: 500,
      error: "missing_mercari_shipping_close_runner_url",
      message: "Mercari shop-close must go through MERCARI_RUNNER_BASE_URL or MERCARI_SHIPPING_CLOSE_RUNNER_URL on the VPS relay.",
    };
  }
  return await callRelayEndpoint(url, { shops, limit, dryRun }, relaySecret, { requireCompletion: true });
}

export async function runMercariOrderMessagesViaRelay(env, { shopLabel, orderId }) {
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) {
    return {
      ok: false,
      statusCode: 500,
      error: "no_relay_base_url",
      message: "Mercari API access must go through MERCARI_RUNNER_BASE_URL on the VPS relay.",
    };
  }
  const url = `${baseUrl}/admin/order-messages`;
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  return await callRelayEndpoint(url, { shopLabel, orderId }, relaySecret);
}

export async function runMercariOrderStatusesViaRelay(env, { shopLabel, orderIds }) {
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) return { ok: false, statusCode: 500, error: "no_relay_base_url" };
  return await callRelayEndpoint(
    `${baseUrl}/admin/order-statuses`,
    { shopLabel, orderIds },
    text(env.MERCARI_RELAY_SECRET),
  );
}

export async function runMercariOrderReplyViaRelay(env, { shopLabel, transactionId, text: replyText }) {
  const baseUrl = resolveBaseUrl(env);
  if (!baseUrl) {
    return {
      ok: false,
      statusCode: 500,
      error: "no_relay_base_url",
      message: "Mercari API access must go through MERCARI_RUNNER_BASE_URL on the VPS relay.",
    };
  }
  const url = `${baseUrl}/admin/order-reply`;
  const relaySecret = text(env.MERCARI_RELAY_SECRET);
  return await callRelayEndpoint(url, { shopLabel, transactionId, text: replyText }, relaySecret);
}

export async function callRelayEndpoint(url, body, relaySecret, { requireCompletion = false } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildRelayHeaders(relaySecret),
    body: JSON.stringify(body || {}),
  });
  const parsed = await res.json().catch(() => null);
  const completionState = relayCompletionState(res.status, parsed);
  const completionProven = completionState === "completed"
    && text(parsed && (parsed.state || parsed.completion_state)).toLowerCase() === "completed";
  const ok = res.ok && parsed && parsed.ok !== false && (!requireCompletion || completionProven);
  return {
    ok,
    status: res.status,
    completion_state: completionState,
    completion_proven: completionProven,
    counts: parsed && parsed.counts && typeof parsed.counts === "object" ? parsed.counts : {},
    body: parsed,
    ...(!ok && requireCompletion && res.ok && parsed && parsed.ok !== false
      ? { error: `relay_completion_not_proven:${completionState}` }
      : {}),
  };
}

export function relayCompletionState(status, body) {
  const explicit = text(body && (body.state || body.completion_state)).toLowerCase();
  if (["accepted", "running", "completed", "failed", "skipped"].includes(explicit)) return explicit;
  if (status === 202 || (body && body.accepted === true)) return "accepted";
  if (status >= 200 && status < 300 && body && body.ok !== false) return "completed";
  return "failed";
}
