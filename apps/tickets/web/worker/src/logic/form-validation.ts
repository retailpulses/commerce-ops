/** Form completeness validation — pure logic, no I/O. */

export interface FormCompletenessResult {
  /** True when the form has at least 1 image AND a non-empty description. */
  isComplete: boolean;
  hasImages: boolean;
  hasDescription: boolean;
  /** Machine-readable marker for the ticket Comments field. */
  marker: string;
}

/**
 * Check whether a submitted ticket form is complete enough for investigation.
 *
 * A complete form has:
 * - At least one image in the Attachments field (same array semantics as mapFormImages)
 * - A non-empty Description after trimming whitespace
 *
 * Always returns a result — never throws. Missing/undefined fields are treated as absent.
 */
export function checkFormCompleteness(form: {
  Attachments?: unknown;
  Description?: unknown;
  [key: string]: unknown;
}): FormCompletenessResult {
  const attachments = form.Attachments;
  const hasImages = Array.isArray(attachments) && attachments.length > 0;

  const desc = form.Description;
  const hasDescription = typeof desc === "string" && desc.trim().length > 0;

  const isComplete = hasImages && hasDescription;

  let marker: string;
  if (isComplete) {
    marker = "[FORM_COMPLETE]";
  } else {
    const missing: string[] = [];
    if (!hasImages) missing.push("no_image");
    if (!hasDescription) missing.push("no_description");
    marker = `[FORM_INCOMPLETE: ${missing.join(",")}]`;
  }

  return { isComplete, hasImages, hasDescription, marker };
}
