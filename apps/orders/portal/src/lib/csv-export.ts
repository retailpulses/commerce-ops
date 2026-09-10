import type { OrderRow } from "@/types/orders";
import { shopLabel } from "@/lib/constants";

const HEADERS = [
  "Order ID",
  "Shop",
  "Product Name",
  "B2B Item Code",
  "Review Status",
  "Order Status",
  "Tracking Number",
  "Purchase Date",
  "Shipping Name",
  "Margin",
] as const;

/**
 * Escape a string value for CSV: wrap in double quotes if it contains
 * commas, double-quotes, or newlines. Double-quotes inside are escaped
 * by doubling them.
 */
function escapeCSV(value: string | number | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatMargin(margin: { profit: number | null }): string {
  if (margin.profit == null) return "";
  return `¥${Math.round(margin.profit).toLocaleString()}`;
}

/**
 * Takes an array of OrderRow objects and triggers a browser CSV download.
 * No server call involved — the export is generated entirely client-side.
 */
export function exportOrdersToCsv(orders: OrderRow[], filename?: string): void {
  if (!orders.length) return;

  const rows: string[] = [];

  // Header row
  rows.push(HEADERS.map((h) => escapeCSV(h)).join(","));

  // Data rows
  for (const o of orders) {
    const fields: string[] = [
      o.order_id,
      shopLabel(o.shop_id),
      o.product_name,
      o.B2BItemCode,
      o.review_status,
      o.order_status,
      "", // tracking number is not available at the list level
      o.purchase_date,
      o.shipping_name,
      formatMargin(o.margin),
    ];
    rows.push(fields.map((v) => escapeCSV(v)).join(","));
  }

  const bom = "﻿"; // UTF-8 BOM for Excel compatibility with Japanese text
  const blob = new Blob([bom + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename || `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
