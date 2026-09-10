import { SHOP_OPTIONS } from "../../utils/constants";

interface ShopFilterProps {
  selected: string;
  onSelect: (shopKey: string) => void;
}

export default function ShopFilter({ selected, onSelect }: ShopFilterProps) {
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-xs font-medium text-gray-500">Shop</span>
      <select
        aria-label="Shop"
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {SHOP_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
