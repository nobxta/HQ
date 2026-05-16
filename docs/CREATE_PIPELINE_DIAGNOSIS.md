# AdBot Creation Pipeline — Runtime Diagnosis & Messaging Audit

## 1. Pipeline trace (shop + admin)

### Shop purchase flow

1. **Payment confirmed** → Payment worker (temppay or orders loop) sets order `status=paid`, `awaiting_field=proceed`, stores `tx_hash`/`network` in order; edits payment message to **Transaction Confirmation** screen (HTML, [Proceed]).
2. **User presses Proceed** → Handler `shop_proceed_setup:{order_id}` sets `awaiting_field=name`, sends STEP5 (name) with premium emoji.
3. **User sends name** → Handler sets `awaiting_field=token`, sends STEP6 with premium emoji.
4. **User sends token** → Handler validates token, builds `form`, sends **“Creating your AdBot…”** with `progress_msg = await update.message.reply_text(text, entities=entities)` (rocket emoji), then:
   - `submit_create_job(chat_id, progress_msg.message_id, form, notification_bot_token=config.SHOP_BOT_TOKEN)`
5. **submit_create_job** → Creates `progress_queue`, starts `_progress_consumer_ptb(progress_queue, notification_bot_token)`, puts `(chat_id, msg_id, form, progress_queue)` on `_create_job_queue`. Logs: `[CREATE_PIPELINE] submit_create_job called chat_id=... msg_id=... order_id=... queue_size=...`
6. **_create_worker_loop** (background thread) → `job = _create_job_queue.get(timeout=60)`. If maintenance: re-put job, sleep 30, continue. Else: idempotency check (skip if order already completed/creating), then `with creation_pool_lock: load_adbot(); _sync_execute_create_adbot(chat_id, msg_id, form, adbot_data, progress_queue)`.
7. **_sync_execute_create_adbot** → Defines `log_async(msg)` that does `progress_queue.put((chat_id, msg_id, msg))`. Runs `_core_create_adbot_async(form, adbot_data, log_async)`. On exit puts `progress_queue.put(None)`.
8. **_core_create_adbot_async** → Emits: "Starting AdBot setup…", "Configuring bot profile…", "Assigning sessions…", "Creating log group…", "Finalizing setup…", "AdBot successfully created: @...". Each `await log_async(msg)` pushes `(chat_id, msg_id, msg)` to progress_queue.
9. **_progress_consumer_ptb** → Consumes `(chat_id, msg_id, msg)`. If `chat_id` or `msg_id` is 0, skips. Else: for **Shop** (`notification_bot_token` set), builds `(progress_text, progress_entities) = build_emoji_message(msg, "rocket")` and calls `notify_edit_message(chat_id, msg_id, progress_text, entities=progress_entities, bot_token=...)`; for admin, `notify_edit_message(..., parse_mode=None, bot_token=...)`. Stops on `None`.
10. **Worker** → Puts `(chat_id, msg_id, username, form)` on `_result_queue` (username or None).
11. **_result_consumer_ptb** → Gets result, updates order status if success, starts user bot, calls `notify_edit_message(chat_id, msg_id, SUCCESS_ACTIVATED_MESSAGE or failure/queue msg, ...)`. Only edits when `chat_id and msg_id` (skips 0,0).

### Persistence chain

- **User JSON:** `config.DATA_USER_DIR / f"{safe_name}.json"` → **data/user/<name>.json** (not data/users). Written in `_core_create_adbot_async` via `save_user_data(safe_name, entry)`.
- **index.json:** `config.DATA_INDEX_FILE` (data/index.json). Updated in create flow: `index["by_token"][bot_token] = safe_name`, `index["by_name"][safe_name] = bot_token`; then `save_index(index)`. Rollback on save_index failure: unlink user file, restore pool free_sessions.
- **pool.json:** `config.DATA_POOL_FILE` (data/pool.json). Updated: `pool["free_sessions"]`, `pool["dead_sessions"]` from adbot_data; `save_pool(pool)` before save_user_data.

### Order status transitions

- **waiting** (payment_waiting) → **confirming** (payment detected) → **paid** (amount confirmed) → **creating** (job started) → **completed** or **failed** / **pending_creation** (insufficient sessions). Shop worker does not set "creating" and leave it stuck: worker sets "creating" and then on completion/failure the result consumer sets "completed" or "failed".

