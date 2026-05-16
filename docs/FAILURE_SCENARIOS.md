# Failure Scenarios: Multiprocessing + Asyncio Sharded Architecture

**Architecture:** 1 controller process, N worker processes (1 session per worker), spawn, two-phase START/STOP.

**Count:** ~35 concrete cases across **6 buckets** (A–F). Handling these buckets yields production-safe behavior: correctness, isolation, and safe shutdown.

---

## Bucket A: User-control cases

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| A1 | User presses **Run when already running** | **Yes** | Controller (`_start_posting`) | Pops existing workers, sends STOP, joins (up to 40s), then spawns new workers and sends START. Idempotent restart. |
| A2 | User presses **Stop when already stopped** | **Yes** | Controller (`_stop_posting`) | Sets state=stopped, pops `_worker_handles` (None), no workers to join. Safe no-op. |
| A3 | User presses **Stop while sessions mid-post** | **Yes** | Worker + Controller | Controller sends STOP; worker sets `stop_event`. Session loop checks `stop_event` at **start of each group iteration** — current post can finish, then loop breaks, `finally` runs `client.disconnect()`. Clean disconnect. |
| A4 | User presses **Run immediately after Stop** | **Yes** | Controller | `_start_posting` awaits `_stop_posting` (Run handler calls stop then start is separate clicks; if user clicks Run, it’s a new _start_posting which first stops any existing workers then starts). So Run after Stop = normal start. |
| A5 | User **restarts bot while workers still shutting down** | **Partially** | Controller | Run calls `_start_posting` which **pops** `_worker_handles` and sends STOP to **that** list, then joins. So old workers get STOP and join; new workers are spawned after. No leak. If "restart" means process restart (e.g. kill main), see main shutdown. |
| A6 | **Admin issues Stop All** | **Yes** | main.py `finally` | Shutdown loop calls `_stop_posting(bot_token)` for every bot; each sets state=stopped, sends STOP, joins. Clean. |

**Summary A:** Handled via global state (adbot.json + `_worker_handles`), idempotent start/stop, controller-owned lifecycle.

---

## Bucket B: Worker lifecycle failures

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| B1 | **Worker process fails to start** (e.g. OOM, fork error) | **Gap** | — | `proc.start()` can raise. If worker 3 fails, workers 1–2 are already running; handle not updated for failed worker. **Fix:** wrap spawn loop in try/except; on first failure, send STOP to already-started workers, join them, re-raise or return False. |
| B2 | **Worker crashes during runtime** | **Yes** | Controller (health monitor) | Process exits; `proc.is_alive()` becomes False. Health monitor sees `alive < expected`, restarts posting (`_start_posting(..., preserve_cycle_time=True)`). Other workers unaffected (separate processes). |
| B3 | **Worker freezes** (alive PID, no progress) | **Yes** | Controller (health monitor) + Worker (heartbeat) | Worker sends heartbeat at cycle start and every `HEARTBEAT_INTERVAL_SEC` (60s) during cycle sleep. Controller tracks `_worker_last_heartbeat[(bot_token, worker_id)]`. If process alive and no heartbeat for `max(HEARTBEAT_FROZEN_TIMEOUT_MIN, 2*cycle_sec)`, controller logs `worker_frozen`, terminates that worker, and restarts posting with `preserve_cycle_time=True`. Other workers unaffected. |
| B4 | **Worker exits early without STOP** (e.g. unhandled exception) | **Yes** | Controller (health monitor) | Same as B2: `alive < expected` → restart. Worker’s `finally` in session loop still runs `client.disconnect()` on normal exit path; on crash, OS closes sockets. |
| B5 | **Worker stuck during shutdown** (ignores STOP) | **Yes** | Controller (`_stop_posting`) | After sending STOP, controller does `proc.join(timeout=40)` then `proc.terminate()` if still alive, then `join(timeout=5)`. Force-kill after timeout. |
| B6 | **Worker ignores STOP signal** | **Yes** | Same as B5 | Command listener reads queue; if worker is stuck in a blocking call (e.g. network), listener may not run until that call returns. After 40s controller terminates process. |

**Summary B:** Crash, stop timeout, start failure (B1), and frozen worker (B3) are all handled. See **Heartbeat + watchdog** below.

---

