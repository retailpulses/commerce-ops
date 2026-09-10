import type { Request, Response, NextFunction } from "express";
import { Config } from "../config.js";

export function createStreamLimiter(config: Config) {
  let activeStreams = 0;

  return (_req: Request, res: Response, next: NextFunction): void => {
    if (activeStreams >= config.maxConcurrentStreams) {
      res.status(503).json({ error: "Too many concurrent downloads" });
      return;
    }

    activeStreams++;

    let released = false;
    const decrement = () => {
      if (released) return;
      released = true;
      activeStreams = Math.max(0, activeStreams - 1);
    };

    res.on("close", decrement);
    res.on("finish", decrement);

    next();
  };
}
