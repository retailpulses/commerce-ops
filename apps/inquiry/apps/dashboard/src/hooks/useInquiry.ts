import { useState, useEffect, useCallback, useRef } from "react";
import type { InquiryDetail } from "../types/inquiry";
import { getInquiry } from "../api/client";

export function useInquiry(id: number | null) {
  const [inquiry, setInquiry] = useState<InquiryDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Incremented on inquiry switch — used to discard stale async responses
  const versionRef = useRef(0);

  const fetchInquiry = useCallback(async (inquiryId: number) => {
    const version = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getInquiry(inquiryId);
      if (versionRef.current !== version) return;
      setInquiry(data);
    } catch (err) {
      if (versionRef.current !== version) return;
      setError(err instanceof Error ? err.message : "Failed to load inquiry");
      setInquiry(null);
    } finally {
      if (versionRef.current === version) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id !== null) {
      fetchInquiry(id);
    } else {
      versionRef.current += 1;
      setInquiry(null);
      setError(null);
      setIsLoading(false);
    }
  }, [id, fetchInquiry]);

  const updateInquiryState = useCallback((updates: Partial<InquiryDetail>) => {
    setInquiry((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const refetch = useCallback(() => {
    if (id !== null) fetchInquiry(id);
  }, [id, fetchInquiry]);

  return {
    inquiry,
    isLoading,
    error,
    updateInquiry: updateInquiryState,
    refetch,
  };
}
