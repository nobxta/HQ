# AdBot Worker Startup and First-Post Latency — Report

## 1. Blocking points: Run → Scheduler cycle triggered → First successful post

| Phase | File | Function | Line(s) | What blocks | Max delay (before) |
|-------|------|----------|---------|-------------|--------------------|
| Run → START sent | users.py | _start_posting | 2455–2669 | Pending STOP, status sleeps (4×0.2s), spawn | 0.8 s + teardown |
| START → loop iteration | workers.py | worker_main_async | 284–296 | Wait for START (already in queue) | ~0 |
| Loop → cycle trigger | users.py | _async_session_loop | 1209–1398 | Stagger (skipped when run_first), global/cooldown/FloodWait, delta sleep (0 when run_first) | 0 when run_first |
| Cycle trigger → connect | users.py | _async_session_loop | 1429–1437 | **Previously:** `await _connect_session_for_cycle()` every cycle | **60–120+ s** (Telethon connect) |
| Connect | users.py | _connect_session_for_cycle | 1146–1232 | **Previously:** no timeout; `client.connect()` + auth | Unbounded |
| Connect → first post | users.py | _async_session_loop | 1448+ | Assignment, DM handler, first post | ~1–5 s |

**Main cause of “first post several minutes late”:** Connect ran **after** “Scheduler triggering cycle” and had no timeout, so a single slow Telethon connect (TCP + MTProto handshake + auth) could block 60–120+ seconds.

---

## 2. _connect_session_for_cycle() and Telethon connect paths

**Before changes:**

- **users.py 1143–1166 (old):** One `await client.connect()` per attempt, no timeout, no timing logs, no heartbeat during connect. Time was spent in:
  - **client.connect():** TCP connect, TLS, MTProto handshake (often 10–90+ s under load).
  - **Session load / auth:** `is_user_authorized()` after connect (usually &lt;1 s).
  - **Retries:** Up to 3 attempts with 5 s delay between them.

**After changes (exact locations):**

| What | File | Function | Line(s) |
|------|------|----------|---------|
| Connect timeout | users.py | _connect_session_for_cycle | 1195: `await asyncio.wait_for(connect_task, timeout=SESSION_CONNECT_TIMEOUT_SEC)` (constant 1081: 25 s) |
| Heartbeat during connect | users.py | _connect_session_for_cycle | 1178–1198: background task runs `report_heartbeat()` every `SESSION_CONNECT_HEARTBEAT_INTERVAL_SEC` (8 s) while connect runs |
| Connect start log | users.py | _connect_session_for_cycle | 1154–1157: `[Connect] session=... connect_start attempt=...` + report_user_log |
| Connect end / duration | users.py | _connect_session_for_cycle | 1204–1209: `[Connect] session=... connect_end duration_sec=...` + report_user_log |
| Connect failure / duration | users.py | _connect_session_for_cycle | 1210–1219: `connect_failed ... duration_sec=...` on exception or timeout |
| Retry on timeout | users.py | _connect_session_for_cycle | 1196–1202: on TimeoutError, cancel connect task, log, then raise and retry after SESSION_RECONNECT_DELAY_SEC |

**Measuring connect time per session:** Grep user log or adbot.log for:

- `[Connect] session=... connect_start`
- `[Connect] session=... connect_end duration_sec=...` or `connect_failed ... duration_sec=...`

From these lines you can compute per-session average and worst-case connect time.

---

## 3. Connections: fresh every cycle → reused between cycles

**Before:** Each cycle did connect at start and disconnect at end (users.py 1353, 1852). Connections were **new every cycle**.

**After:**

- **users.py 1286–1302:** Pre-warm: right after creating the client and before the main loop, workers call `_connect_session_for_cycle(...)` once so the session is connected before the first cycle.
- **users.py 1429–1447:** At cycle start we **only** call `_connect_session_for_cycle` if `not client.is_connected()` (reuse existing connection; reconnect only when dropped or after FloodWait).
- **users.py 1876–1880 (removed disconnect):** We no longer disconnect at end of cycle. Session stays connected between cycles.
- **users.py 1448–1458 (unchanged):** On FloodWait we still disconnect and sleep until unblock, then next cycle will reconnect.
- **users.py 1892–1895 (finally):** On worker exit we disconnect.

So: **sessions stay connected between cycles; reconnect only when connection is down or after FloodWait.**

---

## 4. Connection pre-warming

