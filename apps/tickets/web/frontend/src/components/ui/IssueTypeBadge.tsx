interface IssueTypeBadgeProps {
  label: string;
  onRemove?: () => void;
  className?: string;
}

export function IssueTypeBadge({
  label,
  onRemove,
  className = "",
}: IssueTypeBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-accent-bg px-2.5 py-0.5 text-xs font-medium text-accent ${className}`}
    >
      {label}
      {onRemove && (
        <button
          onClick={onRemove}
          className="inline-flex items-center justify-center rounded-full p-0.5 hover:bg-accent/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={`Remove ${label}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="size-3"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
    </span>
  );
}
