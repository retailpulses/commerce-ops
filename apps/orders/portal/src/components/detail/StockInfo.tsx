import type { OrderDetail } from "@/types/orders";

export function StockInfo({ order }: { order: OrderDetail }) {
  const s = order.stock || {};
  const owned = s.ownedQty != null ? s.ownedQty : "?";
  const avail = s.qtyAvailable != null ? s.qtyAvailable : "?";
  const seller = order.product?.seller;

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">Stock</h3>
      <Field label="Owned Qty" value={String(owned)} />
      <Field label="Qty Available" value={String(avail)} />
      <Field label="Status" value={s.label || "—"} />
      {seller && <Field label="Seller" value={seller} />}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 text-sm border-b border-dotted border-gray-200">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
