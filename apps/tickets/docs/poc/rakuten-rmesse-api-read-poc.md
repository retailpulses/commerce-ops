# Rakuten RMS InquiryManagementAPI Read POC

Status: **Passed (zero-write)**  
Date: 2026-08-23  
Issue: [#192](https://github.com/retailpulses/ticket-handling/issues/192)

## Objective

Verify that the existing Homebliss RMS ESA credential can read R-Messe
inquiries through the official `InquiryManagementAPI`, without changing inquiry
state or exposing customer content.

## Endpoints exercised

- `GET /es/1.0/inquirymng-api/inquiries`
- `GET /es/1.0/inquirymng-api/inquiry/{inquiryNumber}`

Authentication used the existing OrderMgmt VPS environment and fixed egress
path. Credentials were neither printed nor copied into this repository.

No call was made to `reply.post`, attachment upload, read, complete, or
incomplete operations.

## Result

List request for 2026-08-01 through 2026-08-23:

- HTTP 200;
- `totalCount=4`, one page, four returned inquiries;
- all four carried a non-empty `orderNumber`;
- all four contained replies.

Detail request for the known order-related inquiry:

- HTTP 200;
- exact shop ID and order association returned;
- initial customer message present;
- 12 replies and one reply attachment reference returned;
- completion/read state and `lastUpdateDate` returned.

Only aggregate/boolean evidence and a short inquiry suffix were emitted during
the POC. Message bodies, customer identity, full order number, and credentials
were not logged.

## Contract confirmed

The API exposes the fields required for order-only ingestion:

- `inquiryNumber`, `shopId`, `orderNumber`;
- initial `message`, `regDate`, `lastUpdateDate`;
- `replies[].id`, `message`, `regDate`, `isRead`;
- inquiry/reply attachment `label` and `path`;
- completion and merchant-read state.

The native reply ID is suitable as the external message ID. The initial message
needs a deterministic identity derived from account + inquiry number because it
does not expose a separate message ID.

## Outbound status

The operator confirmed on 2026-08-23 that `inquirymngapi.reply.post` is also
`利用中`. API entitlement is therefore not an outbound blocker. A live send was
not part of this zero-write POC; it requires a specifically approved test
inquiry and reply text.
