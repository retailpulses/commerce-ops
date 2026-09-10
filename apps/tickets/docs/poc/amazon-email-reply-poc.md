# Amazon Email Ingestion and Reply POC

Issue: <https://github.com/retailpulses/ticket-handling/issues/235>

Date: 2026-09-07 JST  
Status: Read-only and dry-run complete; no customer-facing send performed.

## Tested order

`249-*******-5024`

## Zoho inbound and reply dry-run

| Check | Result |
|---|---|
| Locate Amazon buyer message | Pass |
| Fetch by native Zoho message ID | Pass |
| Message body available | Pass |
| Expected order number present | Pass |
| Original Amazon anonymized recipient resolved for reply | Pass |
| Sender fixed to `amazon@retailpulses.com` | Pass |
| Reply subject/thread action preserved | Pass |
| Customer-facing send | Not performed |

The tested message reported `hasAttachment=0`. It proves body retrieval and
reply addressing, but not customer-photo retrieval. A known attachment-bearing
message is required for the separate attachment POC.

## SP-API comparison

The same order succeeded with `getMessagingActionsForOrder` and returned only
`updateFeedback` and `sendInvoice`. `GET /attributes` returned only buyer
locale. SP-API returned no buyer message, thread, or attachment and was not used
for the reply dry-run.

## Safety result

The Zoho reply dry-run used the original source message ID and resolved the
Amazon anonymized recipient server-side. The POC-only Japanese placeholder was
marked `送信禁止` and was not submitted. A live canary requires approval of the
exact final Japanese response.

## Change log

- 2026-09-07: Recorded SP-API comparison, Zoho inbound read, and reply dry-run.
