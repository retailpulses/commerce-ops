/**
 * Safely read a URL search param during SSR/prerender.
 * @param {URL} url
 * @param {string} key
 * @returns {string}
 */
export function safeSearchParam(url, key) {
  try {
    return url.searchParams.get(key) || '';
  } catch {
    return '';
  }
}

/**
 * Case-insensitive substring search across specified fields.
 * @param {any[]} items
 * @param {string} query
 * @param {string[]} fields
 * @returns {any[]}
 */
export function searchItems(items, query, fields) {
  if (!query || !query.trim()) return items;
  const q = query.toLowerCase().trim();
  return items.filter((item) =>
    fields.some((field) => {
      const val = item[field];
      if (!val) return false;
      return String(val).toLowerCase().includes(q);
    })
  );
}
