# Favorite Tickets — Feature Requirements & Design

## 1. Problem

Operators routinely work with a subset of high-priority or unresolved tickets across sessions. There is currently no way to mark a ticket for quick recall — operators must search or scroll through the full list every time. A lightweight "favorite" mechanism reduces friction.

## 2. Goal

Allow the operator to **favorite/unfavorite a ticket** with one click, **filter the list to show only favorites**, and have favorites **persist across sessions**.

## 3. Storage Decision

**Store `Favorite` as a boolean checkbox field in Baserow** (table 884687), not in KV or localStorage.

| Storage | Pros | Cons |
|---|---|---|
| Baserow checkbox | Survives cache clears, queryable via filter API, synced across all sessions automatically, no new infra | One extra API field write per toggle |
| KV (per-session) | — | Lost on session expiry, not shared, not queryable |
| localStorage | — | Per-browser only, lost on clear, not queryable |

## 4. Baserow Schema

Add one field to Tickets table (884687):

| Field Name | Type | Default |
|---|---|---|
| `Favorite` | Checkbox | unchecked |

> Baserow checkbox fields map to `true` / `false` in the API.

## 5. API Changes

### 5.1 Type additions

**`TicketSummary`** — add:
```typescript
favorited?: boolean;
```

**`TicketDetail`** — inherit from `TicketSummary` (no extra work).

**`TicketFilters`** — add:
```typescript
favorited?: string; // "true" to show only favorites
```

**`TicketUpdateRequest`** — add:
```typescript
favorited?: boolean;
```

### 5.2 Endpoint: `PATCH /api/tickets/:id`

Accept `{ favorited: true }` / `{ favorited: false }`. Maps to Baserow field `"Favorite"`.

### 5.3 Endpoint: `GET /api/tickets`

Accept new query param `favorited=true` — filters to show only tickets where `Favorite` is true.

### 5.4 Response: `GET /api/tickets/:id`

Include `favorited: boolean` in the returned `TicketDetail`.

## 6. Server-side Implementation

### `src/types.ts`

- Add `favorited?: boolean` to `TicketSummary`
- Add `favorited?: boolean` to `TicketUpdateRequest`

### `src/clients/baserow.ts`

- **`TicketFilters`**: add `favorited?: string`
- **`normalizeTicketSummary`**: read `row["Favorite"]` → set `favorited` to the raw boolean (Baserow returns `true`/`false` for checkbox fields)
- **`listTicketsPaginated`**: if `filters.favorited === "true"`, push `filter__Favorite__boolean=true`
- **`updateTicket`**: already handles arbitrary `fields` — no change needed

### `src/handlers/tickets.ts`

- **`handleListTickets`**: read `favorited` from query params, pass into filters
- **`handleUpdateTicket`**: accept `favorited` in the body, set `fields["Favorite"]`
- **`handleGetTicket`**: the `normalizeTicketSummary` call already returns `favorited` — just ensure it flows to `TicketDetail`

## 7. Frontend UI Changes

### 7.1 State (`state` object)

Add:
```javascript
favoriteFilter: false,  // false = show all, true = show only favorites
```

### 7.2 Filter row — Favorites toggle

Add a visual toggle in `#filter-section` (between the Type and Reply filters, or alongside the search bar):

```html
<label style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;user-select:none">
  <input type="checkbox" id="favorite-filter" onchange="toggleFavFilter()" />
  ★ Favorites
</label>
```

`toggleFavFilter()` updates `state.favoriteFilter` and calls `applyFilters()`.

When `state.favoriteFilter` is true, `loadTickets()` includes `favorited=true` in the query params.

### 7.3 Ticket card — Star indicator

Each ticket card in the sidebar gets a star icon in the `tc-top` row, next to the order ID:

```javascript
// In renderTicketList
var star = t.favorited ? '★' : '☆';
// ... add to tc-top
'<span class="fav-star" data-id="'+t.id+'" onclick="event.stopPropagation();toggleFavorite('+t.id+')">'+star+'</span>'
```

CSS for `.fav-star`:
- Cursor pointer, font-size ~14px
- Color: `#f59e0b` (amber) when filled, `var(--text-xs)` when outline
- Transition on color
- Prevent click-through to `selectTicket()` via `event.stopPropagation()`

### 7.4 Detail header — Star toggle

