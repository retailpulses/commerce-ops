import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  AFTERSALES_FORM_PLACEHOLDER,
  containsAfterSalesFormLink,
  fuguaiAlreadySent,
} from "../src/logic/templates";

const root = resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("legacy ticket pipeline retirement guard", () => {
  it("keeps Baserow credentials and the legacy processor out of Worker runtime configuration", () => {
    const files = ["index.ts", "wrangler.toml", "wrangler.staging.toml", "src/types.ts"];
    for (const file of files) {
      const body = readFileSync(resolve(root, file), "utf8");
      assert.doesNotMatch(body, /BASEROW_(?:TOKEN|BASE_URL)/, file);
      assert.doesNotMatch(body, /runTicketMgmt|transaction-processor/, file);
    }
  });

  it("uses tokenized Supabase after-sales form links", () => {
    const link = "https://tickets.homesbliss.net/forms/after-sales/test-token";
    assert.equal(AFTERSALES_FORM_PLACEHOLDER, "{{AFTERSALES_FORM_URL}}");
    assert.equal(containsAfterSalesFormLink(link), true);
    assert.equal(fuguaiAlreadySent([{ message: link }]), true);
    assert.equal(fuguaiAlreadySent([{ message: "https://example.com/form" }]), false);
  });

  it("enforces manual-or-TicketForm ticket creation authority", () => {
    const prohibitedAutomaticModules = [
      "index.ts",
      "src/handlers/webhooks.ts",
      "src/handlers/webhook-retry.ts",
      "src/handlers/webhook-reconciliation.ts",
      "src/handlers/copywriting.ts",
      "src/services/inboundClassificationService.ts",
      "src/services/ticketFormRequestService.ts",
      "src/services/messageSendService.ts",
    ];
    for (const file of prohibitedAutomaticModules) {
      const body = readFileSync(resolve(root, file), "utf8");
      assert.doesNotMatch(body, /\.createTicket\(/, `${file} calls ticket creation`);
      assert.doesNotMatch(
        body,
        /\.from\(["']tickets["']\)\s*\.insert\(/,
        `${file} inserts a ticket`,
      );
      assert.doesNotMatch(
        body,
        /finalize_ticketform_submission/,
        `${file} calls the TicketForm-only creation RPC`,
      );
      assert.doesNotMatch(body, /origin:\s*["']platform_ingest["']/, file);
    }

    // Any future runtime call to the repository/domain creation command must
    // be added to this explicit manual-authority allow-list during review.
    const creationCallFiles = sourceFiles(resolve(root, "src"))
      .filter((file) => /\.createTicket\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1))
      .sort();
    assert.deepEqual(creationCallFiles, [
      "src/handlers/ticketing.ts",
      "src/services/ticketService.ts",
    ]);

    const ticketService = readFileSync(resolve(root, "src/services/ticketService.ts"), "utf8");
    assert.match(ticketService, /authority:\s*ManualTicketCreationAuthority/);
    assert.match(ticketService, /origin:\s*"manual"/);
    assert.match(ticketService, /actor_id:\s*authority\.actor_id/);
    const ticketRepository = readFileSync(resolve(root, "src/repositories/supabaseTicketRepository.ts"), "utf8");
    assert.match(ticketRepository, /input\.origin !== "manual"/);

    const legacyDecision = readFileSync(resolve(root, "src/logic/ticket-state.ts"), "utf8");
    assert.match(legacyDecision, /Only an authenticated[\s\S]*TicketForm finalization may create one/);
    assert.match(legacyDecision, /shouldCreateTicket: false/);

    const queueService = readFileSync(resolve(root, "src/services/inboundMessageService.ts"), "utf8");
    assert.match(queueService, /convert_mercari_inbound_message_to_ticket_v1/);
    assert.doesNotMatch(queueService, /this\.ticketRepo\.createTicket\(/);
    const queueMigration = readFileSync(
      resolve(root, "../../supabase/migrations/20260909023000_mercari_queue_link_rpc.sql"),
      "utf8",
    );
    assert.match(queueMigration, /'message_received','operator'/);
    assert.match(queueMigration, /'source','manual_queue_conversion'/);

    const classifier = readFileSync(resolve(root, "src/services/inboundClassificationService.ts"), "utf8");
    assert.match(classifier, /recommended_for_manual_creation/);
    assert.doesNotMatch(classifier, /recommended_operator_action:\s*[^\n]*["']manual_create_ticket["']/);
  });
});
