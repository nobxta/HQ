# Control Plane Repair Summary

**Context:** Full control-plane migration repair after switching admin/controller/log bots from Telethon to python-telegram-bot (PTB). All notification and create-job flows are now independent of Telethon admin bot lifecycle.

---

## 1. Message Flow Graph (After Repair)

### 1.1 Notification pipelines

```
Worker (multiprocessing)
    │ report_alert(kind, msg)
    │ report_log(bot_token, msg, …)
    │ report_dm_alert(session_file, from_name, user_id, message_text)
    ▼
_worker_result_queue
    ▼
_apply_worker_result() [main loop]
    ├─ admin_alert → add_admin_alert(kind, msg)  → adbot.json "admin_alerts"
    ├─ log         → enqueue_log(...)             → _log_queue
    └─ dm_alert    → create_task(notify_dm_received(...))  → PTB admin DM
```

```
adbot.json "admin_alerts"
    ▼
_alert_forward_loop_ptb() [main, started from main.py]
    ▼
notify_admin_send(msg) → bot_ptb.send_admin_dm_alert() → ADMIN_USER_ID
```

```
_log_queue
    ▼
_log_queue_consumer() [main, started from main.py]
    ▼
notify_log_group(bot_token, log_ent, msg) → bot_ptb.send_log_message() → log group
```

```
Create job (enqueued via submit_create_job(chat_id, msg_id, form) from PTB wizard)
    │
    ├─ progress_queue
    │      ▼
    │  _progress_consumer_ptb(progress_queue) [main, one per job]
    │      ▼
    │  notify_edit_admin_message(chat_id, msg_id, msg) → bot_ptb.edit_admin_message()
    │
    └─ _create_job_queue → _create_worker_loop() [thread] → _sync_execute_create_adbot()
            ▼
       _result_queue
            ▼
       _result_consumer_ptb() [main, started from main.py]
            ▼
       notify_edit_admin_message(chat_id, msg_id, success/fail text) + create_user_bot(bot_token)
```

**Daily report (no queue):**

```
_daily_report_loop_ptb() [main, started from main.py]
    ▼
notify_admin_send(daily_report_text) → bot_ptb.send_admin_dm_alert() → ADMIN_USER_ID
```

### 1.2 Dependency map: components and Telethon

| Component | Previously relied on Telethon admin? | After repair |
|-----------|--------------------------------------|--------------|
| Admin alerts (forward loop) | Yes — started inside `run_admin_bot()`, used `client.send_message(ADMIN_USER_ID, msg)` | **No** — started from `main()`, uses `notify_admin_send` → PTB |
| Daily report loop | Yes — same as above | **No** — started from `main()`, uses PTB |
| Log queue consumer | No (already used PTB) | **No** — unchanged, started from `main()` |
| Result consumer (create job) | Yes — started inside `run_admin_bot()`, used `admin_client.edit_message` | **No** — `_result_consumer_ptb()` started from `main()`, uses `notify_edit_admin_message` → PTB |
| Progress consumer (create job) | Yes — started per job in Telethon callback, used `admin_client.edit_message` | **No** — `_progress_consumer_ptb(progress_queue)` started per job via `submit_create_job()`, uses PTB |

**Conclusion:** No control-plane consumer depends on a Telethon admin client. All admin/log/create-job messaging goes through PTB (via the notify gateway or directly `bot_ptb`).

---

## 2. Pipelines That Were Disconnected (Before Repair)

| Pipeline | Previous Telethon startup | Issue |
|----------|---------------------------|--------|
| **Alert forward loop** | Started inside `run_admin_bot()` (Telethon) | When using PTB-only, `run_admin_bot()` was never run; alert loop was instead started inside `run_admin_bot_ptb()`, so it was tied to PTB admin startup. |
| **Daily report loop** | Same as above | Same — lived inside admin bot entrypoint. |
| **Result consumer** | Started inside `run_admin_bot()` as `asyncio.create_task(_result_consumer(client))` | With PTB-only, `run_admin_bot()` not run → **no consumer for _result_queue** → create-job results were never applied (no final message edit, no `create_user_bot`). |
| **Progress consumer** | Started in Telethon callback when user triggered Create AdBot: `asyncio.create_task(_progress_consumer(progress_queue, client))` | With PTB-only, Create AdBot wizard was not ported, so no jobs were enqueued and no progress consumer was started. Additionally, progress/result consumers depended on Telethon `client`. |

