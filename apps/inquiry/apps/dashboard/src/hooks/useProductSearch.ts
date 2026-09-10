import { useState, useCallback, useRef } from "react";
import type { ProductSearchResult } from "../types/product";
import { searchProducts } from "../api/client";

export function useProductSearch(shopKey?: string | null) {
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = useCallback((term: string) => {
    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!term || term.trim().length === 0) {
      setResults([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    setIsSearching(true);
    setError(null);

    // Debounce: 300ms
    timerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchProducts(term.trim(), shopKey);
        setResults(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Product search failed");
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, [shopKey]);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setResults([]);
    setIsSearching(false);
    setError(null);
  }, []);

  return { results, isSearching, error, search, clear };
}
