import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAuthenticationResults, ZohoMailClient } from "../src/clients/zoho-mail";
import { syncAmazonMail } from "../src/services/amazonMailSyncService";
import { AmazonMailSendService } from "../src/services/amazonMailSendService";
import { reconcileAmazonMailAttachments } from "../src/services/amazonMailAttachmentService";

const config = {
  accountsBase: "https://accounts.test",
  apiBase: "https://mail.test/api",
  accountId: "account-1",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  fromAddress: "amazon@retailpulses.com",
};

test("requires aligned Amazon DKIM and DMARC authentication", () => {
  assert.deepEqual(parseAuthenticationResults({
    "Authentication-Results": "mx.test; dkim=pass header.d=amazon.co.jp; dmarc=pass header.from=marketplace.amazon.co.jp; spf=pass",
  }), {
    status: "pass", domain: "marketplace.amazon.co.jp", dkim: "pass", dmarc: "pass", spf: "pass",
  });
  assert.equal(parseAuthenticationResults({
    "Authentication-Results": "mx.test; dkim=pass header.d=evil.test; dmarc=pass header.from=evil.test; spf=pass",
  }).status, "failed");
  assert.equal(parseAuthenticationResults({}).status, "unavailable");
});

test("Zoho client keeps OAuth secrets in token body and access token in headers", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new ZohoMailClient(config, async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/oauth/v2/token")) {
      return Response.json({ access_token: "short-lived", expires_in: 3600 });
    }
    return Response.json({ data: [] });
  });
  await client.searchMessages({ searchKey: "sender:@marketplace.amazon.co.jp", start: 1, limit: 100 });
  assert.equal(requests[0].url.includes("refresh-token"), false);
  assert.match(String(requests[0].init.body), /refresh_token=refresh-token/);
  assert.equal((requests[1].init.headers as Record<string, string>).Authorization, "Zoho-oauthtoken short-lived");
  assert.equal(requests[1].url.includes("short-lived"), false);
});

