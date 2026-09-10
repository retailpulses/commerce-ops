const NON_MEMO_AUDIT_PATTERNS = [
  /^\[[^\]]+\]\s+PORTAL_OPERATOR:\s+sent reply to customer \(\d+ chars\)\s+—\s+see Messages$/,
  /^\[[^\]]+\]\s+PORTAL_OPERATOR:\s+AI-polished reply draft \(.*\)\s+\[see AI copywrite log\]$/,
];

const RMS_REMARKS_START = "[ingest] RMSお客様備考:";
const RMS_REMARKS_END = "[ingest] RMSお客様備考ここまで";

export type TimestampedMemo = {
  timestamp: string;
  author: string;
  body: string;
};

/** Parse only a single-line operator memo; managed multiline blocks render verbatim. */
export function parseTimestampedMemo(value: string): TimestampedMemo | null {
  if (value.includes("\n")) return null;
  const match = value.match(/^\[([0-9][^\]]*)\]\s*(\S+):\s*(.+)$/);
  if (!match) return null;
  return { timestamp: match[1], author: match[2], body: match[3] };
}

/** Keep customer-communication audit events out of the operator memo surface. */
export function manualMemoLines(value: string): string[] {
  const entries: string[] = [];
  const lines = value.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (line.trim() === RMS_REMARKS_START) {
      const endIndex = lines.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && candidate.trim() === RMS_REMARKS_END,
      );
      if (endIndex > index) {
        entries.push(lines.slice(index, endIndex + 1).join("\n"));
        index = endIndex;
        continue;
      }
    }

    if (!NON_MEMO_AUDIT_PATTERNS.some((pattern) => pattern.test(line.trim()))) {
      entries.push(line);
    }
  }

  return entries;
}
