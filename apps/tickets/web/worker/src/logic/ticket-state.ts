import type { TemplateBehavior } from "../types";

export const STATUS_OPEN = "Open";
export const STATUS_AWAITING_CUSTOMER_FORM = "Awaiting Customer Form";
export const STATUS_CUSTOMER_FORM_RECEIVED = "Customer Form Received";
export const CLOSED_WORKFLOW_STATUSES = new Set(["Closed Resolved", "Closed Unresolved"]);

export type WorkflowRoute = "ticket_handling" | "order_mgmt" | "ignore";

export interface WorkflowTransitionArgs {
  orderStatus: string | null | undefined;
  existingStatus: string | null;
  cls: string;
  subcls: string;
  isFugai: boolean;
  operatorActionRequired: boolean;
  sellerRepliedAfterLatestBuyer: boolean;
}

export interface WorkflowTransition {
  status: string | null;
  shouldWriteTicket: boolean;
  shouldCreateTicket: boolean;
  shouldReopen: boolean;
  shouldPreserveClosed: boolean;
  route: WorkflowRoute;
  reason: string;
}

export interface NeedsReplyArgs {
  workflowStatus: string | null;
  behavior: TemplateBehavior | "none";
  wasSent: boolean;
  wasSkipped: boolean;
}

export function normalizeOrderTxId(orderId: unknown): string | null {
  const raw = String(orderId || "").trim();
  if (!raw) return null;
  return raw.replace(/^order[_-]/i, "") || null;
}

export function isTicketScope(orderStatus: string | null | undefined): boolean {
  return orderStatus === "COMPLETED";
}

function isClosedStatus(status: string | null): boolean {
  return !!status && CLOSED_WORKFLOW_STATUSES.has(status);
}

function activeStatusForClassification(args: WorkflowTransitionArgs): { status: string | null; reason: string } {
  if (args.cls === "delivery_request") {
    return { status: null, reason: "delivery_request_report_only" };
  }

  if (args.cls === "real_ticket" && args.subcls === "quality_issue") {
    if (args.existingStatus === STATUS_CUSTOMER_FORM_RECEIVED) {
      return { status: STATUS_CUSTOMER_FORM_RECEIVED, reason: "preserve_form_received" };
    }
    return { status: STATUS_AWAITING_CUSTOMER_FORM, reason: "quality_issue_awaiting_form" };
  }

  if (args.operatorActionRequired) {
    return { status: STATUS_OPEN, reason: "operator_action_required" };
  }

  if (args.cls === "greeting_only" || args.cls === "information-only") {
    if (args.existingStatus) {
      return { status: args.existingStatus, reason: "preserve_existing_for_greeting_or_info" };
    }
    return { status: null, reason: "closeable_message_no_ticket" };
  }

  if (
    args.isFugai ||
    args.operatorActionRequired ||
    args.cls === "real_ticket" ||
    args.cls === "suspicious"
  ) {
    return { status: STATUS_OPEN, reason: "actionable_aftersales" };
  }

  return { status: null, reason: "not_actionable" };
}

export function deriveWorkflowTransition(args: WorkflowTransitionArgs): WorkflowTransition {
  if (!isTicketScope(args.orderStatus)) {
    const actionable = args.operatorActionRequired || args.cls === "real_ticket" || args.cls === "suspicious";
    return {
      status: null,
      shouldWriteTicket: false,
      shouldCreateTicket: false,
      shouldReopen: false,
      shouldPreserveClosed: false,
      route: actionable || args.cls === "delivery_request" ? "order_mgmt" : "ignore",
      reason: `out_of_scope_${args.orderStatus || "unknown"}`,
    };
  }

  if (args.cls === "delivery_request") {
    return {
      status: null,
      shouldWriteTicket: false,
      shouldCreateTicket: false,
      shouldReopen: false,
      shouldPreserveClosed: false,
      route: "order_mgmt",
      reason: "delivery_request_report_only",
    };
  }

  const existingIsClosed = isClosedStatus(args.existingStatus);
  const desired = activeStatusForClassification(args);

  if (existingIsClosed && args.sellerRepliedAfterLatestBuyer) {
    return {
      status: args.existingStatus,
      shouldWriteTicket: true,
      shouldCreateTicket: false,
      shouldReopen: false,
      shouldPreserveClosed: true,
      route: "ticket_handling",
      reason: "closed_preserved_seller_replied_after_buyer",
    };
  }

  if (existingIsClosed && desired.status) {
    // Reopen only when the desired status is a non-closed status.
    // If desired.status is still a closed status (e.g. greeting_only
    // preserving the existing closed status), treat it as preserve-closed.
    if (!isClosedStatus(desired.status)) {
      return {
        status: desired.status,
        shouldWriteTicket: true,
        shouldCreateTicket: false,
        shouldReopen: true,
        shouldPreserveClosed: false,
        route: "ticket_handling",
        reason: `closed_reopened_${desired.reason}`,
      };
    }
    return {
      status: args.existingStatus,
      shouldWriteTicket: true,
      shouldCreateTicket: false,
      shouldReopen: false,
      shouldPreserveClosed: true,
      route: "ticket_handling",
      reason: `closed_preserved_${desired.reason}`,
    };
  }

  if (args.existingStatus) {
    return {
      status: desired.status || args.existingStatus,
      shouldWriteTicket: true,
      shouldCreateTicket: false,
      shouldReopen: false,
      shouldPreserveClosed: false,
      route: "ticket_handling",
      reason: desired.reason,
    };
  }

  // Classification is advisory before a ticket exists. Only an authenticated
  // operator command or validated TicketForm finalization may create one.
  return {
    status: null,
    shouldWriteTicket: false,
    shouldCreateTicket: false,
    shouldReopen: false,
    shouldPreserveClosed: false,
    route: desired.status ? "ticket_handling" : "ignore",
    reason: desired.status ? `manual_creation_recommended_${desired.reason}` : desired.reason,
  };
}

export function deriveNeedsReply(args: NeedsReplyArgs): boolean {
  if (!args.workflowStatus || isClosedStatus(args.workflowStatus)) return false;

  switch (args.behavior) {
    case "informational_ack":
      return false;
    case "holding_ack":
      return true;
    case "form_request":
      return args.wasSkipped || !args.wasSent;
    case "cancel_fee":
    case "custom":
      return true;
    case "none":
      return false;
    default:
      return true;
  }
}
