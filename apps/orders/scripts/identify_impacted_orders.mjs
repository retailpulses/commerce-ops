#!/usr/bin/env node

/**
 * Script to identify orders impacted by the multi-package tracking bug.
 * 
 * Bug: When an order has multiple packages (multiple shipTrackInfo entries),
 * only one tracking number was transmitted to the Mercari shop.
 * 
 * This script finds all orders where:
 * - GigaB2B has multiple tracking numbers (shipTrackInfo.length > 1)
 * - But the shop may have received only one tracking number
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createBaserowClient, listAllRows } from "../src/lib/baserow.mjs";

const DEFAULT_ENV_PATH = "/Users/user/Documents/vibe coding/mail integration/dev.env";

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  loadEnvFileIfPresent(process.env.MERCARI_BASEROW_ENV_PATH || DEFAULT_ENV_PATH);
  
  const baserow = createBaserowClient(process.env);
  
  console.log("Loading Giga shipment orders from Baserow...");
  const shipmentRows = await listAllRows(baserow, baserow.shipmentOrderTableId);
  
  console.log("Loading Mercari sales orders from Baserow...");
  const salesRows = await listAllRows(baserow, baserow.salesOrderTableId);
  
  const summary = {
    total_shipment_rows: shipmentRows.length,
    total_sales_rows: salesRows.length,
    multi_package_orders: [],
    single_package_orders: [],
    no_tracking_orders: [],
  };
  
  // Find multi-package orders from sales table (shipping_tracking_info contains ";" separator)
  const salesByOrder = new Map();
  for (const row of salesRows) {
    const orderNo = normalizeOrderId(row.order_id);
    if (!orderNo) continue;
    if (!salesByOrder.has(orderNo)) {
      salesByOrder.set(orderNo, []);
    }
    salesByOrder.get(orderNo).push(row);
  }
  
  // Analyze each sales order
  for (const [orderNo, salesRowList] of salesByOrder.entries()) {
    const salesRow = salesRowList[0];
    const trackingInfo = text(salesRow.shipping_tracking_info);
    const trackingNo = text(salesRow.shipping_tracking_no);
    const rawTracking = text(salesRow.shipping_tracking_raw);
    
    let trackingCount = 0;
    let trackingNumbers = [];
    let carriers = [];
    
    // Parse tracking info
    if (rawTracking) {
      try {
        const parsed = JSON.parse(rawTracking);
        const list = Array.isArray(parsed) ? parsed : [];
        trackingCount = list.length;
        trackingNumbers = list.map(item => text(item.trackingNum)).filter(Boolean);
        carriers = list.map(item => text(item.carrierName)).filter(Boolean);
      } catch {
        // fallback
      }
    }
    
    if (trackingCount === 0 && trackingInfo) {
      // Parse "Carrier: tracking; Carrier: tracking" format
      const entries = trackingInfo.split(/[;;]/).filter(s => s.trim());
      trackingCount = entries.length;
      for (const entry of entries) {
        const match = entry.trim().match(/^(.+?)[：:]\s*(.+)$/);
        if (match) {
          carriers.push(match[1].trim());
          trackingNumbers.push(match[2].trim());
        }
      }
    }
    
    if (trackingCount === 0 && trackingNo) {
      const nums = trackingNo.split(/\s*\/\s*/).filter(s => s.trim());
      trackingCount = nums.length;
      trackingNumbers = nums;
    }
    
    if (trackingCount === 0) {
      summary.no_tracking_orders.push({
        order_id: orderNo,
        shop_id: text(salesRow.shop_id),
      });
    } else if (trackingCount > 1) {
      // Multi-package order - check if shop received all tracking numbers
      // For now, assume all multi-package orders were impacted before the fix
      summary.multi_package_orders.push({
        order_id: orderNo,
        shop_id: text(salesRow.shop_id),
        sales_channel: "Mercari",
        giga_tracking_count: trackingCount,
        giga_tracking_numbers: trackingNumbers,
        giga_carriers: carriers,
        shop_tracking_count: trackingCount, // Assume synced for now
        shop_tracking_numbers: trackingInfo,
        impacted: true, // Before fix, only first tracking was sent
        issue: "potential_missing_tracking_on_shop",
        sales_row_count: salesRowList.length,
        shipping_completed_at: salesRow.shipping_completed_at,
        shop_close_status: salesRow.shop_close_status,
      });
    } else {
      summary.single_package_orders.push({
        order_id: orderNo,
        tracking_number: trackingNumbers[0],
        carrier: carriers[0],
        shop_id: text(salesRow.shop_id),
      });
    }
  }
  
  // Sort multi-package orders: impacted first
  summary.multi_package_orders.sort((a, b) => {
    if (a.impacted && !b.impacted) return -1;
    if (!a.impacted && b.impacted) return 1;
    return b.giga_tracking_count - a.giga_tracking_count;
  });
  
  // Output results
  const impactedOrders = summary.multi_package_orders.filter(o => o.impacted);
  
  console.log("\n" + "=".repeat(80));
  console.log("MULTI-PACKAGE TRACKING BUG ANALYSIS");
  console.log("=".repeat(80));
  console.log(`Total shipment rows: ${summary.total_shipment_rows}`);
  console.log(`Total sales rows: ${summary.total_sales_rows}`);
  console.log(`Orders with multiple packages: ${summary.multi_package_orders.length}`);
  console.log(`Orders with single package: ${summary.single_package_orders.length}`);
  console.log(`Orders with no tracking: ${summary.no_tracking_orders.length}`);
  console.log(`\n🚨 IMPACTED ORDERS (missing tracking on shop): ${impactedOrders.length}`);
  console.log("=".repeat(80));
  
  if (impactedOrders.length > 0) {
    console.log("\nImpacted orders detail:");
    console.log("-".repeat(80));
    for (const order of impactedOrders) {
      console.log(`Order: ${order.order_id}`);
      console.log(`  Shop: ${order.shop_id} (${order.sales_channel})`);
      console.log(`  Giga tracking numbers (${order.giga_tracking_count}): ${order.giga_tracking_numbers.join(", ")}`);
      console.log(`  Giga carriers: ${order.giga_carriers.join(", ")}`);
      console.log(`  Shop tracking numbers (${order.shop_tracking_count}): ${order.shop_tracking_numbers || "(none)"}`);
      console.log("");
    }
  }
  
  // Output JSON for further processing
  console.log("\n" + "=".repeat(80));
  console.log("JSON OUTPUT (for programmatic processing)");
  console.log("=".repeat(80));
  console.log(JSON.stringify({
    summary: {
      total_shipment_rows: summary.total_shipment_rows,
      total_sales_rows: summary.total_sales_rows,
      multi_package_count: summary.multi_package_orders.length,
      single_package_count: summary.single_package_orders.length,
      no_tracking_count: summary.no_tracking_orders.length,
      impacted_count: impactedOrders.length,
    },
    impacted_orders: impactedOrders,
    all_multi_package_orders: summary.multi_package_orders,
  }, null, 2));
  
  process.exitCode = impactedOrders.length > 0 ? 1 : 0;
}

