const DEFAULT_API_BASE = "https://api.baserow.io/api";

export function createBaserowClient(env) {
  const apiBase = trimAndCollapse(env.BASEROW_API_BASE) || DEFAULT_API_BASE;
  const token = trimAndCollapse(env.BASEROW_DATABASE_TOKEN);
  if (!token) throw new Error("Missing BASEROW_DATABASE_TOKEN");
  const salesOrderTableId = parseInteger(env.BASEROW_MERCARI_SALES_ORDER_TABLE_ID, 903318);
  const shipmentOrderTableId = parseInteger(env.BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID, 903319);
  const rakutenSalesOrderTableId = parseInteger(env.BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID, 1015675);
  // Rakuten table lives in a different Baserow database (410074).
  // If the default token doesn't have access, set BASEROW_RAKUTEN_DATABASE_TOKEN separately.
  const rakutenToken = trimAndCollapse(env.BASEROW_RAKUTEN_DATABASE_TOKEN) || token;
  if (!Number.isFinite(salesOrderTableId) || salesOrderTableId <= 0) throw new Error("Invalid BASEROW_MERCARI_SALES_ORDER_TABLE_ID");
  if (!Number.isFinite(shipmentOrderTableId) || shipmentOrderTableId <= 0) throw new Error("Invalid BASEROW_GIGA_SHIPMENT_ORDER_TABLE_ID");
  if (!Number.isFinite(rakutenSalesOrderTableId) || rakutenSalesOrderTableId <= 0) throw new Error("Invalid BASEROW_RAKUTEN_SALES_ORDER_TABLE_ID");
  return { apiBase, token, rakutenToken, salesOrderTableId, shipmentOrderTableId, rakutenSalesOrderTableId };
}

/**
 * Return a client view for Rakuten table access, using the Rakuten-scoped
 * token if one is configured (falls back to the default database token).
 */
export function clientForRakuten(client) {
  return {
    apiBase: client.apiBase,
    token: client.rakutenToken,
    salesOrderTableId: client.rakutenSalesOrderTableId,
    shipmentOrderTableId: client.shipmentOrderTableId,
  };
}

// Baserow field IDs for filter__field_{id}__{type} URL parameters.
// These are Baserow-internal numeric IDs. Verifiied stable as of 2026-06-05.
export const BASEROW_FIELD = {
  SALES: {
    ORDER_ID: "7824209",
    PRODUCT_NAME: "7824214",
    ORIGINAL_PRODUCT_ID: "7824213",
    B2B_ITEM_CODE: "8990468",
    SHOP_ID: "7907194",
    ORDER_STATUS: "7907193",
    SHIPPING_COMPLETED_AT: "7909235",
    SHIPPING_PHONE_NUMBER: "7824241",
    SHIPPING_NAME: "7824233",
    SHIPPING_POSTAL_CODE: "7824228",
    REVIEW_STATUS: "8989067",
    AUTO_APPROVAL_RULE: "9308210",
    AUTO_APPROVED_AT: "9308212",
    AI_COPYWRITE_LOG: "9064713",
  },
  RAKUTEN_SALES: {
    ORDER_ID: "8918893",
    ORDER_STATUS: "8918896",
    MANAGE_NUMBER: "8918899",
    CONFIRM_IN_PROGRESS: "8918919",
  },
  SHIPMENT: {
    ORDER_ID: "7824253",
    SOURCE_STORE_ID: "7907499",
    GIGA_SYNC_STATUS: "7907696",
    SALES_CHANNEL: "7824251",
    SHIPPING_COMPLETED_AT: "7909235",
    CREATED_ON: "8016485",
  },
};

// Single-select option IDs for filter__field_{id}__single_select_equal={option_id}
export const BASEROW_OPTION = {
  ORDER_STATUS: {
    CANCELED: "5982564",
    WAITING_FOR_SHIPPING: "5982565",
    WAITING_FOR_PAYMENT: "5982566",
    COMPLETED: "5982567",
  },
  RAKUTEN_ORDER_STATUS: {
    PENDING_CONFIRMATION: "6444571",
    CONFIRMED: "6444572",
    RMS_CONFIRMED: "6444573",
    CANCELED: "6444574",
  },
  GIGA_SYNC_STATUS: {
    SYNCED: "5785872",
    ALREADY_EXISTS: "5785873",
    INVALID: "5785874",
    ERROR: "5785875",
  },
  REVIEW_STATUS: {
    PENDING_REVIEW: "6482438",
    APPROVED: "6482439",
    ON_HOLD: "6484637",
    // TODO: Update this ID after adding "Auto-Approved" option in Baserow
    // (Mercari Sales Orders table 903318, review_status field).
    AUTO_APPROVED: "6523828",
  },
};