test("default Zoho fetch wrapper does not bind the client as fetch this", async () => {
  const originalFetch = globalThis.fetch;
  let observedThis: unknown = Symbol("unset");
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
    observedThis = this;
    if (String(input).includes("/oauth/v2/token")) {
      return Promise.resolve(Response.json({ access_token: "access", expires_in: 3600 }));
    }
    return Promise.resolve(Response.json({ data: [] }));
  } as typeof fetch;
  try {
    const client = new ZohoMailClient(config);
    await client.searchMessages({ searchKey: "in:inbox", start: 1, limit: 1 });
    assert.notEqual(observedThis, client);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reply fixes sender server-side and targets the original message endpoint", async () => {
  let posted: { url: string; body: Record<string, unknown> } | null = null;
  const client = new ZohoMailClient(config, async (url, init = {}) => {
    if (String(url).includes("/oauth/v2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
    posted = { url: String(url), body: JSON.parse(String(init.body)) };
    return Response.json({ data: { messageId: "sent-1" } });
  });
  const result = await client.reply({
    messageId: "source-1", toAddress: "masked@marketplace.amazon.co.jp",
    subject: "Re: Amazon", content: "reply",
  });
  assert.equal(posted!.url, "https://mail.test/api/accounts/account-1/messages/source-1");
  assert.equal(posted!.body.fromAddress, "amazon@retailpulses.com");
  assert.equal(posted!.body.action, "reply");
  assert.equal(result.messageId, "sent-1");
});

test("migration preserves manual ticket authority and frozen continuation windows", () => {
  const sql = readFileSync(new URL(
    "../../../supabase/migrations/20260907160000_amazon_zoho_mail_pipeline.sql",
    import.meta.url,
  ), "utf8");
  const ingest = sql.slice(sql.indexOf("FUNCTION public.ingest_amazon_mail_message"), sql.indexOf("FUNCTION public.convert_amazon_mail_to_ticket"));
  assert.doesNotMatch(ingest, /INSERT INTO public\.tickets/i);
  assert.match(sql, /window_start timestamptz/);
  assert.match(sql, /run_to timestamptz/);
  assert.match(sql, /status IN \('pending_customer', 'pending_third_party', 'resolved', 'closed', 'canceled'\)/);
  assert.match(sql, /source_inbound_message_id uuid/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.convert_amazon_mail_to_ticket/);
  assert.match(sql, /FUNCTION public\.finalize_amazon_mail_send/);
  assert.match(sql, /FOR UPDATE;[\s\S]*amazon_outbound_source_mismatch/);
  assert.match(sql, /v_latest\.source_received_at IS DISTINCT FROM v_sent\.reviewed_customer_message_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reviewed_customer_message_id text/);
  assert.match(sql, /IF v_sent\.reply_intent = 'terminal' AND NOT v_newer THEN/);
  assert.match(sql, /ELSIF v_newer THEN[\s\S]*needs_reply = true/);
  assert.doesNotMatch(sql, /finalize_operator_message_send\(/);
  assert.match(sql, /FUNCTION public\.claim_amazon_mail_attachments/);
  assert.match(sql, /linked_ticket_id IS NOT NULL/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_active_send_lease/);
  assert.match(sql, /FUNCTION public\.claim_amazon_mail_send/);
  assert.match(sql, /reviewed_thread_revision IS DISTINCT FROM p_reviewed_thread_revision/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS message_revision bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /AFTER INSERT ON public\.ticket_messages/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 1/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS lease_claimed_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /SET lease_generation = lease_generation \+ 1,[\s\S]*lease_claimed_at = now\(\)/);
  assert.match(sql, /FUNCTION public\.begin_amazon_mail_provider_mutation/);
  assert.match(sql, /v_sent\.lease_generation IS DISTINCT FROM p_lease_generation/);
  assert.match(sql, /v_ticket\.message_revision::text IS DISTINCT FROM v_sent\.reviewed_thread_revision/);
  assert.match(sql, /delivery_status IN \('sending', 'sent', 'ambiguous', 'confirmed_not_sent'\)/);
  assert.match(sql, /SET delivery_status = 'confirmed_not_sent'/);
  assert.match(sql, /provider_mutation_started_at \+ interval '30 minutes'/);
  assert.match(sql, /no_send_first_observed_at \+ interval '5 minutes'/);
  assert.match(sql, /platform = 'amazon' AND delivery_status IN \('ambiguous', 'confirmed_not_sent'\)/);
  assert.match(sql, /IF v_sent\.delivery_status = 'confirmed_not_sent' THEN[\s\S]*amazon_send_confirmed_not_sent/);
  assert.match(sql, /FUNCTION public\.promote_abandoned_amazon_send/);
  assert.match(sql, /provider_mutation_started_at < now\(\) - interval '5 minutes'/);
  assert.match(sql, /v_ticket\.message_revision::text IS DISTINCT FROM v_sent\.reviewed_thread_revision[\s\S]*v_latest\.id IS DISTINCT/);
  assert.match(sql, /v_external_message_id, 'completed', 'failed', 'source_not_applicable'/);
  assert.doesNotMatch(sql, /v_ticket\.message_revision IS DISTINCT FROM v_sent\.reviewed_thread_revision::bigint \+ 1/);
  assert.match(sql, /FUNCTION public\.finalize_amazon_mail_attachment_batch/);
  assert.match(sql, /attachment_processing_attempts < 4/);
  assert.match(sql, /customer_message_revision::text IS DISTINCT FROM v_sent\.reviewed_customer_revision/);
  assert.match(sql, /attachment_retries_exhausted[\s\S]*attachment_processing_attempts >= 5/);
  assert.match(sql, /attachment_processing_attempts = 4[\s\S]*attachment_claimed_at < now\(\) - interval '15 minutes'/);
  const sourceConstraint = sql.slice(
    sql.indexOf("ADD CONSTRAINT chk_inbound_ticket_messages_source_fields"),
    sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_amazon_provider_message"),
  );
  assert.doesNotMatch(sourceConstraint, /source = 'amazon_zoho_mail'[\s\S]*\n\s+AND account_id IS NOT NULL/);
});

test("v3 migration preserves atomic Amazon ticket projection and truthful replay result", () => {
  const sql = readFileSync(new URL(
    "../../../supabase/migrations/20260909011500_amazon_mail_ingestion_v3.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /FUNCTION public\.ingest_amazon_mail_message_v3/);
  assert.match(sql, /FROM public\.tickets[\s\S]*platform = 'amazon'[\s\S]*account_id = p_account_id/);
  assert.match(sql, /INSERT INTO public\.ticket_messages/);
  assert.match(sql, /ON CONFLICT \(platform, external_message_id\)[\s\S]*DO NOTHING/);
  assert.match(sql, /UPDATE public\.tickets[\s\S]*needs_reply = CASE/);
  assert.match(sql, /'evidence_inserted', v_inserted/);
  assert.doesNotMatch(sql, /inbound_ticket_messages/);
});

const syncEnv = {
  ZOHO_MAIL_ACCOUNT_ID: "account-1",
  ZOHO_MAIL_INBOX_FOLDER_ID: "inbox-1",
  AMAZON_PLATFORM_ACCOUNT_ID: "00000000-0000-0000-0000-000000000001",
  AMAZON_MAIL_INITIAL_LOOKBACK_HOURS: "24",
  AMAZON_MAIL_OVERLAP_MINUTES: "15",
} as never;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1", folderId: "inbox-1", threadId: "thread-1",
    receivedTime: String(Date.parse("2026-09-07T01:00:00Z")),
    sentDateInGMT: "", fromAddress: "buyer@marketplace.amazon.co.jp",
    subject: "Amazon 249-8835835-9935024", summary: "buyer message",
    hasAttachment: 1, hasInline: 0, size: 200, ...overrides,
  };
}

test("shadow sync performs no database writes or content/attachment fetches", async () => {
  let contentReads = 0;
  let attachmentReads = 0;
  const supabase = new Proxy({}, {
    get() { throw new Error("shadow_must_not_touch_database"); },
  });
  const client = {
    searchMessages: async () => [candidate()],
    getAuthentication: async () => ({ status: "pass", domain: "amazon.co.jp" }),
    getMessageContent: async () => { contentReads += 1; return "secret"; },
    getAttachmentInfo: async () => { attachmentReads += 1; return []; },
  };
  const report = await syncAmazonMail(syncEnv, supabase as never, {
    mode: "shadow", now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  });
  assert.equal(report.authenticated, 1);
  assert.equal(report.persisted, 0);
  assert.equal(contentReads, 0);
  assert.equal(attachmentReads, 0);
});

test("active sync resumes a frozen UTC-day segment and advances to the prior day", async () => {
  const searches: Array<Record<string, unknown>> = [];
  let upserted: Record<string, unknown> | null = null;
  const state = {
    generation: 4,
    watermark_received_at: "2026-09-05T00:00:00Z", watermark_message_id: "old",
    window_start: "2026-09-05T23:45:00Z", run_to: "2026-09-07T03:00:00Z",
    continuation: JSON.stringify({ segment_date: "2026-09-06" }),
  };
  const supabase = {
    from(table: string) {
      if (table !== "amazon_mail_sync_state_v2") throw new Error(`unexpected_table:${table}`);
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: state, error: null }; },
      };
    },
    async rpc(name: string, body: Record<string, unknown>) {
      if (name === "seed_amazon_mail_sync_state_v2_from_legacy") return { data: state, error: null };
      assert.equal(name, "upsert_amazon_mail_sync_state_v2");
      upserted = body;
      return { data: { generation: 5 }, error: null };
    },
  };
  const client = {
    searchMessages: async (input: Record<string, unknown>) => { searches.push(input); return []; },
  };
  const report = await syncAmazonMail(syncEnv, supabase as never, {
    mode: "active", now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  });
  assert.equal(searches[0].start, 1);
  assert.match(String(searches[0].searchKey), /fromDate:06-Sept?-2026::toDate:06-Sept?-2026/);
  assert.equal(upserted!.p_expected_generation, 4);
  assert.equal(upserted!.p_watermark_received_at, "2026-09-05T00:00:00Z");
  assert.equal(upserted!.p_continuation, JSON.stringify({ segment_date: "2026-09-05" }));
  assert.equal(report.checkpointAdvanced, false);
  assert.equal(report.continuation, true);
});

