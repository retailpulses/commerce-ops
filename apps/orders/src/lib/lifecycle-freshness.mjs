const DEFAULT_MAX_AGE_MINUTES = 90;

export function parseFreshnessScopes(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const scopes = raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return scopes.length ? [...new Set(scopes)] : [...fallback];
}

export function evaluateFreshness(watermarks, requiredScopes, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const configuredAge = Number(options.maxAgeMinutes);
  const maxAgeMinutes = Number.isFinite(configuredAge) && configuredAge > 0
    ? configuredAge
    : DEFAULT_MAX_AGE_MINUTES;
  const byScope = new Map((watermarks || []).map((row) => [
    `${String(row.platform || "").toLowerCase()}:${String(row.source_store_id || "").toLowerCase()}`,
    row,
  ]));
  const failures = [];

  for (const scope of requiredScopes || []) {
    const normalized = String(scope || "").trim().toLowerCase();
    const watermark = byScope.get(normalized);
    if (!watermark) {
      failures.push({ scope: normalized, reason: "missing" });
      continue;
    }
    if (watermark.completion_state !== "accounting_complete") {
      failures.push({ scope: normalized, reason: watermark.completion_state || "unknown_state" });
      continue;
    }
    const observedAt = new Date(watermark.observed_at);
    if (!Number.isFinite(observedAt.getTime())) {
      failures.push({ scope: normalized, reason: "invalid_observed_at" });
      continue;
    }
    const ageMinutes = (now.getTime() - observedAt.getTime()) / 60000;
    if (ageMinutes < 0 || ageMinutes > maxAgeMinutes) {
      failures.push({ scope: normalized, reason: ageMinutes < 0 ? "future" : "stale", age_minutes: Math.round(ageMinutes) });
    }
  }

  return { ok: failures.length === 0, max_age_minutes: maxAgeMinutes, failures };
}

export async function requireLifecycleFreshness(supabase, options = {}) {
  const requiredScopes = parseFreshnessScopes(options.requiredScopes, options.fallbackScopes || []);
  if (!requiredScopes.length) {
    return { ok: false, max_age_minutes: Number(options.maxAgeMinutes) || DEFAULT_MAX_AGE_MINUTES, failures: [{ scope: "configuration", reason: "no_required_scopes" }] };
  }
  const platforms = [...new Set(requiredScopes.map((scope) => scope.split(":", 1)[0]))];
  const { data, error } = await supabase
    .from("order_lifecycle_watermarks")
    .select("platform,source_store_id,completion_state,observed_at,completed_at,run_id")
    .in("platform", platforms);
  if (error) {
    return { ok: false, failures: [{ scope: "database", reason: "query_failed" }], error: error.message };
  }
  return evaluateFreshness(data, requiredScopes, options);
}

export const MERCARI_FRESHNESS_SCOPES = Object.freeze([
  "mercari:wmyisfmhbgwyvapewsfirn",
  "mercari:zamyqwzp6hudgdh5e9adob",
  "mercari:2jgrmzqojnbmfdwrtp2xk3",
  "mercari:2jmlhbxjifhdr55jmwa7fs",
]);

