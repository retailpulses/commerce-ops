import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_FORM_MAX_FILE_SIZE_BYTES,
  evidenceSignatureMatches,
  handleFormSubmit,
  validateCustomerFormFiles,
} from "../src/handlers/customer-form";

describe("stored evidence content signatures", () => {
  it("accepts supported image/video magic bytes and rejects spoofed MIME", () => {
    assert.equal(evidenceSignatureMatches("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.equal(evidenceSignatureMatches("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
    assert.equal(evidenceSignatureMatches("video/mp4", new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ])), true);
    assert.equal(evidenceSignatureMatches("video/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), true);
    assert.equal(evidenceSignatureMatches("video/mp4", new TextEncoder().encode("<html>not a video</html>")), false);
    assert.equal(evidenceSignatureMatches("image/jpeg", new TextEncoder().encode("GIF89a")), false);
  });
});

interface FakeOptions {
  uploadFailureAt?: number;
  finalizationFails?: boolean;
  finalizationCommitsButReturnsError?: boolean;
  finalizationReturnsOtherSubmission?: boolean;
  finalizationMalformed?: boolean;
  reconciliationFails?: boolean;
  tokenUpdateFails?: boolean;
}

class FakeQuery {
  private operation = "select";
  private payload: Record<string, unknown> | null = null;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(): this { return this; }
  eq(): this { return this; }
  async maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.db.options.reconciliationFails) {
      return { data: null, error: { message: "verification unavailable" } };
    }
    return { data: this.db.token, error: null };
  }
  delete(): this { this.operation = "delete"; return this; }
  insert(payload: Record<string, unknown>): this {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Record<string, unknown>): this {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  async single(): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.table === "submission_tokens") {
      return { data: this.db.token, error: null };
    }
    if (this.table === "customer_submissions" && this.operation === "insert") {
      this.db.submissionCreated = true;
      return { data: { id: "submission-1", ticket_id: null }, error: null };
    }
    return { data: null, error: null };
  }

  private async execute(): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.table === "ticket_attachments" && this.operation === "select") {
      if (this.db.options.reconciliationFails) {
        return { data: null, error: { message: "evidence verification unavailable" } };
      }
      return {
        data: this.db.attachmentPaths.map((storage_path) => ({ storage_path })),
        error: null,
      };
    }
    if (this.table === "submission_tokens" && this.operation === "update") {
      this.db.tokenUpdateCount += 1;
      if (this.db.options.tokenUpdateFails) {
        return { data: null, error: { message: "token update failed" } };
      }
      this.db.token.status = String(this.payload?.status ?? this.db.token.status);
      return { data: null, error: null };
    }
    if (this.table === "customer_submissions" && this.operation === "delete") {
      this.db.submissionDeleted = true;
    }
    if (this.table === "ticket_attachments" && this.operation === "delete") {
      this.db.attachmentRowsDeleted = true;
    }
    return { data: null, error: null };
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  readonly token = {
    id: "token-1",
    token_hash: "ignored",
    ticket_id: null as string | null,
    platform: "mercari",
    account_id: null,
    external_order_id: "order-1",
    allowed_submission_type: "aftersales_request",
    status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    max_upload_count: 5,
    used_count: 0,
    customer_submission_id: null as string | null,
  };
  submissionCreated = false;
  submissionDeleted = false;
  attachmentRowsDeleted = false;
  finalizationCount = 0;
  tokenUpdateCount = 0;
  uploadCount = 0;
  removedPaths: string[] = [];
  attachmentPaths: string[] = [];

  constructor(readonly options: FakeOptions = {}) {}

  from(table: string): FakeQuery { return new FakeQuery(this, table); }

  async rpc(_name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message: string } | null;
  }> {
    this.finalizationCount += 1;
    const submissionId = String(args.p_submission_id);
    this.attachmentPaths = (args.p_attachments as Array<{ storage_path: string }> || [])
      .map((attachment) => attachment.storage_path);
    if (this.options.finalizationCommitsButReturnsError) {
      this.token.status = "used";
      this.token.ticket_id = "ticket-1";
      this.token.customer_submission_id = submissionId;
      return { data: null, error: { message: "response lost" } };
    }
    if (this.options.finalizationFails) {
      return { data: null, error: { message: "finalization failed" } };
    }
    if (this.options.finalizationMalformed) {
      return { data: [], error: null };
    }
    this.token.status = "used";
    this.token.ticket_id = "ticket-1";
    this.token.customer_submission_id = this.options.finalizationReturnsOtherSubmission
      ? "00000000-0000-4000-8000-000000000099"
      : submissionId;
    return {
      data: [{
        ticket_id: "ticket-1",
        submission_id: this.token.customer_submission_id,
        created_ticket: true,
        replayed: false,
      }],
      error: null,
    };
  }

  readonly storage = {
    createBucket: async (): Promise<{ error: null }> => ({ error: null }),
    from: (_bucket: string) => ({
      upload: async (_path: string, _file: File): Promise<{ error: { message: string } | null }> => {
        this.uploadCount += 1;
        if (this.options.uploadFailureAt === this.uploadCount) {
          return { error: { message: "upload failed" } };
        }
        return { error: null };
      },
      remove: async (paths: string[]): Promise<{ error: null }> => {
        this.removedPaths.push(...paths);
        return { error: null };
      },
    }),
  };
}

function file(name: string, type: string): File {
  return new File(["evidence"], name, { type });
}