test("SQL-owned seed preserves an unfinished legacy window then writes only v2 CAS", async () => {
  let checkpoint: Record<string, unknown> | null = null;
  const legacy = {
    watermark_received_at: "2026-09-04T00:00:00Z", watermark_message_id: "legacy",
    window_start: "2026-09-04T23:45:00Z", run_to: "2026-09-06T03:00:00Z",
    continuation: JSON.stringify({ segment_date: "2026-09-05" }),
  };
  const supabase = {
    async rpc(name: string, body: Record<string, unknown>) {
      if (name === "seed_amazon_mail_sync_state_v2_from_legacy") {
        return { data: { generation: 1, ...legacy, source: "legacy_seeded" }, error: null };
      }
      assert.equal(name, "upsert_amazon_mail_sync_state_v2");
      checkpoint = body;
      return { data: { generation: 1 }, error: null };
    },
  };
  const report = await syncAmazonMail(syncEnv, supabase as never, {
    mode: "active", now: new Date("2026-09-07T02:00:00Z"),
    client: { searchMessages: async () => [] } as never,
  });
  assert.equal(checkpoint!.p_expected_generation, 1);
  assert.equal(checkpoint!.p_watermark_received_at, "2026-09-04T00:00:00Z");
  assert.equal(report.continuation, true);
});

