const RMS_REMARKS_START = "[ingest] RMSお客様備考:";
const RMS_REMARKS_END = "[ingest] RMSお客様備考ここまで";
const RMS_DELIVERY_WARNING_PREFIX = "[ingest] ⚠️ RMS配送時間コード";

const RMS_SHIPPING_TERM_TO_TIME_SLOT = Object.freeze({
  "1": "08:00-12:00",
  "1416": "14:00-16:00",
  "1618": "16:00-18:00",
  "1820": "18:00-20:00",
  "1921": "19:00-21:00",
});

function rawText(value) {
  return String(value == null ? "" : value);
}

function text(value) {
  return rawText(value).trim();
}

export function mapRmsShippingTerm(value) {
  const normalizedTerm = text(value);
  if (!normalizedTerm) {
    return { normalizedTerm: "", requestedDeliveryTime: "", known: true };
  }
  const requestedDeliveryTime = RMS_SHIPPING_TERM_TO_TIME_SLOT[normalizedTerm] || "";
  return {
    normalizedTerm,
    requestedDeliveryTime,
    known: Boolean(requestedDeliveryTime),
  };
}

export function hasRmsCustomerRemarksBlock(orderComments) {
  const comments = rawText(orderComments);
  const start = comments.indexOf(RMS_REMARKS_START);
  if (start < 0) return false;
  return comments.indexOf(RMS_REMARKS_END, start + RMS_REMARKS_START.length) >= 0;
}

export function extractRmsCustomerRemarks(orderComments) {
  const comments = rawText(orderComments);
  const start = comments.indexOf(RMS_REMARKS_START);
  if (start < 0) return "";
  const contentStart = start + RMS_REMARKS_START.length;
  const end = comments.indexOf(RMS_REMARKS_END, contentStart);
  if (end < 0) return "";
  return comments.slice(contentStart, end).trim();
}

function buildRmsCustomerRemarksBlock(remarks) {
  const body = text(remarks);
  if (!body) return "";
  return `${RMS_REMARKS_START}\n${body}\n${RMS_REMARKS_END}`;
}

function replaceOrAppendRemarksBlock(existingComments, remarks) {
  const existing = text(existingComments);
  const nextBlock = buildRmsCustomerRemarksBlock(remarks);
  const start = existing.indexOf(RMS_REMARKS_START);

  if (start >= 0) {
    const endMarker = existing.indexOf(RMS_REMARKS_END, start + RMS_REMARKS_START.length);
    if (endMarker >= 0) {
      // An empty upstream value is not treated as deletion approval. Retain the
      // last captured RMS block so a transient/partial response cannot erase it.
      if (!nextBlock) return existing;
      const after = endMarker + RMS_REMARKS_END.length;
      return `${existing.slice(0, start).trimEnd()}\n\n${nextBlock}\n\n${existing.slice(after).trimStart()}`.trim();
    }
  }

  if (!nextBlock) return existing;
  return existing ? `${existing}\n\n${nextBlock}` : nextBlock;
}

function removeManagedDeliveryWarnings(orderComments) {
  return rawText(orderComments)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(RMS_DELIVERY_WARNING_PREFIX))
    .join("\n")
    .trim();
}

export function mergeRmsOrderComments(existingComments, remarks, shippingTermMapping) {
  let merged = replaceOrAppendRemarksBlock(existingComments, remarks);
  merged = removeManagedDeliveryWarnings(merged);

  const normalizedTerm = text(shippingTermMapping?.normalizedTerm);
  if (normalizedTerm && shippingTermMapping?.known === false) {
    const warning = `${RMS_DELIVERY_WARNING_PREFIX}「${normalizedTerm}」は未対応です。配送時間をポータルで手動設定してください。`;
    merged = merged ? `${merged}\n\n${warning}` : warning;
  }
  return merged;
}
