# UI audit · B11 (responsive + a11y)

> **Status after the merge step (B12, done by hand):** the items in §3 were followed up as below. The table in §1–§2 is the original B11 audit and is kept unchanged.
>
> | # | Status | Where |
> |---|---|---|
> | P1 `nav-bell` label-content-name-mismatch | fixed | `src/core/html.js` (`sr-only` text instead of `aria-label`) |
> | P2 `holiday-delete-btn` accessible name | fixed | `reports.js` (`aria-label="ลบ วันหยุด <date>"`) |
> | P3 TC-NFR-02 never logged in | fixed | `e2e/tests-b.spec.ts` TC-NFR-02 logs in a user per route and asserts the page was not redirected to `/login` |
> | P4 Tab count varies in the keyboard flow | open (no failure seen) | TC-NFR-02 `tabTo` allows up to 40 Tab presses; it passed in every full run recorded in `test-report/results/matrix.log` |
> | P5 duplicated name/role text | by design | follows TEST-DATA |
>
> Evidence: TC-NFR-01 and TC-NFR-02 pass in the final 51/51 runs (axe serious/critical = 0 on the 13 pages).

Scope: NFR-01, NFR-02, NFR-03, NFR-11 and CONTRACT §2 · Checked on 2026-11-16 against the server `TEST_MODE=1` (reset before every page) · Chromium 1254 (Playwright 1.66) + axe-core 4.14.0 with tags `wcag2a wcag2aa wcag21a wcag21aa`

B11 output files:
- `public/ui.css`: CSS-only layer. `src/core/html.js` loads it automatically after `app.css` when the file exists. It does not touch the DOM, testids or text.
- `ui-audit.md`: this file.

The audit script is outside the repo (`/tmp/b11/audit.js` and `kbd.js`). It is not part of the deliverable.

## 1. Summary

| Criterion | Result |
|---|---|
| No horizontal scroll at 375 / 768 / 1280 (`documentElement.scrollWidth ≤ innerWidth`) | ✅ **passes on all 22 pages/states × 3 widths** (no element runs past the right edge of the screen, and since ui.css there is no inner scroll in any table at 375 either) |
| Every `input/select/textarea` has a label (`labels` / `aria-label` / `aria-labelledby`) | ✅ 0 inputs without a label (all inputs counted, including the payment step after creating a QR) |
| data-testid as in CONTRACT §2 (statically checkable in the seed state) | ✅ none missing · `audit-edit-btn` / `audit-delete-btn` are not rendered |
| Status is not shown by colour alone (`case-status` `sla-level` `row-status` `row-sla-level` `payment-status` `verify-result`) | ✅ every element has non-empty Thai text plus `data-status`/`data-level` · ui.css also adds a shape marker (⚠ ⏰ ⏸ ✓ ✕) and a border/background |
| Keyboard only (TC-NFR-02 flow: login → OTP → SV-01 → upload → "ไปชำระเงิน") | ✅ reaches `create-qr-btn`, and every step has a visible focus ring (outline) |
| axe serious/critical = 0 | ❌ **6 pages still fail with `label-content-name-mismatch` (serious)**. This must be fixed in HTML, not CSS (see §3, P1). |

## 2. Results by page (13 required pages + extra states)

`W` = scrollWidth at 375/768/1280 · `in` = number of inputs (all have labels) · `st` = number of status elements (all have text)

| Page (user) | HTTP | W | in | st | axe serious/critical | Note |
|---|---|---|---|---|---|---|
| `/login` (-) | 200 | 375/768/1280 | 4 | – | 0 | |
| `/register` (มานะ) | 200 | 375/768/1280 | 4 | – | 0 | |
| `/citizen` (สมชาย) | 200 | 375/768/1280 | 0 | 22 | 0 | ≤900px: draft rows and case rows become cards |
| `/citizen/new/SV-01` | 200 | 375/768/1280 | 3 | – | 0 | step 3 (QR) at 375 = 375 ✅ |
| `/citizen/new/SV-03` (extra) | 200 | 375/768/1280 | 5 | – | 0 | |
| `/citizen/new/SV-02?draft=DR-0002` (extra) | 200 | 375/768/1280 | 4 | – | 0 | |
| `/citizen/cases/EG-2569-000017` NEED_FIX | 200 | 375/768/1280 | 2 | 2 | 0 | `fix-upload-input` has a label |
| `/citizen/cases/…000005` COMPLETED+doc (extra) | 200 | 375/768/1280 | 0 | 2 | 0 | `doc-qr` does not overflow |
| `/citizen/cases/…000030` SUBMITTED · `…000011` SV-03 (extra) | 200 | 375/768/1280 | 0 | 2 | 0 | |
| `/officer/queue` (off.reg1) | 200 | 375/768/1280 | 1 | 34 | **1** nav-bell | before ui.css, the due/level/owner/claim columns were in an inner scroll area at 375 |
| `/officer/cases/EG-2569-000020` (off.reg1) | 200 | 375/768/1280 | 3 | 2 | **1** nav-bell | |
| `/officer/cases/…000011` (head1, extra) | 200 | 375/768/1280 | 2 | 2 | **1** nav-bell | |
| `/head/approvals` (head1) | 200 | 375/768/1280 | 0 | 2 | **1** nav-bell | |
| `/dashboard` (exec1) | 200 | 375/768/1280 | 2 | – | 0 | |
| `/audit` (audit1) | 200 | 375/768/1280 | 4 | – | 0 | before ui.css, 375 had `scrollable-region-focusable` (serious): the table scrolled sideways with no focusable element. Now fixed with cards. |
| `/admin/services` (admin1) | 200 | 375/768/1280 | 7 | – | 0 | before ui.css, the `svc-save-*` buttons were pushed off the right edge at 375. Now fixed. |
| `/admin/holidays` (extra) | 200 | 375/768/1280 | 2 | – | **4** delete buttons | |
| `/admin/users` (extra) | 200 | 375/768/1280 | 14 | – | 0 | |
| `/notifications` (off.reg1) | 200 | 375/768/1280 | 0 | – | **1** nav-bell | |
| `/verify/K7M2Q9XA` · `/verify/ZZZZZZZZ` (404) | 200/404 | 375/768/1280 | 0 | – | 0 | |