function oversizedFile(): File {
  const result = file("large.mp4", "video/mp4");
  Object.defineProperty(result, "size", { value: CUSTOMER_FORM_MAX_FILE_SIZE_BYTES + 1 });
  return result;
}

function requestWith(files: File[]): Request {
  const body = new FormData();
  body.set("issue_description", "Product arrived damaged");
  body.set("expected_solution", "Replacement");
  for (const evidence of files) body.append("files", evidence);
  return new Request("https://tickets.example.test/api/forms/submit/plain-token", {
    method: "POST",
    body,
  });
}

async function submit(db: FakeSupabase, files: File[]): Promise<Response> {
  return handleFormSubmit(
    requestWith(files),
    {} as never,
    "plain-token",
    { supabase: db as unknown as SupabaseClient },
  );
}

describe("TicketForm evidence safety", () => {
  it("rejects unsupported and oversized evidence before creating a submission", async () => {
    const unsupported = validateCustomerFormFiles([file("notes.txt", "text/plain")]);
    assert.ok("error" in unsupported);
    const oversized = validateCustomerFormFiles([oversizedFile()]);
    assert.ok("error" in oversized);
    if ("error" in oversized) assert.equal(oversized.status, 413);

    const db = new FakeSupabase();
    const response = await submit(db, [file("notes.txt", "text/plain")]);
    assert.equal(response.status, 422);
    assert.equal(db.submissionCreated, false);
    assert.equal(db.tokenUpdateCount, 0);
    assert.equal(db.token.status, "active");
  });

  it("fails the whole request and preserves the token when any upload fails", async () => {
    const db = new FakeSupabase({ uploadFailureAt: 2 });
    const response = await submit(db, [file("one.jpg", "image/jpeg"), file("two.mp4", "video/mp4")]);

    assert.equal(response.status, 502);
    assert.equal(db.tokenUpdateCount, 0);
    assert.equal(db.token.status, "active");
    assert.equal(db.removedPaths.length, 1);
  });

  it("fails the whole request and preserves the token when database finalization fails", async () => {
    const db = new FakeSupabase({ finalizationFails: true });
    const response = await submit(db, [file("one.jpg", "image/jpeg"), file("two.mp4", "video/mp4")]);

    assert.equal(response.status, 500);
    assert.equal(db.tokenUpdateCount, 0);
    assert.equal(db.token.status, "active");
    assert.equal(db.removedPaths.length, 2);
  });

  it("only reports success after every accepted file has an attachment row", async () => {
    const db = new FakeSupabase();
    const response = await submit(db, [file("one.jpg", "image/jpeg"), file("two.mp4", "video/mp4")]);
    const payload = await response.json() as { attachment_count: number };

    assert.equal(response.status, 200);
    assert.equal(payload.attachment_count, 2);
    assert.equal(db.uploadCount, 2);
    assert.equal(db.finalizationCount, 1);
    assert.equal(db.token.status, "used");
  });

  it("does not delete finalized evidence when the RPC committed but its response was lost", async () => {
    const db = new FakeSupabase({ finalizationCommitsButReturnsError: true });
    const response = await submit(db, [file("one.mp4", "video/mp4")]);

    assert.equal(response.status, 200);
    assert.equal(db.token.status, "used");
    assert.equal(db.removedPaths.length, 0);
  });

  it("rejects a concurrent losing submission and deletes only its staged prefix", async () => {
    const db = new FakeSupabase({ finalizationReturnsOtherSubmission: true });
    const response = await submit(db, [file("loser.mp4", "video/mp4")]);

    assert.equal(response.status, 409);
    assert.equal(db.removedPaths.length, 1);
    assert.match(db.removedPaths[0], /^customer-submissions\//);
  });

  it("preserves staged evidence when an ambiguous outcome cannot be reconciled", async () => {
    const db = new FakeSupabase({ finalizationFails: true, reconciliationFails: true });
    const response = await submit(db, [file("one.mp4", "video/mp4")]);
    const payload = await response.json() as { evidence_preserved: boolean };

    assert.equal(response.status, 503);
    assert.equal(payload.evidence_preserved, true);
    assert.equal(db.removedPaths.length, 0);
  });

  it("cleans staged evidence only after an authoritative active-token reconciliation", async () => {
    const db = new FakeSupabase({ finalizationMalformed: true });
    const response = await submit(db, [file("one.jpg", "image/jpeg")]);

    assert.equal(response.status, 500);
    assert.equal(db.token.status, "active");
    assert.equal(db.removedPaths.length, 1);
  });
});

describe("TicketForm deployment contracts", () => {
  it("routes direct upload preparation and idempotent finalization", async () => {
    const index = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../index.ts", import.meta.url), "utf8"));
    assert.match(index, /api\\\/forms\\\/uploads/);
    assert.match(index, /api\\\/forms\\\/finalize/);
    const handler = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../src/handlers/customer-form.ts", import.meta.url), "utf8"));
    assert.match(handler, /uploadDirectWithRetry/);
    assert.match(handler, /attempt <= 3/);
  });

  it("verifies object metadata, queue backlink, and actionable ticket transition in SQL", async () => {
    const migration = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../../supabase/migrations/20260715000003_ticketform_transactional_finalization.sql", import.meta.url), "utf8"));
    assert.match(migration, /storage\.objects/);
    assert.match(migration, /attachment_size_mismatch/);
    assert.match(migration, /attachment_mime_mismatch/);
    assert.match(migration, /source_inbound_message_id/);
    assert.match(migration, /queue_status = 'linked'/);
    assert.match(migration, /needs_reply = true/);
  });
});
