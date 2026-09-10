// Shared Ops Portal navigation (Issue 60).
//
// The OrderMgmt portal is one of several sibling "Ops Portals" hosted under
// distinct canonical paths on the same ops host (ops.homesbliss.net):
//   /inquiry/  — customer inquiry portal
//   /tickets/  — support ticket portal
//   /order/    — this portal (order management)
//
// The contract is machine-verified by the portal-acceptance gate:
//   aria-label="Operations portals"  data-ops-nav-version="1"
// Do not change these attributes without updating the acceptance contract.

const OPS_PORTALS = [
  { href: "/inquiry/", label: "Inquiry" },
  { href: "/tickets/", label: "Tickets" },
  { href: "/order/", label: "Order" },
] as const;

export function OpsNav() {
  return (
    <nav
      aria-label="Operations portals"
      data-ops-nav-version="1"
      className="flex items-center gap-1"
    >
      {OPS_PORTALS.map((portal) => (
        <a
          key={portal.href}
          href={portal.href}
          aria-current={portal.href === "/order/" ? "page" : undefined}
          className="px-3 py-1 rounded text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {portal.label}
        </a>
      ))}
    </nav>
  );
}
