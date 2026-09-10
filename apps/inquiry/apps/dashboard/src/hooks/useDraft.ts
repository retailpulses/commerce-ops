import { useState, useCallback, useEffect, useRef } from "react";
import { saveDraft, copywriteDraft } from "../api/client";

/**
 * Manages draft reply and copywriting state for a single inquiry.
 * Resets all local state when inquiryId changes, and guards against
 * stale async responses from the previous inquiry.
 */
export function useDraft(
  inquiryId: number | null,
  initialDraft: string = "",
) {
  const [draft, setDraft] = useState(initialDraft);
  const [promptVersion, setPromptVersion] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopywriting, setIsCopywriting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copywriteError, setCopywriteError] = useState<string | null>(null);

  // Incremented on inquiry switch — used to discard stale async responses
  const versionRef = useRef(0);

  // Track whether the user has made local edits since the last inquiry switch.
  // Prevents the inquiry data load from overwriting text the user typed in the
  // brief window before the fetch completes.
  const hasEditedRef = useRef(false);

  // Cache the initial values so the inquiry-switch useEffect only depends on
  // inquiryId, but reads the latest initialDraft/initialCopywriteResult at
  // effect time (which may still be stale — the real sync happens in the
  // initialDraft effect below once the inquiry fetch completes).
  const initialDraftRef = useRef(initialDraft);
  initialDraftRef.current = initialDraft;

  // Reset all state when inquiryId changes
  useEffect(() => {
    setDraft(initialDraftRef.current);
    setPromptVersion(0);
    setSaveError(null);
    setCopywriteError(null);
    setIsSaving(false);
    setIsCopywriting(false);
    versionRef.current += 1;
    hasEditedRef.current = false;
  }, [inquiryId]);

  // Sync draft when the inquiry data actually loads (initialDraft changes).
  // The inquiry-switch effect above may set the draft to a stale value because
  // at the time inquiryId changes, the inquiry state still holds the *previous*
  // inquiry's data. This effect corrects it once the fetch completes — but
  // only if the user hasn't typed anything in the meantime.
  useEffect(() => {
    if (!hasEditedRef.current) {
      setDraft(initialDraft);
    }
  }, [initialDraft]);

  const setDraftText = useCallback((text: string) => {
    setDraft(text);
    setSaveError(null);
    hasEditedRef.current = true;
  }, []);

  const save = useCallback(async () => {
    if (inquiryId === null || !draft.trim()) return;
    const version = versionRef.current;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveDraft(inquiryId, draft);
    } catch (err) {
      if (versionRef.current !== version) return;
      setSaveError(err instanceof Error ? err.message : "Failed to save draft");
    } finally {
      if (versionRef.current === version) setIsSaving(false);
    }
  }, [inquiryId, draft]);

  const copywrite = useCallback(async () => {
    if (inquiryId === null || !draft.trim()) return;
    const version = versionRef.current;
    setIsCopywriting(true);
    setCopywriteError(null);
    try {
      const { result, promptVersion: pv } = await copywriteDraft(inquiryId, draft);
      if (versionRef.current !== version) return;
      setDraft(result);
      hasEditedRef.current = true;
      setPromptVersion(pv || 0);
    } catch (err) {
      if (versionRef.current !== version) return;
      setCopywriteError(err instanceof Error ? err.message : "Copywrite failed");
    } finally {
      if (versionRef.current === version) setIsCopywriting(false);
    }
  }, [inquiryId, draft]);

  return {
    draft,
    promptVersion,
    isSaving,
    isCopywriting,
    saveError,
    copywriteError,
    setDraft: setDraftText,
    save,
    copywrite,
  };
}
