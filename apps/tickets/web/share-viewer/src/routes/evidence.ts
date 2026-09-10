import { Router, Request, Response, NextFunction } from "express";
import { Config } from "../config.js";
import { BridgeClient, BridgeError } from "../services/bridge.js";
import { isValidToken, isValidAttachmentId } from "../utils/validation.js";
import { contentDisposition } from "../utils/sanitize.js";
import { fetchFromUpstream, UpstreamError } from "../utils/stream.js";
import { log } from "../services/logger.js";
import { createStreamLimiter } from "../middleware/streamLimiter.js";

export function createEvidenceRouter(
  config: Config,
  bridgeClient?: BridgeClient,
): Router {
  const router = Router();
  const bridge = bridgeClient || new BridgeClient(config);
  const streamLimiter = createStreamLimiter(config);

  router.use("/:token/evidence/:attachmentId", streamLimiter);

  function validateParams(
    token: string,
    attachmentId: string,
  ): string | null {
    if (!isValidToken(token)) {
      return "Invalid token format";
    }
    if (!isValidAttachmentId(attachmentId)) {
      return "Invalid attachment ID format";
    }
    return null;
  }

  async function handleEvidence(
    token: string,
    attachmentId: string,
    disposition: "inline" | "attachment",
    req: Request,
    res: Response,
  ): Promise<void> {
    const validationError = validateParams(token, attachmentId);
    if (validationError) {
      log.warn(validationError, { route: "evidence" });
      res.status(404).json({ error: "Not found" });
      return;
    }

    let upstreamData: {
      url: string;
      fileName: string;
      mimeType: string;
      size: number;
    };
    try {
      upstreamData = await bridge.getEvidenceUrl(token, attachmentId);
    } catch (err) {
      if (err instanceof BridgeError) {
        log.warn("bridge error on evidence", {
          route: "evidence",
          status: String(err.statusCode),
        });
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }

    let result: {
      response: globalThis.Response;
      responseHeaders: Record<string, string>;
    };
    if (!Number.isFinite(upstreamData.size)
        || upstreamData.size < 0
        || upstreamData.size > config.maxFileSize) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const rangeHeader = req.headers.range as string | undefined;
      result = await fetchFromUpstream(
        upstreamData.url,
        rangeHeader,
        config,
        fetch,
      );
    } catch (err) {
      if (err instanceof UpstreamError) {
        log.warn("upstream error on evidence fetch", {
          route: "evidence",
          error: err.message,
        });
        res
          .status(err.statusCode)
          .json({ error: "Service temporarily unavailable" });
        return;
      }
      throw err;
    }

    result.responseHeaders["Content-Disposition"] =
      contentDisposition(disposition, upstreamData.fileName);

    res.status(result.response.status === 206 ? 206 : 200);
    for (const [key, value] of Object.entries(result.responseHeaders)) {
      res.setHeader(key, value);
    }

    if (result.response.body) {
      const reader = result.response.body.getReader();
      let streamedBytes = 0;
      let closed = false;
      res.once("close", () => {
        closed = true;
        void reader.cancel().catch(() => undefined);
      });
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!closed) res.end();
            break;
          }
          streamedBytes += value.byteLength;
          if (streamedBytes > config.maxFileSize) {
            await reader.cancel();
            res.destroy();
            break;
          }
          if (!res.write(value)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      };
      pump().catch((err: unknown) => {
        log.error("evidence stream error", { error: String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        } else {
          res.end();
        }
      });
    } else {
      res.end();
    }
  }

  router.get(
    "/:token/evidence/:attachmentId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handleEvidence(
          req.params.token,
          req.params.attachmentId,
          "inline",
          req,
          res,
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/:token/evidence/:attachmentId/download",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handleEvidence(
          req.params.token,
          req.params.attachmentId,
          "attachment",
          req,
          res,
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
