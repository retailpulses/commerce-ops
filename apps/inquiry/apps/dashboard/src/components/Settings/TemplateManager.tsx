import { useState, useEffect, useCallback } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import type { MessageTemplate } from "../../types/inquiry";

interface TemplateManagerProps {
  open: boolean;
  onClose: () => void;
  templates: MessageTemplate[];
  isLoading: boolean;
  error: string | null;
  onCreate: (title: string, body: string) => Promise<MessageTemplate | null>;
  onUpdate: (id: string, title: string, body: string) => Promise<MessageTemplate | null>;
  onDelete: (id: string) => Promise<boolean>;
  onRefresh: () => void;
}

export default function TemplateManager({
  open,
  onClose,
  templates,
  isLoading,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onRefresh,
}: TemplateManagerProps) {
  // Create form state
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Edit state: template ID being edited, or null
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      onRefresh();
      setNewTitle("");
      setNewBody("");
      setEditingId(null);
      setFeedback(null);
    }
  }, [open, onRefresh]);

  const clearFeedback = useCallback(() => {
    setFeedback(null);
  }, []);

  const handleCreate = useCallback(async () => {
    clearFeedback();
    if (!newTitle.trim() || !newBody.trim()) {
      setFeedback({ type: "error", text: "Title and body are required" });
      return;
    }
    const result = await onCreate(newTitle, newBody);
    if (result) {
      setNewTitle("");
      setNewBody("");
      setFeedback({ type: "success", text: "Template created" });
    } else {
      setFeedback({ type: "error", text: "Failed to create template" });
    }
  }, [newTitle, newBody, onCreate, clearFeedback]);

  const handleStartEdit = useCallback((id: string) => {
    const t = templates.find((tmpl) => tmpl.id === id);
    if (t) {
      setEditingId(id);
      setEditTitle(t.title);
      setEditBody(t.body);
      setFeedback(null);
    }
  }, [templates]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditTitle("");
    setEditBody("");
    setFeedback(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (editingId === null) return;
    clearFeedback();
    if (!editTitle.trim() || !editBody.trim()) {
      setFeedback({ type: "error", text: "Title and body are required" });
      return;
    }
    const result = await onUpdate(editingId, editTitle, editBody);
    if (result) {
      setEditingId(null);
      setFeedback({ type: "success", text: "Template updated" });
    } else {
      setFeedback({ type: "error", text: "Failed to update template" });
    }
  }, [editingId, editTitle, editBody, onUpdate, clearFeedback]);

  const handleDelete = useCallback(async (id: string) => {
    clearFeedback();
    if (!window.confirm("Delete this template?")) return;
    const ok = await onDelete(id);
    if (!ok) {
      setFeedback({ type: "error", text: "Failed to delete template" });
    }
  }, [onDelete, clearFeedback]);

  return (
    <Modal open={open} onClose={onClose} title="Message Templates">
      <div className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner size="sm" />
            Loading templates...
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Create form */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Template name"
              maxLength={100}
              value={newTitle}
              onChange={(e) => {
                setNewTitle(e.target.value);
                clearFeedback();
              }}
              className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-sm
                placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <Button variant="primary" size="sm" onClick={handleCreate}>
              Add
            </Button>
          </div>
          <textarea
            placeholder="Template message body"
            maxLength={1000}
            rows={2}
            value={newBody}
            onChange={(e) => {
              setNewBody(e.target.value);
              clearFeedback();
            }}
            className="w-full resize-y rounded-md border border-gray-200 px-2 py-1.5 text-sm
              placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {feedback && (
            <p className={`text-xs ${feedback.type === "error" ? "text-red-600" : "text-green-600"}`}>
              {feedback.text}
            </p>
          )}
        </div>

        {/* Template list */}
        {!isLoading && templates.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">
            No templates yet. Create one above.
          </p>
        )}

        {templates.length > 0 && (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`rounded-lg border p-3 ${
                  editingId === t.id
                    ? "border-blue-300 bg-blue-50"
                    : "border-gray-200 bg-white"
                }`}
              >
                {editingId === t.id ? (
                  /* Inline edit mode */
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => {
                        setEditTitle(e.target.value);
                        clearFeedback();
                      }}
                      maxLength={100}
                      className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm
                        focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <textarea
                      value={editBody}
                      onChange={(e) => {
                        setEditBody(e.target.value);
                        clearFeedback();
                      }}
                      maxLength={1000}
                      rows={3}
                      className="w-full resize-y rounded-md border border-gray-200 px-2 py-1.5 text-sm
                        focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="sm" onClick={handleSaveEdit}>
                        Save
                      </Button>
                      <Button variant="secondary" size="sm" onClick={handleCancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* View mode */
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {t.title}
                      </span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handleStartEdit(t.id)}
                          className="text-xs text-gray-400 hover:text-gray-600 transition-colors px-1"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(t.id)}
                          className="text-xs text-red-400 hover:text-red-600 transition-colors px-1"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap line-clamp-3">
                      {t.body}
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
