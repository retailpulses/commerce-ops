import type { InquiryDetail, MessageTemplate } from "../../types/inquiry";
import { formatDate, formatPrice } from "../../utils/formatters";
import StatusDropdown from "./StatusDropdown";
import InquiryTypeSelect from "./InquiryTypeSelect";
import MessageThread from "./MessageThread";
import MessageTimeline from "./MessageTimeline";
import InquirySummaryCard from "./InquirySummaryCard";
import ProductSection from "./ProductSection";
import DraftEditor from "./DraftEditor";
import ExternalLink from "../ui/ExternalLink";
import Spinner from "../ui/Spinner";
import ErrorState from "../ui/ErrorState";
import { useState, useEffect } from "react";
import ListingOptimization from "./ListingOptimization";
import MainImageOptimization from "./MainImageOptimization";

interface InquiryDetailProps {
  inquiry: InquiryDetail | null;
  inquiryId: number | null;
  isLoading: boolean;
  error: string | null;
  // Status
  isUpdatingStatus: boolean;
  onStatusChange: (statusKey: string) => void;
  isUpdatingInquiryType: boolean;
  onInquiryTypeChange: (inquiryTypeKey: string) => void;
  // Product
  isLinkingProduct: boolean;
  isUnlinkingProduct: boolean;
  onLinkProduct: (productVariantId: string) => void;
  onUnlinkProduct: (linkId: number) => void;
  linkError: string | null;
  mutationsEnabled: boolean;
  // Units
  isSavingUnits: boolean;
  onUnitsChange: (units: number) => void;
  isSavingInquiryContent: boolean;
  inquiryContentError: string | null;
  onSaveInquiryContent: (content: string) => Promise<boolean>;
  // Draft
  draft: string;
  promptVersion: number;
  isSaving: boolean;
  isCopywriting: boolean;
  saveError: string | null;
  copywriteError: string | null;
  onDraftChange: (text: string) => void;
  onSaveDraft: () => void;
  onCopywrite: () => void;
  onSent: (result: { followUpDueDate?: string; followUpState?: string; followUpDateSource?: string }) => void;
  messageRefreshKey: number;
  onOpenPromptEditor: () => void;
  onRetry: () => void;
  templates: MessageTemplate[];
}

