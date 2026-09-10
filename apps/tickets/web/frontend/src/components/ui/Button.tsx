import type { ReactNode, ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

/* ------------------------------------------------------------------ */
/*  Button                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "danger" | "outline" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent-light focus-visible:ring-accent/50",
  secondary:
    "bg-surface text-text-muted border border-border hover:bg-gray-50 focus-visible:ring-accent/50",
  danger:
    "bg-danger text-white hover:bg-red-700 focus-visible:ring-danger/50",
  outline:
    "bg-transparent text-accent border border-accent hover:bg-accent-bg focus-visible:ring-accent/50",
  ghost:
    "bg-transparent text-text-muted hover:bg-gray-100 focus-visible:ring-accent/50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "text-xs px-3 py-1",
  md: "text-sm px-4 py-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      disabled={isDisabled}
      className={`
        inline-flex items-center justify-center gap-1.5 rounded-md font-medium
        transition-colors duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1
        disabled:pointer-events-none disabled:opacity-50
        ${variantClasses[variant]}
        ${sizeClasses[size]}
        ${className}
      `.trim()}
      {...rest}
    >
      {loading && <Spinner className="size-3.5 border-current" />}
      {children}
    </button>
  );
}
