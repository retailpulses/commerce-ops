import { useState, useEffect, useRef, useCallback } from "react";
import type { InquiryDetail } from "../../types/inquiry";
import { formatDate } from "../../utils/formatters";
import Button from "../ui/Button";

interface InquirySummaryCardProps {
  inquiry: InquiryDetail;
}

type CopyState = "idle" | "copied" | "error";

/** Resolve summary fields once — used for both rendering and clipboard text */
interface ResolvedSummary {
  seller: string | null;
  sku: string | null;
  productName: string | null;
  inquiryType: string | null;
  inquiryBody: string | null;
  date: string | null;
}

export function buildSummary(inquiry: InquiryDetail): ResolvedSummary {
  const primaryProduct =
    inquiry.linkedProducts.find((product) => product.isPrimary) ??
    inquiry.linkedProducts[0] ??
    null;
  return {
    seller: inquiry.seller || null,
    sku: primaryProduct?.itemCode || null,
    productName: primaryProduct?.productName || inquiry.productName || null,
    inquiryType: inquiry.inquiryType?.label || null,
    inquiryBody: inquiry.inquiryBody || null,
    date: inquiry.inquiryDate || null,
  };
}

/** Build the plain-text clipboard payload from resolved summary */
function buildClipboardText(s: ResolvedSummary): string {
  return [
    `卖家: ${s.seller ?? "--"}`,
    `SKU: ${s.sku ?? "--"}`,
    `商品名: ${s.productName ?? "--"}`,
    `咨询类型: ${s.inquiryType ?? "--"}`,
    `咨询内容（原文）:`,
    s.inquiryBody ?? "--",
    `日期: ${s.date ? formatDate(s.date) : "--"}`,
  ].join("\n");
}

export default function InquirySummaryCard({ inquiry }: InquirySummaryCardProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timer helper
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Reset state when inquiry changes
  useEffect(() => {
    setCopyState("idle");
  }, [inquiry.id]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  const summary = buildSummary(inquiry);

  const handleCopy = async () => {
    clearTimer();
    const text = buildClipboardText(summary);

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      timerRef.current = setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      timerRef.current = setTimeout(() => setCopyState("idle"), 3000);
    }
  };

  const copyButtonLabel =
    copyState === "copied"
      ? "已复制"
      : copyState === "error"
        ? "复制失败"
        : "复制";

  const copyButtonClass =
    copyState === "copied"
      ? "bg-green-50 !text-green-700 hover:bg-green-100"
      : copyState === "error"
        ? "bg-red-50 !text-red-700 hover:bg-red-100"
        : undefined;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">咨询概要</h3>
        <Button
          variant="secondary"
          size="sm"
          className={`notranslate ${copyButtonClass ?? ""}`}
          translate="no"
          onClick={handleCopy}
        >
          {copyState === "copied" ? (
            <CheckIcon />
          ) : copyState === "error" ? (
            <XIcon />
          ) : (
            <ClipboardIcon />
          )}
          {copyButtonLabel}
        </Button>
      </div>

      <div className="space-y-2 text-xs">
        <SummaryRow label="卖家" value={summary.seller} />
        <SummaryRow label="SKU" value={summary.sku} />
        <SummaryRow label="商品名" value={summary.productName} />
        <SummaryRow label="咨询类型" value={summary.inquiryType} />
        <div>
          <span className="text-gray-400">咨询内容（原文）</span>
          <p className="whitespace-pre-wrap font-medium text-gray-700">
            {summary.inquiryBody || "--"}
          </p>
        </div>
        <SummaryRow label="日期" value={summary.date ? formatDate(summary.date) : null} />
      </div>
    </div>
  );
}

/** Read-only field for displaying a label + value in the summary */
function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-gray-400">{label}</span>
      <p className="font-medium text-gray-700">{value || "--"}</p>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
