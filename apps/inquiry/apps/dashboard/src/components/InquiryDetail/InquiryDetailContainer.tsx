import { useCallback, useEffect, useState } from "react";
import { useInquiry } from "../../hooks/useInquiry";
import { useDraft } from "../../hooks/useDraft";
import {
  updateStatus,
  updateInquiryType,
  linkProduct,
  unlinkProduct,
  updateUnits,
  updateInquiryContent,
  getMutationConfig,
} from "../../api/client";
import InquiryDetailView from "./InquiryDetail";
import PromptEditor from "../Settings/PromptEditor";
import type {
  InquiryDetail as InquiryDetailType,
  StatusInfo,
  InquiryTypeInfo,
  MessageTemplate,
} from "../../types/inquiry";
import {
  STATUS_RECEIVED,
  STATUS_FOLLOWED_UP,
  STATUS_ANSWERED,
  STATUS_CLOSED_WON,
  STATUS_CLOSED_LOSE,
  INQUIRY_TYPE_OPTIONS,
} from "../../utils/constants";

const STATUS_LABEL: Record<string, string> = {
  [STATUS_RECEIVED]: "Received",
  [STATUS_FOLLOWED_UP]: "Followed-up",
  [STATUS_ANSWERED]: "Answered",
  [STATUS_CLOSED_WON]: "Closed Won",
  [STATUS_CLOSED_LOSE]: "Closed Lose",
};

interface InquiryDetailContainerProps {
  inquiryId: number | null;
  templates: MessageTemplate[];
  onStatusChanged?: (id: number, newStatus: StatusInfo) => void;
  onInquiryTypeChanged?: (id: number, newType: InquiryTypeInfo) => void;
  onProductChanged?: (id: number) => void;
}

