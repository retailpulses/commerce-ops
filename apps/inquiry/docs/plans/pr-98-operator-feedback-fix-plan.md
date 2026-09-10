# PR #98 operator feedback fix plan

Date: 2026-09-04 JST  
Source: PR #98 issue comment `#issuecomment-5537274547`  
Related architecture issue: #92  
Scope: Inquiry Portal detail panel only; no outbound enablement or production write is authorized by this plan.

## Definition of done

All six operator observations are resolved in one coherent detail-panel workflow, covered by component/API tests, and verified in an authenticated `/inquiry/` session. A Send acceptance run must prove the exact displayed text is the text confirmed on Mercari and that the returned N+3 follow-up date is immediately visible and survives reload.

## Findings and fixes

| Priority | Observation | Planned fix | Acceptance |
|---|---|---|---|
| P0 | Send can occur before `Accept & Edit` | Reuse the Ticket Message pattern: `Copywrite` replaces the single editable draft; remove the second result card and `Accept & Edit`. The editor exposes `Review & Send`, while final `Send to Mercari` exists only in a browser-translatable review view. Send uses captured React state, never translated DOM text. | Copywrite replaces the editable textarea. Review displays exactly that value, browser translation works, and Send transmits the original Japanese. |
| P0 | Follow-up date remains null after Send | Consume the authoritative finalizer response, show its N+3 date/state/source immediately, and refresh detail plus timeline. The database RPC remains the unique writer. | Default and overridden dates display immediately and survive reload. |
| P1 | Inquiry URL is gone | Build the Seller Central link server-side from the allowlisted four-shop slug map and canonical inquiry ID; validate legacy fallback URLs. | Every known shop opens the exact inquiry; unknown or malformed identity yields no link. |
| P1 | Message history and timeline duplicate | Remove the legacy raw-log area from the panel without deleting stored evidence. Make normalized `MessageTimeline` the only history and collapse it by default. | Initial view is collapsed; expanding shows normalized chronological messages and no legacy log area. |
| P1 | Linked product exists but summary name is null | Resolve explicit primary link, then first link, then inquiry snapshot; use the same resolved value for screen and clipboard. | Linked-only, snapshot-only, both and neither cases render correctly. |
| P2 | Send is above Copywrite | Order the workflow as Copywrite → editable draft → Review & Send → translatable review → Send. | Desktop and mobile action order matches the operator workflow. |

## Verification and release

1. Add focused regression tests for the data fallbacks, draft/review payload identity, follow-up detail fields, Seller links, collapsed timeline, and legacy-log removal.
2. Run dashboard tests, typecheck, production build, and diff checks.
3. Deploy behind the existing outbound kill switch and verify the authenticated `/inquiry/` UI plus deployed asset/release contract.
4. An actual customer-message canary remains a separate explicit authorization: prove preview payload, Mercari readback, persisted message and follow-up readback before acceptance.

## Boundaries

- Do not add a second follow-up writer or weaken outbound fail-closed behavior.
- Do not derive Seller links from customer-controlled values.
- Do not delete or rewrite stored legacy evidence.
- This plan does not authorize enabling outbound Send or sending a customer message.
