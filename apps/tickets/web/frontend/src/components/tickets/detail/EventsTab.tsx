import type { TicketEvent } from "@/api/types";
import { fmtDate } from "@/lib/utils";

interface EventsTabProps {
  events: TicketEvent[];
}

function eventPresentation(event: TicketEvent): { title: string; detail?: string } {
  const payload = event.payload ?? {};
  if (payload.source === "ticketform_submission" && event.event_type === "message_received") {
    const preview = typeof payload.description_preview === "string"
      ? payload.description_preview
      : undefined;
    const count = typeof payload.attachment_count === "number"
      ? payload.attachment_count
      : undefined;
    const evidence = count === undefined
      ? undefined
      : count === 0
        ? "No evidence files"
        : `${count} evidence file${count === 1 ? "" : "s"}`;
    return {
      title: "Customer form submitted",
      detail: [preview, evidence].filter(Boolean).join(" · ") || undefined,
    };
  }
  if (event.event_type === "attachment_added" && payload.submission_id) {
    const filename = typeof payload.filename === "string" ? payload.filename : undefined;
    return {
      title: "Customer form evidence added",
      detail: filename,
    };
  }
  return { title: event.event_type.replaceAll("_", " ") };
}

export function EventsTab({ events }: EventsTabProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-text-muted text-center py-8">
        No events recorded yet.
      </p>
    );
  }

  const sorted = [...events].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="flex flex-col divide-y divide-border">
      {sorted.map((event) => {
        const presentation = eventPresentation(event);
        return (
        <div key={event.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="font-semibold text-sm text-accent">
                {presentation.title}
              </span>
              {event.actor_type && (
                <span className="text-xs text-text-muted ml-2">
                  by {event.actor_type}
                </span>
              )}
              {presentation.detail && (
                <p className="mt-1 text-xs text-text-muted whitespace-pre-wrap break-words">
                  {presentation.detail}
                </p>
              )}
            </div>
            <time className="text-xs text-text-muted shrink-0">
              {fmtDate(event.created_at)}
            </time>
          </div>
        </div>
        );
      })}
    </div>
  );
}
