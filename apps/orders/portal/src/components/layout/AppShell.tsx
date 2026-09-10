import { useAuth } from "@/hooks/useAuth";
import { useSummaryQuery } from "@/hooks/useOrders";
import { exportOrdersToCsv } from "@/lib/csv-export";
import type { OrderFilters, OrderRow } from "@/types/orders";

interface SummaryBarProps {
  filters: OrderFilters;
}

export function SummaryBar({ filters }: SummaryBarProps) {
  const { data, isLoading } = useSummaryQuery({
    shop: filters.shop,
    lifecycle: filters.lifecycle,
    search: filters.search,
    channel: filters.channel,
  });

  if (isLoading) {
    return <div className="flex gap-5 text-sm text-gray-500" />;
  }

  if (!data) return null;

  const byReview = data.by_review || {};
  const parts: { label: string; cls: string; count: number }[] = [];
  if (byReview.pending_review) parts.push({ label: "Pending", cls: "bg-[#fff3e0] text-[#f57c00]", count: byReview.pending_review });
  if (byReview.auto_approved) parts.push({ label: "Auto-Approved", cls: "bg-[#e0f7fa] text-[#00695c]", count: byReview.auto_approved });
  if (byReview.approved) parts.push({ label: "Approved", cls: "bg-[#e8f5e9] text-[#388e3c]", count: byReview.approved });
  if (byReview.on_hold) parts.push({ label: "On Hold", cls: "bg-[#fff3e0] text-[#e65100]", count: byReview.on_hold });
  parts.push({ label: "Total", cls: "bg-gray-100 text-gray-600", count: data.total || 0 });

  return (
    <div className="flex gap-5 text-sm text-gray-500">
      {parts.map((p) => (
        <span key={p.label} className={`px-2 py-0.5 rounded-full text-xs font-medium ${p.cls}`}>
          {p.label}: {p.count}
        </span>
      ))}
      {data.degraded && (
        <span className="text-[#f57c00] text-xs">⚠ Counts may be incomplete</span>
      )}
    </div>
  );
}

interface TopBarProps {
  onOpenTemplates: () => void;
  filters: OrderFilters;
  orders: OrderRow[];
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function TopBar({ onOpenTemplates, filters, orders, theme, onToggleTheme }: TopBarProps) {
  const { logout } = useAuth();
  return (
    <header className="flex items-center justify-between py-3 border-b-2 border-gray-200 mb-4 dark:border-gray-700">
      <div className="flex items-center gap-6">
        <h1 className="text-xl font-bold dark:text-gray-100">📦 Order Mgmt</h1>
      </div>
      <div className="flex items-center gap-4">
        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 p-1.5 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {theme === "dark" ? (
            /* Sun icon */
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            /* Moon icon */
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          )}
        </button>

        {/* CSV Export */}
        <button
          onClick={() => exportOrdersToCsv(orders)}
          disabled={orders.length === 0}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-3 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          title={orders.length === 0 ? "No orders to export" : "Export visible orders as CSV"}
        >
          CSV
        </button>

        <button
          onClick={onOpenTemplates}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-3 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          Templates
        </button>
        <SummaryBar filters={filters} />
        <button
          onClick={logout}
          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-3 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
