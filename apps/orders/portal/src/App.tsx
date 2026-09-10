import { useState, useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { LoginScreen } from "@/components/shared/LoginScreen";
import { TopBar } from "@/components/layout/AppShell";
import { FilterBar } from "@/components/layout/FilterBar";
import { Pagination } from "@/components/layout/Pagination";
import { OrderTable } from "@/components/orders/OrderTable";
import { OrderDetailDrawer } from "@/components/detail/OrderDetailDrawer";
import { FeeOrderTable } from "@/components/fee-orders/FeeOrderTable";
import { PresaleDashboard } from "@/components/presale/PresaleDashboard";
import { TemplateManager } from "@/components/templates/TemplateManager";
import { ControlPlaneDashboard } from "@/components/control-plane/ControlPlaneDashboard";
import { ErrorBanner } from "@/components/shared/ErrorBanner";
import { useOrdersQuery, useBulkApproveMutation } from "@/hooks/useOrders";
import { orderFiltersFromSearch } from "@/lib/order-drillthrough";
import type { OrderFilters } from "@/types/orders";
import { PAGE_SIZE } from "@/lib/constants";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppContent() {
  const { isLoggedIn, login } = useAuth();

  if (!isLoggedIn) {
    return <LoginScreen onLogin={login} />;
  }

  return <PortalApp />;
}

function PortalApp() {
  const { theme, toggleTheme } = useTheme();
  const [filters, setFilters] = useState<OrderFilters>(() => orderFiltersFromSearch(window.location.search));
  const [sort, setSort] = useState("purchase_date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"orders" | "fee_orders" | "presale" | "health">("orders");
  const [showTemplates, setShowTemplates] = useState(false);
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(null);

  const { data, isLoading } = useOrdersQuery(filters, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    sort,
    order: sortOrder,
  });

  const bulkApproveMutation = useBulkApproveMutation();

  const handleSort = useCallback(
    (col: string) => {
      if (sort === col) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSort(col);
        setSortOrder(col === "purchase_date" ? "asc" : "desc");
      }
      setPage(1);
    },
    [sort],
  );

  const handleFilterChange = useCallback((f: OrderFilters) => {
    setFilters(f);
    setPage(1);
    setSelectedIds(new Set());
  }, []);

  const handleSearch = useCallback((q: string) => {
    setFilters((f) => ({ ...f, search: q }));
    setPage(1);
  }, []);

  const handleBulkApprove = async () => {
    const ids = [...selectedIds];
    try {
      await bulkApproveMutation.mutateAsync(ids);
      setSelectedIds(new Set());
    } catch (e) {
      setError(`Bulk approve failed: ${(e as Error).message}`);
    }
  };

  const orders = data?.results || [];
  const hasMore = (data?.has_more) ?? ((page * PAGE_SIZE) < (data?.total || 0));

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-4">
      <TopBar
        onOpenTemplates={() => setShowTemplates(true)}
        filters={filters}
        orders={orders}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {activeTab !== "health" && <FilterBar filters={filters} onChange={handleFilterChange} onSearch={handleSearch} />}

      {/* Tab bar */}
      <div className="flex gap-0 mb-3 border-b-2 border-gray-200">
        {(["orders", "fee_orders", "presale", "health"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2 text-sm border border-gray-200 border-b-0 rounded-t-md mr-0.5 ${
              activeTab === tab
                ? "bg-gray-100 text-gray-800 font-semibold -mb-0.5 border-b-gray-100"
                : "bg-white text-gray-500 hover:bg-gray-50"
            }`}
          >
            {tab === "orders" ? "Orders" : tab === "fee_orders" ? "Fee Orders" : tab === "presale" ? "Presale" : "Pipeline Health"}
          </button>
        ))}
      </div>

      {/* Bulk approve bar — orders tab only */}
      {activeTab === "orders" && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-[#e8f4fd] border border-[#1976d2] rounded-md mb-3 text-sm">
          <span className="font-semibold">{selectedIds.size} selected</span>
          <button
            onClick={handleBulkApprove}
            disabled={bulkApproveMutation.isPending}
            className="px-4 py-1.5 bg-[#388e3c] text-white border-none rounded text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {bulkApproveMutation.isPending ? "Approving..." : "Approve Selected"}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="bg-transparent border-none text-gray-500 text-xs underline cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* Orders tab */}
      {activeTab === "orders" && (
        <>
          <OrderTable
            orders={orders}
            isLoading={isLoading}
            sort={sort}
            order={sortOrder}
            onSort={handleSort}
            onSelectOrder={(id) => setDrawerOrderId(id)}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
          <Pagination
            page={page}
            hasMore={hasMore}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      {/* Fee Orders tab */}
      {activeTab === "fee_orders" && (
        <>
          <FeeOrderTable filters={filters} page={page} onSelectOrder={(id) => setDrawerOrderId(id)} />
          <Pagination
            page={page}
            hasMore={hasMore}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      {/* Presale tab */}
      {activeTab === "presale" && <PresaleDashboard />}

      {activeTab === "health" && <ControlPlaneDashboard />}

      {/* Order Detail Drawer */}
      <OrderDetailDrawer orderId={drawerOrderId} onClose={() => setDrawerOrderId(null)} />

      {/* Template Manager */}
      <TemplateManager open={showTemplates} onClose={() => setShowTemplates(false)} />
    </div>
  );
}

export default App;
