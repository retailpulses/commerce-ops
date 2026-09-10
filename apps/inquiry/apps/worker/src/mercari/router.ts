import type {
  MercariTarget,
  RouteDecision,
  RouteTarget,
} from "./types";

/**
 * Domain router: decide whether a readback inquiry is presales (inquiry cohort),
 * post-order (ticketing), or must be quarantined.
 *
 * `InquiryOrderTransactionTarget.orderTransaction` is the routing authority.
 * A regex-derived order id is only a hint; when it conflicts with a
 * product/shop target we fail closed to quarantine rather than risk an
 * order thread entering the presales portal.
 */
export function routeInquiryTarget(
  target: MercariTarget | null | undefined,
  orderIdHint?: string | null,
): RouteDecision {
  const typename = target?.__typename ?? "";
  const hasOrderTransaction = Boolean(target?.orderTransaction);

  if (typename === "InquiryOrderTransactionTarget" || hasOrderTransaction) {
    return { route: "ticketing", reason: "order_transaction_authority" };
  }

  if (typename === "InquiryProductTarget" || typename === "InquiryShopTarget") {
    if (orderIdHint) {
      return { route: "quarantine", reason: "order_id_hint_conflict" };
    }
    return { route: "inquiry" };
  }

  return { route: "quarantine", reason: `unknown_target:${typename || "missing"}` };
}

/** True when a decision keeps the thread in the presales inquiry cohort. */
export function isPresalesInquiry(decision: RouteDecision): boolean {
  return decision.route === "inquiry";
}

export const ROUTE_TARGETS: readonly RouteTarget[] = [
  "inquiry",
  "ticketing",
  "quarantine",
];
