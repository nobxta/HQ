# Admin Broadcast System — Execution-Path Audit

## Part 1 — Broadcast Execution Flow Trace

There are **three** broadcast entry points:

### A. Control Center broadcast (PTB: segment → copy_message)

| Stage | File:Line | Input data | Possible failure condition | Log produced |
|-------|-----------|------------|----------------------------|--------------|
| 1. Admin triggers | admin_ptb.py:920 | callback_data="bc_send" | — | — |
| 2. User ID list loaded | admin_ptb.py:924–931 | ud["broadcast_uids"] or broadcast_segment_user_ids_validated(segment) | segment not in user_data; payload missing; session expired (>600s) | [BroadcastDebug] total_ids_loaded, valid_ids, invalid_ids |
| 3. Validation | admin_control.py:173–198 | raw list from broadcast_users.json | JSON has strings/floats/None; filtered to valid ints | [BroadcastDebug] (see above) |
| 4. Send loop | admin_ptb.py:971–984 | user_id, from_chat_id, message_id | copy_message raises (Forbidden, BadRequest, etc.) | logger.warning with type(e).__name__ |
| 5. Result logging | admin_ptb.py:985–990 | segment, total, sent, failed | broadcast_log_append can raise (file I/O) | logger.warning "Broadcast log append failed" |
| 6. Completion | admin_ptb.py:991–995 | sent, failed | — | [BroadcastRun] progress, failures, completed=True |

### B. /broadcast command (PTB: authorized users + Markdown text)

| Stage | File:Line | Input data | Possible failure condition | Log produced |
|-------|-----------|------------|----------------------------|--------------|
| 1. Admin triggers | admin_ptb.py:511 | /broadcast <message> | No text → "Use: /broadcast <message>" | — |
| 2. User ID list loaded | admin_ptb.py:518–527 | load_adbot(); ADMIN_USER_ID + all cfg["authorized"] | authorized may be int or str from JSON | [BroadcastDebug] after validation |
| 3. Validation | admin_ptb.py:528–534 | _broadcast_validate_user_ids(raw_ids) | Invalid IDs skipped | [BroadcastDebug] |
| 4. Send loop | admin_ptb.py:539–551 | uid, text (MarkdownV2) | bot.send_message raises (Forbidden, BadRequest, etc.) | logger.warning with type(e).__name__ |
| 5. Result | admin_ptb.py:552–553 | sent, failed | — | [BroadcastRun] completed=True; reply to user |

### C. Telethon /broadcast (admin.py: authorized users)

| Stage | File:Line | Input data | Possible failure condition | Log produced |
|-------|-----------|------------|----------------------------|--------------|
| 1. Admin triggers | admin.py:1351 | /broadcast <message> | No text → "Use: /broadcast <message>" | — |
| 2. User ID list loaded | admin.py:1360–1372 | load_adbot(); ADMIN_USER_ID + cfg["authorized"]; then _broadcast_validate_user_ids | invalid IDs filtered | [BroadcastDebug] |
| 3. Send loop | admin.py:1375–1383 | uid in valid_ids, text (parse_mode="md") | client.send_message raises | logger.warning with type(e).__name__ |
| 4. Result | admin.py:1374 | sent, failed | — | reply to user |

---

## Part 2 — User ID Validation

### Before fix (audit finding)

- **Stored format:** broadcast_users.json stores lists of integers. When loaded via `json.loads`, numbers are Python `int`. If the file was hand-edited with string IDs (e.g. `"123"`), they remain strings.
- **authorized:** In pool/index user configs, `authorized` is a list that may contain int or str depending on how it was written (JSON allows both).
- **Filtering:** broadcast_segment_user_ids returned `list(db.get("all_users") or [])` with no validation; invalid entries (str, float, None) were passed to copy_message/send_message and could cause TypeError or API errors.
- **Silent skip:** No explicit “skip if conversion fails”; the loop would raise on first invalid ID or rely on the API to reject.

### After fix

- **_broadcast_validate_user_ids(raw_ids)** in admin_control.py: coerces each ID to int; skips None, non-numeric, float, ≤0. Returns `(valid_list, invalid_count)`.
- **broadcast_segment_user_ids_validated(segment)** returns `(valid_ids, total_loaded, invalid_count)` for logging.
- **broadcast_segment_user_ids(segment)** now returns only valid ints (via validated).
- **Debug output:** `[BroadcastDebug] total_ids_loaded=N valid_ids=M invalid_ids=K` is logged in both Control Center bc_send and cmd_broadcast (admin_ptb).

### Telethon /broadcast (admin.py)

