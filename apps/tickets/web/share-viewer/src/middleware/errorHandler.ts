import type { Request, Response, NextFunction } from "express";
import { log } from "../services/logger.js";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  log.error("unhandled error", {
    error: err.message,
    name: err.name,
  });

  if (res.headersSent) {
    return;
  }

  const statusCode =
    "statusCode" in err ? (err as Record<string, unknown>).statusCode as number : 500;

  res.status(statusCode >= 400 ? statusCode : 500).json({
    error:
      statusCode >= 500
        ? "Internal server error"
        : "Invalid request",
  });
}
