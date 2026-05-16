# Migration Breakage Report: Telethon → python-telegram-bot (PTB)

**Scope:** Admin bot, controller/log-group sender, and admin notification paths after migrating to PTB.

---

## 1. Communication Paths (Before vs After)

### 1.1 Admin alerts (to ADMIN_USER_ID)

| Before (Telethon) | After (PTB) | Status |
|-------------------|-------------|--------|
| `add_admin_alert(type, msg)` appends to `admin_alerts` in adbot.json | Same | **Unchanged** |
| `run_admin_bot()` started `_alert_forward_loop()` which read `admin_alerts` and called `client.send_message(config.ADMIN_USER_ID, msg)` (Telethon) | `run_admin_bot_ptb()` starts `_alert_forward_loop_ptb()` which reads `admin_alerts` and calls `bot_ptb.send_admin_dm_alert(msg)` | **Replaced, working** |
| Call site: `code/admin.py` `_alert_forward_loop` (inside dead `run_admin_bot()`) | Call site: `code/admin_ptb.py` `_alert_forward_loop_ptb` | **Active path** |

**Verdict:** Admin alerts still flow: `add_admin_alert` → adbot.json → `_alert_forward_loop_ptb` → `bot_ptb.send_admin_dm_alert`.

---

### 1.2 Log-group messages (per-AdBot log group)

| Before (Telethon) | After (PTB) | Status |
|-------------------|-------------|--------|
| `enqueue_log(bot_token, msg, ...)` put on `_log_queue` | Same | **Unchanged** |
| `_log_queue_consumer()` used `BOT_CLIENTS.get(bot_token)` (Telethon client) and `await client.send_message(log_ent, msg)` | `_log_queue_consumer()` uses `bot_ptb.send_log_message(bot_token, log_ent, msg, ...)` | **Replaced, working** |
| Telethon: `code/users.py` ~lines 85–127 (old consumer) | PTB: `code/users.py` ~lines 78–124 (current consumer) | **Active** |

**Verdict:** Log-group pipeline still connected: enqueue_log → _log_queue → _log_queue_consumer → bot_ptb.send_log_message.

---

### 1.3 Runtime notifications (worker → controller)

| Path | Before | After | Status |
|------|--------|--------|--------|
| Worker `report_alert(kind, msg)` | result_queue → `_apply_worker_result` → `add_admin_alert(kind, msg)` → admin_alerts → Telethon `_alert_forward_loop` | Same up to add_admin_alert; then `_alert_forward_loop_ptb` → PTB | **Working** |
| Worker `report_log(bt, msg, …)` | result_queue → `_apply_worker_result` → `enqueue_log(...)` → _log_queue → Telethon client | Same; consumer now uses PTB | **Working** |
| Worker `report_dm_alert(...)` | N/A (new in migration) | result_queue → `_apply_worker_result` → `loop.create_task(bot_ptb.send_admin_dm_received(...))` | **Working** |

**Verdict:** All worker → controller notification paths are connected and use PTB or the same queue → PTB consumer.

---

### 1.4 Startup validation → admin notification

| Before | After | Status |
|--------|--------|--------|
| `main()` called `run_startup_validation(data)` then `add_admin_alert("startup_validation", ...)` | Startup validation was **removed by design** from `main.py`; no longer runs or sends alerts | **Removed intentionally** |

**Verdict:** Not broken; feature was deliberately removed. Validation now only runs when creating AdBot, replacing session, or when user starts AdBot.

---

## 2. Pipeline Connectivity

| Pipeline | Producer | Queue / storage | Consumer | Sender | Status |
|----------|----------|------------------|----------|--------|--------|
| Worker → log group | Workers `report_log` | `_worker_result_queue` → `_apply_worker_result` → `enqueue_log` → `_log_queue` | `_log_queue_consumer()` (main loop) | `bot_ptb.send_log_message` | **Connected** |
| Worker → admin alert | Workers `report_alert`; various `add_admin_alert` call sites | `add_admin_alert` → adbot.json `admin_alerts` | `_alert_forward_loop_ptb()` (main loop) | `bot_ptb.send_admin_dm_alert` | **Connected** |
| Startup validation → admin | (Removed) | — | — | — | **N/A** |
| Runtime error alerts → admin | `add_admin_alert(...)` in users.py, admin.py, etc. | adbot.json `admin_alerts` | `_alert_forward_loop_ptb()` | `bot_ptb.send_admin_dm_alert` | **Connected** |
| DM received → admin (no log group) | Worker `report_dm_alert` | `_worker_result_queue` → `_apply_worker_result` | Inline in `_apply_worker_result` | `bot_ptb.send_admin_dm_received` (create_task) | **Connected** |

