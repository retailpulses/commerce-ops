const NONCE_PREFIX = "nonce:";
const NONCE_TTL_MS = 5 * 60 * 1000;

export class TicketShareReplayGuard {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let nonce = "";
    try {
      const body = await request.json() as { nonce?: unknown };
      nonce = typeof body.nonce === "string" ? body.nonce : "";
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return new Response(null, { status: 400 });

    const claimed = await this.state.storage.transaction(async (transaction) => {
      const key = `${NONCE_PREFIX}${nonce}`;
      if (await transaction.get(key) !== undefined) return false;
      await transaction.put(key, Date.now() + NONCE_TTL_MS);
      if (await transaction.getAlarm() === null) await transaction.setAlarm(Date.now() + NONCE_TTL_MS);
      return true;
    });
    return new Response(null, { status: claimed ? 201 : 409 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<number>({ prefix: NONCE_PREFIX });
    const expired = [...entries].filter(([, expiresAt]) => expiresAt <= now).map(([key]) => key);
    if (expired.length > 0) await this.state.storage.delete(expired);
    const remaining = [...entries].filter(([key, expiresAt]) => !expired.includes(key) && expiresAt > now);
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Math.min(...remaining.map(([, expiresAt]) => expiresAt)));
    }
  }
}

export async function claimTicketShareNonce(namespace: DurableObjectNamespace, nonce: string): Promise<boolean> {
  const guard = namespace.get(namespace.idFromName("ticket-share-replay-v1"));
  const response = await guard.fetch("https://ticket-share-replay.internal/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  if (response.status === 201) return true;
  if (response.status === 409) return false;
  throw new Error(`replay guard unavailable (${response.status})`);
}
