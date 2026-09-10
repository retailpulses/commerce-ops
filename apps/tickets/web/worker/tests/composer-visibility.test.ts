import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const workspaceSource = readFileSync(
  new URL("../../frontend/src/pages/WorkspacePage.tsx", import.meta.url),
  "utf8",
);
const detailPaneSource = readFileSync(
  new URL("../../frontend/src/components/tickets/detail/DetailPane.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../frontend/src/components/composer/Composer.tsx", import.meta.url),
  "utf8",
);

describe("composer visibility and platform handling", () => {
  it("renders the composer inside the Messages tab for every loaded ticket", () => {
    assert.match(detailPaneSource, /activeTab === "messages"[\s\S]*<Composer[\s\S]*ticketId=\{ticket\.id\}/);
    assert.doesNotMatch(workspaceSource, /<Composer/);
    assert.doesNotMatch(workspaceSource, /\["mercari", "amazon"\]\.includes/);
  });

  it("normalizes platform casing before enabling Mercari API send", () => {
    assert.match(composerSource, /ticketPlatform\.trim\(\)\.toLowerCase\(\)/);
    assert.match(composerSource, /canSend = normalizedPlatform === "mercari"/);
    assert.match(composerSource, /normalizedPlatform === "rakuten" && rakutenOutboundEnabled/);
    assert.match(detailPaneSource, /rakuten_rmesse_outbound_enabled/);
  });
});
