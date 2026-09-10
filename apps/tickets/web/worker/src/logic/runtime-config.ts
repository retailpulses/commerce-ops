/** Shared runtime initialization for ticket processing entrypoints. */

import { setLLMConfig } from "./classifier";

export const TICKET_LLM_MODEL = "deepseek-v4-flash";
export const TICKET_LLM_FALLBACK_MODEL = "gpt-4o";
export const TICKET_LLM_MAX_CALLS_PER_RUN = 200;
export const TICKET_LLM_CLOSE_THRESHOLD = 0.85;

export function initTicketProcessingRuntime(llmEnabled = true): void {
  setLLMConfig(
    TICKET_LLM_MODEL,
    TICKET_LLM_MAX_CALLS_PER_RUN,
    TICKET_LLM_CLOSE_THRESHOLD,
    llmEnabled,
    TICKET_LLM_FALLBACK_MODEL
  );
}
