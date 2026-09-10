import type { OrderRow } from "@/types/orders";
import { Badge, UnreadBadge, CheckPendingBadge } from "@/components/shared/Badge";
import { shopLabel, fmtYen, fmtPct, relativeTime, formatJstDisplay } from "@/lib/constants";
import { Spinner } from "@/components/shared/Spinner";

interface OrderTableProps {
  orders: OrderRow[];
  isLoading: boolean;
  sort: string;
  order: "asc" | "desc";
  onSort: (col: string) => void;
  onSelectOrder: (orderId: string) => void;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
}

type SortCol = "purchase_date" | "order_id" | "quantity" | "margin_amount" | "margin_pct";

function SortHeader({
  col,
  label,
  currentSort,
  currentOrder,
  onSort,
}: {
  col: SortCol;
  label: string;
  currentSort: string;
  currentOrder: string;
  onSort: (col: string) => void;
}) {
  const isSorted = currentSort === col;
  const arrow = isSorted ? (currentOrder === "asc" ? "▲" : "▼") : "";
  return (
    <th
      onClick={() => onSort(col)}
      className={`bg-gray-100 dark:bg-gray-700 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200 dark:border-gray-600 whitespace-nowrap cursor-pointer select-none hover:bg-gray-200 dark:hover:bg-gray-600 ${isSorted ? "text-[#1565c0]" : "dark:text-gray-200"}`}
    >
      {label}
      <span className={`ml-1 text-xs ${isSorted ? "opacity-100" : "opacity-40"}`}>
        {arrow || "▸"}
      </span>
    </th>
  );
}

