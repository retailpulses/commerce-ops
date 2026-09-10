const LINKS = [
  { id: "inquiry", href: "/inquiry/", label: "Inquiry" },
  { id: "follow-ups", href: "/inquiry/?view=follow-ups", label: "Follow-ups" },
  { id: "order", href: "/order/", label: "Orders" },
  { id: "tickets", href: "/tickets/", label: "Tickets" },
] as const;

export default function OpsNavigation() {
  const isFollowUps =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("view") === "follow-ups";
  return (
    <nav
      aria-label="Operations portals"
      data-ops-nav-version="1"
      className="flex min-h-11 flex-shrink-0 items-center gap-1.5 bg-slate-900 px-3 text-sm text-white shadow-sm"
    >
      <span className="mr-1.5 font-bold">Ops</span>
      {LINKS.map((link) => {
        const active = link.id === (isFollowUps ? "follow-ups" : "inquiry");
        return (
          <a
            key={link.id}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-2.5 py-1.5 font-semibold no-underline ${
              active ? "bg-blue-600 text-white" : "text-blue-100 hover:bg-slate-800"
            }`}
          >
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
