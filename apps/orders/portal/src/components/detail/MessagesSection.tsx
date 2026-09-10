import { useEffect, useState } from "react";
import { useMessagesQuery, useMarkReadMutation, useSendReplyMutation, useGenerateAIReplyMutation } from "@/hooks/useMessages";
import { useTemplatesQuery } from "@/hooks/useTemplates";
import { Spinner } from "@/components/shared/Spinner";
import { buildAiCopywriteRequest, canRunAiCopywrite } from "@/lib/ai-copywrite";

interface Props {
  orderId: string;
}

export function MessagesSection({ orderId }: Props) {
  const { data, isLoading, refetch } = useMessagesQuery(orderId);
  const markReadMutation = useMarkReadMutation();
  const [replyText, setReplyText] = useState("");
  const [replyFeedback, setReplyFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  const messages = data?.messages || [];
  const source = data?.source;
  const stale = data?.stale;

  const handleRefresh = () => refetch();

  const handleMarkRead = async () => {
    try {
      await markReadMutation.mutateAsync(orderId);
    } catch { /* ignore */ }
  };

  return (
    <section className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase text-gray-400 tracking-wider">Messages</h3>
        <div className="flex gap-2">
          <button
            onClick={handleMarkRead}
            disabled={markReadMutation.isPending}
            className="px-3 py-1 bg-white text-[#1565c0] border border-[#1565c0] rounded text-xs hover:bg-[#e3f2fd] disabled:opacity-50"
          >
            ✔ Mark Read
          </button>
          <button
            onClick={handleRefresh}
            className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs hover:opacity-90"
          >
            Refresh
          </button>
        </div>
      </div>

      {stale && (
        <div className="text-xs text-[#f57c00] mb-2 italic">{data?.warning || "Showing stale cached messages"}</div>
      )}
      {source && (
        <div className="text-[11px] text-gray-400 mb-2 italic">Source: {source}</div>
      )}

      {isLoading ? (
        <div className="text-center py-4"><Spinner /></div>
      ) : messages.length === 0 ? (
        <div className="text-gray-400 text-sm italic py-2">No messages</div>
      ) : (
        <div className="max-h-[250px] overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50 mb-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`px-2.5 py-2 mb-2 border-l-3 rounded-r text-sm ${
                msg.role === "BUYER"
                  ? "border-l-[#1976d2] bg-white"
                  : "border-l-[#388e3c] bg-white"
              }`}
            >
              <div className={`text-[11px] font-semibold mb-0.5 ${msg.role === "BUYER" ? "text-[#1976d2]" : "text-[#388e3c]"}`}>
                {msg.role}
              </div>
              <div className="break-words">{msg.message}</div>
              <div className="text-[11px] text-gray-400 mt-1">{msg.createdAt}</div>
            </div>
          ))}
        </div>
      )}

      {/* Reply composer */}
      <ReplyComposer
        orderId={orderId}
        replyText={replyText}
        onReplyTextChange={setReplyText}
        feedback={replyFeedback}
        onFeedback={setReplyFeedback}
      />
    </section>
  );
}

function ReplyComposer({
  orderId,
  replyText,
  onReplyTextChange,
  feedback,
  onFeedback,
}: {
  orderId: string;
  replyText: string;
  onReplyTextChange: (v: string) => void;
  feedback: { msg: string; ok: boolean } | null;
  onFeedback: (v: { msg: string; ok: boolean } | null) => void;
}) {
  const { data: templatesData } = useTemplatesQuery();
  const sendMutation = useSendReplyMutation();
  const aiMutation = useGenerateAIReplyMutation();
  const [isConfirming, setIsConfirming] = useState(false);

  const templates = templatesData?.templates || [];

  const handleSelectTemplate = (title: string) => {
    const tpl = templates.find((t) => t.title === title);
    if (tpl) onReplyTextChange(tpl.body);
  };

  useEffect(() => {
    if (!isConfirming) return;

    const previousLang = document.documentElement.lang;
    document.documentElement.lang = "ja";
    return () => {
      document.documentElement.lang = previousLang;
    };
  }, [isConfirming]);

  const handleSend = async () => {
    if (!replyText.trim()) return;
    onFeedback(null);
    try {
      await sendMutation.mutateAsync({ orderId, text: replyText.trim() });
      onFeedback({ msg: "Reply sent", ok: true });
      onReplyTextChange("");
      setIsConfirming(false);
    } catch (e) {
      onFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  if (isConfirming) {
    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-gray-100 p-4 sm:p-8"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-confirmation-title"
      >
        <div className="mx-auto max-w-3xl rounded-lg border border-gray-200 bg-white p-5 shadow-lg sm:p-8">
          <h2 id="send-confirmation-title" className="text-xl font-semibold text-gray-900">
            Confirm message before sending
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Review the customer-facing message below. It will be sent exactly as shown.
          </p>

          <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Message to customer
          </div>
          <div
            lang="ja"
            className="mt-2 min-h-[200px] whitespace-pre-wrap break-words rounded border border-gray-300 bg-gray-50 p-4 text-base text-gray-900"
          >
            {replyText.trim()}
          </div>

          {feedback && !feedback.ok && (
            <div className="mt-3 text-sm text-[#d32f2f]">{feedback.msg}</div>
          )}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => { setIsConfirming(false); onFeedback(null); }}
              disabled={sendMutation.isPending}
              className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Back to edit
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sendMutation.isPending}
              className="rounded bg-[#1565c0] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {sendMutation.isPending ? "Sending…" : "Confirm and send to customer"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleAiGenerate = async () => {
    if (!canRunAiCopywrite(replyText, aiMutation.isPending)) return;
    onFeedback(null);
    try {
      const result = await aiMutation.mutateAsync({
        orderId,
        draft: buildAiCopywriteRequest(replyText).draft,
      });
      if (result.draft) onReplyTextChange(result.draft);
      onFeedback({ msg: "AI copywriting applied — review before sending", ok: true });
    } catch (e) {
      onFeedback({ msg: `AI error: ${(e as Error).message}`, ok: false });
    }
  };

  return (
    <div className="mt-3">
      <div className="text-[11px] text-gray-400 mb-1">Draft msg</div>
      <textarea
        value={replyText}
        onChange={(e) => onReplyTextChange(e.target.value)}
        placeholder="日本語で下書きを入力..."
        className="w-full px-2 py-2 border border-gray-300 rounded text-sm resize-y min-h-[200px] focus:outline-none focus:border-[#1565c0]"
        autoComplete="off"
      />
      <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
        <select
          onChange={(e) => { if (e.target.value) handleSelectTemplate(e.target.value); e.target.value = ""; }}
          className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
        >
          <option value="">— Templates —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.title}>{t.title}</option>
          ))}
        </select>

        <div className="flex gap-2 ml-auto">
          <button
            onClick={handleAiGenerate}
            disabled={!canRunAiCopywrite(replyText, aiMutation.isPending)}
            title="Rewrite the reply above with AI. The result will replace the text for review before sending."
            className="px-3 py-1.5 bg-[#7b1fa2] text-white border-none rounded text-xs font-semibold hover:opacity-85 disabled:opacity-50"
          >
            {aiMutation.isPending ? "AI Copywrite…" : "AI Copywrite"}
          </button>
          <button
            onClick={() => { onFeedback(null); setIsConfirming(true); }}
            disabled={sendMutation.isPending || !replyText.trim()}
            className="px-4 py-1.5 bg-[#1565c0] text-white border-none rounded text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >
            Review before sending
          </button>
        </div>
      </div>
      {feedback && (
        <div className={`text-xs mt-1 ${feedback.ok ? "text-[#388e3c]" : "text-[#d32f2f]"}`}>
          {feedback.msg}
        </div>
      )}
    </div>
  );
}
