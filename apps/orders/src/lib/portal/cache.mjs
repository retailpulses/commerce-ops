import { bulkFetchProducts, resolveProductFields } from "../product-resolver.mjs";

const PRODUCT_FIELDS_CACHE_TTL_MS = 10 * 60 * 1000;
const PRODUCT_SNAPSHOT_CACHE_TTL_MS = 2 * 60 * 1000;
const PORTAL_LIST_CACHE_TTL_MS = 30 * 1000;

const productFieldsCache = new Map();
const productSnapshotCache = new Map();
const portalListCache = new Map();

export function getCachedPortalList(key) {
  const cached = portalListCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    portalListCache.delete(key);
    return null;
  }
  return cached.value;
}

export function setCachedPortalList(key, value) {
  portalListCache.set(key, {
    value,
    expiresAt: Date.now() + PORTAL_LIST_CACHE_TTL_MS,
  });
}

export function invalidatePortalListCache() {
  portalListCache.clear();
}

export async function getPortalProductFields(env, productsTableId) {
  // Include backend in cache key — Supabase returns hardcoded IDs (no API
  // call), Baserow returns discovered field IDs from the API.
  const backend = String(env?.DATABASE_BACKEND || "").trim().toLowerCase() || "baserow";
  const cacheKey = `${backend}_${env.BASEROW_API_BASE || ""}_${productsTableId}`;
  const cached = productFieldsCache.get(cacheKey);
  if (cached && cached.fields && cached.expiresAt > Date.now()) {
    return cached.fields;
  }
  if (cached && cached.promise) {
    return cached.promise;
  }

  const promise = resolveProductFields(env, productsTableId);
  productFieldsCache.set(cacheKey, { promise, fields: null, expiresAt: 0 });

  try {
    const fields = await promise;
    productFieldsCache.set(cacheKey, {
      promise: null,
      fields,
      expiresAt: Date.now() + PRODUCT_FIELDS_CACHE_TTL_MS,
    });
    return fields;
  } catch (error) {
    productFieldsCache.delete(cacheKey);
    throw error;
  }
}

export async function getPortalProductSnapshotMap(env, productsTableId, itemCodeFieldId) {
  const cacheKey = `${env.BASEROW_API_BASE || ""}_${productsTableId}_${itemCodeFieldId}`;
  const cached = productSnapshotCache.get(cacheKey);
  if (cached && cached.map && cached.expiresAt > Date.now()) {
    return cached.map;
  }
  if (cached && cached.promise) {
    return cached.promise;
  }

  const promise = bulkFetchProducts(env, productsTableId, itemCodeFieldId);
  productSnapshotCache.set(cacheKey, { promise, map: null, expiresAt: 0 });

  try {
    const map = await promise;
    productSnapshotCache.set(cacheKey, {
      promise: null,
      map,
      expiresAt: Date.now() + PRODUCT_SNAPSHOT_CACHE_TTL_MS,
    });
    return map;
  } catch (error) {
    productSnapshotCache.delete(cacheKey);
    throw error;
  }
}
