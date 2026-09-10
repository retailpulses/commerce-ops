import { useState } from "react";
import type { Ticket, IssueType, CustomerSubmission } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { IssueTypeBadge } from "@/components/ui/IssueTypeBadge";
import { fmtDate } from "@/lib/utils";
import { IssueTypeEditor } from "./IssueTypeEditor";

interface DescriptionTabProps {
  ticket: Ticket;
  issueTypes: IssueType[];
  onDescriptionChange: (description: string) => Promise<void>;
  onIssueTypesChange: (types: string[]) => void;
  customerSubmissions?: CustomerSubmission[];
}

export function DescriptionTab({
  ticket,
  issueTypes,
  onDescriptionChange,
  onIssueTypesChange,
  customerSubmissions = [],
}: DescriptionTabProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ticket.description ?? "");
  const [saving, setSaving] = useState(false);
  const [issueEditorOpen, setIssueEditorOpen] = useState(false);

  const selectedIssueTypeLabels = ticket.issue_types
    .map((key) => issueTypes.find((it) => it.key === key))
    .filter((it): it is IssueType => it !== undefined)
    .map((it) => it.display_name);

  const handleStartEdit = () => {
    setDraft(ticket.description ?? "");
    setEditing(true);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onDescriptionChange(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(ticket.description ?? "");
    setEditing(false);
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {/* Issue type badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {selectedIssueTypeLabels.length > 0 ? (
          selectedIssueTypeLabels.map((label) => (
            <IssueTypeBadge key={label} label={label} />
          ))
        ) : (
          <span className="text-xs text-text-muted">No issue types</span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIssueEditorOpen(true)}
        >
          Edit Types
        </Button>
      </div>

      {/* Description */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text">Description</span>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={handleStartEdit}>
              Edit
            </Button>
          )}
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-xs resize-vertical focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                onClick={handleSave}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="text-sm text-text whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-3 py-2 min-h-[60px] cursor-pointer hover:border-accent/50 transition-colors"
            onClick={handleStartEdit}
          >
            {ticket.description || (
              <span className="text-text-muted italic">
                No description. Click to add one.
              </span>
            )}
          </div>
        )}
      </div>

      {customerSubmissions.length > 0 && (
        <section className="flex flex-col gap-3 border-t border-border pt-3">
          <div>
            <h3 className="text-sm font-semibold text-text">Customer Form Submission</h3>
            <p className="text-xs text-text-muted">
              Read-only answers submitted by the customer
            </p>
          </div>
          {customerSubmissions.map((submission) => (
            <article
              key={submission.id}
              className="rounded-md border border-border bg-surface px-3 py-3"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-accent">
                  {submission.submission_type.replaceAll("_", " ")}
                </span>
                <time className="text-xs text-text-muted">
                  {fmtDate(submission.submitted_at)}
                </time>
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs font-medium text-text-muted">
                    Issue description
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm text-text">
                    {submission.issue_description || "Not provided"}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-text-muted">
                    Expected solution
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm text-text">
                    {submission.expected_solution || "Not provided"}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      <IssueTypeEditor
        open={issueEditorOpen}
        onClose={() => setIssueEditorOpen(false)}
        issueTypes={issueTypes}
        selected={ticket.issue_types}
        onSave={onIssueTypesChange}
      />
    </div>
  );
}
