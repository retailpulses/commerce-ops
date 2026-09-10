# Portal Mobile-Responsive — Functional & Integration Test Plan

## Scope

MVP changes: rename to "Order Mgmt Portal" + CSS-only responsive at ≤768px and ≤480px. No JS architecture changes, no card layout, no filter drawer.

## 1. Unit Tests

Run with `cd portal && npm test && npm run build`.

| # | Test | Pass Condition |
|---|------|---------------|
| UT1 | React tests | Portal component and behavior tests pass |
| UT2 | Production build | TypeScript and Vite build complete without errors |
| UT3 | Worker retirement | Worker `/portal` returns a permanent redirect to the React portal |

## 2. Functional Tests (Manual — DevTools Device Emulation)

### 2.1 Rename

| # | Step | Expected |
|---|------|----------|
| F1 | Open portal, observe login screen | Heading reads "📦 Order Mgmt Portal" |
| F2 | Login with valid token | Top bar heading reads "📦 Order Mgmt" |
| F3 | Check browser tab title | Title is "Order Mgmt Portal" |

### 2.2 Responsive — ≤768px (iPad / tablet)

Emulate a 768px-wide viewport (iPad).

| # | Step | Expected |
|---|------|----------|
| R1 | Open portal | Top bar wraps: title on first line, summary + buttons below |
| R2 | Observe filter bar | Filters stack vertically, each is full width, selects/inputs have 44px min height |
| R3 | Observe tabs | Orders / Fee Orders tabs are equal-width, full row, 44px min height |
| R4 | Observe table | Table is horizontally scrollable (no column clipping), font reduced to 0.75rem |
| R5 | Observe checkboxes | Row checkboxes are 20×20px |
| R6 | Open order detail drawer | Drawer is full viewport width (100vw) |
| R7 | Check drawer touch targets | Close button, action buttons (Approve/Hold), memo button all have 44px min height |
| R8 | Observe login card | Login card has reduced padding (24px 16px) |
| R9 | Observe reply composer | Template select dropdown stacks above the send button area; select is full width |
| R10 | Observe pagination | Pagination buttons have 44px min height/width |

### 2.3 Responsive — ≤480px (phone)

Emulate a 375-414px wide viewport (iPhone 14 / Pixel 7).

| # | Step | Expected |
|---|------|----------|
| P1 | Open template manager modal | Modal is full-screen (100vw × 100vh), no border radius |
| P2 | Template manager buttons | Edit/Delete/Create buttons have 44px min height |
| P3 | Template manager inputs | Inputs/textarea have 44px min height |

### 2.4 Drawer Full-Screen Behavior

| # | Step | Expected |
|---|------|----------|
| D1 | On ≤768px, tap an order row | Drawer opens and fills entire viewport width |
| D2 | Tap drawer close or overlay | Drawer closes |
| D3 | Drawer action buttons | Approve/Hold buttons are equal width (`flex:1`) with gap |

### 2.5 Fee Orders

| # | Step | Expected |
|---|------|----------|
| FO1 | Switch to Fee Orders tab | Table head renders with compact font at 0.65rem |
| FO2 | Observe horizontal scroll | Fee orders table scrolls horizontally on ≤768px |

## 3. Integration Tests (Live API + Portal)

Requires the React portal deployment at `https://order.homesbliss.net`. Log in and interact with real orders. The retired Worker `/portal` URL must redirect here.

| # | Step | Expected |
|---|------|----------|
| I1 | Load order list | Table renders; at ≤768px, table is scrollable, no overflow cutoff |
| I2 | Open order detail | Drawer is 100vw wide on ≤768px; all fields render correctly |
| I3 | Approve an order | Approve button responds; drawer remains usable at mobile width |
| I4 | Add a memo | Memo textarea is full width; feedback message visible |
| I5 | Load messages | Messages section loads; reply composer has stacked layout on mobile |
| I6 | Send a reply | Send button is 44px min height; feedback displays |
| I7 | Edit delivery date | Inline edit input is 130px wide on mobile (fits within drawer) |
| I8 | Bulk selection | Checkboxes are 20×20px on mobile; bulk bar renders correctly |
| I9 | Template CRUD | Create/edit/delete from full-screen modal (480px) |

## 4. Regression Tests

| # | Test | Expected |
|---|------|----------|
| REG1 | ≥769px viewport | Everything renders as before: inline filters, non-full-width drawer, centered template modal |
| REG2 | Resize from desktop to mobile and back | No JS errors; drawer/modal open states survive resize gracefully |
| REG3 | All existing unit tests | 4/4 pass |

## 5. Running Tests

```bash
# Unit tests
node --test src/lib/__tests__/portal-ui.test.mjs

# Manual: use Chrome DevTools or Safari Responsive Design Mode
# Set viewport to 768px, 480px, and 1024px to verify each layout state
```
