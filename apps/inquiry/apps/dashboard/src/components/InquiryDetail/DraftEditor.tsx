import { useCallback, useEffect, useRef, useState } from "react";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import Spinner from "../ui/Spinner";
import type { MessageTemplate } from "../../types/inquiry";
import { sendReply } from "../../api/client";
import { buildSendPayload, captureReviewMessage } from "./draftWorkflow";

interface DraftEditorProps {
  inquiryId: number | null;
  draft: string;
  promptVersion: number;
  isSaving: boolean;
  isCopywriting: boolean;
  saveError: string | null;
  copywriteError: string | null;
  templates: MessageTemplate[];
  followUpState: string | null;
  followUpDueDate: string | null;
  followUpDateSource: string | null;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onCopywrite: () => void;
  onSent: (result: {
    followUpDueDate?: string;
    followUpState?: string;
    followUpDateSource?: string;
  }) => void;
  onOpenPromptEditor: () => void;
}

export default function DraftEditor({
  inquiryId, draft, promptVersion, isSaving, isCopywriting, saveError,
  copywriteError, templates, followUpState,
  followUpDueDate: persistedFollowUpDueDate, followUpDateSource,
  onDraftChange, onSave, onCopywrite, onSent, onOpenPromptEditor,
}: DraftEditorProps) {
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const templateSelectRef = useRef<HTMLSelectElement>(null);
  const [followUpDueDate, setFollowUpDueDate] = useState("");
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  const handleChange = useCallback((value: string) => {
    onDraftChange(value);
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(onSave, 2000);
  }, [onDraftChange, onSave]);

  useEffect(() => {
    setSendState("idle");
    setSendError(null);
    setFollowUpDueDate("");
    setReviewMessage(null);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [inquiryId]);

  const openReview = useCallback(() => {
    const message = captureReviewMessage(draft);
    if (message) setReviewMessage(message);
  }, [draft]);

  const handleSend = useCallback(async () => {
    if (!inquiryId || !reviewMessage || sendState === "sending") return;
    setSendState("sending");
    setSendError(null);
    try {
      const result = await sendReply(
        inquiryId,
        buildSendPayload(reviewMessage, followUpDueDate),
      );
      setSendState("sent");
      onSent(result);
      setReviewMessage(null);
    } catch (error) {
      setSendState("error");
      setSendError(error instanceof Error ? error.message : "Send failed");
    }
  }, [followUpDueDate, inquiryId, onSent, reviewMessage, sendState]);

  return (
    <>
    <div className="notranslate space-y-3" translate="no">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Your Draft Reply</h3>
        <div className="flex items-center gap-2">
          {isSaving && <span className="text-xs text-gray-400">Saving...</span>}
          <Button variant="secondary" size="sm" onClick={onSave} disabled={isSaving || !draft.trim()}>Save</Button>
        </div>
      </div>
      {saveError && <p className="text-xs text-red-600">{saveError}</p>}

      {templates.length > 0 && (
        <select ref={templateSelectRef} defaultValue="" onChange={(event) => {
          const template = templates.find((item) => item.id === event.target.value);
          if (template) onDraftChange(draft ? `${draft}\n${template.body}` : template.body);
          if (templateSelectRef.current) templateSelectRef.current.value = "";
        }} className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm text-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
          <option value="">— Insert Template —</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
        </select>
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onCopywrite} disabled={isCopywriting || !draft.trim()}>
          {isCopywriting ? <><Spinner size="sm" />Copywriting...</> : "Copywrite"}
        </Button>
        <span className="text-xs text-gray-400">Prompt v{promptVersion || "—"}</span>
        <button type="button" onClick={onOpenPromptEditor} className="text-gray-400 transition-colors hover:text-gray-600" title="Edit copywrite prompt" aria-label="Edit copywrite prompt">⚙</button>
      </div>

      {copywriteError && <div className="rounded-md border border-red-200 bg-red-50 p-3"><p className="text-sm text-red-600">{copywriteError}</p></div>}

      <textarea value={draft} onChange={(event) => handleChange(event.target.value)} placeholder="Type your draft reply in Japanese..." rows={6} className="w-full resize-y rounded-md border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />

      {persistedFollowUpDueDate && (
        <p className="text-xs text-gray-600">
          Follow-up: <span className="font-medium">{persistedFollowUpDueDate}</span>
          {followUpState ? ` · ${followUpState}` : ""}{followUpDateSource ? ` · ${followUpDateSource}` : ""}
        </p>
      )}

      <div className="flex justify-end">
        <Button variant="primary" onClick={openReview} disabled={!inquiryId || !draft.trim() || sendState === "sending"}>Review &amp; Send</Button>
      </div>
    </div>
      <Modal open={reviewMessage !== null} onClose={() => sendState !== "sending" && setReviewMessage(null)} title="Review reply">
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-sm text-gray-500">Message preview</p>
            <div className="max-h-72 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-3">
              <p className="whitespace-pre-wrap text-sm text-gray-700" lang="ja" translate="yes">{reviewMessage}</p>
            </div>
            <p className="mt-1 text-xs text-gray-500">Use browser translation to review. The original Japanese text will be sent.</p>
          </div>
          <label className="block text-xs text-gray-600">
            Follow-up date override (optional)
            <input type="date" value={followUpDueDate} onChange={(event) => setFollowUpDueDate(event.target.value)} className="mt-1 block rounded border border-gray-300 bg-white px-2 py-1.5" />
          </label>
          <p className="text-xs text-gray-500">If blank, follow-up is scheduled three JST calendar days after confirmed delivery.</p>
          {sendError && <p className="text-xs text-red-600">{sendError}</p>}
          <div className="notranslate flex justify-end gap-2" translate="no">
            <Button variant="secondary" onClick={() => setReviewMessage(null)} disabled={sendState === "sending"}>Back to edit</Button>
            <Button variant="primary" onClick={handleSend} disabled={sendState === "sending"}>{sendState === "sending" ? "Sending…" : "Send to Mercari"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
