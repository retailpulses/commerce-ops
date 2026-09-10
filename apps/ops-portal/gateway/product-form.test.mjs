import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formFor,
  dirtyPatch,
  effectiveRestockDateText,
  productRequest
} from '../src/lib/tools/products.js';
const product = {
  manual_cost_price: 100,
  manual_presale_arrival_date: '2026-09-09',
  presale_info_protect_until: null
};
test('one changed field preserves other values and explicit clear uses null', () => {
  assert.deepEqual(dirtyPatch(product, { ...formFor(product), manual_cost_price: '120' }), {
    manual_cost_price: 120
  });
  assert.deepEqual(dirtyPatch(product, { ...formFor(product), manual_presale_arrival_date: '' }), {
    manual_presale_arrival_date: null
  });
  assert.throws(() => dirtyPatch(product, { ...formFor(product), manual_cost_price: 'abc' }));
});
test('API error preserves rejection metadata so UI can retain unsaved form', async () => {
  await assert.rejects(
    () =>
      productRequest('A', { manual_cost_price: 0 }, async () =>
        Response.json({ ok: false, error: 'invalid_manual_fields' }, { status: 400 })
      ),
    (error) => error.status === 400 && error.code === 'invalid_manual_fields'
  );
});
test('effective restock date distinguishes an explicit empty date from unavailable data', () => {
  assert.equal(effectiveRestockDateText({ effective_restock_date: '2026-09-30' }), '2026-09-30');
  assert.equal(effectiveRestockDateText({ effective_restock_date: null }), 'None');
  assert.equal(effectiveRestockDateText({}), 'Unavailable');
  assert.equal(effectiveRestockDateText({ effective_restock_date: '2026-02-30' }), 'Unavailable');
  assert.equal(effectiveRestockDateText({ effective_restock_date: 20260930 }), 'Unavailable');
});
