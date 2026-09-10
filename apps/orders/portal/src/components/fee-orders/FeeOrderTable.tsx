import { useFeeOrdersQuery } from "@/hooks/useOrders";
import { Spinner } from "@/components/shared/Spinner";
import { formatJstDisplay } from "@/lib/constants";
import type { OrderFilters } from "@/types/orders";
import { PAGE_SIZE } from "@/lib/constants";

interface Props {
  filters: OrderFilters;
  page: number;
  onSelectOrder: (id: string) => void;
}

export function FeeOrderTable({ filters, page, onSelectOrder }: Props) {
  const { data, isLoading } = useFeeOrdersQuery({
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    shop: filters.shop,
    lifecycle: filters.lifecycle,
    review: filters.review,
    search: filters.search,
  });

  const rows = data?.results || [];

  if (isLoading) {
    return <div className="text-center py-10 text-gray-400"><Spinner /> Loading fee orders...</div>;
  }

  if (!rows.length) {
    return <div className="text-center py-10 text-gray-400">No fee orders match the current filters.</div>;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Fee Order ID</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Fee Product</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Fee Status</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Main Order ID</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Main Product</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Main Status</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Main Shipped?</th>
            <th className="bg-gray-100 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200">Purchase Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const f = row.fee;
            const m = row.main;
            return (
              <tr
                key={`fee-${f.id}-${i}`}
                className="cursor-pointer transition-colors hover:bg-[#f0f7ff]"
                onClick={() => onSelectOrder(f.order_id)}
              >
                <td className="px-3 py-2 border-b border-gray-200 font-mono text-xs">{f.order_id}</td>
                <td className="px-3 py-2 border-b border-gray-200 text-gray-400">ℹ {f.product_name || "—"}</td>
                <td className="px-3 py-2 border-b border-gray-200">{f.order_status || "—"}</td>
                <td className="px-3 py-2 border-b border-gray-200">
                  {m ? (
                    <code
                      className="text-xs text-[#1565c0] underline cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); onSelectOrder(m.order_id); }}
                    >
                      {m.order_id}
                    </code>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 border-b border-gray-200">{m?.product_name || <span className="text-gray-400">—</span>}</td>
                <td className="px-3 py-2 border-b border-gray-200">{m?.order_status || <span className="text-gray-400">—</span>}</td>
                <td className="px-3 py-2 border-b border-gray-200">
                  {m ? (
                    row.main_shipped ? <span className="text-[#2e7d32]">Yes ✔</span> : <span className="text-[#f9a825]">No</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 border-b border-gray-200">{formatJstDisplay(f.purchase_date) || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
