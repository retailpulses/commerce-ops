import { useState } from "react";
import { usePresaleQuery, usePresaleMemoMutation } from "@/hooks/usePresale";
import { Spinner } from "@/components/shared/Spinner";
import type { PresaleGroup } from "@/types/orders";

export function PresaleDashboard() {
  const { data, isLoading } = usePresaleQuery();
  const memoMutation = usePresaleMemoMutation();
  const [modalItem, setModalItem] = useState<PresaleGroup | null>(null);
  const [memoText, setMemoText] = useState("");
  const [memoFeedback, setMemoFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  const groups = data?.results || [];

  const handleSaveMemo = async () => {
    if (!modalItem || !memoText.trim()) return;
    setMemoFeedback(null);
    try {
      await memoMutation.mutateAsync({ itemCode: modalItem.B2BItemCode, text: memoText.trim() });
      setMemoFeedback({ msg: "Memo saved", ok: true });
      setMemoText("");
    } catch (e) {
      setMemoFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  if (isLoading) {
    return <div className="text-center py-10 text-gray-400"><Spinner /> Loading presale dashboard...</div>;
  }

  if (!groups.length) {
    return <div className="text-center py-10 text-gray-400">No presale orders found.</div>;
  }

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">B2B Code</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Product</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Restock Date</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Orders</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Qty</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Payment/Shipping</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Stock</th>
              <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Restock Info</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.B2BItemCode || "__unassigned__"}
                className="cursor-pointer transition-colors hover:bg-[#f0f7ff]"
                onClick={() => setModalItem(g)}
              >
                <td className="px-3 py-2 border-b border-gray-200 font-mono text-xs">{g.B2BItemCode || "—"}</td>
                <td className="px-3 py-2 border-b border-gray-200">{g.product_name || "—"}</td>
                <td className="px-3 py-2 border-b border-gray-200 font-semibold whitespace-nowrap">{g.restock_date}</td>
                <td className="px-3 py-2 border-b border-gray-200">{g.order_count}</td>
                <td className="px-3 py-2 border-b border-gray-200">{g.total_quantity}</td>
                <td className="px-3 py-2 border-b border-gray-200 text-xs whitespace-nowrap">
                  <span className="inline-block px-1 py-px rounded-sm mr-1 bg-[#e3f2fd] text-[#1565c0] text-[11px]">
                    {g.status_breakdown?.WAITING_FOR_PAYMENT || 0} payment
                  </span>
                  <span className="inline-block px-1 py-px rounded-sm bg-[#e8f5e9] text-[#2e7d32] text-[11px]">
                    {g.status_breakdown?.WAITING_FOR_SHIPPING || 0} shipping
                  </span>
                </td>
                <td className="px-3 py-2 border-b border-gray-200">
                  {g.owned_qty != null ? (
                    <span className={g.owned_qty < g.total_quantity ? "text-[#d32f2f] font-semibold" : "text-[#2e7d32]"}>
                      {g.owned_qty}/{g.qty_available || "?"}
                    </span>
                  ) : (
                    <span className="text-gray-400">?</span>
                  )}
                </td>
                <td className="px-3 py-2 border-b border-gray-200">
                  <span className="text-gray-400 text-xs cursor-pointer hover:text-[#1565c0]" onClick={(e) => { e.stopPropagation(); setModalItem(g); }}>
                    {g.restock_info ? g.restock_info.substring(0, 50) + "..." : "Add memo"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Memo modal */}
      {modalItem && (
        <div className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center" onClick={() => setModalItem(null)}>
          <div className="bg-white rounded-lg shadow-xl w-[640px] max-w-[95vw] max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-bold">
                Restock Memo
                <span className="inline-block bg-[#1565c0] text-white px-2 py-0.5 rounded text-sm ml-2">
                  {modalItem.restock_date}
                </span>
              </h2>
              <button onClick={() => setModalItem(null)} className="text-gray-500 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-4">
              <h3 className="text-sm font-semibold mb-2">{modalItem.B2BItemCode} — {modalItem.product_name}</h3>

              <div className="flex gap-4 text-sm mb-2">
                <span>Orders: <strong>{modalItem.order_count}</strong></span>
                <span>Total Qty: <strong>{modalItem.total_quantity}</strong></span>
                <span>Stock: <strong>{modalItem.owned_qty != null ? `${modalItem.owned_qty}/${modalItem.qty_available}` : "?"}</strong></span>
              </div>

              <div className="text-sm mb-3 max-h-[200px] overflow-y-auto">
                {modalItem.order_ids.map((id) => (
                  <div key={id} className="text-[#1565c0] text-xs">{id}</div>
                ))}
              </div>

              <h3 className="text-sm font-semibold mb-1">Restock Info</h3>
              <textarea
                value={memoText}
                onChange={(e) => setMemoText(e.target.value)}
                placeholder="Add restock memo..."
                className="w-full min-h-[120px] px-3 py-2 border border-gray-300 rounded text-sm resize-y focus:outline-none focus:border-[#1565c0]"
              />
              {modalItem.restock_info && (
                <div className="mt-2 text-sm text-gray-500 whitespace-pre-wrap">
                  Current: {modalItem.restock_info}
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end px-5 py-3 border-t border-gray-200">
              {memoFeedback && (
                <span className={`text-sm mr-auto ${memoFeedback.ok ? "text-[#388e3c]" : "text-[#d32f2f]"}`}>
                  {memoFeedback.msg}
                </span>
              )}
              <button onClick={() => setModalItem(null)} className="px-4 py-2 bg-white border border-gray-300 rounded text-sm text-gray-600">
                Cancel
              </button>
              <button onClick={handleSaveMemo} disabled={memoMutation.isPending || !memoText.trim()} className="px-4 py-2 bg-[#1565c0] text-white border-none rounded text-sm hover:opacity-90 disabled:opacity-50">
                Save Memo
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
