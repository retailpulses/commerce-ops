import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const opsNav = readFileSync(new URL("../src/components/layout/OpsNav.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const useAuth = readFileSync(new URL("../src/hooks/useAuth.tsx", import.meta.url), "utf8");

test("OpsNav carries the shared ops-portal nav contract", () => {
  assert.match(opsNav, /aria-label="Operations portals"/);
  assert.match(opsNav, /data-ops-nav-version="1"/);
  assert.match(opsNav, /href: "\/inquiry\/"/);
  assert.match(opsNav, /href: "\/tickets\/"/);
  assert.match(opsNav, /href: "\/order\/"/);
});

test("browser API base uses the canonical /order/api/portal prefix", () => {
  assert.match(api, /const API_BASE = "\/order\/api\/portal";/);
});

test("login probe uses the canonical /order/api/portal prefix", () => {
  assert.match(useAuth, /new URL\(`\/order\/api\/portal\$\{path\}`/);
});
