import type { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
  onTemplatesClick?: () => void;
}

export default function Layout({ children, onTemplatesClick }: LayoutProps) {
  return (
    <div className="flex h-[calc(100vh-2.75rem)] flex-col bg-gray-50">
      {/* Header */}
      <header className="flex h-14 flex-shrink-0 items-center border-b border-gray-200 bg-white px-4">
        <h1 className="text-base font-semibold text-gray-900">Inquiry Portal</h1>
        <span className="ml-3 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
          MVP
        </span>

        <div className="ml-auto flex items-center gap-2">
          {onTemplatesClick && (
            <button
              type="button"
              onClick={onTemplatesClick}
              className="rounded-md border border-gray-200 px-3 py-1 text-xs text-gray-600
                hover:bg-gray-100 transition-colors"
            >
              Templates
            </button>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
