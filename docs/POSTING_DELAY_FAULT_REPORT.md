# Posting Delay / Random Cycle Stop — Definitive Fault Report

**Full execution-flow audit (Phases 1–6, timeline table, delay audit, determinism, assignment, worker lifecycle, patches, checklist):** see [EXECUTION_FLOW_AUDIT.md](EXECUTION_FLOW_AUDIT.md).

## Phase 1 — Scheduler timing validation

### Timeline trace: Run → first post

| Step | Location | Action | Potential delay |
|------|----------|--------|------------------|
| 1 | User presses Run | Callback fires | 0 |
| 2 | `users.py` ~2545 | `_start_posting()`: await pending STOP cleanup | 0–50s if previous stop not finished |
| 3 | `users.py` ~2564 | `cycle_anchor_ts = time.time()` persisted | 0 |
| 4 | `users.py` ~2566 | `_build_worker_config_snapshot(cfg, …)` with `run_first_cycle_immediately=True` | 0 |
| 5 | `users.py` ~2616–2624 | Worker processes started; START sent to each | 0 |
| 6 | `workers.py` ~260–262 | Worker waits for START (already sent) | 0 |
| 7 | `users.py` ~1210–1214 | **Stagger**: skipped when `run_first_cycle_immediately` | 0 (if skipped); else up to 3600s (Starter) or 300s (Enterprise) |
| 8 | `users.py` ~1248–1260 | **Global flood shield**: if `global_pause_until > now` → sleep until wait_until | Not skipped by run_first; can delay arbitrarily |
| 9 | `users.py` ~1274–1289 | **Cooldown**: if session in cooldown → sleep until cooldown_until | Not skipped by run_first; up to 15 min |
| 10 | `users.py` ~1299–1318 | **next_cycle_time**: with run_first_cycle_immediately set to `now_ts`; delta_sec=0 | 0 |
| 11 | `users.py` ~1322–1336 | If delta_sec > 0: sleep in chunks | 0 when run_first used |
| 12 | `users.py` ~1421–1446 | **Per-session FloodWait**: if pause_until > now → sleep until pause_until | Not skipped; can delay arbitrarily |
| 13 | Posting runs | First post | — |

**Conclusion:** Stagger is correctly skipped when `run_first_cycle_immediately` is True. Cooldown, global flood shield, and per-session FloodWait are **not** skipped and can delay first post; they are intentional (safety / rate limits).

### next_cycle_time formula

- **Code:** `users.py` 1300–1302, 1310–1312  
- **Formula:** `cycle_anchor = cfg.get("cycle_anchor_ts") or now_ts`; `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec`.  
- When `run_first_cycle_immediately` and not done: `next_cycle_time = now_ts`, `delta_sec = 0`.  
- **No recalculation from `time.time()` for the boundary itself**; only `now_ts` is used for delta. Anchor is read from config (snapshot), not reset inside the worker loop.

### Anchor reset points

- **users.py 2564:** `cycle_anchor_ts = time.time()` only when `not preserve_cycle_time` (fresh Run).  
- **users.py 1930:** Snapshot uses `cfg.get("cycle_anchor_ts") or time.time()` at **build** time (so new runs get an anchor).  
- **No other assignment to `cycle_anchor_ts`** in the codebase. Health restarts use `preserve_cycle_time=True` and do not reset the anchor.

---

## Phase 2 — Worker lifecycle stability

### Restart triggers

| Trigger | File:line | Condition | Can interrupt active cycle? |
|---------|-----------|-----------|-----------------------------|
| Heartbeat frozen | `users.py` 2873–2905 | `now < grace_until` → skip. Else if no heartbeat for `timeout_sec` → `_restart_single_worker` | Yes: sends STOP to worker, joins, spawns new process |
| Startup failure | `users.py` 2915–2942 | After grace, if not in `_worker_first_cycle_or_post` and `now > start_ts + 600`. **Skip if `pause_until > now`** | Yes, if triggered |
| alive < expected | `users.py` 2948–2965 | Only when `alive < expected`; **skip if `alive == expected`** and **skip if not `bot_runtime_state.running`** | N/A (full restart) |

