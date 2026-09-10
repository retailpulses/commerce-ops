import { STATUS_TABS } from "../../utils/constants";

interface StatusTabsProps {
  selected: string;
  onSelect: (statusKey: string) => void;
}

export default function StatusTabs({ selected, onSelect }: StatusTabsProps) {
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-xs font-medium text-gray-500">Inquiry stage</span>
      <select
        aria-label="Inquiry stage"
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {STATUS_TABS.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
