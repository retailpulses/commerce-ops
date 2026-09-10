export class GigaClient {
  constructor(clientId, clientSecret, baseUrl) {
    const resolvedBaseUrl = String(baseUrl || "https://openapi.gigab2b.com").trim();
    if (!resolvedBaseUrl) throw new Error("Missing GIGA_API_BASE_URL");
    if (!clientId) throw new Error("Missing GIGA_CLIENT_ID");
    if (!clientSecret) throw new Error("Missing GIGA_CLIENT_SECRET");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = resolvedBaseUrl.replace(/\/$/, "");
  }

  async generateSignature(timestamp, nonce, apiPath) {
    const message = `${this.clientId}&${apiPath}&${timestamp}&${nonce}`;
    const key = `${this.clientId}&${this.clientSecret}&${nonce}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
    const hexString = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { signature: btoa(hexString), stringToSign: message };
  }

  async getTrackingInfo(orderNos) {
    const apiPath = "/b2b-overseas-api/v1/buyer/order/track-no/v1";
    return await this._request("POST", apiPath, { orderNo: orderNos }, { retryTransient: true });
  }

  async createOrder(orderData) {
    const apiPath = "/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1";
    // Creating an order is not safely retryable after a timeout/5xx because
    // the provider may have committed before the response was lost.
    return await this._request("POST", apiPath, orderData, { retryTransient: false });
  }

  async _request(method, apiPath, body = null, { retryTransient = true } = {}) {
    const url = `${this.baseUrl}${apiPath}`;
    let retryCount = 0;
    const maxRetries = 3;
    while (retryCount <= maxRetries) {
      const timestamp = Date.now().toString();
      const nonce = Math.random().toString().substring(2, 12);
      const { signature } = await this.generateSignature(timestamp, nonce, apiPath);
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "client-id": this.clientId,
            timestamp,
            nonce,
            sign: signature,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (cause) {
        const error = new Error(`Giga API transport outcome unknown for ${apiPath}`);
        error.cause = cause;
        error.outcomeUncertain = true;
        throw error;
      }
      const rawText = await response.text();
      let result;
      try {
        result = JSON.parse(rawText);
      } catch {
        const error = new Error(`Giga API Non-JSON Response from ${apiPath} (Status ${response.status})`);
        error.outcomeUncertain = true;
        throw error;
      }
      if (!response.ok || result.success === false) {
        const errorMsg = result.subMsg || result.msg || response.statusText;
        const errorCode = result.code;
        if (retryTransient && retryCount < maxRetries && (response.status === 429 || response.status >= 500)) {
          retryCount += 1;
          await sleep(Math.pow(2, retryCount) * 1000);
          continue;
        }
        const err = new Error(`Giga API Error (${apiPath}): ${errorMsg} (Code: ${errorCode})`);
        err.gigaCode = errorCode;
        err.gigaMessage = errorMsg;
        err.gigaResponse = result;
        err.outcomeUncertain = response.status >= 500;
        throw err;
      }
      return result;
    }
    throw new Error(`Giga API retry exhausted for ${apiPath}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
