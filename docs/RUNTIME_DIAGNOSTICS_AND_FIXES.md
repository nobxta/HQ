# Runtime Diagnostics and Correction Analysis — AdBot Scheduler & Posting Engine

## Root cause summary

| Issue | Root cause | Fix |
|-------|------------|-----|
| **First post delayed several minutes** | (1) Stagger sleep (Starter: up to 1h; Enterprise: 5 min for second half) ran before first cycle. (2) `run_first_cycle_immediately` already set first cycle time to now but stagger was still applied. | Skip initial stagger when `run_first_cycle_immediately` is True so all workers run first cycle within 1–2s of Run. |
| **Sessions receive zero groups** | Enterprise partitioned by total sessions; paused/cooldown/excluded sessions still got a slice index but returned [] in assignment, so their share was unused. | Snapshot includes `active_session_files` (non-paused, non-excluded, non-cooldown). Enterprise partitions only among actives so every active session gets a fair share. |
| **FloodWait sessions never rejoin** | Workers use a static config snapshot; when controller cleared `session_pause_until` on cycle_done, workers never saw the update. | Controller pushes `config_patch` (e.g. `session_pause_until`) to all workers via command queue; workers merge patch in `get_config()` so cleared pauses take effect without restart. |
| **Log channel could block posting** | Unbounded log queue; under load `put()` could in theory block (and queue growth could hurt memory). | Bounded log queue (500) and `put_nowait` in `enqueue_log`; drop when full so posting path never blocks on logging. |
| **Unnecessary worker restarts** | Startup-failure restart (10 min no cycle/post) could fire for sessions in FloodWait pause. | Before triggering startup-failure restart, skip when session is in `session_pause_until` (FloodWait). |

---

## Exact code sections modified

### Step 1 — Scheduling (immediate first cycle, no artificial wait)

**File: `code/users.py`**

- **Stagger skip when run_first_cycle_immediately**
  - In `_async_session_loop`, before `if stagger_sec > 0: await asyncio.sleep(stagger_sec)`:
  - Fetch config once; if `run_first_cycle_immediately` is True, do not sleep.
  - Location: ~1199–1205 (stagger block).

### Step 2 — Session assignment integrity

**File: `code/users.py`**

- **`_active_session_files(cfg)`**
  - New helper: returns list of session files that are not excluded, not paused (`session_pause_until` ≤ now), not in cooldown.
  - Used when building snapshot and for Enterprise assignment.

- **`_build_worker_config_snapshot`**
  - Computes `active_list = _active_session_files(cfg)` and adds `"active_session_files": active_list` to the snapshot.

- **`_assigned_groups_for_session` (Enterprise branch)**
  - When `cfg.get("active_session_files")` is present: if `session_file` not in list, return `[], len(all_groups)`.
  - Otherwise partition using index in `active_session_files` and `total = len(active_session_files)` so only active sessions share groups; each active gets at least one group when `len(all_groups) >= len(active_list)`.

### Step 3 — FloodWait adaptive reintegration

**File: `code/workers.py`**

- **`local_config_patch`**
  - New dict in worker closure; `get_config()` merges it into the returned config (overriding snapshot for patched keys).

- **Command listener**
  - Handles `cmd["cmd"] == "config_patch"` and updates `local_config_patch` with `cmd.get("patch")`.

**File: `code/users.py`**

- **After cycle_done `_save_bot_config`**
  - Load updated config, then for each worker in `_worker_handles[bot_token]` send `{"cmd": "config_patch", "patch": {"session_pause_until": <current map>}}`.
  - Workers see cleared pause on next `get_config()` and can run assignment again without restart.

### Step 4 — Logging channel throttling

**File: `code/users.py`**

- **`_log_queue`**
  - Replaced unbounded queue with `queue.Queue(maxsize=500)`.

- **`enqueue_log`**
  - Uses `put_nowait(item)` and catches `queue.Full` (no-op) so the posting path never blocks on log enqueue.

### Step 5 — Worker lifecycle stability

**File: `code/users.py`**

- **Health monitor — startup-failure restart**
  - Before checking `now > start_ts + STARTUP_FAILURE_RESTART_AFTER_SEC`, read `pause_until` for that session from config.
  - If `pause_until > now` (session in FloodWait), `continue` and do not restart that worker.

---

## Deterministic scheduling verification method

1. **First post within 1–2s**
   - Press Run, note timestamp; confirm first “Posted in …” or post attempt in logs within 1–2s.
   - Check logs: no `await asyncio.sleep(stagger_sec)` for initial cycle when `run_first_cycle_immediately` is True; `[CycleAnchor] first cycle immediately` should appear.

2. **All active sessions receive groups**
   - With N sessions and M groups (M ≥ N), ensure no “session assigned ZERO groups” for non-paused sessions.
   - With some sessions paused, ensure only active sessions get groups and partition is even among actives (e.g. 10 groups, 3 actives → 3,3,4 or similar).

3. **Cycle timing deterministic**
   - After first cycle, next cycle at anchor + cycle_sec (e.g. 900s). Logs should show `next_cycle_time` aligned to `cycle_anchor_ts + k*cycle_sec`.

4. **FloodWait sessions rejoin**
   - Simulate FloodWait (or wait for real one); after pause expires and a cycle_done is processed, confirm controller sends `config_patch` and that session gets groups again on next cycle (no restart).

5. **No posting delays from logging**
   - Under load, confirm `enqueue_log` never blocks (e.g. add a temporary log before/after `put_nowait`). If queue is full, items are dropped and posting continues.

6. **No random worker restarts**
   - When all workers are alive and no process has died, health monitor must not call `_start_posting` (alive == expected).
   - When a session is in FloodWait, health monitor must not trigger startup-failure restart for that session.

---

## Runtime validation checklist

- [ ] First post happens within 1–2 seconds after Run.
- [ ] All active (non-paused, non-excluded, non-cooldown) sessions receive groups when groups exist.
- [ ] Cycle timing remains deterministic (anchor-based; first cycle immediate, then anchor + k×cycle_sec).
- [ ] FloodWait sessions rejoin automatically after pause expires (config_patch; no restart required).
- [ ] No posting delays caused by logging (bounded queue + put_nowait).
- [ ] No unnecessary worker restarts (alive == expected skips full restart; FloodWait skips startup-failure restart).
