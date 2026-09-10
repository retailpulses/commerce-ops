import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import type { Template } from "@/types/orders";

export const templateKeys = {
  all: ["templates"] as const,
  list: () => ["templates", "list"] as const,
};

export function useTemplatesQuery() {
  return useQuery({
    queryKey: templateKeys.list(),
    queryFn: () =>
      apiGet<{ ok: boolean; templates: Template[] }>("/templates"),
    staleTime: 60_000,
  });
}

export function useTemplateCreateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; body: string }) =>
      apiPost<{ ok: boolean; template: Template }>("/templates", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}

export function useTemplateUpdateMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; title: string; body: string }) =>
      apiPut<{ ok: boolean; template: Template }>(`/templates/${encodeURIComponent(id)}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}

export function useTemplateDeleteMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ ok: boolean }>(`/templates/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}

export function useTemplateReorderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; direction: "up" | "down" }) =>
      apiPost<{ ok: boolean }>("/templates/reorder", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}
