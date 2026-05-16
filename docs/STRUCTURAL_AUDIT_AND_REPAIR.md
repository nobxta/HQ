# Full Structural Audit & Repair Plan (Post-Migration)

**Scope:** Telethon → PTB migration. Telethon = user/account sessions only (posting, forwarding, joining, ad cycle). PTB = bot interface only (admin panel, menus, notifications, commands).

---

## 1. Bot Handler Mapping (python-telegram-bot)

### 1.1 Admin bot (PTB) — `code/admin_ptb.py`

| Handler type | Pattern / callback_data | Handler function | Registered? |
|--------------|-------------------------|------------------|-------------|
| Command | `/start` | `cmd_start` | ✅ Yes |
| Command | `/cmd` | `cmd_cmd` | ✅ Yes |
| Command | `/health` | `cmd_health` | ✅ Yes |
| Command | `/cpu` | `cmd_cpu` | ✅ Yes |
| Command | `/logs` | `cmd_logs` | ✅ Yes |
| Command | `/broadcast` | `cmd_broadcast` | ✅ Yes |
| Callback | (all) | `on_callback` | ✅ Yes |
| **Message** (text + document) | any message from user | `on_message` | ❌ **NO** |

**Broken:** `on_message` is **defined** (Create AdBot wizard text steps + Add Sessions file upload) but **never registered**. The app only does:

```python
app.add_handler(CommandHandler("start", cmd_start))
# ...
app.add_handler(CallbackQueryHandler(on_callback))
# MessageHandler is imported but never app.add_handler(MessageHandler(...))
```

**Effect:** Create AdBot wizard would stop after "Enter internal name" and Add Sessions would not receive documents if MessageHandler were not registered.

**Current status:** In the current codebase, `MessageHandler` **is** registered (two handlers: `filters.TEXT & ~filters.COMMAND` and `filters.Document.ALL`, both dispatching to `on_message`). So Create AdBot wizard and Add Sessions are wired. If you ever see only `CallbackQueryHandler` and no `MessageHandler`, add Patch 1 as below.

---

### 1.2 Callback_data vs handler (admin PTB)

All callback_data values used in `admin_ptb.py` are handled inside the single `on_callback` function. Mapping is consistent:

| callback_data | Handled in on_callback |
|---------------|------------------------|
| `create_adbots` | ✅ |
| `create_proceed`, `create_cancel` | ✅ |
| `mode:starter`, `mode:enterprise` | ✅ |
| `gf:<filename>` | ✅ |
| `create_final` | ✅ |
| `manage_sessions`, `add_sessions`, `cancel_add`, `back_sessions`, `remove_sessions` | ✅ |
| `del_f:<name>`, `del_d:<name>` | ✅ |
| `manage_adbots`, `adb_back`, `adb_sel:<i>`, `adb_backlist` | ✅ |
| `adb_val:<i>`, `adb_rep:<i>`, `adb_repe:<i>`, `adb_rec:<i>`, `adb_del:<i>` | ✅ |
| `adb_dfree:<i>`, `adb_ddead:<i>` | ✅ |

No mismatched or orphan callbacks in the admin PTB UI.

---

### 1.3 Per-AdBot user bot (Telethon) — `code/users.py`

The **user-facing** bot (Run, Stop, Set Message, Config, Status, Logs, Validity, Extend) is still **Telethon** (`TelegramClient` with `bot_token`). Callbacks use **bytes**: `CB_RUN`, `CB_STOP`, `CB_SET_MSG`, etc. All are handled in the same Telethon callback handler (`event.data == CB_*` / `raw.startswith(PREFIX_*)`). No migration to PTB for this layer; no duplicate handlers.

---

## 2. Telethon bot handlers — leftover / duplication

- **Admin:** Legacy `run_admin_bot()` in `code/admin.py` (Telethon) is **never started**; `main.py` only starts `run_admin_bot_ptb()`. So there are no two admin bots running; no duplication.
- **Per-AdBot:** One Telethon client per AdBot in `users.py`; no PTB equivalent for that bot. Session handling (posting, DM) remains Telethon; correct.

---

## 3. Main-loop job queue (delete_bot) — consumer missing

- **Producer:** In `admin_ptb.py`, "Delete this AdBot" → "Move sessions to free" / "Mark sessions dead" calls:
  `submit_main_loop_job("delete_bot", (bot_token, chat_id, msg_id, "free"|"dead", name))`
