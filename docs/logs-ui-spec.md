# Live Logs UI — Full Inventory (User Portal) + Admin Proposal

Source of truth: `frontend/app/user/(portal)/logs/page.tsx` (1013 lines), `components/ui/Card.tsx`, `components/ui/Button.tsx`, `components/ui/Skeleton.tsx`, `lib/hooks/usePortal.ts`, `tailwind.config.ts`. No backend logic is touched by this doc — it's a UI-only inventory for Figma recreation.

---

## 1. Data source & polling

- Hook: `usePortalLogs(lines)` → `GET /api/portal/bot/{bot_name}/logs?telegram_id&lines=`
- SWR `refreshInterval: 3000` — polls every 3s (this **is** the "live" behavior; there is no websocket/stream).
- Fetches `FETCH_LINES = 10000` raw lines regardless of what's displayed, so stats/time-range buttons stay accurate.
- Bot status comes from separate `usePortalBot()` (5s poll) → `bot.running` drives the "Live" pill.
- Response shape consumed: `{ lines: string[], total_lines: number }`.
- All parsing/filtering/aggregation happens **client-side** in `useMemo`s — the backend just streams raw log-file lines.

---

## 2. Page structure

Single-column stack, `space-y-4 sm:space-y-5`, fade-in on mount. No breadcrumbs, no sidebar interaction on this page (sidebar is the persistent portal nav, not part of this page). Order top→bottom:

1. **Header row** — title + status + refresh
2. **Time-range selector** — horizontal scroll strip
3. **Stats bar** — 4 mini-stat cards
4. **Account filter chip strip** (conditional — only when one account is selected)
5. **Filters/Controls card** — search, view toggle, type filters, row-count select, account chips
6. **Log viewport** — scrollable panel (Timeline or By-Group)
7. **Footer caption** — counts summary, right-aligned

No modals/dialogs exist on this page at all — row expand is inline, not a popup.

### 2.1 Header
- `<h1>` "Live Logs" — `text-xl sm:text-2xl font-bold text-dark-100`
- Subtitle (conditional, only if an account filter is active): `Filtered: {accountFilter}` — `text-xs text-accent`
- Right side: "Live" pill (only if `bot.running`) — green pulsing dot (`animate-ping` ring + solid dot) + `text-xs text-success` label "Live"
- Refresh button: `Button variant="ghost" size="sm"` containing a `RotateCw` icon (h-3.5 w-3.5). Click → `mutate()` (force SWR refetch). No loading spinner state wired to this button specifically.

### 2.2 Time-range selector
- Horizontal scrollable strip (`overflow-x-auto`), icon `Clock` (h-3.5 w-3.5, text-dark-500) then 7 pill buttons.
- Values: `1 hour | 6 hours | 24 hours | 48 hours | 7 days | 30 days | All time` (keys: 1h/6h/24h/48h/7d/30d/all). Default selected: **24h**.
- Active state: `bg-accent/20 text-accent ring-1 ring-accent/30`. Inactive: `text-dark-400`, hover `text-dark-200 hover:bg-dark-800`.
- Drives every downstream computation (stats, list, group aggregation) via a `nowRef` anchored to the **newest log timestamp** (not client clock, to avoid clock-skew).

### 2.3 Stats bar
Grid `grid-cols-2 sm:grid-cols-4`, 4 `MiniStat` cards, each: rounded-lg, `bg-dark-900`, border `border-dark-700/50`, centered text.
- Icon (h-3.5 w-3.5) → colored number (`text-sm sm:text-base font-bold`) → label (`text-[9px] sm:text-[10px] text-dark-500`)
- **Total** — `Send` icon, `text-accent`, count of success+failure+flood in range
- **Sent** — `CheckCircle2`, `text-success`
- **Failed** — `XCircle`, `text-danger`
- **Flood** — `Timer`, `text-warning`

### 2.4 Account detail chip (conditional)
Appears only when a specific account is selected via the account filter row. `rounded-lg bg-accent/5 border border-accent/20 px-3 py-2.5`, slide-up animation. Contents (all inline, divided by `border-r` "|" separators):
- Account name (`text-xs font-medium text-accent`)
- `{sent} sent` (success color)
- `{failed} failed` (danger color)
- `{flood} flood` (warning color) — only if > 0
- `Last sent: {group}` — hidden on nothing, always shown if present
- `Last failed: {group}` — hidden below `sm` breakpoint
- Right-aligned "Clear" text button → resets account filter to "all"

---

