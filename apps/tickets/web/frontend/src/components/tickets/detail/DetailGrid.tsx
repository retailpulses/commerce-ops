import { useState, useEffect, useRef } from "react";
import type { Ticket, IssueType, TicketStatus, PlatformAccount } from "@/api/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { IssueTypeBadge } from "@/components/ui/IssueTypeBadge";
import { IssueTypeEditor } from "./IssueTypeEditor";
import { listAccounts } from "@/api/tickets";

/* ------------------------------------------------------------------ */
/*  Compact select — inline, no label, for the collapsed summary row  */
/* ------------------------------------------------------------------ */

function CompactSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className="text-xs border border-border rounded px-1.5 py-0.5 bg-white text-text focus:outline-none focus:ring-1 focus:ring-accent/50 max-w-[120px] truncate"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

interface DetailGridProps {
  ticket: Ticket;
  issueTypes: IssueType[];
  statuses: TicketStatus[];
  onFieldChange: (field: string, value: unknown) => void;
  onIssueTypesChange: (types: string[]) => void;
}

function buildStatusOptions(statuses: TicketStatus[]) {
  return statuses.map((s) => ({ value: s.key, label: s.display_name }));
}

const PRIORITY_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

export function DetailGrid({
  ticket,
  issueTypes,
  statuses,
  onFieldChange,
  onIssueTypesChange,
}: DetailGridProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [issueEditorOpen, setIssueEditorOpen] = useState(false);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [localSubject, setLocalSubject] = useState(ticket.subject ?? "");
  const subjectDirtyRef = useRef(false);
  useEffect(() => {
    if (!subjectDirtyRef.current) setLocalSubject(ticket.subject ?? "");
  }, [ticket.subject]);

  const [localCustomer, setLocalCustomer] = useState(ticket.customer_display_name ?? "");
  const customerDirtyRef = useRef(false);
  useEffect(() => {
    if (!customerDirtyRef.current) setLocalCustomer(ticket.customer_display_name ?? "");
  }, [ticket.customer_display_name]);

  const [localExternalUrl, setLocalExternalUrl] = useState(ticket.external_url ?? "");
  const externalUrlDirtyRef = useRef(false);
  useEffect(() => {
    if (!externalUrlDirtyRef.current) setLocalExternalUrl(ticket.external_url ?? "");
  }, [ticket.external_url]);

  useEffect(() => {
    listAccounts().then((d) => setAccounts(d.accounts)).catch(() => setAccounts([]));
  }, []);

  const accountOptions = [
    { value: "", label: "None" },
    ...accounts.map((a) => ({ value: a.id, label: `${a.display_name} (${a.platform})` })),
  ];

  const selectedIssueTypeLabels = ticket.issue_types
    .map((key) => issueTypes.find((it) => it.key === key))
    .filter((it): it is IssueType => it !== undefined)
    .map((it) => it.display_name);

  return (
    <>
      {/* ── Collapsed: compact summary row ── */}
      {!isExpanded ? (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface flex-wrap">
          <CompactSelect
            value={ticket.status}
            options={buildStatusOptions(statuses)}
            onChange={(e) => onFieldChange("status", e.target.value)}
          />
          <CompactSelect
            value={ticket.priority}
            options={PRIORITY_OPTIONS}
            onChange={(e) => onFieldChange("priority", e.target.value)}
          />
          <span className="text-xs text-text truncate max-w-[200px] flex-1 min-w-0">
            {ticket.subject || <span className="text-text-muted">No subject</span>}
          </span>
          {selectedIssueTypeLabels.slice(0, 2).map((label) => (
            <IssueTypeBadge key={label} label={label} />
          ))}
          {selectedIssueTypeLabels.length > 2 && (
            <span className="text-[10px] text-text-muted">
              +{selectedIssueTypeLabels.length - 2}
            </span>
          )}
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="shrink-0 text-xs text-text-muted hover:text-text px-1.5 py-0.5 border border-border rounded cursor-pointer hover:bg-surface transition-colors"
            title="Expand ticket details"
          >
            Details ▸
          </button>
        </div>
      ) : (
        /* ── Expanded: full detail grid ── */
        <div className="border-b border-border">
          <div className="flex items-center justify-end px-4 pt-2">
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="text-xs text-text-muted hover:text-text px-1.5 py-0.5 border border-border rounded cursor-pointer hover:bg-surface transition-colors"
              title="Collapse ticket details"
            >
              ▲ Hide details
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 px-4 py-3">
            {/* Status */}
            <Select
              label="Status"
              options={buildStatusOptions(statuses)}
              value={ticket.status}
              onChange={(e) => onFieldChange("status", e.target.value)}
            />

            {/* Priority */}
            <Select
              label="Priority"
              options={PRIORITY_OPTIONS}
              value={ticket.priority}
              onChange={(e) => onFieldChange("priority", e.target.value)}
            />

            {/* Account */}
            <Select
              label="Account"
              options={accountOptions}
              value={ticket.account_id ?? ""}
              onChange={(e) => onFieldChange("account_id", e.target.value || null)}
            />

            {/* Subject */}
            <Input
              label="Subject"
              value={localSubject}
              onChange={(e) => {
                subjectDirtyRef.current = true;
                setLocalSubject(e.target.value);
              }}
              onBlur={() => {
                subjectDirtyRef.current = false;
                if (localSubject !== ticket.subject) onFieldChange("subject", localSubject);
              }}
            />

            {/* Issue Types */}
            <div className="flex flex-col gap-1">
              <label className="text-text-muted text-sm font-medium">
                Issue Types
              </label>
              <div className="flex items-center gap-2 flex-wrap min-h-[36px]">
                {selectedIssueTypeLabels.length > 0 ? (
                  selectedIssueTypeLabels.map((label) => (
                    <IssueTypeBadge key={label} label={label} />
                  ))
                ) : (
                  <span className="text-xs text-text-muted">None selected</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIssueEditorOpen(true)}
                >
                  Edit
                </Button>
              </div>
            </div>

            {/* Started At */}
            <Input
              label="Started At"
              type="datetime-local"
              value={
                ticket.started_at
                  ? ticket.started_at.slice(0, 16)
                  : ""
              }
              onChange={(e) =>
                onFieldChange(
                  "started_at",
                  e.target.value ? e.target.value + ":00Z" : null,
                )
              }
            />

            {/* Customer */}
            <Input
              label="Customer"
              value={localCustomer}
              onChange={(e) => {
                customerDirtyRef.current = true;
                setLocalCustomer(e.target.value);
              }}
              onBlur={() => {
                customerDirtyRef.current = false;
                if (localCustomer !== (ticket.customer_display_name ?? ""))
                  onFieldChange("customer_display_name", localCustomer || null);
              }}
            />

            {/* External URL */}
            <div className="flex items-end gap-1">
              <div className="flex-1">
                <Input
                  label="External URL"
                  value={localExternalUrl}
                  onChange={(e) => {
                    externalUrlDirtyRef.current = true;
                    setLocalExternalUrl(e.target.value);
                  }}
                  onBlur={() => {
                    externalUrlDirtyRef.current = false;
                    if (localExternalUrl !== (ticket.external_url ?? ""))
                      onFieldChange("external_url", localExternalUrl || null);
                  }}
                />
              </div>
              {ticket.external_url && (
                <a
                  href={ticket.external_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 px-2 py-1.5 text-xs text-accent hover:underline border border-border rounded"
                  title="Open order in Mercari"
                >
                  Open
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      <IssueTypeEditor
        open={issueEditorOpen}
        onClose={() => setIssueEditorOpen(false)}
        issueTypes={issueTypes}
        selected={ticket.issue_types}
        onSave={onIssueTypesChange}
      />
    </>
  );
}
