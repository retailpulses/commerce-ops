export function Spinner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`inline-block w-5 h-5 border-2 border-gray-300 border-t-[#1565c0] rounded-full animate-spin ${className}`}
    />
  );
}
