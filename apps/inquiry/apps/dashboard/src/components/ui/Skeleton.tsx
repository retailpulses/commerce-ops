interface SkeletonProps {
  lines?: number;
  className?: string;
}

export default function Skeleton({ lines = 1, className = "" }: SkeletonProps) {
  return (
    <div className={`space-y-2 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-gray-200"
          style={{ width: i === lines - 1 && lines > 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}
