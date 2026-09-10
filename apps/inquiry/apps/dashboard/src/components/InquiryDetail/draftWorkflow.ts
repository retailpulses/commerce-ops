export function captureReviewMessage(draft: string): string | null {
  const message = draft.trim();
  return message || null;
}

export function buildSendPayload(reviewMessage: string, followUpDueDate: string) {
  return {
    body: reviewMessage,
    followUpDueDate: followUpDueDate || null,
  };
}
