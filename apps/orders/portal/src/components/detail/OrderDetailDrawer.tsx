import { useState, useEffect } from "react";
import { useOrderDetailQuery, useReviewMutation, useMemoMutation, useConfirmMutation, useCancelMutation } from "@/hooks/useOrders";
import { Spinner } from "@/components/shared/Spinner";
import { Badge } from "@/components/shared/Badge";
import { OrderInfo } from "@/components/detail/OrderInfo";
import { MarginBreakdown } from "@/components/detail/MarginBreakdown";
import { StockInfo } from "@/components/detail/StockInfo";
import { ShippingAddress } from "@/components/detail/ShippingAddress";
import { DeliveryPreferences } from "@/components/detail/DeliveryPreferences";
import { ProductManualFields } from "@/components/detail/ProductManualFields";
import { MemoLog } from "@/components/detail/MemoLog";
import { MessagesSection } from "@/components/detail/MessagesSection";
import { OrderLines } from "@/components/detail/OrderLines";

interface Props {
  orderId: string | null;
  onClose: () => void;
}

export function OrderDetailDrawer({ orderId, onClose }: Props) {
  const { data, isLoading, error, refetch } = useOrderDetailQuery(orderId);
  const reviewMutation = useReviewMutation();
  const confirmMutation = useConfirmMutation();
  const cancelMutation = useCancelMutation();
  const memoMutation = useMemoMutation();
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancellationReason, setCancellationReason] = useState("");

  const order = data?.order;
  const linkedOrders = data?.linked_orders;
  const orderLines = data?.order_lines || [];

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!orderId) return null;

  const handleReview = async (status: string) => {
    setFeedback(null);
    try {
      await reviewMutation.mutateAsync({ orderId, status });
      setFeedback({ msg: `Review status updated to: ${status}`, ok: true });
      refetch();
    } catch (e) {
      setFeedback({ msg: `Failed: ${(e as Error).message}`, ok: false });
    }
  };

  const handleConfirm = async () => {
    setFeedback(null);
    try {
      await confirmMutation.mutateAsync({ orderId });
      setFeedback({ msg: "RMS confirmation requested", ok: true });
      refetch();
    } catch (e) {
      setFeedback({ msg: `Confirm failed: ${(e as Error).message}`, ok: false });
    }
  };

  const handleCancel = async () => {
    const reason = cancellationReason.trim();
    if (!reason) return;
    setFeedback(null);
    try {
      await cancelMutation.mutateAsync({ orderId, cancellationReason: reason });
      setShowCancelDialog(false);
      setCancellationReason("");
      setFeedback({ msg: "Order marked cancelled", ok: true });
      refetch();
    } catch (e) {
      setFeedback({ msg: `Cancel failed: ${(e as Error).message}`, ok: false });
    }
  };

  const handleAddMemo = async (text: string) => {
    setFeedback(null);
    try {
      const result = await memoMutation.mutateAsync({ orderId, text });
      if (result.ok) {
        setFeedback({ msg: "Memo added", ok: true });
        if (result.order_comments && order) {
          order.order_comments = result.order_comments;
          order.review_memo_log = result.order_comments;
        }
        refetch();
      }
    } catch (e) {
      setFeedback({ msg: `Error: ${(e as Error).message}`, ok: false });
    }
  };

  const currentStatus = order?.review_status || "";
  const orderStatus = order?.order_status || "";
  const shipmentSyncStatus = order?.shipment_sync_status || "";
  const isLifecycleTerminal = ["COMPLETED", "CANCELED", "CANCELING"].includes(orderStatus);
  const isReviewCanceled = currentStatus === "Canceled";
  const isAlreadySynced = shipmentSyncStatus === "Synced" || shipmentSyncStatus === "Already Exists";
  const isMercari = order?.sales_channel === "mercari";
  const isRakuten = order?.sales_channel === "rakuten";
  const rakutenCanConfirm = isRakuten &&
    order?.rakuten_status_mapping_state === "MAPPED" &&
    ["100", "200", "400", "600", "ORDER_ACCEPTED", "ORDER_IN_PROGRESS"].includes(order?.rakuten_order_progress || "") &&
    ["PENDING_CONFIRMATION", "WAITING_FOR_PAYMENT"].includes(orderStatus) &&
    order?.rms_confirm_result !== "confirmed";
  const hideReviewActions = isLifecycleTerminal || isReviewCanceled || (isRakuten && !order?.rakuten_shipment_ready);
  const needsPriceConfirmation = (order?.cogs_price_match_lines?.length || 0) > 0;
  const canAddOrderLines = !isLifecycleTerminal && !["Approved", "Auto-Approved"].includes(currentStatus);

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-black/30 z-50 transition-opacity ${orderId ? "opacity-100 visible" : "opacity-0 invisible"}`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-[640px] max-w-full bg-white shadow-xl z-50 flex flex-col transition-transform ${
          orderId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-bold">Order {order?.order_id || ""}</h2>
          <button onClick={onClose} className="text-gray-500 text-xl leading-none hover:text-gray-800">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {isLoading && (
            <div className="text-center py-10">
              <Spinner />
            </div>
          )}
          {error && (
            <p className="text-[#d32f2f]">Failed to load: {(error as Error).message}</p>
          )}
          {order && (
            <>
              {/* Risk badges */}
              {order.risk_badges.length > 0 && (
                <section className="mb-5">
                  <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">Risk Flags</h3>
                  {order.risk_badges.map((b, i) => (
                    <Badge key={i} badge={b} />
                  ))}
                </section>
              )}

              {order.is_fee_row && (
                <section className="mb-3">
                  <span className="inline-block px-1.5 py-px rounded-full text-[11px] font-semibold bg-[#e3f2fd] text-[#1976d2]">
                    Fee/Adjustment Row
                  </span>
                </section>
              )}

              {/* Linked orders */}
              {linkedOrders && linkedOrders.length > 0 && (
                <section className="mb-5">
                  <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">
                    {order.is_fee_row ? "Linked Main Orders" : "Linked Fee Orders"}
                  </h3>
                  {linkedOrders.map((lo) => (
                    <div key={lo.id} className="flex justify-between items-center px-2.5 py-2 border-l-3 border-gray-200 bg-gray-50 rounded-r-md mb-2 text-sm">
                      <span>
                        <code className="cursor-pointer underline text-xs">{lo.order_id}</code>{" "}
                        {lo.is_fee ? "ℹ " : ""}{lo.product_name || lo.order_id}
                      </span>
                      <span className="text-[11px] font-semibold">{lo.order_status}</span>
                    </div>
                  ))}
                </section>
              )}

              <OrderLines orderId={order.portal_target_id || order.order_id} lines={orderLines} onRefetch={() => refetch()} canAdd={canAddOrderLines} />

              <OrderInfo order={order} onRefetch={() => refetch()} showLineEditors={false} />

              {isRakuten && (
                <section className="mb-5 rounded border border-gray-200 bg-gray-50 px-3 py-3 text-sm">
                  <h3 className="mb-2 text-xs uppercase tracking-wider text-gray-400">Rakuten RMS Status</h3>
                  <div>Raw orderProgress: <strong>{order.rakuten_order_progress || "Missing"}</strong></div>
                  <div>Mapping: <strong>{order.rakuten_status_mapping_state || "Missing"}</strong></div>
                  <div>RMS confirmation: <strong>{order.rms_confirm_result || "Not requested"}</strong></div>
                  <div>Fulfillment ready: <strong>{order.rakuten_shipment_ready ? "Yes" : "No"}</strong></div>
                  {order.rakuten_blocking_reason && (
                    <div className="mt-2 text-[#b45309]" role="status">Blocked: {order.rakuten_blocking_reason}</div>
                  )}
                </section>
              )}

              <MarginBreakdown order={order} />

              <StockInfo order={order} />

              <ProductManualFields order={order} onRefetch={() => refetch()} />

              <ShippingAddress order={order} onRefetch={() => refetch()} />

              <DeliveryPreferences order={order} onRefetch={() => refetch()} />

              <MemoLog order={order} onAddMemo={handleAddMemo} />

              <MessagesSection orderId={orderId} />

              {/* Global feedback */}
              {feedback && (
                <div className={`mt-3 text-sm ${feedback.ok ? "text-[#388e3c]" : "text-[#d32f2f]"}`}>
                  {feedback.msg}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {order && (
          <div className="px-5 py-3 border-t border-gray-200 flex-shrink-0 bg-white">
            {needsPriceConfirmation && (
              <div className="mb-2 rounded border border-[#f97316] bg-[#fff7ed] px-3 py-2 text-sm font-bold text-[#9a3412]" role="alert">
                ⚠ Confirm or negotiate the supplier price before approval or purchase.
              </div>
            )}
            <div className="flex gap-2">
              {rakutenCanConfirm && (
                <button
                  onClick={handleConfirm}
                  disabled={confirmMutation.isPending}
                  className="px-5 py-2 bg-[#1565c0] text-white border-none rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
                >
                  {confirmMutation.isPending ? "Confirming..." : "Confirm Order"}
                </button>
              )}
              {!hideReviewActions && currentStatus !== "Approved" && currentStatus !== "Auto-Approved" && (
                <button
                  onClick={() => handleReview("Approved")}
                  disabled={reviewMutation.isPending}
                  className="px-5 py-2 bg-[#388e3c] text-white border-none rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
                >
                  ✓ Approve
                </button>
              )}
              {!hideReviewActions && currentStatus !== "On Hold" && (
                <button
                  onClick={() => handleReview("On Hold")}
                  disabled={reviewMutation.isPending}
                  className="px-5 py-2 bg-[#f57c00] text-white border-none rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
                >
                  ⏸ Put on Hold
                </button>
              )}
              {isMercari && !hideReviewActions && !isAlreadySynced && (
                <button
                  onClick={() => setShowCancelDialog(true)}
                  disabled={cancelMutation.isPending}
                  className="px-5 py-2 bg-[#d32f2f] text-white border-none rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
                >
                  {cancelMutation.isPending ? "Cancelling..." : "✕ Cancel"}
                </button>
              )}
            </div>
            {isMercari && isAlreadySynced && !isReviewCanceled && (
              <p className="mt-2 text-xs text-[#f57c00]">
                Already pushed to Giga — cancel manually in Giga/Mercari.
              </p>
            )}
          </div>
        )}
      </div>

      {showCancelDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold">Cancel order</h3>
            <p className="mt-2 text-sm text-gray-600">
              After cancelling, this order can no longer be approved. In-shop cancellation remains manual in Mercari admin.
            </p>
            <label className="mt-4 block text-sm font-semibold" htmlFor="cancellation-reason">Cancellation reason</label>
            <textarea
              id="cancellation-reason"
              autoFocus
              required
              maxLength={2000}
              rows={4}
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              placeholder="Enter the reason for cancellation"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-[#d32f2f] focus:outline-none"
            />
            <div className="mt-1 text-right text-xs text-gray-400">{cancellationReason.length}/2000</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => { setShowCancelDialog(false); setCancellationReason(""); }} disabled={cancelMutation.isPending} className="rounded border border-gray-300 px-4 py-2 text-sm">
                Keep order
              </button>
              <button type="button" onClick={handleCancel} disabled={cancelMutation.isPending || !cancellationReason.trim()} className="rounded bg-[#d32f2f] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {cancelMutation.isPending ? "Cancelling..." : "Confirm cancellation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