**Where messages could stop flowing:** None for the above pipelines. All use either the PTB senders or the same queues with PTB-backed consumers.

---

## 3. Bot Sender Mismatch

### 3.1 Remaining Telethon `send_message` usage (not for admin/log notifications)

| File | Line / context | Purpose | Issue? |
|------|----------------|--------|--------|
| `code/users.py` | 1133, 1287 | `client.send_message(entity, msg_text, ...)` inside posting loop | **OK** – session (user) client posting to groups; not admin/log. |
| `code/admin.py` | 581, 777, 879, 1043, 1076, 1189, 1307, 1330, 1353, 1366, 1379, 1392, 1425, 1755, 1782, 1784 | All inside `run_admin_bot()` or its handlers | **Dead code** – `run_admin_bot()` is never called; only `run_admin_bot_ptb()` is used. No active path uses these for admin/log. |
| `code/utils.py` | 267 | `client.send_message("me", ".")` in session validation | **OK** – user session validation (Saved Messages). |
| `code/rpc_errors.py` | 309, 362 | Doc/example and `safe_send_message` (generic Telethon helper) | **OK** – used for session posting, not admin/log. |

**Verdict:** No active code path uses a Telethon client to send admin or log-group notifications. Remaining Telethon send_message is for session posting or validation, or is dead (admin.py under unused `run_admin_bot()`).

### 3.2 PTB sender usage

| Function | File | Called from | Status |
|----------|------|-------------|--------|
| `bot_ptb.send_log_message` | code/bot_ptb.py | `_log_queue_consumer()` (code/users.py) | **Used** |
| `bot_ptb.send_admin_dm_alert` | code/bot_ptb.py | `_alert_forward_loop_ptb()`, `_daily_report_loop_ptb()`, `send_admin_dm_received()` | **Used** |
| `bot_ptb.send_admin_dm_received` | code/bot_ptb.py | `_apply_worker_result()` (dm_alert branch) | **Used** |

**Verdict:** All PTB sender functions are used; no dead PTB senders.

### 3.3 Async/sync and awaits

| Call | Context | Await / scheduling | Status |
|------|----------|--------------------|--------|
| `await bot_ptb.send_log_message(...)` | `_log_queue_consumer` (async) | Awaited | **OK** |
| `await bot_ptb.send_admin_dm_alert(...)` | `_alert_forward_loop_ptb`, `_daily_report_loop_ptb` (async) | Awaited | **OK** |
| `bot_ptb.send_admin_dm_received(...)` | `_apply_worker_result` (sync, runs on main loop) | `loop.create_task(...)` | **OK** |

**Verdict:** No missing awaits or async/sync misuse for admin or log sends.

---

## 4. Queue Consumer and Dispatcher Status

### 4.1 Log queue consumer

| Check | Result |
|-------|--------|
| Still running after migration? | **Yes** – `main.py` does `asyncio.create_task(_log_queue_consumer())`. |
| Depends on Telethon client? | **No** – consumer uses `bot_ptb.send_log_message(bot_token, log_ent, ...)` and does not use `BOT_CLIENTS`. |
| Dependency on removed pieces? | **None** – `BOT_CLIENTS` is still populated by `create_user_bot()` (Telethon user bot) but log consumer no longer reads it. |

### 4.2 Admin alert dispatcher

| Check | Result |
|-------|--------|
| Still started after migration? | **Yes** – `run_admin_bot_ptb()` does `asyncio.create_task(_alert_forward_loop_ptb())` (and runs on main loop). |
| Depends on Telethon client? | **No** – uses `bot_ptb.send_admin_dm_alert`. |
| Dependency on removed pieces? | **None** – no reference to admin Telethon client. |

