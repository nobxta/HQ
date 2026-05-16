# ADMIN CONTROL FLOW BEHAVIOR REPORT

Full behavioral audit of the Admin Telegram Bot UI and command system. No code was modified; inspection and documentation only.

---

## 1. /start menu analysis

**What appears after `/start`**
- Message: `"Admin menu:"`
- Single inline keyboard with 5 buttons in 3 rows.

| Button             | Purpose | Backend handler | UX placement evaluation |
|--------------------|--------|------------------|--------------------------|
| **Control Center** | Hub for system (maintenance, emergency stop/resume), orders, users, sessions overview, bots shortcut, broadcast, dashboard. | `on_callback` → `raw == "control_center"` | Logical: one place for “overview and system-wide actions.” No redundancy. |
| **Create AdBots**  | Start wizard to create a new user-facing AdBot (name → sessions_count → cycle → gap → bot_token → valid_till → renewal_price → mode → group_file → submit). | `on_callback` → `raw == "create_adbots"` | Logical: primary creation entry. Not redundant. |
| **Manage AdBots**  | List all AdBots; pick one for validate/replace dead/error, recreate log group, suspend/resume, force restart, transfer ownership, delete. | `on_callback` → `raw == "manage_adbots"` | Logical: per-bot operations. Not redundant. |
| **Manage Sessions** | Show session counts (Total \| Dead \| Assigned \| Free) and actions: Add Sessions, Remove Sessions. | `on_callback` → `raw == "manage_sessions"` | Logical for add/remove; see Section 5 for missing “Session List” in this screen. |
| **Pending Orders**  | List shop orders in `pending_creation` (insufficient sessions at payment) with “Recreate” per order. | `on_callback` → `raw == "pending_orders"` | Logical: operational follow-up for failed creations. Not redundant. |

**Redundancy**
- No button is redundant. Each has a distinct role.

**Missing from main menu**
- **Dashboard / health at a glance:** Not on /start; user must use Control Center → Dashboard or `/dashboard` / `/health`. Acceptable if /start is kept minimal.
- **Broadcast:** Only via Control Center → Broadcast. Not on main menu; keeps main menu shorter.
- **Fix (repair):** Only via `/fix` or `/fix <bot_name>`. No main-menu button; docstring in users.py notes “Fix is only via /fix command, not shown as button.” So by design.

---

## 2. Inline button mapping

For every inline button: text, callback_data, handler, what admin sees after click, backend operations, why it exists, placement logic, and whether the screen could show more useful data.

### 2.1 Main menu (after /start)

| Button text       | Callback data     | Handler function | What admin sees after clicking | Backend operations | Why this button exists | Placement logical? | Could screen show more? |
|-------------------|-------------------|------------------|---------------------------------|--------------------|-------------------------|--------------------|--------------------------|
| Control Center    | `control_center`  | `on_callback`    | "Control Center:" + 6 options (System, Orders, Users, Sessions, Bots, Broadcast, Dashboard, « Back) | load_adbot() (for context) | Central hub for system/orders/users/sessions/broadcast/dashboard | Yes | Could add one-line summary (e.g. bots/sessions counts) on the Control Center screen. |
| Create AdBots     | `create_adbots`   | `on_callback`    | Status line (Hosted \| Total \| Dead \| Assigned \| Free) + "Proceed to create a new AdBot?" + [Proceed] [Cancel] | _create_status_text(data), load_adbot(), _session_counts | Let admin create a new AdBot with wizard | Yes | Status line is useful; could add "Free: N" more prominently when free=0. |
| Manage AdBots     | `manage_adbots`   | `on_callback`    | "Manage AdBots - pick one:" + list of bot names + [Back] | load_adbot() | Per-bot actions | Yes | Could show per-bot state (running/stopped) in list. |
| Manage Sessions   | `manage_sessions` | `on_callback`    | "Total sessions: t \| Dead: d \| Assigned: a \| Free: f" + [Add Sessions] [Remove Sessions] [« Back] | load_adbot(), _session_counts(data) | Add or remove session files | Yes | No list of sessions here; list lives under Control Center → Sessions (see Section 5). |
| Pending Orders    | `pending_orders`  | `on_callback`    | Either "No pending shop orders." + [Back] or list "Order {id} — Recreate" + [Back] | orders_pending_creation() (shop.storage) | Re-run creation for orders that failed due to insufficient sessions | Yes | Could show order_id and need count. |