export default function InquiryDetail({
  inquiry,
  inquiryId,
  isLoading,
  error,
  isUpdatingStatus,
  onStatusChange,
  isUpdatingInquiryType,
  onInquiryTypeChange,
  isLinkingProduct,
  isUnlinkingProduct,
  onLinkProduct,
  onUnlinkProduct,
  linkError,
  mutationsEnabled,
  isSavingUnits,
  onUnitsChange,
  isSavingInquiryContent,
  inquiryContentError,
  onSaveInquiryContent,
  draft,
  promptVersion,
  isSaving,
  isCopywriting,
  saveError,
  copywriteError,
  onDraftChange,
  onSaveDraft,
  onCopywrite,
  onSent,
  messageRefreshKey,
  onOpenPromptEditor,
  onRetry,
  templates,
}: InquiryDetailProps) {
  const [activeOptimization, setActiveOptimization] = useState<
    "copy" | "image" | null
  >(null);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!inquiry) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-gray-400">
          Select an inquiry to view details
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-5 p-5">
        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {inquiry.customerNickname || "No name"}
              </h2>
              <p className="text-xs text-gray-500">
                {formatDate(inquiry.inquiryDate)}
                {inquiry.inquiryType && (
                  <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                    {inquiry.inquiryType.label}
                  </span>
                )}
              </p>
            </div>
            <StatusDropdown
              currentStatus={inquiry.status}
              isSaving={isUpdatingStatus}
              onChange={onStatusChange}
            />
          </div>
          {inquiry.url && (
            <ExternalLink href={inquiry.url} label="Open in Mercari" />
          )}
          <InquiryTypeSelect
            currentType={inquiry.inquiryType}
            isSaving={isUpdatingInquiryType}
            disabled={!mutationsEnabled}
            onChange={onInquiryTypeChange}
          />
        </div>

        {/* Messages */}
        <MessageThread
          inquiryBody={inquiry.inquiryBody}
          mutationsEnabled={mutationsEnabled}
          isSaving={isSavingInquiryContent}
          saveError={inquiryContentError}
          onSave={onSaveInquiryContent}
        />
        <details className="rounded-lg border border-gray-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-700">
            Message timeline
          </summary>
          <div className="border-t border-gray-100 p-3">
            <MessageTimeline inquiryId={inquiry.id} refreshKey={messageRefreshKey} />
          </div>
        </details>

        {/* Inquiry Summary */}
        <InquirySummaryCard inquiry={inquiry} />

        {/* Linked Product */}
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-700">
            Linked Product
          </h3>
          <ProductSection
            linkedProducts={inquiry.linkedProducts}
            isLinking={isLinkingProduct}
            isUnlinking={isUnlinkingProduct}
            onLink={onLinkProduct}
            onUnlink={onUnlinkProduct}
            linkError={linkError}
            mutationsEnabled={mutationsEnabled}
            shopKey={inquiry.shopKey}
          />
        </div>

        {/* Pricing Details */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-700">
            Pricing Details
          </h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <ReadOnlyField
              label="Effective PRICE (excl. shipping)"
              value={formatPrice(inquiry.effectivePriceExclShipping)}
            />
            <ReadOnlyField
              label="Effective Price (incl. shipping)"
              value={formatPrice(inquiry.effectivePriceInclShipping)}
            />
            <ReadOnlyField
              label="Effective TCOGS"
              value={formatPrice(inquiry.effectiveTCOGS)}
            />
            <UnitsField
              value={inquiry.units}
              isSaving={isSavingUnits}
              onChange={onUnitsChange}
            />
            <ReadOnlyField
              label="Expected Value"
              value={formatPrice(inquiry.expectedValue)}
            />
          </div>
        </div>

        {/* Load the larger optimization workspaces only when an operator asks for one. */}
        <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
          <button
            type="button"
            aria-expanded={activeOptimization === "copy"}
            onClick={() =>
              setActiveOptimization((current) =>
                current === "copy" ? null : "copy",
              )
            }
            className={`rounded-md border px-3 py-2 text-xs font-medium ${activeOptimization === "copy" ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
          >
            Copywriting Optimization
          </button>
          <button
            type="button"
            aria-expanded={activeOptimization === "image"}
            onClick={() =>
              setActiveOptimization((current) =>
                current === "image" ? null : "image",
              )
            }
            className={`rounded-md border px-3 py-2 text-xs font-medium ${activeOptimization === "image" ? "border-violet-600 bg-violet-50 text-violet-700" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
          >
            Main Image Optimization
          </button>
        </div>

        {activeOptimization === "copy" && (
          <ListingOptimization
            inquiryId={inquiry.id}
            mutationsEnabled={mutationsEnabled}
          />
        )}

        {activeOptimization === "image" && (
          <MainImageOptimization
            inquiryId={inquiry.id}
            mutationsEnabled={mutationsEnabled}
          />
        )}

        {/* Draft Editor */}
        <DraftEditor
          inquiryId={inquiryId}
          draft={draft}
          promptVersion={promptVersion}
          isSaving={isSaving}
          isCopywriting={isCopywriting}
          saveError={saveError}
          copywriteError={copywriteError}
          templates={templates}
          onDraftChange={onDraftChange}
          onSave={onSaveDraft}
          onCopywrite={onCopywrite}
          onSent={onSent}
          onOpenPromptEditor={onOpenPromptEditor}
          followUpState={inquiry.followUpState}
          followUpDueDate={inquiry.followUpDueDate}
          followUpDateSource={inquiry.followUpDateSource}
        />
      </div>
    </div>
  );
}

/** Read-only field for displaying a label + value */
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-400">{label}</span>
      <p className="font-medium text-gray-700">{value}</p>
    </div>
  );
}

/** Editable units field with save-on-blur and save-on-Enter */
function UnitsField({
  value,
  isSaving,
  onChange,
}: {
  value: number | null;
  isSaving: boolean;
  onChange: (units: number) => void;
}) {
  const [draft, setDraft] = useState(String(value ?? 1));

  // Sync draft when value changes externally (inquiry switch, save revert)
  useEffect(() => {
    setDraft(String(value ?? 1));
  }, [value]);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    const num = Number(trimmed);
    if (isNaN(num) || num < 0) return;
    if (num === (value ?? 1)) return; // no change
    onChange(num);
  };

  return (
    <div>
      <span className="text-gray-400">Units</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          step="1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          disabled={isSaving}
          className="w-20 rounded border border-gray-300 px-2 py-1 text-sm font-medium text-gray-700
            focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
            disabled:opacity-50"
        />
        {isSaving && <span className="text-[10px] text-gray-400">Saving…</span>}
      </div>
    </div>
  );
}
