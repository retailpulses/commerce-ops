import { CLASSIFICATION_KEYWORDS, INQUIRY_TYPE_KEYS } from "../config";

/**
 * Classify an inquiry message by keyword matching.
 * Returns a Supabase `inquiry_types.key` (TEXT, snake_case) rather than
 * the canonical inquiry type key.
 */
export function classifyByKeywords(msg: string): string {
  for (const [typeName, regexes] of Object.entries(CLASSIFICATION_KEYWORDS)) {
    for (const re of regexes) {
      if (re.test(msg)) {
        return INQUIRY_TYPE_KEYS[typeName];
      }
    }
  }
  return INQUIRY_TYPE_KEYS["Others"];
}

export function isOkinawa(msg: string): boolean {
  return /沖縄|離島|okinawa/i.test(msg);
}
