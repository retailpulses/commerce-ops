import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ToastType = "info" | "success" | "error";

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

const ToastContext = createContext<ToastContextValue | null>(null);

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

interface ToastProviderProps {
  children: ReactNode;
}

const AUTO_DISMISS_MS = 2500;

const typeStyles: Record<ToastType, string> = {
  info: "bg-blue-50 border-blue-400 text-blue-800",
  success: "bg-success-bg border-success text-green-800",
  error: "bg-danger-bg border-danger text-red-800",
};

const typeIcons: Record<ToastType, string> = {
  info: "ℹ️",
  success: "✅",
  error: "❌",
};

export function ToastProvider({ children }: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = `toast-${++counterRef.current}`;
    setItems((prev) => [...prev, { id, message, type }]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-label="Notifications"
      >
        {items.map((item) => (
          <ToastNotification
            key={item.id}
            item={item}
            onRemove={remove}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Individual toast notification                                      */
/* ------------------------------------------------------------------ */

function ToastNotification({
  item,
  onRemove,
}: {
  item: ToastItem;
  onRemove: (id: string) => void;
}) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      // Wait for exit animation before unmounting
      setTimeout(() => onRemove(item.id), 200);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [item.id, onRemove]);

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => onRemove(item.id), 200);
  };

  return (
    <div
      className={`
        pointer-events-auto flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm shadow-md
        max-w-sm transition-all duration-200
        ${typeStyles[item.type]}
        ${exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"}
      `.trim()}
      role="alert"
    >
      <span className="shrink-0 text-base leading-none">{typeIcons[item.type]}</span>
      <span className="flex-1">{item.message}</span>
      <button
        onClick={handleDismiss}
        className="ml-1 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        aria-label="Dismiss"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="size-4"
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}