## 3. Filters (all inside one `Card !p-3`)

### Row 0 — Search + View toggle
- **Search box**: full-width-ish (`flex-1 min-w-[180px]`), `Filter` icon prefix (h-3.5 w-3.5, text-dark-500), placeholder changes by view:
  - Timeline: "Search account, group, status, error…"
  - Groups: "Search a group by name…"
  - Clear (X) button appears only when text present, right-aligned `XCircle` icon.
  - Matches against: account, accountShort, groupName, groupId, error, message, waitSeconds, a derived status word ("sent"/"failed"/"skipped flood rate limit"), and raw line — all lowercased substring match. No debounce (recomputed via `useMemo`, cheap).
- **View toggle**: 2-segment pill group, border `border-dark-700`, overflow-hidden.
  - "Timeline" (`List` icon) / "By Group" (`Hash` icon)
  - Active segment: `bg-dark-700 text-dark-100`; inactive: `text-dark-400`

### Row 1 — Type filter buttons + row-count select
6 filter pills, each icon + label, active = `bg-dark-700 text-dark-100 ring-1 ring-dark-500`, inactive = `text-dark-400 hover:bg-dark-800`:
1. **All** — `List` icon, no count
2. **Posts (N)** — `Send` icon, `text-accent` — success+failure+flood combined
3. **Sent (N)** — `CheckCircle2`, `text-success`
4. **Failed (N)** — `XCircle`, `text-danger`
5. **Flood (N)** — `Timer`, `text-warning`
6. **System** — `Server`, `text-dark-400` — no count, covers system/cycle_start/cycle_end/connect

Right-aligned **row-count `<select>`**: 200 / 500 / 1,000 (default) / 2,000 / 5,000 / "All rows" (10000 = FETCH_LINES cap). This limits **rendered** rows only, not what's fetched or counted in stats.

### Row 2 — Account chips (conditional: only rendered if 2+ distinct accounts detected)
- Divider `border-t border-dark-800/50`, label "Account:" (text-dark-500)
- "All" pill + one pill per discovered account, labeled `Acc {index}` (1-based, index into sorted account list — **not** the raw session name) with `(sent/sent+failed)` in parentheses at 60% opacity.
- Active = `bg-accent/20 text-accent ring-1 ring-accent/30`, rounded-full (pill-shaped, distinct from the squarer type-filter buttons).

No explicit "Reset/Clear all filters" button exists — each filter clears independently (search X, account "Clear"/"All" chip). No date-range custom picker (only the fixed 7 range buttons); no sort-order control (always newest-first, hardcoded via `.reverse()`).

---

## 4. Log viewport

Container: fixed-height scrollable panel — `h-[60vh] sm:h-[calc(100vh-380px)] min-h-[300px]`, `bg-dark-950`, `border border-dark-700/50`, `rounded-xl`. Rows separated by `divide-y divide-dark-800/30`. Auto-scroll-to-top on new data is wired (`autoScroll` state + effect resets `scrollTop=0`) but there's **no UI control to toggle it** — it's always on by default and never exposed.

Two mutually exclusive render modes based on `view`:

### 4.A Timeline view (default)
Flat reverse-chronological list of `LogEntry` rows (newest first), capped to `displayCount`. Row types below.

### 4.B By-Group view
`GroupRow` list — one row per distinct group name seen in range, sorted by (failed+flood count desc, then name asc) so problem groups float to the top.

**GroupRow layout** (`px-3 py-2.5`):
- Header line: group name (`text-xs sm:text-sm font-medium text-dark-100 truncate`) + group ID below in mono `text-[9px] text-dark-600`, and right-aligned inline stats: `{sent} sent` (success), `{skipped} skipped` (warning, if >0), `{failed} failed` (danger, if >0), `{sent}/{total} acc` (dark-500).
- Below: wrapped chip row, one chip per known account showing that account's last interaction with this group:
  - No record → `bg-dark-800 text-dark-500`, label "no post"
  - Success → `bg-success/10 text-success`, label "sent"
  - Flood → `bg-warning/10 text-warning`, label "skip {N}s"
  - Failure → `bg-danger/10 text-danger`, label "failed"
  - Chip content: `Acc {i+1}` (bold) + label (70% opacity) + local time (50% opacity, if known)
  - Tooltip (native `title`): full formatted timestamp, or "never posted"

---

## 5. Log row anatomy (Timeline, `LogEntry`)

