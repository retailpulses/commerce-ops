import { useState } from "react";
import type { OrderDetail } from "@/types/orders";
import { manualMemoLines, parseTimestampedMemo } from "@/components/detail/manualMemos";

export function MemoLog({
  order,
  onAddMemo,
}: {
  order: OrderDetail;
  onAddMemo: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  const memos = order.order_comments || order.review_memo_log || "";

  const handleAdd = async () => {
    if (!text.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      await onAddMemo(text.trim());
      setText("");
      setFeedback({ msg: "Memo added", ok: true });
    } catch (e) {
      setFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    } finally {
      setSaving(false);
    }
  };

  // Parse memo entries: [timestamp] operator: body
  const lines = manualMemoLines(memos);

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">Memos</h3>

      {lines.length > 0 ? (
        <div>
          {lines.map((line, i) => {
            const timestampedMemo = parseTimestampedMemo(line);
            if (timestampedMemo) {
              return (
                <div key={i} className="px-2.5 py-2 border-l-3 border-gray-200 bg-gray-50 rounded-r-md mb-2 text-sm">
                  <div className="text-[11px] text-gray-400 mb-0.5">
                    {timestampedMemo.timestamp} — {timestampedMemo.author}
                  </div>
                  {timestampedMemo.body}
                </div>
              );
            }
            return (
              <div key={i} className="px-2.5 py-2 border-l-3 border-gray-200 bg-gray-50 rounded-r-md mb-2 text-sm whitespace-pre-wrap">
                {line}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-gray-400 text-sm italic">No memos yet.</div>
      )}

      {/* Add memo */}
      <div className="mt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a memo..."
          className="w-full px-2 py-2 border border-gray-300 rounded text-sm resize-y min-h-[60px] focus:outline-none focus:border-[#1565c0]"
          autoComplete="off"
        />
        <div className="flex justify-between items-center mt-1.5">
          <span className={`text-xs ${feedback?.ok ? "text-[#388e3c]" : "text-[#d32f2f]"}`}>
            {feedback?.msg || ""}
          </span>
          <button
            onClick={handleAdd}
            disabled={saving || !text.trim()}
            className="px-4 py-2 bg-[#1565c0] text-white border-none rounded text-sm hover:opacity-90 disabled:opacity-50"
          >
            Add Memo
          </button>
        </div>
      </div>
    </section>
  );
}
