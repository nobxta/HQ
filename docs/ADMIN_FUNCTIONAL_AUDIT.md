# Admin Bot & Admin Control System — Functional Audit

**Date:** 2025-02-13  
**Scope:** Admin Bot (Telethon + PTB), Admin menu, Shop/order flow, Sessions, Bots, Users, Observability.

---

## 1. Current Admin Capabilities Table

| Area | Capability | Supported | Notes |
|------|------------|-----------|--------|
| **Session management** | Add sessions | ✅ Yes | Single .session, .txt list, or .zip; validated → free_sessions or dead_sessions |
| | View full session file list | ⚠️ Partial | Manage Sessions shows **counts** (total/dead/assigned/free). Remove Sessions lists only **first 15 free + 15 dead** by name |
| | Download/export session files | ❌ No | No export or download of session list/files |
| | Move sessions (unused/assigned/banned/frozen) | ⚠️ Partial | Only **free** and **dead** are in admin UI. No **frozen** or **banned** buckets in pool.json or admin menu; config has `SESSIONS_FROZEN` but admin cannot move sessions there |
| | Replace sessions in bulk | ⚠️ Partial | “Replace dead sessions” / “Replace error sessions” per bot or globally; no “bulk replace N sessions from pool” |
| | Session health statistics | ⚠️ Partial | Counts only (total, dead, assigned, free). No per-session health (last used, errors, banned/frozen state) |
| | See which bot uses which session | ⚠️ Indirect | Per-bot actions show that bot’s sessions only; no global “session → bot” map in UI |
| | Force-disconnect a session | ❌ No | No admin action to disconnect a specific session from a worker |
| **Bot management** | Create bots manually | ✅ Yes | Create AdBots wizard (name, sessions count, cycle, gap, token, valid_till, mode, group file) |
| | Delete bots | ✅ Yes | Delete AdBot with choice: move sessions to free or mark dead |
| | Suspend/disable bot temporarily | ❌ No | No admin “suspend”; only user can Stop from controller; no “disabled” state |
| | Force restart a bot | ❌ No | Health monitor restarts frozen workers automatically; no admin-triggered restart |
| | Real-time bot activity logs | ⚠️ Partial | `/logs` sends **today’s log files** (main + per-bot); not live tail/stream |
| | Transfer bot ownership | ❌ No | No change of authorized user or “transfer to another user” |
| **Order / payment** | Manually mark payment as paid | ❌ No | Only payment worker marks paid on API confirmation; no admin override |
| | Refund / cancel orders | ❌ No | User can `/cancel`; no admin cancel or refund flow |
| | Re-run bot creation for order | ✅ Yes | PTB: “Pending Shop Orders” → Recreate for `pending_creation` orders |
| | View full payment + tx history per user | ❌ No | No admin view of orders/payments by user |
| | Search orders by payment_id / user_id | ❌ No | `get_order`, `get_order_by_payment_id` exist in storage but are not exposed in admin |
| **System control** | Maintenance mode | ❌ No | No global maintenance flag; no “System under maintenance” or notification queue |
| **Broadcast** | Broadcast to all users | ✅ Yes | `/broadcast <text>` → all **authorized** users of all AdBots (+ ADMIN_USER_ID) |
| | Segment (paying / active / never purchased / expiry soon) | ❌ No | No segmentation; single “all authorized” list |
| | Automatic broadcast lists | ❌ No | No stored lists (e.g. /start users, purchasers, expired) or rate-limited send |
| **User management** | Search users by ID, bot username, plan | ❌ No | No admin command or menu |
| | Manually extend plan | ❌ No | valid_till is in user JSON but no admin “extend plan” action |
| | Freeze user account | ❌ No | No “frozen” or “suspended” user state |
| | Flag suspicious users | ❌ No | No flag or notes field |
| **Observability** | Total active bots | ⚠️ In /health | Per-bot lines with state; not a single summary line |
| | Bots running / stopped | ✅ Yes | In `/health`: state (running/stopped/dead) per bot |
| | Active / free sessions | ✅ Yes | In Manage Sessions and `/health` (per-bot sessions ok/dead) |
| | Orders pending / creating / failed | ⚠️ Partial | “Pending Shop Orders” shows only **pending_creation**; no counts for payment_waiting, creating, failed |
| | Worker health status | ❌ No | Not exposed; only internal heartbeat/watchdog |
| | Payment polling health | ❌ No | Heartbeat file exists but not shown in admin |

