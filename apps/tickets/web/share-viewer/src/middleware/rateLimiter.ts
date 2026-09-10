import rateLimit from "express-rate-limit";
import { Config } from "../config.js";

export function createRateLimiter(config: Config) {
  return rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/healthz",
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests" });
    },
  });
}
