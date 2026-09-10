export function canRunAiCopywrite(replyText: string, isPending: boolean): boolean {
  return !isPending && replyText.trim().length > 0;
}

export function buildAiCopywriteRequest(replyText: string): { draft: string } {
  return { draft: replyText.trim() };
}
