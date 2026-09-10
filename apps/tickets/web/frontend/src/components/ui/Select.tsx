import type { SelectHTMLAttributes } from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({
  label,
  error,
  options,
  placeholder,
  id,
  className = "",
  ...rest
}: SelectProps) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={selectId}
          className="text-text-muted text-sm font-medium"
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`
          w-full rounded-md border bg-surface px-3 py-2 text-sm text-text
          transition-colors duration-150
          focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
          disabled:cursor-not-allowed disabled:opacity-50
          [&>option]:text-text
          ${error ? "border-danger" : "border-border"}
          ${className}
        `.trim()}
        aria-invalid={!!error}
        aria-describedby={error ? `${selectId}-error` : undefined}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${selectId}-error`} className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
