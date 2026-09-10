import type { RiskBadge } from "@/types/orders";

const severityColors: Record<string, string> = {
  critical: "bg-[#ffebee] text-[#d32f2f]",
  warning: "bg-[#fff3e0] text-[#f57c00]",
  info: "bg-[#e3f2fd] text-[#1976d2]",
  payment: "bg-[#ede7f6] text-[#4527a0]",
  fee: "bg-[#fff3e0] text-[#e65100]",
};

export function Badge({ badge }: { badge: RiskBadge }) {
  return (
    <span
      className={`inline-block px-1.5 py-px rounded-full text-[11px] font-semibold mr-1 whitespace-nowrap ${severityColors[badge.severity] || "bg-gray-100 text-gray-600"}`}
    >
      {badge.label}
    </span>
  );
}

export function UnreadBadge() {
  return (
    <span className="inline-block px-1.5 py-px rounded-full text-[11px] font-bold mr-1 whitespace-nowrap bg-[#dbeafe] text-[#1d4ed8]">
      unread
    </span>
  );
}

export function CheckPendingBadge() {
  return (
    <span className="inline-block px-1.5 py-px rounded-full text-[11px] font-bold mr-1 whitespace-nowrap bg-[#fef3c7] text-[#92400e]">
      check pending
    </span>
  );
}