test("a full final page fails the UTC-day segment closed without advancing state", async () => {
  let writes = 0;
  let searches = 0;
  const supabase = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert() { writes += 1; return { error: null }; },
      };
    },
    async rpc(name: string) {
      assert.equal(name, "seed_amazon_mail_sync_state_v2_from_legacy");
      return { data: { generation: 1, watermark_received_at: null, watermark_message_id: null, window_start: null, run_to: null, continuation: null }, error: null };
    },
  };
  await assert.rejects(
    () => syncAmazonMail(syncEnv, supabase as never, {
      mode: "active", now: new Date("2026-09-07T02:00:00Z"), maxPages: 2, pageSize: 1,
      client: { searchMessages: async () => {
        searches += 1;
        return [{ ...candidate(), fromAddress: "not-amazon@example.com" }];
      } } as never,
    }),
    /amazon_mail_day_segment_overflow/,
  );
  assert.equal(searches, 2);
  assert.equal(writes, 0);
});

test("failed provider page never advances the active checkpoint", async () => {
  let writes = 0;
  const supabase = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert() { writes += 1; return { error: null }; },
      };
    },
    async rpc(name: string) {
      assert.equal(name, "seed_amazon_mail_sync_state_v2_from_legacy");
      return { data: { generation: 1, watermark_received_at: null, watermark_message_id: null, window_start: null, run_to: null, continuation: null }, error: null };
    },
  };
  await assert.rejects(
    () => syncAmazonMail(syncEnv, supabase as never, {
      mode: "active", now: new Date("2026-09-07T02:00:00Z"),
      client: { searchMessages: async () => { throw new Error("provider_down"); } } as never,
    }),
    /provider_down/,
  );
  assert.equal(writes, 0);
});

test("targeted active canary persists only its match without consuming shared checkpoint", async () => {
  let stateReads = 0;
  let stateWrites = 0;
  let ingests = 0;
  const supabase = {
    from() {
      stateReads += 1;
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert() { stateWrites += 1; return { error: null }; },
      };
    },
    async rpc() { ingests += 1; return { data: { inserted: true }, error: null }; },
  };
  const client = {
    searchMessages: async () => [candidate()],
    getAuthentication: async () => ({ status: "pass", domain: "amazon.co.jp" }),
    getMessageContent: async () => "buyer message",
    getAttachmentInfo: async () => [],
  };
  const report = await syncAmazonMail(syncEnv, supabase as never, {
    mode: "active", targetOrderNumber: "249-8835835-9935024",
    now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  });
  assert.equal(ingests, 1);
  assert.equal(stateReads, 0);
  assert.equal(stateWrites, 0);
  assert.equal(report.checkpointAdvanced, false);
});

test("missing Amazon platform mapping fails closed before provider or database access", async () => {
  let providerReads = 0;
  const supabase = {
    async rpc() { throw new Error("database_must_not_be_touched"); },
  };
  const client = {
    searchMessages: async () => { providerReads += 1; return [candidate({ hasAttachment: 0 })]; },
    getAuthentication: async () => ({ status: "pass", domain: "amazon.co.jp" }),
    getMessageContent: async () => "buyer message",
  };
  await assert.rejects(() => syncAmazonMail({
    ...syncEnv, AMAZON_PLATFORM_ACCOUNT_ID: undefined,
  } as never, supabase as never, {
    mode: "active", targetOrderNumber: "249-8835835-9935024",
    now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  }), /amazon_mail_account_mapping_not_configured/);
  assert.equal(providerReads, 0);
});

test("disabled attachment switch leaves trusted references pending with zero attachment I/O", async () => {
  const rpcNames: string[] = [];
  let downloads = 0;
  const supabase = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert() { return { error: null }; },
      };
    },
    async rpc(name: string) { rpcNames.push(name); return { data: { inserted: true }, error: null }; },
    storage: { from() { throw new Error("storage_must_not_be_touched"); } },
  };
  const client = {
    searchMessages: async () => [candidate()],
    getAuthentication: async () => ({ status: "pass", domain: "amazon.co.jp" }),
    getMessageContent: async () => "buyer message",
    getAttachmentInfo: async () => [{ attachmentId: "attachment-1", contentType: "image/jpeg", attachmentSize: 5 }],
    downloadAttachment: async () => { downloads += 1; throw new Error("must_not_download"); },
  };
  await syncAmazonMail({ ...syncEnv, AMAZON_MAIL_ATTACHMENTS_ENABLED: "false" } as never, supabase as never, {
    mode: "active", now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  });
  assert.deepEqual(rpcNames, ["seed_amazon_mail_sync_state_v2_from_legacy", "ingest_amazon_mail_message_v3", "upsert_amazon_mail_sync_state_v2"]);
  assert.equal(downloads, 0);
});