---

## 2. Where the pipeline can stop

| Stop point | Cause | Fix location |
|------------|--------|---------------|
| Job never consumed | Worker threads not started | `admin.py`: `_start_create_worker_if_needed()`; ensure main calls it (e.g. on startup / when first job submitted). |
| Worker blocked by lock | Long hold of `creation_pool_lock` (load_adbot + full create) | Expected: one creation at a time per lock. If deadlock: ensure no code holds lock while awaiting I/O. |
| Worker deferred | Maintenance mode | `admin.py` worker loop: re-puts job and sleeps 30s. Disable maintenance or wait. |
| Progress not updating | Progress consumer not started, or chat_id/msg_id=0 | `admin_ptb.py`: `submit_create_job` starts `_progress_consumer_ptb`. Consumer skips (0,0). Shop/reconciliation must pass real (chat_id, msg_id). |
| Result not applied | Result consumer not running or exception | `admin_ptb.py`: `_result_consumer_ptb` must be started from main (e.g. `asyncio.create_task(_result_consumer_ptb())`). Exceptions in consumer are now logged; ensure loop continues. |
| Edit fails (wrong bot / bad msg) | Wrong bot_token or message deleted | Use correct `notification_bot_token` for shop. Logs: `[CREATE_PROGRESS] consumer edit failed`. |

---

## 3. Messaging layer audit

### Functions that must forward entities and **kwargs

| Function | Status |
|----------|--------|
| **notify_edit_message** | ✅ `(chat_id, message_id, text, **kwargs)` → `edit_message_with_bot(..., **kwargs)`. |
| **edit_message_with_bot** | ✅ Pops `bot_token` from kwargs, forwards rest to `bot.edit_message_text(**payload)`. |
| **notify_send_to_chat** | ✅ `(chat_id, text, **kwargs)` → `send_message_with_bot(..., **kwargs)`. |
| **send_message_with_bot** | ✅ Forwards **kwargs to `send_message_with_bot_return_id`. |
| **send_message_with_bot_return_id** | ✅ Pops `bot_token`, forwards remaining kwargs to `bot.send_message(**payload)`. So `parse_mode`, `entities`, `disable_web_page_preview` are passed. |

None of these strip or ignore `parse_mode`, `entities`, or `disable_web_page_preview`.

- **send_log_message** (bot_ptb): Accepts `**kwargs`; merges into payload and forwards to `bot.send_message` (so `entities`, `disable_web_page_preview`, etc. work).
- **send_admin_dm_alert** (bot_ptb): Accepts `**kwargs`; merges into payload and forwards to `bot.send_message` (admin notifications can use custom emoji entities).

### Helper for custom emoji

- **build_custom_emoji_text(text_with_placeholders, emoji_positions)** in `code/ui/emoji_entities.py`: builds `(text, entities)` for multiple custom emojis at given offsets. `emoji_positions` is a list of `(offset, emoji_key)`; text must contain `PLACEHOLDER` at each offset.
- **build_emoji_message(label, emoji_key)** unchanged: single leading emoji (placeholder + label).

---

## 4. Premium emoji usage

- **CUSTOM_EMOJIS** in `code/ui/emojis.py` updated with IDs from .env (cart, rocket, error, telegram_gear, white_dot, clock, red_alert, red_cross, green_tick, sand_timer, dollar, arrow, black_dot, gears, golden_dot, scanning, etc.).
- **Shop payment confirmation:** Uses `build_payment_confirmation_screen` → `build_emoji_message(..., "payment_confirmed")` (green tick). Sent with `parse_mode="HTML"`, `entities=...`, `disable_web_page_preview=True`.
- **Creation progress (Shop):** `_progress_consumer_ptb` uses `build_emoji_message(msg, "rocket")` and passes `entities` to `notify_edit_message`.
- **Broadcast / admin:** Use `notify_send_to_chat` / `notify_edit_message` with **kwargs; callers can pass `entities` where needed.

---

## 5. Diagnostic logging added

- **submit_create_job:** Logs `chat_id`, `msg_id`, `order_id`, `queue_size` (after put).
- **Worker loop:** Logs job start (order_id, chat_id, msg_id); maintenance deferral; skip (already completed/creating); acquisition/release of `creation_pool_lock` (debug); result queued.
- **Progress consumer:** Logs skip when chat_id/msg_id=0; logs each edit (chat_id, msg_id, ok, msg_preview); logs edit failure.
- **Result consumer:** Logs start; logs each received result (chat_id, msg_id, username, order_id); logs success edit and edit failure.