---

## 2. Missing Critical Admin Controls

### 2.1 Session management
- **Full session list**: View and paginate all session filenames (free, dead, and assigned with bot name).
- **Export sessions**: Download list (e.g. CSV/txt) or session files for backup (with safety confirmation).
- **Frozen/banned buckets**: Use `SESSIONS_FROZEN` (and optionally a “banned” list) in pool/admin UI; allow moving sessions between free / dead / frozen (and banned if added).
- **Bulk replace**: “Replace N dead/error sessions from pool” for a bot or globally.
- **Session → bot mapping**: One screen or export: session filename → bot name/token.
- **Force-disconnect session**: Stop the worker using a given session (and optionally move session to frozen/dead).

### 2.2 Bot management
- **Suspend/disable**: Admin-only “suspend” state; bot stays in storage but posting and controller are disabled until “resume”.
- **Force restart**: Button/command to stop and start posting for a bot (e.g. after config fix).
- **Live logs**: Optional “stream last N lines” or “tail” for a bot (or link to log file with recent content).
- **Transfer ownership**: Change `authorized` (and optional extra fields) to another user_id.

### 2.3 Order / payment
- **Mark as paid**: Admin action to set order status to `paid` (and optionally trigger creation flow) for edge cases (manual payment, support).
- **Cancel/refund**: Admin cancel order (and optionally notify user); refund handling can be out-of-band but status should be updatable.
- **Order search**: Search by `order_id`, `payment_id`, `user_id` and show order details + payment/tx info.
- **Payment/tx history per user**: List orders and key payment fields for a given user.

### 2.4 System control (critical)
- **Maintenance mode** (see Section 4 below): Single flag; when on: Shop Bot, Controller Bot, and non-critical admin actions pause; users get “System is currently under maintenance”; queue users for “Maintenance complete” notification when mode is turned off.

### 2.5 Broadcast
- **Segments**: Broadcast to: all users, only paying (has completed order), only active-plan (valid_till ≥ today), never purchased, expiry soon (e.g. in 7 days).
- **Stored lists**: Maintain lists such as “clicked /start”, “purchased”, “expired” (from plan validity) for reuse and rate-limited sends.

### 2.6 User management
- **Search**: By Telegram user_id, by bot username (from index), by plan name or valid_till.
- **Extend plan**: Admin sets new `valid_till` (and optionally adds renewal history entry).
- **Freeze account**: Flag or state to disable bot usage / controller access until unfrozen.
- **Flag suspicious**: Optional flag or notes on user/bot for support.

### 2.7 Observability
- **Dashboard summary**: One message or screen: total bots, running/stopped, active/free sessions, orders by status (pending payment, creating, failed, completed).
- **Worker health**: Expose worker heartbeat/status (e.g. last activity per bot) in admin.
- **Payment polling health**: Show last payment heartbeat time and status (e.g. “OK” / “stale”) in admin.

---

## 3. Recommended New Admin Features (Priority Order)

| Priority | Feature | Area | Rationale |
|----------|---------|------|-----------|
| P0 | Maintenance mode | System | Required for safe deployments and incidents; blocks user actions and notifies when done |
| P0 | Admin “mark order as paid” | Order | Handles manual payments and support cases without code changes |
| P0 | Order search (by order_id, payment_id, user_id) | Order | Essential for support and debugging |
| P1 | Admin cancel order | Order | Support and refund flows |
| P1 | User search (by user_id, bot username) | User | Needed for support and manual operations |
| P1 | Manually extend plan | User | Common support action |
| P1 | Observability dashboard (counts: bots, sessions, orders by status) | Observability | Single-pane view of system health |
| P1 | Payment polling + create worker health in admin | Observability | Detect stuck workers without reading logs |
| P2 | Broadcast segments (paying / active / expiry soon) | Broadcast | Better targeting and retention |
| P2 | Suspend / resume bot | Bot | Temporary disable without deleting |
| P2 | Force restart bot | Bot | Recovery after config/session fixes |
| P2 | Full session list + session → bot map | Session | Operational clarity and auditing |
| P2 | Frozen (and optional banned) session buckets in admin | Session | Use existing SESSIONS_FROZEN and optional banned list |
| P3 | Export session list (read-only list, no file download) | Session | Backup/audit without moving files |
| P3 | Transfer bot ownership | Bot | Handover between users |
| P3 | Freeze user / flag suspicious | User | Moderation and risk |
| P3 | Rate-limited broadcast + stored segments | Broadcast | Scale and safety |