export default function InquiryDetailContainer({
  inquiryId,
  templates,
  onStatusChanged,
  onInquiryTypeChanged,
  onProductChanged,
}: InquiryDetailContainerProps) {
  const { inquiry, isLoading, error, updateInquiry, refetch } =
    useInquiry(inquiryId);
  const {
    draft,
    promptVersion,
    isSaving,
    isCopywriting,
    saveError,
    copywriteError,
    setDraft,
    save,
    copywrite,
  } = useDraft(
    inquiryId,
    inquiry?.draftReply ?? "",
  );

  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isUpdatingInquiryType, setIsUpdatingInquiryType] = useState(false);
  const [isLinkingProduct, setIsLinkingProduct] = useState(false);
  const [isUnlinkingProduct, setIsUnlinkingProduct] = useState(false);
  const [isSavingUnits, setIsSavingUnits] = useState(false);
  const [isSavingInquiryContent, setIsSavingInquiryContent] = useState(false);
  const [inquiryContentError, setInquiryContentError] = useState<string | null>(
    null,
  );
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [messageRefreshKey, setMessageRefreshKey] = useState(0);
  // The server is the authoritative kill switch. Keep controls usable while
  // config loads (or if that non-critical request fails); mutation endpoints
  // still enforce the flag and return 503 when deliberately disabled.
  const [mutationsEnabled, setMutationsEnabled] = useState(true);

  // Fetch mutation config on mount
  useEffect(() => {
    getMutationConfig()
      .then((cfg) => setMutationsEnabled(cfg.mutationsEnabled))
      .catch((error) => {
        console.error("Unable to load dashboard mutation config", error);
      });
  }, []);

  const handleStatusChange = useCallback(
    async (statusKey: string) => {
      if (inquiryId === null) return;

      // Optimistic update
      const prevStatus = inquiry?.status;
      updateInquiry({
        status: {
          id: statusKey,
          label: STATUS_LABEL[statusKey] || statusKey,
        },
      });

      setIsUpdatingStatus(true);
      try {
        const result = await updateStatus(inquiryId, statusKey);
        updateInquiry({ status: result.status });
        onStatusChanged?.(inquiryId, result.status);
      } catch {
        // Revert on failure
        if (prevStatus) updateInquiry({ status: prevStatus });
      } finally {
        setIsUpdatingStatus(false);
      }
    },
    [inquiryId, inquiry, updateInquiry, onStatusChanged],
  );

  const handleLinkProduct = useCallback(
    async (productVariantId: string) => {
      if (inquiryId === null) return;
      setLinkError(null);
      setIsLinkingProduct(true);
      try {
        await linkProduct(inquiryId, productVariantId);
        onProductChanged?.(inquiryId);
        refetch();
      } catch (err) {
        setLinkError(
          err instanceof Error ? err.message : "Failed to link product",
        );
      } finally {
        setIsLinkingProduct(false);
      }
    },
    [inquiryId, refetch, onProductChanged],
  );

  const handleInquiryTypeChange = useCallback(
    async (inquiryTypeKey: string) => {
      if (inquiryId === null) return;
      const previousType = inquiry?.inquiryType ?? null;
      const option = INQUIRY_TYPE_OPTIONS.find(
        (item) => item.id === inquiryTypeKey,
      );
      if (!option || option.id === "_all") return;

      updateInquiry({ inquiryType: { id: option.id, label: option.label } });
      setIsUpdatingInquiryType(true);
      try {
        const result = await updateInquiryType(inquiryId, inquiryTypeKey);
        updateInquiry({ inquiryType: result.inquiryType });
        onInquiryTypeChanged?.(inquiryId, result.inquiryType);
      } catch {
        updateInquiry({ inquiryType: previousType });
      } finally {
        setIsUpdatingInquiryType(false);
      }
    },
    [inquiryId, inquiry, updateInquiry, onInquiryTypeChanged],
  );

  const handleUnlinkProduct = useCallback(
    async (linkId: number) => {
      if (inquiryId === null) return;
      setLinkError(null);
      setIsUnlinkingProduct(true);
      try {
        await unlinkProduct(inquiryId, linkId);
        onProductChanged?.(inquiryId);
        refetch();
      } catch (err) {
        setLinkError(
          err instanceof Error ? err.message : "Failed to remove product",
        );
      } finally {
        setIsUnlinkingProduct(false);
      }
    },
    [inquiryId, refetch, onProductChanged],
  );

  const handleUnitsChange = useCallback(
    async (units: number) => {
      if (inquiryId === null) return;

      // Optimistic update
      const prevUnits = inquiry?.units;
      updateInquiry({ units });

      setIsSavingUnits(true);
      try {
        const result = await updateUnits(inquiryId, units);
        // Update Expected Value from server-side computation
        updateInquiry({ expectedValue: result.expectedValue });
      } catch {
        // Revert on failure
        if (prevUnits !== undefined) updateInquiry({ units: prevUnits });
      } finally {
        setIsSavingUnits(false);
      }
    },
    [inquiryId, inquiry, updateInquiry],
  );

  const handleSaveInquiryContent = useCallback(
    async (content: string) => {
      if (inquiryId === null) return false;
      setInquiryContentError(null);
      setIsSavingInquiryContent(true);
      try {
        const result = await updateInquiryContent(inquiryId, content);
        updateInquiry({ inquiryBody: result.content });
        return true;
      } catch (err) {
        setInquiryContentError(
          err instanceof Error ? err.message : "Failed to save inquiry content",
        );
        return false;
      } finally {
        setIsSavingInquiryContent(false);
      }
    },
    [inquiryId, updateInquiry],
  );

  const handleSent = useCallback(
    (result: { followUpDueDate?: string; followUpState?: string; followUpDateSource?: string }) => {
      updateInquiry({
        followUpDueDate: result.followUpDueDate ?? inquiry?.followUpDueDate ?? null,
        followUpState: result.followUpState ?? "scheduled",
        followUpDateSource: result.followUpDateSource ?? inquiry?.followUpDateSource ?? null,
      });
      setMessageRefreshKey((key) => key + 1);
      refetch();
    },
    [inquiry, refetch, updateInquiry],
  );

  return (
    <>
      <InquiryDetailView
        key={inquiryId ?? "empty"}
        inquiry={inquiry}
        inquiryId={inquiryId}
        isLoading={isLoading}
        error={error}
        isUpdatingStatus={isUpdatingStatus}
        onStatusChange={handleStatusChange}
        isUpdatingInquiryType={isUpdatingInquiryType}
        onInquiryTypeChange={handleInquiryTypeChange}
        isLinkingProduct={isLinkingProduct}
        isUnlinkingProduct={isUnlinkingProduct}
        onLinkProduct={handleLinkProduct}
        onUnlinkProduct={handleUnlinkProduct}
        linkError={linkError}
        mutationsEnabled={mutationsEnabled}
        isSavingUnits={isSavingUnits}
        onUnitsChange={handleUnitsChange}
        isSavingInquiryContent={isSavingInquiryContent}
        inquiryContentError={inquiryContentError}
        onSaveInquiryContent={handleSaveInquiryContent}
        draft={draft}
        promptVersion={promptVersion}
        isSaving={isSaving}
        isCopywriting={isCopywriting}
        saveError={saveError}
        copywriteError={copywriteError}
        onDraftChange={setDraft}
        onSaveDraft={save}
        onCopywrite={copywrite}
        onSent={handleSent}
        messageRefreshKey={messageRefreshKey}
        onOpenPromptEditor={() => setPromptEditorOpen(true)}
        onRetry={refetch}
        templates={templates}
      />

      <PromptEditor
        open={promptEditorOpen}
        onClose={() => setPromptEditorOpen(false)}
      />
    </>
  );
}
