import { formatTrackingArtifact } from "../src/lib/tracking-format.mjs";

const sample = {
  orderNo: "DSR202507241513",
  shipTrackInfo: [
    {
      sku: "W2727P199353",
      skuQty: 1,
      isCombo: true,
      comboSku: "W2727S00005",
      trackingNum: "794891243280",
      carrierName: "Fedex",
    },
    {
      sku: "W2727P199353",
      skuQty: 1,
      isCombo: true,
      comboSku: "W2727S00005",
      trackingNum: "794891243258",
      carrierName: "Fedex",
    },
    {
      sku: "W2727P199353",
      skuQty: 1,
      isCombo: true,
      comboSku: "W2727S00005",
      trackingNum: "794891242917",
      carrierName: "Fedex",
    },
    {
      sku: "W2727P181721",
      skuQty: 1,
      isCombo: true,
      comboSku: "W2727S00005",
      trackingNum: "794891243177",
      carrierName: "Fedex",
    },
  ],
};

const formatted = formatTrackingArtifact(sample.shipTrackInfo);

console.log(JSON.stringify({
  orderNo: sample.orderNo,
  carrier_summary: formatted.carrierSummary,
  tracking_number_summary: formatted.trackingNumberSummary,
  tracking_detail_summary: formatted.trackingDetailSummary,
  raw_json: formatted.rawJson,
}, null, 2));
