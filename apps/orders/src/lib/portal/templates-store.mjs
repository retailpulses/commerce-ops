// Supabase-backed message-templates store.
// Replaces Cloudflare KV for Portal template CRUD on the VPS Portal API.
// The Worker (which still has KV) continues to use KV directly.
//
// The order_message_templates table was created by
// supabase/migrations/20260710000000_order_mgmt_core.sql.
//
// Field mapping (frontend ↔ database):
//   FE "title"       ↔ DB "name"
//   FE "body"        ↔ DB "body"
//   FE "subject"     ↔ DB "subject"
//   FE "category"    ↔ DB "category"
//   FE "sort_order"  ↔ DB "sort_order"
//   FE "created_by"  ↔ DB "created_by"

import { createBaserowClient } from "../db.mjs";

// ── DB row → FE template ─────────────────────────────────────────────

function toTemplate(row) {
  return {
    id: row.id,
    title: row.name,           // DB "name" → FE "title"
    body: row.body ?? "",
    subject: row.subject ?? "",
    category: row.category ?? "",
    sort_order: typeof row.sort_order === "number" ? row.sort_order : 0,
    is_active: row.is_active !== false,
    created_by: row.created_by ?? "",
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

// ── Lazy Supabase client ─────────────────────────────────────────────

let _sb = null;
let _sbEnvKey = null;

function getSupabase(env) {
  // Cache the client per env identity to avoid repeated createClient calls
  const key = String(env.SUPABASE_URL ?? "") + "|" + String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").slice(0, 8);
  if (_sb && _sbEnvKey === key) return _sb;

  const client = createBaserowClient(env);
  if (client.type !== "supabase" || !client.supabase) {
    throw new Error("templates-store requires DATABASE_BACKEND=supabase");
  }
  _sb = client.supabase;
  _sbEnvKey = key;
  return _sb;
}

// ── Public API ───────────────────────────────────────────────────────

export async function listTemplates(env) {
  const sb = getSupabase(env);
  const { data, error } = await sb
    .from("order_message_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[templates-store] list:", error.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  return { ok: true, templates: (data ?? []).map(toTemplate) };
}

export async function getTemplate(env, id) {
  const sb = getSupabase(env);
  const { data, error } = await sb
    .from("order_message_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[templates-store] get:", error.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  if (!data) return { ok: false, error: "template_not_found", statusCode: 404 };
  return { ok: true, template: toTemplate(data) };
}

export async function createTemplate(env, fields) {
  const sb = getSupabase(env);
  const name = String(fields.title ?? "").trim();
  const body = String(fields.body ?? "").trim();

  if (!name) return { ok: false, error: "template_title_required", statusCode: 400 };
  if (!body) return { ok: false, error: "template_body_required", statusCode: 400 };

  // Duplicate check
  const { data: dup } = await sb
    .from("order_message_templates")
    .select("id")
    .eq("name", name)
    .eq("is_active", true)
    .maybeSingle();
  if (dup) return { ok: false, error: "template_title_duplicate", statusCode: 400 };

  // Compute next sort_order (new templates appear at top)
  const { data: top } = await sb
    .from("order_message_templates")
    .select("sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = (top?.sort_order ?? 0) + 1;

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("order_message_templates")
    .insert({
      name,
      body,
      subject: String(fields.subject ?? "").trim(),
      category: String(fields.category ?? "").trim(),
      sort_order: fields.sort_order ?? nextSort,
      is_active: true,
      created_by: String(fields.created_by ?? "operator").trim(),
    })
    .select("*")
    .single();

  if (error) {
    console.error("[templates-store] create:", error.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  return { ok: true, template: toTemplate(data) };
}

export async function updateTemplate(env, id, fields) {
  const sb = getSupabase(env);

  const { data: existing } = await sb
    .from("order_message_templates")
    .select("id,name")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "template_not_found", statusCode: 404 };

  const name = String(fields.title ?? "").trim();
  const body = String(fields.body ?? "").trim();

  if (!name) return { ok: false, error: "template_title_required", statusCode: 400 };
  if (!body) return { ok: false, error: "template_body_required", statusCode: 400 };

  // Duplicate check (exclude self)
  const { data: dup } = await sb
    .from("order_message_templates")
    .select("id")
    .eq("name", name)
    .eq("is_active", true)
    .neq("id", id)
    .maybeSingle();
  if (dup) return { ok: false, error: "template_title_duplicate", statusCode: 400 };

  const update = { name, body, updated_at: new Date().toISOString() };
  if (fields.subject !== undefined) update.subject = String(fields.subject || "").trim();
  if (fields.category !== undefined) update.category = String(fields.category || "").trim();
  if (fields.sort_order !== undefined) update.sort_order = fields.sort_order;

  const { data, error } = await sb
    .from("order_message_templates")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[templates-store] update:", error.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  return { ok: true, template: toTemplate(data) };
}

export async function deleteTemplate(env, id) {
  const sb = getSupabase(env);

  // Soft-delete
  const { data: existing } = await sb
    .from("order_message_templates")
    .select("id")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();
  if (!existing) return { ok: false, error: "template_not_found", statusCode: 404 };

  const { error } = await sb
    .from("order_message_templates")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[templates-store] delete:", error.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  return { ok: true };
}

export async function reorderTemplates(env, id, direction) {
  const listResult = await listTemplates(env);
  if (!listResult.ok || !listResult.templates.length) {
    return { ok: false, error: "no_templates", statusCode: 400 };
  }

  const templates = listResult.templates;
  const idx = templates.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: "template_not_found", statusCode: 404 };

  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= templates.length) {
    return { ok: false, error: "already_at_edge", statusCode: 400 };
  }

  const current = templates[idx];
  const target = templates[targetIdx];
  const curSort = current.sort_order;
  const tgtSort = target.sort_order;

  let newCurSort, newTgtSort;
  if (curSort === tgtSort) {
    if (direction === "up") {
      newCurSort = tgtSort + 1;
      newTgtSort = tgtSort;
    } else {
      newCurSort = tgtSort - 1;
      newTgtSort = tgtSort;
    }
  } else {
    newCurSort = tgtSort;
    newTgtSort = curSort;
  }

  const sb = getSupabase(env);
  const now = new Date().toISOString();
  const [r1, r2] = await Promise.all([
    sb.from("order_message_templates").update({ sort_order: newCurSort, updated_at: now }).eq("id", current.id),
    sb.from("order_message_templates").update({ sort_order: newTgtSort, updated_at: now }).eq("id", target.id),
  ]);

  if (r1.error || r2.error) {
    console.error("[templates-store] reorder:", r1.error?.message, r2.error?.message);
    return { ok: false, error: "db_error", statusCode: 500 };
  }
  return { ok: true };
}
