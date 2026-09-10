export function formatTrackingArtifact(shipTrackInfo) {
  const carriers = [];
  const trackingPairs = [];
  const trackingNumbers = [];
  const raw = [];
  const seenCarrier = new Set();
  const seenTrackingNumber = new Set();
  const seenPair = new Set();

  for (const item of shipTrackInfo || []) {
    const carrierName = text(item && item.carrierName) || "Unknown";
    const trackingNum = text(item && item.trackingNum) || "";
    const pairKey = `${carrierName}::${trackingNum}`;
    raw.push({
      carrierName,
      trackingNum,
      sku: text(item && item.sku),
      skuQty: item && item.skuQty != null ? item.skuQty : null,
      isCombo: item && item.isCombo != null ? Boolean(item.isCombo) : null,
      comboSku: text(item && item.comboSku),
    });
    if (!seenCarrier.has(carrierName)) {
      seenCarrier.add(carrierName);
      carriers.push(carrierName);
    }
    if (trackingNum && !seenTrackingNumber.has(trackingNum)) {
      seenTrackingNumber.add(trackingNum);
      trackingNumbers.push(trackingNum);
    }
    if ((trackingNum || carrierName) && !seenPair.has(pairKey)) {
      seenPair.add(pairKey);
      trackingPairs.push(`${carrierName}: ${trackingNum}`.trim());
    }
  }

  return {
    carrierSummary: carriers.join(" / "),
    trackingNumberSummary: trackingNumbers.join(" / "),
    trackingDetailSummary: trackingPairs.join("; "),
    rawJson: JSON.stringify(raw),
  };
}

function text(value) {
  return String(value == null ? "" : value).trim();
}
