import { useEffect, useState } from "react";
import { getInquiryMessages } from "../../api/client";
import type { InquiryMessage } from "../../types/inquiry";

function formatTime(value: string | null): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export default function MessageTimeline({ inquiryId, refreshKey = "" }: { inquiryId: number; refreshKey?: string | number }) {
  const [messages, setMessages] = useState<InquiryMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getInquiryMessages(inquiryId)
      .then((res) => {
        if (!cancelled) setMessages(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load timeline");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inquiryId, refreshKey]);

  if (loading) return <p className="text-xs text-gray-400">Loading timeline…</p>;
  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (messages.length === 0) {
    return <p className="text-xs italic text-gray-400">No normalized messages yet</p>;
  }

  return (
    <ol className="space-y-2">
      {messages.map((message) => {
        const isBuyer = message.direction === "inbound";
        return (
          <li
            key={message.id}
            className={`rounded-lg border p-2.5 text-sm ${
              isBuyer ? "border-gray-200 bg-white" : "border-blue-100 bg-blue-50"
            }`}
          >
            <div className="mb-1 flex items-center justify-between text-[11px] text-gray-500">
              <span className="font-medium uppercase tracking-wide">
                {isBuyer ? "Buyer" : "Seller"}
              </span>
              <span>{formatTime(message.sentAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-gray-700">{message.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
