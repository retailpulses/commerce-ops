import type { InquiryTypeInfo } from "../../types/inquiry";
import { INQUIRY_TYPE_OPTIONS } from "../../utils/constants";

interface InquiryTypeSelectProps {
  currentType: InquiryTypeInfo | null;
  isSaving: boolean;
  disabled: boolean;
  onChange: (inquiryTypeKey: string) => void;
}

export default function InquiryTypeSelect({ currentType, isSaving, disabled, onChange }: InquiryTypeSelectProps) {
  return (
    <label className="notranslate block" translate="no">
      <span className="mb-1 block text-xs font-medium text-gray-500">Inquiry type</span>
      <div className="flex items-center gap-2">
        <select
          aria-label="Inquiry type"
          value={currentType?.id ?? ""}
          disabled={disabled || isSaving}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        >
          <option value="" disabled>Select type</option>
          {INQUIRY_TYPE_OPTIONS.filter((option) => option.id !== "_all").map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        {isSaving && <span className="text-[10px] text-gray-400">Saving…</span>}
      </div>
    </label>
  );
}
