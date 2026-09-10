/**
 * @param {any[]} items
 * @param {Record<string, string|boolean>} filters
 * @param {function(any, string, string|boolean): boolean} predicate
 * @returns {any[]}
 */
export function applyFilters(items, filters, predicate) {
  const active = Object.entries(filters).filter(
    ([_, v]) => v !== '' && v !== false && v !== undefined
  );
  if (active.length === 0) return items;
  return items.filter((item) => active.every(([key, val]) => predicate(item, key, val)));
}

/**
 * @param {string[]} itemDomains
 * @param {string} domainId
 * @returns {boolean}
 */
export function matchesDomain(itemDomains, domainId) {
  if (!domainId) return true;
  return itemDomains.includes(domainId);
}