### 2.2 Create wizard

| Button text   | Callback data    | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|---------------|------------------|--------|-----------------|---------|------------|-----------|--------------------|
| Proceed       | `create_proceed` | on_callback | Either "No free sessions…" (main menu) or "Enter internal name (e.g. buyer2): Type /cancel to abort." | _session_counts; state create_step=name | Start wizard | Yes | — |
| Cancel        | `create_cancel`   | on_callback | "Cancelled." + main menu | _clear_create_state | Abort wizard | Yes | — |
| (group file)  | `gf:<name>`      | on_callback | Summary (name, bot, sessions, cycle, gap, valid_till, renewal, mode, group file) + [Proceed] [Cancel] | validate_bot_token if bot_token set | Choose group file | Yes | Summary is good; could warn if group file missing. |
| Proceed (summary) | `create_final` | on_callback | "Create queued. I'll update this message when done." then progress/result | submit_create_job → _create_job_queue, create worker, _result_consumer_ptb | Submit create job | Yes | — |
| Starter       | `mode:starter`   | on_callback | "Choose group file:" + file list + [Cancel] | — | Set mode | Yes | — |
| Enterprise    | `mode:enterprise`| on_callback | Same | — | Set mode | Yes | — |

### 2.3 Manage Sessions

| Button text      | Callback data   | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|------------------|-----------------|--------|-----------------|---------|------------|-----------|--------------------|
| Add Sessions     | `add_sessions`  | on_callback | "Send a single .session file, a .txt (one session filename per line), or a .zip containing session files." + [Cancel] | user_data add_sessions=True | Upload sessions | Yes | Could mention max size or supported formats again. |
| Remove Sessions  | `remove_sessions`| on_callback | "Select session to remove:" + rows of " <name>" or " <name> (dead)" (up to 15 each) + [Back], or "No free or dead sessions. Add some first." + [Back] | load_adbot(), free_sessions, dead_sessions | Delete session from pool and file | Yes | No list of assigned sessions here; only free/dead. Could add "View full list" → Control Center → Sessions. |
| « Back           | `back_sessions` | on_callback | "Admin menu:" + main menu | clear add_sessions | Return to main menu | Yes | — |
| Cancel           | `cancel_add`    | on_callback | Same as Manage Sessions screen (counts + Add/Remove/Back) | clear add_sessions, load_adbot | Cancel upload mode | Yes | — |
| (session name)   | `del_f:<name>` or `del_d:<name>` | on_callback | "Removed." (toast) then same Manage Sessions text + Add/Remove/Back | load_adbot, save_adbot, unlink file from SESSIONS_ACTIVE or SESSIONS_DEAD | Remove one session | Yes | — |

### 2.4 Control Center

| Button text | Callback data | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|-------------|---------------|--------|-----------------|---------|------------|-----------|--------------------|
| System      | `cc_system`   | on_callback | "System control\n\nMaintenance: ON/OFF\nQueue to notify when off: N" + [Turn maintenance ON/OFF] [Emergency: Stop all] [Emergency: Resume all] [« Back] | load_maintenance, load_maintenance_queue | Maintenance and emergency stop/resume | Yes | Could show last emergency stop time. |
| Orders      | `cc_orders`   | on_callback | "Order search: use /order_id <id>, /order_payment <payment_id>, /order_user <user_id> to search. Or:" + [Pending creations] [« Back] | — | Signpost to order commands and pending list | Yes | Could show count of pending_creation. |
| Users       | `cc_users`    | on_callback | "User search: use /user_id <telegram_id>, /user_bot @username, /user_plan <plan_name>" + [« Back] | — | Signpost to user commands | Yes | — |
| Sessions    | `cc_sessions` | on_callback | "Sessions: N total. Map: M assigned." + first 20 session lines (file — status (bot_name)) + [Full list (next 20)] [Session → Bot map] [Manage Sessions] [« Back] | session_full_list(), session_to_bot_map() | View session list and map; jump to Manage Sessions | Yes | This is where session list lives; Manage Sessions does not show list (see Section 5). |
| Bots        | `manage_adbots`| on_callback | Same as main menu Manage AdBots | load_adbot | Shortcut to manage bots | Yes | Duplicate entry point; intentional for hub. |
| Broadcast   | `cc_broadcast`| on_callback | "Select Broadcast Target:" + [All Users] [Plan Users] [Cancel] | — | Start broadcast flow | Yes | Could show recipient counts. |
| Dashboard   | `cc_dashboard` | on_callback | Dashboard text (bots, sessions, orders, create/payment worker) + [Refresh] [« Back] | dashboard_counts() | At-a-glance stats | Yes | — |
| « Back      | `cc_back`     | on_callback | "Admin menu:" + main menu | — | Return to main menu | Yes | — |

