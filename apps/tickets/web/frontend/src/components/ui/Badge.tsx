/* ------------------------------------------------------------------ */
/*  Badge — generic colorable badge (used by classification etc.)      */
/* ------------------------------------------------------------------ */

interface BadgeProps {
  children: React.ReactNode;
  className?: string;
}

export function Badge({ children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  PlatformBadge                                                      */
/* ------------------------------------------------------------------ */

type Platform = "mercari" | "amazon" | "rakuten" | (string & {});

interface PlatformBadgeProps {
  platform: Platform;
  className?: string;
}

const platformStyles: Record<string, string> = {
  mercari: "bg-blue-100 text-indigo-700",
  amazon: "bg-amber-100 text-amber-700",
  rakuten: "bg-red-100 text-red-700",
};

export function PlatformBadge({ platform, className = "" }: PlatformBadgeProps) {
  const colors = platformStyles[platform] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors} ${className}`}
    >
      {platform.charAt(0).toUpperCase() + platform.slice(1)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  StatusBadge                                                        */
/* ------------------------------------------------------------------ */

type TicketStatus =
  | "open"
  | "in_progress"
  | "pending_customer"
  | "resolved"
  | "closed"
  | (string & {});

interface StatusBadgeProps {
  status: TicketStatus;
  className?: string;
}

const statusStyles: Record<string, string> = {
  open: "bg-blue-100 text-blue-700",
  in_progress: "bg-indigo-100 text-indigo-700",
  pending_customer: "bg-amber-100 text-amber-700",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-gray-100 text-gray-600",
};

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  pending_customer: "Pending Customer",
  resolved: "Resolved",
  closed: "Closed",
};

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const colors = statusStyles[status] ?? "bg-gray-100 text-gray-600";
  const label = statusLabels[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors} ${className}`}
    >
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  PriorityBadge                                                      */
/* ------------------------------------------------------------------ */

type PriorityLevel = "urgent" | "high" | "normal" | "low" | (string & {});

interface PriorityBadgeProps {
  priority: PriorityLevel;
  className?: string;
}

const priorityColors: Record<string, string> = {
  urgent: "bg-danger",
  high: "bg-warning",
  normal: "bg-gray-400",
  low: "bg-gray-200",
};

const priorityLabels: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export function PriorityBadge({ priority, className = "" }: PriorityBadgeProps) {
  const dotColor = priorityColors[priority] ?? "bg-gray-400";
  const label = priorityLabels[priority] ?? priority;
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className}`}>
      <span className={`inline-block size-2 rounded-full ${dotColor}`} />
      <span className="text-text-muted text-xs font-medium">{label}</span>
    </span>
  );
}
