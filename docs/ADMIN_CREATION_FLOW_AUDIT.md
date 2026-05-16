# Admin Bot Creation Flow — End-to-End Audit Report

**Date:** 2026-02-13  
**Scope:** Admin-initiated AdBot creation (wizard → job queue → worker → persistence → notifications).  
**No code changes; analysis only.**

---

## 1. Creation Flow Diagram (Step-by-Step)

```
[Admin] /start → Main menu
    ↓
[Admin] Create AdBots (callback_data="create_adbots")
    ↓
[Bot] "Proceed to create a new AdBot?" [Proceed] [Cancel]
    ↓
[Admin] Proceed (callback_data="create_proceed")
    ↓  (check: free_sessions > 0 else abort)
[Bot] "Enter internal name (e.g. buyer2)"  →  create_step="name", create_data={}
    ↓
[Admin] sends text  →  name stored, create_step="sessions_count"
[Bot] "Sessions count (1–N, max M per bot)"
    ↓
[Admin] sends number  →  sessions_count, create_step="cycle"
[Bot] "Cycle time (seconds, min 300)"
    ↓
[Admin] sends number  →  cycle, create_step="gap"
[Bot] "Gap (seconds)"
    ↓
[Admin] sends number  →  gap, create_step="bot_token"
[Bot] "Send bot token"
    ↓
[Admin] sends token  →  validate_bot_token(); bot_token + bot_username stored, create_step="valid_till"
[Bot] "Valid till (dd/mm/yyyy)"
    ↓
[Admin] sends date  →  valid_till, create_step="renewal_price"
[Bot] "Renewal price (USD)"
    ↓
[Admin] sends number  →  renewal_price, create_step="mode"
[Bot] "Mode:" [Starter] [Enterprise]
    ↓
[Admin] clicks mode  →  mode, create_step="group_file"
[Bot] "Choose group file:" (list from groups/*.txt)
    ↓
[Admin] clicks gf:filename  →  group_file, create_step="summary"
[Bot] Summary + "Proceed?" [Proceed] [Cancel]
    ↓
[Admin] Proceed (callback_data="create_final")
    ↓  _clear_create_state(); send "Create queued. I'll update this message when done."
    ↓  Check: free_sessions > 0, bot_token not already in adbot_data["bots"]
    ↓
submit_create_job(chat_id, msg_id, form)
    ↓
_start_create_worker_if_needed()  →  start up to MAX_CONCURRENT_CREATE_JOBS threads
asyncio.create_task(_progress_consumer_ptb(progress_queue, None))
_create_job_queue.put((chat_id, msg_id, form, progress_queue))
    ↓
[Worker thread] _create_worker_loop()
    ↓
job = _create_job_queue.get(timeout=60)
if maintenance → put job back, sleep 30, continue
if order_id:
    order = get_order(order_id)
    if status=="completed" → _result_queue.put(success), continue
    if status=="creating" → _result_queue.put(already_creating), continue
    update_order_status(order_id, "creating")
adbot_data = load_adbot()   ← snapshot of pool + index + bots
username = _sync_execute_create_adbot(chat_id, msg_id, form, adbot_data, progress_queue)
_result_queue.put((chat_id, msg_id, username, form))
    ↓
[Inside _sync_execute_create_adbot]
  loop = asyncio.new_event_loop()
  username = loop.run_until_complete(_core_create_adbot_async(form, adbot_data, log_async))
  progress_queue.put(None)
  loop.close()
    ↓
[Inside _core_create_adbot_async]
  Duplicate token check: get_name_by_token(bot_token) → if exists, return None
  Validate group file (warn if missing/empty)
  "Setting bot profile" (Telethon bot client, UpdateProfileRequest)
  "Assigning sessions" — iterate adbot_data["free_sessions"], validate_session(), assign up to sessions_count
    (mutate adbot_data["free_sessions"], optionally move invalid to dead_sessions)
  If assigned < sessions_count → save_adbot(adbot_data), return None (insufficient_valid_sessions)
  "Creating log group" — try each assigned session until one creates megagroup, set username
  Invite bot to log group, EditAdmin
  "Joining all assigned sessions to log group"
  Build entry (name, bot_token, sessions, authorized, state=stopped, plan, etc.)
  save_user_data(safe_name, entry)
  index["by_token"][bot_token]=safe_name, index["by_name"][safe_name]=bot_token
  save_index(index)
  pool["free_sessions"] = adbot_data["free_sessions"], save_pool(pool)
  add_admin_alert("bot_created", ...)
  return f"@{bot_username}"
    ↓
[Main loop] _result_consumer_ptb()
_result_queue.get()  →  (chat_id, msg_id, username, form)
if username:
  create_user_bot(bot_token)  (asyncio.create_task)
  if order_id: update_order_status(order_id, "completed", created_bot_username=..., bot_token=...)
  notify_edit_message(chat_id, msg_id, SUCCESS_ACTIVATED_MESSAGE or "Bot created: @...")
  (Shop: optional admin DM with order summary)
else:
  if order_id and reason==insufficient_valid_sessions: update_order_status(order_id, "pending_creation"); alert; notify user
  else: notify_edit_message(chat_id, msg_id, FAILURE_...)
```

