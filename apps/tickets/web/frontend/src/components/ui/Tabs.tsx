interface Tab {
  key: string;
  label: string;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onTabChange, className = "" }: TabsProps) {
  return (
    <div className={`flex border-b border-border ${className}`} role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.key)}
            className={`
              relative px-4 py-2.5 text-sm font-medium transition-colors duration-150
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset
              ${isActive
                ? "text-accent"
                : "text-text-muted hover:text-text"
              }
            `.trim()}
          >
            {tab.label}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-t-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
