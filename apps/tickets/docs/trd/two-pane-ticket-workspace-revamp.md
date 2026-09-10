# TRD: Two-Pane Ticket Workspace Revamp

**Status**: proposed
**Date**: 2026-07-09
**Scope**: Supabase Ticketing MVP operator UI

## 1. Problem

The current ticket workspace uses a full-width ticket table and opens a ticket in a separate detail view. This creates friction for operators because every ticket review requires a context switch:

- scan list
- open detail
- inspect messages, notes, products, status, and composer
- go back to the list
- repeat

For triage and reply workflows, operators need to keep list context visible while reviewing and updating a selected ticket.

## 2. Goal

Revamp the ticket page into a persistent two-pane workspace:

- ticket list on the left
- selected ticket detail on the right
- filters and search always available above the list
- detail pane updates in place when a ticket is selected
- mobile falls back to list/detail navigation

The first desktop screen should be the usable ticket workspace, not a separate landing or table-only page.

## 3. Non-Goals

- No database schema change.
- No API contract change required.
- No change to ticket creation fields.
- No change to message sending semantics.
- No migration from legacy Baserow tickets in this task.
- No redesign of authentication.

## 4. Current UI

Relevant current implementation:

- `web/worker/src/handlers/ticketing.ts`
- `#view-list` contains the filter topbar and full-width ticket table.
- `#view-detail` is a separate screen shown by `showView("view-detail")`.
- `openDetail(id)` hides the list and fetches detail data.
- `showList()` hides detail and clears the selected ticket.

Current behavior is functional, but it is optimized for record browsing rather than queue processing.

## 5. Target Layout

Desktop and tablet landscape:

```text
+-------------------------------------------------------------+
| Header                                                      |
+-------------------------------+-----------------------------+
| Filters / Search / New Ticket | Detail toolbar              |
|-------------------------------|-----------------------------|
| Ticket list                   | Ticket fields               |
| - selected row/card           | Tabs: Messages / Notes ...  |
| - status, priority, age       | Conversation / detail body  |
| - customer/order/subject      | Response composer           |
| - Load more / count           |                             |
+-------------------------------+-----------------------------+
```

Recommended proportions:

- Left pane: `360px` fixed preferred width, clamped between `320px` and `440px`.
- Right pane: remaining width, `min-width: 0`.
- Header: fixed at top.
- Workspace: `height: calc(100dvh - 52px)`.
- Each pane owns its own scrolling region.

Mobile:

- Keep the current list/detail navigation pattern.
- Selecting a ticket opens the detail pane full-screen.
- Back button returns to the list.
- Do not force a cramped two-column layout below `900px`.

## 6. Information Architecture

### 6.1 Left Pane

The left pane is the operator queue. It should include:

- search input
- platform filter
- status filter
- priority filter
- sort selector
- new ticket button
- ticket count
- ticket list

Replace the table with dense list rows/cards. Each item should show:

- ticket number
- platform badge
- status tag
- priority indicator
- subject
- customer display name
- external order ID
- latest message date
- selected state

List item height should remain stable so scanning is predictable.

### 6.2 Right Pane

The right pane is the selected ticket workspace. It should include:

- ticket number, platform, order ID, and subject in the detail toolbar
- status and priority controls
- subject, issue type, started date, customer, and external URL fields
- tabs for Events, Messages, Notes, Products, and Description
- Mercari response composer when the selected ticket is Mercari

When no ticket is selected, show a neutral empty state:

```text
Select a ticket to view details
```

### 6.3 Create Ticket

Ticket creation can remain a separate view/modal for this task.

Recommended first implementation:

- Keep `showCreate()` as a full workspace view.
- Return to the two-pane workspace after create/cancel.

Future enhancement:

- Convert create ticket into a right-pane drawer or modal if operators need to create tickets while preserving list context.

## 7. Interaction Design

### 7.1 Selecting Tickets

- Clicking a list item calls `openDetail(id)`.
- The list remains visible on desktop.
- The selected item gets a persistent active style.
- On fetch start, right pane should show loading state while preserving the selected item highlight.
- If the fetch fails, keep the list visible and show a toast.

### 7.2 Updating Ticket Fields

Field updates continue using `PATCH /api/ticketing/tickets/:id`.

After a successful update:

- update `state.ticket`
- update the matching item in `state.tickets`
- re-render the active list row so status, priority, subject, or customer changes are reflected without reloading the list

### 7.3 Filters

Changing filters reloads the left pane.

If the selected ticket is no longer present after filtering:

- keep the right-pane detail open if the operator is editing it
- visually remove the active list item
- do not clear unsent composer text

This avoids losing in-progress work when an operator changes list filters.

### 7.4 Composer

The composer remains in the right pane. It should stay anchored at the bottom of the detail pane, with the tab content scrolling above it.

For non-Mercari tickets, hide the composer as currently implemented.

## 8. Frontend Implementation Plan

### 8.1 State

Current:

