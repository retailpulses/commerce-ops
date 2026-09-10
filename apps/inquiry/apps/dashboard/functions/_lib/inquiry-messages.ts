type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function messageText(record: UnknownRecord): string | null {
  for (const key of ["body", "message", "text", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isCustomerMessage(record: UnknownRecord): boolean {
  const sender = String(
    record.sender_type ??
      record.senderType ??
      record.role ??
      record.author_type ??
      record.authorType ??
      "",
  ).toLowerCase();
  return ["customer", "buyer", "inquirer", "user"].includes(sender);
}

export function firstCustomerMessage(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const root = asRecord(parsed);
    const candidates = Array.isArray(parsed)
      ? parsed
      : root && Array.isArray(root.messages)
        ? root.messages
        : root && Array.isArray(root.data)
          ? root.data
          : [];
    for (const candidate of candidates) {
      const record = asRecord(candidate);
      if (record && isCustomerMessage(record)) {
        const text = messageText(record);
        if (text) return text;
      }
    }
  } catch {
    // Plain legacy logs remain visible in Message history, but do not expose
    // enough sender metadata to infer customer authorship safely.
  }
  return null;
}

export function resolveInquiryBody(
  inquiryBody: string | null,
  messageLogRaw: string | null,
  lastCustomerMessage: string | null,
): string {
  return inquiryBody?.trim()
    ? inquiryBody
    : (firstCustomerMessage(messageLogRaw) ?? lastCustomerMessage ?? "");
}