test("unavailable v2 attachment adapter cannot fail an otherwise successful ingestion run", async () => {
  const supabase = {
    from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: null }; } }; },
    async rpc() { return { data: { inserted: true }, error: null }; },
  };
  const report = await syncAmazonMail({ ...syncEnv, AMAZON_MAIL_ATTACHMENTS_ENABLED: "true" } as never, supabase as never, {
    mode: "active", now: new Date("2026-09-07T02:00:00Z"),
    client: { searchMessages: async () => [] } as never,
  });
  assert.equal(report.failed, 0);
  assert.equal(report.attachmentErrors, 1);
});

test("untrusted active mail persists metadata without fetching body or attachments", async () => {
  let contentReads = 0;
  let attachmentReads = 0;
  let rpcBody: Record<string, unknown> | null = null;
  const supabase = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert() { return { error: null }; },
      };
    },
    async rpc(name: string, body: Record<string, unknown>) {
      if (name === "ingest_amazon_mail_message_v3") rpcBody = body;
      return { data: { inserted: true }, error: null };
    },
  };
  const client = {
    searchMessages: async () => [candidate()],
    getAuthentication: async () => ({ status: "failed", domain: "evil.test" }),
    getMessageContent: async () => { contentReads += 1; return "must not read"; },
    getAttachmentInfo: async () => { attachmentReads += 1; return []; },
  };
  await syncAmazonMail(syncEnv, supabase as never, {
    mode: "active", now: new Date("2026-09-07T02:00:00Z"), client: client as never,
  });
  assert.equal(contentReads, 0);
  assert.equal(attachmentReads, 0);
  assert.equal(rpcBody!.p_body, "");
  assert.equal(rpcBody!.p_attachment_count, 0);
});

test("ambiguous Amazon retry reconciles its reviewed source and never posts twice", async () => {
  let replyPosts = 0;
  let claimedSource = "";
  let claimedReviewed = "";
  const source = {
    id: "11111111-1111-4111-8111-111111111111",
    external_order_id: "249-8835835-9935024",
    provider_folder_id: "inbox-1", provider_message_id: "source-1",
    provider_account_id: "account-1", provider_thread_id: "thread-1", source_received_at: "2026-09-07T01:00:00Z",
    message_subject: "Amazon order", mail_auth_status: "pass",
  };
  const supabase = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: source, error: null }; },
      };
    },
  };
  const repo = {
    claimAmazonMailSentMessage: async (input: { source_inbound_message_id: string; reviewed_customer_message_id: string }) => {
      claimedSource = input.source_inbound_message_id;
      claimedReviewed = input.reviewed_customer_message_id;
      return { claimed: false, ticketMessage: null, sentMessage: {
      id: "sent-1", ticket_id: "ticket-1", platform: "amazon", platform_message_id: null,
      body: "reply", reply_intent: "terminal", sent_by: "portal_operator",
      sent_at: "2026-09-07T01:01:00Z", created_at: "2026-09-07T01:01:00Z",
      client_operation_id: "22222222-2222-4222-8222-222222222222",
      delivery_status: "ambiguous", delivery_error: null, platform_message_ids_before_send: [],
    } }; },
    finalizeAmazonMailSend: async (input: { platform_message_id: string }) => {
      return {
        replayed: false, newerCustomerMessage: true,
        sentMessage: { platform_message_id: input.platform_message_id, sent_at: "2026-09-07T01:02:00Z" },
        ticketMessage: { external_message_id: input.platform_message_id },
      };
    },
  };
  const client = {
    searchMessages: async () => [{
      ...candidate({ messageId: "sent-1", folderId: "sent-folder", fromAddress: "amazon@retailpulses.com" }),
      toAddress: "buyer@marketplace.amazon.co.jp",
      sentDateInGMT: String(Date.parse("2026-09-07T01:02:00Z")),
    }],
    getMessageDetails: async () => candidate({ messageId: "source-1", fromAddress: "buyer@marketplace.amazon.co.jp" }),
    getMessageContent: async () => "reply",
    reply: async () => { replyPosts += 1; throw new Error("must_not_post"); },
  };
  const result = await new AmazonMailSendService(
    supabase as never, repo as never, client as never, "sent-folder",
  ).send({
    ticket: { id: "ticket-1" } as never,
    message: "reply", clientOperationId: "22222222-2222-4222-8222-222222222222",
    replyIntent: "terminal", reviewedCustomerMessageId: "zoho:account-1:source-1",
    reviewedCustomerRevision: "customer-revision-1", reviewedThreadRevision: "thread-revision-1",
    lastSeenMessageAt: "2026-09-07T01:00:00Z", sentBy: "portal_operator",
  });
  assert.equal(replyPosts, 0);
  assert.equal(claimedSource, source.id);
  assert.equal(claimedReviewed, "zoho:account-1:source-1");
  assert.equal(result.newerCustomerMessage, true);
});