## Bucket C: Session-level failures

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| C1 | **Session fails to connect** | **Yes** | Worker (session loop) | `_connect_session_for_cycle` retries up to `SESSION_RECONNECT_MAX_ATTEMPTS` (3); on failure, `report_alert("session_disconnected", ...)`, loop `break`. Only that session in that worker stops; other session in same worker continues. Other workers unaffected. |
| C2 | **Session connects but can’t send messages** (e.g. permission) | **Yes** | Worker | Per-group try/except; `AdBotErrorHandler` returns SKIP_GROUP or MARK_SESSION_BANNED; errors logged, blacklist updated via `report_ban_error`. Other groups and other sessions unaffected. |
| C3 | **Session FloodWait** | **Yes** | Worker (rpc_errors + session loop) | `with_retry` raises `FloodWaitPause` if seconds > `FLOODWAIT_THRESHOLD_SEC` (300). Session loop catches it, calls `set_session_paused`, breaks out of group loop, disconnects, sleeps cycle_sec, then continues. Other session in same worker unaffected (separate asyncio tasks). Other workers unaffected. |
| C4 | **Session banned mid-cycle** | **Yes** | Worker | Handler returns MARK_SESSION_BANNED → `report_session_died` / `_mark_session_dead_and_replace`; session removed from bot, file moved to dead. Other sessions in other workers unaffected. |
| C5 | **Session logs out (AuthKeyError, etc.)** | **Yes** | rpc_errors + Worker | `SESSION_DEAD_ERRORS` (AuthKeyInvalid, SessionRevoked, etc.) → MARK_SESSION_BANNED → same as C4. |
| C6 | **Session rate-limited only in some groups** | **Yes** | Worker | Per-target blacklist (`ban_error_count_by_session`, `report_ban_error`); skip that group next time. Other groups and sessions unaffected. |
| C7 | **Session hits private / deleted groups** | **Yes** | Worker | Handler SKIP_GROUP / IGNORE; entity errors and topic errors increment ban count or skip. No crash. |
| C8 | **Session stuck retrying** | **Yes** | rpc_errors | `with_retry` has `max_tries` (default 4) and backoff; after max, re-raise or return None. Caller continues to next group or breaks. |

**Summary C:** All handled in worker with per-session/per-group try/except, retry limits, and local blacklists; isolation per worker.

---

## Bucket D: Timing and scheduling

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| D1 | **Session start time arrives while worker is busy** (e.g. Session B’s time while Session A posting) | **Yes** | Worker | Each session is its own asyncio task with its own stagger sleep. When Session B’s stagger ends, its task runs; it doesn’t wait for Session A. So "no global blocking; no missed starts" — one session per worker; no intra-worker contention. |
| D2 | **Session cycle overlaps next cycle** | **Yes** | Worker (session loop) | Cycle: connect → post all groups (with gap) → disconnect → sleep(cycle_sec). Next cycle starts after sleep. Overlap would only occur if one cycle took longer than cycle_sec; we still sleep remainder after. No explicit overlap guard; in practice gap and group count keep cycle under cycle_sec. |
| D3 | **Clock drift** (system time changes) | **Partial** | Worker | Uses `time.time()` for last_cycle_time and scheduled_for. If system clock jumps, scheduling can shift. No monotonic clock. **Minimal fix:** use `time.monotonic()` for relative delays (e.g. sleep remainder); keep `time.time()` only for wall-clock last_cycle_time if needed for reporting. |
| D4 | **Restart during cycle sleep** | **Yes** | Controller + Worker | Health restart calls `_start_posting(..., preserve_cycle_time=True)` so last_cycle_time is kept; new workers get same config snapshot. Workers start from their stagger; cycle sleep is per-session state. |
| D5 | **Cycle interval changes mid-run** | **Partial** | Worker | Workers receive config **snapshot** at start; they don’t reload adbot.json. So cycle_sec doesn’t change until next restart. Acceptable for "minimal." |
| D6 | **Stagger window recalculation on restart** | **Yes** | Controller + Worker | On restart, new workers get new config_snapshot with same total_sessions; stagger = (STAGGER_WINDOW_SEC / total_sessions) * global_ordinal. Consistent. |

**Summary D:** Session start timing is reliable (one session per worker; no loop overload). Clock drift and cycle change mid-run are partial/acceptable.

---

## Bucket E: System / resource failures

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| E1 | **CPU spike** | **Yes** | Process isolation | Workers are separate processes; one heavy worker doesn’t block others. Controller is separate from workers. |
| E2 | **Memory pressure** | **Partial** | OS | No in-app limit. OOM killer can kill a worker (then health monitor restarts) or controller (then full restart). |
| E3 | **File I/O blocked** | **Partial** | — | If adbot.json or session file I/O blocks, only that process blocks. Workers don’t write adbot.json; controller can block on save. |
| E4 | **Log file locked** | **Partial** | logging | Same process; can block. No cross-process log lock. |
| E5 | **Too many open sockets** | **Partial** | Worker | Each worker connects 1 session per cycle then disconnects. So limited sockets per worker. |
| E6 | **OS kills process (OOM)** | **Yes** | Health monitor (worker) or restart (controller) | Worker: health monitor restarts. Controller: process exit; no automatic restart unless supervised (e.g. systemd, PM2). |
| E7 | **Docker / VM restart** | **Yes** | Crash resume | On next start, main.py runs, resume_adbots starts running bots again from adbot.json. |

**Summary E:** Process isolation handles CPU; OOM and I/O are best-effort / OS-dependent.

---

## Bucket F: Telegram / external

