import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch } from "@/lib/api";
import type {
  OrderRow,
  OrderDetail,
  FeeOrderRow,
  Summary,
  ListResponse,
  OrderFilters,
  PaginationParams,
  LinkedOrder,
} from "@/types/orders";

// ── Query key factory ──────────────────────────────────────

export const orderKeys = {
  all: ["orders"] as const,
  list: (filters: OrderFilters & PaginationParams) => ["orders", "list", filters] as const,
  detail: (orderId: string) => ["orders", "detail", orderId] as const,
  summary: (filters?: Record<string, string | undefined>) => ["orders", "summary", filters] as const,
  feeOrders: (params: Record<string, string | number | undefined>) => ["orders", "fee", params] as const,
};

// ── Summary ────────────────────────────────────────────────

export function useSummaryQuery(filters?: Record<string, string | undefined>) {
  return useQuery({
    queryKey: orderKeys.summary(filters),
    queryFn: () => apiGet<Summary>("/summary", filters),
    staleTime: 30_000,
  });
}

// ── Order list ─────────────────────────────────────────────

export function useOrdersQuery(filters: OrderFilters, pagination: PaginationParams) {
  return useQuery({
    queryKey: orderKeys.list({ ...filters, ...pagination }),
    queryFn: () =>
      apiGet<ListResponse<OrderRow>>("/orders", {
        ...filters,
        ...pagination,
      }),
    staleTime: 30_000,
    // Don't show stale data from previous filter selection —
    // it's confusing when filters change and old results include
    // orders that don't match the new filter params.
  });
}

// ── Order detail ───────────────────────────────────────────

export function useOrderDetailQuery(orderId: string | null) {
  return useQuery({
    queryKey: orderKeys.detail(orderId || ""),
    queryFn: () =>
      apiGet<{ ok: boolean; order: OrderDetail; order_lines?: import("@/types/orders").OrderLine[]; linked_orders?: LinkedOrder[] }>(
        `/orders/${encodeURIComponent(orderId!)}`,
      ),
    enabled: !!orderId,
    staleTime: 60_000,
  });
}

// ── Review mutation ────────────────────────────────────────

export function useReviewMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: string }) =>
      apiPatch<{ ok: boolean; previous_status: string }>(
        `/orders/${encodeURIComponent(orderId)}/review`,
        { status },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Memo mutation ──────────────────────────────────────────

export function useMemoMutation() {
  return useMutation({
    mutationFn: ({ orderId, text }: { orderId: string; text: string }) =>
      apiPatch<{ ok: boolean; order_comments: string }>(
        `/orders/${encodeURIComponent(orderId)}/memo`,
        { text },
      ),
  });
}

// ── B2B code mutation ─────────────────────────────────────

export function useB2bCodeMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, row_id, b2b_item_code }: { orderId: string; row_id?: string | number; b2b_item_code: string }) =>
      apiPatch<{ ok: boolean; order: OrderDetail | null }>(
        `/orders/${encodeURIComponent(orderId)}/b2b-code`,
        { row_id, b2b_item_code },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Quantity mutation ─────────────────────────────────────

export function useQuantityMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, row_id, quantity }: { orderId: string; row_id?: string | number; quantity: number }) =>
      apiPatch<{ ok: boolean; order: OrderDetail | null }>(
        `/orders/${encodeURIComponent(orderId)}/quantity`,
        { row_id, quantity },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

export function useAddOrderLineMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, b2b_item_code, quantity }: { orderId: string; b2b_item_code: string; quantity: number }) =>
      apiPost<{ ok: boolean; order_line: import("@/types/orders").OrderLine }>(
        `/orders/${encodeURIComponent(orderId)}/lines`,
        { b2b_item_code, quantity },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: orderKeys.detail(variables.orderId) });
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Address mutation ──────────────────────────────────────

export function useAddressMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...fields }: { orderId: string } & Record<string, string>) =>
      apiPatch<{ ok: boolean; order: OrderDetail | null; updated_fields: string[] }>(
        `/orders/${encodeURIComponent(orderId)}/address`,
        fields,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Delivery preferences mutation ──────────────────────────

export function useDeliveryPrefsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      ...fields
    }: {
      orderId: string;
      requested_delivery_date?: string;
      requested_delivery_time?: string;
    }) =>
      apiPatch<{ ok: boolean; delivery_preferences_complete: boolean }>(
        `/orders/${encodeURIComponent(orderId)}/delivery-preferences`,
        fields,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Cancel mutation (Mercari) ─────────────────────────────

export function useCancelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, cancellationReason }: { orderId: string; cancellationReason: string }) =>
      apiPost<{ ok: boolean; order_id: string; review_status: string; previous_status: string; updated_lines: number | null; cancellation_reason: string }>(
        `/orders/${encodeURIComponent(orderId)}/cancel`,
        { cancellation_reason: cancellationReason },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Confirm mutation (Rakuten) ────────────────────────────

export function useConfirmMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      apiPost<{ ok: boolean; order_id: string; row_id: number; previous_status: string; order: OrderDetail | null }>(
        `/orders/${encodeURIComponent(orderId)}/confirm`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Product manual fields mutation ────────────────────────

export interface ManualFieldsPayload {
  manual_cost_price?: number | null;
  manual_presale_arrival_date?: string | null;
  presale_info_protect_until?: string | null;
}

export interface ManualFieldsResult {
  ok: boolean;
  item_code: string;
  manual_cost_price: number | null;
  manual_presale_arrival_date: string | null;
  presale_info_protect_until: string | null;
  effective_cost_price: number | null;
}

export function useProductManualFieldsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemCode, ...fields }: { itemCode: string } & ManualFieldsPayload) =>
      apiPatch<ManualFieldsResult>(
        `/products/${encodeURIComponent(itemCode)}/manual-fields`,
        fields,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Bulk approve ──────────────────────────────────────────

export function useBulkApproveMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderTargets: string[]) =>
      apiPost<{ ok: boolean; approved: number; skipped: number; failed: number }>(
        "/orders/bulk-approve",
        { order_targets: orderTargets },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

// ── Fee orders ─────────────────────────────────────────────

export function useFeeOrdersQuery(params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: orderKeys.feeOrders(params),
    queryFn: () => apiGet<ListResponse<FeeOrderRow>>("/fee-orders", params),
    staleTime: 30_000,
    // Don't show stale data from previous filter selection —
    // it's confusing when filters change and old results include
    // orders that don't match the new filter params.
  });
}
