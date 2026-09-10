export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    backoffMs?: number;
    shouldRetry?: (error: Error) => boolean;
  },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseBackoffMs = options?.backoffMs ?? 1000;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts || options?.shouldRetry?.(lastError) === false) {
        throw lastError;
      }
      const jitter = Math.floor(Math.random() * 500);
      const delay = baseBackoffMs * Math.pow(2, attempt - 1) + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error("withRetry failed");
}
