import { useState } from "react";
import type { TicketProduct, ProductSearchResult } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useSearchProducts } from "@/hooks/useTickets";

interface ProductsTabProps {
  products: TicketProduct[];
  onLinkProduct: (product: ProductSearchResult) => Promise<void>;
  onUnlinkProduct: (productId: string) => Promise<void>;
}

function formatPrice(value: number | undefined): string {
  if (value === undefined || value === null) return "-";
  return `¥${value.toLocaleString()}`;
}

export function ProductsTab({
  products,
  onLinkProduct,
  onUnlinkProduct,
}: ProductsTabProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const { data: searchData, isLoading: searching } =
    useSearchProducts(searchQuery);

  const searchResults = searchData?.products ?? [];

  const handleLink = async (product: ProductSearchResult) => {
    setLinking(true);
    try {
      await onLinkProduct(product);
      setSearchOpen(false);
      setSearchQuery("");
    } catch {
      // Error toast is shown by the parent handler
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async (productId: string) => {
    setUnlinkingId(productId);
    try {
      await onUnlinkProduct(productId);
    } finally {
      setUnlinkingId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {/* Product list */}
      {products.length === 0 && (
        <p className="text-sm text-text-muted text-center py-8">
          No linked products.
        </p>
      )}

      <div className="flex flex-col divide-y divide-border">
        {products.map((p) => (
          <div
            key={p.id}
            className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 items-center px-4 py-3 text-sm"
          >
            <div className="min-w-0">
              <span className="font-mono text-xs text-text-muted">
                {p.sku}
              </span>
              <span className="ml-2 text-text truncate block">
                {p.product_name ?? "-"}
              </span>
            </div>
            <span className="text-xs text-text-muted px-2 py-0.5 rounded bg-gray-100">
              {p.role}
            </span>
            <span className="text-xs text-text-muted">
              {p.seller_name ?? "-"}
            </span>
            <span className="text-xs text-text-muted tabular-nums">
              {formatPrice(p.unit_price)}
            </span>
            <span className="text-xs text-text-muted tabular-nums">
              {formatPrice(p.unit_fulfillment_price)}
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={unlinkingId === p.id}
              onClick={() => handleUnlink(p.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      {/* Link Product button */}
      <div className="px-4 py-3 border-t border-border">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSearchOpen(true)}
        >
          + Link Product
        </Button>
      </div>

      {/* Product search modal */}
      <Modal
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery("");
        }}
        title="Search Products"
      >
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search by SKU or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />

          {searching && (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          )}

          {!searching && searchQuery && searchResults.length === 0 && (
            <p className="text-sm text-text-muted text-center py-4">
              No products found.
            </p>
          )}

          {!searching && searchResults.length > 0 && (
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
              {searchResults.map((result) => (
                <button
                  key={`${result.product_id}-${result.variant_id}`}
                  disabled={linking}
                  onClick={() => handleLink(result)}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-text font-medium block truncate">
                      {result.product_name}
                    </span>
                    <span className="text-xs text-text-muted font-mono">
                      {result.sku}
                    </span>
                    {result.platform && (
                      <span className="text-xs text-text-muted ml-2">
                        {result.platform}
                      </span>
                    )}
                    {result.variant_name && (
                      <span className="text-xs text-text-muted ml-2">
                        / {result.variant_name}
                      </span>
                    )}
                  </div>
                  {linking && <Spinner className="size-4" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