### 2.5 System (cc_system)

| Button text              | Callback data   | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|--------------------------|-----------------|--------|-----------------|---------|------------|-----------|--------------------|
| Turn maintenance ON      | `maint_on`      | on_callback | "Maintenance mode is ON. Users will see the maintenance message." + [« Back] | save_maintenance(True), log_admin_action | Enable maintenance | Yes | — |
| Turn maintenance OFF     | `maint_off`     | on_callback | "Notifying N user(s)… Rate-limited." then "Maintenance OFF. Notified: sent, failed." or "Maintenance mode is OFF." + [« Back] | save_maintenance(False), process_maintenance_queue_and_clear, log_admin_action | Disable and notify queue | Yes | — |
| Emergency: Stop all posting | `emergency_stop`  | on_callback | "Stop requested for N bot(s). You will be notified when done." + [« Back] | emergency_stop_all_posting(admin_id) → submit_main_loop_job("emergency_stop_all") | Stop all running bots | Yes | — |
| Emergency: Resume all posting | `emergency_resume` | on_callback | "Resume requested for N bot(s)." + [« Back] | emergency_resume_all_posting(admin_id) → submit_main_loop_job("emergency_resume_all") | Resume emergency-stopped bots | Yes | — |
| « Back                   | `control_center`| on_callback | Control Center screen | — | Back to hub | Yes | — |

### 2.6 Dashboard

| Button text   | Callback data            | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|---------------|--------------------------|--------|-----------------|---------|------------|-----------|--------------------|
| Refresh       | `cc_dashboard_refresh`   | on_callback | Same dashboard text (refreshed) + [Refresh] [« Back] | dashboard_counts() | Refresh counts | Yes | — |
| « Back        | `control_center`         | on_callback | Control Center screen | — | Back to hub | Yes | — |

### 2.7 Sessions (cc_sessions)

| Button text         | Callback data   | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|---------------------|-----------------|--------|-----------------|---------|------------|-----------|--------------------|
| Full list (next 20) | `sess_list:20`  | on_callback | "Sessions (offset N):" + 20 lines + [Next 20] (if more) [« Back] | session_full_list() | Paginate full list | Yes | — |
| Session → Bot map   | `sess_map`      | on_callback | "Session → Bot" + up to 30 lines "file → bot_name" + [« Back] | session_to_bot_map() | See assignment | Yes | — |
| Manage Sessions     | `manage_sessions`| on_callback | Manage Sessions screen (counts + Add/Remove) | load_adbot, _session_counts | Go to add/remove | Yes | — |
| « Back              | `control_center`| on_callback | Control Center | — | Back | Yes | — |

### 2.8 Broadcast

| Button text   | Callback data     | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|---------------|-------------------|--------|-----------------|---------|------------|-----------|--------------------|
| All Users     | `bc_target:all_users`  | on_callback | "Target: All Users (Shop Bot)\nRecipients: N\n\nSend the broadcast message… Or /cancel to cancel." | broadcast_recipients_all_users(), user_data | Set target | Yes | N shown. |
| Plan Users    | `bc_target:plan_users` | on_callback | Same with "Plan Users (assigned bot per user)" | broadcast_recipients_plan_users() | Set target | Yes | N shown. |
| Cancel        | `bc_cancel`       | on_callback | "Broadcast cancelled." + [« Back] | _broadcast_clear | Abort | Yes | — |
| Send          | `bc_send`         | on_callback | After user sent message: runs broadcast; then new message "Broadcast Completed\n\nSent: X\nFailed: Y" | _run_broadcast, broadcast_log_append | Execute send | Yes | — |