Every page has 1 `h1`, `lang="th"`, a title and no duplicate ids. axe found no moderate/minor issues either (known issues = 0).

## 3. Issues the merge block (B12) or the file owner must fix (B11 cannot edit these)

| # | Severity | File (owner) | Problem | How to fix (tested by editing the DOM, then axe = 0) |
|---|---|---|---|---|
| P1 | **serious, fails TC-NFR-02** | `src/core/html.js:34` (B01) | `nav-bell` has `aria-label="แจ้งเตือน"`, but its visible text is `🔔 <count>`, so axe reports `label-content-name-mismatch` on every officer/head page (queue, officer case, approvals, notifications) | Remove `aria-label` and put `<span class="sr-only">แจ้งเตือน </span>` before 🔔 (the count stays in `bell-count`), or use `aria-label="แจ้งเตือน ${n}"`. The first option is better because it does not need updating when the count changes. |
| P2 | **serious** (/admin/holidays is not one of the 13 TC pages, but it is a real a11y issue) | `reports.js:629` and `:650` (B08) | `holiday-delete-btn` has `aria-label="ลบวันหยุด 2026-12-07"` with the text `ลบ`. Thai has no word spacing, so axe does not see the word "ลบ". | Change it to `aria-label="ลบ วันหยุด <date>"` (with a space after ลบ) in both the SSR code and the JS that redraws the list. |
| P3 | test fails or is not meaningful | `tests-b.spec.ts:437` (B10) | In TC-NFR-02, `routes` is `[path]` with no user, so it never logs in. Protected pages redirect to `/login`, so axe really only checks `/login`, `/verify` and `/register` (the last one through มานะ). | Add a user to each route, e.g. `['/citizen','citizen']`, `['/officer/queue','off.reg1']`, `['/head/approvals','head1']`, `['/dashboard','exec1']`, `['/audit','audit1']`, `['/admin/services','admin1']`, `['/notifications','off.reg1']`. Once fixed, P1 will make the test fail until B01/B12 fixes the header. |
| P4 | flaky risk | wizard page `/citizen/new/SV-01` (B04) | In the keyboard flow, the number of Tab presses to reach `upload-input-id-card` and `to-payment-btn` changes from run to run (2–16 and 11–27 out of the limit of 40 in `tabTo`), with or without ui.css. Focus seems to start at different points depending on when async rendering finishes after Enter on `to-upload-btn`. | After switching to step 2, call `focus()` on the step heading or the first input (`upload-input-id-card`), so focus has a fixed start and screen readers announce the new step. |
| P5 | minor (not an axe violation) | header (B01) | `user-name` and `user-role` for exec1/audit1/admin1 show the same text twice ("ผู้บริหาร ผู้บริหาร"), because TEST-DATA sets the display name to the role name. This follows the CONTRACT and is not a bug, so it is recorded here only. | – |

## 4. What ui.css does (for reviewing side effects)

1. **Overflow protection**: `main{overflow-wrap:anywhere;min-width:0}`, media `max-width:100%`, `input[type=file]`/`textarea` full width, `fieldset{min-width:0}`.
2. **Narrow header** (≤480px): brand on its own line, user name and logout button on the next line, links/buttons at least 44px tall.
3. **Focus visible**: amber outline 3px + white ring (contrast passes on both light and dark backgrounds). The header uses a yellow outline.
4. **Status is not colour alone**: `.badge` does not wrap and is bold, with a marker in front via `::before` (`content:"⚠ " / ""` so it does not enter the accessible name). Overdue has a thicker border and NEED_FIX a dashed border. The marker **is not part of `innerText`/`textContent`**, so tests that check status text are not affected.
5. **Tables → cards (≤900px)**: only for tables that contain rows with a CONTRACT testid (`my-case-row` `my-draft-row` `queue-row` `approval-row` `audit-row` `service-row` `user-row`). The thead is hidden visually but kept for screen readers, and each cell gets a column-name label with `::before` (alt text `""`). Matching is by the row testid + `nth-child`, so **if a block changes its column order, the labels in ui.css must change too.** Workload and holiday tables are not changed (they have few columns).
6. **forced-colors**: badges/buttons get a border using system colours, and focus uses `Highlight` (TC-NFR-02 calls `emulateMedia({forcedColors:'active'})`).
7. `prefers-reduced-motion` and `@media print` (hides the menu and buttons).

## 5. How to check again

```bash
PORT=3941 TEST_MODE=1 DB_PATH=/tmp/b11/egov.db node server.js &
cd /tmp/b11 && npm i axe-core@4
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node audit.js   # 22 states × 3 widths + labels + testids + status + axe
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node kbd.js     # keyboard flow TC-NFR-02
```
