interface PaginationProps {
  page: number;
  hasMore: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export function Pagination({ page, hasMore, onPrev, onNext }: PaginationProps) {
  return (
    <div className="flex items-center justify-center gap-3 py-3">
      <button
        onClick={onPrev}
        disabled={page <= 1}
        className="px-4 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 disabled:opacity-40 enabled:hover:bg-gray-100 dark:enabled:hover:bg-gray-700"
      >
        ← Previous
      </button>
      <span className="text-sm text-gray-500 dark:text-gray-400">Page {page}</span>
      <button
        onClick={onNext}
        disabled={!hasMore}
        className="px-4 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 disabled:opacity-40 enabled:hover:bg-gray-100 dark:enabled:hover:bg-gray-700"
      >
        Next →
      </button>
    </div>
  );
}
