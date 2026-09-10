# Build Plan: Issue 100 — Two-Pane Ticket Workspace Revamp (React + Vite + Supabase)

| Field | Value |
|-------|-------|
| **Status** | Approved |
| **Date** | 2026-07-09 |
| **Author** | Planning agent (review-issue-100-and-lucky-lake) |
| **Issue** | [#100](https://github.com/retailpulses/ticket-handling/issues/100) |
| **Repo** | `ticket-handling` |
| **Related docs** | [TRD: Two-Pane Ticket Workspace Revamp](./two-pane-ticket-workspace-revamp.md), [Supabase Ticketing MVP Spec](./supabase-ticketing-mvp-spec.md) |

---

## 1. Context

### 1.1 Current State

The ticketing UI is an **inline SPA** -- 1,207 lines of HTML/CSS/JS embedded as a template string (`TICKETING_INDEX_HTML`) inside `web/worker/src/handlers/ticketing.ts`. The Cloudflare Worker serves this string directly for `GET /`, `/ticketing`, and `/ticketing/new`.

The API layer is solid: 15+ REST endpoints at `/api/ticketing/*`, backed by Supabase PostgreSQL, with KV-based session auth. The database schema is fully migrated (tickets, messages, notes, events, products, attachments, drafts, sent_messages, copywriting_logs).

The `web/frontend/` directory exists but is effectively empty (no source files, only `node_modules`).

Key pain points with the current SPA:
- List and detail views are mutually exclusive -- operators must context-switch between scanning and replying.
- 1,200+ lines of imperative DOM manipulation are hard to maintain.
- No build step, no type checking, no module structure.

### 1.2 Target State

| Layer | Current | Target |
|-------|---------|--------|
| Frontend framework | Inline vanilla JS SPA in Worker string | **React 18 + Vite + TypeScript** in `web/frontend/` |
| Routing | Manual `showView()` DOM toggle | **React Router v7** (client-side: `/`, `/tickets/:id`, `/tickets/new`) |
| State management | Global `var state = {...}` | **React Query (TanStack Query)** for server state; **React Context** for auth |
| Styling | Inline CSS in template string | **Tailwind CSS** with design tokens |
| API layer | Direct `fetch()` calls | Typed API client layer with auth headers |
| Layout | Mutually exclusive `#view-list` / `#view-detail` | **Persistent two-pane workspace** (list left, detail right) |
| Database | Supabase PostgreSQL | Supabase PostgreSQL (unchanged) |
| Backend API | CF Worker `/api/ticketing/*` | CF Worker `/api/ticketing/*` (unchanged) |
| Build / deploy | No build step | Vite build, Worker serves static assets |
| Auth | Password -- KV session token | Same API, React auth context |
| Mobile | Single-pane fallback | Same approach, responsive CSS |

### 1.3 What Stays the Same

- All `/api/ticketing/*` endpoints (15+ routes) -- zero backend changes.
- Supabase database schema -- no migrations required.
- KV session auth mechanism.
- Authentication flow (password -- POST /api/session -- Bearer token).
- Overall acceptance criteria for ticket operations.

---

## 2. Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **React 18 + Vite** | Matches existing JS ecosystem; Vite is fast, standard for new React projects; TypeScript support out of the box |
| 2 | **React Router v6** | Client-side routing for `/`, `/tickets/:id`, `/tickets/new`; params-driven selection state |
| 3 | **TanStack Query (React Query)** | Server state management for tickets, messages, products -- built-in caching, refetching, loading/error states, mutations with optimistic updates |
| 4 | **Tailwind CSS** | Rapid UI development, matches design system tokens, no CSS file bloat |
| 5 | **API through Worker, not direct Supabase** | Security -- `service_role` key never reaches the browser; auth already works via KV sessions |
| 6 | **Worker serves built React app** | Vite builds to `web/frontend/dist/`; Worker imports and serves static assets. Single deploy target, no CORS issues. |
| 7 | **Keep all existing API routes unchanged** | Minimum risk -- backend is stable and tested; the entire scope is a frontend replacement |
| 8 | **Wrangler `[assets]` config for static files** | Built-in Workers Assets support, simpler than manual import, handles `Content-Type` and caching |
| 9 | **Feature flag for rollout** | Old SPA remains as a fallback enabled by `ENABLE_REACT_FRONTEND` environment variable |
| 10 | **Copied types (no shared package)** | Frontend types mirror backend types manually; a shared package can be extracted post-MVP if the interface proves stable |

---

## 3. Agent Team Structure

Six specialized teams coordinated across three phases. Phase 1 teams can work in parallel after the foundation is laid.

### 3.1 Dependency Graph

```text
Phase 1: Foundation (sequential start, then parallel)
========================================================
Team Foundation  -->  Team API Client    Team UI Kit
                           |                  |
                      Phase 2: Features (parallel within constraints)
                      =============================================
                      Team List Pane   Team Detail Pane   Team Composer
                           |                  |                  |
                      Phase 3: Integration and Deployment
                      =============================================
                      Team Integration (workspace shell + routing)
                           |
                      Team Worker (CF Worker static serving update)
                           |
                      Team Test (test updates + verification)
```

### 3.2 Team Assignments

| # | Team | Agents | Key Deliverable | Depends On |
|---|------|--------|-----------------|------------|
| 1 | **Foundation** | 1 | Vite + React + TS project, Tailwind, folder structure, routing skeleton | -- |
| 2 | **API Client** | 1 | Typed API client, auth context, React Query hooks | Foundation |
| 3 | **UI Kit** | 1 | Shared components: badges, tags, buttons, modals, toast, layout primitives | Foundation |
| 4 | **List Pane** | 1 | Left pane: filters, search, ticket list items, selection state | API Client, UI Kit |
| 5 | **Detail Pane** | 1 | Right pane: detail toolbar, editable fields, tabs (Events/Messages/Notes/Products/Description) | API Client, UI Kit |
| 6 | **Composer** | 1 | Response Composer: AI copywrite, draft editor, send modal, thread display | API Client, UI Kit |
| 7 | **Integration** | 1 | Two-pane workspace shell, React Router wiring, responsive breakpoints, field sync | List, Detail, Composer |
| 8 | **Worker** | 1 | Update CF Worker to serve built React app (static assets + SPA fallback) | Integration |
| 9 | **Test** | 1 | Update worker routing tests, manual smoke verification | All |

**Total: 9 teams.** Sequential start (Foundation) -- Phase 2 parallel -- Phase 3 sequential.

---

## 4. Team Scopes, Deliverables, and Verification

### 4.1 Team 1: Foundation -- Project Setup

**Scope**

1. Initialize the Vite + React + TypeScript project in `web/frontend/`:
   ```bash
   npm create vite@latest . -- --template react-ts
   ```

2. Install dependencies:
   ```bash
   npm install react-router-dom @tanstack/react-query tailwindcss @tailwindcss/vite
   npm install -D @types/react @types/react-dom
   ```

3. Configure tooling:
   - `vite.config.ts`: React plugin, Tailwind plugin, proxy `/api` to Worker dev server (`http://localhost:8787`)
   - `tsconfig.json`: strict mode, `@/` path alias pointing to `src/`
   - `package.json` scripts: `dev`, `build`, `preview`, `typecheck` (`tsc --noEmit`)

4. Set up folder structure:
   ```
   web/frontend/src/
   ├── main.tsx                  # React entry point
   ├── App.tsx                   # Router + QueryClientProvider + AuthProvider
   ├── index.css                 # Tailwind imports + global styles
   ├── api/
   │   ├── client.ts             # fetch wrapper with auth token
   │   ├── tickets.ts            # ticket API functions
   │   ├── products.ts           # product search API
   │   ├── copywriting.ts        # copywrite/send/draft API
   │   └── types.ts              # API request/response types
   ├── hooks/
   │   ├── useAuth.ts            # auth context + hook
   │   ├── useTickets.ts         # React Query hooks for tickets
   │   └── useCopywriting.ts     # React Query hooks for composer
   ├── components/
   │   ├── ui/                   # shared UI primitives
   │   ├── layout/               # workspace shell, header
   │   ├── tickets/              # list pane, detail pane, create form
   │   └── composer/             # response composer
   ├── pages/
   │   ├── WorkspacePage.tsx     # two-pane workspace (list + detail)
   │   ├── CreateTicketPage.tsx  # create ticket form
   │   └── LoginPage.tsx         # password gate
   └── lib/
       └── utils.ts              # date formatting, html escaping, etc.
   ```

5. Set up router skeleton in `App.tsx`:
   ```tsx
   <QueryClientProvider>
     <AuthProvider>
       <Routes>
         <Route path="/" element={<WorkspacePage />} />
         <Route path="/tickets/:id" element={<WorkspacePage />} />
         <Route path="/tickets/new" element={<CreateTicketPage />} />
       </Routes>
     </AuthProvider>
   </QueryClientProvider>
   ```

6. Tailwind design tokens (extend in config):
   ```js
   colors: {
     mercari: { bg: '#e0e7ff', text: '#3730a3' },
     amazon:  { bg: '#fef3c7', text: '#92400e' },
     rakuten: { bg: '#fee2e2', text: '#991b1b' },
     accent:  { DEFAULT: '#0f3460', light: '#1a4a8a', bg: '#eef2ff' },
   }
   ```

**Deliverables**
- Working `web/frontend/` with Vite dev server, build, and typecheck passing.
- Folder structure and stub files.
- `vite.config.ts` with proxy to Worker.

**Verification**
- [ ] `npm run dev` starts Vite dev server at `http://localhost:5173`
- [ ] `npm run build` produces optimized build in `dist/`
- [ ] `npm run typecheck` passes

---

### 4.2 Team 2: API Client Layer + Auth

**Scope**

1. **Auth context** (`src/hooks/useAuth.tsx`):
   - `AuthProvider` with `token`, `login(password)`, `logout()`, `isAuthenticated`
   - Token stored in `sessionStorage` (key: `hb_ticketing_token`, matching Worker expectations)
   - `login()` calls `POST /api/session` with password, stores returned token
   - Auto-check token validity on mount via `GET /api/health`
   - Expose `useAuth()` hook

2. **API client** (`src/api/client.ts`):
   ```ts
   async function api<T>(path: string, opts?: RequestInit): Promise<T>
   ```
   - Reads token from `sessionStorage`, adds `Authorization: Bearer <token>` header
   - Adds `Content-Type: application/json` by default
   - On 401 response: clear token, trigger auth logout
   - On network error: surface error to caller
   - Returns parsed JSON with correct typing

3. **Ticket API functions** (`src/api/tickets.ts`):
   ```ts
   listTickets(filters: TicketFilters): Promise<{ tickets: Ticket[], total: number }>
   getTicket(id: string): Promise<{ ticket: TicketDetail, events: Event[] }>
   createTicket(input: CreateTicketInput): Promise<{ ticket: Ticket }>
   updateTicket(id: string, input: Partial<Ticket>): Promise<{ ticket: Ticket }>
   linkProduct(ticketId: string, input: LinkProductInput): Promise<{ product: Product }>
   unlinkProduct(ticketId: string, productId: string): Promise<void>
   searchProducts(q: string, platform?: string): Promise<{ products: Product[] }>
   addMessage(ticketId: string, input: AddMessageInput): Promise<{ message: Message }>
   addNote(ticketId: string, input: AddNoteInput): Promise<{ note: Note }>
   getIssueTypes(): Promise<{ issue_types: IssueType[] }>
   ```

4. **Copywriting API functions** (`src/api/copywriting.ts`):
   ```ts
   copywrite(ticketId: string, resolutionGuide?: string): Promise<{ reply: string, model: string }>
   sendReply(ticketId: string, message: string, intent: 'terminal' | 'holding', lastSeenAt?: string): Promise<SendResponse>
   saveDraft(ticketId: string, body: string, resolutionGuide?: string): Promise<void>
   getDraft(ticketId: string): Promise<{ draft: Draft | null }>
   getThread(ticketId: string): Promise<{ messages: ThreadMessage[], latest_buyer_message_at: string | null, fetch_error?: string }>
   ```

5. **React Query hooks** (`src/hooks/useTickets.ts`):
   - `useTicketList(filters)` -- `useQuery` for ticket list
   - `useTicketDetail(id)` -- `useQuery` for ticket detail + events
   - `useCreateTicket()` -- `useMutation`
   - `useUpdateTicket()` -- `useMutation` with optimistic invalidation of list query
   - `useLinkProduct()` / `useUnlinkProduct()` -- `useMutation`
   - `useTicketThread(id)` -- `useQuery` for merged thread messages

6. **API types** (`src/api/types.ts`):
   - Mirror existing Supabase domain types: `Ticket`, `TicketDetail`, `Event`, `Product`, `Message`, `Note`, `IssueType`, `Draft`, `SendResponse`, `ThreadMessage`, `TicketFilters`, `CreateTicketInput`, `AddMessageInput`, `AddNoteInput`, `LinkProductInput`

**Deliverables**
- Auth context with login/logout/session management.
- Typed API client with automatic auth header injection.
- Complete set of React Query hooks for all ticket operations.

**Verification**
- [ ] Login flow works: enter password -- token stored -- API calls include Bearer header
- [ ] Logout clears token from sessionStorage
- [ ] 401 response triggers redirect to login
- [ ] Each API function returns correctly typed data (manual test against local Worker)
- [ ] `npm run typecheck` passes

---

### 4.3 Team 3: UI Kit -- Shared Components

**Scope**

Build shared, reusable components with consistent styling matching the existing design system:

1. **Badges**: `PlatformBadge`, `StatusBadge`, `PriorityBadge`
   - Props: `platform` (mercari/amazon/rakuten/other), `status` (open/in_progress/resolved/closed), `priority` (urgent/high/normal/low)
   - Colors per design tokens (mercari=indigo, amazon=amber, rakuten=red)

2. **Buttons**: `Button`
   - Variants: `primary` (solid accent), `secondary` (outline), `danger` (red), `ghost` (no border), `outline`
   - Sizes: `sm`, `md`, `lg`
   - States: loading (spinner), disabled

3. **Form controls**: `Input`, `Select`, `Textarea`, `CheckboxGroup`
   - Label + error message support
   - Consistent border, focus ring, padding

4. **Modal**: `Modal`
   - Overlay backdrop + centered content box
   - Close on overlay click and Escape key
   - Used by: send confirmation, issue type editor, product search

5. **Toast / Notification**: `Toast`, `useToast()` hook
   - Types: `info` (blue), `success` (green), `error` (red)
   - Auto-dismiss after 2.5 seconds
   - Fixed position bottom-right
   - Stack multiple toasts

6. **Layout primitives**:
   - `PageHeader` -- top bar with app title + logout button
   - `Pane` -- scrollable panel container with optional title
   - `Tabs` -- `Tabs` container + `TabButton` items; controlled `activeTab` prop
   - `EmptyState` -- centered muted text with optional action button

7. **Loading states**: `Spinner` (rotating SVG), `Skeleton` (animated placeholder blocks for list items, detail fields)

8. **IssueTypeBadge** -- colored chip with display name, optional remove button

**Deliverables**
- Complete set of reusable UI components in `src/components/ui/`.
- Components accept standard props (`className`, `children`, event handlers).
- Storybook or manual test page demonstrating all components.

**Verification**
- [ ] Each component renders without errors
- [ ] Platform/status/priority colors match existing SPA design tokens
- [ ] Loading states animate
- [ ] Modal opens/closes with overlay click and Escape
- [ ] Toast appears and auto-dismisses
- [ ] Components are responsive at 320px -- 1440px widths

---

### 4.4 Team 4: List Pane (Left Pane)

**Scope**

1. **Components**:
   - `ListPane` -- container with filter bar + ticket list + ticket count
   - `FilterBar` -- search input (debounced 250ms), platform select, status select, priority select, sort select, "New Ticket" button
   - `TicketList` -- scrollable list rendering `TicketListItem` components
   - `TicketListItem` -- dense row: ticket number, platform badge, status tag, priority dot, subject (2-line clamp), customer name, order ID, latest message date, selected highlight
   - `TicketCount` -- "N tickets" counter

2. **State and behavior**:
   - Filters managed via `useState` in `ListPane`, mapped to URL search params for shareability
   - Debounced search input (250ms delay before API call)
   - `selectedTicketId` prop controls which item is highlighted
   - Click on item calls `onTicketSelect(id)` which navigates to `/tickets/:id`
   - Keyboard: Enter on focused item navigates
   - Empty state: "No tickets found" with button to create ticket
   - Loading state: skeleton placeholder rows (5 items)
   - Error state: error message with retry button

3. **Filter contract** (maps to existing API query params):
   ```ts
   interface TicketFilters {
     platform?: string;
     status?: string;
     priority?: string;
     q?: string;
     sort?: string;
     page?: number;
     limit?: number;
   }
   ```

4. **Props interface**:
   ```ts
   interface ListPaneProps {
     selectedTicketId: string | null;
     onTicketSelect: (id: string) => void;
   }
   ```

**Deliverables**
- Fully functional list pane with filters, search, paginated list, and selection.
- Debounced search.
- Loading, empty, and error states.

**Verification**
- [ ] Ticket list renders with real data from API
- [ ] Selecting a platform filter triggers list refetch
- [ ] Search input debounces before API call
- [ ] Clicking a ticket calls `onTicketSelect(id)`
- [ ] Selected item is visually highlighted
- [ ] Empty state shows when no tickets match filters
- [ ] Loading skeleton shows during fetch
- [ ] On mobile: list is full-width

---

### 4.5 Team 5: Detail Pane (Right Pane)

**Scope**

1. **Components**:
   - `DetailPane` -- container with empty/loading/detail states
   - `DetailToolbar` -- ticket number, platform badge, order ID, subject (truncated), mobile back button
   - `DetailGrid` -- editable fields: status (select), priority (select), subject (input), issue types (badges + Edit button opens `IssueTypeEditor` modal), `started_at` (datetime-local), customer (input), external URL (input)
   - `DetailTabs` -- tabs container: Events, Messages, Notes, Products, Description
   - `EventsTab` -- reverse-chronological event list: event type label, actor (human/system), timestamp
   - `MessagesTab` -- merged thread messages (platform badge vs manual badge), author, body, timestamp
   - `NotesTab` -- internal notes list with "Add Note" button opening inline textarea or prompt
   - `ProductsTab` -- linked products with seller info, price, fulfillment status, Remove button, "Link Product" search modal
   - `DescriptionTab` -- editable description textarea + issue type editor
   - `IssueTypeEditor` -- modal with checkboxes for each issue type (fetched from API), save/cancel buttons

2. **State and behavior**:
   - `useTicketDetail(id)` fetches detail + events data on mount or when `id` changes
   - Loading state: `Spinner` or `Skeleton` in the detail pane
   - Error state: error message with retry button
   - Empty state (no ticket selected): "Select a ticket to view details" centered text
   - Field edits: inline control change triggers `useUpdateTicket()` mutation
   - On mutation success: invalidate `["tickets"]` query key so list pane refreshes
   - Product search: modal with text input -- results -- click to link
   - Add note: inline textarea with Save/Cancel -- calls `addNote()` mutation
   - Issue type editor: modal with checkboxes -- Save calls `updateTicket()` with selected issue types

3. **Props interface**:
   ```ts
   interface DetailPaneProps {
     ticketId: string | null;
     onBack?: () => void;  // mobile only
   }
   ```

4. **Field update sync**:
   - After `useUpdateTicket` mutation succeeds, call `queryClient.invalidateQueries({ queryKey: ["tickets"] })` to refresh list pane data
   - Optimistic update: immediately update the cached list item to reflect new values

**Deliverables**
- Complete detail pane with all 5 tabs.
- Editable fields with mutation sync back to list.
- Product search and linking modal.
- Issue type editor modal.

**Verification**
- [ ] Selecting a ticket loads detail in the right pane
- [ ] All 5 tabs render correct data (Events, Messages, Notes, Products, Description)
- [ ] Changing status/priority sends PATCH and updates both detail and list
- [ ] Product search finds products; clicking links them to the ticket
- [ ] Add note appears in notes tab immediately
- [ ] Issue type editor shows checkboxes and saves selections
- [ ] Empty state shown when no ticket selected
- [ ] Loading state during fetch

---

### 4.6 Team 6: Response Composer

**Scope**

1. **Components**:
   - `Composer` -- full composer section anchored at the bottom of the detail pane; only visible for Mercari tickets
   - `ComposerHeader` -- "Response Composer" title + thread status badge showing unread message count
   - `ResolutionGuideInput` -- textarea for AI copywriting context (placeholder: "Brief resolution guide...")
   - `CopywriteButton` -- "Generate AI Reply" button with loading spinner; calls `useCopywrite()` mutation
   - `DraftEditor` -- main textarea (placeholder: "Type your reply..."); character count display (current / 500), color transitions at 400 (amber warning) and 500+ (red, overflow)
   - `ComposerActions` -- "Final reply" checkbox (controls `reply_intent`), "Save Draft" button, "Send" button
   - `SendConfirmModal` -- message preview + reply intent radio (terminal / holding) + confirm/cancel buttons

2. **State and behavior**:
   - `useCopywrite()` mutation: sends resolution guide, populates draft editor with AI response
   - `useSendReply()` mutation: opens confirm modal -- on confirm, executes send -- clears draft -- refreshes messages tab
   - Draft save/load via `useSaveDraft()` / `useLoadDraft()` mutations (manual save, not auto-save)
   - Character count: real-time update as user types; color classes change at thresholds
   - Thread status: on ticket select, load thread from API, show message count in header badge
   - Keyboard shortcut: `Ctrl+Enter` opens send confirmation modal
   - `reply_intent`: "terminal" clears the ticket's Needs Reply flag; "holding" preserves it

3. **Visibility**:
   - Only visible when `ticket.platform === "mercari"`
   - Hidden entirely for Amazon, Rakuten, and Other platform tickets (match current SPA behavior)

4. **Props interface**:
   ```ts
   interface ComposerProps {
     ticketId: string;
     ticketPlatform: string;
   }
   ```

**Deliverables**
- Fully functional response composer with AI copywriting, draft save/load, and send.
- Thread display and status badge.
- Character count with visual warnings.
- Send confirmation modal.

**Verification**
- [ ] Composer appears only for Mercari tickets
- [ ] Entering resolution guide and clicking Copywrite populates the draft editor
- [ ] Character count updates in real-time; color changes at 400 and 500
- [ ] Save draft persists across ticket switches
- [ ] Send -- confirm modal appears -- message sent -- thread refreshes
- [ ] `Ctrl+Enter` opens send modal
- [ ] Reply intent radio works: terminal clears flag, holding preserves it

---

### 4.7 Team 7: Integration -- Workspace Shell and Routing

**Scope**

1. **`WorkspacePage.tsx`** -- main two-pane layout:
   ```tsx
   function WorkspacePage() {
     const { id } = useParams<{ id: string }>();
     const navigate = useNavigate();

     return (
       <div className="flex flex-col h-screen">
         <Header />
         <div className="flex-1 grid grid-cols-[clamp(320px,32vw,440px)_minmax(0,1fr)]
                         max-md:grid-cols-1 min-h-0">
           <ListPane
             selectedTicketId={id ?? null}
             onTicketSelect={(tid) => navigate(`/tickets/${tid}`)}
           />
           <DetailPane
             ticketId={id ?? null}
             onBack={() => navigate('/')}
           />
         </div>
       </div>
     );
   }
   ```

2. **Responsive behavior**:
   - Desktop (>=900px): both panes visible, CSS Grid layout
   - Mobile (<900px): single pane via `max-md:grid-cols-1`
   - Mobile logic: when `id` param is present, show detail pane; when absent, show list pane
   - Back button: visible only on mobile (in `DetailToolbar`), navigates to `/`
   - Each pane owns its own scroll container (`overflow-y-auto`)

3. **Field sync between panes**:
   - Detail pane mutations invalidate `["tickets"]` query key -- list pane refetches
   - Optimistic cache updates for immediate list item refresh without waiting for refetch

4. **`CreateTicketPage.tsx`** -- full-screen create form:
   - Platform selector (Mercari default)
   - Account auto-map based on platform
   - Issue type checkboxes (loaded from API)
   - External order ID, external URL, customer name, contact method, subject, description
   - Submit calls `useCreateTicket()` mutation -- navigates to `/tickets/:newId` on success
   - Cancel button navigates back to `/`

5. **`LoginPage.tsx`** -- password gate:
   - Centered card layout with password input + "Login" button
   - Error message display for invalid password (401 response)
   - Enter key submits the form
   - On success: store token in context, redirect to `/`
   - If already authenticated on mount: automatically redirect to `/`

**Deliverables**
- `WorkspacePage.tsx` with two-pane layout and responsive breakpoints.
- `CreateTicketPage.tsx` with full ticket creation form.
- `LoginPage.tsx` with password gate.
- Complete React Router wiring in `App.tsx`.

**Verification**
- [ ] Desktop (>=900px): list pane left, detail pane right
- [ ] Mobile (<900px): single pane, back button navigates between list and detail
- [ ] Create ticket: fill form -- submit -- redirect to new ticket detail
- [ ] Login gate: incorrect password shows error; correct password redirects to workspace
- [ ] Resize from desktop to mobile: layout transitions correctly
- [ ] Selecting a ticket updates URL to `/tickets/:id`

---

### 4.8 Team 8: Worker -- Static Asset Serving

**Scope**

1. **Configure Wrangler for Workers Assets** in `web/worker/wrangler.toml` (staging) and `wrangler.production.toml`:
   ```toml
   [assets]
   directory = "../frontend/dist"
   ```

2. **Update `web/worker/index.ts`**:
   - Replace all `serveTicketingIndex()` calls with SPA fallback logic
   - All non-API, non-asset routes: serve `index.html` from the build output
   - All `/api/*` routes: unchanged (keep all existing handlers)
   - All `/assets/*` routes: handled automatically by Workers Assets with correct `Content-Type` and caching headers

3. **Configure Vite build output**:
   - `base: '/'` (absolute paths)
   - Build output directory: `web/frontend/dist/` (already the Vite default)

4. **Remove legacy inline SPA code** from `web/worker/src/handlers/ticketing.ts`:
   - Remove the `TICKETING_INDEX_HTML` template string (~960 lines)
   - Remove `serveTicketingIndex()` function
   - Keep all API handler functions -- they are now consumed by the React app

5. **Feature flag** (optional safety net):
   - If `ENABLE_REACT_FRONTEND` is not set or `"false"`, fall back to old inline SPA
   - This allows rolling back instantly without a redeploy of the Worker

**Deliverables**
- Updated `wrangler.toml` with `[assets]` configuration.
- Updated `web/worker/index.ts` with SPA fallback routing.
- Legacy inline SPA code removed from `ticketing.ts`.
- Feature flag for safe rollout.

**Verification**
- [ ] `npm run build` in `web/frontend/` produces `web/frontend/dist/`
- [ ] `wrangler dev` serves the React app at `/`
- [ ] API routes still return JSON: `GET /api/ticketing/tickets`
- [ ] SPA fallback: any non-API path serves `index.html`
- [ ] Static assets served with correct content types
- [ ] Legacy SPA still accessible when feature flag is off

---

### 4.9 Team 9: Tests and Verification

**Scope**

1. **Update Worker routing tests** (`web/worker/tests/worker-routing.test.ts`):
   - Update assertions: SPA HTML is now React build output (contains `<div id="root">`) instead of the old inline template string
   - Test: `GET /` returns HTML
   - Test: `GET /tickets/123` returns HTML (SPA fallback)
   - Test: `GET /api/ticketing/tickets` returns JSON (API unchanged)
   - Test: Static assets served with correct `Content-Type` (if added)

2. **Run all existing Worker tests**:
   ```bash
   cd web/worker && npm test
   ```

3. **TypeScript check both projects**:
   ```bash
   cd web/frontend && npx tsc --noEmit
   cd web/worker && npx tsc --noEmit
   ```

4. **Manual smoke test** (10 acceptance criteria from TRD Section 10):
   - [ ] Desktop layout shows two panes
   - [ ] Selecting a ticket updates right pane without hiding the list
   - [ ] Selected ticket is visibly highlighted in the left pane
   - [ ] All ticket field edits, tabs, product links, notes, messages, and composer work
   - [ ] Updating fields updates both detail and list state
   - [ ] Filters reload the list without destroying the open detail
   - [ ] Empty detail state when no ticket selected
   - [ ] Mobile width uses single-pane navigation with back button
   - [ ] No API or database schema changes required
   - [ ] Existing Worker tests pass

**Deliverables**
- Updated Worker routing tests.
- Manual smoke test results.
- Verified `tsc --noEmit` passes in both projects.

**Verification**
- [ ] All existing Worker tests pass
- [ ] New routing tests pass
- [ ] `tsc --noEmit` passes in `web/frontend/` and `web/worker/`

---

## 5. Execution Order and Timeline

### 5.1 Phase Breakdown

```text
Phase 1 -- Foundation (Day 1, ~4 hours)
  Team Foundation   [2 hrs]  Vite + React + TS + Tailwind setup
  Team API Client   [2 hrs]  (parallel with UI Kit, after Foundation)
  Team UI Kit       [2 hrs]  (parallel with API Client)

Phase 2 -- Features (Day 1-2, ~8 hours)
  Team List Pane    [3 hrs]  (parallel with Detail + Composer)
  Team Detail Pane  [3 hrs]  (parallel with List + Composer)
  Team Composer     [3 hrs]  (parallel with List + Detail)

Phase 3 -- Integration and Deployment (Day 2-3, ~4 hours)
  Team Integration  [2 hrs]  Workspace shell + routing + responsive
  Team Worker       [1.5 hrs] Static serving + legacy removal
  Team Test         [1 hr]   Test updates + smoke verification
```

### 5.2 Dependency Constraints

| Step | Can Start When | Blocks |
|------|----------------|--------|
| Foundation | Start of execution | API Client, UI Kit |
| API Client | Foundation done | List Pane, Detail Pane, Composer |
| UI Kit | Foundation done | List Pane, Detail Pane, Composer |
| List Pane | API Client + UI Kit done | Integration |
| Detail Pane | API Client + UI Kit done | Integration |
| Composer | API Client + UI Kit done | Integration |
| Integration | List + Detail + Composer done | Worker |
| Worker | Integration done | Test |
| Test | All teams done | -- |

### 5.3 Parallelization Opportunities

- **API Client** and **UI Kit** can work in parallel after Foundation is complete.
- **List Pane**, **Detail Pane**, and **Composer** can all work in parallel after API Client + UI Kit are done.
- **Test** can start writing routing test updates against interfaces while features are being built.
- If Foundation is expedited, the entire build can complete in **2-3 days** with two or more agents working in parallel.

---

## 6. Risk Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| React + Vite adds complexity vs. vanilla JS | Medium | Medium | The existing SPA already has 1,200+ lines -- React makes it more maintainable. Vite setup is well-documented and the team knows the stack. |
| Worker static asset serving configuration fails | Medium | Low | Use Wrangler `[assets]` config (built-in Workers Assets support). Fallback: import built HTML as a string, same as the current SPA approach. |
| API types drift between frontend and backend | Medium | Medium | Copied types with explicit review during build. The existing `types.ts` in the Worker defines all types -- mirror them in frontend and cross-reference. |
| Tailwind learning curve | Low | Low | UI Kit team builds reusable components; feature teams compose them. Minimal direct Tailwind in feature code. |
| React Query cache invalidation complexity | Low | Low | Simple pattern: `queryClient.invalidateQueries({ queryKey: ["tickets"] })` on mutation success. Well-documented TanStack Query pattern. |
| Mobile two-pane behavior breaks | Medium | Low | CSS Grid with `max-md:grid-cols-1` + conditional rendering based on URL param. Test with Chrome DevTools responsive mode. |
| Composer draft lost during re-renders | Low | Low | Draft text lives in `useState` within the Composer component, not in global state. Survives tab switches and filter changes. |
| Merge conflicts with ongoing Worker development | Low | Medium | React frontend is in `web/frontend/` -- separate directory from Worker code. Worker changes are minimal (remove inline SPA, add static serving config). |
| Legacy SPA needs to be kept as fallback | Low | Medium | Feature flag `ENABLE_REACT_FRONTEND`: when off, Worker serves old inline SPA. Zero-risk rollout. |

---

## 7. Open Decisions

These decisions are made in the approved plan but noted here for clarity and future reference:

| # | Decision | Chosen Approach | Rationale |
|---|----------|----------------|-----------|
| 1 | Styling: Tailwind CSS vs. CSS Modules? | **Tailwind CSS** | Faster for this scope, matches ecosystem, no CSS file bloat |
| 2 | State management: React Context vs. Zustand? | **React Context + React Query** | Query handles server state; Context only for auth. Zustand not needed for this size. |
| 3 | Worker static assets: `[assets]` config vs. manual import? | **`[assets]` config** | Simplest approach, built into Wrangler, handles content types and caching |
| 4 | Share types between frontend and Worker? | **Copied types (manual mirror)** | Shared package overhead not justified for MVP; add later if interface proves stable |
| 5 | Component testing: Vitest + RTL vs. manual only? | **Manual smoke test for MVP** | Add component tests post-launch; integration test coverage via Worker routing tests |
| 6 | Deploy frontend via Worker or Cloudflare Pages? | **Via Worker** | Single deploy target, existing domain, no CORS issues, simpler infrastructure |
| 7 | Keep old SPA as fallback during rollout? | **Yes** | Feature flag `ENABLE_REACT_FRONTEND` allows instant rollback without redeploy |
| 8 | Database schema changes? | **None required** | All existing tables and columns unchanged; frontend-only migration |

---

## 8. Definition of Done

### Build Verification

- [ ] React + Vite + TypeScript project builds and type-checks successfully in `web/frontend/`
- [ ] Two-pane workspace renders on desktop (list left, detail right)
- [ ] Mobile single-pane fallback works at <900px width
- [ ] All existing SPA functionality replicated:
  - [ ] Login / logout
  - [ ] Ticket list with filters and search
  - [ ] Ticket detail with all 5 tabs (Events, Messages, Notes, Products, Description)
  - [ ] Field edits (status, priority, subject, customer, external URL, started_at)
  - [ ] Issue type selection with editor modal
  - [ ] Product search and linking
  - [ ] Notes (add, display)
  - [ ] Response composer: AI copywrite, draft save/load, send with confirmation
  - [ ] Create ticket form

### Data Integrity

- [ ] Field updates sync from detail pane back to list pane
- [ ] Filters reload the list without destroying the open detail pane or clearing unsent draft text
- [ ] Composer draft survives ticket selection changes

### API and Backend

- [ ] All 15+ API routes unchanged and responding correctly
- [ ] Worker serves React app for SPA routes (`/`, `/tickets/*`, `/tickets/new`)
- [ ] Legacy inline SPA code removed from `web/worker/src/handlers/ticketing.ts`

### Quality

- [ ] `npm run typecheck` passes in both `web/worker/` and `web/frontend/`
- [ ] `npm test` passes for Worker tests
- [ ] Worker routing tests updated for React SPA output
- [ ] Manual smoke test of 10 acceptance criteria from TRD Section 10
- [ ] Desktop and mobile layouts tested in Chrome DevTools responsive mode

### Rollout Safety

- [ ] Feature flag `ENABLE_REACT_FRONTEND` exists (default off for staging, on for production after validation)
- [ ] Rollback plan documented: toggle flag off, Worker reverts to inline SPA, no redeploy needed
