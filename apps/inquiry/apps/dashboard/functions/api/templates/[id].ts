import { updateTemplate, deleteTemplate } from "../../_lib/templates";

interface TemplatesEnv {
  TEMPLATES_KV: KVNamespace;
}

/** PUT /api/templates/:id — update a template */
export async function onRequestPut(context: {
  request: Request;
  env: TemplatesEnv;
  params: { id: string };
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "kv_unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { id } = context.params;
  if (!id) {
    return new Response(JSON.stringify({ error: "template_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { title?: string; body?: string };
  try {
    body = (await context.request.json()) as { title?: string; body?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const title = (body.title || "").trim();
  const bodyText = (body.body || "").trim();

  if (!title) {
    return new Response(JSON.stringify({ error: "template_title_required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (!bodyText) {
    return new Response(JSON.stringify({ error: "template_body_required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const template = await updateTemplate(context.env.TEMPLATES_KV, id, title, bodyText);
    return new Response(
      JSON.stringify({ ok: true, template }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "kv_unavailable";
    const status = message === "template_not_found" ? 404
      : message === "template_title_duplicate" ? 400
      : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** DELETE /api/templates/:id — delete a template */
export async function onRequestDelete(context: {
  request: Request;
  env: TemplatesEnv;
  params: { id: string };
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "kv_unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { id } = context.params;
  if (!id) {
    return new Response(JSON.stringify({ error: "template_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    await deleteTemplate(context.env.TEMPLATES_KV, id);
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "kv_unavailable";
    const status = message === "template_not_found" ? 404 : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
