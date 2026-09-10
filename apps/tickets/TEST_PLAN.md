# Mobile UI MVP — Test Plan

## Automated Checks (CI-equivalent, already passing)
- [x] `tsc --noEmit` — no type errors (155 lines added, 0 errors)
- [x] `wrangler deploy --dry-run` — compiles, 155.64 KiB total upload

## Functional Tests (manual — run in browser DevTools mobile emulation)

### A. Panel Navigation (core feature)
| # | Test | Steps | Expected |
|---|------|-------|----------|
| A1 | List loads on mobile | Set viewport to 375px (iPhone SE), login | Ticket list fills full viewport, no split panel |
| A2 | Tap ticket → detail | Tap any ticket card | Ticket list hides, detail panel shows full-screen with back button (←) |
| A3 | Back button → list | Tap ← back button in detail header | Detail hides, list returns with scroll position preserved |
| A4 | Multiple ticket taps | Tap ticket A → back → tap ticket B | Each tap correctly loads and shows the new ticket detail |
| A5 | Load More in list | Scroll to bottom, tap "Load More" | More tickets appended, no panel switch |

### B. Panel Navigation (desktop)
| # | Test | Steps | Expected |
|---|------|-------|----------|
| B1 | Desktop unchanged | Set viewport to 1440px | Side-by-side layout, same as before — no back button visible |
| B2 | Tablet split | Set viewport to 1024px | Side-by-side layout, back button hidden |

### C. Filters (mobile)
| # | Test | Steps | Expected |
|---|------|-------|----------|
| C1 | Filter toggle visible | Set viewport 375px | "▼ Filter" button visible next to search input |
| C2 | Filters collapsed default | Fresh login on mobile | Filters hidden, button shows "▼ Filter" |
| C3 | Toggle open filters | Tap "▼ Filter" | Filters slide open, button shows "▲ Filter" |
| C4 | Filter still works | Open filters, change Shop/Status/Reply | Filter applies immediately, list updates |
| C5 | Toggle close filters | Tap "▲ Filter" | Filters slide closed |
| C6 | Filters on desktop | Set viewport 1024px+ | Filter toggle button hidden, filters always visible |

### D. Existing Features (regression — all viewports)
| # | Test | Steps | Expected |
|---|------|-------|----------|
| D1 | Tab switching | Open ticket detail on mobile, tap Messages/Images/Description/Notes | Tabs switch correctly, tabs remain sticky in scroll |
| D2 | Copywrite (AI reply) | Tap "Copywrite (DeepSeek)" | AI reply generated in draft editor |
| D3 | Send reply | Type message, tap Send Reply | Confirm dialog shown, send executes |
| D4 | Save draft | Type message, tap Save Draft | Draft saved, badge reflects |
| D5 | Add note | In Notes tab, type note, tap + Add Note | Note appended below |
| D6 | Refresh messages | Tap ↻ Refresh | Messages refreshed from Mercari |
| D7 | Status change | Change status dropdown | Status updates, ticket list reflects change |
| D8 | Image lightbox | Tap any image in Messages or Images tab | Lightbox opens at full resolution, tap to close |
| D9 | Search by Order ID | Type partial order ID in search | Ticket list filters live |
| D10 | Prompt Manager | Tap "Prompt Manager" in header | Prompt Manager opens full-screen on mobile, "Back to Tickets" works |

### E. Edge Cases
| # | Test | Steps | Expected |
|---|------|-------|----------|
| E1 | Orientation change | Load list → rotate to landscape → tap ticket | Detail shows correctly in landscape |
| E2 | Resize mid-session | Start at 375px, tap ticket (detail shows) → resize to 1024px | Both panels appear (desktop split mode restores) |
| E3 | Resize back | Resize to 375px while in detail view | Single panel detail retained |
| E4 | Login gate | Open on 375px | Login form fits, no overflow |
| E5 | Gate → workspace | Login on mobile | Workspace list view fills screen |
| E6 | Confirm send on mobile | Tap Send Reply on mobile | Confirm overlay fits within viewport, buttons tappable |
| E7 | Toast on mobile | Trigger any toast (e.g., save draft) | Toast visible at bottom-center on mobile |
| E8 | iOS safe area | Test on real iPhone (notch) | No overlap with notch/home indicator |

## Integration Tests (automated, CI)
| # | Check | How |
|---|-------|-----|
| IT1 | TypeScript compilation | `npx tsc --noEmit` |
| IT2 | Worker deploy | `npx wrangler deploy --dry-run` |
| IT3 | PR check | GitHub Actions `pr-check.yml` on PR to main |

## Test Matrix

| Viewport | Device | Functional tests |
|----------|--------|-----------------|
| 375px | iPhone SE | A1-A5, C1-C6, D1-D10, E1-E8 |
| 390px | iPhone 14 | A1-A5, C1-C6, D1-D10, E1-E8 |
| 430px | iPhone 15 Pro Max | A1-A5, C1-C6, D1-D10 |
| 768px | iPad Mini (portrait) | B2, D1-D10 |
| 1024px | iPad Air (landscape) | B2, D1-D10 |
| 1440px | Desktop | B1, D1-D10 |

## Pass/Fail Criteria
- **Blocking**: A1, A2, A3, B1, C2, C3 — core navigation must work
- **High**: A4, A5, C4, C6, D1-D5 — existing features must not regress
- **Medium**: D6-D10, E1-E8 — edge cases should pass
