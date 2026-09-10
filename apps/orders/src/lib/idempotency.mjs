/**
 * Dual-backend idempotency guard for replacing Cloudflare KV auto-msg:*
 * and reply-sent:* keys.
 *
 * Tries KV first (Worker), falls back to Supabase (VPS Portal API).
 * Guards are permanent by default; set a TTL (in seconds) for short-lived
 * guards like reply dedup (60s).
 *
 * Return values:
 *   "acquired"      — guard was newly set, proceed with operation
 *   "duplicate"     — guard already exists (active, non-expired), skip operation
 *   "backend_error" — neither KV nor Supabase available, fail closed
 *
 * Supabase table: idempotency_guards (created by migration 20260728012328)
 */

import { createBaserowClient } from "./db.mjs";

/**
 * Check whether a guard key already exists (idempotency check).
 * Expired guards are treated as absent.
 *
 * @param {Object} env — Worker env or process.env
 * @param {string} guardKey — e.g. "auto-msg:v2:order123:2026-07-28T..."
 * @returns {Promise<boolean>}
 */
export async function checkIdempotencyGuard(env, guardKey) {
  // KV path (Worker)
  if (env?.PORTAL_KV) {
    try {
      const existing = await env.PORTAL_KV.get(guardKey);
      if (existing) return true;
    } catch (_) {
      /* fall through to Supabase */
    }
  }

  // Supabase fallback (VPS Portal API)
  if (isSupabaseBackend(env)) {
    try {
      const client = createBaserowClient(env);
      if (client.type !== "supabase" || !client.supabase) return false;
      const { data, error } = await client.supabase
        .from("idempotency_guards")
        .select("id")
        .eq("guard_key", guardKey)
        .or("expires_at.is.null,expires_at.gt.now()")
        .maybeSingle();
      if (error) {
        console.warn("[idempotency] guard check failed:", error.message);
        return false;
      }
      return !!data;
    } catch (_) {
      /* non-fatal */
    }
  }

  return false;
}

/**
 * Atomically acquire an idempotency guard.
 *
 * For Supabase: INSERT with unique constraint provides atomic acquisition.
 * Expired rows are cleaned up before insert to allow re-acquisition.
 *
 * Callers MUST use this return value to gate operations:
 *   "acquired"      → proceed
 *   "duplicate"     → skip (already performed)
 *   "backend_error" → fail closed
 *
 * @param {Object} env — Worker env or process.env
 * @param {string} guardKey — unique guard key
 * @param {{ ttlSeconds?: number }} options — TTL in seconds (default: permanent)
 * @returns {Promise<"acquired"|"duplicate"|"backend_error">}
 */
export async function setIdempotencyGuard(env, guardKey, { ttlSeconds } = {}) {
  // KV path (Worker) — KV lacks atomic check-and-set, so pre-check before put
  if (env?.PORTAL_KV) {
    try {
      const existing = await env.PORTAL_KV.get(guardKey);
      if (existing) return "duplicate";
      const kvOpts = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
      await env.PORTAL_KV.put(guardKey, "1", kvOpts);
      return "acquired";
    } catch (_) {
      /* fall through to Supabase */
    }
  }

  // Supabase fallback (VPS Portal API)
  if (isSupabaseBackend(env)) {
    try {
      const client = createBaserowClient(env);
      if (client.type !== "supabase" || !client.supabase) return "backend_error";

      // Clean up any expired row with the same key before insert.
      // This is safe: if two callers race, one cleans + inserts, the other
      // hits the unique constraint and gets "duplicate".
      if (ttlSeconds) {
        await client.supabase
          .from("idempotency_guards")
          .delete()
          .eq("guard_key", guardKey)
          .lte("expires_at", new Date().toISOString());
      }

      const expiresAt = ttlSeconds
        ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
        : null;

      const { error } = await client.supabase
        .from("idempotency_guards")
        .insert({
          guard_key: guardKey,
          expires_at: expiresAt,
        });

      if (error) {
        if (error.code === "23505") return "duplicate";
        console.warn("[idempotency] guard set failed:", error.message);
        return "backend_error";
      }
      return "acquired";
    } catch (_) {
      /* non-fatal */
    }
  }

  return "backend_error";
}

/**
 * Delete an idempotency guard (e.g., release after delivery failure).
 *
 * @param {Object} env — Worker env or process.env
 * @param {string} guardKey
 * @returns {Promise<void>}
 */
export async function deleteIdempotencyGuard(env, guardKey) {
  // KV path (Worker)
  if (env?.PORTAL_KV) {
    try {
      await env.PORTAL_KV.delete(guardKey);
      return;
    } catch (_) {
      /* fall through */
    }
  }

  // Supabase fallback
  if (isSupabaseBackend(env)) {
    try {
      const client = createBaserowClient(env);
      if (client.type !== "supabase" || !client.supabase) return;
      await client.supabase
        .from("idempotency_guards")
        .delete()
        .eq("guard_key", guardKey);
    } catch (_) {
      /* non-fatal */
    }
  }
}

function isSupabaseBackend(env) {
  return String(env?.DATABASE_BACKEND || "").trim().toLowerCase() === "supabase";
}
