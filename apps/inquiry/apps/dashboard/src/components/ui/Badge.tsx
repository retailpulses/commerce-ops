import {
  STATUS_RECEIVED,
  STATUS_FOLLOWED_UP,
  STATUS_ANSWERED,
  STATUS_CLOSED_WON,
  STATUS_CLOSED_LOSE,
} from "../../utils/constants";

interface BadgeProps {
  statusId: string;
  label: string;
}

const colorMap: Record<string, string> = {
  [STATUS_RECEIVED]: "bg-gray-100 text-gray-700",
  [STATUS_FOLLOWED_UP]: "bg-amber-100 text-amber-700",
  [STATUS_ANSWERED]: "bg-green-100 text-green-700",
  [STATUS_CLOSED_WON]: "bg-blue-100 text-blue-700",
  [STATUS_CLOSED_LOSE]: "bg-red-100 text-red-700",
};

const dotMap: Record<string, string> = {
  [STATUS_RECEIVED]: "bg-gray-400",
  [STATUS_FOLLOWED_UP]: "bg-amber-500",
  [STATUS_ANSWERED]: "bg-green-500",
  [STATUS_CLOSED_WON]: "bg-blue-500",
  [STATUS_CLOSED_LOSE]: "bg-red-500",
};

export default function Badge({ statusId, label }: BadgeProps) {
  const colorClass = colorMap[statusId] || "bg-gray-100 text-gray-700";
  const dotClass = dotMap[statusId] || "bg-gray-400";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${colorClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}