---

## 4. Maintenance Mode — Implementation Design

### 4.1 Behavior
- **When enabled**
  - Shop Bot: all handlers (except e.g. /start for “under maintenance” message) respond with:  
    `System is currently under maintenance. Please try again later.`
  - Controller Bot (user AdBots): same message for any action (Run/Stop/Set Message/Status/etc.).
  - Admin Bot: **Critical actions only** (e.g. enable/disable maintenance, /health, /cpu). Optional: block Create AdBots / Manage Sessions / Manage AdBots during maintenance to avoid inconsistent state.
- **User queue**: Every user_id (or chat_id) that receives “under maintenance” is appended to a **maintenance_notify_queue** (in memory or in a small JSON file under `data/`).
- **When disabled**
  - Clear or process the queue: send each user:  
    `Maintenance is complete. You may now continue.`
  - Rate-limit sends (e.g. 1 message per second) to avoid Telegram limits.
  - Then clear the queue.

### 4.2 Storage
- **Config**: Add a single flag, e.g. in `data/maintenance.json`:
  ```json
  { "enabled": true, "updated_at": "2025-02-13T12:00:00Z" }
  ```
- Or an env override: `MAINTENANCE_MODE=1` (read at startup and optionally re-read periodically).

### 4.3 Code touchpoints
- **Shop Bot** (`code/shop/handlers.py`): At top of handler chain, if maintenance enabled → reply with maintenance message and add user to queue; return.
- **Controller Bot** (`code/users.py`): Same: before handling Run/Stop/etc., if maintenance enabled → reply and add to queue; return.
- **Admin Bot** (`code/admin_ptb.py` or `code/admin.py`): New command or menu: “Maintenance On” / “Maintenance Off”. When turning off, run notify loop then clear queue.
- **Queue**: e.g. `data/maintenance_queue.json` — list of `user_id` or `{ "user_id", "chat_id" }`; dedupe on add.

### 4.4 Compatibility
- No change to existing session/bot/order schema. Only new file(s) and one global check in handlers. Optional: admin “Maintenance” button in main menu.

---

## 5. Broadcast System Design (Segmentation + Safety)

### 5.1 Segments (examples)
- **all** — All users who ever interacted (e.g. /start in Shop or any AdBot authorized).
- **paying** — At least one order with status `completed`.
- **active_plan** — valid_till ≥ today (from user/bot config).
- **never_purchased** — No completed order.
- **expiry_soon** — valid_till in next 7 days (configurable).

### 5.2 Segmentation storage
- **Option A (minimal)**: No new tables; compute at send time:
  - **all**: current logic (authorized per bot + ADMIN_USER_ID).
  - **paying**: from `orders` with status `completed` → distinct user_id.
  - **active_plan** / **expiry_soon**: from `load_adbot()["bots"]` and per-bot `valid_till` and `authorized`.
- **Option B**: Periodic job that writes segment lists to e.g. `data/broadcast_segments.json`:
  ```json
  {
    "updated_at": "...",
    "all": [123, 456],
    "paying": [123],
    "active_plan": [123],
    "never_purchased": [456],
    "expiry_soon": [123]
  }
  ```
  Admin broadcast uses these lists; rate-limit (e.g. 30 users/min) and optional “Preview count” before sending.

### 5.3 Safe sending
- **Rate limit**: e.g. 1 message per 0.5–1 s per recipient; configurable cap (e.g. 100 users per run, then “Batch sent; continue?”).
- **Dry run**: “Would send to N users; type /broadcast_confirm to send.”
- **Log**: Log segment + count + timestamp for audits.

---

## 6. Required Database or Config Changes