// ============================================================================
// Reverse mapping: Supabase column name → Baserow field ID
// Used by translateFilterParams() so consumers can use human-readable
// FIELD constants (from db-fields.mjs) and both backends work transparently.
// ============================================================================

const FIELD_NAME_TO_ID = {
  // SALES fields
  "order_id":               "7824209",
  "product_name":           "7824214",
  "original_product_id":    "7824213",
  "b2b_item_code":          "8990468",
  "source_store_id":        "7907194",
  "order_status":           "7907193",
  "shipping_completed_at":  "7909235",
  "shipping_phone_number":  "7824241",
  "shipping_name":          "7824233",
  "shipping_postal_code":   "7824228",
  "review_status":          "8989067",
  "auto_approval_rule":     "9308210",
  "auto_approved_at":       "9308212",
  "ai_copywrite_log":       "9064713",
  // RAKUTEN_SALES fields
  "manage_number":          "8918899",
  "confirm_in_progress":    "8918919",
  // SHIPMENT fields
  "giga_sync_status":       "7907696",
  "sales_channel":          "7824251",
  "created_at":             "8016485",
};

const OPTION_VALUE_TO_ID = {
  "CANCELED":              "5982564",
  "WAITING_FOR_SHIPPING":  "5982565",
  "WAITING_FOR_PAYMENT":   "5982566",
  "COMPLETED":             "5982567",
  "PENDING_CONFIRMATION":  "6444571",
  "CONFIRMED":             "6444572",
  "RMS_CONFIRMED":         "6444573",
  "SYNCED":                "5785872",
  "ALREADY_EXISTS":        "5785873",
  "INVALID":               "5785874",
  "ERROR":                 "5785875",
  "PENDING_REVIEW":        "6482438",
  "APPROVED":              "6482439",
  "ON_HOLD":               "6484637",
  "AUTO_APPROVED":         "6523828",
};

/**
 * Translate filter params from column-name format to Baserow field-ID format.
 * Consumers use FIELD.SALES.ORDER_ID ("order_id") → baserow needs field ID "7824209".
 * Consumers use OPTION.REVIEW_STATUS.APPROVED ("APPROVED") → baserow needs option ID "6482439".
 *
 * Only translates known column names; passes through unrecognized keys unchanged
 * (backward-compatible with direct BASEROW_FIELD / BASEROW_OPTION usage).
 */
function translateFilterParams(filterParams, tableId, client) {
  if (!filterParams || !Object.keys(filterParams).length) return filterParams;

  const translated = {};
  for (const [key, value] of Object.entries(filterParams)) {
    // Parse: filter__field_{identifier}__{operator}
    const match = key.match(/^filter__field_(.+?)__(.+?)$/);
    if (match) {
      let [, identifier, operator] = match;
      // Translate column name → field ID
      // source_store_id exists in both Sales and Shipment with different
      // Baserow field IDs. Resolve it against the table being queried;
      // the global name map otherwise selects the Sales field and causes
      // ERROR_FILTER_FIELD_NOT_FOUND on shipment queries.
      const isShipmentTable = Number(tableId) === Number(client?.shipmentOrderTableId);
      const fieldId = identifier === "source_store_id" && isShipmentTable
        ? BASEROW_FIELD.SHIPMENT.SOURCE_STORE_ID
        : FIELD_NAME_TO_ID[identifier];
      if (fieldId) identifier = fieldId;

      // Translate display value → option ID for single_select filters
      let translatedValue = value;
      if ((operator === "single_select_equal" || operator === "single_select_not_equal") && !Array.isArray(value)) {
        const optionId = OPTION_VALUE_TO_ID[String(value)];
        if (optionId) translatedValue = optionId;
      } else if (operator === "single_select_equal" && Array.isArray(value)) {
        translatedValue = value.map(v => OPTION_VALUE_TO_ID[String(v)] || v);
      }

      translated[`filter__field_${identifier}__${operator}`] = translatedValue;
    } else {
      translated[key] = value;
    }
  }
  return translated;
}