### 2.9 Manage AdBots (list and per-bot)

| Button text              | Callback data    | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|--------------------------|------------------|--------|-----------------|---------|------------|-----------|--------------------|
| (Bot name)               | `adb_sel:<i>`    | on_callback | "*Name* - Last activity: Xs ago\nActions:" + Validate, Replace dead/error, Recreate log group, Suspend/Resume, Force restart, Transfer ownership, Delete, Back to list | get_bot_last_activity_ts, load_adbot | Open per-bot actions | Yes | Could show state (running/stopped). |
| Back                     | `adb_back`       | on_callback | "Admin menu:" + main menu | — | Exit manage bots | Yes | — |
| Back to list             | `adb_backlist`   | on_callback | "Manage AdBots - pick one:" + list + [Back] | load_adbot | Return to bot list | Yes | — |
| Validate this bot sessions| `adb_val:<i>`    | on_callback | "Validating..." then "Validate: X ok, Y moved to dead." + [Back to list] | _admin_validate_sessions, save_adbot | Validate sessions | Yes | — |
| Replace dead sessions    | `adb_rep:<i>`    | on_callback | "Replacing dead sessions..." then result message + [Back to list] | _admin_replace_dead, save_adbot | Replace dead | Yes | — |
| Replace error sessions   | `adb_repe:<i>`   | on_callback | "Replacing error sessions..." then result + [Back to list] | _admin_replace_error_sessions, save_adbot | Replace error | Yes | — |
| Recreate log group       | `adb_rec:<i>`    | on_callback | "Recreating log group..." then result + [Back to list] | _admin_recreate_log_group, save_adbot | New log group | Yes | — |
| Suspend                  | `adb_suspend:<i>`| on_callback | "Suspended" + [Back to list] | user_set_suspended(token, True), submit_main_loop_job("stop_posting"), log_admin_action | Suspend bot | Yes | — |
| Resume                   | `adb_resume:<i>` | on_callback | "Resumed" + [Back to list] | user_set_suspended(token, False), log_admin_action | Resume bot | Yes | — |
| Force restart            | `adb_restart:<i>`| on_callback | "Restart requested for Name. The main loop will stop and start posting shortly." + [Back to list] | submit_main_loop_job("restart_bot") | Restart bot | Yes | — |
| Transfer ownership       | `adb_transfer:<i>`| on_callback | "Send the new owner Telegram user ID (numeric):" + [Cancel] | user_data adb_transfer_token | Start transfer flow | Yes | — |
| Delete this AdBot        | `adb_del:<i>`    | on_callback | "Delete *Name*? Choose what to do with its sessions:" + [Move sessions to free] [Mark sessions dead] [Cancel] | user_data adb_delete_* | Confirm delete | Yes | — |
| Move sessions to free    | `adb_dfree:<i>`  | on_callback | "Deleting AdBot... I'll update this message when done." | submit_main_loop_job("delete_bot", …, "free") | Delete, sessions → free | Yes | — |
| Mark sessions dead       | `adb_ddead:<i>`  | on_callback | Same | submit_main_loop_job("delete_bot", …, "dead") | Delete, sessions → dead | Yes | — |

### 2.10 Pending orders / shop

| Button text        | Callback data        | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|--------------------|----------------------|--------|-----------------|---------|------------|-----------|--------------------|
| Order X — Recreate | `shop_recreate:<id>` | on_callback | "Recreate submitted for order X..." or "Recreate failed: msg" + [Back] | recreate_pending_order(order_id) | Re-run creation | Yes | — |
| Back               | `adb_back`           | on_callback | Main menu | — | Back | Yes | — |

### 2.11 Order actions (from /order_* reply)