| Change | Purpose |
|--------|--------|
| **data/maintenance.json** (or env) | Maintenance mode flag and optional timestamp |
| **data/maintenance_queue.json** | Queue of user/chat IDs to notify when maintenance ends |
| **data/broadcast_segments.json** (optional) | Cached segment lists for broadcast |
| **pool.json** | Optional: add `frozen_sessions: []` (and `banned_sessions: []` if desired); admin UI to move sessions between free/dead/frozen |
| **orders.json** | No schema change; use existing status and fields for search and “mark paid” |
| **User JSON (data/user/*.json)** | Optional: `suspended: true`, `notes: "..."`, `flagged_at: "..."` for suspend and flag-user |
| **Config (config.py)** | Optional: `MAINTENANCE_MODE`, `BROADCAST_RATE_LIMIT_PER_MIN` |

No migration of existing orders or user files required for P0/P1; only new files and new keys (optional) for segments and user flags.

---

## 7. Commands / Buttons to Add

### 7.1 Session management
- **“List all sessions”** (or “View full list”): Paginated list of session filenames with status (free/dead/assigned) and, if assigned, bot name.
- **“Export session list”**: Send a text file listing session names and status (no .session file download by default for safety).
- **“Move to frozen”** / **“Move to free”** (and “Move to dead”): In Remove Sessions or in a “Session detail” view, for each session.
- **“Bulk replace”**: From Manage AdBots → bot → “Replace up to N sessions” (N from free pool).
- **“Session → Bots”**: Menu or `/sessions_map` output: table or list “session_file → bot_name”.
- **“Disconnect session”**: Choose session → confirm → stop worker using it, move session to frozen or dead.

### 7.2 Bot management
- **“Suspend” / “Resume”**: In per-bot menu; sets a `suspended` (or `disabled`) flag and stops posting + blocks controller until resumed.
- **“Restart bot”**: Button to stop posting and start again (same as force restart).
- **“Logs (last 50 lines)”**: Send last 50 lines of that bot’s log file (or link).
- **“Transfer ownership”**: Prompt for new user_id, confirm, then set `authorized = [new_id]` (and optional history).

### 7.3 Order / payment
- **“Orders”** (main menu): Submenu: “Search by order ID”, “Search by payment ID”, “Search by user ID”, “Pending creations”, “Mark as paid”.
- **/order &lt;order_id&gt;** or **/order_payment &lt;payment_id&gt;** or **/order_user &lt;user_id&gt;**.
- **“Mark as paid”**: After selecting an order (e.g. payment_waiting/confirming), set status to `paid` and optionally trigger creation (same as worker).
- **“Cancel order”**: Select order → confirm → set status to `cancelled`, optionally notify user.

### 7.4 System control
- **“Maintenance”** (main menu): “Turn on” / “Turn off”. When turning off: “Notifying N users… Done.”

### 7.5 Broadcast
- **/broadcast_segment &lt;segment&gt; &lt;message&gt;**  
  Segments: `all`, `paying`, `active_plan`, `never_purchased`, `expiry_soon`.
- Or menu: “Broadcast” → choose segment → enter message → “Preview count” → “Send” (with rate limit).

### 7.6 User management
- **“Users”** (main menu): “Search by user ID”, “Search by bot username”.
- **/user &lt;user_id&gt;** or **/user_bot @username**: Show user’s bots, plans, valid_till, last order.
- **“Extend plan”**: Select user/bot → enter new valid_till or “+30 days” → confirm.
- **“Freeze user”** / **“Flag user”**: Set flags/notes; controller and Shop can check and show “Account frozen” or similar.

### 7.7 Observability
- **/dashboard** or **“Dashboard”** button: One message with:
  - Bots: total, running, stopped, dead.
  - Sessions: active, free, dead (and frozen if added).
  - Orders: payment_waiting, confirming, creating, pending_creation, failed, completed (counts).
  - Workers: “Create worker heartbeat: OK/stale”; “Payment worker heartbeat: OK/stale”.
- **/workers**: Per-bot worker status (e.g. last_activity, alive count).

---

## 8. Summary

- **Current strengths**: Create/delete bots, add/remove sessions, validate/replace dead or error sessions, recreate log groups, re-run creation for pending_creation orders, broadcast to all authorized users, /health and /cpu, /logs, /fix (repair), daily reports and alerts.
- **Critical gaps**: No maintenance mode, no admin “mark paid” or order search, no user search or extend plan, no observability dashboard or worker/payment health in admin, no broadcast segments or rate limiting, no suspend/restart/transfer or session-level controls (full list, frozen, force-disconnect).
- **Recommended order of work**: Implement maintenance mode (P0), then “mark paid” + order search (P0), then order cancel + user search + extend plan + dashboard + worker/payment health (P1), then broadcast segments + suspend/restart + session list and frozen bucket (P2), then export, transfer, freeze/flag, and advanced broadcast (P3). All can be done within the current architecture (pool.json, index, user JSON files, orders.json) with small additions (maintenance file, optional segment cache, optional user flags).