---

## 2. Functions / Files Involved

| Layer | File | Function / Role |
|-------|------|------------------|
| **Admin UI** | `code/admin_ptb.py` | `on_callback`: create_adbots, create_proceed, mode:starter/enterprise, gf:*, create_final. `on_message`: create_step name → sessions_count → cycle → gap → bot_token → valid_till → renewal_price → mode (then callback group_file → summary). `_clear_create_state`, `submit_create_job`, `_progress_consumer_ptb`, `_result_consumer_ptb`. |
| **Job submit** | `code/admin_ptb.py` | `submit_create_job(chat_id, msg_id, form, notification_bot_token=None)`: starts worker if needed, creates progress_queue, spawns `_progress_consumer_ptb`, puts `(chat_id, msg_id, form, progress_queue)` on `_create_job_queue`. |
| **Shop-triggered** | `code/shop/handlers.py` | `recreate_pending_order` / paid-order flow: build form (order_id, source=shop, user_id), `submit_create_job(user_id, msg_id, form, SHOP_BOT_TOKEN)`. |
| **Reconciliation** | `code/shop/workers.py` | `run_payment_reconciliation`: finds paid orders with no created bot, builds form, `_create_job_queue.put((0, 0, form, _q.Queue()))` (no progress consumer for chat_id=0). |
| **Queue / worker** | `code/admin.py` | `_create_job_queue`, `_result_queue`. `_create_worker_loop()`: get job, maintenance check, order idempotency (completed / creating), `load_adbot()`, `_sync_execute_create_adbot()`, `_result_queue.put()`. `_start_create_worker_if_needed()`, `request_create_worker_restart()`. |
| **Core create** | `code/admin.py` | `_sync_execute_create_adbot()`: new event loop, `run_until_complete(_core_create_adbot_async(...))`, put None on progress_queue. `_core_create_adbot_async()`: duplicate token check, bot profile, session assignment from adbot_data["free_sessions"], validation, log group creation, join sessions, build entry, save_user_data, save_index, save_pool. |
| **Persistence** | `code/utils.py` | `load_adbot()` (pool + index + user files), `save_adbot()` (pool + bots to user files). `load_pool`, `save_pool` (atomic + lock). `load_index`, `save_index` (atomic + lock). `load_user_data`, `save_user_data` (atomic + lock). `name_to_filename`, `get_name_by_token`. |
| **Config** | `code/config.py` | `MAX_SESSIONS_PER_BOT`, `GROUPS_DIR`, `SESSIONS_ACTIVE`, `DATA_DIR`, `DATA_USER_DIR`, `DATA_POOL_FILE`, `DATA_INDEX_FILE`. |
| **Main** | `main.py` | `asyncio.create_task(_result_consumer_ptb())`; shop bot and payment workers started; create worker started via `_start_create_worker_if_needed()` when first job is submitted. |

---

## 3. Current Safeguards