- Now uses _broadcast_validate_user_ids(raw_ids); only valid int IDs are sent to. [BroadcastDebug] and [BroadcastRun] are logged as in admin_ptb.

---

## Part 3 — Send Attempt Failure Audit

| UserID source | ErrorType (examples) | Handled | Logged |
|---------------|----------------------|--------|--------|
| Control Center (copy_message) | telegram.error.Forbidden (user blocked bot) | True (except block) | True (logger.warning + type name) |
| Control Center | telegram.error.BadRequest (chat not found, invalid id) | True | True |
| Control Center | telegram.error.TimedOut / NetworkError | True | True |
| Control Center | Any other Exception | True | True (logger.warning) |
| /broadcast PTB (send_message) | Same as above | True | True (logger.warning + type name) |
| /broadcast Telethon (send_message) | Telethon RPC errors | True | True (logger.warning + type name) |

- **Retries:** No retries in any path; one attempt per user.
- **Rate limit:** Control Center uses `asyncio.sleep(interval)` with `interval = 60.0 / BROADCAST_RATE_LIMIT_PER_MIN` (default 30/min). /broadcast commands have no delay between sends (can hit rate limits).
- **User blocked bot:** Forbidden is caught and counted as failed; logged with exception type.

---

## Part 4 — Async / Queue Issues

- **Background task:** Control Center broadcast runs in the same callback handler (bc_send); it is not offloaded to a background task. The handler runs until the loop finishes, so it can block the bot for long runs (many users × interval).
- **Timeout / cancellation:** No explicit timeout; if the process is killed or the bot restarts mid-loop, state is in context.user_data and is cleared in `finally`, but no “resume” capability. Session expiry (10 min) clears state before sending.
- **Worker restart:** N/A (broadcast uses the admin PTB bot, not posting workers).
- **Sending too fast:** /broadcast (cmd_broadcast and admin.py on_broadcast) sends with no sleep between users → risk of rate-limit (429) from Telegram. Control Center broadcast is rate-limited.

**Confirmation (after implementation):**

- **broadcast_task_completed:** Reflected by [BroadcastRun] completed=True (or False if loop raises).
- **messages_attempted:** total (loaded_users).
- **messages_success:** sent.
- **messages_failed:** failed.

---

## Part 5 — Debug Output Implemented

- **[BroadcastDebug]** (admin_ptb Control Center + cmd_broadcast):  
  `total_ids_loaded=N valid_ids=M invalid_ids=K`

- **[BroadcastRun]** (admin_ptb Control Center + cmd_broadcast):  
  - Start: `loaded_users=N sending_started=True progress=0/N failures=0 completed=False`  
  - End: `loaded_users=N sending_started=True progress=sent/N failures=K completed=True` (or completed=False if loop raises)

- Control Center: each send failure logs `Broadcast to <user_id> failed: <e> (<ErrorType>)`.
- cmd_broadcast: each failure logs `Broadcast failed to <uid>: <e> (<ErrorType>)`.

---

## Summary: Where broadcast can stop or skip

1. **No recipients:** Segment empty or all IDs invalid after validation → "Segment has no recipients" / no send.
2. **Missing payload:** User did not send a message before pressing Send → "Missing message. Send the broadcast content first."
3. **Session expired:** >600 s since segment selection → "Broadcast session expired"; state cleared.
4. **Already sending:** broadcast_sending flag set → "Broadcast already in progress."
5. **Per-user failure:** copy_message/send_message raises → caught, failed += 1, next user; no retry.
6. **Loop exception:** Any uncaught exception in the try block (e.g. in broadcast_log_append) → caught by outer except, completed=False logged, user notified.

---

## Silent exception handling

- All send attempts are in `try/except`; exceptions are logged (logger.warning) and counted. No silent swallow without log.
- **broadcast_log_append** (admin_control.py): `except Exception as e: logger.warning("Broadcast log append failed: %s", e)` — logged.
- admin.py on_broadcast now uses the same validation and [BroadcastDebug] / [BroadcastRun] logging.

---

## Part 6 — Run (Controller Bot): Exact Process When User Clicks Run

This section documents the **exact execution path** when a user clicks **Run** from their controller (AdBot) bot: backend, frontend (bot UI), worker processes, logs (file, log group, console), and **estimated time until posting starts**.

### Where Run is handled