| Button text   | Callback data              | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|---------------|----------------------------|--------|-----------------|---------|------------|-----------|--------------------|
| Mark paid     | `order_act:<id>:mark_paid` | on_callback | Result message + [« Orders] | order_mark_paid, log_admin_action | Mark order paid | Yes | — |
| Cancel order  | `order_act:<id>:cancel`    | on_callback | Result + [« Orders] | order_cancel, log_admin_action | Cancel order | Yes | — |
| Re-run creation | `order_act:<id>:rerun`   | on_callback | msg or "Failed: msg" | recreate_pending_order, log_admin_action | Re-run creation | Yes | — |
| « Orders      | `cc_orders`                | on_callback | Control Center Orders screen | — | Back to orders | Yes | — |

### 2.12 Fix menu (/fix)

| Button text     | Callback data   | Handler | What admin sees | Backend | Why exists | Placement | More useful data? |
|-----------------|-----------------|--------|-----------------|---------|------------|-----------|--------------------|
| (Bot name)      | `fix_sel:<i>`   | on_callback | "Repair menu for *Name*:" + Fix Log Group, Fix Sessions, Fix Config, Fix Bot Token, Cancel | user_data fix_bot_* | Select bot for repair | Yes | — |
| Cancel          | `fix_cancel`    | on_callback | "Cancelled." + main menu | clear fix_* state | Abort fix | Yes | — |
| Fix Log Group   | `fix_log`       | on_callback | "Fixing log group…" then result + [Back] | repair_fix_log_group | Fix log group | Yes | — |
| Fix Sessions    | `fix_sess`      | on_callback | "Checking sessions…" then "Sessions (select to replace):" list + [Back] or error + [Back] | repair_fix_sessions | List sessions for replace | Yes | — |
| Fix Config      | `fix_cfg`       | on_callback | "Fixing config…" then result + [Back] | repair_fix_config | Fix config | Yes | — |
| Fix Bot Token   | `fix_tok`       | on_callback | "Send the new bot token…" + [Cancel] | user_data fix_wait_token | Start token replacement | Yes | — |
| Back            | `fix_back`      | on_callback | Repair menu for *Name* (same as after fix_sel) | — | Back to repair menu | Yes | — |
| (session line)  | `fix_sess:<idx>`| on_callback | "Session fn — status. Replace?" + [Replace] [Cancel] | user_data fix_sess_* | Choose session to replace | Yes | — |
| Replace         | `fix_sess_rep`  | on_callback | "Replacing…" then result + [Back] | repair_replace_session | Replace one session | Yes | — |
| Cancel (sess)   | `fix_sess_back` | on_callback | Repair menu for *Name* | — | Back to repair menu | Yes | — |

---

## 3. Command behavior mapping