### 4.3 Create AdBot result consumer (admin.py)

| Check | Result |
|-------|--------|
| `_result_consumer(admin_client)` (Telethon) | Started only inside `run_admin_bot()` in `code/admin.py` (line 1794). |
| `run_admin_bot()` ever called? | **No** – entrypoint is `run_admin_bot_ptb()` from main. |
| Effect | **Broken pipeline:** `_result_queue` (create job results) has **no consumer** when running PTB-only. Create AdBot wizard is also not exposed in PTB admin UI (only a minimal “Proceed in legacy admin” message). So create-job results are never processed and the full wizard is not available. |

---

## 5. Migration Breakage Report (Summary)

| # | Feature | Before migration | After migration | Break location | Recommended fix |
|---|--------|-------------------|------------------|----------------|------------------|
| 1 | Admin alerts (generic) | Telethon admin client sent to ADMIN_USER_ID | PTB `send_admin_dm_alert` from `_alert_forward_loop_ptb` | — | **None** – working. |
| 2 | Log-group messages | Telethon bot client per token sent to log group | PTB `send_log_message` from `_log_queue_consumer` | — | **None** – working. |
| 3 | Worker → admin_alert | add_admin_alert → Telethon loop | add_admin_alert → PTB loop | — | **None** – working. |
| 4 | Worker → log | enqueue_log → Telethon consumer | enqueue_log → PTB consumer | — | **None** – working. |
| 5 | DM received → admin (no log) | N/A | report_dm_alert → send_admin_dm_received | — | **None** – working. |
| 6 | Startup validation → admin | Ran and sent alert | Removed from main | main.py | **None** – intentional removal. |
| 7 | Daily report → admin | Telethon client in run_admin_bot | PTB in `_daily_report_loop_ptb` | — | **None** – working. |
| 8 | Create AdBot wizard (full flow) | run_admin_bot() had _result_consumer(client); progress and final message via Telethon | run_admin_bot() not run; _result_consumer never started; PTB admin has no full wizard | code/admin.py (dead run_admin_bot); code/admin_ptb.py (no wizard) | **Option A:** Port full Create AdBot wizard to PTB (progress + final message via PTB bot). **Option B:** Start a separate Telethon admin client only for create flow and run _result_consumer with it. **Option C:** Document that “full Create AdBot” is unavailable when using PTB-only admin. |
| 9 | Create AdBot progress updates | _progress_consumer(progress_queue, client) edited message via Telethon | Same code exists but is only used when create job is enqueued from Telethon admin; PTB admin does not enqueue create jobs | code/admin.py callbacks (only run under run_admin_bot) | Same as #8 – fix with wizard port or hybrid admin. |

---

## 6. Dead or Unused Code (No Impact on Current Paths)

- **`code/admin.py`**  
  - `run_admin_bot()` and everything inside it: `_alert_forward_loop()`, `_result_consumer()`, `_daily_report_loop()` (Telethon), and all handlers that use `client.send_message`.  
  - These are never run; only `run_admin_bot_ptb()` is used. They can be removed or kept for reference/hybrid use.

- **`BOT_CLIENTS`** in `code/users.py`  
  - Still populated by `create_user_bot()` (Telethon user bot for Run/Stop menu).  
  - No longer used for log sending; log consumer uses PTB only.  
  - Safe to keep for user-bot lifecycle; no broken dependency.

---

## 7. Conclusion

- **Admin alerts, log-group messages, worker alerts, DM alerts, and daily report** all work after migration and use PTB or the same queues with PTB-backed consumers. No broken pipelines for these.
- **Startup validation** was intentionally removed; no fix needed unless you want it back.
- **Only broken pipeline:** full **Create AdBot wizard** and its **result/progress** flow, because they depend on `run_admin_bot()` and `_result_consumer(admin_client)`, which are never started when using PTB-only admin. Fix by either porting the wizard to PTB, reintroducing a limited Telethon admin for create flow, or documenting the limitation.
