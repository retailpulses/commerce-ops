/**
 * Portal adapter for RPagentOS-owned manual product overrides.
 *
 * OrderMgmt never writes product_catalog directly. The catalog owner validates
 * identity and fields, performs the mutation, and records owner-side evidence.
 */

const MANUAL_FIELDS = Object.freeze([
  "manual_cost_price",
  "manual_presale_arrival_date",
  "presale_info_protect_until",
]);

const DATE_FIELDS = new Set(["manual_presale_arrival_date", "presale_info_protect_until"]);
const DEFAULT_OWNER_API_BASE_URL = "https://rpagentos.pages.dev";

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function validateDate(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "expected YYYY-MM-DD or null";
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return "invalid calendar date";
  }
  return null;
}

export function validateManualFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request_body_must_be_a_json_object" };
  }

  const keys = Object.keys(body);
  if (!keys.length) return { ok: false, error: "at_least_one_manual_field_required" };
  const unknown = keys.filter((key) => !MANUAL_FIELDS.includes(key));
  if (unknown.length) return { ok: false, error: `unknown_field: ${unknown.join(", ")}` };

  const payload = {};
  for (const key of keys) {
    const value = body[key];
    if (key === "manual_cost_price") {
      if (value === null) {
        payload[key] = null;
      } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 99_999_999) {
        return { ok: false, error: "manual_cost_price_must_be_a_finite_number_between_0_and_99999999" };
      } else {
        payload[key] = value;
      }
      continue;
    }

    if (DATE_FIELDS.has(key)) {
      const error = validateDate(value);
      if (error) return { ok: false, error: `${key}: ${error}` };
      payload[key] = value;
    }
  }
  return { ok: true, payload };
}

function ownerConfig(env) {
  return {
    baseUrl: text(env.CATALOG_OWNER_API_BASE_URL) || DEFAULT_OWNER_API_BASE_URL,
    token: text(env.ORDERMGMT_CATALOG_API_TOKEN),
  };
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

export async function fetchPortalProductManualFields(env, itemCode, fetchFn = fetch) {
  const config = ownerConfig(env);
  const normalizedCode = text(itemCode);
  if (!normalizedCode) return { ok: false, error: "item_code_required", statusCode: 400 };
  if (!config.token) return { ok: false, error: "catalog_owner_api_not_configured", statusCode: 503 };

  try {
    const response = await fetchFn(
      `${config.baseUrl.replace(/\/$/, "")}/api/internal/catalog/sku/${encodeURIComponent(normalizedCode)}`,
      {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const body = await parseJson(response);
    if (!response.ok) return { ok: false, error: body.error || "catalog_owner_api_failed", statusCode: response.status };
    return { ok: true, product: body };
  } catch (_) {
    return { ok: false, error: "catalog_owner_api_unavailable", statusCode: 502 };
  }
}

export async function handlePortalProductManualFields(env, itemCode, body, fetchFn = fetch) {
  const validation = validateManualFields(body);
  if (!validation.ok) return { ...validation, statusCode: 400 };

  const config = ownerConfig(env);
  const normalizedCode = text(itemCode);
  if (!normalizedCode) return { ok: false, error: "item_code_required", statusCode: 400 };
  if (!config.token) return { ok: false, error: "catalog_owner_api_not_configured", statusCode: 503 };

  try {
    const response = await fetchFn(
      `${config.baseUrl.replace(/\/$/, "")}/api/internal/catalog/sku/${encodeURIComponent(normalizedCode)}/manual-fields`,
      {
        method: "PATCH",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validation.payload),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const result = await parseJson(response);
    if (!response.ok) {
      return { ok: false, error: result.error || "catalog_owner_api_failed", statusCode: response.status };
    }
    return { ok: true, ...result };
  } catch (_) {
    return { ok: false, error: "catalog_owner_api_unavailable", statusCode: 502 };
  }
}
