import { listTemplates, createTemplate } from "../../_lib/templates";

interface TemplatesEnv {
  TEMPLATES_KV: KVNamespace;
}

/** GET /api/templates — list all templates */
export async function onRequestGet(context: {
  request: Request;
  env: TemplatesEnv;
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "kv_unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const templates = await listTemplates(context.env.TEMPLATES_KV);
    return new Response(
      JSON.stringify({ templates }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (_) {
    return new Response(JSON.stringify({ error: "kv_unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** POST /api/templates — create a new template */
export async function onRequestPost(context: {
  request: Request;
  env: TemplatesEnv;
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "kv_unavailable" }), {
      status: 500,
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
    const template = await createTemplate(context.env.TEMPLATES_KV, title, bodyText);
    return new Response(
      JSON.stringify({ ok: true, template }),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "kv_unavailable";
    const status = message === "template_title_duplicate" ? 400 : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
