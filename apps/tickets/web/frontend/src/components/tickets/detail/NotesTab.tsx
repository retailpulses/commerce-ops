import { useState } from "react";
import type { TicketNote } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { fmtDate } from "@/lib/utils";

interface NotesTabProps {
  notes: TicketNote[];
  onAddNote: (body: string) => Promise<void>;
  onUpdateNote: (noteId: string, body: string) => Promise<void>;
}

export function NotesTab({ notes, onAddNote, onUpdateNote }: NotesTabProps) {
  const [adding, setAdding] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  const handleUpdate = async () => {
    if (!editingId || !editBody.trim() || saving) return;
    setSaving(true);
    try {
      await onUpdateNote(editingId, editBody.trim());
      setEditingId(null);
      setEditBody("");
    } finally { setSaving(false); }
  };

  const handleSave = async () => {
    if (!draftBody.trim() || saving) return;
    setSaving(true);
    try {
      await onAddNote(draftBody.trim());
      setDraftBody("");
      setAdding(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftBody("");
    setAdding(false);
  };

  return (
    <div className="flex flex-col">
      {/* Existing notes */}
      {notes.length === 0 && !adding && (
        <p className="text-sm text-text-muted text-center py-8">
          No internal notes yet.
        </p>
      )}

      <div className="flex flex-col divide-y divide-border">
        {[...notes]
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          )
          .map((note) => (
            <div key={note.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-xs font-medium text-text-muted">
                  {note.created_by ?? "Unknown"}
                </span>
                <time className="text-xs text-text-muted shrink-0">
                  {fmtDate(note.created_at)}
                </time>
              </div>
              {editingId === note.id ? (
                <div className="flex flex-col gap-2">
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={3} autoFocus className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40" />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setEditingId(null); setEditBody(""); }}>Cancel</Button>
                    <Button variant="primary" size="sm" loading={saving} disabled={!editBody.trim()} onClick={handleUpdate}>Save changes</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-text whitespace-pre-wrap break-words">{note.body}</p>
                  <Button variant="ghost" size="sm" onClick={() => { setEditingId(note.id); setEditBody(note.body); }}>Edit</Button>
                </div>
              )}
            </div>
          ))}
      </div>

      {/* Add note area */}
      {adding ? (
        <div className="px-4 py-3 border-t border-border flex flex-col gap-2">
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder="Write an internal note..."
            rows={3}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-xs resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!draftBody.trim()}
              onClick={handleSave}
            >
              Save Note
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-3 border-t border-border">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAdding(true)}
          >
            + Add Note
          </Button>
        </div>
      )}
    </div>
  );
}