- **Docstring:** "Consumer runs in main.py".
- **Reality:** `main.py` does **not** read from `_main_loop_job_queue`. No `get()` or task that processes `delete_bot` jobs.

**Effect:** Without a consumer, Delete AdBot would leave the message on "Deleting AdBot... I'll update this message when done." and never complete.

**Current status:** The consumer is **already implemented in main.py**: a local `_main_loop_job_consumer()` reads from `_main_loop_job_queue` (imported from `admin_ptb`), processes `delete_bot` (stop posting, disconnect, update adbot.json, notify_edit_admin_message), and is started with `asyncio.create_task(_main_loop_job_consumer())`. So Delete AdBot completes and the admin message is updated.

**If missing:** Add a consumer (e.g. in the main asyncio loop) that:
1. Gets jobs from `admin_ptb._main_loop_job_queue` (non-blocking or in a thread).
2. For `job_type == "delete_bot"`, runs the same logic as in `admin.py`: `_stop_posting(bot_token)`, disconnect controller bot, pop from `data["bots"]`, move sessions to free or dead, `save_adbot`, then call `notify.notify_edit_admin_message(chat_id, msg_id, "Deleted …")`.

---

## 4. Session handling separation

- **Bot session (admin):** PTB only. `config.ADMIN_BOT_TOKEN` → PTB `Application` / `Bot`. No Telethon client for the admin bot. ✅
- **Account sessions (posting):** Telethon only. Each AdBot has a Telethon `TelegramClient` (user bot) in `users.py`; posting workers use their own Telethon session clients. ✅
- **Log group / admin DM:** Sent via PTB (`bot_ptb.send_log_message`, `send_admin_dm_alert`, `edit_admin_message`). ✅

No mixing: admin UI = PTB; posting and session actions = Telethon.

---

## 5. Forwarding / posting triggers

- **Start posting:** `_start_posting(bot_token)` in `users.py` is called from:
  - `create_user_bot()` after bot is created (and from `_result_consumer_ptb` when creation succeeds),
  - Run button callback (`event.data == CB_RUN`) in the same file.
- **Stop posting:** `_stop_posting(bot_token)` from Stop button and from delete_bot (in admin.py legacy; in main loop consumer once implemented).

Flow is unchanged; no broken triggers.

---

## 6. Renames / imports / async

- `admin_ptb` correctly imports from `admin`: `_create_job_queue`, `_result_queue`, `_session_counts`, `_create_status_text`, `_get_system_stats`, `load_adbot`, `save_adbot`, `_workers_alive`, `_start_create_worker_if_needed`, `_process_upload_standalone`, `_admin_validate_sessions`, `_admin_replace_dead`, `_admin_replace_error_sessions`, `_admin_recreate_log_group`, `_extract_zip_and_copy_sessions`, `_unique_session_path`, `_all_known_session_files`.
- `_admin_recreate_log_group` is called with `None` for the first parameter (admin_client); the function does not use it, only Telethon session clients. ✅
- Create-job flow: `submit_create_job` → `_create_job_queue` → worker → `_result_queue` → `_result_consumer_ptb` → `notify_edit_admin_message` + `create_user_bot`. All wired; progress consumer is started by `submit_create_job`. ✅

No broken renames or import/async issues identified.

---

## 7. Files where behavior diverges from intended architecture

| File | Issue | Severity |
|------|--------|----------|
| `code/admin_ptb.py` | `on_message` (Create wizard text + Add Sessions documents) never registered → wizard and add-sessions broken | **Critical** |
| `main.py` | No consumer for `_main_loop_job_queue` → Delete AdBot never completes | **Critical** |
| `code/admin.py` | `run_admin_bot()` and all its Telethon handlers are dead code (never run) | Informational only |

---

## 8. Step-by-step repair patches

### Patch 1: Register MessageHandler in admin_ptb.py

**Issue:** Create AdBot wizard (name, sessions_count, cycle, gap, bot_token, valid_till) and Add Sessions (document upload) never run because `on_message` is not attached.

**Change:** After `app.add_handler(CallbackQueryHandler(on_callback))`, add a handler for messages that should be processed by the admin (text and documents). Use a filter so only relevant messages are passed to `on_message` (e.g. when user is in create wizard or add_sessions mode, or for /cancel).