| Layer | Location | What runs |
|-------|----------|-----------|
| **Frontend (user-facing)** | User opens their AdBot (Telegram bot), sees menu with [Run] [Stop] [Set Message] … | Telethon controller client in main process |
| **Callback handler** | `code/users.py` — `@client.on(events.CallbackQuery())` → `on_callback` → `if raw == CB_RUN` (≈ line 2918) | Same process as `main.py` (main asyncio loop) |
| **Backend (posting)** | `_start_posting(bot_token)` in `code/users.py` (≈ 2264) | Main process: stops old workers, spawns new worker processes, sends START |
| **Workers** | `code/workers.py` — `worker_entry` → `worker_main_async` → `_async_session_loop` (from `code/users.py`) | One process per session (multiprocessing); each runs its own asyncio loop |

There is **no separate HTTP frontend**. The “frontend” is the Telegram chat with the user’s AdBot; the “backend” is the same Python process that runs `main.py`, the admin bot, and the Telethon controller clients.

---

### Step-by-step process (user clicks Run)

| Step | File:Line (or component) | What happens | Checks / details | Logs produced |
|------|--------------------------|--------------|------------------|----------------|
| 1 | **User** | Clicks inline button **Run** in chat with their AdBot | — | — |
| 2 | `users.py` (callback) | `on_callback` receives `callback_data="run"` (CB_RUN) | — | — |
| 3 | `users.py:2918–2926` | `event.answer()`; load `cfg = get_cfg()` (from `data/user/<name>.json`). Check **suspended**. | If `cfg.get("suspended")` → edit "Bot is suspended…", return | — |
| 4 | `users.py:2926–2946` | Check **message content**: `links = _get_post_links_list(cfg)`, `msg_text = (cfg.get("message_text") or "").strip()`. | If `not links and not msg_text` → edit "Set a message before running…", return | — |
| 5 | `users.py:2948–2950` | **Persist state**: `_save_bot_config(bot_token, lambda c: c.update({"state": "running"}))`. Then `started = await _start_posting(bot_token)`. | Config written to disk; then backend starts posting | — |
| 6 | `users.py:2264–2274` **_start_posting** | Await any **pending STOP cleanup** for this bot (join previous worker processes). | Timeout 50 s; if cleanup was pending, this can take up to ~50 s | — |
| 7 | `users.py:2275–2306` | Load `cfg`; stop any **existing** workers: pop `_worker_handles`, send `{"cmd": "stop"}`, `_join_workers_sync` (blocking in thread). Clear `_posting_handles` if asyncio tasks were used. | — | (Existing worker logs "[worker-N] …" in worker process) |
| 8 | `users.py:2307–2312` | **First-run behaviour**: if `not preserve_cycle_time` (user Run, not health restart), clear `last_cycle_time` and `_session_availability` / `_deferred_groups` so **first cycle is due immediately**. | Ensures first cycle is not delayed by previous schedule | — |
| 9 | `users.py:2312–2329` | Load **sessions** from config; filter to **valid_sessions** (file exists, not in `excluded_sessions`). If none → return False. | Sessions from `cfg["sessions"]`; path via `config.resolve_session_path` | — |
| 10 | `users.py:2330–2365` | **Spawn worker processes**: `chunk_sessions(valid_sessions)` (1 session per worker), `worker_entry(bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, result_queue)`; `proc.start()`. | One process per session; workers wait for START (no Telethon connect yet) | `logger.info("[posting] bot=... worker_id=... sessions_assigned=...")`; "Worker started for session ..." |
| 11 | `users.py:2396–2402` | **Send START** to each worker: `cmd_q.put({"cmd": "start"})`. | Workers leave “Phase 1” and enter “Phase 2” (stagger + session loop) | `logger.info("[posting] START sent to worker_id=... bot=...")` |
| 12 | `users.py:2407–2411` | Log summary and return True. UI: `event.edit("Running.", buttons=_menu_buttons())`; `log_bot_event(..., "User … clicked Run — posting started")`; `enqueue_log(bot_token, "Started Adbot")`. | — | **Controller bot log file** (`data/logs/<name>.log`): "User … clicked Run — posting started". **Log group** (if configured): "Started Adbot". **Console**: "Started posting for bot ... N worker(s) ..." |

Then, **inside each worker process**:

