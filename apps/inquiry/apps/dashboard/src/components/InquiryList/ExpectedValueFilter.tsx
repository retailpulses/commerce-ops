import { useState, type FormEvent } from "react";

interface ExpectedValueFilterProps {
  min: number | null;
  max: number | null;
  onApply: (min: number | null, max: number | null) => void;
}

function parseBound(raw: string): { value: number | null; valid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, valid: true };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { value: null, valid: false };
  return { value: n, valid: true };
}

export default function ExpectedValueFilter({
  min,
  max,
  onApply,
}: ExpectedValueFilterProps) {
  const [draftMin, setDraftMin] = useState(min != null ? String(min) : "");
  const [draftMax, setDraftMax] = useState(max != null ? String(max) : "");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const minResult = parseBound(draftMin);
    const maxResult = parseBound(draftMax);
    if (!minResult.valid || !maxResult.valid) {
      setError("Enter a non-negative number for Min and Max");
      return;
    }
    if (
      minResult.value !== null &&
      maxResult.value !== null &&
      minResult.value > maxResult.value
    ) {
      setError("Min cannot be greater than Max");
      return;
    }
    setError(null);
    onApply(minResult.value, maxResult.value);
  };

  const handleClear = () => {
    setDraftMin("");
    setDraftMax("");
    setError(null);
    onApply(null, null);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-2"
      aria-label="Expected value range filter"
    >
      <div>
        <label
          htmlFor="expected-value-min"
          className="mb-1 block text-xs font-medium text-gray-500"
        >
          Min
        </label>
        <input
          id="expected-value-min"
          type="number"
          min={0}
          value={draftMin}
          onChange={(event) => setDraftMin(event.target.value)}
          placeholder="Min"
          aria-label="Minimum expected value"
          className="w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label
          htmlFor="expected-value-max"
          className="mb-1 block text-xs font-medium text-gray-500"
        >
          Max
        </label>
        <input
          id="expected-value-max"
          type="number"
          min={0}
          value={draftMax}
          onChange={(event) => setDraftMax(event.target.value)}
          placeholder="Max"
          aria-label="Maximum expected value"
          className="w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
      >
        Apply
      </button>
      {(min !== null || max !== null) && (
        <button
          type="button"
          onClick={handleClear}
          className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
        >
          Clear
        </button>
      )}
      {error && (
        <p className="basis-full text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
