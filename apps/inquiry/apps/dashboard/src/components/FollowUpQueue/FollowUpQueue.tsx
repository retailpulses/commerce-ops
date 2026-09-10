import { useCallback, useEffect, useState } from "react";
import { getFollowUps, scheduleFollowUp, sendReply } from "../../api/client";
import type { FollowUpBucket, FollowUpQueueItem } from "../../types/inquiry";
import Button from "../ui/Button";

const BUCKETS: FollowUpBucket[] = ["due", "overdue", "upcoming", "history"];

export default function FollowUpQueue() {
  const [bucket, setBucket] = useState<FollowUpBucket>("due");
  const [items, setItems] = useState<FollowUpQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<Record<number, string>>({});
  const [sending, setSending] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getFollowUps(bucket);
      setItems(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [bucket]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSend = async (item: FollowUpQueueItem) => {
    const body = (compose[item.id] ?? "").trim();
    if (!body) return;
    setSending(item.id);
    setStatus(null);
    try {
      await sendReply(item.id, { body, followUpCycleId: item.followUpCycleId });
      setStatus("Sent — removed from active queue.");
      setCompose((prev) => ({ ...prev, [item.id]: "" }));
      refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(null);
    }
  };

  const handleClear = async (item: FollowUpQueueItem) => {
    setStatus(null);
    try {
      await scheduleFollowUp(item.id, { state: "do_not_follow_up", reason: "operator" });
      refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Update failed");
    }
  };

  const handleReschedule = async (item: FollowUpQueueItem, date: string) => {
    setStatus(null);
    try {
      await scheduleFollowUp(item.id, { dueDate: date, state: "scheduled" });
      refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Reschedule failed");
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Follow-up queue</h2>
        <div className="flex gap-1.5">
          {BUCKETS.map((b) => (
            <button
              key={b}
              onClick={() => setBucket(b)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                bucket === b
                  ? "bg-blue-600 text-white"
                  : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {status && <p className="text-xs text-blue-700">{status}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {loading && <p className="text-xs text-gray-400">Loading…</p>}

      {!loading && items.length === 0 && (
        <p className="text-sm italic text-gray-400">No items in this queue.</p>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {item.customerNickname || "No name"}
                  {item.productName && (
                    <span className="ml-2 text-xs text-gray-500">{item.productName}</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {item.shopKey} · due {item.followUpDueDate}
                  {item.daysOverdue != null && item.daysOverdue > 0 && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">
                      {item.daysOverdue}d overdue
                    </span>
                  )}
                </p>
              </div>
              {bucket !== "history" && (
                <div className="flex gap-1.5">
                  <input
                    type="date"
                    defaultValue={item.followUpDueDate ?? ""}
                    onBlur={(e) => {
                      if (e.target.value) handleReschedule(item, e.target.value);
                    }}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                  <Button variant="secondary" size="sm" onClick={() => handleClear(item)}>
                    Skip
                  </Button>
                </div>
              )}
            </div>

            {bucket !== "history" && (
              <div className="mt-2 space-y-2">
                <textarea
                  placeholder="Compose follow-up message…"
                  value={compose[item.id] ?? ""}
                  onChange={(e) => setCompose((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 p-2 text-sm"
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={sending === item.id || !(compose[item.id] ?? "").trim()}
                  onClick={() => handleSend(item)}
                >
                  {sending === item.id ? "Sending…" : "Send"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
