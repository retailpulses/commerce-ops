export interface Template {
  id: string; // UUID, matches OrderMgmt
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_PREFIX = "template:";

/** List all templates, newest first (matches OrderMgmt handlePortalTemplatesList) */
export async function listTemplates(
  kv: KVNamespace,
): Promise<Template[]> {
  try {
    const list = await kv.list({ prefix: TEMPLATE_PREFIX });
    const keys = list.keys || [];
    const templates: Template[] = [];
    for (const key of keys) {
      try {
        const value = await kv.get(key.name, "json");
        if (value) {
          templates.push({
            id: key.name.replace(TEMPLATE_PREFIX, ""),
            ...(value as Omit<Template, "id">),
          });
        }
      } catch (_) {
        // skip corrupt entries
      }
    }
    templates.sort((a, b) =>
      (b.created_at || "") > (a.created_at || "") ? 1 : -1,
    );
    return templates;
  } catch (_) {
    return [];
  }
}

/** Create a new template (matches OrderMgmt handlePortalTemplatesCreate) */
export async function createTemplate(
  kv: KVNamespace,
  title: string,
  body: string,
): Promise<Template> {
  // Check duplicate title
  const existing = await listTemplates(kv);
  if (existing.some((t) => t.title === title)) {
    throw new Error("template_title_duplicate");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = { title, body, created_at: now, updated_at: now };
  await kv.put(`${TEMPLATE_PREFIX}${id}`, JSON.stringify(record));
  return { id, ...record };
}

/** Update an existing template (matches OrderMgmt handlePortalTemplatesUpdate) */
export async function updateTemplate(
  kv: KVNamespace,
  id: string,
  title: string,
  body: string,
): Promise<Template> {
  const key = `${TEMPLATE_PREFIX}${id}`;
  const existing = await kv.get(key, "json");
  if (!existing) {
    throw new Error("template_not_found");
  }

  // Check duplicate title (exclude self)
  const list = await listTemplates(kv);
  if (list.some((t) => t.title === title && t.id !== id)) {
    throw new Error("template_title_duplicate");
  }

  const row = existing as { created_at?: string };
  const now = new Date().toISOString();
  const record = {
    title,
    body,
    created_at: row.created_at || now,
    updated_at: now,
  };
  await kv.put(key, JSON.stringify(record));
  return { id, ...record };
}

/** Delete a template by ID (matches OrderMgmt handlePortalTemplatesDelete) */
export async function deleteTemplate(
  kv: KVNamespace,
  id: string,
): Promise<void> {
  const key = `${TEMPLATE_PREFIX}${id}`;
  const existing = await kv.get(key, "json");
  if (!existing) {
    throw new Error("template_not_found");
  }
  await kv.delete(key);
}