In `renderTicketDetail`, add a star button in `#detail-top`:

```javascript
'<button class="fav-btn" onclick="toggleFavorite('+ticket.id+')" title="Toggle favorite">'+
  (ticket.favorited ? '★' : '☆') +
'</button>'
```

CSS for `.fav-btn`:
- `background: none; border: none; cursor: pointer; font-size: 16px;`
- Color amber when filled, text-xs when outline

### 7.5 `toggleFavorite(id)` function

```javascript
async function toggleFavorite(id) {
  var ticket = state.tickets.find(function(t) { return t.id === id; });
  if (!ticket) return;
  var newVal = !ticket.favorited;
  // Optimistic UI
  ticket.favorited = newVal;
  if (state.selectedTicket && state.selectedTicket.id === id) {
    state.selectedTicket.favorited = newVal;
    renderTicketDetail(state.selectedTicket);
  }
  renderTicketList();
  try {
    await apiFetch("/api/tickets/" + id, {
      method: "PATCH",
      body: JSON.stringify({ favorited: newVal })
    });
    toast(newVal ? "Added to favorites" : "Removed from favorites", "info");
  } catch (e) {
    // Revert on failure
    ticket.favorited = !newVal;
    if (state.selectedTicket && state.selectedTicket.id === id) {
      state.selectedTicket.favorited = !newVal;
      renderTicketDetail(state.selectedTicket);
    }
    renderTicketList();
    toast("Failed to update favorite", "error");
  }
}
```

### 7.6 `loadTickets` / `loadMore` — Favorites filter

When building query params:
```javascript
if (state.favoriteFilter) params.set("favorited", "true");
```

### 7.7 `applyFilters`

Add:
```javascript
state.favoriteFilter = document.getElementById("favorite-filter").checked;
```

## 8. No-UI (Empty / Edge) States

| State | Behaviour |
|---|---|
| No tickets are favorited | "Favorites" filter shows "No tickets found" message |
| Ticket is favorited | Star is amber-filled (★); toggling removes it |
| Ticket is not favorited | Star is grey-outline (☆); toggling fills it |
| API call fails on toggle | Toast error, UI reverts to previous state |
| Favorite filter is on with active filters | Combined query — only favorited tickets matching other filters |
| Load More with favorite filter on | Cursor pagination continues with `favorited=true` |

## 9. Files to Modify

| File | Changes |
|---|---|
| `web/worker/src/types.ts` | Add `favorited` to `TicketSummary` and `TicketUpdateRequest` |
| `web/worker/src/clients/baserow.ts` | Add `favorited` to `TicketFilters`; read+normalize `Favorite` field; add filter |
| `web/worker/src/handlers/tickets.ts` | Read `favorited` query param; accept `favorited` in PATCH body |
| `web/worker/index.ts` | Frontend: state, filter UI, star icon, toggle function |

## 10. Implementation Order

1. Add `Favorite` checkbox field to Baserow table 884687
2. Modify types and Baserow client (read/write/filter)
3. Modify API handlers (list filter, PATCH body)
4. Frontend: star icon on cards + detail header
5. Frontend: favorites filter toggle
6. Frontend: `toggleFavorite` with optimistic UI
7. Test

## 11. Test Plan

### Server-side
- `GET /api/tickets?favorited=true` returns only favorited tickets
- `PATCH /api/tickets/:id` with `{favorited: true}` writes to Baserow
- `GET /api/tickets/:id` returns `favorited` field matching Baserow value
- Toggle off (`favorited: false`) correctly clears the field

### Frontend (manual)
- Clicking ☆ on a card → fills amber (★), API call succeeds
- Clicking ★ on a card → outlines (☆), API call succeeds
- Star click does NOT trigger ticket selection
- Check "Favorites" checkbox → list shows only favorited tickets
- Uncheck → list shows all tickets
- Favorite a ticket while filter is active → card still shows
- Un-favorite while filter active → card disappears from list
- Refresh page → favorites persist
- Open ticket detail → star in header matches state
- Toggle in header → card star updates in sidebar
- API error → optimistic revert with error toast

## 12. Out of Scope (Future)

- Favorites sort order (favorites first, then by date)
- Drag-to-reorder favorites
- Per-operator favorites (requires user accounts)
- Export favorites report
