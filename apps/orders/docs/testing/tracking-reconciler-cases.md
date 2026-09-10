# Tracking Reconciliation — Integration Test Cases

## Prerequisites

```bash
# Set up env (baserow token, giga creds, etc.)
source /Users/user/Documents/April\ 2026/.env 2>/dev/null || true
export MERCARI_BASEROW_ENV_PATH="/Users/user/Documents/April 2026/.env"
```

## Test Suite

### TC-01: Smoke — Single shop, small limit

**Command:**
```bash
node src/index.mjs --mode pull_giga_tracking --shops Shop1 --limit 5
```

**Checks:**
- Exit code 0
- `result.ok === true`
- `shipment_rows_loaded` < 1078 (server-side filter active)
- `candidate_orders` ≤ `shipment_rows_loaded`
- No `patch_errors` entries
- Each result has `carrier`, `tracking_numbers`, `updated_shipments`

---

### TC-02: Multi-shop scope

**Command:**
```bash
node src/index.mjs --mode pull_giga_tracking --shops Shop1,Shop2 --limit 10
```

**Checks:**
- Exit code 0
- Only Shop1 + Shop2 shipment rows processed
- `selectedShopIds` does not include Shop3/Shop4

---

### TC-03: Dry-run pipeline (no mutations)

**Command:**
```bash
node src/index.mjs --mode reconcile_end_to_end --shops Shop1 --limit 3
```

**Checks:**
- Full pipeline runs (ingest → project → push → tracking → close)
- `reconcile_end_to_end` step has `ok: true`
- No crash in any phase

---

### TC-04: Server-side filter validation

**Command:**
```bash
node -e "
import { createBaserowClient, listAllRows, BASEROW_FIELD, BASEROW_OPTION } from './src/lib/baserow.mjs';
import { readFileSync } from 'fs';
// Load env
const lines = readFileSync('/Users/user/Documents/April 2026/.env', 'utf8').split('\n');
for (const line of lines) {
  const [k, ...rest] = line.split('=');
  if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
}
const baserow = createBaserowClient(process.env);

// Without filter — full scan
const allRows = await listAllRows(baserow, baserow.shipmentOrderTableId, {
  filter__field_7824251__equal: 'Mercari',
});
console.log('All Mercari shipments:', allRows.length);

// With server-side filters (Phase 2)
const filteredRows = await listAllRows(baserow, baserow.shipmentOrderTableId, {
  filter__field_7824251__equal: 'Mercari',
  filter__field_7909235__empty: '',
  filter__field_7907696__single_select_not_equal: '5785874',
});
console.log('Filtered (pending tracking):', filteredRows.length);

const reduction = allRows.length > 0 ? Math.round((1 - filteredRows.length / allRows.length) * 100) : 0;
console.log('Reduction:', reduction + '%');
process.exit(filteredRows.length <= allRows.length ? 0 : 1);
"
```

**Checks:**
- Filtered count ≤ full count
- Reduction > 70% (most shipments already have tracking)

---

### TC-05: Tracking data loss detection

**Command:**
Run TC-01 or TC-02 and grep logs:
```bash
node src/index.mjs --mode pull_giga_tracking --shops Shop1 --limit 10 2>&1 | grep "tracking_data_loss_detected"
```

**Checks:**
- If output: each entry has `original_count`, `formatted_count`, `orderNo`, `shipTrackInfo`
- No silent truncation

---

### TC-06: Invalid shipments skipped

**Command:**
```bash
node src/index.mjs --mode pull_giga_tracking --shops Shop1 --limit 10
```

**Checks:**
- No patch attempt on rows with `giga_sync_status === "Invalid"`
- `candidate_orders` count excludes Invalid rows

---

### TC-07: Multi-package tracking format

**Scenario:** An order with multiple packages (e.g., 2+ tracking numbers from Giga)

**Verification in Baserow:**
- `giga_tracking_no` field: carriers joined with ` / `
- `giga_carrier_name` field: tracking numbers joined with ` / `
- `shipping_completed_at` is set to JST ISO timestamp

---

### TC-08: No-tracking order in batch

**Scenario:** Giga returns empty `shipTrackInfo` for an order in the batch

**Verification in CLI output:**
- Result entry shows `updated_shipments: 0`, `updated_sales_rows: 0`
- No error thrown

---

### TC-09: channel-config module integrity

**Command:**
```bash
node -e "
import { MERCARI_CHANNEL } from './src/lib/channel-config.mjs';
const c = MERCARI_CHANNEL;
const checks = [
  c.salesChannel === 'Mercari',
  Object.keys(c.shopIds).length === 4,
  c.shopIds.Shop1 === 'WMyisFmhbGWyVAPEwsfirn',
  c.salesOrderIdField === 'order_id',
  c.salesStatusFilters.length === 2,
  c.patchSales === true,
  Object.isFrozen(c),
];
console.log(checks.every(Boolean) ? 'PASS' : 'FAIL', JSON.stringify(checks));
process.exit(checks.every(Boolean) ? 0 : 1);
"
```

**Checks:**
- All assertions true
- Object is frozen (immutable)

---

### TC-10: Worker syntax + import check

**Command:**
```bash
node --check worker/index.js && node --check src/index.mjs && node --check scripts/backfill_shop_orders.mjs
```

**Checks:**
- All three entrypoints parse without error
- All imports resolve (no runtime check, just syntax)

---

## Execution Order

1. **TC-10** (fast, no network) → validate all files syntax-OK
2. **TC-09** (fast, no network) → channel config integrity
3. **TC-04** (network) → server-side filter effectiveness
4. **TC-01** (network) → smoke test
5. **TC-06** (network, same run as TC-01) → Invalid skip
6. **TC-02** (network) → multi-shop
7. **TC-05** (same run as TC-02, check logs) → data loss detection
8. **TC-08** (observed in any run) → no-tracking handling
9. **TC-03** (network, pipeline) → end-to-end

## Success Criteria

| # | Criterion |
|---|-----------|
| All 40 unit tests pass | ✓ |
| TC-01 exit 0, valid summary | |
| TC-02 exit 0, correct shop scope | |
| TC-03 full pipeline OK | |
| TC-04 reduction > 70% | |
| TC-09 channel config frozen + correct | |
| TC-10 all files parse | |
| No `tracking_data_loss_detected` in TC-05 | |
| No regressions vs pre-refactor behavior | |