- **Where:** users.py 1286–1310, in `_async_session_loop`, after `pending_groups = []` and before `while True`.
- **What:** If `is_worker`, we start a background task `_prewarm_connect()` that calls `_connect_session_for_cycle(...)` once and sets `session_ready.set()` on success. Logs: `prewarm_start`, `prewarm_ready`, or `prewarm_failed (will retry at first cycle)`.
- **Scheduler:** First cycle runs when `run_first_cycle_immediately` (no boundary wait). By then pre-warm has already been started (and usually completed), so “trigger cycle” → “ensure connected” often finds `client.is_connected()` true and **skips connect**, so first cycle proceeds as soon as pre-warm sets ready; Run to first post is about pre-warm completion time (often under 30 s) plus assignment and first send.

---

## 5. Safety timeout

- **Constant:** users.py 1081: `SESSION_CONNECT_TIMEOUT_SEC = 25`.
- **Use:** users.py 1195: `await asyncio.wait_for(connect_task, timeout=SESSION_CONNECT_TIMEOUT_SEC)`.
- **On timeout:** Connect task is cancelled (1197–1202), timeout is logged, exception is re-raised and caught (1210), then we retry after `SESSION_RECONNECT_DELAY_SEC` (1222). So the scheduler is not blocked for more than 25 s per attempt; we retry without blocking the cycle indefinitely.

---

## 6. Heartbeat during connect

- **users.py 1178–1198:** Before `wait_for(connect_task, ...)` we start a task that calls `report_heartbeat()` every `SESSION_CONNECT_HEARTBEAT_INTERVAL_SEC` (8 s). That task is cancelled in `finally` when the wait finishes. So during a 25 s connect we send heartbeats and avoid the health monitor treating the worker as frozen (heartbeat timeout is 120 s).

---

## 7. Report: connect times and Run → first post

**From logs (e.g. nobi.log) before optimization:**

- Run → first post: **~77–108 s** (connect in the critical path after “triggering cycle”).
- Connect is the dominant cost; no per-session averages were logged (only post times).

**After optimization:**

- **Connect time per session:** Use log lines `[Connect] session=... connect_end duration_sec=X` (and optionally `connect_failed ... duration_sec=X`). Average = sum of durations / count; worst = max of durations.
- **Run → first post:**
  - **Target:** Pre-warm runs as soon as the worker starts; first cycle runs immediately (run_first_cycle_immediately). So Run → first post ≈ controller (~0.8 s) + time until first session is ready and first cycle triggers. If pre-warm finishes before the first cycle (typical when connect &lt; ~30 s), first post happens within **~2–5 s** of Run (controller + assignment + first send). If pre-warm is slow, first cycle may still wait on “ensure connected” (with 25 s timeout per attempt).
  - **Benchmark:** Run the bot, measure from “Run” click to first “[SESSION] … post_attempt [STATUS] success” (or “Posted in …”) in the user log. Compare before (no pre-warm, disconnect each cycle) vs after (pre-warm, stay connected). Expected: **large reduction** when connect is slow (e.g. from ~90 s to ~3–5 s when pre-warm succeeds before first cycle).

---

## 8. Exact file / function / line changes (minimal patch set)

| Change | File | Function | Line(s) |
|--------|------|----------|---------|
| Add SESSION_CONNECT_TIMEOUT_SEC, SESSION_CONNECT_HEARTBEAT_INTERVAL_SEC | users.py | (module) | 1080–1083 |
| Rewrite _connect_session_for_cycle: optional report_heartbeat, report_user_log; timeout; start/end/duration logs; heartbeat task during connect | users.py | _connect_session_for_cycle | 1146–1232 |
| Pre-warm: start background task _prewarm_connect() before main loop (workers only); session_ready Event | users.py | _async_session_loop | 1286–1310 |
| At cycle start: wait for session_ready (timeout 30s) if not connected; then only connect if still not client.is_connected(); pass report_heartbeat, report_user_log | users.py | _async_session_loop | 1438–1465 |
| Remove disconnect at end of cycle (keep connected between cycles) | users.py | _async_session_loop | 1876–1880 (replaced block) |
| Docstring: “pre-warm; stay connected between cycles” | users.py | _async_session_loop | 1190–1193 |

---

## 9. Benchmark: Run → first post (expected)

| Scenario | Before | After |
|----------|--------|--------|
| Connect ~80 s (e.g. nobi.log) | Run → first post ~80–108 s | Pre-warm runs in background; first cycle sees session already connected → Run → first post ~2–5 s |
| Connect ~5 s | Run → first post ~6–10 s | Pre-warm often done before first cycle → Run → first post ~2–4 s |
| Connect timeout (25 s) then retry | N/A (could block 60+ s) | First attempt times out at 25 s; retry; heartbeat every 8 s so no false “worker frozen” |

**How to benchmark:** Run the bot, note time of Run click, then note time of first “Posted in …” or first `[SESSION] ... post_attempt [STATUS] success` in the user log. Compare runs with the same sessions/groups before and after this patch set.
