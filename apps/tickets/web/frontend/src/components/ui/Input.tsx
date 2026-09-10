import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({
  label,
  error,
  id,
  className = "",
  ...rest
}: InputProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={inputId}
          className="text-text-muted text-sm font-medium"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`
          w-full rounded-md border bg-surface px-3 py-2 text-sm text-text
          placeholder:text-text-xs
          transition-colors duration-150
          focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
          disabled:cursor-not-allowed disabled:opacity-50
          ${error ? "border-danger" : "border-border"}
          ${className}
        `.trim()}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...rest}
      />
      {error && (
        <p id={`${inputId}-error`} className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
