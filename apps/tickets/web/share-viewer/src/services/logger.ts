let requestIdStore = new WeakMap<object, string>();

export function setRequestId(ctx: object, id: string): void {
  requestIdStore.set(ctx, id);
}

export function getRequestId(ctx: object): string {
  return requestIdStore.get(ctx) || "unknown";
}

function fmt(level: string, message: string, extra?: Record<string, string>): string {
  const ts = new Date().toISOString();
  const parts = [ts, level, message];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(" ");
}

export const log = {
  info(message: string, extra?: Record<string, string>): void {
    console.log(fmt("INFO", message, extra));
  },
  warn(message: string, extra?: Record<string, string>): void {
    console.warn(fmt("WARN", message, extra));
  },
  error(message: string, extra?: Record<string, string>): void {
    console.error(fmt("ERROR", message, extra));
  },
};
