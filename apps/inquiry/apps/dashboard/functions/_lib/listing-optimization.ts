import type { DashboardConfig } from "./config";
import type { InquiryDetailRow } from "./supabase";

export type ListingOptimization = {
  status: "ready" | "waiting_for_customer_confirmation" | "mapping_error" | "mapping_conflict";
  message?: string;
  listing?: {
    id: string; platform: string; shopCode: string; externalListingId: string;
    title: string; description: string; contentRevision: number;
    scoreTotal: number | null; scoreModules: Record<string, unknown> | null;
    scoredAt: string | null; scoreIsStale: boolean;
  };
};

export const LISTING_ENRICHMENT_PROMPT = `You are a senior Japanese marketplace ecommerce copywriter using the RPagentOS Rakuten preserve-first strategy.
Use a preserve-first structured enrichment strategy. Do not rewrite or summarize the current title or description.
Write only new Japanese content that is missing from the current description. Do not repeat information already present.
Preserve the title unchanged. Never invent specifications, compatibility, materials, quantities, guarantees, certifications, included items, or performance claims.
Use each heading exactly once and in this order: 【商品概要】, 【特徴・ベネフィット】, 【商品仕様】, 【使用シーン・おすすめ】, 【お手入れ・注意事項】.
Category-specific subheadings belong inside the appropriate standard section. Do not create 【追加情報】 or duplicate specification sections.
Keep the enrichment focused and scannable. Do not output HTML.
Return only JSON with title set to null and description containing only the new five-section enrichment block.`;

const DESCRIPTION_SECTIONS = [
  { title: "商品概要", pattern: /^(商品概要|商品説明|概要|イントロ)$/ },
  { title: "特徴・ベネフィット", pattern: /^(特徴・ベネフィット|特徴|特長|注目のポイント)$/ },
  { title: "商品仕様", pattern: /^(商品仕様|商品スペック|スペック)$/ },
  { title: "使用シーン・おすすめ", pattern: /^(使用シーン・おすすめ|おすすめの使用シーン|こんな方におすすめ|対応シーン)$/ },
  { title: "お手入れ・注意事項", pattern: /^(お手入れ・注意事項|品質・お手入れについて)$/ },
] as const;

function visibleText(value: string): string {
  return value.replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n・")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sectionIndex(line: string): number {
  const heading = line.trim().replace(/^#+\s*/, "").match(/^[【［\[]([^】］\]]+)[】］\]]$/)?.[1];
  if (!heading) return -1;
  return DESCRIPTION_SECTIONS.findIndex((section) => section.pattern.test(heading));
}

function parseDescriptionSections(value: string): string[][] {
  const sections = DESCRIPTION_SECTIONS.map(() => [] as string[]);
  let current = 0;
  for (const line of visibleText(value).split("\n").map((item) => item.trim()).filter(Boolean)) {
    const index = sectionIndex(line);
    if (index >= 0) current = index;
    else sections[current].push(line);
  }
  return sections;
}

/** Preserve all existing visible copy, then add only non-duplicate enrichment under the standard section set. */
export function composeStructuredListingDescription(source: string, enrichment: string): string {
  const sourceSections = parseDescriptionSections(source);
  const enrichmentSections = parseDescriptionSections(enrichment);
  return DESCRIPTION_SECTIONS.map((section, index) => {
    const seen = new Set<string>();
    const lines = [...sourceSections[index], ...enrichmentSections[index]].filter((line) => {
      const key = line.normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return `【${section.title}】\n${lines.join("\n")}`;
  }).join("\n\n").trim();
}

async function catalogFetch<T>(config: DashboardConfig, path: string, init?: RequestInit): Promise<T> {
  const base = config.supabase.restUrl || `${config.supabase.url.replace(/\/$/, "")}/rest/v1`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Catalog lookup failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function normalizeInquiryPlatform(source: string | null): string {
  const normalized = (source || "mercari").trim().toLowerCase();
  if (normalized === "mercari_shops" || normalized === "mercari-shops") return "mercari";
  return normalized;
}

export async function resolveExactListing(config: DashboardConfig, inquiry: InquiryDetailRow): Promise<ListingOptimization> {
  const primary = (inquiry.linked_products || []).find((item) => item.isPrimary) || inquiry.linked_products?.[0];
  if (!primary?.id) {
    return { status: "waiting_for_customer_confirmation", message: "Waiting for customer product confirmation" };
  }
  const platform = normalizeInquiryPlatform(inquiry.source);
  const shopCode = inquiry.shop_key || "";
  if (!shopCode) return { status: "mapping_error", message: "Inquiry shop is missing" };
  const linkQs = new URLSearchParams({
    select: "listing_id,platform,shop_code,platform_listings!inner(id,external_listing_id,title,description,content_revision,score_total,score_modules,scored_content_revision,scored_at)",
    variant_id: `eq.${primary.id}`,
    platform: `eq.${platform}`,
    shop_code: `eq.${shopCode}`,
  });
  const listingQs = new URLSearchParams({
    select: "id,external_listing_id,title,description,content_revision,score_total,score_modules,scored_content_revision,scored_at,platform,shop_code",
    variant_id: `eq.${primary.id}`,
    platform: `eq.${platform}`,
    shop_code: `eq.${shopCode}`,
  });
  const [linkRows, directRows] = await Promise.all([
    catalogFetch<Array<Record<string, unknown>>>(config, `/product_platform_links?${linkQs}`),
    catalogFetch<Array<Record<string, unknown>>>(config, `/platform_listings?${listingQs}`),
  ]);
  const candidates = new Map<string, { raw: Record<string, unknown>; platform: string; shopCode: string }>();
  for (const row of linkRows) {
    const raw = row.platform_listings as Record<string, unknown>;
    if (raw?.id) candidates.set(String(raw.id), { raw, platform: String(row.platform), shopCode: String(row.shop_code) });
  }
  for (const raw of directRows) {
    if (raw?.id) candidates.set(String(raw.id), { raw, platform: String(raw.platform), shopCode: String(raw.shop_code) });
  }
  if (candidates.size === 0) return { status: "mapping_error", message: "No exact listing matches this inquiry product and shop" };
  if (candidates.size > 1) return { status: "mapping_conflict", message: "Multiple listings match this inquiry product and shop" };
  const candidate = [...candidates.values()][0];
  const raw = candidate.raw;
  if (!raw?.external_listing_id) return { status: "mapping_error", message: "Exact listing has no marketplace ID" };
  const revision = Number(raw.content_revision || 1);
  return { status: "ready", listing: {
    id: String(raw.id), platform: candidate.platform, shopCode: candidate.shopCode,
    externalListingId: String(raw.external_listing_id), title: String(raw.title || ""),
    description: String(raw.description || ""), contentRevision: revision,
    scoreTotal: typeof raw.score_total === "number" ? raw.score_total : null,
    scoreModules: raw.score_modules && typeof raw.score_modules === "object" ? raw.score_modules as Record<string, unknown> : null,
    scoredAt: typeof raw.scored_at === "string" ? raw.scored_at : null,
    scoreIsStale: Number(raw.scored_content_revision || 0) !== revision,
  }};
}

export async function publishListingText(config: DashboardConfig, listingId: string, body: Record<string, unknown>) {
  if (!config.catalogOwner.apiUrl || !config.catalogOwner.token) throw new Error("Listing publisher is not configured");
  const response = await fetch(`${config.catalogOwner.apiUrl.replace(/\/$/, "")}/api/internal/catalog/listings/${listingId}/operator-text-publishes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.catalogOwner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `Publish failed (${response.status})`));
  return result;
}
