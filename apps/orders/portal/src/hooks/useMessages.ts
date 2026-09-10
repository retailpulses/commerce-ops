import { useQuery, useMutation } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import type { Message } from "@/types/orders";

export const messageKeys = {
  order: (orderId: string) => ["messages", orderId] as const,
};

export function useMessagesQuery(orderId: string | null) {
  return useQuery({
    queryKey: messageKeys.order(orderId || ""),
    queryFn: () =>
      apiGet<{ ok: boolean; messages: Message[]; source?: string; stale?: boolean; warning?: string }>(
        `/orders/${encodeURIComponent(orderId!)}/messages`,
      ),
    enabled: !!orderId,
    staleTime: 60_000,
  });
}

export function useMarkReadMutation() {
  return useMutation({
    mutationFn: (orderId: string) =>
      apiPost(`/orders/${encodeURIComponent(orderId)}/messages/read`),
  });
}

export function useSendReplyMutation() {
  return useMutation({
    mutationFn: ({ orderId, text }: { orderId: string; text: string }) =>
      apiPost(`/orders/${encodeURIComponent(orderId)}/messages`, { text }),
  });
}

export function useGenerateAIReplyMutation() {
  return useMutation({
    mutationFn: ({ orderId, draft }: { orderId: string; draft: string }) =>
      apiPost<{ ok: boolean; draft: string }>(
        `/orders/${encodeURIComponent(orderId)}/generate-reply`,
        { draft },
      ),
  });
}
