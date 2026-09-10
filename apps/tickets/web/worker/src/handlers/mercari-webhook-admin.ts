/** Narrow admin handler for Mercari webhook setup.
 *
 *  This is protected by WEBHOOK_SHARED_SECRET and routes Mercari GraphQL through
 *  the existing VPS proxy, so Mercari still sees the fixed Conoha IPv4.
 */

import { runGraphQL } from "../clients/mercari";
import { SHOP_TOKENS } from "../config/shops";
import { validateSession } from "../middleware/auth";
import type { Env } from "../types";

const DEFAULT_TOPIC = "ORDER_TRANSACTION_MESSAGE_CREATED";

type AdminBody = {
  shop?: string;
  action?: "graphql" | "create" | "list";
  query?: string;
  variables?: Record<string, unknown>;
  endpoint?: string;
  topic?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ success: false, error: message }, status);
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  // Auth method 1: WEBHOOK_SHARED_SECRET
  const expected = env.WEBHOOK_SHARED_SECRET;
  if (expected) {
    const url = new URL(request.url);
    const authHeader = request.headers.get("Authorization") || "";
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const querySecret = url.searchParams.get("secret") || "";
    if (bearer === expected || querySecret === expected) return true;
  }
  // Auth method 2: workspace session token
  if (await validateSession(request, env.MERCARI_REPORTS)) return true;
  return false;
}

function isAllowedWebhookGraphQL(query: string): boolean {
  const normalized = query.replace(/\s+/g, " ").toLowerCase();
  if (!normalized.includes("webhook") && !normalized.includes("__schema") && !normalized.includes("__type")) {
    return false;
  }

  const blocked = [
    "addordertransactionmessage",
    "ordertransaction(",
    "ordertransactions(",
    "product",
    "inventory",
  ];
  return !blocked.some((term) => normalized.includes(term));
}

/**
 * Ensure all configured shops have the ORDER_TRANSACTION_MESSAGE_CREATED
 * webhook registered. Idempotent — skips shops that already have one.
 * Uses KV flag to avoid running more than once per deploy cycle.
 */
export async function ensureAllShopsWebhooks(env: Env): Promise<void> {
  const KV = env.MERCARI_REPORTS;
  const FLAG_KEY = "webhook_setup:all_shops_v1";
  const existing = await KV.get(FLAG_KEY);
  if (existing) return;

  const secret = env.WEBHOOK_SHARED_SECRET;
  if (!secret) {
    console.error("[WebhookSetup] WEBHOOK_SHARED_SECRET not configured — skipping");
    return;
  }

  const endpoint = `https://tickets.homesbliss.net/api/webhooks/mercari-message?secret=${secret}`;
  const results: string[] = [];

  for (const [shopName, tokenEnvKey] of Object.entries(SHOP_TOKENS)) {
    const token = env[tokenEnvKey] as string | undefined;
    if (!token) {
      console.log(`[WebhookSetup] ${shopName}: no token — skipping`);
      continue;
    }

    try {
      const listResp = await runGraphQL(token, `query { webhooks { id endPoint topic createdAt } }`);
      const listData = listResp.data as Record<string, unknown> | undefined;
      const existingHooks = (listData?.webhooks as Array<Record<string, unknown>>) ?? [];
      const alreadyExists = existingHooks.some(
        (w) => w.topic === "ORDER_TRANSACTION_MESSAGE_CREATED"
      );

      if (alreadyExists) {
        results.push(`${shopName}: exists`);
        continue;
      }

      const createResp = await runGraphQL(token, `
        mutation createWebhook($input: CreateWebhookInput!) {
          createWebhook(input: $input) {
            webhook { id endPoint topic createdAt }
          }
        }
      `, { input: { endPoint: endpoint, topic: "ORDER_TRANSACTION_MESSAGE_CREATED" } });

      if (createResp.errors?.length) {
        results.push(`${shopName}: error — ${createResp.errors[0]?.message}`);
      } else {
        results.push(`${shopName}: created`);
      }
    } catch (e) {
      results.push(`${shopName}: exception — ${e}`);
    }
  }

  console.log(`[WebhookSetup] Results: ${results.join(" | ")}`);

  // Store per-shop result in KV so we can verify without auth
  const resultObj: Record<string, string> = {};
  for (const r of results) {
    const [shop, status] = r.split(": ");
    resultObj[shop] = status;
  }
  await KV.put(`${FLAG_KEY}_result`, JSON.stringify(resultObj), { expirationTtl: 86400 });

  // Set flag so this only runs once per deploy
  await KV.put(FLAG_KEY, new Date().toISOString(), { expirationTtl: 86400 });
}

