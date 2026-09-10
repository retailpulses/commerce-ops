import type { ReactNode } from "react";

interface PageHeaderProps {
  onLogout?: () => void;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({ onLogout, className = "", children }: PageHeaderProps) {
  return (
    <header
      className={`flex h-[52px] items-center justify-between bg-accent px-4 ${className}`}
    >
      <div className="flex items-center gap-3">
        <span className="text-white text-base font-semibold tracking-tight select-none">
          Homebliss Ticketing
        </span>
        {children}
      </div>
      {onLogout && (
        <button
          onClick={onLogout}
          className="text-white/80 hover:text-white text-sm font-medium transition-colors rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          Logout
        </button>
      )}
    </header>
  );
}