export async function listAllRows(client, tableId, filterParams = {}) {
  const rows = [];
  // Translate column-name-based filter keys to Baserow field IDs
  const translatedParams = translateFilterParams(filterParams, tableId, client);
  // Keep empty strings — they are valid values for Baserow's __empty / __not_empty
  // filter operators. Only drop null/undefined (params not provided at all).
  const paramStr = Object.entries(translatedParams)
    .filter(([, v]) => v != null)
    .flatMap(([k, v]) => Array.isArray(v)
      ? v.map((item) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`)
      : [`&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`])
    .join("");
  let nextUrl = `${client.apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true&size=200${paramStr}`;
  while (nextUrl) {
    const page = await request(client, nextUrl);
    if (!page.ok) throw new Error(`baserow_list_failed:${page.error || page.status}`);
    const body = page.body && typeof page.body === "object" ? page.body : {};
    const pageRows = Array.isArray(body.results) ? body.results : [];
    rows.push(...pageRows);
    nextUrl = body.next ? normalizeNextUrl(body.next) : "";
  }
  return rows;
}

/**
 * Like listAllRows but stops after maxRows to prevent Worker timeouts.
 * Shares retry/URL-normalization logic. Returns at most maxRows rows.
 *
 * @param {Object} client - Baserow client
 * @param {number} tableId
 * @param {Object} filterParams
 * @param {number} maxRows
 * @returns {Promise<Array<Object>>}
 */
export async function listRowsWithLimit(client, tableId, filterParams = {}, maxRows = 100) {
  const rows = [];
  const translatedParams = translateFilterParams(filterParams);
  const paramStr = Object.entries(translatedParams)
    .filter(([, v]) => v != null)
    .flatMap(([k, v]) => Array.isArray(v)
      ? v.map((item) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`)
      : [`&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`])
    .join("");
  let nextUrl = `${client.apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true&size=200${paramStr}`;
  while (nextUrl && rows.length < maxRows) {
    const page = await request(client, nextUrl);
    if (!page.ok) throw new Error(`baserow_list_failed:${page.error || page.status}`);
    const body = page.body && typeof page.body === "object" ? page.body : {};
    const pageRows = Array.isArray(body.results) ? body.results : [];
    const remaining = maxRows - rows.length;
    rows.push(...pageRows.slice(0, remaining));
    nextUrl = body.next ? normalizeNextUrl(body.next) : "";
  }
  return rows;
}

export async function patchRow(client, tableId, rowId, payload) {
  const url = `${client.apiBase}/database/rows/table/${encodeURIComponent(tableId)}/${encodeURIComponent(rowId)}/?user_field_names=true`;
  const response = await fetchWithRetry(url, {
    method: "PATCH",
    headers: headers(client, true),
    body: JSON.stringify(payload || {}),
  });
  const body = await parseResponseBody(response);
  const ok = response.ok && !(body && typeof body === "object" && body.error);
  return { ok, status: response.status, body, error: ok ? null : extractError(body, response.status) };
}

export async function createRow(client, tableId, payload) {
  const url = `${client.apiBase}/database/rows/table/${encodeURIComponent(tableId)}/?user_field_names=true`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: headers(client, true),
    body: JSON.stringify(payload || {}),
  });
  const body = await parseResponseBody(response);
  const ok = response.ok && !(body && typeof body === "object" && body.error);
  return { ok, status: response.status, body, error: ok ? null : extractError(body, response.status) };
}

export async function deleteRow(client, tableId, rowId) {
  const url = `${client.apiBase}/database/rows/table/${encodeURIComponent(tableId)}/${encodeURIComponent(rowId)}/?user_field_names=true`;
  const response = await fetchWithRetry(url, {
    method: "DELETE",
    headers: headers(client, false),
  });
  const body = await parseResponseBody(response);
  const ok = response.ok && !(body && typeof body === "object" && body.error);
  return { ok, status: response.status, body, error: ok ? null : extractError(body, response.status) };
}

function headers(client, includeJson) {
  const out = { accept: "application/json" };
  if (includeJson) out["content-type"] = "application/json";
  out.authorization = `Token ${client.token}`;
  return out;
}

async function request(client, url) {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: headers(client, false),
  });
  const body = await parseResponseBody(response);
  const ok = response.ok && !(body && typeof body === "object" && body.error);
  return { ok, status: response.status, body, error: ok ? null : extractError(body, response.status) };
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (!shouldRetryStatus(res.status) || attempt === maxAttempts) return res;
      await sleep(retryDelayMs(attempt, res.status));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
      await sleep(retryDelayMs(attempt, 0));
    }
  }
  throw lastError || new Error("baserow_fetch_failed");
}

function shouldRetryStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(attempt, status) {
  const base = status === 429 ? 1200 : 800;
  return Math.min(15000, base * Math.pow(2, attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractError(body, status) {
  if (typeof body === "string") return `${status}:${body.substring(0, 300)}`;
  if (body && typeof body === "object") {
    return trimAndCollapse(body.error) || trimAndCollapse(body.detail) || trimAndCollapse(body.message) || String(status);
  }
  return String(status);
}

function normalizeNextUrl(url) {
  const parsed = new URL(String(url || "").trim());
  if (parsed.hostname === "api.baserow.io" && parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.toString();
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim() || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function trimAndCollapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
