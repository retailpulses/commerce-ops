import { useState, useCallback, useEffect } from "react";
import Layout from "./components/Layout";
import InquiryList from "./components/InquiryList/InquiryList";
import InquiryDetailContainer from "./components/InquiryDetail/InquiryDetailContainer";
import ErrorBoundary from "./components/ErrorBoundary";
import TemplateManager from "./components/Settings/TemplateManager";
import FollowUpQueue from "./components/FollowUpQueue/FollowUpQueue";
import { useInquiries } from "./hooks/useInquiries";
import { useTemplates } from "./hooks/useTemplates";
import type { StatusInfo } from "./types/inquiry";

export default function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "follow-ups") {
    return (
      <Layout onTemplatesClick={() => {}}>
        <FollowUpQueue />
      </Layout>
    );
  }

  const {
    inquiries,
    statusFilter,
    shopFilter,
    inquiryTypeFilter,
    searchQuery,
    minExpectedValue,
    maxExpectedValue,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
    setStatus,
    setShop,
    setInquiryType,
    setSearch,
    setExpectedValueRange,
    removeInquiry,
    updateInquiry,
  } = useInquiries();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);

  const { templates, fetch: fetchTemplates, create: createTemplate, update: updateTemplate, remove: removeTemplate } = useTemplates();

  // Fetch templates on mount (for the DraftEditor dropdown)
  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleSelectInquiry = useCallback((id: number) => {
    setSelectedId(id);
  }, []);

  const handleStatusChanged = useCallback(
    (id: number, newStatus: StatusInfo) => {
      // If the new status doesn't match the current filter, remove it from list
      if (statusFilter !== "_all" && newStatus.id !== statusFilter) {
        removeInquiry(id);
        if (selectedId === id) setSelectedId(null);
      } else {
        updateInquiry(id, { status: newStatus });
      }
    },
    [statusFilter, removeInquiry, updateInquiry, selectedId],
  );

  const handleProductChanged = useCallback(
    (id: number) => {
      updateInquiry(id, { hasProduct: true });
    },
    [updateInquiry],
  );

  const handleInquiryTypeChanged = useCallback(
    (id: number, inquiryType: import("./types/inquiry").InquiryTypeInfo) => {
      if (inquiryTypeFilter !== "_all" && inquiryType.id !== inquiryTypeFilter) {
        removeInquiry(id);
        if (selectedId === id) setSelectedId(null);
      } else {
        updateInquiry(id, { inquiryType });
      }
    },
    [inquiryTypeFilter, removeInquiry, updateInquiry, selectedId],
  );

  const handleSearchChange = useCallback(
    (search: string) => {
      setSearch(search);
      setSelectedId(null); // Deselect when searching
    },
    [setSearch],
  );

  const handleStatusChange = useCallback(
    (status: string) => {
      setStatus(status);
      setSelectedId(null); // Deselect when changing filter
    },
    [setStatus],
  );

  const handleShopChange = useCallback(
    (shop: string) => {
      setShop(shop);
      setSelectedId(null); // Deselect when changing filter
    },
    [setShop],
  );

  const handleInquiryTypeChange = useCallback(
    (inquiryType: string) => {
      setInquiryType(inquiryType);
      setSelectedId(null);
    },
    [setInquiryType],
  );

  return (
    <Layout onTemplatesClick={() => setTemplateManagerOpen(true)}>
      <div className="flex h-full">
        {/* Left panel: Inquiry list (50%) */}
        <div className="w-1/2 flex-shrink-0 border-r border-gray-200 bg-white md:w-1/2">
          <InquiryList
            inquiries={inquiries}
            statusFilter={statusFilter}
            shopFilter={shopFilter}
            inquiryTypeFilter={inquiryTypeFilter}
            searchQuery={searchQuery}
            minExpectedValue={minExpectedValue}
            maxExpectedValue={maxExpectedValue}
            selectedId={selectedId}
            isLoading={isLoading}
            error={error}
            hasMore={hasMore}
            onStatusChange={handleStatusChange}
            onShopChange={handleShopChange}
            onInquiryTypeChange={handleInquiryTypeChange}
            onSearchChange={handleSearchChange}
            onExpectedValueRangeChange={setExpectedValueRange}
            onSelectInquiry={handleSelectInquiry}
            onLoadMore={loadMore}
            onRetry={refresh}
          />
        </div>

        {/* Right panel: Inquiry detail (50%) */}
        <div className="w-1/2 flex-shrink-0 bg-gray-50 md:w-1/2">
          <ErrorBoundary resetKey={selectedId}>
            <InquiryDetailContainer
              inquiryId={selectedId}
              templates={templates}
              onStatusChanged={handleStatusChanged}
              onProductChanged={handleProductChanged}
              onInquiryTypeChanged={handleInquiryTypeChanged}
            />
          </ErrorBoundary>
        </div>
      </div>

      <TemplateManager
        open={templateManagerOpen}
        onClose={() => setTemplateManagerOpen(false)}
        templates={templates}
        isLoading={false}
        error={null}
        onCreate={createTemplate}
        onUpdate={updateTemplate}
        onDelete={removeTemplate}
        onRefresh={fetchTemplates}
      />
    </Layout>
  );
}
