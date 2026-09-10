import { useState, useEffect, useCallback, useRef } from "react";
import type { InquirySummary, Pagination } from "../types/inquiry";
import { getInquiries } from "../api/client";
import { STATUS_RECEIVED } from "../utils/constants";

const DEFAULT_PAGE_SIZE = 20;

export function useInquiries() {
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_RECEIVED);
  const [shopFilter, setShopFilter] = useState<string>("_all");
  const [inquiryTypeFilter, setInquiryTypeFilter] = useState<string>("_all");
  const [searchQuery, setSearchQuery] = useState("");
  const [minExpectedValue, setMinExpectedValue] = useState<number | null>(null);
  const [maxExpectedValue, setMaxExpectedValue] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<number | null>(null);

  const fetchInquiries = useCallback(
    async (
      status: string,
      search: string,
      shop: string,
      inquiryType: string,
      minEv: number | null,
      maxEv: number | null,
      append = false,
    ) => {
      setIsLoading(true);
      setError(null);
      try {
        const params: {
          status?: string;
          search?: string;
          shop?: string;
          inquiryType?: string;
          pageSize?: number;
          cursor?: number;
          minExpectedValue?: number | null;
          maxExpectedValue?: number | null;
        } = {
          search,
          pageSize: DEFAULT_PAGE_SIZE,
        };
        if (append && cursorRef.current != null) params.cursor = cursorRef.current;
        if (status !== "_all") params.status = status;
        if (shop !== "_all") params.shop = shop;
        if (inquiryType !== "_all") params.inquiryType = inquiryType;
        if (minEv != null) params.minExpectedValue = minEv;
        if (maxEv != null) params.maxExpectedValue = maxEv;
        const { data, pagination } = await getInquiries(params);
        setInquiries((previous) => append ? [...previous, ...data] : data);
        setHasMore(pagination.hasMore);
        cursorRef.current = pagination.nextCursor ?? null;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load inquiries");
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  // Fetch when filter changes
  useEffect(() => {
    cursorRef.current = null;
    fetchInquiries(statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue);
  }, [statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue, fetchInquiries]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return;
    fetchInquiries(statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue, true);
  }, [hasMore, isLoading, statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue, fetchInquiries]);

  const refresh = useCallback(() => {
    cursorRef.current = null;
    fetchInquiries(statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue);
  }, [statusFilter, searchQuery, shopFilter, inquiryTypeFilter, minExpectedValue, maxExpectedValue, fetchInquiries]);

  const setStatus = useCallback((status: string) => {
    setStatusFilter(status);
  }, []);

  const setSearch = useCallback((search: string) => {
    setSearchQuery(search);
  }, []);

  const setShop = useCallback((shop: string) => {
    setShopFilter(shop);
  }, []);

  const setInquiryType = useCallback((inquiryType: string) => {
    setInquiryTypeFilter(inquiryType);
  }, []);

  const setExpectedValueRange = useCallback((min: number | null, max: number | null) => {
    setMinExpectedValue(min);
    setMaxExpectedValue(max);
  }, []);

  // Optimistic update: remove inquiry from list (e.g., after status change)
  const removeInquiry = useCallback((id: number) => {
    setInquiries((prev) => prev.filter((inq) => inq.id !== id));
  }, []);

  // Optimistic update: update inquiry in list
  const updateInquiry = useCallback((id: number, updates: Partial<InquirySummary>) => {
    setInquiries((prev) =>
      prev.map((inq) => (inq.id === id ? { ...inq, ...updates } : inq)),
    );
  }, []);

  return {
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
  };
}
