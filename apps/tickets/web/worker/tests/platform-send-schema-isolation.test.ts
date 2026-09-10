import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SupabaseCopywritingRepository } from "../src/repositories/supabaseCopywritingRepository";

const AMAZON_ONLY_COLUMNS = new Set([
  "source_inbound_message_id",
  "reviewed_customer_message_id",
  "reviewed_customer_message_at",
  "reviewed_customer_revision",
  "reviewed_thread_revision",
  "provider_mutation_started_at",
  "lease_generation",
  "lease_claimed_at",
  "no_send_first_observed_at",
  "no_send_last_observed_at",
  "no_send_observation_count",
]);

function sentRow() {
  return {
    id: "sent-1",
    ticket_id: "ticket-1",
    platform: "mercari",
    client_operation_id: "11111111-1111-4111-8111-111111111111",
    platform_message_id: null,
    body: "reply",
    reply_intent: "holding",
    sent_by: "operator",
    sent_at: "2026-09-08T00:00:00Z",
    created_at: "2026-09-08T00:00:00Z",
    delivery_status: "sending",
    delivery_error: null,
    platform_message_ids_before_send: null,
  };
}

class QueryRecorder {
  payloads: Record<string, unknown>[] = [];
  filters: Array<{ column: string; value: unknown }> = [];

  insert(payload: Record<string, unknown>) { this.payloads.push(payload); return this; }
  update(payload: Record<string, unknown>) { this.payloads.push(payload); return this; }
  delete() { return this; }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push({ column, value }); return this; }
  is(column: string, value: unknown) { this.filters.push({ column, value }); return this; }
  neq(column: string, value: unknown) { this.filters.push({ column, value }); return this; }
  single() { return Promise.resolve({ data: sentRow(), error: null }); }
  maybeSingle() { return Promise.resolve({ data: { id: "sent-1" }, error: null }); }
  then(resolve: (value: { data: null; error: null }) => unknown) {
    return Promise.resolve({ data: null, error: null }).then(resolve);
  }
}

describe("platform-neutral send persistence", () => {
  for (const platform of ["mercari", "rakuten"] as const) {
  it(`keeps the full ${platform} lifecycle fenced from other platforms and Amazon schema`, async () => {
    const queries: QueryRecorder[] = [];
    const rpcNames: string[] = [];
    const rpcPayloads: Record<string, unknown>[] = [];
    const supabase = {
      from(table: string) {
        assert.equal(table, "sent_messages");
        const query = new QueryRecorder();
        queries.push(query);
        return query;
      },
      async rpc(name: string, payload: Record<string, unknown>) {
        rpcNames.push(name);
        rpcPayloads.push(payload);
        if (name === `release_${platform}_operator_message_claim_v1`) {
          return { data: true, error: null };
        }
        return {
          data: {
            sent_message: { ...sentRow(), delivery_status: "sent", platform_message_id: "provider-1" },
            ticket_message: {
              id: "message-1", ticket_id: "ticket-1", platform: "mercari",
              external_message_id: "provider-1", sender_type: "operator",
              sender_display_name: "operator", body: "reply",
              sent_at: "2026-09-08T00:00:01Z", raw_payload: {}, created_at: "2026-09-08T00:00:01Z",
            },
            replayed: false,
          },
          error: null,
        };
      },
    };
    const repository = new SupabaseCopywritingRepository(supabase as never);

    await repository.claimPlatformSentMessage({
      ticket_id: "ticket-1", platform,
      client_operation_id: "11111111-1111-4111-8111-111111111111",
      body: "reply", reply_intent: "holding", sent_by: "operator",
    });
    await repository.recordPlatformSentMessagePreflight("ticket-1", "operation-1", platform, ["before-1"]);
    await repository.markPlatformSentMessageAmbiguous("ticket-1", "operation-1", platform, "provider timeout");
    await repository.releasePlatformSentMessageClaim("ticket-1", "operation-1", platform, "reply", "holding");
    await repository.finalizeSentMessage({
      ticket_id: "ticket-1", client_operation_id: "operation-1",
      platform,
      body: "reply", reply_intent: "holding",
      platform_message_id: "provider-1", platform_sent_at: "2026-09-08T00:00:01Z",
      sent_by: "operator",
    });

    const referencedColumns = new Set([
      ...queries.flatMap((query) => query.filters.map((filter) => filter.column)),
      ...queries.flatMap((query) => query.payloads.flatMap((payload) => Object.keys(payload))),
    ]);
    for (const column of AMAZON_ONLY_COLUMNS) {
      assert.equal(referencedColumns.has(column), false, `platform-neutral lifecycle referenced ${column}`);
    }
    for (const query of queries.slice(1)) {
      assert.equal(
        query.filters.some((filter) => filter.column === "platform" && filter.value === platform),
        true,
        `${platform} mutation/read must include its platform predicate`,
      );
    }
    assert.deepEqual(rpcNames, [
      `release_${platform}_operator_message_claim_v1`,
      `finalize_${platform}_operator_message_send`,
    ]);
    assert.deepEqual(rpcPayloads[0], {
      p_ticket_id: "ticket-1",
      p_client_operation_id: "operation-1",
      p_expected_body: "reply",
      p_expected_reply_intent: "holding",
    });
    assert.deepEqual(rpcPayloads[1], {
      p_ticket_id: "ticket-1",
      p_client_operation_id: "operation-1",
      p_expected_body: "reply",
      p_expected_reply_intent: "holding",
      p_platform_message_id: "provider-1",
      p_platform_sent_at: "2026-09-08T00:00:01Z",
      p_sent_by: "operator",
    });
  });
  }

  it("fences every direct Amazon lifecycle mutation to platform=amazon", async () => {
    const queries: QueryRecorder[] = [];
    const supabase = {
      from(table: string) {
        assert.equal(table, "sent_messages");
        const query = new QueryRecorder();
        queries.push(query);
        return query;
      },
    };
    const repository = new SupabaseCopywritingRepository(supabase as never);
    await repository.recordAmazonMailSentMessagePreflight("ticket-1", "operation-1", [], 1);
    await repository.markAmazonMailSentMessageAmbiguous("ticket-1", "operation-1", "timeout", 1);
    await repository.releaseAmazonMailSentMessageClaim("ticket-1", "operation-1", 1);

    for (const query of queries) {
      assert.equal(
        query.filters.some((filter) => filter.column === "platform" && filter.value === "amazon"),
        true,
        "Amazon mutation must include its platform predicate",
      );
    }
  });
});
