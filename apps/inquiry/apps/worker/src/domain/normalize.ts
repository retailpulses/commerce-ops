import { STOPWORDS, COLOR_KEYWORDS, MARKETING_WORDS } from "../config";

export interface SpecFeatures {
  colors: Set<string>;
  qty?: number;
  tier?: number;
}

const BRACKET_RE = /[【「(\[（][^】」)\]）]*[】」)\]）]/g;
const DATE_RE = /\d+月\d+日/g;
const MULTIPLY_RE = /[×xX]\d+枚/g;
const NEW_WORK_RE = /\d{4}新作/g;
const SPACE_RE = /\s+/g;
const TOKEN_RE = /[A-Za-z0-9]{2,}|[ァ-ヶー]{2,}|[一-龥]{1,}/g;
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

const MARKETING_SORTED = [...MARKETING_WORDS].sort((a, b) => b.length - a.length);

export function cleanName(text: string): string {
  let result = text;

  result = result.replace(BRACKET_RE, "");

  for (const word of MARKETING_SORTED) {
    const escaped = word.replace(ESCAPE_RE, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), "");
  }

  result = result.replace(DATE_RE, "");
  result = result.replace(MULTIPLY_RE, "");
  result = result.replace(NEW_WORK_RE, "");
  result = result.replace(SPACE_RE, " ").trim();

  return result;
}

export function tokenizeV2(text: string): string[] {
  const tokens = text.match(TOKEN_RE) || [];
  return tokens.filter((t) => !STOPWORDS.has(t));
}

export function extractSpecFeatures(text: string): SpecFeatures {
  const colors = new Set<string>();
  for (const color of COLOR_KEYWORDS) {
    if (text.includes(color)) {
      colors.add(color);
    }
  }

  let qty: number | undefined;
  const qtyMatch = text.match(/(\d+)\s*[脚点枚组個]セット?|1脚/);
  if (qtyMatch) {
    qty = parseInt(qtyMatch[1] || "1", 10);
  }

  let tier: number | undefined;
  const tierMatch = text.match(/(\d+)\s*段/);
  if (tierMatch) {
    tier = parseInt(tierMatch[1], 10);
  }

  return { colors, qty, tier };
}

export function getTokenOverlap(tokens1: string[], tokens2: string[]): number {
  if (tokens1.length === 0) return 0;
  const set2 = new Set(tokens2);
  let intersection = 0;
  for (const t of tokens1) {
    if (set2.has(t)) intersection++;
  }
  return intersection / tokens1.length;
}

export function scoreCandidate(
  inputTokens: string[],
  candidateName: string,
  inputFeatures: SpecFeatures,
  inputClean?: string,
): number {
  const candClean = cleanName(candidateName);
  const candTokens = tokenizeV2(candidateName);

  const candSet = new Set(candTokens);
  const inputSet = new Set(inputTokens);

  let intCount = 0;
  for (const t of inputSet) {
    if (candSet.has(t)) intCount++;
  }

  const union = new Set([...inputSet, ...candSet]);
  const iou = union.size > 0 ? intCount / union.size : 0;
  const overlap = getTokenOverlap(inputTokens, candTokens);

  let score = 0.7 * iou + 0.3 * overlap;

  if (inputClean && inputClean.includes(candClean)) {
    score += 0.4;
  } else if (inputClean && candClean.includes(inputClean)) {
    score += 0.2;
  }

  const candFeatures = extractSpecFeatures(candidateName);

  if (inputFeatures.colors.size > 0 && candFeatures.colors.size > 0) {
    const hasOverlap = [...inputFeatures.colors].some((c) => candFeatures.colors.has(c));
    if (!hasOverlap) {
      return 0.0;
    }
  }

  if (inputFeatures.qty != null && candFeatures.qty != null) {
    if (inputFeatures.qty === candFeatures.qty) {
      score += 0.3;
    } else {
      score -= 0.6;
    }
  }

  if (inputFeatures.tier != null && candFeatures.tier != null) {
    if (inputFeatures.tier === candFeatures.tier) {
      score += 0.3;
    } else {
      score -= 0.6;
    }
  }

  const specTerms = new Set<string>();
  for (const token of inputTokens) {
    if (/\d/.test(token)) {
      specTerms.add(token);
    }
  }
  for (const token of specTerms) {
    if (candSet.has(token)) {
      score += 0.15;
    }
  }

  return Math.max(0, score);
}
