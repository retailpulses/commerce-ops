import type { ThreadMessage, TicketMessage } from "@/api/types";
import { fmtDate } from "@/lib/utils";
import { mergeMessages } from "./messageTimeline";

interface MessagesTabProps {
  threadMessages: ThreadMessage[];
  ticketMessages: TicketMessage[];
  isMercari: boolean;
}

const SOURCE_BADGES: Record<string, string> = {
  mercari: "bg-blue-100 text-blue-700",
  portal: "bg-gray-100 text-gray-600",
};

const ROLE_BADGES: Record<string, string> = {
  buyer: "bg-surface border border-border text-text-muted",
  customer: "bg-surface border border-border text-text-muted",
  seller: "bg-accent text-white",
  operator: "bg-accent text-white",
  system: "bg-violet-600 text-white",
  automation: "bg-violet-600 text-white",
};

const SEND_METHOD_BADGES = {
  manual: {
    label: "manual sent",
    className: "bg-emerald-100 text-emerald-700",
  },
  system: {
    label: "system sent",
    className: "bg-violet-100 text-violet-700",
  },
};

export function MessagesTab({
  threadMessages,
  ticketMessages,
  isMercari,
}: MessagesTabProps) {
  const merged = mergeMessages(threadMessages, ticketMessages);

  if (merged.length === 0) {
    return (
      <p className="text-sm text-text-muted text-center py-8">
        No messages yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {merged.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.isOperator ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[80%] rounded-lg px-3 py-2 ${
              msg.isOperator
                ? "bg-accent-bg text-text"
                : "bg-surface border border-border text-text"
            }`}
          >
            {/* Header row: badges + timestamp */}
            <div
              className={`flex items-center gap-1.5 mb-1 ${
                msg.isOperator ? "flex-row-reverse" : ""
              }`}
            >
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  ROLE_BADGES[msg.role.toLowerCase()] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {msg.displayName ?? msg.role}
              </span>
              {msg.sendMethod && (
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    SEND_METHOD_BADGES[msg.sendMethod].className
                  }`}
                >
                  {SEND_METHOD_BADGES[msg.sendMethod].label}
                </span>
              )}
              {msg.source && (
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    SOURCE_BADGES[msg.source] ?? "bg-gray-100 text-gray-600"
                  }`}
                >
                  {msg.source}
                </span>
              )}
              <time
                className={`text-[10px] text-text-muted ${
                  msg.isOperator ? "ml-auto" : "mr-auto"
                }`}
              >
                {fmtDate(msg.sentAt)}
              </time>
            </div>

            {/* Body text */}
            <p className="text-sm whitespace-pre-wrap break-words">
              {msg.body}
            </p>
          </div>
        </div>
      ))}

      {isMercari && merged.length > 0 && (
        <p className="text-[11px] text-text-muted text-center mt-1">
          Messages are from the Mercari platform thread
        </p>
      )}
    </div>
  );
}
