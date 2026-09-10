import { useState } from "react";
import { useAddOrderLineMutation, useB2bCodeMutation, useQuantityMutation } from "@/hooks/useOrders";
import type { OrderLine } from "@/types/orders";

export function OrderLines({ orderId, lines, onRefetch, canAdd = false }: { orderId: string; lines: OrderLine[]; onRefetch: () => void; canAdd?: boolean }) {
  const mutation = useB2bCodeMutation();
  const quantityMutation = useQuantityMutation();
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [quantityEditingId, setQuantityEditingId] = useState<string | number | null>(null);
  const [value, setValue] = useState("");
  const [quantityValue, setQuantityValue] = useState("");
  const [error, setError] = useState("");
  const addMutation = useAddOrderLineMutation();
  const [showAdd, setShowAdd] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newQuantity, setNewQuantity] = useState("1");

  const addLine = async () => {
    const quantity = Number.parseInt(newQuantity, 10);
    if (!newCode.trim() || !Number.isInteger(quantity) || quantity < 1) return;
    setError("");
    try {
      await addMutation.mutateAsync({ orderId, b2b_item_code: newCode.trim(), quantity });
      setNewCode("");
      setNewQuantity("1");
      setShowAdd(false);
      onRefetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  const save = async (line: OrderLine) => {
    setError("");
    try {
      await mutation.mutateAsync({ orderId, row_id: line.id, b2b_item_code: value });
      setEditingId(null);
      onRefetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  const saveQuantity = async (line: OrderLine) => {
    const quantity = Number.parseInt(quantityValue, 10);
    if (!Number.isInteger(quantity) || quantity < 1) return;
    setError("");
    try {
      await quantityMutation.mutateAsync({ orderId, row_id: line.id, quantity });
      setQuantityEditingId(null);
      onRefetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs uppercase text-gray-400 tracking-wider">Order Lines ({lines.length})</h3>
        {canAdd && !showAdd && <button onClick={() => { setShowAdd(true); setError(""); }} className="text-xs text-[#1565c0]">+ Add line</button>}
      </div>
      {showAdd && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-3">
          <div className="mb-2 text-xs font-semibold">Add component line</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 text-xs">B2B Item Code<input value={newCode} onChange={(e) => setNewCode(e.target.value)} className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1" autoFocus /></label>
            <label className="w-20 text-xs">Qty<input type="number" min="1" value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1" /></label>
            <button onClick={addLine} disabled={addMutation.isPending || !newCode.trim()} className="rounded bg-[#1565c0] px-3 py-1 text-xs text-white disabled:opacity-50">{addMutation.isPending ? "Adding..." : "Add"}</button>
            <button onClick={() => { setShowAdd(false); setError(""); }} className="rounded border border-gray-300 bg-white px-2 py-1 text-xs">Cancel</button>
          </div>
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
        </div>
      )}
      <div className="border border-gray-200 rounded overflow-hidden">
        {lines.map((line) => (
          <div key={line.id} className={`p-3 border-b border-gray-200 last:border-b-0 ${line.cogs_unit_price_equal ? "border-l-4 border-l-[#f97316] bg-[#fff7ed]" : "bg-white"}`}>
            <div className="flex justify-between gap-3 text-xs mb-2">
              <div>
                <div className="font-semibold">{line.platform_sku || "SKU unavailable"}</div>
                <div className="text-gray-500">{line.product_name || "—"}</div>
              </div>
              {quantityEditingId === line.id ? (
                <span className="flex items-center gap-1">
                  <input type="number" min="1" value={quantityValue} onChange={(e) => setQuantityValue(e.target.value)} className="w-16 px-2 py-1 border border-gray-300 rounded" autoFocus />
                  <button onClick={() => saveQuantity(line)} disabled={quantityMutation.isPending} className="px-2 py-1 bg-[#1565c0] text-white rounded disabled:opacity-50">Save</button>
                  <button onClick={() => setQuantityEditingId(null)} className="px-2 py-1 border border-gray-300 rounded">Cancel</button>
                </span>
              ) : (
                <span className="text-gray-500">Qty {line.quantity} <button onClick={() => { setQuantityEditingId(line.id); setQuantityValue(String(line.quantity)); setError(""); }} className="ml-1 text-[#1565c0]">Edit</button></span>
              )}
            </div>
            {line.cogs_unit_price_equal && (
              <div className="mb-2 rounded border border-[#fb923c] bg-[#ffedd5] px-2 py-1.5 text-xs font-bold text-[#9a3412]" role="alert">
                ⚠ Effective COGS = Giga Unit Price ({line.effective_cogs?.toLocaleString("ja-JP")} JPY) — confirm supplier price
              </div>
            )}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 w-16">B2B Code</span>
              {editingId === line.id ? (
                <>
                  <input value={value} onChange={(e) => setValue(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-xs flex-1" autoFocus />
                  <button onClick={() => save(line)} disabled={mutation.isPending || !value.trim()} className="px-3 py-1 bg-[#1565c0] text-white rounded disabled:opacity-50">Save</button>
                  <button onClick={() => setEditingId(null)} className="px-2 py-1 border border-gray-300 rounded">Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1 font-medium">{line.B2BItemCode || "—"}</span>
                  <button onClick={() => { setEditingId(line.id); setValue(line.B2BItemCode || ""); setError(""); }} className="bg-white border border-gray-300 px-2 py-0.5 rounded text-[#1565c0]">Edit</button>
                </>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
              <span>Line TCOGS: {line.line_tcogs == null ? "Unavailable" : `${line.line_tcogs.toLocaleString("ja-JP")} JPY`}</span>
              <span>Stock: {line.stock?.label || "Unknown"}</span>
              {line.line_origin === "operator_component" && <span>Component #{line.component_index || "—"}</span>}
            </div>
            {(editingId === line.id || quantityEditingId === line.id) && error && <div className="mt-1 text-xs text-red-600">{error}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
