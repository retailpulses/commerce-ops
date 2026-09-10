import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Request, Response } from "express";
import { createStreamLimiter } from "../src/middleware/streamLimiter.js";
import type { Config } from "../src/config.js";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; return this; }
}

test("a completed response releases exactly one stream slot", () => {
  const limiter = createStreamLimiter({ maxConcurrentStreams: 1 } as Config);
  const first = new FakeResponse();
  let firstNext = 0;
  limiter({} as Request, first as unknown as Response, () => { firstNext += 1; });
  assert.equal(firstNext, 1);

  // Node commonly emits finish followed by close. This must not release twice.
  first.emit("finish");
  first.emit("close");

  const second = new FakeResponse();
  let secondNext = 0;
  limiter({} as Request, second as unknown as Response, () => { secondNext += 1; });
  assert.equal(secondNext, 1);

  const third = new FakeResponse();
  let thirdNext = 0;
  limiter({} as Request, third as unknown as Response, () => { thirdNext += 1; });
  assert.equal(thirdNext, 0);
  assert.equal(third.statusCode, 503);
});
