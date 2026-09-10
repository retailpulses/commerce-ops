/** KV-backed reply template storage.
 *  Key pattern: template:<uuid>
 *  Same pattern as OrderMgmt's portal-templates.mjs.
 */

import type { ReplyTemplate, TemplateCategory, TemplateBehavior } from "../types";
import { extractVariables, validateVariables } from "../logic/template-engine";

const TEMPLATE_KEY_PREFIX = "template:";

// Valid enum values enforced at create/update
const VALID_CATEGORIES = new Set([
  "greeting_only", "information_only", "holding", "fuguai", "fuguai_lite",
  "followup_form_helper", "cancel_fee", "form_received_ack", "custom",
]);
const VALID_BEHAVIORS = new Set([
  "informational_ack", "holding_ack", "form_request", "cancel_fee", "custom",
]);

function generateId(): string {
  return crypto.randomUUID();
}

function templateKey(id: string): string {
  return `${TEMPLATE_KEY_PREFIX}${id}`;
}

function normalizeStoredTemplate(raw: Record<string, unknown>, id: string): ReplyTemplate & { _kv_id: string } {
  return {
    id: 0, // not used in KV — id is the UUID string in _kv_id
    title: String(raw.title || ""),
    category: (String(raw.category || "custom")) as TemplateCategory,
    behavior: (String(raw.behavior || "custom")) as TemplateBehavior,
    body: String(raw.body || ""),
    variables: String(raw.variables || ""),
    is_active: raw.is_active !== false,
    notes: String(raw.notes || ""),
    version: typeof raw.version === "number" ? raw.version : 1,
    created_at: String(raw.created_at || ""),
    updated_at: String(raw.updated_at || ""),
    _kv_id: id,
  } as ReplyTemplate & { _kv_id: string };
}

function serializeTemplate(t: ReplyTemplate): Record<string, unknown> {
  return {
    title: t.title,
    category: t.category,
    behavior: t.behavior,
    body: t.body,
    variables: t.variables,
    is_active: t.is_active,
    notes: t.notes,
    version: t.version,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** List all templates (active optional). */
export async function listTemplates(
  KV: KVNamespace,
  opts?: { isActive?: boolean; category?: string }
): Promise<(ReplyTemplate & { _kv_id: string })[]> {
  const result: (ReplyTemplate & { _kv_id: string })[] = [];
  const list = await KV.list({ prefix: TEMPLATE_KEY_PREFIX });

  for (const key of list.keys) {
    try {
      const raw = await KV.get(key.name, "json");
      if (raw && typeof raw === "object") {
        const data = raw as Record<string, unknown>;
        const id = key.name.slice(TEMPLATE_KEY_PREFIX.length);
        const t = normalizeStoredTemplate(data, id);

        if (opts?.isActive === true && !t.is_active) continue;
        if (opts?.category && t.category !== opts.category) continue;

        result.push(t);
      }
    } catch {
      // skip corrupted entries
    }
  }

  // Sort by updated_at descending (newest first)
  result.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return result;
}

/** Get a single template by KV ID. */
export async function getTemplate(
  KV: KVNamespace,
  id: string
): Promise<(ReplyTemplate & { _kv_id: string }) | null> {
  try {
    const raw = await KV.get(templateKey(id), "json");
    if (raw && typeof raw === "object") {
      return normalizeStoredTemplate(raw as Record<string, unknown>, id);
    }
  } catch {
    // fall through
  }
  return null;
}

/** Create a new template. */
export async function createTemplate(
  KV: KVNamespace,
  fields: { title: string; category: string; behavior: string; body: string; notes?: string }
): Promise<ReplyTemplate & { _kv_id: string }> {
  // Validate category
  if (!VALID_CATEGORIES.has(fields.category)) {
    throw new Error(`Invalid category: ${fields.category}`);
  }
  // Validate behavior
  if (!VALID_BEHAVIORS.has(fields.behavior)) {
    throw new Error(`Invalid behavior: ${fields.behavior}`);
  }
  // Extract and validate variables from body
  const vars = extractVariables(fields.body);
  const validation = validateVariables(vars);
  if (!validation.valid) {
    throw new Error(`Unknown variables: ${validation.unknown.join(", ")}`);
  }

  const id = generateId();
  const now = new Date().toISOString();
  const record: Record<string, unknown> = {
    title: fields.title,
    category: fields.category,
    behavior: fields.behavior,
    body: fields.body,
    variables: vars.join(", "),
    is_active: true,
    notes: fields.notes || "",
    version: 1,
    created_at: now,
    updated_at: now,
  };

  await KV.put(templateKey(id), JSON.stringify(record));
  return normalizeStoredTemplate(record, id);
}

/** Update an existing template. Increments version. */
export async function updateTemplate(
  KV: KVNamespace,
  id: string,
  fields: { title?: string; category?: string; behavior?: string; body?: string; notes?: string; isActive?: boolean }
): Promise<(ReplyTemplate & { _kv_id: string }) | null> {
  const existing = await getTemplate(KV, id);
  if (!existing) return null;

  // Validate enums if provided
  if (fields.category && !VALID_CATEGORIES.has(fields.category)) {
    throw new Error(`Invalid category: ${fields.category}`);
  }
  if (fields.behavior && !VALID_BEHAVIORS.has(fields.behavior)) {
    throw new Error(`Invalid behavior: ${fields.behavior}`);
  }

  // If body changed, recompute and validate variables
  const newBody = fields.body ?? existing.body;
  let variables: string;
  if (fields.body !== undefined) {
    const vars = extractVariables(newBody);
    const validation = validateVariables(vars);
    if (!validation.valid) {
      throw new Error(`Unknown variables: ${validation.unknown.join(", ")}`);
    }
    variables = vars.join(", ");
  } else {
    variables = existing.variables;
  }

  const now = new Date().toISOString();
  const updated: Record<string, unknown> = {
    title: fields.title ?? existing.title,
    category: fields.category ?? existing.category,
    behavior: fields.behavior ?? existing.behavior,
    body: newBody,
    variables,
    is_active: fields.isActive ?? existing.is_active,
    notes: fields.notes ?? existing.notes,
    version: (existing.version || 1) + 1,
    created_at: existing.created_at,
    updated_at: now,
  };

  await KV.put(templateKey(id), JSON.stringify(updated));
  return normalizeStoredTemplate(updated, id);
}

/** Soft-delete: set is_active = false. */
export async function softDeleteTemplate(KV: KVNamespace, id: string): Promise<boolean> {
  const existing = await getTemplate(KV, id);
  if (!existing) return false;

  await updateTemplate(KV, id, { isActive: false });
  return true;
}