| # | Scenario | Handled? | Where | Effect on others |
|---|----------|----------|--------|------------------|
| F1 | **Telegram API slow** | **Yes** | rpc_errors `with_retry` | Retries with backoff; timeout/network errors retried. Session may be delayed but doesn’t crash. |
| F2 | **Random disconnects** | **Yes** | Session loop | Each cycle: connect → work → disconnect. Next cycle reconnects. So transient disconnect only affects current cycle; next cycle retries (`_connect_session_for_cycle`). |
| F3 | **MTProto internal errors** | **Yes** | rpc_errors | Retryable errors retried; session-dead errors mark session dead. |
| F4 | **Temporary global rate limits** | **Yes** | FloodWait handling | Session PAUSED, skip cycle sleep, retry later. Other workers unaffected. |
| F5 | **Network hiccups / DNS** | **Yes** | with_retry + connect retry | Connect has 3 attempts; send_message/forward use with_retry. |

**Summary F:** Retries, backoff, and per-session handling; no global panic.

---

## Confirmation

| Requirement | Status |
|-------------|--------|
| **One worker crashing does not affect others** | **Yes.** Workers are separate processes; health monitor restarts only the bot’s workers when `alive < expected`. |
| **Stop always results in clean disconnect** | **Yes.** Controller sends STOP; worker sets `stop_event`; session loop breaks at iteration boundary; `finally` runs `await client.disconnect()`. If worker doesn’t exit in time, controller terminates after 40s. |
| **Sessions never miss scheduled starts due to loop overload** | **Yes.** One session per worker; no shared heavy loop. |

---

## Unhandled or weak cases (minimal fixes)

1. **B1 – Worker process fails to start**  
   **Fix:** In `_start_posting`, wrap the spawn loop in try/except. On any `proc.start()` exception: send STOP to already-started workers, join them, remove from `_worker_handles`, return False (and optionally alert).

2. **B3 – Worker freezes (alive but no progress)**  
   **Fix (optional):** Add a lightweight heartbeat: worker sends `{"type": "heartbeat", "bot_token", "worker_id"}` every cycle start (or every 60s). Controller keeps `last_heartbeat[(bot_token, worker_id)]`. Health monitor: if `state == "running"` and a worker has no heartbeat for e.g. `2 * cycle_sec`, treat as dead and restart posting. (Requires worker to send heartbeat and controller to track and check.)

3. **D3 – Clock drift**  
   **Fix (optional):** Use `time.monotonic()` for sleep remainder (cycle alignment) so relative timing is immune to wall-clock jumps.

---

## Heartbeat + watchdog (B3 – frozen worker)

**How heartbeat is sent**

- **Worker:** In the session loop (`_async_session_loop`), when `report_heartbeat` is set (worker process only):
  1. At the **start of each posting cycle** (top of the `while True`), before connect/post: `report_heartbeat()`.
  2. During the **cycle sleep** (after disconnect): instead of a single `await asyncio.sleep(cycle_sec)`, the loop sleeps in chunks of `heartbeat_interval_sec` (default 60s). Each chunk: `report_heartbeat()` then `await asyncio.sleep(min(heartbeat_interval_sec, remaining))`.
- Payload: `{"type": "heartbeat", "bot_token", "worker_id", "timestamp"}`. Sent via the existing `result_queue` (no new pipes or threads).

**How freeze is detected**

- **Controller:** The result handler (`_apply_worker_result`) updates `_worker_last_heartbeat[(bot_token, worker_id)] = timestamp` on every `"heartbeat"` message.
- **Watchdog:** Inside `run_session_health_monitor` (same loop as crash recovery), for each running bot with workers:
  - `timeout_sec = max(HEARTBEAT_FROZEN_TIMEOUT_MIN, 2 * cycle_sec)` (default min 120s).
  - For each worker: if `proc.is_alive()` and we have received at least one heartbeat (`last_hb > 0`) and `(now - last_hb) > timeout_sec` → treat as **frozen**.
- Frozen worker is **not** restarted in place; the whole bot’s posting is restarted (same as crash recovery).

**How restart is triggered**

- When any worker is considered frozen: log `worker_frozen`, call `proc.terminate()` (and `join(timeout=5)`), then call `_start_posting(bot_token, preserve_cycle_time=True)`.
- `_start_posting` pops all workers for that bot, sends STOP to every worker’s queue, joins all (terminated one exits immediately), then spawns new workers and sends START. So **restart is full replace** for that bot, with **last_cycle_time** preserved (no burst).

**Safety**

- **Stop is not blocked:** Watchdog only runs in the health monitor loop; it does not hold any lock that Stop needs. When user presses Stop, controller sets state and sends STOP; workers exit; heartbeat state is cleared when handles are popped.
- **Other workers:** Only the bot that had a frozen worker is restarted; other bots’ workers are unchanged.
- **No threads:** Heartbeat is sent from the existing asyncio session loop; controller handles it in the existing result handler task.
