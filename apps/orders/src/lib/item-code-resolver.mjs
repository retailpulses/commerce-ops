// ── GigaB2B Item Code Resolver ───────────────────────────────────────
//
// Channel-agnostic resolver that maps a platform-specific product
// identifier (Mercari SKU, Rakuten manage_number, etc.) to a GigaB2B
// B2BItemCode.
//
// Each channel declares its own resolution rules via channelConfig.
// The resolver returns { resolved, code, reason } — when resolved=false,
// the shipment projector skips that sales row and leaves it for manual
// operator review.
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a B2BItemCode from a platform product identifier.
 *
 * @param {string} originalProductId  - Platform-level product ID (e.g. Mercari SKU)
 * @param {{ itemCodeResolver?: (sku: string) => { resolved: boolean, code: string|null, reason: string|null } }} channelConfig
 * @returns {{ resolved: boolean, code: string|null, reason: string|null }}
 */
export function resolveB2BItemCode(originalProductId, channelConfig) {
  const sku = normalizeText(originalProductId);
  if (!sku) {
    return { resolved: false, code: null, reason: "empty_original_product_id" };
  }

  // Delegate to channel-specific resolver when available
  if (channelConfig && typeof channelConfig.itemCodeResolver === "function") {
    return channelConfig.itemCodeResolver(sku);
  }

  // Default: pass-through (no channel-specific rules)
  return { resolved: true, code: sku, reason: null };
}

// ── Mercari resolution rules ─────────────────────────────────────────
//
// 1. SKU starts with "RP" (case-insensitive) → internal fee-adjustment
//    listing. Never create a shipment row for these.
// 2. SKU contains "-" → ambiguous mapping; leave for operator to
//    resolve manually in Baserow.
// 3. Otherwise → SKU is the B2BItemCode directly.
// ──────────────────────────────────────────────────────────────────────

/**
 * Mercari-specific item code resolver.
 *
 * @param {string} sku  - Normalized original_product_id from Mercari sales row
 * @returns {{ resolved: boolean, code: string|null, reason: string|null }}
 */
export function mercariResolveItemCode(sku) {
  const normalized = normalizeText(sku);
  if (!normalized) {
    return { resolved: false, code: null, reason: "empty_sku" };
  }

  // Rule 1: "RP" prefix → internal fee-adjustment listing
  if (/^RP/i.test(normalized)) {
    return { resolved: false, code: null, reason: "rp_fee_adjustment" };
  }

  // Rule 2: contains hyphen → ambiguous, requires manual resolution
  if (normalized.includes("-")) {
    return { resolved: false, code: null, reason: "ambiguous_hyphen" };
  }

  // Rule 3: pass-through
  return { resolved: true, code: normalized, reason: null };
}

// ── Rakuten resolution ────────────────────────────────────────────────
//
// Rakuten manage_number → B2B item code mapping is data, not an algorithm.
// The mapping lives in the existing catalog tables:
//   platform_listings.manage_number
//     → product_platform_links (via listing_id)
//       → product_variants.item_code (via variant_id)
//
// This factory returns an async resolver that queries these tables.
// The client parameter must have a .supabase property (raw Supabase JS client).
// ──────────────────────────────────────────────────────────────────────

/**
 * Create a DB-backed resolver that maps Rakuten manage_number to GigaB2B
 * item_code via the product_platform_links mapping table.
 *
 * @param {{ supabase: object }} client - client with raw Supabase JS client
 * @returns {(manageNumber: string) => Promise<{ resolved: boolean, code: string|null, reason: string|null }>}
 */
export function createRakutenItemCodeResolver(client) {
  const resolveMany = createRakutenItemCodeBatchResolver(client);
  return async (manageNumber, productName = "") => {
    const normalized = normalizeText(manageNumber);
    if (!normalized) return unresolved("empty_manage_number");
    const key = rakutenItemCodeResolutionKey(normalized, productName);
    const results = await resolveMany([{ manageNumber: normalized, productName }]);
    return results.get(key) || unresolved("no_mapping_found");
  };
}

/**
 * Resolve multiple Rakuten manage numbers in two set-based queries.
 * A mapping is usable only when every linked row points to one unique item
 * code. Multiple variants fail closed because only getOrder v7 SkuModelList
 * identifies the exact variation selected by the buyer.
 *
 * @param {{ supabase: object }} client
 * @returns {(contexts: Array<string|{manageNumber: string, productName?: string}>) => Promise<Map<string, { resolved: boolean, code: string|null, reason: string|null }>>}
 */