**Recommended:** Add a single `MessageHandler` that handles all non-command messages (so that both text for the wizard and documents for Add Sessions are received). Filter: `filters.TEXT | filters.Document.ALL` and optionally restrict to private chat. Then:

```python
app.add_handler(MessageHandler(
    (filters.TEXT & ~filters.COMMAND) | filters.Document.ALL,
    on_message,
))
```

Place this immediately after `app.add_handler(CallbackQueryHandler(on_callback))`.

---

### Patch 2: Main-loop job consumer in main.py

**Issue:** `submit_main_loop_job("delete_bot", ...)` enqueues work but nothing runs it; the admin message stays on "Deleting AdBot... I'll update this message when done."

**Change:**

1. In `main.py`, import:
   - `submit_main_loop_job` is not needed (only the queue consumer is).
   - From `code.admin_ptb`: get the queue (e.g. expose `_main_loop_job_queue` or a function that returns the next job).
   - From `code.users`: `_stop_posting`, and whatever is used to disconnect the controller bot (e.g. from `code.utils` or `code.users`: `get_shutdown_clients` / disconnect_and_remove_controller_bot).

2. Implement a consumer task that:
   - In a loop, gets a job from the queue (e.g. `asyncio.to_thread(queue.get)` or a non-blocking get with a short timeout to avoid blocking the loop).
   - For `job_type == "delete_bot"`: unpack `(bot_token, chat_id, msg_id, move_to, name)`; call `_stop_posting(bot_token)`; wait briefly; disconnect and remove the controller bot for that token; load adbot.json, pop the bot, move sessions to free or dead per `move_to`, save; then call `notify.notify_edit_admin_message(chat_id, msg_id, f"Deleted {name}. Sessions moved to {'free' if move_to == 'free' else 'dead'}.")`.

3. Start this consumer task from `main()` (e.g. `asyncio.create_task(main_loop_job_consumer())`) next to the other control-plane tasks.

**Detail:** The delete logic currently lives in `admin.py` (Telethon handlers). Either:
- Expose a function in `admin.py` or `admin_ptb.py` that performs the delete (stop, disconnect, update data, save) and only needs `(bot_token, move_to)` and returns a short message; then the main loop consumer calls it and then `notify_edit_admin_message(chat_id, msg_id, msg)`, or
- Replicate the delete steps in the consumer (load adbot, pop bot, move sessions, save) and call `_stop_posting` and disconnect from `users`/utils. Prefer a single shared function to avoid drift.

---

### Patch 3 (optional): String formatting in admin_ptb.py

Lines 343–345 and 398–417 use multi-line f-strings. If any runtime or linter complains, replace with explicit `\n` or triple-quoted f-strings for clarity. Current linter reports no errors; no change strictly required.

---

## 9. Summary checklist

| Check | Result |
|-------|--------|
| All PTB commands and callbacks mapped | ✅ Callbacks and commands are mapped; MessageHandler is not registered |
| No duplicated/broken Telethon admin handlers | ✅ Legacy admin is simply not run |
| callback_data matches handlers | ✅ All admin PTB callbacks handled in `on_callback` |
| Functions no longer triggered | Create wizard text steps and Add Sessions documents not triggered (missing MessageHandler); delete_bot job not processed (missing consumer) |
| Session separation (bot vs account) | ✅ Correct |
| Forwarding/posting called as before | ✅ Unchanged |
| Renames/imports/async breaks | ✅ None found |
| **Fixes required** | (1) Register MessageHandler in admin_ptb. (2) Add main_loop_job consumer in main.py and implement delete_bot handling |

---

## 10. Exact code changes (minimal)

- **admin_ptb.py:** Add one line (and ensure `filters` is in scope):
  `app.add_handler(MessageHandler((filters.TEXT & ~filters.COMMAND) | filters.Document.ALL, on_message))`
- **main.py:** Add a `main_loop_job_consumer()` task that reads from the admin job queue and processes `delete_bot` (stop posting, disconnect bot, update adbot.json, edit message via notify), and start it with `asyncio.create_task(...)`.
- **admin_ptb.py (or admin.py):** Expose a small API for the main loop to run delete_bot (e.g. `run_delete_bot(bot_token, move_to) -> str`) so the consumer only does: get job → run_delete_bot → notify_edit_admin_message.

Once Patch 1 and Patch 2 are in place, Create AdBot wizard, Add Sessions, and Delete AdBot will behave as intended without rewriting the rest of the project.