Every raw log line is parsed client-side (regex) into a `ParsedLog` with a `type`. Types: `success | failure | flood | cycle_start | cycle_end | connect | system | noise`. `noise` is filtered out entirely before rendering (dedup/internal scheduler chatter never reaches the UI).

### 5.1 Post-event rows (success / failure / flood) — the primary row type
Single-line flex row, `px-3 sm:px-4 py-2`, clickable (`onClick` → toggle expand), hover `bg-dark-900/30`. Background tint: failure = `bg-danger/[0.03]`, flood = `bg-warning/[0.03]`, success = none.

Left→right:
1. **Status icon** (h-3.5 w-3.5): `CheckCircle2` (success, text-success) / `Timer` (flood, text-warning) / `XCircle` (failure, text-danger)
2. **Timestamp** — mono, `text-[10px] text-dark-600`, hidden below `sm`, local 12h time (`HH:MM:SS AM/PM`); full date+time in `title` tooltip
3. **Group name** — flex-1, truncated. If a link was extracted from the raw HTML anchor, renders as `<a target=_blank>` with `ExternalLink` icon suffix, color varies by type (success: dark-200→accent hover; flood: warning/80; failure: dark-300). Falls back to plain text if no link. Falls back to `entry.message` or `groupId` or "Unknown group" if no group name (e.g. account-level pause events).
4. **Error reason** (failure only, hidden below `sm`) — short/cleaned error text, `text-[10px] text-danger/60`, max-width 180px truncate
5. **Status badge** (pill, `rounded px-1.5 py-0.5 text-[10px] font-medium`):
   - Success → "Sent", `bg-success/10 text-success`
   - Flood → "{N}s" (wait seconds), `bg-warning/10 text-warning`
   - Failure → "Failed", `bg-danger/10 text-danger`
6. **Account badge** (only shown when "All" accounts filter is active AND 2+ accounts exist; hidden below `sm`) — "Acc {N}", `bg-dark-800 text-dark-400`
7. **Expand chevron** — `ChevronDown`/`ChevronRight` (h-3 w-3, text-dark-600)

### 5.2 Expanded detail panel (inline accordion, not a modal)
On row click, appends below the row: `mt-2 ml-5 sm:ml-6`, `bg-dark-900/50 border border-dark-800/50 rounded-lg p-2.5`, `space-y-1.5`. Rows via `DetailRow` (label fixed-width `w-16 text-dark-600` + value):
- **Account** (mono)
- **Group** (link-aware, opens external URL with icon if available)
- **Group ID** (mono, conditional)
- **Error** (conditional, `text-danger`)
- **Wait** → "{N} seconds" (conditional, `text-warning`)
- **Time** — full formatted local datetime (mono)
- Divider `border-t`, then the full **raw log line** in tiny mono (`text-[9px] text-dark-700 break-all`) — this is effectively the "raw/JSON viewer" equivalent for this page (plain text, no syntax highlighting, no copy button).

No copy-to-clipboard button exists anywhere on this page currently.

### 5.3 Cycle start / connect rows (informational, non-post events)
Compact single line, `px-3 sm:px-4 py-1.5`, not clickable, no expand.
- Icon: `Activity` (cycle_start, text-accent/60) or `Wifi` (connect, text-success/60), h-3 w-3
- Optional short account label (mono, text-dark-600)
- Message text, `text-[11px] text-dark-500` (e.g. "Cycle started — 40 groups", "Connected (1.2s)")

### 5.4 Cycle end rows
Same compact style but with subtle full-row tint `bg-dark-900/30`, icon `Zap` (text-dark-500).

### 5.5 System/info rows (catch-all)
`px-3 sm:px-4 py-1.5`, icon chosen by message content:
- Contains "start" → `Play`, `text-success/60`
- Contains "stop" → `XCircle`, `text-danger/60`
- Contains "stagger"/"wait" → `Clock`, `text-dark-500`
- Else → `Radio`, `text-dark-500`
- Timestamp (mono, dark-600) inline before message; message text color matches icon semantic (success/70, danger/70, or dark-500), `text-[11px] break-all`.

---

## 6. Status badges — consolidated reference