### Can restart happen while worker is still alive?

- **Heartbeat frozen:** Yes. Process can be alive but not sending heartbeats (e.g. stuck in long sleep or blocking call). After `timeout_sec` (e.g. max(120, 2*cycle_sec)) the health monitor restarts that worker.  
- **Startup failure:** Only after 600s with no cycle/post and not in `_worker_first_cycle_or_post`; and we skip if session is in FloodWait. So it can’t fire during normal first cycle.  
- **alive < expected:** Only when a process has actually died; then full `_start_posting(..., preserve_cycle_time=True)` runs. Anchor is preserved.

### next_run / anchor after restart

- **`_restart_single_worker`** (`users.py` 2409): builds snapshot with `_build_worker_config_snapshot(cfg, total_sessions)` (no `run_first_cycle_immediately`). Snapshot includes `cycle_anchor_ts` from current `cfg` (persisted). New worker uses same anchor; next_run remains `cycle_anchor_ts + (k)*cycle_sec`. **Anchor not reset on single-worker restart.**

---

## Phase 3 — Group assignment correctness

### _assigned_groups_for_session flow

1. Excluded check (`users.py` 982–984).  
2. FloodWait: `session_pause_until` > now → return [] (987–991).  
3. Cooldown: `session_cooldown_until` > now → return [] (994–999).  
4. Starter: full list, rotated by cycle index (1001–1004).  
5. Enterprise: if `active_session_files` present, session must be in list else []; partition by `len(active_session_files)` (1006–1019).

### Stale active_session_files (root cause of “random” zero groups after FloodWait)

- **Problem:** Snapshot is built once at start. `active_session_files` is computed then (paused sessions omitted). When FloodWait clears, controller sends **config_patch** with updated `session_pause_until` only. Worker’s `get_config()` merges patch, so `session_pause_until` is updated, but **active_session_files** in the worker remains the old snapshot list. So the cleared session is still not in `active_list` and gets `return [], len(all_groups)` in Enterprise.  
- **Reproducible scenario:** Enterprise, 5 sessions, 124 groups. One session hits FloodWait; controller later clears its pause via cycle_done and sends config_patch(session_pause_until). That session still has stale `active_session_files` (4 entries). Assignment does `session_file not in active_list` → []. Posting “stops” for that session until bot restart.  
- **Fix applied:** When pushing config_patch after cycle_done, also compute and send **active_session_files** from current cfg so workers see the updated active list and cleared sessions get groups again without restart.

### Assignment distribution example (5 sessions, 124 groups, all active)

- **Starter:** Each session gets 124 groups (full list).  
- **Enterprise:** `active_session_files` = [s1, s2, s3, s4, s5]. Partition: 124/5 → 24,24,25,25,26 (or similar). Each active gets ≥1.  
- **Enterprise with 2 paused:** At start snapshot `active_session_files` = [s1, s2, s3]. s4, s5 get []. After config_patch with updated pause + **active_session_files** = [s1,s2,s3,s4,s5], s4 and s5 get a share on next cycle.

### Assignment runs once per cycle

- Assignment is called inside the scheduler loop at `users.py` ~1448, once per cycle when entering the posting phase. Not cached across cycles; `get_config()` is called each loop iteration, so merged config (including config_patch) is used every time.

---

## Phase 4 — Async blocking / queue stalls

### Logging

- **users.py 54–66:** `enqueue_log` uses `put_nowait` on a bounded queue (500). On `queue.Full` it ignores. **Does not block** the caller.  
- Consumer runs in a separate loop with `await asyncio.sleep(...)`; **posting loop never awaits** on log send. No backpressure from logging to posting.

### Interprocess queues

- **Worker → controller:** `result_queue.put(...)` in worker. Queue is multiprocessing; put can block if queue is full (default is unbounded), so in practice no block.  
- **Controller → worker:** `cmd_queue.put({"cmd": "config_patch", ...})` and stop/start. Same as above.  
- **config_patch:** Applied in worker’s command_listener; `local_config_patch.update(patch)`. No await; no blocking of the session loop. Session loop calls `get_config()` which reads merged config; no queue wait there.