| Step | File:Line | What happens | Details | Logs |
|------|-----------|--------------|---------|------|
| 13 | `workers.py` | Worker receives **START**; sets `start_event`; exits wait. | Phase 1 was “wait for START” (no connections); Phase 2 starts session loop(s) | Worker stdout: `[worker-N] received START` |
| 14 | `workers.py:321–328` | **Stagger** per session: **Starter** mode: `stagger_sec = (STAGGER_WINDOW_SEC / total_sessions) * global_ordinal` (0 for first session, up to ~1 h for last in 1 h window). **Enterprise**: first half 0 s, second half `ENTERPRISE_STAGGER_SEC` (300 s). | `STAGGER_WINDOW_SEC = 3600`, `ENTERPRISE_STAGGER_SEC = 300` | — |
| 15 | `users.py` _async_session_loop | After stagger, **first cycle**: `last_cycle_time` was cleared so `scheduled_time = now_ts` → **no extra wait** for “next run”. Optional **first-cycle startup offset**: `random.uniform(0, cycle_sec / total_workers)` to desynchronize workers. | Cycle from config (e.g. 3600 s); first run is “due now” | **[user_log]** (→ `data/logs/<name>.log`): `[Scheduler] session=... next_run=...`; optionally `[PostingScheduler] ... decision=posting` |
| 16 | `users.py` | **Connect** Telethon for this cycle; load groups; **post** (forward or send message) to each assigned group with gap (min 4–6 s). | Connection only for duration of cycle; then disconnect | **Log group**: cycle-start line (e.g. "session.session N groups"); then per-post success/failure lines (batched). **User log file**: `[SESSION] ... [GROUP] ... [ACTION] post_attempt [STATUS] success|failure`. **Console**: worker prefix `[worker-N]` in worker process logs |

---

### Log destinations (where each type goes)

| Log type | Source | Destination | Notes |
|----------|--------|--------------|--------|
| **Controller bot (user actions)** | `log_bot_event(bot_token, msg)` | File: `cfg["log_file"]` or `data/logs/<name>.log` | e.g. "User … clicked Run — posting started" |
| **Log group (Telegram)** | `enqueue_log(bot_token, msg)` or worker `report_log` → controller `enqueue_log` | Telegram log group (PTB) | Cycle-start lines; "Started Adbot"; post results (batched). Consumer: `_log_queue_consumer` on main loop |
| **User log file (scheduler/diagnostics)** | Worker `report_user_log(msg)` → controller `_apply_worker_result` → `append_to_user_log` | Same file as above: `data/logs/<name>.log` | [Scheduler], [FloodShield], [FloodWait], [PostingScheduler], [ShardCheck] |
| **Post attempt (structured)** | Worker `report_post_attempt` → controller → `append_to_user_log` | Same file | `[SESSION] ... [GROUP] ... [ACTION] post_attempt [STATUS] ... [ERROR] ... [TIME] ...` |
| **Console (main process)** | `logger.info` / `logger.warning` in `users.py`, `main.py` | Stdout of main process | e.g. "[posting] START sent to worker_id=...", "Started posting for bot ..." |
| **Console (worker process)** | `logger` in `workers.py` and `users._async_session_loop` (in worker) | Stdout of each worker process | Prefixed with `[worker-N]` by `WorkerLogFilter` |
| **Audit (forensic)** | Worker `report_audit_log` → controller → `logger` / adbot audit | Main process logger / adbot.log (if configured) | SESSION_STOPPED, SESSION_CYCLE_START, SESSION_DELAYED, etc. |

**Log group flow (high level):** Worker posts success/failure → `report_log` → `result_queue` → main process `_worker_result_handler_async` → `_apply_worker_result` → `enqueue_log(bot_token, message)` → `_log_queue` → `_log_queue_consumer` (main loop) → `notify.notify_log_group` (PTB → Telegram).

---

### Estimated time until posting actually starts

- **Immediate (same process):** Button click → validations → `_save_bot_config("running")` → `_start_posting` called.  
  If **no** pending STOP cleanup: worker spawn and START send usually complete in **a few seconds** (e.g. 2–5 s).

- **After START:**  
  - **First session (ordinal 0)** in **Starter** mode: stagger = 0. Then one **random startup offset** `0 … cycle_sec/total_workers` (e.g. 0–360 s for cycle 3600 and 10 workers). Then connect and post.  
  - **First session in Enterprise:** stagger = 0; same startup offset.  
  - **Other sessions:** Starter stagger up to ~1 h (spread over 1 h); Enterprise second half after 5 min.

So:

- **Best case (first session, no cleanup, minimal offset):** ~**2–10 s** from Run click to first post (process start + connect + first post).
- **Typical (first session, no cleanup, average offset):** ~**30 s – 3 min** from Run click to first post (e.g. cycle 3600, 10 workers → offset up to 360 s).
- **Worst case:** Pending STOP cleanup up to **50 s** + last session in Starter mode stagger up to **3600 s** + startup offset. So **up to ~1 h** for the last session’s first post in Starter with many sessions.

**Summary:** The **UI** updates to "Running." and **log group** gets "Started Adbot" as soon as `_start_posting` returns (seconds). The **first post** to a group can be as fast as a few seconds for the first session or up to tens of minutes / 1 h depending on stagger and startup offset.