export function createRakutenItemCodeBatchResolver(client) {
  return async (contexts) => {
    const normalizedContexts = normalizeRakutenContexts(contexts);
    const normalizedNumbers = [...new Set(normalizedContexts.map(({ manageNumber }) => manageNumber))];
    const results = new Map(normalizedContexts.map(({ key }) => [key, unresolved("no_mapping_found")]));
    if (normalizedNumbers.length === 0) return results;

    try {
      const listingRows = await loadRakutenListings(client.supabase, normalizedNumbers);
      const listingIds = [...new Set(listingRows.map((row) => row?.id).filter(Boolean))];
      if (listingIds.length === 0) return results;

      const links = await loadRakutenLinks(client.supabase, listingIds);

      const manageNumbersByListingId = new Map();
      const requestedManageNumbers = new Set(normalizedNumbers);
      for (const listing of listingRows) {
        const manageNumber = normalizeText(listing?.manage_number);
        if (!listing?.id || !manageNumber || !requestedManageNumbers.has(manageNumber)) continue;
        const values = manageNumbersByListingId.get(listing.id) || new Set();
        values.add(manageNumber);
        manageNumbersByListingId.set(listing.id, values);
      }

      const candidatesByManageNumber = new Map(normalizedNumbers.map((value) => [value, new Set()]));
      for (const link of Array.isArray(links) ? links : []) {
        const itemCodes = readItemCodes(link?.product_variants);
        for (const manageNumber of manageNumbersByListingId.get(link?.listing_id) || []) {
          const candidates = candidatesByManageNumber.get(manageNumber);
          for (const itemCode of itemCodes) candidates.add(itemCode);
        }
      }

      for (const { key, manageNumber } of normalizedContexts) {
        const codes = [...(candidatesByManageNumber.get(manageNumber) || [])];
        if (codes.length === 1) {
          results.set(key, { resolved: true, code: codes[0], reason: null });
        } else if (codes.length > 1) results.set(key, unresolved("ambiguous_mapping"));
      }
      return results;
    } catch (_) {
      return errorResults(normalizedContexts);
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value ?? "").trim();
}

function readItemCodes(value) {
  const variants = Array.isArray(value) ? value : [value];
  return variants.map((variant) => normalizeText(variant?.item_code)).filter(Boolean);
}
function unresolved(reason) {
  return { resolved: false, code: null, reason };
}

function errorResults(values) {
  return new Map(values.map((value) => [value.key || value, unresolved("query_error")]));
}

export function rakutenItemCodeResolutionKey(manageNumber, productName = "") {
  const normalizedManageNumber = normalizeText(manageNumber);
  const normalizedProductName = normalizeText(productName);
  return normalizedProductName ? `${normalizedManageNumber}\u0000${normalizedProductName}` : normalizedManageNumber;
}
function normalizeRakutenContexts(values) {
  const contexts = (values || []).map((value) => {
    const manageNumber = normalizeText(typeof value === "object" ? value?.manageNumber : value);
    const productName = normalizeText(typeof value === "object" ? value?.productName : "");
    return { manageNumber, productName, key: rakutenItemCodeResolutionKey(manageNumber, productName) };
  }).filter(({ manageNumber }) => manageNumber);
  return [...new Map(contexts.map((context) => [context.key, context])).values()];
}

const QUERY_CHUNK_SIZE = 100;
const QUERY_PAGE_SIZE = 1000;

async function loadRakutenListings(supabase, manageNumbers) {
  const rows = [];
  for (const chunk of chunks(manageNumbers, QUERY_CHUNK_SIZE)) {
    for (let from = 0; ; from += QUERY_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("platform_listings")
        .select("id,manage_number")
        .eq("platform", "rakuten")
        .in("manage_number", chunk)
        .order("manage_number", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + QUERY_PAGE_SIZE - 1);
      if (error) throw new Error("rakuten_listing_query_failed");
      const page = Array.isArray(data) ? data : [];
      rows.push(...page);
      if (page.length < QUERY_PAGE_SIZE) break;
    }
  }
  return rows;
}

async function loadRakutenLinks(supabase, listingIds) {
  const rows = [];
  for (const chunk of chunks(listingIds, QUERY_CHUNK_SIZE)) {
    for (let from = 0; ; from += QUERY_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("product_platform_links")
        .select("id,listing_id,product_variants!variant_id(item_code)")
        .in("listing_id", chunk)
        .order("listing_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + QUERY_PAGE_SIZE - 1);
      if (error) throw new Error("rakuten_link_query_failed");
      const page = Array.isArray(data) ? data : [];
      rows.push(...page);
      if (page.length < QUERY_PAGE_SIZE) break;
    }
  }
  return rows;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
