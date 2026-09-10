import { getToken, clearToken } from "./auth";

const API_BASE = "/order/api/portal";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = getToken();
  const url = new URL(`${API_BASE}${path}`, window.location.origin);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const res = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new ApiError("unauthorized", 401);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }

  return body as T;
}

export function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  return request<T>(path, {}, params);
}

export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(data || {}) });
}

export function apiPatch<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(data || {}) });
}

export function apiPut<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(data || {}) });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export { ApiError };