**What was not broken:** Log queue consumer and worker → result_queue → _apply_worker_result → enqueue_log / add_admin_alert were already working; only the **create-job result** path had no consumer when using PTB-only.

---

## 3. Code Moved to Main Startup

All of the following are now started from `main()` in `main.py` so they run regardless of which admin bot (Telethon vs PTB) is used:

| Consumer / loop | Function | File | Started in main.py as |
|-----------------|----------|------|------------------------|
| PTB admin bot | `run_admin_bot_ptb()` | code/admin_ptb.py | `asyncio.create_task(run_admin_bot_ptb())` |
| Log queue consumer | `_log_queue_consumer()` | code/users.py | `asyncio.create_task(_log_queue_consumer())` |
| Alert forward loop | `_alert_forward_loop_ptb()` | code/admin_ptb.py | `asyncio.create_task(_alert_forward_loop_ptb())` |
| Daily report loop | `_daily_report_loop_ptb()` | code/admin_ptb.py | `asyncio.create_task(_daily_report_loop_ptb())` |
| Create-job result consumer | `_result_consumer_ptb()` | code/admin_ptb.py | `asyncio.create_task(_result_consumer_ptb())` |
| Session health monitor | `run_session_health_monitor()` | code/users.py | `asyncio.create_task(run_session_health_monitor())` |

**Removed from `run_admin_bot_ptb()`:**  
`asyncio.create_task(_alert_forward_loop_ptb())` and `asyncio.create_task(_daily_report_loop_ptb())` were removed from there so that alert and daily report loops are **not** tied to PTB admin bot startup and run purely from main.

**Progress consumer:**  
Not a single global loop. One `_progress_consumer_ptb(progress_queue)` is started per create job when `submit_create_job(chat_id, msg_id, form)` is called (e.g. from the PTB Create AdBot wizard when ported). That function creates the progress queue, starts the PTB progress consumer, and enqueues the job.

---

## 4. Unified Notification Gateway

**Module:** `code/notify.py`

| Function | Purpose | Internal routing |
|----------|---------|-------------------|
| `notify_admin(alert_type, msg)` | Queue an admin alert (persisted, sent by alert loop) | `add_admin_alert(alert_type, msg)` → adbot.json |
| `notify_admin_send(text, parse_mode=..., reply_markup=...)` | Send one message to ADMIN_USER_ID immediately | `bot_ptb.send_admin_dm_alert(...)` |
| `notify_log_group(bot_token, chat_id, text, ...)` | Send to log group (or any chat) | `bot_ptb.send_log_message(...)` |
| `notify_dm_received(session_file, from_name, user_id, message_text)` | “New DM received” alert to admin (with button) | `bot_ptb.send_admin_dm_received(...)` |
| `notify_edit_admin_message(chat_id, message_id, text, parse_mode=...)` | Edit a message sent by the admin bot | `bot_ptb.edit_admin_message(...)` |

**Call sites updated to use the gateway:**

- **code/users.py**  
  - Log consumer: `bot_ptb.send_log_message` → `notify.notify_log_group`.  
  - DM alert: `bot_ptb.send_admin_dm_received` → `notify.notify_dm_received`.

- **code/admin_ptb.py**  
  - Alert forward loop: `bot_ptb.send_admin_dm_alert` → `notify.notify_admin_send`.  
  - Daily report: same.  
  - Result consumer: `notify.notify_edit_admin_message` for final success/fail.  
  - Progress consumer: `notify.notify_edit_admin_message` for progress; on edit failure, `notify.notify_admin_send` as fallback.

No Telethon-based admin or log sends remain in active paths; all go through PTB (directly or via the gateway).

---

## 5. Startup Initialization (main.py)

During system startup, `main()` now:

1. **Starts PTB admin bot polling** — `asyncio.create_task(run_admin_bot_ptb())` (builds app, runs polling in a thread).
2. **Starts log queue consumer** — `asyncio.create_task(_log_queue_consumer())`.
3. **Starts alert forward loop** — `asyncio.create_task(_alert_forward_loop_ptb())`.
4. **Starts daily report loop** — `asyncio.create_task(_daily_report_loop_ptb())`.
5. **Starts create-job result consumer** — `asyncio.create_task(_result_consumer_ptb())`.
6. **Starts session health monitor** — `asyncio.create_task(run_session_health_monitor())`.
7. **Resumes AdBots** — `await resume_adbots(data)`.

