import type { ThreadMessage, TicketMessage } from "../../../api/types";

export interface MergedMessage {
  id: string;
  role: string;
  body: string;
  sentAt: string;
  source: string;
  displayName?: string;
  isOperator: boolean;
  sendMethod?: "manual" | "system";
}

function isOperatorRole(role: string): boolean {
  const normalizedRole = role.toLowerCase();
  return (
    normalizedRole === "seller" ||
    normalizedRole === "operator" ||
    normalizedRole === "system" ||
    normalizedRole === "automation"
  );
}

function getSendMethod(role: string): "manual" | "system" | undefined {
  const normalizedRole = role.toLowerCase();
  if (normalizedRole === "operator") return "manual";
  if (normalizedRole === "system" || normalizedRole === "automation") {
    return "system";
  }
  return undefined;
}

export function mergeMessages(
  thread: ThreadMessage[],
  manual: TicketMessage[],
): MergedMessage[] {
  const map = new Map<string, MergedMessage>();

  for (const message of thread) {
    map.set(message.id, {
      id: message.id,
      role: message.role,
      body: message.body,
      sentAt: message.sentAt,
      source: message.source === "platform" ? "mercari" : "portal",
      displayName: message.displayName,
      isOperator: isOperatorRole(message.role),
      sendMethod: getSendMethod(message.role),
    });
  }

  for (const message of manual) {
    // The merged thread uses the Mercari message ID for platform messages,
    // while ticket_messages uses its database row ID. Match both identities.
    const matchingId =
      message.external_message_id !== null &&
      map.has(message.external_message_id)
        ? message.external_message_id
        : map.has(message.id)
          ? message.id
          : null;

    if (matchingId) {
      const existing = map.get(matchingId)!;
      map.set(matchingId, {
        ...existing,
        role: message.sender_type,
        displayName: message.sender_display_name ?? existing.displayName,
        isOperator: isOperatorRole(message.sender_type),
        sendMethod: getSendMethod(message.sender_type),
      });
      continue;
    }

    map.set(message.id, {
      id: message.id,
      role: message.sender_type,
      body: message.body,
      sentAt: message.sent_at,
      source: "portal",
      displayName: message.sender_display_name ?? undefined,
      isOperator: isOperatorRole(message.sender_type),
      sendMethod: getSendMethod(message.sender_type),
    });
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
  );
}
