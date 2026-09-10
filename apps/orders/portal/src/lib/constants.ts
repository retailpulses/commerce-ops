export const SHOP_LABELS: Record<string, string> = {
  WMyisFmhbGWyVAPEwsfirn: "Shop1",
  ZaMyGWzp6hUdgDh5E9ADob: "Shop2",
  "2JGrmZqojnBMfdWrtP2xk3": "Shop3",
  "2JMLHBxjiFHDr55jMwA7fs": "Shop4",
};

export const SHOP_NAMES = ["Shop1", "Shop2", "Shop3", "Shop4"] as const;

export const PAGE_SIZE = 50;

export const DELIVERY_TIME_SLOTS = [
  "08:00-12:00",
  "14:00-16:00",
  "16:00-18:00",
  "18:00-20:00",
  "19:00-21:00",
] as const;

export function shopLabel(shopId: string): string {
  return SHOP_LABELS[shopId] || shopId;
}

export function fmtYen(n: number | null | undefined): string {
  if (n == null) return "—";
  return `¥${Math.round(n).toLocaleString()}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function relativeTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatJstDisplay(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min} JST`;
  } catch {
    return isoStr;
  }
}
