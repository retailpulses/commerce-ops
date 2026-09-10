import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  message: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  message,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 py-12 px-4 ${className}`}
    >
      {icon && (
        <div className="text-text-xs/60">{icon}</div>
      )}
      <p className="text-text-muted text-sm text-center max-w-xs">{message}</p>
      {action && <div>{action}</div>}
    </div>
  );
}