No consumer depends on Telethon admin initialization. The create-worker thread (for create jobs) is still started on first use (e.g. when the PTB admin is built) via `_start_create_worker_if_needed()`; the **result** of that thread is consumed by `_result_consumer_ptb()`, which is started from main.

---

## 6. Broken Features and Fixes Applied

| Feature | Before repair (after PTB migration) | Fix applied |
|--------|-------------------------------------|-------------|
| **Admin alerts** | Worked (alert loop was started inside `run_admin_bot_ptb`) | Loop moved to main startup so it does not depend on admin bot lifecycle; sends go through `notify_admin_send`. |
| **Daily report** | Worked (same as above) | Same — started from main; uses `notify_admin_send`. |
| **Log group posts** | Worked (log consumer already used PTB) | No behavioral change; log consumer now uses `notify.notify_log_group` for a single gateway. |
| **Create-job result** | **Broken** — `_result_consumer` ran only inside `run_admin_bot()` (Telethon), so with PTB-only there was no consumer for `_result_queue`. | **Fixed** — `_result_consumer_ptb()` added; it consumes `_result_queue`, edits the final message via `notify_edit_admin_message`, and starts `create_user_bot(bot_token)`. Started from `main()`. |
| **Create-job progress** | **Broken** — Progress consumer was started only from the Telethon Create AdBot callback with a Telethon client. With PTB-only, no progress consumer was started and no create jobs were enqueued. | **Fixed** — `_progress_consumer_ptb(progress_queue)` added; it uses `notify_edit_admin_message`. When the PTB Create AdBot wizard is implemented, it should call `submit_create_job(chat_id, msg_id, form)`, which starts `_progress_consumer_ptb(progress_queue)` and enqueues the job. Result consumer is already running from main. |
| **DM received alerts** | Worked (already used PTB) | No behavioral change; now routed through `notify.notify_dm_received`. |

**Summary:**  
The only pipeline that was actually broken was **create-job result** (no consumer for `_result_queue`). It is fixed by starting `_result_consumer_ptb()` from main. Create-job **progress** is fixed by providing `_progress_consumer_ptb` and `submit_create_job()` so that when the PTB wizard is ported, progress and result both work without any Telethon admin client.

---

## 7. New / Modified Files

| File | Change |
|------|--------|
| **code/notify.py** | **New.** Unified gateway: `notify_admin`, `notify_admin_send`, `notify_log_group`, `notify_dm_received`, `notify_edit_admin_message`. |
| **code/bot_ptb.py** | **Added** `edit_admin_message(chat_id, message_id, text, parse_mode)` for editing admin bot messages (e.g. Create AdBot progress/result). |
| **code/admin_ptb.py** | **Added** `_result_consumer_ptb()`, `_progress_consumer_ptb(progress_queue)`, `submit_create_job(chat_id, msg_id, form)`. Alert/daily loops now use `notify`. Removed starting of alert and daily loops from `run_admin_bot_ptb()`. |
| **main.py** | **Added** startup of `_alert_forward_loop_ptb()`, `_daily_report_loop_ptb()`, `_result_consumer_ptb()` so all run from main. |
| **code/users.py** | Log consumer and dm_alert handler now use `notify.notify_log_group` and `notify.notify_dm_received`. |

---

## 8. Confirmation

- **Worker → result_queue → controller → admin/log sender:** Unchanged; worker results are applied in `_apply_worker_result`; admin alerts go to `admin_alerts` and are sent by `_alert_forward_loop_ptb`; log messages go to `_log_queue` and are sent by `_log_queue_consumer` via the notify gateway. All senders use PTB.
- **Startup → admin alert:** No startup validation in main; any future startup alert would use `notify_admin` or `notify_admin_send`; no Telethon dependency.
- **Create-job → progress/result consumer → admin message:** Result consumer runs from main (`_result_consumer_ptb`). Progress consumer runs per job when `submit_create_job` is used (`_progress_consumer_ptb`). Both use `notify_edit_admin_message` (PTB). Create-worker thread and queues (`_create_job_queue`, _result_queue`) are unchanged; only the consumers that edit/send admin messages were moved to PTB and started from main or from `submit_create_job`.

All notification and create-job flows are now independent of the Telethon admin bot lifecycle and route through PTB (and the notify gateway where applicable).
