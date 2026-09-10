import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import type { PresaleGroup } from "@/types/orders";

export const presaleKeys = {
  all: ["presale"] as const,
  list: () => ["presale", "list"] as const,
};

export function usePresaleQuery() {
  return useQuery({
    queryKey: presaleKeys.list(),
    queryFn: () =>
      apiGet<{ ok: boolean; count: number; results: PresaleGroup[] }>("/presale"),
    staleTime: 60_000,
  });
}

export function usePresaleMemoMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemCode, text }: { itemCode: string; text: string }) =>
      apiPatch<{ ok: boolean; restock_info: string }>(
        `/presale/${encodeURIComponent(itemCode)}/memo`,
        { text },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: presaleKeys.all }),
  });
}
