import express from "express";
import { createServer, Server } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRequestIdMiddleware } from "./middleware/requestId.js";
import { securityHeadersMiddleware } from "./middleware/securityHeaders.js";
import { createRateLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createHealthzRouter } from "./routes/healthz.js";
import { createTicketShareRouter } from "./routes/ticketShare.js";
import { createEvidenceRouter } from "./routes/evidence.js";
import { log } from "./services/logger.js";

export function createApp(config = loadConfig()) {
  const app = express();

  app.disable("x-powered-by");
  // Nginx is the only direct peer and overwrites X-Forwarded-For. This lets
  // per-IP limits use the seller address without trusting arbitrary proxies.
  app.set("trust proxy", "loopback");
  app.use(createRequestIdMiddleware());
  app.use(securityHeadersMiddleware);
  app.use(createRateLimiter(config));

  app.use("/healthz", createHealthzRouter());
  app.use("/tickets/share", createTicketShareRouter(config));
  app.use("/tickets/share", createEvidenceRouter(config));

  app.use(errorHandler);

  return app;
}

let server: Server | null = null;

function gracefulShutdown(signal: string) {
  log.info(`received ${signal}, shutting down gracefully`);
  if (server) {
    server.close(() => {
      log.info("server closed");
      process.exit(0);
    });
    setTimeout(() => {
      log.error("forced shutdown after timeout");
      process.exit(1);
    }, 30000).unref();
  } else {
    process.exit(0);
  }
}

export function startServer(config = loadConfig()): Server {
  const app = createApp(config);
  server = createServer(app);

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  server.listen(config.port, config.host, () => {
    log.info("ticket-share-viewer started", {
      host: config.host,
      port: String(config.port),
    });
  });

  return server;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  startServer();
}
