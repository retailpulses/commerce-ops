import type { InquirySummary } from "../../types/inquiry";
import StatusTabs from "./StatusTabs";
import ShopFilter from "./ShopFilter";
import InquiryTypeFilter from "./InquiryTypeFilter";
import SearchBar from "./SearchBar";
import ExpectedValueFilter from "./ExpectedValueFilter";
import InquiryRow from "./InquiryRow";
import Skeleton from "../ui/Skeleton";
import EmptyState from "../ui/EmptyState";
import ErrorState from "../ui/ErrorState";
import Button from "../ui/Button";

interface InquiryListProps {
  inquiries: InquirySummary[];
  statusFilter: string;
  shopFilter: string;
  inquiryTypeFilter: string;
  searchQuery: string;
  minExpectedValue: number | null;
  maxExpectedValue: number | null;
  selectedId: number | null;
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  onStatusChange: (status: string) => void;
  onShopChange: (shop: string) => void;
  onInquiryTypeChange: (inquiryType: string) => void;
  onSearchChange: (search: string) => void;
  onExpectedValueRangeChange: (min: number | null, max: number | null) => void;
  onSelectInquiry: (id: number) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

export default function InquiryList({
  inquiries,
  statusFilter,
  shopFilter,
  inquiryTypeFilter,
  searchQuery,
  minExpectedValue,
  maxExpectedValue,
  selectedId,
  isLoading,
  error,
  hasMore,
  onStatusChange,
  onShopChange,
  onInquiryTypeChange,
  onSearchChange,
  onExpectedValueRangeChange,
  onSelectInquiry,
  onLoadMore,
  onRetry,
}: InquiryListProps) {
  const renderContent = () => {
    if (error) {
      return <ErrorState message={error} onRetry={onRetry} />;
    }

    if (isLoading && inquiries.length === 0) {
      return (
        <div className="space-y-4 px-4 py-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-8 w-8 animate-pulse rounded-full bg-gray-200" />
              <Skeleton lines={2} className="flex-1" />
            </div>
          ))}
        </div>
      );
    }

    if (!isLoading && inquiries.length === 0) {
      return (
        <EmptyState
          icon={
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
              />
            </svg>
          }
          message={
            searchQuery
              ? "No inquiries match your search"
              : "No inquiries in this status"
          }
        />
      );
    }

    return (
      <>
        <div className="divide-y divide-gray-100">
          {inquiries.map((inq) => (
            <InquiryRow
              key={inq.id}
              inquiry={inq}
              isSelected={selectedId === inq.id}
              onClick={() => onSelectInquiry(inq.id)}
            />
          ))}
        </div>
        {hasMore && (
          <div className="px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={onLoadMore}
            >
              Load more
            </Button>
          </div>
        )}
        {isLoading && inquiries.length > 0 && (
          <div className="flex justify-center py-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="space-y-3 border-b border-gray-200 px-4 py-3">
        <div className="flex gap-3">
          <StatusTabs selected={statusFilter} onSelect={onStatusChange} />
          <ShopFilter selected={shopFilter} onSelect={onShopChange} />
          <InquiryTypeFilter selected={inquiryTypeFilter} onSelect={onInquiryTypeChange} />
        </div>
        <SearchBar value={searchQuery} onChange={onSearchChange} />
        <ExpectedValueFilter
          min={minExpectedValue}
          max={maxExpectedValue}
          onApply={onExpectedValueRangeChange}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">{renderContent()}</div>
    </div>
  );
}