---

## 6. "already_creating" diagnostic (root cause and fix)

### Where the decision is made

- **File:** `code/admin.py`  
- **Location:** Inside `_create_worker_loop()`, in the idempotency block that runs when `order_id` is present (after `get_order(order_id)`).  
- **Exact logic:** If `order.get("status") == "creating"`, the worker logs `[CREATE_PIPELINE] worker skipping (already_creating) order_id=...`, sets `form["_result_reason"] = "already_creating"`, puts the result on `_result_queue`, and `continue`s — so it never runs creation.

### Why it triggered for new creation attempts

The **shop handler** (and the rerun flow) set order status to **"creating"** in **orders.json** **before** calling `submit_create_job()`:

- `code/shop/handlers.py` (main flow): `update_order_status(order_id, "creating")` then `submit_create_job(...)`.
- `code/shop/handlers.py` (`recreate_pending_order`): same pattern.

So the sequence was:

1. User sends token → handler sets `order.status = "creating"` in orders.json.
2. Handler calls `submit_create_job(...)` → job is put on `_create_job_queue`.
3. Worker gets the job, loads the order, sees `status == "creating"` (set by the handler).
4. Worker assumes another worker is already handling it and skips with "already_creating".

So the worker never ran creation; the flag was set too early and by the wrong place (handler instead of worker).

### What controls the flag

- **Storage:** `orders.json` (order `status` and, after fix, `creating_since`).
- **Set by:** Previously the shop handler and `recreate_pending_order`; now only the worker when it actually starts (with `creating_since=now`).
- **Cleared / transitioned:** On success → result consumer sets `completed`; on failure → `failed`; on startup recovery (workers.py) `creating` → `failed`; on stale recovery (worker) `creating` → `pending_creation` then worker sets `creating` again and runs.

### Minimal patch applied

1. **Do not set "creating" in the handler**  
   - **File:** `code/shop/handlers.py`  
   - Removed `update_order_status(order_id, "creating")` before `submit_create_job` in both the main token-handler flow and in `recreate_pending_order`.  
   - Only the worker now sets `"creating"` when it passes the idempotency check and is about to run.

2. **Worker sets "creating" with timestamp**  
   - **File:** `code/admin.py`  
   - When the worker sets status to "creating", it now passes `creating_since=datetime.utcnow().isoformat() + "Z"` so we can detect stuck orders.

3. **Stale "creating" recovery**  
   - **File:** `code/admin.py`  
   - If `order.status == "creating"`: if `creating_since` is present and &lt; 5 minutes old, skip (already_creating). If missing or older than 5 minutes, treat as stuck: `update_order_status(order_id, "pending_creation")` and fall through so the worker then sets "creating" again and runs.  
   - **File:** `code/shop/storage.py`  
   - Allowed transition `creating` → `pending_creation` in `ORDER_STATUS_TRANSITIONS` for this recovery.

Result: jobs always run when no active creation is actually in progress; only genuinely concurrent or recent "creating" is skipped; stuck "creating" is auto-reset after 5 minutes.

---

## 7. Recommended checks if pipeline stops

1. **Jobs not consumed:** Confirm `_create_worker_if_needed()` is called and worker threads are alive; check logs for `[CREATE_PIPELINE] job→worker started`.
2. **Progress not updating:** Confirm `[CREATE_PROGRESS] consumer edited` for the same chat_id/msg_id as the buyer’s progress message; confirm no `consumer skipping edit (chat_id=0 msg_id=0)` for shop.
3. **Result not updating:** Confirm `_result_consumer_ptb` is running and logs `result_consumer received`; then `result_consumer notify_edit_message success` or the warning on failure.
4. **Lock stuck:** If logs show "acquiring creation_pool_lock" but not "released", the create workflow or save inside the lock may have hung or raised; check for unhandled exceptions in `_sync_execute_create_adbot` / `_core_create_adbot_async`.
5. **Still seeing "already_creating":** Ensure no code path sets `order.status = "creating"` before `submit_create_job`. Only the worker should set it (with `creating_since`). If an order was stuck from before the fix, wait 5 min or restart; worker will reset it to `pending_creation` and run.
