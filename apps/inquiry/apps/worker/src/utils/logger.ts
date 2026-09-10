export function createLogger(runId: string, jobName: string) {
  function log(level: string, message: string, meta?: Record<string, unknown>) {
    const entry: Record<string, unknown> = {
      runId,
      jobName,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    if (meta?.error instanceof Error) {
      entry.error = (meta.error as Error).message;
    }
    console.log(JSON.stringify(entry));
  }

  return {
    info(msg: string, meta?: Record<string, unknown>) {
      log("info", msg, meta);
    },
    error(msg: string, meta?: Record<string, unknown>) {
      log("error", msg, meta);
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      log("warn", msg, meta);
    },
  };
}
