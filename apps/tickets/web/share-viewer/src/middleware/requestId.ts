import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function createRequestIdMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.requestId = crypto.randomUUID();
    next();
  };
}
