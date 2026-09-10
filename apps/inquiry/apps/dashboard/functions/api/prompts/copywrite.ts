import { getActivePrompt, listVersions, createPromptVersion } from "../../_lib/prompts";
import { COPYWRITE_DEFAULT_PROMPT } from "../../_lib/openai";

type Env = Record<string, string> & {
  TEMPLATES_KV?: KVNamespace;
};

/** GET /api/prompts/copywrite — get current active prompt and version history */
export async function onRequestGet(context: {
  request: Request;
  env: Env;
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "TEMPLATES_KV is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const active = await getActivePrompt(context.env.TEMPLATES_KV);
    const versions = await listVersions(context.env.TEMPLATES_KV);

    return new Response(
      JSON.stringify({
        active: active
          ? { version: active.version, text: active.text }
          : { version: 0, text: COPYWRITE_DEFAULT_PROMPT, isDefault: true },
        versions: versions.map((v) => ({
          version: v.version,
          text: v.text,
          active: v.active,
          createdAt: v.createdAt,
        })),
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch prompts";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** PUT /api/prompts/copywrite — save a new prompt version */
export async function onRequestPut(context: {
  request: Request;
  env: Env;
}) {
  if (!context.env.TEMPLATES_KV) {
    return new Response(JSON.stringify({ error: "TEMPLATES_KV is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { text?: string };
  try {
    body = (await context.request.json()) as { text?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
    return new Response(JSON.stringify({ error: "text (non-empty string) is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const created = await createPromptVersion(context.env.TEMPLATES_KV, body.text);
    const versions = await listVersions(context.env.TEMPLATES_KV);

    return new Response(
      JSON.stringify({
        success: true,
        active: { version: created.version, text: created.text },
        versions: versions.map((v) => ({
          version: v.version,
          text: v.text,
          active: v.active,
          createdAt: v.createdAt,
        })),
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save prompt";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
