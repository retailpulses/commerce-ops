const SESSION_KEY = "hb_ticketing_token";

export class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(SESSION_KEY);
  const headers: Record<string, string> = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Only set Content-Type when not using FormData (browser sets it automatically with boundary)
  if (!opts.body || !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(path, {
    ...opts,
    headers: {
      ...headers,
      ...(opts.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    sessionStorage.removeItem(SESSION_KEY);
    window.dispatchEvent(new CustomEvent("auth:logout"));
    throw new ApiError(401, "UNAUTHORIZED", "Unauthorized — please log in again", null);
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    // Normalize flat { error: string } and nested { error: { message, code } } shapes
    const err = body as Record<string, unknown> | null;
    const parsed: { message: string; code: string } =
      typeof err?.error === "string"
        ? { message: err.error, code: (err.code as string) ?? "ERROR" }
        : err?.error && typeof err.error === "object"
          ? {
              message: (err.error as Record<string, unknown>).message as string ?? "Unknown error",
              code: (err.error as Record<string, unknown>).code as string ?? "ERROR",
            }
          : { message: `Request failed with status ${res.status}`, code: "ERROR" };
    throw new ApiError(res.status, parsed.code, parsed.message, body);
  }

  return res.json() as Promise<T>;
}