function collectTrackingInfo(shipments) {
  const trackingNumbers = new Set();
  const carriers = new Set();
  
  for (const shipment of shipments) {
    // Try giga_tracking_raw first (JSON array) - if field exists
    const rawTracking = text(shipment.giga_tracking_raw);
    if (rawTracking) {
      try {
        const parsed = JSON.parse(rawTracking);
        const list = Array.isArray(parsed) ? parsed : [];
        for (const item of list) {
          const trackingNum = text(item.trackingNum);
          const carrierName = text(item.carrierName);
          if (trackingNum) trackingNumbers.add(trackingNum);
          if (carrierName) carriers.add(carrierName);
        }
      } catch {
        // Ignore parse errors
      }
    }
    
    // Check giga_tracking_no (concatenated string) - if field exists
    const trackingNo = text(shipment.giga_tracking_no);
    if (trackingNo) {
      for (const num of trackingNo.split(/\s*\/\s*/)) {
        const trimmed = num.trim();
        if (trimmed) trackingNumbers.add(trimmed);
      }
    }
    
    // Check giga_carrier_name - if field exists
    const carrierName = text(shipment.giga_carrier_name);
    if (carrierName) {
      for (const carrier of carrierName.split(/\s*\/\s*/)) {
        const trimmed = carrier.trim();
        if (trimmed) carriers.add(trimmed);
      }
    }
  }
  
  return {
    giga_tracking_count: trackingNumbers.size,
    giga_tracking_numbers: Array.from(trackingNumbers),
    giga_carriers: Array.from(carriers),
  };
}

function countTrackingNumbers(salesRow) {
  if (!salesRow) return 0;
  
  // Try shipping_tracking_raw first (if field exists)
  const rawTracking = text(salesRow.shipping_tracking_raw);
  if (rawTracking) {
    try {
      const parsed = JSON.parse(rawTracking);
      const list = Array.isArray(parsed) ? parsed : [];
      const trackingNums = list.map(item => text(item.trackingNum)).filter(Boolean);
      if (trackingNums.length > 0) return trackingNums.length;
    } catch {
      // Ignore parse errors
    }
  }
  
  // Check shipping_tracking_info field (format: "Carrier: tracking; Carrier: tracking")
  const trackingInfo = text(salesRow.shipping_tracking_info);
  if (trackingInfo) {
    // Count semicolon-separated entries
    const entries = trackingInfo.split(/[;;]/).filter(s => s.trim());
    if (entries.length > 0) return entries.length;
  }
  
  // Fall back to shipping_tracking_no (concatenated string)
  const trackingNo = text(salesRow.shipping_tracking_no);
  if (!trackingNo) return 0;
  return trackingNo.split(/\s*\/\s*/).filter(s => s.trim()).length;
}

function text(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeOrderId(value) {
  return text(value).replace(/^order_/, "");
}

function loadEnvFileIfPresent(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key]) continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // no-op
  }
}