test("ambiguous reconciliation stays blocked when multiple post-baseline bodies match", async () => {
  let replyPosts = 0;
  let finalizations = 0;
  const source = {
    id: "11111111-1111-4111-8111-111111111111",
    external_order_id: "249-8835835-9935024", provider_folder_id: "inbox-1",
    provider_message_id: "source-1", provider_account_id: "account-1",
    provider_thread_id: "thread-1",
    source_received_at: "2026-09-07T01:00:00Z", message_subject: "Amazon", mail_auth_status: "pass",
  };
  const supabase = { from() { return {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: source, error: null }; },
  }; } };
  const repo = {
    claimAmazonMailSentMessage: async () => ({ claimed: false, ticketMessage: null, sentMessage: {
      id: "sent-1", ticket_id: "ticket-1", platform: "amazon", platform_message_id: null,
      body: "same reply", reply_intent: "terminal", sent_by: "portal_operator",
      sent_at: "2026-09-07T01:01:00Z", created_at: "2026-09-07T01:01:00Z",
      client_operation_id: "22222222-2222-4222-8222-222222222222",
      delivery_status: "ambiguous", delivery_error: "zoho_reply_result_unknown",
      platform_message_ids_before_send: ["old"],
    } }),
    finalizeAmazonMailSend: async () => { finalizations += 1; throw new Error("must_not_finalize"); },
  };
  const providerRows = ["old", "new-1", "new-2"].map((messageId, index) => ({
    ...candidate({ messageId, folderId: "sent-folder", fromAddress: "amazon@retailpulses.com" }),
    toAddress: "buyer@marketplace.amazon.co.jp",
    sentDateInGMT: String(Date.parse(`2026-09-07T01:0${index + 1}:00Z`)),
  }));
  const client = {
    searchMessages: async () => providerRows,
    getMessageContent: async () => "same reply",
    getMessageDetails: async () => candidate({ messageId: "source-1", fromAddress: "buyer@marketplace.amazon.co.jp" }),
    reply: async () => { replyPosts += 1; throw new Error("must_not_post"); },
  };
  await assert.rejects(
    () => new AmazonMailSendService(supabase as never, repo as never, client as never, "sent-folder").send({
      ticket: { id: "ticket-1" } as never, message: "same reply",
      clientOperationId: "22222222-2222-4222-8222-222222222222", replyIntent: "terminal",
      reviewedCustomerMessageId: "zoho:account-1:source-1",
      reviewedCustomerRevision: "customer-revision-1", reviewedThreadRevision: "thread-revision-1",
      lastSeenMessageAt: "2026-09-07T01:00:00Z", sentBy: "portal_operator",
    }),
    (error: Error & { code?: string }) => error.code === "DELIVERY_UNCONFIRMED",
  );
  assert.equal(replyPosts, 0);
  assert.equal(finalizations, 0);
});

test("every failure before Zoho mutation releases a newly-created Amazon claim", async () => {
  let releases = 0;
  let searches = 0;
  let replyPosts = 0;
  const source = {
    id: "11111111-1111-4111-8111-111111111111",
    external_order_id: "249-8835835-9935024", provider_folder_id: "inbox-1",
    provider_message_id: "source-1", provider_account_id: "account-1", provider_thread_id: "thread-1",
    source_received_at: "2026-09-07T01:00:00Z", message_subject: "Amazon", mail_auth_status: "pass",
  };
  const supabase = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    async maybeSingle() { return { data: source, error: null }; },
  }; } };
  const repo = {
    claimAmazonMailSentMessage: async () => ({ claimed: true, ticketMessage: null, sentMessage: {
      id: "sent-1", ticket_id: "ticket-1", platform: "amazon", platform_message_id: null,
      body: "reply", reply_intent: "terminal", sent_by: "portal_operator",
      sent_at: "2026-09-07T01:01:00Z", created_at: "2026-09-07T01:01:00Z",
      client_operation_id: "22222222-2222-4222-8222-222222222222",
      delivery_status: "sending", delivery_error: null, platform_message_ids_before_send: null,
    } }),
    releaseAmazonMailSentMessageClaim: async () => { releases += 1; },
  };
  const client = {
    searchMessages: async () => {
      searches += 1;
      if (searches === 1) return [{ ...candidate({ messageId: "source-1" }) }];
      throw new Error("sent_baseline_unavailable");
    },
    reply: async () => { replyPosts += 1; throw new Error("must_not_post"); },
  };
  await assert.rejects(
    () => new AmazonMailSendService(supabase as never, repo as never, client as never, "sent-folder").send({
      ticket: { id: "ticket-1" } as never, message: "reply",
      clientOperationId: "22222222-2222-4222-8222-222222222222", replyIntent: "terminal",
      reviewedCustomerMessageId: "zoho:account-1:source-1",
      reviewedCustomerRevision: "customer-revision-1", reviewedThreadRevision: "thread-revision-1",
      lastSeenMessageAt: "2026-09-07T01:00:00Z", sentBy: "portal_operator",
    }),
    /sent_baseline_unavailable/,
  );
  assert.equal(releases, 1);
  assert.equal(replyPosts, 0);
});