```javascript
var state = { tickets: [], ticket: null, events: [], products: [], tab: "events", ... };
```

Add or standardize:

```javascript
selectedTicketId: null,
detailLoading: false
```

Use `selectedTicketId` for left-pane active state instead of deriving selection only from `state.ticket`.

### 8.2 DOM Structure

Replace the desktop list/detail route split with a workspace shell:

```html
<div id="view-workspace">
  <aside id="ticket-list-pane">
    <div id="list-toolbar">...</div>
    <div id="ticket-list"></div>
  </aside>
  <main id="ticket-detail-pane">
    <div id="detail-empty">Select a ticket to view details</div>
    <div id="detail-content">...</div>
  </main>
</div>
```

Keep `#view-create` as the separate create-ticket screen.

For mobile, CSS can make `#view-workspace` show either the list pane or detail pane based on a class such as:

```text
workspace-list-mode
workspace-detail-mode
```

### 8.3 Rendering

Replace `renderList()` table rendering with `renderTicketList()` list-item rendering.

Keep `renderDetail()` and tab renderers, but render into the right pane instead of a separate full-screen view.

Recommended function split:

- `renderWorkspace()`
- `renderTicketList()`
- `renderDetailShell()`
- `renderDetail()`
- `renderDetailTab()`

### 8.4 Navigation Functions

Current:

- `showList()`
- `showCreate()`
- `openDetail(id)`

Recommended:

- `showWorkspace()`
- `showCreate()`
- `openDetail(id)`
- `closeMobileDetail()`

`showList()` may remain as a compatibility alias for `showWorkspace()`.

### 8.5 CSS

Add stable layout CSS:

```css
#view-workspace {
  display: grid;
  grid-template-columns: clamp(320px, 32vw, 440px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

#ticket-list-pane,
#ticket-detail-pane {
  min-height: 0;
  overflow: hidden;
}

#ticket-list {
  overflow-y: auto;
}

#ticket-detail-pane {
  display: flex;
  flex-direction: column;
}

#tab-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
```

At `max-width: 899px`, switch to one pane at a time.

## 9. Accessibility and Usability

- List items must be keyboard-focusable buttons or rows with `tabindex="0"`.
- Pressing Enter on a focused list item opens the ticket.
- Active ticket state should not depend on color alone.
- Detail controls must retain labels.
- Empty, loading, and error states must be visible inside the pane where they occur.
- Text must not overflow list items; long subjects should clamp to two lines.

## 10. Acceptance Criteria

- [ ] Desktop layout shows ticket list on the left and selected ticket detail on the right.
- [ ] Selecting a ticket updates the right pane without hiding the list.
- [ ] The selected ticket is visibly highlighted in the left pane.
- [ ] Ticket fields, tabs, product links, notes, messages, and composer still work.
- [ ] Updating status, priority, subject, customer, or external URL updates both detail and list state.
- [ ] Filters reload the list without destroying the currently open detail pane.
- [ ] Empty detail state appears when no ticket is selected.
- [ ] Mobile width uses single-pane list/detail navigation with a back button.
- [ ] No API or database schema changes are required.
- [ ] Existing ticketing tests pass, and at least one UI smoke test covers the two-pane layout.

## 11. Test Plan

### Manual

1. Login to the ticket workspace.
2. Confirm desktop opens as a two-pane workspace.
3. Select a ticket from the left list.
4. Confirm detail loads on the right and the list remains visible.
5. Change status and priority; confirm the selected list item updates.
6. Switch tabs: Events, Messages, Notes, Products, Description.
7. For a Mercari ticket, confirm the composer appears and draft text is not lost by list filtering.
8. Apply filters and search; confirm list reloads.
9. Resize below `900px`; confirm mobile list/detail behavior.

### Automated

- Add or update frontend/handler tests to assert the ticket workspace HTML includes `ticket-list-pane` and `ticket-detail-pane`.
- Add a smoke test for `openDetail(id)` that verifies it does not hide the list pane on desktop.
- Run existing worker tests.

## 12. Implementation Order

1. Introduce workspace shell and pane CSS.
2. Convert ticket table into left-pane list items.
3. Move detail screen markup into right-pane detail content.
4. Update `showView`, `showList`, and `openDetail` behavior for desktop.
5. Add selected/loading/empty states.
6. Keep mobile single-pane behavior with responsive CSS/class toggles.
7. Verify field updates sync back into the list item.
8. Run tests and manual smoke checks.

## 13. Risks

- Inline HTML inside `ticketing.ts` is large, so layout changes are easy to regress.
- Existing functions assume list/detail are mutually exclusive views.
- Composer draft state can be lost if detail re-renders too broadly.
- Mobile behavior needs explicit testing because desktop two-pane CSS can easily create overflow.

Mitigation:

- Keep the first implementation scoped to layout and state flow.
- Avoid API changes.
- Preserve existing detail tab rendering functions where possible.
- Add a small smoke test for workspace DOM structure.
