import { useState } from "react";
import { useB2bCodeMutation, useQuantityMutation } from "@/hooks/useOrders";
import type { OrderDetail } from "@/types/orders";
import { shopLabel, formatJstDisplay } from "@/lib/constants";

export function OrderInfo({ order, onRefetch, showLineEditors = true }: { order: OrderDetail; onRefetch: () => void; showLineEditors?: boolean }) {
  const [editingB2b, setEditingB2b] = useState(false);
  const [editingQty, setEditingQty] = useState(false);
  const [b2bValue, setB2bValue] = useState(order.B2BItemCode || "");
  const [qtyValue, setQtyValue] = useState(String(order.quantity || 1));
  const [b2bError, setB2bError] = useState("");
  const [qtyError, setQtyError] = useState("");

  const b2bMutation = useB2bCodeMutation();
  const qtyMutation = useQuantityMutation();

  const saveB2b = async () => {
    setB2bError("");
    try {
      await b2bMutation.mutateAsync({ orderId: order.portal_target_id || order.order_id, b2b_item_code: b2bValue });
      setEditingB2b(false);
      onRefetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setB2bError(msg);
    }
  };

  const saveQty = async () => {
    const n = parseInt(qtyValue, 10);
    if (isNaN(n) || n < 1) return;
    setQtyError("");
    try {
      await qtyMutation.mutateAsync({ orderId: order.portal_target_id || order.order_id, quantity: n });
      setEditingQty(false);
      onRefetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setQtyError(msg);
    }
  };

  const orderUrl = `https://mercari-shops.com/seller/shops/${encodeURIComponent(order.shop_id || "")}/orders/${encodeURIComponent(order.order_id || "")}`;

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">Order Info</h3>
      <Field label="Order ID" value={<code className="text-xs">{order.order_id || "—"}</code>} />
      <Field label="Status" value={order.order_status || "—"} />
      <Field label="Review" value={order.review_status || "—"} />
      <Field label="Pipeline State" value={order.pipeline_state || "—"} />
      <Field label="Shop" value={shopLabel(order.shop_id)} />
      <Field label="Purchase Date" value={formatJstDisplay(order.purchase_date) || "—"} />
      <Field label="Buyer" value={order.buyer_name || "—"} />
      <Field label="Payment Method" value={order.payment_method || "—"} />
      <Field label="SKU" value={order.platform_sku || "—"} />
      {showLineEditors && <Field
        label="B2B Code"
        value={
          editingB2b ? (
            <>
            <span className="inline-flex gap-1 items-center">
              <input
                type="text"
                value={b2bValue}
                onChange={(e) => setB2bValue(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-xs w-[180px] focus:outline-none focus:border-[#1565c0]"
                autoFocus
              />
              <button onClick={saveB2b} disabled={b2bMutation.isPending} className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs">
                Save
              </button>
            </span>
            {b2bError && <div className="mt-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-0.5">{b2bError}</div>}
            </>
          ) : (
            <span className="inline-flex gap-1 items-center">
              {order.B2BItemCode || "—"}
              <button onClick={() => { setB2bValue(order.B2BItemCode || ""); setEditingB2b(true); }} className="bg-white border border-gray-300 px-2 py-0.5 rounded text-xs text-[#1565c0] hover:bg-gray-100">
                Edit
              </button>
            </span>
          )
        }
      />}
      {showLineEditors && <Field
        label="Qty"
        value={
          editingQty ? (
            <>
            <span className="inline-flex gap-1 items-center">
              <input
                type="number"
                value={qtyValue}
                onChange={(e) => setQtyValue(e.target.value)}
                min="1"
                className="px-2 py-1 border border-gray-300 rounded text-xs w-[70px] focus:outline-none focus:border-[#1565c0]"
                autoFocus
              />
              <button onClick={saveQty} disabled={qtyMutation.isPending} className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs">
                Save
              </button>
            </span>
            {qtyError && <div className="mt-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-0.5">{qtyError}</div>}
            </>
          ) : (
            <span className="inline-flex gap-1 items-center">
              {order.quantity || 0}
              <button onClick={() => { setQtyValue(String(order.quantity || 1)); setEditingQty(true); }} className="bg-white border border-gray-300 px-2 py-0.5 rounded text-xs text-[#1565c0] hover:bg-gray-100">
                Edit
              </button>
            </span>
          )
        }
      />}
      <Field
        label="Mercari"
        value={
          <a href={orderUrl} target="_blank" rel="noopener noreferrer" className="text-[#1565c0] text-xs no-underline hover:underline inline-flex items-center gap-1">
            View in Mercari ↗
          </a>
        }
      />
      {order.shipment_sync_status && (
        <Field label="Giga Sync" value={<span className="text-[11px] font-semibold bg-gray-100 px-1.5 py-px rounded-full">{order.shipment_sync_status}</span>} />
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-1 text-sm border-b border-dotted border-gray-200">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
