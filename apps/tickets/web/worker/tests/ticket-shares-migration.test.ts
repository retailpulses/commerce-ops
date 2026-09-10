import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../../../supabase/migrations/20260716010000_ticket_shares.sql", import.meta.url);

test("ticket share migration is worker-only, transactional, and fixed at seven days", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /-- Domain: ticketing/);
  assert.match(sql, /-- Change class: additive/);
  assert.match(sql, /CREATE TABLE public\.ticket_share_tokens/);
  assert.match(sql, /CREATE TABLE public\.ticket_share_attachments/);
  assert.match(sql, /WHERE status = 'active'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /now\(\) \+ interval '7 days'/);
  assert.equal((sql.match(/SET statement_timeout = '5s'/g) ?? []).length, 4);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /REVOKE ALL ON TABLE public\.ticket_share_tokens FROM anon, authenticated/);
  assert.doesNotMatch(sql, /CREATE POLICY/i);
});

test("ticket share database commands validate ticket-scoped evidence and fail closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /attachment does not belong to ticket/);
  assert.match(sql, /attachments\.ticket_id = tokens\.ticket_id/);
  assert.match(sql, /tokens\.expires_at > now\(\)/);
  assert.match(sql, /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.resolve_ticket_share\(text\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.resolve_ticket_share\(text\) TO service_role/);
});
