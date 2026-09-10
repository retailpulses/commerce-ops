import { describe, expect, it } from "vitest";

import { onRequestGet } from "../../api/release";

describe("release identity", () => {
  it("returns the immutable Inquiry owner commit contract", async () => {
    const response = await onRequestGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ application: "inquiry", contract_version: 1 });
    expect(body.release_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(body.built_at))).toBe(false);
  });
});
