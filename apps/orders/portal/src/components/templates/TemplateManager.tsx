import { useState } from "react";
import {
  useTemplatesQuery,
  useTemplateCreateMutation,
  useTemplateUpdateMutation,
  useTemplateDeleteMutation,
  useTemplateReorderMutation,
} from "@/hooks/useTemplates";
import type { Template } from "@/types/orders";
import { Spinner } from "@/components/shared/Spinner";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TemplateManager({ open, onClose }: Props) {
  const { data, isLoading } = useTemplatesQuery();
  const createMutation = useTemplateCreateMutation();
  const updateMutation = useTemplateUpdateMutation();
  const deleteMutation = useTemplateDeleteMutation();
  const reorderMutation = useTemplateReorderMutation();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  const templates = data?.templates || [];

  if (!open) return null;

  const handleCreate = async () => {
    if (!title.trim() || !body.trim()) return;
    setFeedback(null);
    try {
      await createMutation.mutateAsync({ title: title.trim(), body: body.trim() });
      setTitle("");
      setBody("");
      setFeedback({ msg: "Template created", ok: true });
    } catch (e) {
      setFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      await updateMutation.mutateAsync({ id, title: editTitle.trim(), body: editBody.trim() });
      setEditingId(null);
      setFeedback({ msg: "Template updated", ok: true });
    } catch (e) {
      setFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      setFeedback({ msg: "Template deleted", ok: true });
    } catch (e) {
      setFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  const handleReorder = async (id: string, direction: "up" | "down") => {
    try {
      await reorderMutation.mutateAsync({ id, direction });
    } catch { /* ignore */ }
  };

  const startEdit = (t: Template) => {
    setEditingId(t.id);
    setEditTitle(t.title);
    setEditBody(t.body);
  };

  return (
    <div className="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold">Message Templates</h2>
          <button onClick={onClose} className="text-gray-500 text-xl leading-none hover:text-gray-800">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* Create form */}
          <div className="flex flex-col gap-2 mb-4 p-3 bg-gray-50 rounded">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Template title"
              className="px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-[#1565c0]"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Template body"
              className="px-2 py-2 border border-gray-300 rounded text-sm resize-y min-h-[48px] focus:outline-none focus:border-[#1565c0]"
            />
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || !title.trim() || !body.trim()}
              className="self-start px-4 py-1.5 bg-[#1565c0] text-white border-none rounded text-sm hover:opacity-90 disabled:opacity-50"
            >
              Add Template
            </button>
          </div>

          {feedback && (
            <div className={`text-xs mb-3 ${feedback.ok ? "text-[#388e3c]" : "text-[#d32f2f]"}`}>
              {feedback.msg}
            </div>
          )}

          {/* Template list */}
          {isLoading ? (
            <div className="text-center py-4"><Spinner /></div>
          ) : templates.length === 0 ? (
            <div className="text-center py-5 text-gray-400 text-sm italic">No templates yet.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {[...templates].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((t) => (
                <div key={t.id} className="px-2.5 py-2 bg-gray-50 rounded text-sm">
                  {editingId === t.id ? (
                    <div className="flex flex-col gap-1">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
                      />
                      <textarea
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs resize-y min-h-[40px] focus:outline-none focus:border-[#1565c0]"
                      />
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => handleUpdate(t.id)} className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs">Save</button>
                        <button onClick={() => setEditingId(null)} className="px-3 py-1 bg-white border border-gray-300 rounded text-xs text-gray-500">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold text-xs">{t.title}</span>
                        <div className="flex gap-1">
                          <button onClick={() => handleReorder(t.id, "up")} disabled={t.sort_order <= 0} className="px-1.5 py-0.5 text-[11px] border border-gray-300 rounded bg-white text-gray-500 hover:bg-gray-100 disabled:opacity-30">↑</button>
                          <button onClick={() => handleReorder(t.id, "down")} className="px-1.5 py-0.5 text-[11px] border border-gray-300 rounded bg-white text-gray-500 hover:bg-gray-100">↓</button>
                          <button onClick={() => startEdit(t)} className="px-1.5 py-0.5 text-[11px] border border-gray-300 rounded bg-white text-gray-500 hover:bg-gray-100">Edit</button>
                          <button onClick={() => handleDelete(t.id)} className="px-1.5 py-0.5 text-[11px] border border-[#d32f2f] rounded bg-white text-[#d32f2f] hover:bg-[#ffebee]">Del</button>
                        </div>
                      </div>
                      <div className="text-gray-500 text-xs whitespace-nowrap overflow-hidden text-ellipsis">
                        {t.body}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
