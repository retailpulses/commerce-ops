export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div className="bg-[#ffebee] text-[#d32f2f] px-4 py-3 rounded-md mb-3 text-sm flex justify-between items-center">
      <span>{message}</span>
      <button onClick={onDismiss} className="ml-3 text-[#d32f2f] font-bold text-lg leading-none">
        ×
      </button>
    </div>
  );
}
