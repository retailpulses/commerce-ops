interface SpinnerProps {
  className?: string;
}

export function Spinner({ className = "" }: SpinnerProps) {
  return (
    <span
      className={`inline-block size-5 rounded-full border-2 border-gray-300 border-t-accent animate-spin ${className}`}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </span>
  );
}
