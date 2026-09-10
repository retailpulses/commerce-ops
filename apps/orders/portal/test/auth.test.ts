import test from "node:test";
import assert from "node:assert/strict";

import { isCloudflareAccessUrl } from "../src/lib/auth.ts";

test("enables Cloudflare Access mode only for the proxied Order Portal", () => {
  assert.equal(
    isCloudflareAccessUrl({ hostname: "ops.homesbliss.net", pathname: "/order" }),
    true,
  );
  assert.equal(
    isCloudflareAccessUrl({ hostname: "ops.homesbliss.net", pathname: "/order/assets/app.js" }),
    true,
  );
  assert.equal(
    isCloudflareAccessUrl({ hostname: "order.homesbliss.net", pathname: "/" }),
    false,
  );
  assert.equal(
    isCloudflareAccessUrl({ hostname: "ops-portal.pages.dev", pathname: "/order" }),
    false,
  );
});