**Conclusion:** No queue or logging path blocks the worker coroutine or cycle loop or delays next cycle execution.

---

## Phase 5 — Deterministic cycle enforcement

### Invariant: cycles at deterministic intervals

- **next_cycle_time** is always derived from **cycle_anchor_ts** and **cycle_sec**: `cycle_anchor + (cycle_index + 1) * cycle_sec`.  
- **cycle_anchor_ts** is set only once per Run at `users.py` 2564 (when `not preserve_cycle_time`). Health restarts do not reset it.  
- Workers never set `cycle_anchor_ts = time.time()` in the loop; they only read it from config.

### Where cycle_anchor_ts is set

- **users.py 2564:** `_save_bot_config(bot_token, lambda c: c.update({"cycle_anchor_ts": time.time()}))` — only on fresh start.  
- **users.py 1930:** Snapshot default `cfg.get("cycle_anchor_ts") or time.time()` — used only when building the snapshot (so new runs get an anchor). No reset in worker.

### Workers do not “miss” a cycle

- Cycle is driven by sleep until `scheduled_time` then one cycle run. If the process is killed, that cycle is lost (by design). If the process is restarted, the new process uses the same anchor and will run at the next boundary. No drift from anchor.

---

## Exact causes and minimal patches

### FAULT 1: Enterprise session gets zero groups after FloodWait clears (no restart)

- **Cause:** config_patch after cycle_done sent only `session_pause_until`. Worker’s `active_session_files` stayed the snapshot value (built when session was paused), so in `_assigned_groups_for_session` the session was not in `active_list` and received [].  
- **File:** `users.py`  
- **Function:** block after `_save_bot_config(bot_token, upd)` in `cycle_done` handling  
- **Patch (APPLIED):** When pushing config_patch to workers, also send `active_session_files`: compute `active_list = _active_session_files(cfg_after)` and include in patch so workers merge it. Cleared FloodWait sessions re-enter the active list and get groups on the next cycle.

### FAULT 2: (No additional fault requiring code change)

- Stagger is already skipped when `run_first_cycle_immediately` is True.  
- Cooldown / global flood / per-session FloodWait are intentional and not skipped for first cycle (safety).  
- Anchor is not reset on health or single-worker restart.  
- Log queue is non-blocking; no patch needed.  
- Startup-failure restart already skips when session is in FloodWait.

---

## Verification method (deterministic scheduling)

1. **First post within 1–2s after Run (no cooldown / no global pause):**  
   Run bot with all sessions active and no FloodWait/cooldown. Confirm first “Posted in” or post attempt in logs within 1–2s. Confirm log has `[CycleAnchor] first cycle immediately session=...` and no stagger sleep.

2. **Enterprise FloodWait reintegration:**  
   Run Enterprise with 3+ sessions. Force or wait for FloodWait on one session. After it completes a cycle and controller clears pause, confirm next cycle that session gets groups (check logs for assigned count > 0). No restart.

3. **Anchor stability across health restart:**  
   Run bot; note `cycle_anchor_ts` (e.g. from logs or debug). Trigger a single-worker restart (e.g. kill one worker process). Confirm new worker logs next_cycle_time aligned to same anchor (e.g. `cycle_anchor_ts + k*cycle_sec`).

4. **No late posting from cooldown (intended):**  
   If a session is in cooldown at Run, first cycle for that session is delayed until cooldown_until. This is expected; no patch.

---

## Summary table

| Issue | Root cause | Location | Patch |
|-------|------------|----------|--------|
| Enterprise session gets 0 groups after FloodWait clear | config_patch did not update `active_session_files`; worker kept stale list | `users.py` ~1977–1987 (cycle_done config_patch) | Include `active_session_files` in patch (done) |
| Late first post (stagger) | N/A | — | Already skipped when run_first_cycle_immediately |
| Anchor reset on restart | N/A | — | Not reset; preserve_cycle_time used |
| Log blocking posting | N/A | — | put_nowait + bounded queue |
| Restart while paused | N/A | — | Startup-failure skip when pause_until > now |
