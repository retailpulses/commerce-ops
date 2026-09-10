import type { OrderContext } from "@/api/types";

export function OrderContextCard({ order, isLoading, unavailable }: { order?: OrderContext; isLoading: boolean; unavailable: boolean }) {
  if (isLoading) return <div className="px-4 py-2 text-xs text-text-muted border-b border-border">Loading order information…</div>;
  if (unavailable || !order) return <div className="px-4 py-2 text-xs text-text-muted border-b border-border">Order information is currently unavailable.</div>;
  const address = [order.shipping_postal_code, order.shipping_state, order.shipping_city, order.shipping_address_1, order.shipping_address_2].filter(Boolean).join(" ");
  return (
    <section className="border-b border-border bg-surface px-4 py-3" aria-label="Order information">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold">Order Information</h3>
        <a href={`/order/?q=${encodeURIComponent(order.order_id)}`} className="text-xs text-accent hover:underline">Open in Order Portal</a>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-xs">
        <Field label="Status" value={order.order_status} />
        <Field label="Payment" value={order.payment_method} />
        <Field label="Buyer" value={order.buyer_name || order.shipping_name} />
        <Field label="Purchased" value={order.purchase_date_jst} />
        <Field label="Shipping" value={[order.shipping_method, order.shipping_carrier].filter(Boolean).join(" / ")} />
        <Field label="Tracking" value={order.tracking_number} />
        <div className="col-span-2"><Field label="Address" value={address} /></div>
      </div>
      <div className="mt-3 space-y-1">
        {order.lines.map((line, index) => (
          <div key={`${line.platform_sku}-${index}`} className="flex flex-wrap gap-x-3 text-xs">
            <span className="font-medium">{line.product_name || "Product"}</span>
            <span className="font-mono text-text-muted">{line.b2b_item_code || line.platform_sku}</span>
            <span>× {line.quantity}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return <div><span className="text-text-muted">{label}: </span><span className="text-text">{value || "—"}</span></div>;
}
