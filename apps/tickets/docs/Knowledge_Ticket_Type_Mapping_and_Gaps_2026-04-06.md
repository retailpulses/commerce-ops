# Knowledge to Ticket Type Mapping and Gaps

Date: 2026-04-06
Source: Baserow `Tickets` table `884687`
Records analyzed: `168`

## Summary

Linked `Knowledge` exists on `21` ticket rows.
The linked knowledge is mostly SOP-style context, not full answer automation.

This means:
- Knowledge helps AI reply drafting on a subset of operational cases
- Knowledge does not remove the need for human review on sensitive tickets
- Several high-volume ticket types still have no or weak Knowledge coverage

## Ticket Type To Knowledge Mapping

### shipping / delivery
- Ticket rows: `50`
- Rows with Knowledge: `5`
- Common Knowledge titles:
  - `on shipping optional service`
  - `Bad review SOP`
  - `Product quality issue handing SOP`
- Assessment:
  - Good for shipping-option wording and logistics guidance
  - Coverage is too thin for the largest ticket type

### other
- Ticket rows: `42`
- Rows with Knowledge: `1`
- Common Knowledge titles:
  - `Order Cancellation before shipping`
- Assessment:
  - This bucket is too broad to rely on Knowledge
  - Most rows need finer ticket typing before Knowledge can help

### positive close / confirmation
- Ticket rows: `14`
- Rows with Knowledge: `1`
- Common Knowledge titles:
  - `Order Cancellation before shipping`
- Assessment:
  - Knowledge coverage is incidental, not purpose-built
  - These rows are usually template-response candidates anyway

### escalation / complaint
- Ticket rows: `13`
- Rows with Knowledge: `0`
- Assessment:
  - Clear gap
  - Complaint handling needs dedicated escalation/complaint SOPs, not generic product-quality guidance

### missing parts
- Ticket rows: `12`
- Rows with Knowledge: `2`
- Common Knowledge titles:
  - `Product quality issue handing SOP`
  - `on invoice`
- Assessment:
  - Partial coverage only
  - Missing-parts cases would benefit from a dedicated parts-resend SOP and a clearer closure script

### bank transfer / payment
- Ticket rows: `9`
- Rows with Knowledge: `3`
- Common Knowledge titles:
  - `Product quality issue handing SOP`
  - `Return address for resellable product`
- Assessment:
  - Weak semantic match
  - Current Knowledge is not tailored to payment or bank-detail handling

### return / RMA
- Ticket rows: `8`
- Rows with Knowledge: `3`
- Common Knowledge titles:
  - `Product quality issue handing SOP`
- Assessment:
  - Better than average, but still generic
  - This type needs explicit return / RMA SOP coverage

### assembly / installation
- Ticket rows: `7`
- Rows with Knowledge: `1`
- Common Knowledge titles:
  - `Order Cancellation before shipping`
- Assessment:
  - Mismatch
  - Assembly and installation need their own technical troubleshooting knowledge

### form / channel issue
- Ticket rows: `5`
- Rows with Knowledge: `3`
- Common Knowledge titles:
  - `Shipping parts with COS or UPS from China factory`
  - `Product quality issue handing SOP`
  - `Product disposal`
- Assessment:
  - Knowledge is present but loosely matched
  - Most value comes from process guidance, not direct answer text

### refund
- Ticket rows: `4`
- Rows with Knowledge: `0`
- Assessment:
  - Clear gap
  - Refund handling needs a dedicated refund policy / wording pack

### damage / defect
- Ticket rows: `3`
- Rows with Knowledge: `1`
- Common Knowledge titles:
  - `Bad review SOP`
- Assessment:
  - Very thin coverage
  - Damage cases need explicit photos, replacement, return, and disposal decision guidance

### replacement / parts resend
- Ticket rows: `1`
- Rows with Knowledge: `1`
- Common Knowledge titles:
  - `Product quality issue handing SOP`
- Assessment:
  - Exists, but only as a side-effect of generic quality SOP coverage

## Best-Fit Knowledge Titles

Most reusable titles across the table:
- `Product quality issue handing SOP`
- `Order Cancellation before shipping`
- `on shipping optional service`
- `Bad review SOP`
- `Shipping parts with COS or UPS from China factory`

These are useful, but they are still broad SOPs.
They do not fully cover the ticket types that dominate the table.

## Knowledge Gaps

High-priority gaps:
- `refund`
- `escalation / complaint`
- `assembly / installation`

Medium-priority gaps:
- `bank transfer / payment`
- `shipping / delivery` at scale
- `damage / defect`
- `missing parts`

Structural gap:
- the `other` bucket is too large, which means ticket typing is still too coarse for Knowledge routing

## What Knowledge Should Be Added

Recommended new Knowledge packs:
- refund policy and refund wording
- complaint / escalation de-escalation wording
- parts-resend and missing-parts workflow
- damage-case photo request and replacement decision tree
- assembly / installation troubleshooting
- payment / bank-detail collection script
- return / RMA instructions

## Practical Conclusion

Knowledge currently helps most when the ticket is already a standard operational case.
The biggest gap is not AI capability.
The biggest gap is missing, ticket-type-specific Knowledge packs for the most frequent real case families.
