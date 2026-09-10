import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import worker from "../../../worker/index.js";

describe("retired Worker portal", () => {
  it("permanently redirects /portal to the React portal", async () => {
    const response = await worker.fetch(new Request("https://worker.example/portal"), {});

    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://order.homesbliss.net/");
  });

  it("redirects browser requests to the Worker root", async () => {
    const response = await worker.fetch(new Request("https://worker.example/", {
      headers: { accept: "text/html" },
    }), {});

    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://order.homesbliss.net/");
  });
});