- **Wizard pre-checks:** Before "Proceed", free_sessions count checked; if 0, creation aborted. Before "create_final", token uniqueness checked against current `adbot_data["bots"]`.
- **Duplicate token in worker:** At start of `_core_create_adbot_async`, `get_name_by_token(bot_token)` — if already registered, return None with message (no user file written).
- **Order idempotency:** If `order_id` present: status `completed` → push success and skip create; status `creating` → push already_creating and skip; else set status to `creating` then run create. Prevents double execution for same order.
- **Maintenance:** Worker checks `is_maintenance_enabled()`; if true, re-puts job and sleeps 30s (no creation during maintenance).
- **Session validation:** Each candidate session from `free_sessions` is checked with `validate_session(path)`; invalid ones removed from free and optionally added to dead_sessions.
- **Insufficient sessions:** If assigned count < requested, `save_adbot(adbot_data)` (to persist any free_sessions cleanup), then return None; result consumer can set order to `pending_creation` and notify.
- **Atomic writes:** `save_user_data`, `save_pool`, `save_index` use file lock and write-to-tmp-then-rename.
- **Progress and result:** Progress messages and final success/failure are sent via PTB (admin or shop bot); result consumer updates order and notifies user/admin.

---

## 4. Weak Points / Race Conditions

### 4.1 Session assignment race (critical)

- **What:** Up to `MAX_CONCURRENT_CREATE_JOBS` (2) worker threads can run at once. Each job does `adbot_data = load_adbot()` at the start of the loop, then passes this snapshot into `_sync_execute_create_adbot`. Session assignment in `_core_create_adbot_async` iterates `adbot_data["free_sessions"]` and mutates the same in-memory dict.
- **Effect:** Two jobs can both see the same initial `free_sessions` (e.g. [s1, s2, s3]) and both assign s1, s2. Both then call `save_user_data`, `save_index`, `save_pool`. The last writer wins for pool and index; both bots end up with the same sessions in their user JSON. So the same session can be assigned to two bots (duplicate assignment, undefined behavior at runtime).
- **No process-level lock** around “load pool → assign sessions → save” for creation.

### 4.2 Partial persistence failure

- **Sequence in worker:** `save_user_data(safe_name, entry)` → `save_index(index)` → `save_pool(pool)`.
- **If save_index fails:** User file exists but index does not reference it (orphan user file; bot not discoverable via index).
- **If save_pool fails:** User + index updated (sessions belong to new bot) but pool still has old `free_sessions` (those sessions still listed as free). A subsequent creation could assign the same sessions again.
- No rollback of earlier steps if a later step fails.

### 4.3 Token check window

- **Wizard** checks `form.get("bot_token") in adbot_data.get("bots", {})` at create_final using a fresh `load_adbot()`. **Worker** checks `get_name_by_token(bot_token)` at start of `_core_create_adbot_async`. Between the two, another creation (e.g. Shop order) could register the same token. Then the second job fails in the worker with “already linked” — correct outcome but user sees “Create queued” then failure. No functional corruption.

### 4.4 Restart during creation

- **If process dies after** `update_order_status(order_id, "creating")` **but before** `_result_queue.put` (e.g. during log group creation or persistence): order stays in `creating`, pool/index/user files may be mid-update (e.g. only user file written). On restart there is no automatic “creation in progress” detection for admin-initiated jobs (no order_id). For **Shop** orders, reconciliation or manual “Recreate” can re-queue; for admin-only creation, the bot may be half-created (user file + maybe index, pool not updated) and no job is re-queued automatically.
- **Create worker heartbeat:** Used by watchdog to restart the worker thread if stale; it does not persist “which job is running” or “which order_id is creating”.

### 4.5 Progress consumer and chat_id=0

- **Reconciliation** enqueues `(0, 0, form, _q.Queue())`. Progress queue has no consumer that uses that queue (progress_consumer is not started for that put). So progress messages for that job are dropped. Result is still consumed by `_result_consumer_ptb` (chat_id=0, msg_id=0); `notify_edit_message(0, 0, ...)` will not update a real message. So reconciliation-queued creations complete but the buyer/admin get no in-chat progress or final edit; they rely on other notifications (e.g. alert, or order status).

