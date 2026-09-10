import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { PageHeader } from "../components/ui/PageHeader";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Input } from "../components/ui/Input";
import { useCreateTicket } from "../hooks/useTickets";
import { useIssueTypes } from "../hooks/useTickets";
import { useToast } from "../components/ui/Toast";
import { listAccounts } from "../api/tickets";
import type { CreateTicketInput, PlatformAccount } from "../api/types";

const PLATFORM_OPTIONS = [
  { value: "mercari", label: "Mercari" },
  { value: "amazon", label: "Amazon" },
  { value: "rakuten", label: "Rakuten" },
  { value: "other", label: "Other" },
];

const PRIORITY_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export default function CreateTicketPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const createTicket = useCreateTicket();
  const { data: issueTypesData } = useIssueTypes();
  const { toast } = useToast();

  const [platform, setPlatform] = useState("mercari");
  const [priority, setPriority] = useState("normal");
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [externalOrderId, setExternalOrderId] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [selectedIssueTypes, setSelectedIssueTypes] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    listAccounts().then((d) => setAccounts(d.accounts)).catch(() => setAccounts([]));
  }, []);

  const fetchAccountsForPlatform = async (pf: string) => {
    try {
      const d = await listAccounts(pf);
      setAccounts(d.accounts);
    } catch { setAccounts([]); }
  };

  const accountOptions = [
    { value: "", label: "Select account..." },
    ...accounts.map((a) => ({ value: a.id, label: `${a.display_name} (${a.platform})` })),
  ];

  const issueTypes = issueTypesData?.issue_types ?? [];

  const toggleIssueType = (key: string) => {
    setSelectedIssueTypes((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleSubmit = async () => {
    if (!platform) {
      setErrors(["Platform is required"]);
      return;
    }

    const input: CreateTicketInput = {
      platform,
      account_id: accountId || null,
      priority,
      external_order_id: externalOrderId.trim() || null,
      external_url: externalUrl.trim() || null,
      customer_display_name: customerName.trim() || null,
      customer_contact: customerContact.trim() || null,
      subject: subject.trim() || null,
      description: description.trim() || null,
      issue_types: selectedIssueTypes,
      status: "open",
    };

    try {
      const result = await createTicket.mutateAsync(input);
      toast(`Ticket ${result.ticket.ticket_number} created!`, "success");
      navigate(`/${result.ticket.id}`);
    } catch {
      setErrors(["Failed to create ticket"]);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    navigate("/");
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader onLogout={() => navigate("/")} />

      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-2xl mx-auto">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold">New Ticket</h2>
            <Button variant="secondary" size="sm" onClick={() => navigate("/")}>
              Cancel
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
                Platform *
              </label>
              <Select
                value={platform}
                onChange={(e) => { setPlatform(e.target.value); fetchAccountsForPlatform(e.target.value); }}
                options={PLATFORM_OPTIONS}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
                Priority
              </label>
              <Select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                options={PRIORITY_OPTIONS}
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
              Account (Shop)
            </label>
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              options={accountOptions}
            />
          </div>

          <div className="mb-4">
            <Input
              label="External Order ID"
              value={externalOrderId}
              onChange={(e) => setExternalOrderId(e.target.value)}
              placeholder="Platform order/transaction ID"
            />
          </div>

          <div className="mb-4">
            <Input
              label="External URL"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="Link to platform order page"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <Input
              label="Customer Name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Customer display name"
            />
            <Input
              label="Customer Contact"
              value={customerContact}
              onChange={(e) => setCustomerContact(e.target.value)}
              placeholder="Email or phone"
            />
          </div>

          <div className="mb-4">
            <Input
              label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief summary"
            />
          </div>

          <div className="mb-4">
            <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
              Issue Types
            </label>
            <div className="flex flex-wrap gap-1.5">
              {issueTypes.map((it) => {
                const checked = selectedIssueTypes.includes(it.key);
                return (
                  <label
                    key={it.key}
                    className={`inline-flex items-center gap-1 text-[11px] cursor-pointer px-2 py-1 rounded-full border transition-all select-none ${
                      checked
                        ? "bg-accent text-white border-accent"
                        : "border-border hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleIssueType(it.key)}
                      className="hidden"
                    />
                    {it.display_name}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Issue details..."
              rows={4}
              className="w-full px-2 py-2 border border-border rounded text-[13px] font-[inherit] resize-y outline-none focus:border-accent"
            />
          </div>

          {errors.length > 0 && (
            <p className="text-danger text-xs mb-4">{errors.join("; ")}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate("/")}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              loading={createTicket.isPending}
            >
              Create Ticket
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