export function OrderTable({
  orders,
  isLoading,
  sort,
  order,
  onSort,
  onSelectOrder,
  selectedIds,
  onSelectionChange,
}: OrderTableProps) {
  const toggleSelect = (orderId: string) => {
    const next = new Set(selectedIds);
    if (next.has(orderId)) next.delete(orderId);
    else next.add(orderId);
    onSelectionChange(next);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === orders.length) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(orders.map((o) => o.portal_target_id || o.order_id)));
    }
  };

  if (isLoading) {
    return (
      <div className="text-center py-10 text-gray-400 dark:text-gray-500">
        <Spinner /> Loading orders...
      </div>
    );
  }

  if (!orders.length) {
    return <div className="text-center py-10 text-gray-400 dark:text-gray-500">No orders match the current filters.</div>;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="w-9 bg-gray-100 dark:bg-gray-700 px-2 py-2.5 border-b-2 border-gray-200 dark:border-gray-600">
              <input
                type="checkbox"
                checked={orders.length > 0 && selectedIds.size === orders.length}
                onChange={toggleSelectAll}
                className="w-4 h-4 cursor-pointer"
              />
            </th>
            <SortHeader col="purchase_date" label="Age" currentSort={sort} currentOrder={order} onSort={onSort} />
            <SortHeader col="order_id" label="Order ID" currentSort={sort} currentOrder={order} onSort={onSort} />
            <th className="bg-gray-100 dark:bg-gray-700 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200 dark:border-gray-600 whitespace-nowrap dark:text-gray-200">
              Product
            </th>
            <th className="bg-gray-100 dark:bg-gray-700 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200 dark:border-gray-600 whitespace-nowrap dark:text-gray-200">
              Shop
            </th>
            <SortHeader col="quantity" label="Qty" currentSort={sort} currentOrder={order} onSort={onSort} />
            <SortHeader col="margin_amount" label="Margin" currentSort={sort} currentOrder={order} onSort={onSort} />
            <SortHeader col="margin_pct" label="Margin%" currentSort={sort} currentOrder={order} onSort={onSort} />
            <th className="bg-gray-100 dark:bg-gray-700 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200 dark:border-gray-600 whitespace-nowrap dark:text-gray-200">
              Stock
            </th>
            <th className="bg-gray-100 dark:bg-gray-700 px-3 py-2.5 text-left font-semibold text-sm border-b-2 border-gray-200 dark:border-gray-600 whitespace-nowrap dark:text-gray-200">
              Risk
            </th>
            <th className="w-9 bg-gray-100 dark:bg-gray-700 px-2 py-2.5 border-b-2 border-gray-200 dark:border-gray-600" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <OrderRowView
              key={o.id}
              order={o}
              isSelected={selectedIds.has(o.portal_target_id || o.order_id)}
              onToggleSelect={() => toggleSelect(o.portal_target_id || o.order_id)}
              onClick={() => onSelectOrder(o.portal_target_id || o.order_id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderRowView({
  order: o,
  isSelected,
  onToggleSelect,
  onClick,
}: {
  order: OrderRow;
  isSelected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
}) {
  const m = o.margin || {};
  const s = o.stock || {};
  const badges = o.risk_badges || [];
  const age = relativeTime(o.purchase_date);

  const marginAmountHtml =
    m.profit != null ? (
      <span className={m.profit >= 0 ? "text-[#2e7d32] font-semibold" : "text-[#c62828] font-semibold"}>
        {fmtYen(m.profit)}
      </span>
    ) : (
      <span className="text-gray-400 dark:text-gray-500">N/A</span>
    );

  const marginPctHtml =
    m.marginPercent != null ? (
      <span className={m.marginPercent >= 0 ? "text-[#2e7d32] font-semibold" : "text-[#c62828] font-semibold"}>
        {fmtPct(m.marginPercent)}
      </span>
    ) : (
      <span className="text-gray-400 dark:text-gray-500">N/A</span>
    );

  let stockHtml: React.ReactNode;
  const owned = s.ownedQty != null ? s.ownedQty : "?";
  const avail = s.qtyAvailable != null ? s.qtyAvailable : "?";
  if (s.status === "owned_ok") stockHtml = <span className="text-[#2e7d32]">{owned}/{avail}</span>;
  else if (s.status === "supplier_ok") stockHtml = <span className="text-[#f9a825]">{owned}/{avail}</span>;
  else if (s.status === "partial" || s.status === "needs_procurement") stockHtml = <span className="text-[#c62828]">{owned}/{avail}</span>;
  else stockHtml = <span className="text-gray-400 dark:text-gray-500">?</span>;

  const isWaitingPayment = o.order_status === "Waiting for Payment";
  const isMsgUnknown = o.unread_classification === "unknown";
  const hasUnread = o.has_unread;
  const needsPriceConfirmation = badges.some((badge) => badge.type === "cogs_unit_price_equal");

  let rowClass = "cursor-pointer transition-colors hover:bg-[#f0f7ff] dark:hover:bg-gray-700";
  if (isWaitingPayment) rowClass += " bg-[#ede7f6] dark:bg-[#322b4a] hover:bg-[#dbcfeb] dark:hover:bg-[#3d3460]";
  if (needsPriceConfirmation) rowClass += " bg-[#fff7ed] dark:bg-[#422d1f] shadow-[inset_5px_0_0_#f97316] hover:bg-[#ffedd5] dark:hover:bg-[#513624]";
  else if (isMsgUnknown) rowClass += " shadow-[inset_3px_0_0_#f59e0b]";
  else if (hasUnread) rowClass += " shadow-[inset_3px_0_0_#3b82f6]";

  const orderUrl = `https://mercari-shops.com/seller/shops/${encodeURIComponent(o.shop_id || "")}/orders/${encodeURIComponent(o.order_id || "")}`;

  return (
    <tr onClick={onClick} className={rowClass}>
      <td className="px-2 py-2 border-b border-gray-200 dark:border-gray-700" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          className="w-4 h-4 cursor-pointer"
        />
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700" title={formatJstDisplay(o.purchase_date)}>
        {age}
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 font-mono text-xs">
        {o.order_id || "—"}
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        {o.is_fee_row ? (
          <span className="text-gray-400 dark:text-gray-500">ℹ {o.product_name} (fee row)</span>
        ) : (
          o.product_name || "—"
        )}
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">{shopLabel(o.shop_id)}</td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">{o.quantity || 0}</td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">{marginAmountHtml}</td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">{marginPctHtml}</td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">{stockHtml}</td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        {isMsgUnknown ? <CheckPendingBadge /> : hasUnread ? <UnreadBadge /> : null}
        {needsPriceConfirmation && (
          <Badge badge={{ type: "cogs_unit_price_equal", label: "⚠ Effective COGS = Giga Unit Price", severity: "warning" }} />
        )}
        {badges.filter((badge) => badge.type !== "cogs_unit_price_equal").slice(0, needsPriceConfirmation ? 2 : 3).map((b, i) => (
          <Badge key={i} badge={b} />
        ))}
      </td>
      <td className="px-2 py-2 border-b border-gray-200 dark:border-gray-700">
        <a
          href={orderUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[#1565c0] no-underline text-xs whitespace-nowrap hover:underline"
          title="View in Mercari"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      </td>
    </tr>
  );
}
