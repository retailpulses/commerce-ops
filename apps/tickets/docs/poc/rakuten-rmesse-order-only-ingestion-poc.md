# Rakuten R-Messe Order-Only Ingestion POC

Status: **Superseded as a source design; retained as notification-format evidence (zero-write)**  
Date: 2026-08-22  
Issue: [#192](https://github.com/retailpulses/ticket-handling/issues/192)

> Production ingestion will use the official RMS R-Messe API. This historical
> email POC must not be used as authority to build a Zoho/mail ingestion path.

## Objective

Prove that R-Messe email notifications can support ticket creation and message
appending while excluding pre-sale product inquiries. Eligibility is based on
an order-qualified R-Messe thread, not merely the email subject.

## Data handling

- Read-only search of Rakuten RMS R-Messe automatic notifications delivered to
  the current Zoho-hosted mailbox; no messages were sent, changed, or deleted.
- Search reports containing customer content are stored only under the
  gitignored `reports/rakuten-message-ingestion-poc/` directory.
- This committed report contains aggregate and structural evidence only.
- No Supabase or Baserow reads/writes were performed.

## Verified notification contract

Sender observed: `ichiba-inquiry@rakuten.co.jp`.

Order inquiry notification:

- `問い合わせ番号` — stable R-Messe thread identity.
- `受注番号` — Rakuten order number, present on the order-bearing event.
- `内容` — message body.
- `https://rmesse.rms.rakuten.co.jp/inquiry/...` — operator deep link.

Later customer replies:

- repeat `問い合わせ番号`;
- normally omit `受注番号`;
- retain the same R-Messe deep link.

Pre-sale product inquiry:

- contains `問い合わせ番号`, product name, and product URL;
- does not contain `受注番号`.

Therefore, a per-email `受注番号 required` filter is incorrect. The safe rule
is: **admit a message only when its `問い合わせ番号` belongs to a thread that
has an explicit `受注番号` on at least one trusted notification.**

## Sample result

The read-only search returned 33 recent R-Messe-related emails:

| Result | Count |
|---|---:|
| Parsed trusted R-Messe notifications | 30 |
| Eligible order-qualified events | 24 |
| Eligible customer events | 11 |
| Eligible seller events | 13 |
| Order-qualified threads | 7 |
| Excluded unqualified/pre-sale thread events | 3 |
| Excluded reminder/non-event notifications | 3 |

All seven eligible threads contained at least one explicit order-bearing event.
The pre-sale sample was rejected because no event qualified its thread with an
order number.

## POC implementation

- Parser: `web/worker/src/logic/rakuten-rmesse-email.ts`
- Tests: `web/worker/tests/rakuten-rmesse-email-poc.test.ts`

The POC demonstrates:

1. trusted-sender and R-Messe signature checks;
2. extraction of thread ID, order number, body, shop, direction, and deep link;
3. two-pass qualification when a reply is encountered before the order-bearing
   event in the same polling batch;
4. qualification from a previously persisted thread-to-order mapping;
5. rejection of a pre-sale product inquiry;
6. customer-versus-seller direction classification;
7. provider-message-ID idempotency.

## Verification

```text
Focused POC tests: 7 passed, 0 failed
Live-sample parser: 33 sampled; 24 eligible; 6 excluded; 7 qualified threads
Hosted writes: 0
```

## POC conclusion

The sample remains useful only as evidence that order qualification belongs at
the inquiry/thread level. The production source decision has since changed to
the official RMS R-Messe API. OrderMgmt's current RMS relay does not expose
R-Messe conversations.

## Version history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-08-22 | Initial zero-write POC and live-format validation |
| 1.1 | 2026-08-23 | Marked email source superseded by official RMS R-Messe API |