| Command | Handler | UI output shown to admin | Backend action | Related inline buttons generated | Duplicates menu? |
|---------|---------|---------------------------|----------------|-----------------------------------|-------------------|
| /start | cmd_start | "Admin menu:" | _clear_create_state; load_adbot not used for menu | Control Center, Create AdBots, Manage AdBots, Manage Sessions, Pending Orders | No; menu is the main entry. |
| /cmd | cmd_cmd | Markdown list of all admin commands and "Actions (via menu)" | None | None | No; help only. |
| /health | cmd_health | "*Health overview*" + per-bot lines (name, state, valid, sessions ok/dead, workers) + optional dead_reason + "*Recent alerts*" (last 10) | load_adbot, _workers_alive, config paths | None | Partially: Dashboard shows aggregates; /health shows per-bot detail. Complementary. |
| /cpu | cmd_cpu | First: "Checking CPU, RAM…" then replaced by _get_system_stats lines (CPU, RAM, disk, uptime, connectivity) | _get_system_stats (admin.py) | None | No; no menu equivalent for raw system stats. |
| /logs | cmd_logs | "Collecting log files…" then "Sending N log file(s)…" then documents (adbot.log + bots/*.log) | LOGS_DIR scan, send_document | None | No; no menu equivalent. |
| /fix | cmd_fix | If no arg: "Select AdBot to repair:" + bot list + [Cancel]. If arg: "Repair menu for *Name*:" + Fix Log Group/Sessions/Config/Token/Cancel. If not found: "AdBot 'X' not found." | load_adbot, load_index, name_to_filename; user_data fix_list/fix_bot_* | fix_sel:i, fix_cancel, or fix_log/fix_sess/fix_cfg/fix_tok/cancel | Yes: same repair flow as Manage AdBots → pick bot → actions; /fix is alternate entry (with optional bot name). |
| /order_id | cmd_order_id | "Use: /order_id <order_id>" if no args; else order details + [Mark paid] [Cancel order] [Re-run creation] [« Orders] as applicable | _orders_search(order_id=) | order_act:id:mark_paid/cancel/rerun, cc_orders | Yes: Pending Orders and cc_orders point to pending list; /order_* is search by id/payment/user. |
| /order_payment | cmd_order_payment | Same pattern for payment_id | _orders_search(payment_id=) | Same | Yes (order actions). |
| /order_user | cmd_order_user | Same pattern for user_id | _orders_search(user_id=) | Same | Yes (order actions). |
| /user_id | cmd_user_id | "Use: /user_id <telegram_id>" or "User U — N bot(s):" with @username, name, valid, suspended, frozen | user_search_by_telegram_id | None | Partially: cc_users only signposts commands; no menu list. |
| /user_bot | cmd_user_bot | "Use: /user_bot @username" or "Bot: @…, Name, Valid till, Authorized" | user_search_by_bot_username | None | Same. |
| /user_plan | cmd_user_plan | "Use: /user_plan <plan_name>" or "Plan \"X\" — N bot(s):" list | user_search_by_plan_type | None | Same. |
| /user_extend | cmd_user_extend | "Use: /user_extend @bot_username <days>" or result of user_extend_plan | user_extend_plan, log_admin_action | None | No menu equivalent. |
| /user_freeze | cmd_user_freeze | "Use: /user_freeze @bot_username on|off" or result of user_freeze | user_freeze, log_admin_action | None | No menu equivalent. |
| /dashboard | cmd_dashboard | "Dashboard" + bots/sessions/orders/workers lines + [Refresh] [Control Center] | dashboard_counts() | cc_dashboard_refresh, control_center | Yes: same as Control Center → Dashboard. |
| /dashboard_refresh | cmd_dashboard | Same as /dashboard | Same | Same | Yes. |
| /cancel | cmd_cancel | "Cancelled." | _clear_create_state, clear add_sessions, fix_wait_token, adb_transfer, broadcast | None | No; cancels any in-progress flow. |

---

## 4. Structural UX findings

### Duplicate controls
- **Dashboard:** Reachable by /dashboard, /dashboard_refresh, and Control Center → Dashboard. Same data and Refresh button. Intentional: command for quick access, menu for discovery.
- **Manage AdBots:** Reachable from main menu and from Control Center → Bots. Same list and actions. Intentional: hub shortcut.
- **Pending Orders / pending_creation list:** Reachable by Control Center → Orders → "Pending creations" and by main menu "Pending Orders." Same list. Intentional: main menu for operational visibility.
- **Repair (Fix):** /fix with optional bot name leads to same repair menu as Manage AdBots → bot → (Validate, Replace, Recreate log, etc.). Fix menu is repair-focused (log group, sessions, config, token); Manage AdBots has more (suspend, delete, transfer). Overlap on session/config repair; not fully duplicated.

### Missing navigation items
- **Session list from Manage Sessions:** Manage Sessions shows only counts and Add/Remove. Full session list (and Session → Bot map) is under Control Center → Sessions. Admin looking for "sessions" may go to Manage Sessions first and not see the list (see Section 5).
- **Broadcast:** No /broadcast command; only Control Center → Broadcast. Documented in BROADCAST_AUDIT; by design.
- **Fix (repair) on main menu:** No button; only /fix. By design per code comment.

### Misplaced or buried features
- **Session list:** Logically fits "Manage Sessions" but lives under Control Center → Sessions. So "manage" is add/remove; "view list" is under a different top-level entry (Control Center). Can confuse admins who expect "manage" to include "list."
- **Order search:** Only via /order_id, /order_payment, /order_user. Control Center → Orders only explains commands and shows "Pending creations." No inline "Search by ID" that opens a prompt or submenu. Power users get commands; others may not discover search.
- **User search:** Same: only /user_* commands; Control Center → Users only documents them. No inline search.

### Features reachable only by command (no UI)
- /cpu (system stats)
- /logs (send log files)
- /order_id, /order_payment, /order_user (order search)
- /user_id, /user_bot, /user_plan (user search)
- /user_extend, /user_freeze (extend validity, freeze bot)
- /fix (repair entry; repair actions also reachable from Manage AdBots for some operations)

### Buttons that are not redundant and appear necessary
- All main-menu and Control Center buttons serve distinct purposes.
- Fix menu buttons are repair-specific; Manage AdBots has broader per-bot actions. Both are used.

---

## 5. Sessions management evaluation

### Why Manage Sessions shows only Add Sessions and Remove Sessions
- **Design:** "Manage Sessions" is implemented as the place to **change** the pool: add (upload) or remove (delete) session files. The screen text is the summary line: `Total sessions: t | Dead: d | Assigned: a | Free: f`. So the menu answers "how many" and "add/remove," not "which sessions exist and where."
- **Intent:** Add and Remove are the only actions that modify the session pool from this screen. Listing is treated as an overview function and placed under Control Center.

### Existing backend method to list sessions
- **session_full_list()** in `admin_control.py`: returns a list of `{file, status, bot_name}` for all sessions (free, dead, frozen, assigned). Uses `load_pool()` and `load_adbot()`.
- **session_to_bot_map()**: returns `(session_file, bot_name)` for assigned sessions.

### Why a "Session List" button is missing from Manage Sessions
- Session list is implemented under **Control Center → Sessions** (`cc_sessions`): it shows "Sessions: N total. Map: M assigned." plus the first 20 entries, with buttons "Full list (next 20)," "Session → Bot map," "Manage Sessions," "« Back." So listing was added to the Control Center hub, not to the Manage Sessions screen. No separate "Session List" button was added to Manage Sessions; the only link from Manage Sessions to the list is indirectly via Control Center → Sessions.

### Where session listing is implemented
- **Control Center → Sessions** (`cc_sessions` callback): calls `session_full_list()` and `session_to_bot_map()`, shows first 20 sessions, then "Full list (next 20)" (`sess_list:20`) and "Session → Bot map" (`sess_map`). So the only place the full list and map are shown in the UI is Control Center → Sessions.

### Recommendation (analysis only; no code changes)
- **Integrate session listing into Manage Sessions:** Yes, for UX consistency.
  - **Reason:** Admins often think "sessions" → "Manage Sessions." Finding only counts and Add/Remove, they may not know the list lives under Control Center → Sessions. Adding a "View session list" (or "Full list") button on Manage Sessions that either (a) navigates to the same view as Control Center → Sessions (e.g. same message and buttons), or (b) shows the same list inline on Manage Sessions (e.g. summary + first N + "More in Control Center → Sessions"), would align expectations and reduce navigation.
  - **Optional:** A "View list" button that replaces the current message with the cc_sessions content (and "« Back" to Manage Sessions) reuses existing logic and keeps one source of truth for the list.
- **Move session list to Manage Sessions only:** Not recommended; Control Center → Sessions is a good overview for "system state" and should keep the list. Better to add a link or list on Manage Sessions that points to or repeats that view.
- **Backend:** No change needed; `session_full_list()` and `session_to_bot_map()` already exist. Only UI wiring (e.g. one more button or navigation path from Manage Sessions to the same list view) would address the gap.

---

## 6. Summary

- **/start:** Five buttons (Control Center, Create AdBots, Manage AdBots, Manage Sessions, Pending Orders); each has a clear purpose; none redundant. Fix and Broadcast are intentionally command or hub-only.
- **Inline buttons:** All mapped above with handler, admin-facing message, backend effect, and UX note. Placement is generally logical; main gap is session list not reachable from Manage Sessions.
- **Commands:** 17 commands documented; /dashboard and /health overlap with menu; order/user search and extend/freeze are command-only; /fix overlaps with Manage AdBots for repair-style actions.
- **Structure:** Some duplication is intentional (Dashboard, Manage AdBots, Pending Orders). Session list lives only under Control Center → Sessions; Manage Sessions could expose it for better discoverability.
- **Sessions:** Manage Sessions = counts + Add/Remove. Listing is implemented in backend and UI under Control Center → Sessions; adding a "Session list" entry point from Manage Sessions would improve UX without requiring new backend logic.
