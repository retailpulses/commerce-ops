import fs from "node:fs/promises";
import https from "node:https";

const GRAPHQL_URL = "https://api.mercari-shops.com/v1/graphql";
const MAX_STATUS_BATCH = 50;
const GET_TRANSACTION_QUERY = `
query GetTransaction($id: ID!) {
  orderTransaction(id: $id) {
    id
    status
    messages { id role message createdAt }
  }
}`;
const SEND_MESSAGE_MUTATION = `
mutation AddOrderTransactionMessage($input: AddOrderTransactionMessageInput!) {
  addOrderTransactionMessage(input: $input) {
    orderTransaction { id messages { id role message createdAt } }
  }
}`;

export async function fetchMercariOrderStatuses(env, { shopLabel, orderIds }, injected = {}) {
  const label = String(shopLabel || "").trim();
  const ids = Array.isArray(orderIds)
    ? [...new Set(orderIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  if (!label) return { ok: false, error: "shopLabel is required" };
  if (!ids.length) return { ok: false, error: "orderIds is required" };
  if (ids.length > MAX_STATUS_BATCH) return { ok: false, error: `orderIds exceeds ${MAX_STATUS_BATCH}` };
  const tokensPath = String(env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, error: "MERCARI_TOKENS_PATH not configured" };
  try {
    const token = await (injected.loadToken || loadMercariShopToken)(tokensPath, label);
    const variables = {};
    const declarations = [];
    const selections = ids.map((orderId, index) => {
      const variable = `id${index}`;
      variables[variable] = orderId;
      declarations.push(`$${variable}: ID!`);
      return `o${index}: orderTransaction(id: $${variable}) { id status }`;
    });
    const query = `query OrderStatuses(${declarations.join(", ")}) { ${selections.join("\n")} }`;
    const data = await (injected.graphql || mercariGraphQL)(env, token, query, variables);
    return {
      ok: true,
      shopLabel: label,
      orders: ids.map((orderId, index) => {
        const transaction = data && data[`o${index}`];
        return transaction
          ? { orderId: String(transaction.id || orderId), status: String(transaction.status || "").trim() || null, found: true }
          : { orderId, status: null, found: false };
      }),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export async function fetchMercariOrderMessages(env, { shopLabel, orderId }, injected = {}) {
  const label = String(shopLabel || "").trim();
  const id = String(orderId || "").trim();
  if (!label) return { ok: false, body: { ok: false, error: "shopLabel is required" } };
  if (!id) return { ok: false, body: { ok: false, error: "orderId is required" } };
  const tokensPath = String(env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, body: { ok: false, error: "MERCARI_TOKENS_PATH not configured" } };
  try {
    const token = await (injected.loadToken || loadMercariShopToken)(tokensPath, label);
    const data = await (injected.graphql || mercariGraphQL)(env, token, GET_TRANSACTION_QUERY, { id });
    const transaction = data && data.orderTransaction;
    if (!transaction) return { ok: false, body: { ok: false, error: "order_transaction_not_found", orderId: id } };
    const messages = (transaction.messages || []).map((message) => ({
      id: message.id ? String(message.id).trim() : null,
      role: String(message.role || "").trim().toUpperCase(),
      message: String(message.message || "").trim(),
      createdAt: String(message.createdAt || "").trim(),
    }));
    return { ok: true, body: { ok: true, messages, status: transaction.status ? String(transaction.status).trim() : null } };
  } catch (error) {
    return { ok: false, body: { ok: false, error: String(error?.message || error) } };
  }
}

export async function sendMercariOrderReply(env, { shopLabel, transactionId, text }, injected = {}) {
  const label = String(shopLabel || "").trim();
  const id = String(transactionId || "").trim();
  const reply = String(text || "").trim();
  if (!label || !id || !reply) return { ok: false, body: { ok: false, error: "shopLabel, transactionId and text are required" } };
  const tokensPath = String(env.MERCARI_TOKENS_PATH || "").trim();
  if (!tokensPath) return { ok: false, body: { ok: false, error: "MERCARI_TOKENS_PATH not configured" } };
  try {
    const token = await (injected.loadToken || loadMercariShopToken)(tokensPath, label);
    const data = await (injected.graphql || mercariGraphQL)(env, token, SEND_MESSAGE_MUTATION, {
      input: { orderTransactionId: id, message: reply },
    });
    const transaction = data?.addOrderTransactionMessage?.orderTransaction;
    const messages = transaction?.messages || [];
    if (!transaction || !messages.length) return { ok: false, body: { ok: false, error: "send_message_failed" } };
    const last = messages[messages.length - 1];
    return { ok: true, body: { ok: true, message: {
      id: last.id ? String(last.id).trim() : null,
      role: String(last.role || "SELLER").trim().toUpperCase(),
      message: String(last.message || reply).trim(),
      createdAt: String(last.createdAt || "").trim(),
    } } };
  } catch (error) {
    return { ok: false, body: { ok: false, error: String(error?.message || error) } };
  }
}

async function loadMercariShopToken(tokensPath, shopLabel) {
  const raw = await fs.readFile(tokensPath, "utf8");
  let currentLabel = "";
  for (const line of raw.split(/\r?\n/g)) {
    const labelMatch = line.match(/^##\s+(Shop\d+)\s*$/);
    if (labelMatch) { currentLabel = labelMatch[1]; continue; }
    const tokenMatch = line.match(/-\s*API token:\s*`([^`]+)`/);
    if (tokenMatch && currentLabel === shopLabel) return tokenMatch[1].trim();
  }
  throw new Error(`token_not_found:${shopLabel}`);
}

function mercariGraphQL(env, token, query, variables) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const request = https.request(GRAPHQL_URL, {
      method: "POST",
      family: 4,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
        "User-Agent": `${String(env.MERCARI_API_CLIENT_NAME || "Inhouse_ERP").trim()}/${String(env.MERCARI_API_CLIENT_VERSION || "0.0.1").trim()}`,
      },
      timeout: 30000,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("mercari_response_too_large"));
      });
      response.on("end", () => {
        try {
          if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
            return reject(new Error(`mercari_http_${response.statusCode || 0}`));
          }
          const parsed = JSON.parse(body);
          if (parsed.errors?.length) return reject(new Error("mercari_graphql_error"));
          resolve(parsed.data || parsed);
        } catch (error) { reject(new Error(`mercari_parse_error:${error.message}`)); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("mercari_graphql_timeout")));
    request.end(payload);
  });
}
