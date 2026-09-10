# Inquiry Migration Exception Report Format

**Workstream**: G — Migration & Reconciliation Tooling
**Phase**: 1 (Baserow-to-Supabase cut-over)
**Format**: Machine-readable JSON, handable by operator
**File location**: `{data-dir}/reconciliation_report.json`

---

## 1. Purpose

The exception report captures all rows and fields that could not be cleanly
migrated during the Baserow-to-Supabase one-time migration.  It is the primary
hand-off artifact from the migration tooling to the operator for manual review
and remediation.

No suspect row is silently dropped — every ambiguity is surfaced in this report.

---

## 2. Report Structure

```jsonc
{
  "generated_at": "2026-07-21T12:00:00+09:00",
  "summary": {
    "row_count_match": true,
    "field_value_match": false,
    "status_distribution_match": true,
    "product_link_count_match": true,
    "knowledge_link_count_match": true,
    "errors": 2,
    "warnings": 3,
    "overall_match": false
  },
  // ---- Section 1: Count discrepancies ----
  "counts": {
    "baserow_inquiry_rows": 1542,
    "supabase_inquiry_rows": 1541,
    "difference": 1,
    "match": false
  },

  // ---- Section 2: Field hash comparison ----
  "field_hashes": {
    "fields_checked": [],
    "total_matched_rows": 1500,
    "total_mismatched_rows": 5,
    "per_field": {
      "status": { "matched": 1500, "mismatched": 5, "sample_discrepancies": [...] },
      "customer_nickname": { "matched": 1503, "mismatched": 2, "sample_discrepancies": [...] }
    },
    "field_discrepancies": [
      {
        "field": "customer_nickname",
        "count": 2,
        "sample": [
          {
            "baserow_row_id": 12345,
            "baserow_value": "John Smith",
            "supabase_value": "John Smith "
          }
        ]
      }
    ]
  },

  // ---- Section 3: Status distributions ----
  "status_distribution": {
    "baserow_field": "Status",
    "supabase_column": "status",
    "baserow_distribution": {
      "Received": 800,
      "Answered": 400,
      "Closed Won": 200,
      "Closed Lose": 100,
      "Followed-up": 42
    },
    "supabase_distribution": {
      "received": 799,
      "answered": 400,
      "closed_won": 200,
      "closed_lose": 100,
      "followed_up": 42
    },
    "difference_count": 1
  },

  // ---- Section 4: Link counts ----
  "links": {
    "product_links": {
      "baserow_count": 287,
      "supabase_count": 287,
      "difference": 0
    },
    "knowledge_links": {
      "baserow_count": 94,
      "supabase_count": 94,
      "difference": 0
    }
  },

  // ---- Section 5: Null / empty field anomalies ----
  "null_fields": {
    "inquiry_body": {
      "baserow_nulls": 12,
      "baserow_total": 1542,
      "baserow_null_pct": 0.8,
      "supabase_nulls": 15,
      "supabase_total": 1541,
      "supabase_null_pct": 1.0
    },
    "product_name_snapshot": {
      "baserow_nulls": 312,
      "baserow_total": 1542,
      "baserow_null_pct": 20.2,
      "supabase_nulls": 320,
      "supabase_total": 1541,
      "supabase_null_pct": 20.8
    }
  },

  // ---- Section 6: Import field exceptions (from migrate_import.py) ----
  "import_exceptions": [
    {
      "baserow_row_id": 42,
      "field": "Account",
      "issue": "Unmapped Account label 'Store 5' — stored as shop_key='store_5'. Update SHOP_KEY_MAP.",
      "severity": "warning",
      "action": "Update shop mapping config, then re-run with --canary 42"
    },
    {
      "baserow_row_id": 99,
      "field": "AI Reply Copywrited",
      "issue": "Ambiguous value '2024/03/15' — mapped to ai_copywritten_at. Review manually.",
      "severity": "warning",
      "action": "Inspect row 99 in Baserow to confirm intent"
    }
  ],

  // ---- Section 7: Consolidation report (from migrate_consolidate.py) ----
  "consolidation": {
    "legacy_total": 845,
    "baserow_total": 1542,
    "matched_on_external_id": 600,
    "matched_on_shop_customer": 100,
    "legacy_only": 145,
    "baserow_only": 697,
    "merge_plan": [
      {
        "baserow_row_id": 123,
        "legacy_mercari_inquiries_id": 456,
        "external_inquiry_id": "abc123",
        "match_type": "external_id",
        "shop_key": "shop1",
        "customer": "John Smith"
      }
    ],
    "sample_legacy_only": [
      {
        "legacy_id": 789,
        "external_inquiry_id": null,
        "customer": "Jane Doe",
        "shop_key": "shop2",
        "inquiry_date": "2026-06-15T10:00:00Z"
      }
    ]
  },

  // ---- Section 8: Errors and warnings ----
  "errors": [
    "Row count mismatch: Baserow=1542 Supabase=1541"
  ],
  "warnings": [
    "Unresolved Account mapping for 3 rows",
    "Field value mismatches in 5 rows across 2 fields"
  ]
}
```

---

## 3. Exception Categories

| Category | Severity | Description | Action |
|----------|----------|-------------|--------|
| Count mismatch | error | Baserow row count != Supabase row count | Investigate missing/duplicate rows |
| Field hash mismatch | warning | Same row has different field values | Inspect sample; may be whitespace/encoding |
| Unmapped status | warning | Baserow label not in STATUS_LABEL_MAP | Add mapping, re-process affected rows |
| Unmapped shop key | warning | Account label not in SHOP_KEY_MAP | Add mapping, re-process affected rows |
| Ambiguous AI Copywrited | warning | Cannot determine if value is timestamp or reply | Manual inspection required |
| Link count mismatch | warning | Product/knowledge link counts differ | Check for missing or extra links |
| Null field anomaly | info | High null rate in a normally-populated field | Flags potential extraction gaps |
| legacy-only rows | info | Rows in mercari_inquiries with no Baserow match | Decide whether to import as orphan records |

---

## 4. Severity Rules

- **error** — Blocks cut-over. Must be resolved before declaring migration complete.
- **warning** — Does not block cut-over, but must be reviewed and acknowledged by operator.
- **info** — Informational. No action required unless operator sees a pattern.

---

## 5. Operator Remediation Workflow

For warnings requiring action:

1. **Review the exception report** — open `reconciliation_report.json`
2. **For mapping issues** — update the relevant map in `scripts/_migrate_shared.py`
3. **Re-run targeted import** — `--canary <affected_row_ids> --confirm`
4. **Re-reconcile** — `migrate_reconcile.py` to confirm the fix
5. **No unresolved exceptions remain** → migration is clean and can proceed to cut-over

For errors (count mismatch):

1. Check if the discrepancy is within the expected range (e.g., rows added during migration window)
2. Re-run full extraction and import to pick up late-arriving rows
3. If mismatch persists, inspect the specific Baserow row IDs that differ

---

## 6. File Location

After a full migration run, operators will find:

```
{data-dir}/
  reconciliation_report.json       # Full reconciliation report
  consolidation_report.json        # mercari_inquiries merge analysis
  inquiries.ndjson                 # Raw Baserow extraction (for replay)
  knowledge.ndjson                 # Knowledge articles
  product_tickets.ndjson           # Product/Ticket rows
  product_links.ndjson             # Product link records
  knowledge_links.ndjson           # Knowledge link records
```
