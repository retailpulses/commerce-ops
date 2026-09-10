import type { InquirySummary } from "../../types/inquiry";
import Badge from "../ui/Badge";
import { formatDateTimeJst, truncate, formatPrice } from "../../utils/formatters";

interface InquiryRowProps {
  inquiry: InquirySummary;
  isSelected: boolean;
  onClick: () => void;
}

export default function InquiryRow({ inquiry, isSelected, onClick }: InquiryRowProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full border-b border-gray-100 px-4 py-3 text-left transition-colors hover:bg-gray-50
        ${isSelected ? "border-l-2 border-l-blue-600 bg-blue-50" : "border-l-2 border-l-transparent"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">
              {inquiry.customerNickname || "No name"}
            </span>
            <span className="text-xs text-gray-400">
              {formatDateTimeJst(inquiry.inquiryDate)} JST
            </span>
          </div>
          <p className="mt-0.5 text-xs text-gray-500 truncate">
            {truncate(inquiry.productName || "No product name", 40)}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {inquiry.hasDraft && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
              Draft
            </span>
          )}
          <Badge statusId={inquiry.status.id} label={inquiry.status.label} />
        </div>
      </div>
      {inquiry.inquiryType && (
        <p className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
          <span>{inquiry.inquiryType.label}</span>
          {inquiry.account && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
              {inquiry.account.label}
            </span>
          )}
        </p>
      )}
      {!inquiry.inquiryType && inquiry.account && (
        <p className="mt-1 text-[11px] text-gray-400">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            {inquiry.account.label}
          </span>
        </p>
      )}
      {(inquiry.units !== null ||
        inquiry.effectivePriceInclShipping !== null ||
        inquiry.expectedValue !== null) && (
        <p className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
          {inquiry.units !== null && (
            <span>Units: <span className="font-medium text-gray-600">{inquiry.units}</span></span>
          )}
          {inquiry.effectivePriceInclShipping !== null && (
            <span>Price: <span className="font-medium text-gray-600">{formatPrice(inquiry.effectivePriceInclShipping)}</span></span>
          )}
          {inquiry.expectedValue !== null && (
            <span>Expected Value: <span className="font-medium text-gray-600">{formatPrice(inquiry.expectedValue)}</span></span>
          )}
        </p>
      )}
    </button>
  );
}