test("a reclaimed Amazon lease fences the old worker before the Zoho mutation", async () => {
  let releases = 0;
  let replyPosts = 0;
  const source = {
    id: "11111111-1111-4111-8111-111111111111", external_order_id: "249-8835835-9935024",
    provider_folder_id: "inbox-1", provider_message_id: "source-1", provider_account_id: "account-1",
    provider_thread_id: "thread-1", source_received_at: "2026-09-07T01:00:00Z",
    message_subject: "Amazon", mail_auth_status: "pass",
  };
  const supabase = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    async maybeSingle() { return { data: source, error: null }; },
  }; } };
  const repo = {
    claimAmazonMailSentMessage: async () => ({ claimed: true, ticketMessage: null, sentMessage: {
      id: "sent-1", ticket_id: "ticket-1", platform: "amazon", platform_message_id: null,
      body: "reply", reply_intent: "terminal", sent_by: "portal_operator", sent_at: "2026-09-07T01:01:00Z",
      created_at: "2026-09-07T01:01:00Z", client_operation_id: "22222222-2222-4222-8222-222222222222",
      delivery_status: "sending", delivery_error: null, platform_message_ids_before_send: null,
      provider_mutation_started_at: null, lease_generation: 1,
    } }),
    recordAmazonMailSentMessagePreflight: async () => undefined,
    markSentMessageProviderMutationStarted: async () => { throw new Error("amazon_send_lease_fenced"); },
    releaseAmazonMailSentMessageClaim: async () => { releases += 1; },
  };
  let searches = 0;
  const client = {
    searchMessages: async () => searches++ === 0 ? [candidate({ messageId: "source-1" })] : [],
    getMessageDetails: async () => candidate({ messageId: "source-1", fromAddress: "buyer@marketplace.amazon.co.jp" }),
    reply: async () => { replyPosts += 1; throw new Error("must_not_post"); },
  };
  await assert.rejects(
    () => new AmazonMailSendService(supabase as never, repo as never, client as never, "sent-folder", "account-1").send({
      ticket: { id: "ticket-1" } as never, message: "reply",
      clientOperationId: "22222222-2222-4222-8222-222222222222", replyIntent: "terminal",
      reviewedCustomerMessageId: "zoho:account-1:source-1", reviewedCustomerRevision: "1", reviewedThreadRevision: "1",
      lastSeenMessageAt: "2026-09-07T01:00:00Z", sentBy: "portal_operator",
    }),
    (error: Error & { code?: string }) => error.code === "SEND_IN_PROGRESS",
  );
  assert.equal(releases, 1);
  assert.equal(replyPosts, 0);
});

test("operator can durably confirm no Sent match without outbound mutation", async () => {
  let resolvedRpc = "";
  let replyPosts = 0;
  const source = {
    id: "11111111-1111-4111-8111-111111111111", external_order_id: "249-8835835-9935024",
    provider_folder_id: "inbox-1", provider_message_id: "source-1", provider_account_id: "account-1",
    provider_thread_id: "thread-1", source_received_at: "2026-09-07T01:00:00Z",
    message_subject: "Amazon", mail_auth_status: "pass",
  };
  const sent = {
    client_operation_id: "22222222-2222-4222-8222-222222222222", body: "reply", delivery_status: "ambiguous",
    created_at: "2026-09-07T01:01:00Z", provider_mutation_started_at: "2026-09-07T01:01:30Z",
    source_inbound_message_id: source.id, platform_message_ids_before_send: [],
  };
  const supabase = {
    from(table: string) { const row = table === "sent_messages" ? sent : source; return {
      select() { return this; }, eq() { return this; }, in() { return this; },
      async maybeSingle() { return { data: row, error: null }; },
    }; },
    async rpc(name: string) { resolvedRpc = name; return { data: null, error: null }; },
  };
  const client = {
    searchMessages: async () => [],
    getMessageDetails: async () => candidate({ messageId: "source-1", fromAddress: "buyer@marketplace.amazon.co.jp" }),
    getMessageContent: async () => "",
    reply: async () => { replyPosts += 1; throw new Error("must_not_post"); },
  };
  const result = await new AmazonMailSendService(
    supabase as never, {} as never, client as never, "sent-folder", "account-1",
  ).resolveActiveLease({
    ticketId: "ticket-1", clientOperationId: sent.client_operation_id,
    resolution: "confirmed_not_sent", sentBy: "portal_operator",
  });
  assert.equal(result.resolution, "confirmed_not_sent");
  assert.equal(resolvedRpc, "resolve_amazon_mail_send_as_not_sent");
  assert.equal(replyPosts, 0);
});

