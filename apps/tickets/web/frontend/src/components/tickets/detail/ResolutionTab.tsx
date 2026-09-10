import { useState } from "react";
import type { CreateResolutionInput, TicketResolutionAction } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { fmtDate } from "@/lib/utils";

const ACTIONS = [
  ["full_refund", "Full refund"],
  ["partial_refund", "Partial refund"],
  ["replacement", "Replacement"],
  ["return_request", "Return request"],
  ["address_change", "Address change"],
  ["cancel_order", "Cancel order"],
  ["information_only", "Information only"],
  ["seller_escalation", "Seller escalation"],
  ["platform_escalation", "Platform escalation"],
  ["no_action", "No action / waived"],
] as const;

interface Props {
  actions: TicketResolutionAction[];
  isSaving: boolean;
  onRecord: (input: CreateResolutionInput) => Promise<void>;
}

export function ResolutionTab({ actions, isSaving, onRecord }: Props) {
  const [actionType, setActionType] = useState("information_only");
  const [amount, setAmount] = useState("");
  const [replacementSku, setReplacementSku] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [closeTicket, setCloseTicket] = useState(true);
  const [operationId, setOperationId] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const currentOperationId = operationId ?? crypto.randomUUID();
    setOperationId(currentOperationId);
    await onRecord({
      operation_id: currentOperationId,
      action_type: actionType,
      amount: amount ? Number(amount) : null,
      currency: "JPY",
      replacement_sku: replacementSku || null,
      quantity: actionType === "replacement" ? Number(quantity || 1) : null,
      reason: reason || null,
      external_reference: externalReference || null,
      close_ticket: closeTicket,
    });
    setOperationId(null);
    setReason("");
    setExternalReference("");
  };

  return (
    <div className="flex flex-col divide-y divide-border">
      <form onSubmit={submit} className="p-4 grid grid-cols-2 gap-3">
        <label className="text-xs text-text-muted col-span-2">
          Outcome
          <select className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={actionType} onChange={(e) => { setOperationId(null); setActionType(e.target.value); }}>
            {ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {(actionType === "full_refund" || actionType === "partial_refund") && (
          <label className="text-xs text-text-muted">Amount (JPY)<input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" type="number" min="0" value={amount} onChange={(e) => { setOperationId(null); setAmount(e.target.value); }} /></label>
        )}
        {actionType === "replacement" && <>
          <label className="text-xs text-text-muted">Replacement SKU<input required className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" value={replacementSku} onChange={(e) => { setOperationId(null); setReplacementSku(e.target.value); }} /></label>
          <label className="text-xs text-text-muted">Quantity<input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" type="number" min="1" value={quantity} onChange={(e) => { setOperationId(null); setQuantity(e.target.value); }} /></label>
        </>}
        <label className="text-xs text-text-muted col-span-2">Reason / notes<textarea required={actionType === "no_action"} className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" rows={3} value={reason} onChange={(e) => { setOperationId(null); setReason(e.target.value); }} /></label>
        <label className="text-xs text-text-muted col-span-2">External reference<input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Refund, return, or platform reference" value={externalReference} onChange={(e) => { setOperationId(null); setExternalReference(e.target.value); }} /></label>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={closeTicket} onChange={(e) => { setOperationId(null); setCloseTicket(e.target.checked); }} />Close ticket and clear reply-needed state</label>
        <div className="col-span-2"><Button type="submit" loading={isSaving} disabled={isSaving}>Record outcome</Button></div>
      </form>
      <div className="divide-y divide-border">
        {actions.length === 0 && <p className="text-sm text-text-muted text-center py-8">No resolution outcome recorded.</p>}
        {actions.map((action) => (
          <div key={action.id} className="px-4 py-3 text-sm">
            <div className="flex justify-between gap-3"><strong>{ACTIONS.find(([key]) => key === action.action_type)?.[1] ?? action.action_type}</strong><span className="text-xs text-text-muted">{fmtDate(action.created_at)}</span></div>
            {(action.amount !== null || action.replacement_sku) && <p className="text-text-muted mt-1">{action.amount !== null ? `${action.amount.toLocaleString()} ${action.currency}` : ""}{action.replacement_sku ? `Replacement: ${action.replacement_sku} × ${action.quantity ?? 1}` : ""}</p>}
            {action.reason && <p className="mt-1 whitespace-pre-wrap">{action.reason}</p>}
            {action.external_reference && <p className="text-xs text-text-muted mt-1">Reference: {action.external_reference}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
