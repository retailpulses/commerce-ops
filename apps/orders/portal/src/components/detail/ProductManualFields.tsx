import { useState } from "react";
import { useProductManualFieldsMutation } from "@/hooks/useOrders";
import type { OrderDetail } from "@/types/orders";

/**
 * Inline-edit component for product manual fields (cost price, restock date,
 * protection until). Appears in the order detail drawer when the order has a
 * linked product (B2B item code).
 *
 * Writes through the RPagentOS product-catalog owner API via the Portal API.
 * Effective values (effective_cost_price, restock_date) are computed by
 * CatalogSync on its next run — the UI shows the "effective" value alongside
 * the manual override so operators see both.
 */
export function ProductManualFields({ order, onRefetch }: { order: OrderDetail; onRefetch: () => void }) {
  const itemCode = order.B2BItemCode;
  const product = order.product;
  const hasProduct = !!(itemCode && product && product.manual_fields_available);

  // Hooks must be called unconditionally (React Rules of Hooks)
  const [editing, setEditing] = useState(false);
  const [cost, setCost] = useState(
    product?.manual_cost_price != null ? String(product.manual_cost_price) : ""
  );
  const [arrivalDate, setArrivalDate] = useState(product?.manual_presale_arrival_date || "");
  const [protectUntil, setProtectUntil] = useState(product?.presale_info_protect_until || "");
  const [error, setError] = useState("");

  const mutation = useProductManualFieldsMutation();

  // Only show when there's a linked product
  if (!hasProduct) return null;

  const startEdit = () => {
    setCost(product!.manual_cost_price != null ? String(product!.manual_cost_price) : "");
    setArrivalDate(product!.manual_presale_arrival_date || "");
    setProtectUntil(product!.presale_info_protect_until || "");
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setError("");
    try {
      // Build payload: only include explicitly-set fields (partial PATCH).
      // Empty → send as null to clear the override. Zero is rejected server-side.
      const trimmedCost = cost.trim();
      const costNum = trimmedCost ? Number(trimmedCost) : null;
      const payload = {
        manual_cost_price: (costNum != null && Number.isFinite(costNum)) ? costNum : null,
        manual_presale_arrival_date: arrivalDate || null,
        presale_info_protect_until: protectUntil || null,
      };

      await mutation.mutateAsync({ itemCode, ...payload });
      setEditing(false);
      onRefetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    }
  };

  const effectiveTcogs = product.effective_tcogs;
  const fmtYen = (n: number | null) =>
    n != null ? `¥${n.toLocaleString()}` : "—";

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">
        Product Manual Fields
      </h3>

      {editing ? (
        <div className="mt-2">
          {/* Manual Cost Price */}
          <div className="flex items-center py-1">
            <span className="w-[140px] text-xs text-gray-500 flex-shrink-0">Manual Cost Price</span>
            <div className="flex items-center gap-1 flex-1">
              <span className="text-xs text-gray-400">¥</span>
              <input
                type="number"
                min="1"
                step="1"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="Override cost price"
                className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
              />
            </div>
          </div>

          {/* Manual Restock Date */}
          <div className="flex items-center py-1">
            <span className="w-[140px] text-xs text-gray-500 flex-shrink-0">Manual Restock Date</span>
            <input
              type="date"
              value={arrivalDate}
              onChange={(e) => setArrivalDate(e.target.value)}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
            />
          </div>

          {/* Protection Until */}
          <div className="flex items-center py-1">
            <span className="w-[140px] text-xs text-gray-500 flex-shrink-0">Protection Until</span>
            <input
              type="date"
              value={protectUntil}
              onChange={(e) => setProtectUntil(e.target.value)}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
            />
          </div>

          {/* Info: protection only active when date is in the future */}
          {protectUntil && (
            <div className="text-[11px] text-gray-400 mt-1 ml-[140px]">
              Protection active only while date is in the future (assessed JST by CatalogSync)
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 justify-end mt-2">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1 bg-white border border-gray-300 rounded text-xs text-gray-500"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={mutation.isPending}
              className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs"
            >
              {mutation.isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {error && (
            <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div>
          {/* Read-only display */}
          <Field label="Manual Cost" value={product.manual_cost_price != null ? fmtYen(product.manual_cost_price) : "—"} />
          <Field label="Effective TCOGS" value={fmtYen(effectiveTcogs)} />
          <Field label="Manual Restock Date" value={product.manual_presale_arrival_date || "—"} />
          <Field label="Protection Until" value={product.presale_info_protect_until || "—"} />

          {/* Effective value note */}
          {product.manual_cost_price != null && (
            <div className="text-[11px] text-gray-400 mt-1">
              {effectiveTcogs != null && effectiveTcogs !== product.manual_cost_price
                ? "Effective TCOGS pending next CatalogSync run (showing last computed value)."
                : ""}
            </div>
          )}
          {product.manual_presale_arrival_date && (
            <div className="text-[11px] text-gray-400 mt-1">
              Restock date effective after next CatalogSync run. Protection cleared when stock returns.
            </div>
          )}

          <div className="flex justify-end mt-2">
            <button
              onClick={startEdit}
              className="bg-white border border-gray-300 px-2 py-0.5 rounded text-xs text-[#1565c0] hover:bg-gray-100"
            >
              Edit Product Manual Fields
            </button>
          </div>
        </div>
      )}
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