export async function handleMercariWebhookAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) return err("Unauthorized", 401);

  let body: AdminBody;
  try {
    body = (await request.json()) as AdminBody;
  } catch {
    return err("Invalid JSON", 400);
  }

  const shop = body.shop || "Shop4";

  const tokenKey = SHOP_TOKENS[shop];
  const token = tokenKey ? (env[tokenKey] as string | undefined) : undefined;
  if (!token) return err(`Missing token for ${shop}`, 500);

  // ── list: query existing webhooks ──
  if (body.action === "list") {
    const query = `
      query {
        webhooks {
          id
          endPoint
          topic
          createdAt
        }
      }
    `;
    const resp = await runGraphQL(token, query);
    return json({ success: !resp.errors?.length, response: resp }, resp.errors?.length ? 422 : 200);
  }

  if (body.action === "create") {
    if (!body.endpoint) return err("Missing endpoint", 400);

    const mutation = `
      mutation createWebhook($input: CreateWebhookInput!) {
        createWebhook(input: $input) {
          webhook {
            id
            endPoint
            topic
            createdAt
          }
        }
      }
    `;
    const resp = await runGraphQL(token, mutation, {
      input: {
        endPoint: body.endpoint,
        topic: body.topic || DEFAULT_TOPIC,
      },
    });
    return json({ success: !resp.errors?.length, response: resp }, resp.errors?.length ? 422 : 200);
  }

  if (body.action === "graphql") {
    if (!body.query) return err("Missing query", 400);
    if (!isAllowedWebhookGraphQL(body.query)) {
      return err("Only webhook schema/list/create GraphQL is allowed", 400);
    }

    const resp = await runGraphQL(token, body.query, body.variables || {});
    return json({ success: !resp.errors?.length, response: resp }, resp.errors?.length ? 422 : 200);
  }

  // ── ensure-all-shops: register webhooks for all configured shops ──
  if (body.action === "ensure-all-shops") {
    const webhookSecret = env.WEBHOOK_SHARED_SECRET;
    if (!webhookSecret) return err("WEBHOOK_SHARED_SECRET not configured", 503);

    const webhookEndpoint = `https://tickets.homesbliss.net/api/webhooks/mercari-message?secret=${webhookSecret}`;
    const results: Record<string, unknown> = {};

    for (const [shopName, tokenEnvKey] of Object.entries(SHOP_TOKENS)) {
      const shopToken = env[tokenEnvKey] as string | undefined;
      if (!shopToken) {
        results[shopName] = { status: "skipped", reason: "no_token" };
        continue;
      }

      // List existing webhooks
      const listQuery = `query { webhooks { id endPoint topic createdAt } }`;
      let listResp;
      try {
        listResp = await runGraphQL(shopToken, listQuery);
      } catch (e) {
        results[shopName] = { status: "error", reason: `list_failed: ${e}` };
        continue;
      }

      const listData = listResp.data as Record<string, unknown> | undefined;
      const existing = (listData?.webhooks as Array<Record<string, unknown>>) ?? [];
      const messageHook = existing.find(
        (w) => w.topic === "ORDER_TRANSACTION_MESSAGE_CREATED"
      );

      if (messageHook) {
        results[shopName] = {
          status: "exists",
          webhook_id: messageHook.id,
          endpoint: messageHook.endPoint,
          created_at: messageHook.createdAt,
        };
        continue;
      }

      // Create webhook
      const createMutation = `
        mutation createWebhook($input: CreateWebhookInput!) {
          createWebhook(input: $input) {
            webhook { id endPoint topic createdAt }
          }
        }
      `;
      let createResp;
      try {
        createResp = await runGraphQL(shopToken, createMutation, {
          input: {
            endPoint: webhookEndpoint,
            topic: DEFAULT_TOPIC,
          },
        });
      } catch (e) {
        results[shopName] = { status: "error", reason: `create_failed: ${e}` };
        continue;
      }

      if (createResp.errors?.length) {
        results[shopName] = {
          status: "error",
          reason: `create_errors: ${JSON.stringify(createResp.errors)}`,
        };
        continue;
      }

      const createdData = createResp.data as Record<string, unknown> | undefined;
      const createWebhook = createdData?.createWebhook as Record<string, unknown> | undefined;
      const created = createWebhook?.webhook as Record<string, unknown> | undefined;
      results[shopName] = {
        status: "created",
        webhook_id: created?.id,
        endpoint: created?.endPoint ?? webhookEndpoint,
        created_at: created?.createdAt,
      };
    }

    return json({ success: true, endpoint: webhookEndpoint, shops: results });
  }

  return err("Unsupported action", 400);
}
