/** Format an ISO date string to a readable Japanese date */
export function formatDate(iso: string | null): string {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Format a datetime string to readable format */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Format a datetime in Japan Standard Time for operator-facing SLA timestamps */
export function formatDateTimeJst(iso: string | null): string {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** Truncate a string to max length */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** Get the first character for an avatar */
export function avatarChar(name: string): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

/** Ensure URL has https:// prefix */
export function normalizeUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

/** Format a numeric price as ¥1,234 or -- if null */
export function formatPrice(value: number | null): string {
  if (value === null || value === undefined) return "--";
  return `¥${value.toLocaleString("ja-JP")}`;
}
