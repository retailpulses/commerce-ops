# Ground Assembly First Responses In Product Data

## Problem

Assembly inquiries can produce unsafe first-response drafts when the automation
does not ground the answer in verified product data.

This violates the 100% first-response automation strategy: every inquiry should
receive a response, but substantive product claims must only be made from
trusted fields. Missing product context, ambiguous product links, or empty
required fields should use a safe category-specific fallback.

## Policy

For Assembly inquiries:

- If exactly one product is linked and the product row is fetched, read the
  product's assembly status field.
- If the assembly status field has a non-empty value, use that value in the
  reply.
- If no product is linked, multiple products are linked, the product row cannot
  be fetched, or assembly status is empty, send the approved Assembly fallback
  template.
- Do not use LLM generation for Assembly replies.
- Do not claim assembled/unassembled state unless the assembly status field
  supports it.

## Acceptance Criteria

- Worker drafting uses the linked product assembly status when available.
- Worker drafting falls back to the approved Assembly fallback template when
  product linking or assembly status is not trustworthy.
- Assembly drafting never calls LLM.
- Regression tests cover confirmed status, missing status, ambiguous product
  link, and no LLM call.
- The retired Python runtime is guarded so Worker remains the single source of
  truth for production behavior.

## Related Branch

`first-response-worker-fix`
