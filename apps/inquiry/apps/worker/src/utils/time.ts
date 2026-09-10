export const JST_OFFSET = 9 * 60 * 60 * 1000;

export function nowJST(): Date {
  const utc = Date.now();
  return new Date(utc + JST_OFFSET);
}

export function parseToJST(tsStr: string): Date | null {
  try {
    const isoStr = tsStr.replace("+00:00", "Z");
    const utcMs = Date.parse(isoStr);
    if (isNaN(utcMs)) return null;
    return new Date(utcMs + JST_OFFSET);
  } catch {
    return null;
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function formatJSTCompact(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  return `${y}年${mo}月${day}日 ${h}:${m}`;
}

export function formatJSTDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${y}年${mo}月${day}日`;
}

export function formatCursorUTC(d: Date): string {
  const utc = new Date(d.getTime() - JST_OFFSET);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}
