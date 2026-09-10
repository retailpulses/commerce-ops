/**
 * Shared template helpers for message templates.
 *
 * Supports dual backend: Cloudflare KV (Worker) and Supabase (VPS Portal API).
 * Other modules (e.g. auto-approval) can look up templates without duplicating
 * backend logic.
 *
 * KV path:
 *   Key:   template:<uuid>
 *   Value: { title, body, sort_order, created_at, updated_at }
 *
 * Supabase path:
 *   Table: order_message_templates (via templates-store.mjs)
 */

import { listTemplates as sbListTemplates } from "./portal/templates-store.mjs";

/**
 * List all templates.
 * Supabase is the canonical store (primary). KV is a legacy fallback
 * during the cutover window. This ordering prevents template divergence:
 * VPS portal writes → Supabase, Worker auto-approval reads → Supabase.
 *
 * @param {Object} env — Worker env or process.env
 * @returns {Promise<Array<{id: string, title: string, body: string, sort_order: number, created_at: string, updated_at: string}>>}
 */
export async function listTemplates(env) {
  // Supabase is canonical (primary source)
  if (isSupabaseBackend(env)) {
    try {
      const result = await sbListTemplates(env);
      if (result.ok && result.templates) return result.templates;
    } catch (_) {
      /* fall through to KV */
    }
  }

  // KV fallback (legacy — templates not yet migrated, or Supabase unavailable)
  if (env?.PORTAL_KV) {
    try {
      const list = await env.PORTAL_KV.list({ prefix: "template:" });
      const keys = list.keys || [];
      const templates = [];
      for (const key of keys) {
        try {
          const value = await env.PORTAL_KV.get(key.name, "json");
          if (value) {
            templates.push({ id: key.name.replace("template:", ""), ...value });
          }
        } catch (_) {
          /* skip corrupt entries */
        }
      }
      return templates;
    } catch (_) {
      /* non-fatal */
    }
  }

  return [];
}

/**
 * Find a template by exact title match.
 * Returns the first match if multiple templates share the same title.
 * Returns null if no backend is available, no match found, or on error.
 *
 * @param {Object} env — Worker env or process.env
 * @param {string} title — exact title to match
 * @returns {Promise<{id: string, title: string, body: string, sort_order: number, created_at: string, updated_at: string}|null>}
 */
export async function findTemplateByTitle(env, title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return null;
  try {
    const templates = await listTemplates(env);
    return templates.find((t) => t.title === trimmed) || null;
  } catch (_) {
    return null;
  }
}

function isSupabaseBackend(env) {
  return String(env?.DATABASE_BACKEND || "").trim().toLowerCase() === "supabase";
}
