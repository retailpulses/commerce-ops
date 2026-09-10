interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  rounded?: boolean;
  className?: string;
}

export function Skeleton({
  width,
  height = "1rem",
  rounded = false,
  className = "",
}: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-gray-200 ${rounded ? "rounded-full" : "rounded-md"} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