test("attachment reconciliation stores verified image evidence only after ticket linking", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  let uploadPath = "";
  let batch: Array<Record<string, unknown>> = [];
  const claimed = [{
    id: "inbound-1", linked_ticket_id: "ticket-1", provider_account_id: "account-1",
    provider_folder_id: "inbox-1", provider_message_id: "message-1",
    attachment_processing_attempts: 1,
    provider_metadata: { attachments: [{
      attachment_id: "attachment-1", declared_size: 5,
      declared_mime: "image/jpeg", filename: "photo.jpg", state: "waiting_for_ticket",
    }] },
  }];
  const supabase = {
    async rpc(name: string, args?: { p_results?: Array<Record<string, unknown>> }) {
      if (name === "claim_amazon_mail_attachments") return { data: claimed, error: null };
      if (name === "finalize_amazon_mail_attachment_batch") {
        batch = args?.p_results || [];
        return { data: batch.length, error: null };
      }
      throw new Error(`unexpected_rpc:${name}`);
    },
    storage: { from() { return { async upload(path: string) { uploadPath = path; return { error: null }; } }; } },
  };
  const client = {
    getAttachmentInfo: async () => [{ attachmentId: "attachment-1", attachmentName: "photo.jpg" }],
    downloadAttachment: async () => new Response(jpeg, {
      headers: { "content-type": "image/jpeg", "content-length": "5" },
    }),
  };
  const report = await reconcileAmazonMailAttachments(
    { AMAZON_MAIL_RECONCILIATION_LIMIT: "1" } as never, supabase as never, client as never,
  );
  assert.equal(report.stored, 1);
  assert.match(uploadPath, /^tickets\/ticket-1\/amazon-zoho\/[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.jpg$/);
  const evidence = batch[0].evidence as Array<Record<string, unknown>>;
  assert.equal(evidence[0].ticket_id, "ticket-1");
  assert.equal(evidence[0].storage_bucket, "ticket-attachments");
  assert.equal(evidence[0].filename, "photo.jpg");
  assert.equal(((batch[0].provider_metadata as { attachments: Array<{ filename?: string }> }).attachments[0]).filename, undefined);
  assert.equal(batch[0].status, "completed");
});

test("exhausted attachment recovery reads deterministic Storage without another Zoho download", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  let zohoDownloads = 0;
  let finalized: Array<Record<string, unknown>> = [];
  const referenceBytes = new TextEncoder().encode("account-1:message-1:attachment-1");
  const referenceHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", referenceBytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const objectName = `${"a".repeat(64)}-${referenceHash}.jpg`;
  const claimed = [{
    id: "inbound-1", linked_ticket_id: "ticket-1", provider_account_id: "account-1",
    provider_folder_id: "inbox-1", provider_message_id: "message-1",
    attachment_processing_attempts: 5,
    provider_metadata: { attachments: [{
      attachment_id: "attachment-1", declared_size: 5,
      declared_mime: "image/jpeg", state: "failed",
    }] },
  }];
  const supabase = {
    async rpc(name: string, args?: { p_results?: Array<Record<string, unknown>> }) {
      if (name === "claim_amazon_mail_attachments") return { data: claimed, error: null };
      finalized = args?.p_results || [];
      return { data: finalized.length, error: null };
    },
    storage: { from() { return {
      async list() { return { data: [{ name: objectName }], error: null }; },
      async download() { return { data: new Blob([jpeg], { type: "image/jpeg" }), error: null }; },
    }; } },
  };
  const client = {
    getAttachmentInfo: async () => [{ attachmentId: "attachment-1", attachmentName: "photo.jpg" }],
    downloadAttachment: async () => { zohoDownloads += 1; throw new Error("must_not_download"); },
  };
  const report = await reconcileAmazonMailAttachments(
    { AMAZON_MAIL_RECONCILIATION_LIMIT: "1" } as never, supabase as never, client as never,
  );
  assert.equal(zohoDownloads, 0);
  assert.equal(report.stored, 1);
  assert.equal(finalized[0].status, "completed");
  assert.equal((finalized[0].evidence as unknown[]).length, 1);
});
