export const manualFields = [
  { key: 'manual_cost_price', label: 'Manual Cost Price (JPY)', type: 'number' },
  { key: 'manual_presale_arrival_date', label: 'Manual Restock Date', type: 'date' },
  { key: 'presale_info_protect_until', label: 'Protection Until', type: 'date' }
];
export const tools = [
  {
    name: 'Product update tool',
    href: '/tools/product-update',
    description: 'Find a product by Item Code and update its manual business values.'
  }
];
export function formFor(product) {
  return Object.fromEntries(
    manualFields.map(({ key }) => [key, product[key] == null ? '' : String(product[key])])
  );
}
export function dirtyPatch(product, form) {
  const baseline = formFor(product);
  const patch = {};
  for (const { key } of manualFields) {
    const value = form[key].trim();
    if (value === baseline[key]) continue;
    if (value === '') {
      patch[key] = null;
      continue;
    }
    if (key === 'manual_cost_price') {
      const cost = Number(value);
      if (!Number.isFinite(cost) || cost <= 0 || cost > 99999999)
        throw new Error(
          'Cost must be greater than 0 and at most 99,999,999. Use Clear to remove an override.'
        );
      patch[key] = cost;
    } else {
      const date = new Date(`${value}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        throw new Error('Enter a valid calendar date.');
      patch[key] = value;
    }
  }
  return patch;
}
export function effectiveRestockDateText(product) {
  if (!Object.hasOwn(product, 'effective_restock_date')) return 'Unavailable';
  const value = product.effective_restock_date;
  if (value === null) return 'None';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Unavailable';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : 'Unavailable';
}
export const errorText = {
  sku_not_found: 'Product not found. Check the complete Item Code.',
  commercial_state_missing:
    'Product exists but its commercial data is missing. Ask the catalog owner to repair it.',
  duplicate_item_code: 'Duplicate Item Code. The catalog owner must resolve the conflict.',
  duplicate_commercial_state:
    'Duplicate commercial data. The catalog owner must resolve the conflict.',
  catalog_service_unavailable:
    'Product service is temporarily unavailable. Please try again later.',
  access_service_unavailable:
    'Access verification is temporarily unavailable. Please try again later.',
  access_session_required:
    'Your Cloudflare Access session has expired. Reload to sign in through the existing Access login.',
  product_permission_denied: 'Your Access identity does not have product tool permission.',
  product_writes_disabled: 'Product updates are currently disabled.',
  save_result_unknown:
    'Save result is uncertain. Check current values before making another change.',
  invalid_manual_fields:
    'Check the cost and dates. Cost must be greater than zero; clear a field to remove its override.'
};
export async function productRequest(itemCode, patch, fetchFn = fetch) {
  const response = await fetchFn(
    `/api/tools/products/${encodeURIComponent(itemCode)}/manual-fields`,
    {
      method: patch ? 'PATCH' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      ...(patch ? { body: JSON.stringify(patch) } : {})
    }
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      'Session or service unavailable. Reload to check your existing Cloudflare Access session.'
    );
  }
  if (!response.ok || !data.ok) {
    const error = new Error(
      `${errorText[data.error] || 'Request failed.'}${data.request_id ? ` Reference: ${data.request_id}` : ''}`
    );
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data.product;
}
