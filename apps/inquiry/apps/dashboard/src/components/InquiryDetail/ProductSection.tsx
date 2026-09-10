import { useState } from "react";
import type { ProductLink } from "../../types/inquiry";
import type { ProductSearchResult } from "../../types/product";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import ProductSearchModal from "./ProductSearchModal";

interface ProductSectionProps {
  linkedProducts: ProductLink[];
  isLinking: boolean;
  isUnlinking: boolean;
  onLink: (productId: string) => void;
  onUnlink: (linkId: number) => void;
  linkError: string | null;
  mutationsEnabled: boolean;
  shopKey: string | null;
}

function provenanceLabel(linkSource: string | null, confidence: number | null): string {
  switch (linkSource) {
    case "operator":
      return "Manual";
    case "worker_match":
      return confidence != null ? `Auto-matched (${Math.round(confidence * 100)}%)` : "Auto-matched";
    case "enrichment":
      return "Enriched";
    case "migration":
      return "Migrated";
    default:
      return linkSource || "Unknown";
  }
}

function provenanceColor(linkSource: string | null): string {
  switch (linkSource) {
    case "operator":
      return "bg-blue-100 text-blue-700";
    case "worker_match":
      return "bg-green-100 text-green-700";
    case "enrichment":
      return "bg-purple-100 text-purple-700";
    case "migration":
      return "bg-gray-100 text-gray-600";
    default:
      return "bg-yellow-100 text-yellow-700";
  }
}

export default function ProductSection({
  linkedProducts,
  isLinking,
  isUnlinking,
  onLink,
  onUnlink,
  linkError,
  mutationsEnabled,
  shopKey,
}: ProductSectionProps) {
  const [showSearch, setShowSearch] = useState(false);

  return (
    // Product linking adds/removes and reorders nodes. Chrome's page translator
    // rewrites text nodes in-place, which can make React reconcile against DOM
    // nodes that are no longer children of their original parent.
    <div className="notranslate space-y-3" translate="no">
      {/* Mutations disabled banner */}
      {!mutationsEnabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Editing is currently disabled. Contact an admin to enable mutations.
        </div>
      )}

      {/* Error banner */}
      {linkError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {linkError}
        </div>
      )}

      {/* Linked product cards */}
      {linkedProducts.map((p, idx) => (
        <div key={p.linkRowId ?? idx} className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-gray-900">{p.productName}</h4>
                {p.isPrimary && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                    Primary
                  </span>
                )}
                {p.linkSource && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${provenanceColor(p.linkSource)}`}
                  >
                    {provenanceLabel(p.linkSource, p.confidence)}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">SKU: {p.itemCode || "--"}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              disabled={isUnlinking || !mutationsEnabled || p.linkRowId == null}
              onClick={() => {
                if (p.linkRowId != null) onUnlink(p.linkRowId);
              }}
              title={p.linkRowId == null ? "Cannot remove — no link row ID available" : undefined}
            >
              {isUnlinking ? "Removing..." : "Remove"}
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <StockField label="Giga Supplier Qty" value={p.qtyAvailable} />
            <StockField label="Owned Qty" value={p.ownedQty} />
            <StockField label="Mercari Qty" value={p.mercariQty} />
            <StockField label="Restock Date" value={p.restockDate} />
          </div>
        </div>
      ))}

      {/* Link a Product — always visible */}
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center">
        <p className="mb-3 text-sm text-gray-500">
          {linkedProducts.length > 0 ? "Link another product" : "No product linked"}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={isLinking || !mutationsEnabled}
          onClick={() => setShowSearch(true)}
        >
          {isLinking ? <Spinner size="sm" /> : null}
          Link a Product
        </Button>
      </div>

      <ProductSearchModal
        open={showSearch}
        shopKey={shopKey}
        onClose={() => setShowSearch(false)}
        onSelect={(productId) => {
          onLink(productId);
          setShowSearch(false);
        }}
      />
    </div>
  );
}

function StockField({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <span className="text-gray-400">{label}</span>
      <p className="font-medium text-gray-700">
        {value !== null && value !== undefined ? String(value) : "--"}
      </p>
    </div>
  );
}
