// ── JST Timezone Helpers ──────────────────────────────────────────
//
// Deterministic JST date/time operations using Intl.DateTimeFormat
// with timeZone: "Asia/Tokyo". No manual epoch-shift trickery.
//
// Exports:
//   getJstDateParts(date)   → { year, month, day, hour, minute }
//   formatJstDate(date)     → "YYYY-MM-DD"
//   formatJstDateTime(date) → "2026年6月12日 09:30"
//   toJstIso(value)         → ISO 8601 with +09:00 offset
//   getJstEarliestDeliveryDate() → "YYYY-MM-DD" per GigaB2B rules
// ──────────────────────────────────────────────────────────────────

const JST = "Asia/Tokyo";

/**
 * Extract JST calendar parts from a Date or ISO string.
 * Uses Intl.DateTimeFormat.formatToParts() for accuracy.
 *
 * @param {Date|string} date
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
 */
export function getJstDateParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return { year: 0, month: 0, day: 0, hour: 0, minute: 0 };

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return {
    year: map.year || 0,
    month: map.month || 0,
    day: map.day || 0,
    hour: map.hour || 0,
    minute: map.minute || 0,
  };
}

/**
 * Format a date as "YYYY-MM-DD" in JST.
 *
 * @param {Date|string} date
 * @returns {string}
 */
export function formatJstDate(date) {
  const parts = getJstDateParts(date);
  if (!parts.year) return "";
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

/**
 * Format a date as "2026年6月12日 09:30" in JST.
 *
 * @param {Date|string} date
 * @returns {string}
 */
export function formatJstDateTime(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const year = String(map.year || "").trim();
  const month = String(map.month || "").trim();
  const day = String(map.day || "").trim();
  const hour = String(map.hour || "").trim().padStart(2, "0");
  const minute = String(map.minute || "").trim().padStart(2, "0");
  return `${year}年${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
}

/**
 * Convert a Date or timestamp to ISO 8601 with +09:00 offset,
 * preserving the absolute instant. Suitable for transport to
 * frontends that parse +09:00 correctly.
 *
 * @param {Date|string} value
 * @returns {string}
 */
export function toJstIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/Z$/i, "+09:00");
}

/**
 * Compute the earliest eligible requested_delivery_date per GigaB2B rules:
 * - Orders uploaded by 11:00 AM JST → earliest = 3rd day from upload
 * - Orders uploaded after 11:00 AM JST → earliest = 4th day from upload
 *
 * Returns "YYYY-MM-DD" string.
 *
 * @returns {string}
 */
export function getJstEarliestDeliveryDate() {
  const now = new Date();
  const parts = getJstDateParts(now);
  const daysToAdd = parts.hour < 11 ? 3 : 4;

  const earliest = new Date(now.getTime() + daysToAdd * 86400000);
  return formatJstDate(earliest);
}