| Badge | Trigger | Text | BG | Text color | Icon |
|---|---|---|---|---|---|
| Sent | `[POST_SUCCESS]` / "Posted in/Sent to" | "Sent" | `bg-success/10` | `text-success` (#00cec9) | `CheckCircle2` |
| Failed | `[POST_FAILURE]` / "Failed in" | "Failed" | `bg-danger/10` | `text-danger` (#ff6b6b) | `XCircle` |
| Flood/{N}s | `[FLOOD_WAIT]`, `[POST_SKIPPED]`, "FloodWait Ns in" | "{N}s" | `bg-warning/10` | `text-warning` (#fdcb6e) | `Timer` |
| Acc N | account index chip | "Acc {n}" | `bg-dark-800` | `text-dark-400` | none |
| Live | `bot.running` | "Live" | none (dot only) | `text-success` | pulsing dot |

There is no distinct "Banned"/"Retry"/"Running"/"Queued"/"Cancelled" badge today — those states are folded into the 3 core types via the parser's `cleanError()` (e.g. `USER_BANNED_IN_CHANNEL` → shows as a Failed badge with error text "Account banned in group"; `SLOWMODE_WAIT` → "Slowmode (Ns)" under a Failed badge). This is an important gap the Admin proposal should address (see §10).

---

## 7. Buttons — full inventory

| Button | Location | Icon | Variant/style | Action |
|---|---|---|---|---|
| Refresh | header, top-right | `RotateCw` | `Button ghost sm` | `mutate()` forces SWR refetch |
| Time-range pills (×7) | range strip | none | text pill | sets `range` state |
| Search clear (×) | search box | `XCircle` | icon-only | clears `search` |
| Timeline/By Group | view toggle | `List`/`Hash` | segmented | sets `view` |
| Type filter pills (×6) | filters row | per-type icon | pill | sets `filter` |
| Row-count select | filters row | none | native `<select>` | sets `displayCount` |
| Account chips (All + ×N) | filters row 2 | none | rounded-full pill | sets `accountFilter` |
| Account chip "Clear" | account detail banner | none | text link | resets `accountFilter` to "all" |
| Log row (click) | any post-event row | — | whole-row click target | toggles inline expand |
| Group link (in row/expand) | group name / DetailRow | `ExternalLink` | inline link | opens Telegram group URL in new tab, `stopPropagation` so it doesn't also toggle expand |

None of these buttons have an explicit tooltip, disabled state, or loading spinner in the current implementation (Button component supports a `loading` prop globally, but it's not passed here).

---

## 8. Notifications / empty / loading states

- **Loading (initial)**: page-level `PageSkeleton` — title skeleton bar + 4 card skeletons + table skeleton (5 rows × 4 cols of pulsing gray blocks). *(Only shown while `usePortalBot`/data is undefined — check parent route wiring; the logs page itself doesn't show its own skeleton mid-poll, only on first mount via layout.)*
- **No logs at all**: `MessageSquare` icon (40% opacity) + "No logs yet — start the bot to see output"
- **No matches for current filter**: same icon + "No matching logs for this filter"
- **No group matches (By Group view, empty)**: `Hash` icon + "No group activity yet" or "No group matches your search"
- **No toast/alert system on this page** — no success/error toasts, no retry banners. SWR failures are silent (`shouldRetryOnError: false`); a failed fetch simply leaves stale data displayed with no error indicator.

---

## 9. Pagination, responsiveness, typography, spacing, animation quick reference

**Pagination**: not paginated — it's a capped, reverse-chronological slice (`displayCount`, up to 10,000) inside one scrollable panel. No next/prev, no page numbers, no scroll-restoration logic beyond the auto-scroll-to-top-on-refresh behavior.

**Responsive**: single breakpoint (`sm`, Tailwind default 640px) hides secondary metadata on mobile (timestamp, error text, account badge, "last failed" chip) to keep rows to essential info: icon, group, status badge. Time-range strip and filter rows scroll horizontally / wrap on narrow viewports. No dedicated tablet breakpoint — `sm:` covers tablet+desktop uniformly.

**Typography**: font family — Space Grotesk (sans, headings/UI) / JetBrains Mono (mono, timestamps, IDs, raw log text). Sizes used: `text-[9px]`, `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm`, `text-base`, `text-xl/2xl` (h1 only). Weights: `font-medium` (badges, labels), `font-semibold` (card titles, unused here directly), `font-bold` (h1, stat numbers).

**Spacing**: page sections `space-y-4 sm:space-y-5`; filter card `!p-3`; row padding `px-3 sm:px-4 py-2` (post rows), `py-1.5` (info rows); card radius `rounded-xl` (panels), `rounded-lg` (chips/cards), `rounded-full` (account pills), `rounded` (badges); row dividers `divide-y divide-dark-800/30`.

**Animations**: `animate-fade-in` (page mount), `animate-slide-up` (account detail banner appearing), `animate-ping` (live dot pulse), row hover `transition-colors`, filter/pill `transition-all`. No skeleton shimmer specific to log rows, no expand/collapse transition (instant show/hide — not animated height).

---

## 10. Full color palette (Tailwind tokens actually used on this page)

- `dark-100` #ececf1 (primary text) · `dark-200` #d9d9e3 · `dark-300` #c5c5d2 · `dark-400` #acacbe (secondary/inactive text) · `dark-500` #8e8ea0 (tertiary/icons) · `dark-600` #6e6e80 (timestamps/mono) · `dark-700` #4a4a5a (borders) · `dark-800` #2d2d3a (chip bg, hover) · `dark-850` #252533 (card bg) · `dark-900` #1a1a2e (stat card bg) · `dark-950` #0f0f1a (log viewport bg)
- `accent` #6c5ce7 (brand purple — active states, links, "Posts" stat)
- `success` #00cec9 (teal — sent/connected)
- `warning` #fdcb6e (amber — flood/wait)
- `danger` #ff6b6b (red — failed)

All status colors are applied at low opacity (`/10`, `/[0.03]`, `/60`, `/70`) for backgrounds and secondary text rather than solid fills — a consistent "tinted glass" convention worth preserving in the admin version.

---

## 11. User flow (entry → inspecting one log)

1. Land on page → `PageSkeleton` if first load, then header + Live pill (if bot running) render.
2. Default view: Timeline, range=24h, filter=All, rows=1000, account=All.
3. Data polls every 3s; if `autoScroll`, panel resets to top on each refresh (newest entries appear at top since list is newest-first).
4. User narrows by: time range pill → type filter pill → account chip → free-text search — all combine (AND) except By-Group search which only matches group name/ID.
5. User switches to "By Group" to see per-group health across accounts instead of raw chronological stream.
6. Clicking a post-event row expands inline detail (account, group, group ID, error, wait, full timestamp, raw line) without navigating away or opening a dialog.
7. Clicking a group-name link (when Telegram invite link was embedded in the raw log) opens that group in a new tab; click is isolated from the row's expand toggle.
8. Manual refresh via the header `RotateCw` button forces an immediate refetch outside the 3s cycle.

---

# Admin Logs UI Proposal

Design language carried over 1:1: dark palette (`dark-850/900/950` surfaces, `accent`/`success`/`warning`/`danger` low-opacity tints), Space Grotesk/JetBrains Mono, `rounded-xl` panels, pill filters, inline-expand rows over modals where possible, tinted-glass status badges, no toasts (keep silent-SWR convention unless we introduce a real event stream).

## 11.1 Backend compatibility strategy
Keep existing per-bot endpoint (`/api/portal/bot/{bot}/logs?lines=`) as the source for **User Logs** and **Session/Worker logs** (same file, scoped by bot). Everything net-new (global cross-bot search, audit, security, system) needs new read-only admin endpoints, but they should return the **same shape** (`{ lines: string[], total_lines }` or a structured equivalent) so the existing `parseLine` logic can be reused/extended rather than rewritten:

- `GET /api/admin/logs/global?lines=&bots=&types=` — merges multiple bots' log streams server-side (avoids N parallel polls from the client)
- `GET /api/admin/logs/{category}` where category ∈ `audit | security | system | api` — new categories, each still line-oriented so the same parser/row components apply
- `GET /api/admin/logs/correlate/{correlation_id}` — pulls all lines sharing an ID, for the "Related logs" panel
- Existing session pool / payment / portal-auth admin endpoints stay untouched — this is additive, read-only surface.

## 11.2 Page structure (expanded)
1. **Header**: "Admin Logs" title + global Live/stream indicator + bot-count context + Refresh + **Stream mode** toggle (see 11.7) + **Export** button
2. **Category tabs** (new, replaces nothing — sits above the existing time-range strip): `Global | User | Session | Worker | API | Audit | Security | System`. Same pill styling as the view toggle (segmented, `bg-dark-700` active). Each tab reuses the Timeline/By-Group content area; category just changes the source endpoint + which columns are relevant.
3. **Time-range strip** — unchanged, same 7 buttons.
4. **Stats bar** — same MiniStat cards, but category-aware (e.g. Security tab shows "Blocked / Alerts / Reviewed / Open" instead of Sent/Failed/Flood).
5. **Saved searches / Pinned filters bar** (new) — chip row above the filter card: pinned filter presets (e.g. "Failed floods, last 24h") saved per-admin, stored client-side (localStorage) initially — no backend needed for v1. Star icon to pin current filter combo; chips are removable.
6. **Filters card** — existing search/view/type/account rows, plus:
   - **Bulk-select checkbox** column toggle (new "Select" mode button) enabling multi-row checkboxes for bulk actions (export selected, mark reviewed, copy IDs).
   - **Advanced filters** disclosure (`ChevronDown`) revealing: bot/user picker (multi-select), correlation ID input, min/max duration, custom date-time range (supplementing the fixed pills).
7. **Log viewport** — same scrollable panel; add a **Timeline / By-Group / Grouped-by-Event** third view (event grouping — collapses repeated identical errors into one row with a count badge, e.g. "SLOWMODE_WAIT ×47").
8. **Details drawer** (new — replaces nothing existing since today's expand is inline; for admin, promote to a **right-side slide-in drawer** for JSON inspector / request-response / performance metrics, since inline expand doesn't scale to that much data): tabs inside — `Overview | Raw JSON | Request/Response | Related | Performance`. Copy-raw and Download-log icon buttons in the drawer header. Close via X button, Escape key, or click-outside.
9. **Bulk action bar** (new, appears when 1+ rows selected): sticky bottom bar — "N selected", `Export selected`, `Mark reviewed` (audit/security only), `Copy correlation IDs`, `Clear selection`.
10. **Footer** — same counts caption, plus active category + pinned-filter count.

## 11.3 New/expanded columns for the admin table (list view, denser than user timeline rows)
| Column | Source | Notes |
|---|---|---|
| Time | `timestamp` | mono, sortable (admin gets a sort toggle the user page lacks) |
| Category | new field from endpoint | small colored tag: user/session/worker/api/audit/security/system |
| Bot/User | `bot_name` (new, since admin spans bots) | avatar-less text chip, clickable → filters to that bot |
| Session/Worker | `account`/session id | mono, truncated like today's `shortAccount` |
| Event | `type` + parsed action | e.g. "POST_SUCCESS", "LOGIN", "PAYMENT_CONFIRMED" |
| Status | badge | extends today's 3 badges with Banned / Retry / Running / Queued / Cancelled (see 11.4) |
| Correlation ID | new | mono, short-hashed, click to open Related-logs view |
| Duration | new (where available) | right-aligned, ms/s |
| Message | `message`/`error` | truncated, tooltip = full text |

## 11.4 Expanded status badges (fills the gap noted in §6)
Same tinted-glass convention (`bg-{color}/10`, `text-{color}`, no border unless focused):
- **Banned** — `text-danger`, icon `Ban` (new import) — derived from `USER_BANNED_IN_CHANNEL`/similar instead of collapsing into generic Failed
- **Retry** — `text-warning`, icon `RotateCw`
- **Running** — `text-accent`, icon `Loader2` (spin)
- **Queued** — `text-dark-400`, icon `Clock`
- **Cancelled** — `text-dark-500`, icon `XCircle` (outline/muted vs Failed's solid red)
- Existing Sent/Failed/Flood unchanged.

## 11.5 JSON inspector / raw / copy / download (drawer)
- **Raw tab**: monospace block identical styling to today's `text-[9px] text-dark-700` raw line, but full raw log text (not truncated), scrollable, `Copy raw log` icon button (clipboard) top-right of the block.
- **JSON tab**: only for structured events (e.g. payment/audit) — collapsible tree view, key/value pairs, same dark theme (`bg-dark-900/50` panel).
- **Download log** button in drawer header — downloads the filtered/selected slice as `.txt`/`.json` (client-side blob, no new backend needed beyond the existing fetch).

## 11.6 Request/Response viewer & performance metrics (API logs category only)
Two-column split inside the drawer's dedicated tab: left = request (method, path, headers, body), right = response (status, headers, body, latency). Latency shown as a small colored badge (green <200ms, amber <1s, red >1s) — reuses success/warning/danger tokens, no new colors.

## 11.7 Live/Stream mode
Toggle button next to Refresh: **Poll (3s)** vs **Stream**. Stream mode upgrades the connection to SSE/WebSocket if the backend adds one; until then, "Stream" just tightens the SWR interval (e.g. 1s) as a stopgap — fully backward compatible with the existing polling endpoint, no breaking change required to ship v1.

## 11.8 Event grouping & Related logs
- **Event grouping**: client-side aggregation identical in spirit to today's `groupAgg` (by-group aggregation) but keyed by `(category, error/event-type)` instead of group name — collapses noisy repeats into one row + count + "expand to see all N" affordance (same chevron pattern as row-expand today).
- **Related logs**: once a correlation ID is present on a row, the drawer's "Related" tab lists every other line sharing that ID (chronological), each rendered with the same `LogEntry`-style compact row — reuses existing component, just fed a filtered subset.

## 11.9 Export & bulk actions
- **Export** (header button, and duplicated in bulk-action bar for "selected only"): client-side, generates CSV/JSON from currently-filtered rows — no backend export endpoint required for v1 since all data is already fetched to the client.
- **Bulk actions** beyond export limited to read/administrative ones that don't touch bot logic: "mark reviewed" (audit/security triage, needs a small new table/endpoint to persist reviewed-state per log line — the only genuinely new backend surface this proposal requires) and "copy IDs".

## 11.10 What stays purely additive (no risk to existing user page)
Everything above is a **new page** (`/admin/logs`) composed from the same building blocks (`Card`, `Button`, `MiniStat`, `LogEntry`, `GroupRow`, parser functions) — the existing `frontend/app/user/(portal)/logs/page.tsx` is not modified. Shared pieces (parser, `DetailRow`, `MiniStat`) should be extracted into `components/logs/` for reuse rather than duplicated, but that's a refactor decision for implementation time, not for the Figma stage.

---

# 12. Design Rules Applied — Revised Admin Layout

Section 11 above listed every feature that *could* exist. This section applies the stricter design rules (clarity over decoration, 3-second comprehension, progressive disclosure, 8px spacing, color-with-meaning) and **cuts §11 down to what earns its place on first paint**. Treat this section as overriding §11 wherever they conflict — §11 remains as a feature backlog/reference, this is the actual layout to build in Figma.

## 12.1 The 3-second test — what must be visible with zero interaction
On load, in order of eye travel:
1. **Is everything healthy?** → one status line at the very top: a single word/phrase state ("All systems normal" / "3 failures need attention") backed by color, not a grid of numbers competing for attention.
2. **Are there failures?** → the failure/attention count is the only number rendered large; everything else is supporting text.
3. **Which logs need attention?** → those rows are already sorted to the top of the table, tinted, no extra click needed.
4. **What happened recently?** → the table itself, newest-first, visible without scrolling on desktop.
5. **Where should they click next?** → the one row with a problem is visually the highest-contrast thing on the page after the status line. Nothing else competes with it.

Everything else (category tabs, saved searches, bulk mode, export) is reachable but not visible-by-default — see 12.4.

## 12.2 Collapse the header/stats zone (replaces §2.1–§2.3, §11.2 items 1–4)
Old design had: title row, 7-button range strip, 4 stat cards, conditional account banner — four separate visual bands before the table even starts. New design merges these into **one card**:

- **Single "Status" card** at the top (not four `MiniStat` boxes): left side = one large colored word ("Healthy" in success green / "Needs attention" in warning/danger) with a small supporting line underneath ("142 sent · 3 failed · 1 flood — last 24h"); right side = a tiny inline sparkline/trend (last N cycles, success rate) and the time-range control collapsed into a single dropdown ("Last 24h ▾") instead of 7 always-visible pill buttons.
- This is a card with **purpose** per the Card Design rule: primary metric (health state) + supporting text (counts) + trend (sparkline) + status indicator (color) + context (range) — one card, not four single-number boxes.
- Category context (Global/User/Session/etc., see 12.4) lives as a label inside this same card, not a separate tab strip competing for top-of-page attention.

Removed entirely from default view: the always-visible 4-card stat grid, the always-visible 7-button range strip, the separate account-detail banner (folded into the row-selection drawer instead, since it's a filtered-context state, not primary info).

## 12.3 Filters go behind one control, not three rows (replaces §3, §11.2 item 6)
Rule violated today: three stacked rows (search+view, 6 type pills + select, account chips) are visible at all times whether or not the user needs them — visual noise before any interaction.

Revised:
- **One visible row**: search box (full width) + a single "Filters" button (shows active-filter count as a badge, e.g. "Filters · 2") + the view toggle (Timeline/By Group, since that's a primary mode, not a filter).
- Clicking "Filters" opens a **popover (desktop) / bottom sheet (mobile)** containing: type filter (now a single-select segmented control, not 6 always-rendered pills — most sessions only ever look at "Failed" or "All"), account picker, row-count, advanced fields (correlation ID, bot/user, duration range from §11.2 item 6).
- Active filters render as small removable chips directly under the search bar **only when set** — e.g. after picking "Failed" + "Acc 2", two small dismissible chips appear; with no filters active, nothing renders there. This satisfies progressive disclosure and avoids showing 6 buttons to communicate a choice that's usually "off."
- Saved searches / pinned filters (§11.2 item 5) live inside the same Filters popover as a "Saved" sub-section — not a permanent chip row on the page.

## 12.4 Category switch becomes a compact selector, not 8 tabs (replaces §11.2 item 2)
8 always-visible tabs (Global/User/Session/Worker/API/Audit/Security/System) is exactly the kind of decoration-over-clarity the rules warn against — most admins work in one category per session. Replace with a single dropdown/segmented control next to the page title: **"Viewing: Global ▾"**. Switching categories swaps the table's relevant columns per §11.3, but the chrome around it (status card, search, filters) stays constant so the page doesn't feel like 8 different pages.

## 12.5 Table redesign — the part that must "just work" (replaces §11.3, applies Table Design + Color Usage rules)
Column set is reduced to what supports the stated eye path **Status → Title → Time → Details → Actions**:

| Visual weight | Column | Notes |
|---|---|---|
| Highest (color + icon) | **Status** | badge only — the one place color is used to mean something |
| High (largest text) | **Title** | group/event name — the thing the admin scans for |
| Medium (muted, mono, right-aligned) | **Time** | relative by default ("2m ago"), absolute on hover (tooltip) — reduces label repetition of full dates down the whole list |
| Low (fades, only on hover/expand) | **Details** | account, bot, correlation id, duration — not rendered as separate columns; compressed into one muted "meta" line under the title, revealed in full only in the drawer |
| Actions | icon-only, appears on row hover only (not permanently rendered per row) | expand / copy / open-link |

Concretely: **drop the dedicated Category, Bot/User, Session/Worker, Correlation ID, Duration columns from the always-visible table** (§11.3's 9-column table is too dense to scan). Fold them into a single secondary text line under the title, `text-dark-500`, so the table reads as 3 real columns (Status / Title+meta / Time) plus a hover-revealed action column — matching "less important metadata should fade into the background."

Row separation: no per-row border — use whitespace (8px rhythm) and a very subtle background-only hover state (`bg-dark-900/30`, no border) so rows "clearly separate" through spacing, not lines, per the Visual Noise rule ("increase whitespace instead of adding separators").

Event grouping (§11.8) is on by default for repeated identical errors — collapsing noise is part of "the table is the most important part, make it effortless to scan," not an opt-in power feature.

## 12.6 Progressive disclosure for details (replaces §11.5–§11.6 drawer contents)
Keep the drawer from §11.2 item 8, but it opens with **only the Overview tab** rendered (status, title, time, short message) — Raw/JSON, Request/Response, Related, Performance are tabs the admin *reaches for*, not things dumped on open. This is the literal "advanced information should appear only after interaction" rule applied to the drawer itself, not just the page.

Copy/Download actions (§11.5) move from being permanently visible icons to appearing in the drawer's header only when that drawer is open — not as always-on affordances in the table.

## 12.7 Color discipline (replaces "extended badge" tone in §11.4)
Reconfirm the rule literally: green = success, red = problem, yellow = needs attention, blue/purple (accent) = interactive/clickable, gray = secondary. Applied strictly, the expanded badge set from §11.4 collapses to reuse existing hues rather than inventing new ones:
- Banned/Failed → same red family (both are "problem"; distinguish by icon/label text, not a new color)
- Retry/Queued/Running → same accent/gray family (these are process states, not success/failure — don't borrow red/green/yellow for them)
- Cancelled → gray (secondary/inactive), not red — a cancelled action isn't a failure.

This shrinks the palette back down instead of growing it, per "never use color only because it looks nice."

## 12.8 Mobile (replaces §11's implicit desktop-first framing)
- Status card becomes the only thing above the fold besides search.
- Filters button opens a bottom sheet (not a popover).
- Table rows become stacked cards: Status badge + Title on line 1, relative time + one meta fragment on line 2 — tapping opens the same drawer, now full-screen.
- Bulk-select and category switch both collapse into the same overflow/menu affordance to avoid a second row of controls on narrow screens.
- Minimum touch target 44×44px on every interactive element (filter button, row tap area, drawer close).

## 12.9 Motion
All transitions 150–250ms, ease-out, no bounce: drawer slide-in/out, filter popover fade+scale (0.98→1), row hover background fade, chip appear/remove fade. No decorative animation (no pulsing dots beyond the existing Live indicator, which stays because it communicates real state, not decoration).
