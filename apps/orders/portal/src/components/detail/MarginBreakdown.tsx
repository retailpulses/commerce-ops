import type { OrderDetail } from "@/types/orders";
import { fmtYen, fmtPct } from "@/lib/constants";

export function MarginBreakdown({ order }: { order: OrderDetail }) {
  const m = order.margin || {};
  const revenue = m.revenue;
  const shipping = m.shipping || 0;
  const commission = m.commission;
  const tcogs = m.tcogs;
  const profit = m.profit;
  const marginPct = m.marginPercent;
  const priceMatchLines = order.cogs_price_match_lines || [];

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">Revenue Breakdown</h3>

      {priceMatchLines.length > 0 && (
        <div className="mb-3 rounded-md border-2 border-[#f97316] bg-[#fff7ed] px-3 py-3 text-[#9a3412] shadow-sm" role="alert">
          <div className="font-bold">⚠ Supplier price needs confirmation</div>
          <div className="mt-1 text-sm">
            TCOGS equals Unit Price. Confirm or negotiate the supplier price before purchasing.
          </div>
          {priceMatchLines.map((line) => (
            <div key={line.id} className="mt-1 text-xs font-semibold">
              {line.platform_sku || `Line ${line.id}`}: Giga Unit Price {fmtYen(line.source_unit_price)} / Effective COGS {fmtYen(line.effective_cogs)}
            </div>
          ))}
        </div>
      )}

      <MarginRow label="Product Price" value={fmtYen(order.product_price)} extra={`× ${order.quantity || 0} = ${fmtYen(revenue)}`} />
      <MarginRow label="Shipping" value={fmtYen(m.shipping)} />
      {revenue != null && (
        <MarginRow label="Revenue + Shipping" value={fmtYen(revenue + shipping)} />
      )}
      <MarginRow label={`Platform Fee (${fmtPct(0.10)})`} value={commission != null ? `-${fmtYen(commission)}` : "—"} />
      <MarginRow
        label={`Est. COGS (×${order.quantity || 0})`}
        value={tcogs != null ? `-${fmtYen(tcogs)}` : <span className="text-gray-400">N/A</span>}
      />

      <div className="flex justify-between py-1 mt-1.5 pt-1.5 border-t-2 border-gray-200 font-bold text-[15px]">
        <span>Est. Margin</span>
        {profit != null ? (
          <span className={profit >= 0 ? "text-[#2e7d32]" : "text-[#c62828]"}>
            {fmtYen(profit)} ({fmtPct(marginPct)})
          </span>
        ) : (
          <span className="text-gray-400">N/A</span>
        )}
      </div>

      <div className="flex justify-between text-[11px] text-gray-400 mt-1">
        <span>TCOGS source: {m.tcogsSource || "—"}</span>
      </div>
    </section>
  );
}

function MarginRow({ label, value, extra }: { label: string; value: React.ReactNode; extra?: string }) {
  return (
    <div className="flex justify-between py-0.5 text-sm">
      <span>{label}</span>
      <span>
        {value}
        {extra && <span className="text-gray-400 text-xs ml-1">{extra}</span>}
      </span>
    </div>
  );
}
