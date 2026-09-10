import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { LoginGate } from "./WorkspacePage";
import { PageHeader } from "../components/ui/PageHeader";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import {
  listQueue,
  getQueueItem,
  updateQueueItem,
  ignoreQueueItem,
  linkQueueToTicket,
  convertQueueToTicket,
  getUnreadCount,
  getClassificationLabel,
  getClassificationColor,
  type InboundMessage,
  type QueueFilters,
} from "../api/queue";
import { listTickets } from "../api/tickets";

type DetailTab = "overview" | "classification";

interface QueueMessageGroup {
  key: string;
  shop_id: string | null;
  shop_name: string | null;
  order_transaction_id: string | null;
  latest: InboundMessage;
  items: InboundMessage[];
  unreadCount: number;
  linkedCount: number;
}

function groupQueueItems(items: InboundMessage[]): QueueMessageGroup[] {
  const groups = new Map<string, InboundMessage[]>();
  for (const item of items) {
    const key = item.platform === "amazon"
      ? `amazon:${item.account_id ?? "unknown"}:${item.external_order_id ?? item.provider_message_id ?? item.id}`
      : item.platform === "rakuten"
        ? `rakuten:${item.account_id ?? "unknown"}:${item.external_thread_id ?? item.id}`
        : `mercari:${item.shop_id}:${item.order_transaction_id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, groupItems]) => {
      const sorted = [...groupItems].sort(
        (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
      );
      const latest = sorted[0];
      return {
        key,
        shop_id: latest.shop_id,
        shop_name: latest.shop_name,
        order_transaction_id: latest.order_transaction_id,
        latest,
        items: sorted,
        unreadCount: sorted.filter((item) => item.queue_status === "unread").length,
        linkedCount: sorted.filter((item) => item.linked_ticket_id).length,
      };
    })
    .sort((a, b) => new Date(b.latest.received_at).getTime() - new Date(a.latest.received_at).getTime());
}

export default function MessageQueuePage() {
  const { isAuthenticated, isLoading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<QueueFilters>({
    sort: "received_at.desc",
    limit: 100,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [ticketSearch, setTicketSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; ticket_number: string; subject: string | null }>>([]);

  const openLinkModal = () => { setTicketSearch(""); setSearchResults([]); setLinkModalOpen(true); };
  const closeLinkModal = () => { setLinkModalOpen(false); setTicketSearch(""); setSearchResults([]); };

  // Unread count
  const { data: unreadCount } = useQuery({
    queryKey: ["queue-unread-count"],
    queryFn: () => getUnreadCount(),
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });

  // Queue list
  const { data: queueData, isLoading: queueLoading } = useQuery({
    queryKey: ["queue-list", filters],
    queryFn: () => listQueue(filters),
    enabled: isAuthenticated,
  });

  // Selected item detail
  const { data: selectedItem, isLoading: detailLoading } = useQuery({
    queryKey: ["queue-detail", selectedId],
    queryFn: () => (selectedId ? getQueueItem(selectedId) : null),
    enabled: !!selectedId,
  });

  // Mutations
  const markRead = useMutation({
    mutationFn: (id: string) => updateQueueItem(id, { queue_status: "read" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["queue-list"] }); queryClient.invalidateQueries({ queryKey: ["queue-detail"] }); queryClient.invalidateQueries({ queryKey: ["queue-unread-count"] }); },
  });

  const markUnread = useMutation({
    mutationFn: (id: string) => updateQueueItem(id, { queue_status: "unread" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["queue-list"] }); queryClient.invalidateQueries({ queryKey: ["queue-detail"] }); queryClient.invalidateQueries({ queryKey: ["queue-unread-count"] }); },
  });

  const markReviewed = useMutation({
    mutationFn: (id: string) => updateQueueItem(id, { review_status: "reviewed" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["queue-list"] }); queryClient.invalidateQueries({ queryKey: ["queue-detail"] }); },
    onError: (err: Error) => { alert(`Failed to review: ${err.message}`); },
  });

  const ignoreItem = useMutation({
    mutationFn: (id: string) => ignoreQueueItem(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["queue-list"] }); queryClient.invalidateQueries({ queryKey: ["queue-detail"] }); queryClient.invalidateQueries({ queryKey: ["queue-unread-count"] }); setSelectedId(null); },
    onError: (err: Error) => { alert(`Failed to ignore: ${err.message}`); },
  });

  const linkItem = useMutation({
    mutationFn: ({ id, ticketId }: { id: string; ticketId: string }) => linkQueueToTicket(id, ticketId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["queue-list"] }); queryClient.invalidateQueries({ queryKey: ["queue-detail"] }); queryClient.invalidateQueries({ queryKey: ["queue-unread-count"] }); closeLinkModal(); },
    onError: (err: Error) => { alert(`Failed to link: ${err.message}`); },
  });

  const convertItem = useMutation({
    mutationFn: (id: string) => convertQueueToTicket(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["queue-list"] });
      queryClient.invalidateQueries({ queryKey: ["queue-detail"] });
      queryClient.invalidateQueries({ queryKey: ["queue-unread-count"] });
      navigate(`/${data.ticket.id}`);
    },
    onError: (err: Error) => { alert(`Failed to convert: ${err.message}`); },
  });

  const items = queueData?.items ?? [];
  const groups = useMemo(() => groupQueueItems(items), [items]);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.items.some((item) => item.id === selectedId)) ?? null,
    [groups, selectedId],
  );
  const total = queueData?.total ?? 0;
  const sourceErrors = queueData?.source_errors ?? [];

  if (authLoading) {
    return <div className="flex items-center justify-center h-full"><Spinner /></div>;
  }

  if (!isAuthenticated) return <LoginGate />;

  const handleLogout = () => { logout(); navigate("/"); };

  const handleTicketSearch = async (q: string) => {
    setTicketSearch(q);
    if (q.length < 2) { setSearchResults([]); return; }
    try {
      const data = await listTickets({ q, limit: 10 });
      setSearchResults(data.tickets.map((t) => ({ id: t.id, ticket_number: t.ticket_number, subject: t.subject })));
    } catch {
      setSearchResults([]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader onLogout={handleLogout}>
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          &larr; Tickets
        </Button>
        {unreadCount && unreadCount.total > 0 && (
          <span className="bg-red-500 text-white text-xs rounded-full px-2 py-0.5 font-semibold">
            {unreadCount.total}
          </span>
        )}
      </PageHeader>

      {sourceErrors.length > 0 && (
        <div className="border-b border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
          Partial queue: {sourceErrors.map((item) => `${item.source} ${item.code === "SOURCE_DEGRADED" ? "degraded" : "unavailable"}`).join(", ")}. Available platform results are still shown.
        </div>
      )}

      <div className="flex-1 grid grid-cols-[clamp(340px,36vw,480px)_minmax(0,1fr)] max-[899px]:grid-cols-1 min-h-0">
        {/* Left: Queue list */}
        <aside className="flex flex-col bg-white border-r border-border min-h-0 overflow-hidden">
          {/* Filter bar */}
          <div className="p-3 border-b border-border flex flex-wrap gap-2">
            <Select
              value={filters.queue_status ?? ""}
              onChange={(e) => setFilters({ ...filters, queue_status: e.target.value || undefined })}
              className="text-xs"
              options={[
                { value: "", label: "All Statuses" },
                { value: "unread", label: "Unread" },
                { value: "read", label: "Read" },
                { value: "linked", label: "Linked" },
                { value: "converted", label: "Converted" },
                { value: "ignored", label: "Ignored" },
              ]}
            />
            <Select
              value={filters.shop_name ?? ""}
              onChange={(e) => setFilters({ ...filters, shop_name: e.target.value || undefined })}
              className="text-xs"
              options={[
                { value: "", label: "All Shops" },
                { value: "Shop1", label: "Shop1" },
                { value: "Shop2", label: "Shop2" },
                { value: "Shop3", label: "Shop3" },
                { value: "Shop4", label: "Shop4" },
              ]}
            />
            <Input
              placeholder="Search..."
              value={filters.q ?? ""}
              onChange={(e) => setFilters({ ...filters, q: e.target.value || undefined })}
              className="text-xs flex-1 min-w-[120px]"
            />
          </div>

          {/* Queue list */}
          <div className="flex-1 overflow-y-auto">
            {queueLoading ? (
              <div className="flex items-center justify-center py-12"><Spinner /></div>
            ) : groups.length === 0 ? (
              <EmptyState message="No messages in queue" />
            ) : (
              <div>
                <div className="px-3 py-1.5 text-xs text-text-muted border-b border-border">
                  {groups.length} displayed groups · at least {total} matching rows{queueData?.has_more ? "+" : ""}
                </div>
                {groups.map((group) => (
                  <QueueGroupRow
                    key={group.key}
                    group={group}
                    isSelected={selectedGroup?.key === group.key}
                    onClick={() => setSelectedId(group.latest.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Right: Detail */}
        <main className="flex flex-col min-h-0 overflow-hidden max-[899px]:hidden min-[900px]:flex">
          {!selectedId ? (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              Select a message to view details
            </div>
          ) : detailLoading ? (
            <div className="flex items-center justify-center h-full"><Spinner /></div>
          ) : selectedItem ? (
            <div className="flex flex-col h-full">
              {/* Detail header */}
              <div className="p-3 border-b border-border flex items-center gap-3 flex-shrink-0">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {selectedItem.customer_display_name ?? "Unknown Customer"}
                  </div>
                  <div className="text-xs text-text-muted">
                    {selectedItem.shop_name} &middot;{" "}
                    {selectedItem.order_url ? (
                      <a href={selectedItem.order_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                        {selectedItem.order_transaction_id}
                      </a>
                    ) : (
                      selectedItem.order_transaction_id
                    )}
                  </div>
                </div>
                <Badge className={getClassificationColor(selectedItem.classification)}>
                  {getClassificationLabel(selectedItem.classification)}
                </Badge>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-border flex-shrink-0">
                <button
                  className={`px-3 py-1.5 text-xs font-semibold border-b-2 ${detailTab === "overview" ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text"}`}
                  onClick={() => setDetailTab("overview")}
                >
                  Overview
                </button>
                <button
                  className={`px-3 py-1.5 text-xs font-semibold border-b-2 ${detailTab === "classification" ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text"}`}
                  onClick={() => setDetailTab("classification")}
                >
                  AI Classification
                </button>
              </div>

              {/* Detail content */}
              <div className="flex-1 overflow-y-auto p-3 text-sm">
                {detailTab === "overview" ? (
                  <QueueDetailOverview item={selectedItem} group={selectedGroup} />
                ) : (
                  <QueueClassificationDetail item={selectedItem} />
                )}
              </div>

              {/* Action bar: server-provided capabilities are authoritative. */}
              <div className="p-3 border-t border-border flex gap-2 flex-shrink-0 flex-wrap">
                {selectedItem.allowed_actions.includes("mark_read") ? (
                  <Button size="sm" variant="secondary" onClick={() => markRead.mutate(selectedItem.id)}>
                    Mark Read
                  </Button>
                ) : selectedItem.allowed_actions.includes("mark_unread") ? (
                  <Button size="sm" variant="secondary" onClick={() => markUnread.mutate(selectedItem.id)}>
                    Mark Unread
                  </Button>
                ) : null}
                {selectedItem.allowed_actions.includes("link") && (
                  <Button size="sm" variant="secondary" onClick={openLinkModal}>
                    Link to Ticket
                  </Button>
                )}
                {selectedItem.allowed_actions.includes("review") && (
                  <Button size="sm" variant="secondary" disabled={markReviewed.isPending} onClick={() => markReviewed.mutate(selectedItem.id)}>
                    {markReviewed.isPending ? "Reviewing..." : "Mark Reviewed"}
                  </Button>
                )}
                {selectedItem.allowed_actions.includes("convert") && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={convertItem.isPending}
                    onClick={() => convertItem.mutate(selectedItem.id)}
                  >
                    {convertItem.isPending ? "Converting..." : "Convert to Ticket"}
                  </Button>
                )}
                {selectedItem.allowed_actions.includes("ignore") && (
                  <Button size="sm" variant="secondary" onClick={() => ignoreItem.mutate(selectedItem.id)}>
                    Ignore
                  </Button>
                )}
                {selectedItem.allowed_actions.includes("view_ticket") && selectedItem.linked_ticket_id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(`/${selectedItem.linked_ticket_id}`)}
                  >
                    View Ticket {selectedItem.linked_ticket_number ? `#${selectedItem.linked_ticket_number}` : ""}
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {/* Link to Ticket Modal */}
      {selectedItem && (
        <Modal open={linkModalOpen} onClose={closeLinkModal} title="Link to Ticket">
          <div className="space-y-3">
            <Input
              placeholder="Search by ticket number or subject..."
              value={ticketSearch}
              onChange={(e) => handleTicketSearch(e.target.value)}
              autoFocus
            />
            {linkItem.isPending && (
              <div className="flex items-center gap-2 text-sm text-text-muted py-2">
                <Spinner /> Linking...
              </div>
            )}
            {searchResults.length > 0 && (
              <div className="max-h-48 overflow-y-auto border border-border rounded">
                {searchResults.map((t) => (
                  <button
                    key={t.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent-bg border-b border-border last:border-b-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => linkItem.mutate({ id: selectedItem.id, ticketId: t.id })}
                    disabled={linkItem.isPending}
                  >
                    <span className="font-mono text-accent text-xs">{t.ticket_number}</span>
                    <span className="ml-2 text-text-muted">{t.subject ?? "No subject"}</span>
                  </button>
                ))}
              </div>
            )}
            {ticketSearch.length >= 2 && searchResults.length === 0 && (
              <p className="text-xs text-text-muted">No tickets found</p>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={closeLinkModal}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Sub-components ──

function QueueGroupRow({
  group,
  isSelected,
  onClick,
}: {
  group: QueueMessageGroup;
  isSelected: boolean;
  onClick: () => void;
}) {
  const item = group.latest;
  const isUnread = group.unreadCount > 0;
  const hasMultiple = group.items.length > 1;

  return (
    <button
      className={`w-full text-left px-3 py-2.5 border-b border-border hover:bg-gray-50 transition-colors ${
        isSelected ? "bg-accent-bg border-l-2 border-l-accent" : ""
      } ${isUnread ? "border-l-2 border-l-blue-400" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className={`text-sm truncate ${isUnread ? "font-semibold" : ""}`}>
            {item.customer_display_name ?? "Unknown"}
          </div>
          <div className="text-xs text-text-muted truncate flex items-center gap-1.5">
            <span>
              {item.platform === "amazon" ? "Amazon Mail" : item.platform === "rakuten" ? "Rakuten R-Messe" : (group.shop_name ?? "Unknown shop")}
              {" · "}
              {(group.order_transaction_id ?? item.external_order_id ?? item.provider_message_id ?? item.id).slice(0, 16)}...
            </span>
            {hasMultiple && (
              <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-text">
                {group.items.length} msgs
              </span>
            )}
            {group.unreadCount > 0 && (
              <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                {group.unreadCount} unread
              </span>
            )}
            {group.linkedCount > 0 && (
              <span className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                linked
              </span>
            )}
          </div>
          {item.latest_buyer_message && (
            <div className="text-xs text-text-muted truncate mt-0.5">
              {item.latest_buyer_message.slice(0, 80)}
              {item.latest_buyer_message.length > 80 ? "..." : ""}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <Badge className={getClassificationColor(item.classification)}>
            {getClassificationLabel(item.classification)}
          </Badge>
          <span className="text-[10px] text-text-muted">
            {new Date(item.received_at).toLocaleDateString("ja-JP", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      </div>
    </button>
  );
}

function QueueDetailOverview({
  item,
  group,
}: {
  item: InboundMessage;
  group: QueueMessageGroup | null;
}) {
  return (
    <div className="space-y-4">
      <DetailField label="Status">
        <Badge className={item.queue_status === "unread" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}>
          {item.queue_status}
        </Badge>
      </DetailField>
      <DetailField label="Shop">{item.shop_name}</DetailField>
      <DetailField label="Transaction ID">
        <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{item.order_transaction_id}</code>
      </DetailField>
      <DetailField label="Customer">{item.customer_display_name ?? "—"}</DetailField>
      <DetailField label="Received">
        {new Date(item.received_at).toLocaleString("ja-JP")}
      </DetailField>
      {item.latest_buyer_message && (
        <DetailField label="Customer Message">
          <div className="bg-gray-50 border border-border rounded p-2 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">
            {item.latest_buyer_message}
          </div>
        </DetailField>
      )}
      {item.linked_ticket_id && (
        <DetailField label="Linked Ticket">
          <span className="font-mono text-accent text-xs">
            {item.linked_ticket_number ?? item.linked_ticket_id}
          </span>
          {item.linked_ticket_subject && (
            <span className="text-text-muted text-xs ml-2">{item.linked_ticket_subject}</span>
          )}
        </DetailField>
      )}
      <DetailField label="Queue Status">{item.queue_status}</DetailField>
      <DetailField label="Review Status">{item.review_status}</DetailField>
      {item.platform === "amazon" && (
        <>
          <DetailField label="Mail Authentication">
            <Badge className={item.mail_auth_status === "pass" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>
              {item.mail_auth_status ?? "unknown"}
            </Badge>
          </DetailField>
          <DetailField label="Attachments">
            {(item.provider_metadata?.attachment_count ?? item.provider_metadata?.attachments?.length ?? 0) === 0
              ? "None"
              : `${item.provider_metadata?.attachment_count ?? item.provider_metadata?.attachments?.length ?? 0} · ${item.attachment_processing_status ?? "pending"}`}
          </DetailField>
        </>
      )}

      {group && group.items.length > 1 && (
        <DetailField label={`Order Message History (${group.items.length})`}>
          <div className="space-y-2">
            {group.items.map((message) => (
              <div
                key={message.id}
                className={`rounded border border-border p-2 text-xs ${
                  message.id === item.id ? "bg-accent-bg" : "bg-gray-50"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium text-text">{message.queue_status}</span>
                  <span className="text-[10px] text-text-muted">
                    {new Date(message.received_at).toLocaleString("ja-JP")}
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-text-muted">
                  {message.latest_buyer_message ?? "No message text"}
                </div>
              </div>
            ))}
          </div>
        </DetailField>
      )}
    </div>
  );
}

function QueueClassificationDetail({ item }: { item: InboundMessage }) {
  const c = item.classification;
  if (!c) {
    return <EmptyState message="No classification data available" />;
  }

  return (
    <div className="space-y-4">
      <DetailField label="Classification">
        <Badge className={getClassificationColor(c)}>{getClassificationLabel(c)}</Badge>
      </DetailField>
      <DetailField label="Confidence">{(c.confidence * 100).toFixed(0)}%</DetailField>
      <DetailField label="Workflow Route">{c.workflow_route}</DetailField>
      <DetailField label="Recommended Action">{c.recommended_operator_action}</DetailField>
      {c.suggested_ticket_type && (
        <DetailField label="Suggested Type">{c.suggested_ticket_type}</DetailField>
      )}
      {c.suggested_priority && (
        <DetailField label="Suggested Priority">{c.suggested_priority}</DetailField>
      )}
      {c.reasoning_summary && (
        <DetailField label="AI Reasoning">
          <div className="bg-gray-50 border border-border rounded p-2 text-xs">{c.reasoning_summary}</div>
        </DetailField>
      )}
      <DetailField label="Recommended for Manual Ticket Creation">
        {(c.recommended_for_manual_creation ?? c.should_convert_to_ticket) ? "Yes" : "No"}
      </DetailField>
      <DetailField label="Automation Eligible">{c.automation_eligible ? "Yes" : "No"}</DetailField>
      {c.automation_blockers.length > 0 && (
        <DetailField label="Automation Blockers">
          <ul className="list-disc list-inside text-xs">
            {c.automation_blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </DetailField>
      )}
      <DetailField label="Model">{c.model}</DetailField>
      <DetailField label="Prompt Version">{c.prompt_version}</DetailField>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
