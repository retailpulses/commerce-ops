import assert from "node:assert/strict";
import test from "node:test";

import { planTemplateMigration } from "../scripts/migrate-portal-templates.mjs";

test("template migration creates missing templates and skips exact matches", () => {
  const plan = planTemplateMigration(
    [
      { title: "Shipping", body: "Your order shipped." },
      { title: "Thanks", body: "Thank you." },
    ],
    [{ title: "Thanks", body: "Thank you." }],
  );

  assert.deepEqual(plan.create, [{ title: "Shipping", body: "Your order shipped." }]);
  assert.deepEqual(plan.unchanged, ["Thanks"]);
  assert.deepEqual(plan.conflicts, []);
});

test("template migration refuses same-title content conflicts", () => {
  const plan = planTemplateMigration(
    [{ title: "Thanks", body: "Legacy body" }],
    [{ title: "Thanks", body: "Supabase body" }],
  );

  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.conflicts, [{ title: "Thanks", reason: "same_title_different_body" }]);
});

test("template migration flags invalid source rows", () => {
  const plan = planTemplateMigration([{ title: "", body: "Missing title" }], []);
  assert.deepEqual(plan.conflicts, [{ title: "", reason: "invalid_source_template" }]);
});
