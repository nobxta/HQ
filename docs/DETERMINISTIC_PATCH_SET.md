# AdBot Deterministic Patch Set

Minimal code patches for scheduler determinism and posting timing. No redesign; no new features.

---

## 1. Patches Already in Codebase (Required for Determinism)

These are already present; they are listed so the patch set is complete and auditable.

### 1.1 First cycle runs immediately (no boundary wait)

**File:** `code/users.py`

- **Snapshot:** When building worker config on fresh Run, set `run_first_cycle_immediately=True`.  
  **Line ~2568:** `_build_worker_config_snapshot(cfg, len(valid_sessions), run_first_cycle_immediately=not preserve_cycle_time)`  
  **Line ~1939:** Snapshot includes `"run_first_cycle_immediately": run_first_cycle_immediately`.

- **Worker loop:** If `run_first_cycle_immediately` and first cycle not done, set `next_cycle_time = now_ts`, `delta_sec = 0`.  
  **Lines 1305–1311:** Override next_cycle_time/delta_sec so first cycle is due immediately.

- **Stagger:** Skip initial stagger when run_first_cycle_immediately.  
  **Lines 1209–1214:** Before sleeping stagger_sec, read config and skip if `cfg.get("run_first_cycle_immediately")`.

**Why it fixes nondeterminism:** Without this, the first cycle would wait until the next cycle boundary (up to cycle_sec), so “Run → first post” could be delayed by many minutes. With it, the first cycle runs as soon as the worker passes global/cooldown/FloodWait checks.

---

### 1.2 config_patch includes active_session_files (FloodWait rejoin)

**File:** `code/users.py`

- **Lines 1977–1987:** On cycle_done, after updating session_pause_until and clearing FloodWait for the completed session, compute `active_list = _active_session_files(cfg_after)` and send patch `{"session_pause_until": ..., "active_session_files": active_list}` to all workers.

**File:** `code/workers.py`

- **Lines 276–281:** On `config_patch` command, update `local_config_patch` with the patch.  
- **Lines 90–97:** `get_config()` merges `local_config_patch` into the config returned to the session loop.

**Why it fixes nondeterminism:** Without active_session_files in the patch, workers kept the initial snapshot’s active list. A session that left FloodWait was no longer in that list, so it got 0 groups until bot restart. With the patch, the next cycle sees the updated active list and the cleared session gets groups again.

---

### 1.3 Controller status sleeps reduced (UI only)

**File:** `code/users.py`

- **Lines ~2530, 2560, 2614, 2649:** Each status step uses `await asyncio.sleep(0.2)` (not 0.35). Total controller delay before workers run: 0.8 s.

**Why it helps:** Keeps “Run → workers started” under ~1 s so that, when Telethon connect is fast, “Run → first post” can approach 1–2 s. Does not remove the connect delay.

---

### 1.4 Health monitor: no restart when alive == expected or not running

**File:** `code/users.py`

- **Lines 2952–2955:** If `alive == expected`, skip (do not full restart).  
- **Lines 2960–2962:** If `not bot_runtime_state.get(bot_token, {}).get("running")`, skip.  
- **Lines 2931–2932:** For startup-failure restart, if session is in FloodWait (`pause_until > now`), skip.

**Why it fixes nondeterminism:** Prevents full restart when all workers are present and prevents restarting a session that is only waiting on FloodWait, avoiding “random stop” and churn.

---

## 2. No Additional Patches Required for Determinism

- **cycle_anchor_ts:** Set only once on fresh start (users.py 2565–2566); workers never set it; health restart uses preserve_cycle_time and does not reset anchor.  
- **next_cycle_time:** Always `cycle_anchor_ts + (cycle_index + 1) * cycle_sec` except for the first cycle when run_first_cycle_immediately (overridden to now_ts). No patch needed.  
- **Worker restart:** Does not change next cycle timing; anchor comes from persisted cfg. No patch needed.  
- **Assignment:** config_patch (with active_session_files) and _active_session_files at cycle_done are sufficient; no further patch.

