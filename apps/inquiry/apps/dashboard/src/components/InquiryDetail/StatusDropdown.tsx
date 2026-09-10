import { useState } from "react";
import {
  STATUS_RECEIVED,
  STATUS_FOLLOWED_UP,
  STATUS_ANSWERED,
  STATUS_CLOSED_WON,
  STATUS_CLOSED_LOSE,
} from "../../utils/constants";
import Badge from "../ui/Badge";

interface StatusDropdownProps {
  currentStatus: { id: string; label: string };
  isSaving: boolean;
  onChange: (statusKey: string) => void;
}

const options = [
  { id: STATUS_RECEIVED, label: "Received" },
  { id: STATUS_FOLLOWED_UP, label: "Followed-up" },
  { id: STATUS_ANSWERED, label: "Answered" },
  { id: STATUS_CLOSED_WON, label: "Closed Won" },
  { id: STATUS_CLOSED_LOSE, label: "Closed Lose" },
];

export default function StatusDropdown({ currentStatus, isSaving, onChange }: StatusDropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={isSaving}
        className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        <Badge statusId={currentStatus.id} label={currentStatus.label} />
        {isSaving ? (
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        ) : (
          <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
            {options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50
                  ${opt.id === currentStatus.id ? "bg-blue-50 text-blue-700" : "text-gray-700"}`}
              >
                <Badge statusId={opt.id} label={opt.label} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
