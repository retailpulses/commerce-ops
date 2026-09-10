import { useState, useEffect, useRef } from "react";
import { useProductSearch } from "../../hooks/useProductSearch";
import type { ProductSearchResult } from "../../types/product";
import Modal from "../ui/Modal";
import Spinner from "../ui/Spinner";
import EmptyState from "../ui/EmptyState";
import ErrorState from "../ui/ErrorState";

interface ProductSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (productId: string) => void;
  shopKey: string | null;
}

export default function ProductSearchModal({ open, onClose, onSelect, shopKey }: ProductSearchModalProps) {
  const { results, isSearching, error, search, clear } = useProductSearch(shopKey);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      clear();
      // Focus input after modal opens
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, clear]);

  const handleSearch = (value: string) => {
    setQuery(value);
    search(value);
  };

  return (
    <Modal open={open} onClose={onClose} title="Link a Product">
      <div className="notranslate space-y-4" translate="no">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search by product name or SKU..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm
            placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <div className="max-h-80 overflow-y-auto">
          {isSearching && (
            <div className="flex justify-center py-6">
              <Spinner size="md" />
            </div>
          )}

          {error && <ErrorState message={error} />}

          {!isSearching && !error && results.length === 0 && query && (
            <EmptyState message="No products found" />
          )}

          {!isSearching && !error && results.length === 0 && !query && (
            <EmptyState message="Type to search products" />
          )}

          {!isSearching && results.length > 0 && (
            <div className="space-y-1">
              {results.map((product) => (
                <ProductResult
                  key={product.id}
                  product={product}
                  onClick={() => onSelect(product.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ProductResult({
  product,
  onClick,
}: {
  product: ProductSearchResult;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-md border border-gray-100 px-3 py-2.5 text-left hover:border-blue-300 hover:bg-blue-50"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 truncate">{product.productName}</p>
          <p className="text-xs text-gray-500">SKU: {product.itemCode || "--"}</p>
        </div>
        <div className="ml-3 flex-shrink-0 text-right">
          <p className="text-xs text-gray-500">Giga Supplier: {product.qtyAvailable ?? "--"}</p>
          <p className="text-xs text-gray-400">Owned: {product.ownedQty ?? "--"}</p>
          <p className="text-xs text-gray-400">Mercari: {product.mercariQty ?? "--"}</p>
        </div>
      </div>
    </button>
  );
}
