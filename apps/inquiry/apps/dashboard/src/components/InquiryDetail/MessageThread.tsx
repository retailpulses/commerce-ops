import { useEffect, useState } from "react";
import Button from "../ui/Button";

interface MessageThreadProps {
  inquiryBody: string;
  mutationsEnabled: boolean;
  isSaving: boolean;
  saveError: string | null;
  onSave: (content: string) => Promise<boolean>;
}

export default function MessageThread({
  inquiryBody,
  mutationsEnabled,
  isSaving,
  saveError,
  onSave,
}: MessageThreadProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(inquiryBody);
  useEffect(() => setDraft(inquiryBody), [inquiryBody]);

  const save = async () => {
    if (await onSave(draft)) setEditing(false);
  };

  return (
    <section className="space-y-3" aria-label="Inquiry messages">
      <div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Inquiry content
          </span>
          {!editing && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!mutationsEnabled}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </div>
        {editing ? (
          <div className="mt-1 space-y-2">
            <textarea
              aria-label="Inquiry content"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={6}
              maxLength={50_000}
              className="w-full rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {saveError && <p className="text-xs text-red-600">{saveError}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={isSaving}
                onClick={() => {
                  setDraft(inquiryBody);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={isSaving || !draft.trim()}
                onClick={save}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-1 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="whitespace-pre-wrap text-sm text-gray-700">
              {inquiryBody || "--"}
            </p>
          </div>
        )}
      </div>

    </section>
  );
}