---

## 3. Run → First Post ≤ 2 Seconds: Scope and Limitation

**Achieved when:**

- No pending STOP cleanup (or it finishes quickly).  
- No global flood shield, cooldown, or per-session FloodWait.  
- `run_first_cycle_immediately` is True (fresh Run).  
- **Telethon connect** for the first session that posts completes in well under 2 seconds (e.g. &lt;1 s).

**Not achieved when:**

- **Telethon connect takes 60–120+ seconds** (as in nobi.log). Then “Run → first post” will be ~1–2 minutes regardless of scheduler. The only way to get first post ≤ 2 s in that case would be to connect **before** the first cycle (e.g. pre-warm connections), which is a design change and out of scope here.

So:

- **Run → posting begins immediately** in terms of **scheduler**: workers start, first cycle is due immediately, no boundary wait, no stagger for first cycle.  
- **Run → first post ≤ 2 s** is **only** guaranteed when connect is fast; when connect is slow, the delay is from the network/Telegram stack, not from the scheduler.

---

## 4. Confirmation Checklist

After applying or confirming the patches above:

| Requirement | Status |
|-------------|--------|
| Run → posting begins immediately (scheduler: no boundary wait, no first-cycle stagger) | Yes (run_first_cycle_immediately + stagger skip) |
| Run → first post ≤ 2 s when no flood/cooldown and fast connect | Yes (controller 0.8 s + connect &lt;1 s) |
| Run → first post when connect is 60–120 s | ~1–2 min (connect-bound; no scheduler fix without redesign) |
| No random worker restarts when alive == expected | Yes (health monitor skips when alive == expected) |
| No cycle skips from restart | Yes (anchor preserved; next_cycle_time unchanged) |
| Deterministic cycle intervals (after first cycle) | Yes (cycle_anchor_ts + (k)*cycle_sec) |
| Stable group assignment; FloodWait-cleared sessions rejoin | Yes (config_patch with active_session_files after cycle_done) |
| No active session gets 0 groups while active (when groups exist) | Yes (Enterprise partition + config_patch) |

---

## 5. Optional Hardening (Not Required for Determinism)

- **Connect timeout:** Add a timeout around `await client.connect()` in _connect_session_for_cycle so that a hung connect does not block the worker indefinitely and can be retried (within existing SESSION_RECONNECT_* logic). This does not change determinism but can make “first post” more predictable when the network is bad.  
- **Heartbeat before connect:** The loop already sends heartbeat at the start of each iteration (users.py 1230–1232). Optionally send one immediately before _connect_session_for_cycle to reduce the chance that a long connect is mistaken for a frozen worker. Not required for the current heartbeat timeout logic.

---

## 6. File/Line Reference Summary

| Change | File | Lines |
|--------|------|-------|
| run_first_cycle_immediately in snapshot | users.py | 2568, 1939 |
| First-cycle override (next_cycle_time = now_ts, delta_sec = 0) | users.py | 1305–1311 |
| Skip stagger when run_first_cycle_immediately | users.py | 1209–1214 |
| config_patch with active_session_files on cycle_done | users.py | 1977–1987, 1983 |
| config_patch merge in worker | workers.py | 276–281, 90–97 |
| Status sleeps 0.2 s | users.py | 2530, 2560, 2614, 2649 |
| Health: skip when alive == expected | users.py | 2952–2955 |
| Health: skip when not running | users.py | 2960–2962 |
| Health: skip startup-failure when FloodWait | users.py | 2931–2932 |
| cycle_anchor_ts set once (fresh start) | users.py | 2565–2566 |
| _restart_single_worker preserves anchor (no run_first) | users.py | 2410, 2568 (preserve_cycle_time path) |

---

**End of DETERMINISTIC_PATCH_SET.md**
