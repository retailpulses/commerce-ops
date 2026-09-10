import { Router } from "express";
import { Config } from "../config.js";
import { BridgeClient, BridgeError } from "../services/bridge.js";
import { renderTicketPage, renderErrorPage } from "../services/htmlRenderer.js";
import { isValidToken } from "../utils/validation.js";
import { log } from "../services/logger.js";

export function createTicketShareRouter(
  config: Config,
  bridgeClient?: BridgeClient,
): Router {
  const router = Router();
  const bridge = bridgeClient || new BridgeClient(config);

  router.get("/:token", async (req, res) => {
    const token = req.params.token;

    if (!isValidToken(token)) {
      log.warn("invalid token format", { route: "ticketShare" });
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderErrorPage(404, "Not found"));
      return;
    }

    try {
      const dto = await bridge.resolveToken(token);
      const html = renderTicketPage(dto, token);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof BridgeError) {
        log.warn("bridge error on resolve", {
          route: "ticketShare",
          status: String(err.statusCode),
        });
        res
          .status(err.statusCode)
          .setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderErrorPage(err.statusCode, err.message));
        return;
      }
      throw err;
    }
  });

  return router;
}
