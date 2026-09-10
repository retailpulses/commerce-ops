// ── Multi-line shipment price allocation ──────────────────────────────
//
// When an order is decomposed into operator-chosen component lines, the anchor
// line carries the marketplace revenue but the component lines carry the goods
// being shipped. This module allocates the anchor's order product price across
// the component lines proportionally to each line's TCOGS (quantity-aware) so
// no component line is emitted with a zero commercial value.
//
// Allocation uses largest-remainder rounding in integer minor units (0.01 JPY)
// so the sum of allocated line totals equals the order product price exactly.
//
// Pure module — no env, network, or database access. Exported for tests.

/**
 * Allocate an order product price across lines proportional to line TCOGS.
 *
 * @param {number|string|null} orderProductPrice - anchor order product price
 * @param {Array<{ qty: number, tcogs: number }>} lines - per-unit TCOGS and qty
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   total?: number,
 *   lines: Array<{ qty: number, tcogsPerUnit: number, weight: number, lineTotal: number, unitPrice: number }>
 * }}
 */
export function allocateLineCommercialValues(orderProductPrice, lines) {
  const price = toNumber(orderProductPrice);
  const safeLines = (Array.isArray(lines) ? lines : []).map((line, index) => ({
    index,
    qty: positiveInt(line && line.qty),
    tcogsPerUnit: toNumber(line && line.tcogs),
  }));

  const missingCost = safeLines.some((l) => !(l.qty > 0) || l.tcogsPerUnit == null || l.tcogsPerUnit <= 0);
  if (safeLines.length === 0 || price == null || price <= 0 || missingCost) {
    return { ok: false, reason: "allocation_cost_data_missing", lines: [], total: 0 };
  }

  const weights = safeLines.map((l) => l.tcogsPerUnit * l.qty);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (!(totalWeight > 0)) {
    return { ok: false, reason: "allocation_zero_weight", lines: [], total: 0 };
  }

  // Work in integer minor units (0.01 JPY) so the total is preserved exactly.
  const MINOR = 100;
  const priceMinor = Math.round(price * MINOR);
  const rawMinor = weights.map((w) => (priceMinor * w) / totalWeight);
  const floors = rawMinor.map((r) => Math.floor(r));
  let remainder = priceMinor - floors.reduce((sum, v) => sum + v, 0);

  // Distribute remaining minor units to the largest fractional parts.
  const byFraction = rawMinor
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const lineTotalMinor = floors.slice();
  for (let k = 0; k < remainder && k < byFraction.length; k += 1) {
    lineTotalMinor[byFraction[k].i] += 1;
  }

  // The outbound contract carries a per-unit value with two decimals. Make
  // every line total divisible by its quantity, moving the few residual minor
  // units to a quantity-1 line so unitPrice * qty still reconciles exactly.
  const unitLine = safeLines.findIndex((line) => line.qty === 1);
  for (let i = 0; i < lineTotalMinor.length; i += 1) {
    if (safeLines[i].qty === 1) continue;
    const residual = lineTotalMinor[i] % safeLines[i].qty;
    if (residual && unitLine >= 0) {
      lineTotalMinor[i] -= residual;
      lineTotalMinor[unitLine] += residual;
    }
  }
  if (lineTotalMinor.some((minor, i) => minor % safeLines[i].qty !== 0)) {
    return { ok: false, reason: "allocation_unit_precision_unrepresentable", lines: [], total: 0 };
  }

  const linesOut = safeLines.map((l, i) => {
    const lineTotal = lineTotalMinor[i] / MINOR;
    return {
      qty: l.qty,
      tcogsPerUnit: l.tcogsPerUnit,
      weight: weights[i],
      lineTotal,
      unitPrice: round2(lineTotal / l.qty),
    };
  });

  return {
    ok: true,
    total: lineTotalMinor.reduce((sum, v) => sum + v, 0) / MINOR,
    lines: linesOut,
  };
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
