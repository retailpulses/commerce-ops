export const TICKETFORM_TOKEN_VALIDITY_DAYS = 7;
export const TICKETFORM_TOKEN_VALIDITY_MS =
  TICKETFORM_TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

export const TICKETFORM_MESSAGE_VALIDITY_NOTICE =
  `※本フォームはリンク発行から${TICKETFORM_TOKEN_VALIDITY_DAYS}日間有効です。一度送信すると再利用できません。`;

export function ticketFormExpiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + TICKETFORM_TOKEN_VALIDITY_MS).toISOString();
}

export function formatTicketFormExpiryJst(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function ticketFormValidityCopy(expiresAt: string): string {
  const formatted = formatTicketFormExpiryJst(expiresAt);
  return formatted
    ? `有効期限：${formatted}（日本時間）／一度送信すると再利用できません。`
    : TICKETFORM_MESSAGE_VALIDITY_NOTICE;
}
