import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/repositories/supabaseTicketRepository.ts", import.meta.url), "utf8");
const notesTab = readFileSync(new URL("../../frontend/src/components/tickets/detail/NotesTab.tsx", import.meta.url), "utf8");
const detailToolbar = readFileSync(new URL("../../frontend/src/components/tickets/detail/DetailToolbar.tsx", import.meta.url), "utf8");
const filterBar = readFileSync(new URL("../../frontend/src/components/tickets/FilterBar.tsx", import.meta.url), "utf8");
const frontendShell = readFileSync(new URL("../../frontend/index.html", import.meta.url), "utf8");

describe("ticket note editing", () => {
  it("routes a ticket-scoped PATCH and constrains the update by ticket and note ids", () => {
    assert.match(worker, /method === "PATCH" && updateNoteMatch/);
    assert.match(repository, /\.eq\("id", input\.note_id\)[\s\S]*\.eq\("ticket_id", input\.ticket_id\)/);
  });

  it("exposes an inline editor without replacing the existing add-note flow", () => {
    assert.match(notesTab, /onUpdateNote/);
    assert.match(notesTab, />Edit<\/Button>/);
    assert.match(notesTab, />Save changes<\/Button>/);
    assert.match(notesTab, /\+ Add Note/);
  });
});

describe("ticket search and status controls", () => {
  it("keeps search owned by the ticket list and labels the default active-ticket queue as a group", () => {
    assert.match(filterBar, /<Input[\s\S]*placeholder="Search tickets\.\.\."/);
    assert.doesNotMatch(detailToolbar, /ticket-detail-search/);
    assert.doesNotMatch(detailToolbar, /placeholder="Search tickets\.\.\."/);
    assert.match(detailToolbar, /Back to tickets/);
    assert.doesNotMatch(filterBar, /Open work \(all active statuses\)/);
    assert.match(filterBar, /Active tickets \(all active statuses\)/);
    assert.match(filterBar, /value === "__active" \? "non_terminal"/);
  });
});

describe("shared portal navigation", () => {
  it("uses the Inquiry portal link order and labels", () => {
    assert.ok(frontendShell.indexOf('href="/inquiry/"') < frontendShell.indexOf('href="/order/"'));
    assert.ok(frontendShell.indexOf('href="/order/"') < frontendShell.indexOf('href="/tickets/"'));
    assert.match(frontendShell, />Orders<\/a>/);
  });
});

describe("ticket external link visibility", () => {
  it("keeps the order id and external URL in the always-visible toolbar", () => {
    assert.match(detailToolbar, /Order ID:/);
    assert.match(detailToolbar, /ticket\.external_order_id \?\? "—"/);
    assert.match(detailToolbar, /href=\{ticket\.external_url\}/);
    assert.match(detailToolbar, /Open external/);
    assert.match(detailToolbar, /className="shrink-0 rounded border/);
  });
});
