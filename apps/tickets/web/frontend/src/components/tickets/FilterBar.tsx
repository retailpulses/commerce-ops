import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { TicketFilters, PlatformAccount, IssueType, TicketStatus } from "@/api/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { listAccounts, getIssueTypes, getStatuses } from "@/api/tickets";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FilterBarProps {
  filters: TicketFilters;
  onFiltersChange: (filters: TicketFilters) => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const platformOptions = [
  { value: "", label: "All Platforms" },
  { value: "mercari", label: "Mercari" },
  { value: "amazon", label: "Amazon" },
  { value: "rakuten", label: "Rakuten" },
  { value: "other", label: "Other" },
];

function buildStatusOptions(statuses: TicketStatus[]) {
  return [
    { value: "__active", label: "Active tickets (all active statuses)" },
    { value: "", label: "All Statuses" },
    ...statuses.map((s) => ({ value: s.key, label: s.display_name })),
  ];
}

const priorityOptions = [
  { value: "", label: "All Priorities" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

const sortOptions = [
  { value: "created_at.desc", label: "Newest" },
  { value: "created_at.asc", label: "Oldest" },
  { value: "latest_message_at.desc", label: "Last Msg newest" },
  { value: "priority.desc", label: "Priority" },
];

/* ------------------------------------------------------------------ */
/*  FilterBar                                                          */
/* ------------------------------------------------------------------ */

export function FilterBar({ filters, onFiltersChange }: FilterBarProps) {
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState(filters.q ?? "");
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);
  const [statuses, setStatuses] = useState<TicketStatus[]>([]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // Fetch accounts for filter dropdown
  useEffect(() => {
    listAccounts().then((d) => setAccounts(d.accounts)).catch(() => setAccounts([]));
  }, []);

  // Fetch issue types for filter dropdown
  useEffect(() => {
    getIssueTypes().then((d) => setIssueTypes(d.issue_types)).catch(() => setIssueTypes([]));
  }, []);

  // Fetch statuses for filter dropdown
  useEffect(() => {
    getStatuses().then((d) => setStatuses(d.statuses)).catch(() => setStatuses([]));
  }, []);

  const accountOptions = [
    { value: "", label: "All Accounts" },
    ...accounts.map((a) => ({ value: a.id, label: `${a.display_name} (${a.platform})` })),
  ];

  // Sync search text when external filters.q changes (e.g. parent reset)
  useEffect(() => {
    setSearchText(filters.q ?? "");
  }, [filters.q]);

  // Debounce search text propagation (250ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = searchText || undefined;
      if (q !== filtersRef.current.q) {
        onFiltersChange({ ...filtersRef.current, q });
      }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchText(e.target.value);
    },
    [],
  );

  const handleSelectChange = useCallback(
    (key: keyof TicketFilters, value: string) => {
      onFiltersChange({ ...filtersRef.current, [key]: value || undefined });
    },
    [],
  );

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      {/* Search row */}
      <Input
        placeholder="Search tickets..."
        value={searchText}
        onChange={handleSearchChange}
      />

      {/* Filter row */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex-1 min-w-[120px]">
          <Select
            options={platformOptions}
            value={filters.platform ?? ""}
            onChange={(e) => handleSelectChange("platform", e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[130px]">
          <Select
            options={buildStatusOptions(statuses)}
            value={filters.status_group === "non_terminal" ? "__active" : filters.status ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              onFiltersChange({
                ...filtersRef.current,
                status: value && value !== "__active" ? value : undefined,
                status_group: value === "__active" ? "non_terminal" : undefined,
              });
            }}
          />
        </div>
        <div className="flex-1 min-w-[110px]">
          <Select
            options={priorityOptions}
            value={filters.priority ?? ""}
            onChange={(e) => handleSelectChange("priority", e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[130px]">
          <Select
            options={accountOptions}
            value={filters.account_id ?? ""}
            onChange={(e) => handleSelectChange("account_id", e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[120px]">
          <Select
            options={[
              { value: "", label: "All Issue Types" },
              ...issueTypes.map((it) => ({ value: it.key, label: it.display_name })),
            ]}
            value={filters.issue_type ?? ""}
            onChange={(e) => handleSelectChange("issue_type", e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[130px]">
          <Select
            options={sortOptions}
            value={filters.sort ?? "newest"}
            onChange={(e) => handleSelectChange("sort", e.target.value)}
          />
        </div>
      </div>

      {/* Action row */}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/queue")}
        >
          Message Queue
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => navigate("/new")}
        >
          + New Ticket
        </Button>
      </div>
    </div>
  );
}
