import { useState, useEffect, useCallback } from "react";
import { usePrompt } from "../../hooks/usePrompt";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";

interface PromptEditorProps {
  open: boolean;
  onClose: () => void;
  /** Called when prompt version changes, so DraftEditor can update its display */
  onVersionChange?: (version: number) => void;
}

export default function PromptEditor({ open, onClose, onVersionChange }: PromptEditorProps) {
  const { promptVersion, versions, isLoading, error, fetch, save } = usePrompt();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Load prompt data when modal opens
  useEffect(() => {
    if (open) {
      fetch();
      setEditing(false);
      setSaveError(null);
      setShowHistory(false);
    }
  }, [open, fetch]);

  const activePrompt = versions.find((v) => v.active);
  const displayText = activePrompt?.text || "";

  const handleStartEdit = useCallback(() => {
    setEditText(displayText);
    setEditing(true);
    setSaveError(null);
  }, [displayText]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setEditText("");
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editText.trim()) return;
    setSaving(true);
    setSaveError(null);
    const newVersion = await save(editText);
    setSaving(false);
    if (newVersion !== null) {
      setEditing(false);
      onVersionChange?.(newVersion);
    } else {
      setSaveError("Failed to save. Check the console for details.");
    }
  }, [editText, save, onVersionChange]);

  const versionLabel = promptVersion > 0 ? `v${promptVersion}` : "default";

  return (
    <Modal open={open} onClose={onClose} title={`Copywrite Prompt — ${versionLabel}`}>
      <div className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner size="sm" />
            Loading prompt...
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {!isLoading && !error && (
          <>
            {/* Prompt text area */}
            {editing ? (
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-600">Edit prompt text</label>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={12}
                  className="w-full resize-y rounded-md border border-gray-200 px-3 py-2 text-xs font-mono
                    placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400">
                  Use {"{nickname}"}, {"{inquiry}"}, {"{product}"}, etc. as placeholders — they will be replaced with actual data.
                </p>
                {saveError && (
                  <p className="text-xs text-red-600">{saveError}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !editText.trim()}>
                    {saving ? "Saving..." : "Save New Version"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleCancelEdit} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-600">Current prompt</label>
                  <Button variant="secondary" size="sm" onClick={handleStartEdit}>
                    Edit
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 max-h-64 overflow-y-auto">
                  {displayText || "No prompt configured. Using default."}
                </pre>
              </div>
            )}

            {/* Version history */}
            {versions.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform ${showHistory ? "rotate-90" : ""}`}
                  >
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  Version history ({versions.length})
                </button>

                {showHistory && (
                  <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                    {versions.map((v) => (
                      <div
                        key={v.version}
                        className={`rounded-md border px-3 py-2 text-xs ${
                          v.active
                            ? "border-green-200 bg-green-50"
                            : "border-gray-200 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-gray-700">
                            v{v.version}
                            {v.active && (
                              <span className="ml-2 text-green-600 font-normal">active</span>
                            )}
                          </span>
                          <span className="text-gray-400">{v.createdAt || "—"}</span>
                        </div>
                        <p className="mt-1 text-gray-500 line-clamp-2 whitespace-pre-wrap">
                          {v.text.slice(0, 200)}
                          {v.text.length > 200 ? "..." : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {versions.length === 0 && !editing && (
              <p className="text-xs text-gray-400">
                No prompt versions saved yet. The system is using the built-in default.
                Click Edit to create your first version.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