### 4.6 Double “Proceed” / double submit

- **State cleared** on create_final (`_clear_create_state`), then `submit_create_job` is called once. So the same wizard run cannot submit twice. If the admin clicks “Proceed” twice very fast, the second click might still see create_step "summary" and run the same block again (submit_create_job again). So two jobs with the same form (same token, same name) can be queued. First job creates the bot; second job hits duplicate-token in worker and fails. Outcome: one bot, one failure message. No duplicate bot; only duplicate failure UX.

---

## 5. Failure and Crash Scenarios — Current Behavior

| Scenario | Current behavior | Recovery / notes |
|----------|------------------|------------------|
| **Worker crash mid-creation** | Process exit; no _result_queue.put. Order (if any) stays `creating`. Pool/index/user: depends how far creation got (see partial persistence). | Shop: reconciliation or “Recreate” can re-queue. Admin-only: manual check; may need to fix pool/index/user and then create again or run integrity scan. |
| **Session shortage** | Worker assigns all valid free sessions; if count < requested, logs insufficient, save_adbot(adbot_data), returns None. Result consumer sets order to pending_creation (Shop) and notifies. | Admin adds sessions, then “Recreate” for that order. |
| **Duplicate bot token** | Wizard blocks if token already in current bots. Worker blocks with get_name_by_token. Second concurrent job fails in worker. | No duplicate bot; user sees failure. |
| **Concurrent admin creation jobs** | Both workers can load same free_sessions and assign overlapping sessions (see 4.1). | Risk of same session in two bots; integrity scan / manual fix. |
| **Server restart during creation** | Order (if Shop) remains `creating`. Persistence may be partial. No automatic re-queue for admin-initiated. | Reconciliation for Shop; admin-initiated requires manual inspection and possibly integrity scan + re-create. |
| **Invalid session (file missing / invalid)** | Worker removes from free_sessions, adds to dead_sessions in memory, continues with next; if not enough valid, returns None and save_adbot. | Correct; pool updated so invalid sessions not reused. |
| **Log group creation fails for all sessions** | log_async error, return None. No user/index/pool write. adbot_data free_sessions were already mutated (sessions “taken” in memory but not persisted to a bot). | Those sessions are still in the snapshot’s free_sessions when we return; we do not save_adbot(adbot_data) in that path, so pool is unchanged. So the same sessions remain in pool for next job — correct. |

---

## 6. Recommended Fixes (Summary)

1. **Session assignment under lock:** Serialize “load pool → assign sessions from free_sessions → update pool” (e.g. a dedicated lock or single-threaded creation worker) so two jobs never assign the same session. Option: single create worker thread, or a pool-assignment lock used only in the worker before load_adbot and released after pool update.
2. **Persistence ordering / rollback:** Consider saving in an order that minimizes orphan state (e.g. write pool first so free_sessions are updated, then index, then user), or implement a short rollback (e.g. remove from index and delete user file if save_pool fails). Alternatively, treat creation as a single “transaction” with a recovery script that can reconcile index vs user vs pool.
3. **Restart recovery:** For orders in status `creating` on startup, either auto re-queue creation (with idempotency) or mark them as failed and notify; optionally persist “creation in progress” (e.g. order_id) so restart can re-drive the same job.
4. **Reconciliation progress:** For reconciliation-queued jobs, either pass a real (chat_id, msg_id) and start a progress consumer, or document that progress is not shown and only result/alert is used.
5. **Double Proceed:** Ignore or disable the “Proceed” button after first click (e.g. set a “submitted” flag in user_data and show “Already submitted” on second click) to avoid duplicate failure messages.

---

**Conclusion:** The admin creation flow is well-structured (wizard → queue → worker → persistence → result consumer) and has meaningful safeguards (duplicate token, order idempotency, maintenance, atomic file writes). The main operational risk is **concurrent session assignment** leading to the same session in two bots; the next is **partial persistence** on save_index/save_pool failure. Addressing the session-assignment race (e.g. with a single creation worker or a pool lock) and clarifying persistence/recovery behavior would make the system robust for production.
