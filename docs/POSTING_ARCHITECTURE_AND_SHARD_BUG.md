# AdBot Posting Architecture & Shard Distribution Bug — Deep Dive

## 1. Complete Posting Flow Trace

### 1.1 Scheduler trigger (no cron; in-process cycle boundary)

- **Location:** `code/users.py` `_async_session_loop` (approx. 1404–1452).
- **Mechanism:** Cycle boundaries are deterministic from `cycle_anchor_ts` and `cycle_sec`:
  - `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec`
  - Session sleeps in chunks until `scheduled_time` (polling `stop_event` and heartbeats).
- **No external scheduler:** All sessions share the same anchor; each worker computes the same `next_cycle_time` from `get_config()` (snapshot + patch). No separate scheduler process.

### 1.2 Cycle creation

- **Concept:** A “cycle” is one run of the posting loop for a given cycle boundary.
- **Anchor:** Set once at bot start in `_start_posting_workers_async` (e.g. 2827) via `_save_bot_config(bot_token, lambda c: c.update({"cycle_anchor_ts": time.time()}))` when not preserving cycle time.
- **Cycle ID:** Logged as `current_cycle_id = int(scheduled_run_ts)` (users.py 1627). Used for logging only; not used for shard or assignment.
- **No explicit “cycle object”:** Cycle is implicit: one iteration of the `while True` in `_async_session_loop` from “wait until next boundary” through “post assigned groups” to `report_cycle_done(session_file, scheduled_run_ts)`.

### 1.3 Session selection (which sessions run)

- **At start:** `_start_posting_workers_async` (2785+) builds `valid_sessions` from `cfg["sessions"]` (file exists, not excluded). Then filters to `valid_sessions_with_groups`: only sessions that get >0 groups from `_assigned_groups_for_session(..., idx, len(valid_sessions))` with the **startup** cfg (no pauses). So sessions that would get 0 groups (e.g. excluded/paused at start) are not started.
- **Per cycle (inside worker):** Session is fixed per worker (one session per worker, `SESSIONS_PER_WORKER=1`). No “selection” each cycle; the same session runs again. Assignment is recomputed each cycle via `_assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)` with `cfg = get_config()`.

### 1.4 Shard calculation (exact location and formula)

- **Single place:** `_assigned_groups_for_session` in `code/users.py` 977–1045.
- **Enterprise branch (1011–1045):**
  - `active_list = cfg.get("active_session_files")`.
  - If `active_list` is truthy:
    - `total = max(1, len(active_list))`
    - `idx = active_list.index(session_file)` (position in **active** list).
    - Slice: `start = idx * n // total`, `end = (idx + 1) * n // total`.
    - Return `all_groups[start:end]`, `len(all_groups)`.
  - If `active_list` is falsy (None or empty):
    - `total = max(1, total_sessions or 1)`
    - `idx = max(0, min(session_index, total - 1))` (uses passed-in `session_index` / `session_ordinal`).
    - Same slice formula.
- **Sharding is by list index, not hash:** Slice `[idx*N//T : (idx+1)*N//T]` with `T = len(active_list)` (when active_list present). So **session order in `active_list` determines which slice a session gets**. It is **not** `hash(group_id) % total_sessions`.

### 1.5 Group assignment (how a session gets its list)

- **Each cycle start** (users.py 1544–1587):
  - `cfg = get_config()` (worker: merged snapshot + `local_config_patch`).
  - `assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`.
  - `groups = pending_groups + list(assigned)` then capped by BUG-4 cap (1576–1586).
  - `pending_groups` = rollover from previous cycle when the cycle window expired (1643–1645).
- **Snapshot at start:** `_build_worker_config_snapshot(cfg, len(valid_sessions))` (2831) sets `active_session_files = _active_session_files(cfg)` and `total_sessions = len(valid_sessions)`. So at start, `active_list` = all non-paused sessions (typically all).

### 1.6 Posting loop

- **Location:** users.py 1642–1901 (main loop over `groups`), then 1913–2021 (Enterprise “drain deferred”).
- **Flow:** For each group: check cycle window, skip if already posted this cycle, group cooldown, ban skip; wait for gap/FloodWait; post; on `FloodWaitGroupSkip` cooldown group and continue; on `FloodWaitPause` call `report_session_paused`, defer remaining groups (Enterprise), **break** out of loop. After the loop, **cycle_done is still reported** (2040–2041).

### 1.7 Error handling and FloodWait

- **FloodWaitPause (account-level):** users.py 1832–1850. Sets in-memory pause, `report_session_paused(session_file, unblock_time, wait_seconds)` → controller persists `session_pause_until` and sends **config_patch** with updated `active_session_files` and `session_pause_until` (2244–2268). Session that hit FloodWait **breaks** out of posting loop then still hits `report_cycle_done` (2040).
- **Controller on `session_paused`:** `_apply_worker_result` (2238–2268): saves pause, then pushes patch to **all** workers so “paused session is excluded from active_session_files on their next cycle”.

### 1.8 Next cycle scheduling

- After `report_cycle_done`, loop continues: wait until `next_scheduled = scheduled_run_ts + cycle_sec` (2058), then next iteration of `while True` re-reads `get_config()`, recomputes next boundary, and runs assignment again. So **next cycle again calls `_assigned_groups_for_session` with current (patched) cfg**.

---

## 2. Where Shard Distribution Is Calculated

- **Only in:** `_assigned_groups_for_session` (users.py 977–1045).
- **Enterprise:** Partition size and index come from:
  - **When `active_list` is set:** `total = len(active_list)`, `idx = active_list.index(session_file)`.
  - **When `active_list` is not set:** `total = total_sessions or 1`, `idx = session_index`.
- **`active_session_files`** is set only by the controller:
  - In `_build_worker_config_snapshot`: `active_list = _active_session_files(cfg)`.
  - In `_apply_worker_result` on `session_paused` and on `cycle_done`: patch built with `active_list = _active_session_files(cfg_after)` and sent to all workers. So **shard denominator is the current number of “active” (non-paused, non-excluded, non-cooldown) sessions**.

---

## 3. Session List and Mutations

- **`active_session_files`** is derived from `_active_session_files(cfg)` which iterates `cfg.get("sessions") or []` and filters out excluded, paused (by `session_pause_until`), and cooldown. So it **changes when** any session is paused or cleared.
- **Session list in cfg:** From user JSON; not mutated mid-cycle by the posting engine. Mutations are: controller writes `session_pause_until` / `excluded_sessions` / etc. So **session list (sessions) does not reorder mid-cycle**; only which of them are “active” changes.
- **Worker config:** `get_config()` merges snapshot with `local_config_patch`. Patches are applied with `local_config_patch.update(patch)` (workers.py 284). So **last patch wins per key**. If two patches arrive (e.g. session_paused then cycle_done), the second overwrites `active_session_files`. Order of processing in the controller is FIFO from one queue (`_worker_result_queue`), so order is deterministic for the controller; workers receive patches asynchronously, so a worker can apply “session_paused” patch (active_list = 4) and then later “cycle_done” patch (active_list = 5 if that cycle_done cleared a pause). So **session list for assignment can change between cycles** and is whatever the last patch + snapshot say.

---

## 4. Race Conditions and Global State

- **Single result handler:** `_worker_result_handler_async` (2506) runs one task; it does `q.get` then `_apply_worker_result(msg)`. So **controller applies one message at a time**; no race between two results for the same bot.
- **Config writes:** `_save_bot_config` is used on every pause and cycle_done; no explicit locking. If the main loop is single-threaded (one asyncio loop), there is no concurrent write to the same user file from the controller.
- **Worker-side:** Each worker has its own `local_config_patch` and `get_config()`. No shared in-process state between workers (separate processes). So **no cross-worker race on assignment**; the only “race” is **which patch a worker has when it starts a cycle** (FIFO queue, but cycle start is not synchronized with patch arrival).
- **Global in controller:** `_deferred_groups` and `_session_availability` are process-local. **Workers are separate processes:** when a worker hits FloodWait and calls `_defer_groups_starter(bot_token, remaining)`, that runs **inside the worker process**, so it appends to **that process’s** `_deferred_groups`. Other workers have their own empty (or different) `_deferred_groups`. So **deferred groups are not shared across workers**; “redistribution” of deferred groups to “other sessions” does not work in the current multiprocessing design (only the same session, when it resumes, could drain its own deferred list in that process).

---

## 5. Why [ShardCheck] assigned=124 expected_shard=25

- **VerificationReport** (1594) uses `_verify_assignment_report(mode, total_workers, total_groups, session_ordinal, len(groups), ...)`. So `expected_shard` = `_shard_size(session_ordinal, total_workers, total_groups)` = `(session_ordinal+1)*N//T - session_ordinal*N//T` with **T = total_workers** (e.g. 5), N = 124 → 25.
- **assigned** is `len(groups)` = len(pending_groups) + len(assigned) (after cap). So **assigned=124** means this session’s `_assigned_groups_for_session` returned a list of length 124 (or pending + assigned reached 124 before cap).
- For that to happen with 124 total groups, the slice must be **all** groups: `start=0`, `end=124`. So in `_assigned_groups_for_session`, we need `total == 1` and `idx == 0`. That occurs when:
  - **`active_list` is present and has length 1** (so `total = 1`, and the only element is this session → `idx = 0`), **or**
  - **`active_list` is falsy and `total_sessions == 1`** and `session_index == 0`.
- **Conclusion:** The worker’s `cfg.get("active_session_files")` was a list of **one** session (this one). So the controller had sent a patch (or the snapshot was built) with `_active_session_files(cfg)` returning only that session — i.e. **all other sessions were paused** in that cfg.

---

## 6. Root Cause (Exact)

- **Design:** When some sessions are in FloodWait, the controller excludes them from `active_session_files`. On the **next** cycle, each worker’s `_assigned_groups_for_session` uses `total = len(active_list)`. So if only one session is active, **that session gets the entire group list** (124/1 = 124).
- **Exact code that causes the bug:** users.py 1024–1045 (Enterprise branch when `active_list` is truthy):
  - `total = max(1, len(active_list))`  →  if only one session is active, total = 1.
  - `idx = active_list.index(session_file)`  →  0 for that session.
  - `start = 0 * n // 1`, `end = 1 * n // 1`  →  full list.
- **Trigger scenario:** Several sessions hit FloodWait and send `session_paused`; controller marks them paused and sends patches with `active_session_files` = remaining sessions. One session (e.g. the one that did not hit FloodWait, or the first to finish its cycle) then sends `cycle_done`. Controller builds the next patch from `cfg_after` where the other sessions are still paused, so `_active_session_files(cfg_after)` = **[that one session]**. All workers receive this patch. On the next cycle, that session’s worker calls `_assigned_groups_for_session` with `active_session_files = [that session]` → total=1, idx=0 → **assigned = all 124 groups** → that session then posts to all 124 and hits FloodWait again.

So the **root cause** is: **shard size is computed from the current number of active sessions**. When only one session is active, it is given 100% of the groups, which is unsustainable and causes FloodWait.

---

## 7. Flow Diagram (Posting Lifecycle)

```
[Bot Start]
    │
    ▼
_start_posting_workers_async
    │ valid_sessions, valid_sessions_with_groups
    │ chunks = chunk_sessions(valid_sessions), 1 per worker
    │ config_snapshot = _build_worker_config_snapshot(cfg, len(valid_sessions))
    │   → active_session_files = _active_session_files(cfg)
    │   → total_sessions = len(valid_sessions)
    ▼
Spawn worker processes (worker_id, session_chunk, config_snapshot)
    │
    ▼
[Worker] worker_main_async
    │ get_config() = merge(snapshot, local_config_patch)
    │ On "config_patch" → local_config_patch.update(patch)
    ▼
[Worker] _async_session_loop(session_ordinal, total_workers, session_file)
    │
    └── while True:
          │
          ├─ get_config() → cfg
          ├─ Wait until next_cycle_time (anchor + (k+1)*cycle_sec)
          │
          ├─ assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)
          │     Enterprise: active_list = cfg["active_session_files"]
          │     if active_list: total=len(active_list), idx=active_list.index(session_file)  ← BUG: total=1 ⇒ full list
          │     slice = all_groups[idx*n//total : (idx+1)*n//total]
          │
          ├─ groups = pending_groups + assigned (capped)
          ├─ [ShardCheck] log total_groups, assigned=len(groups)
          ├─ _verify_assignment_report(..., total_workers, total_groups, session_ordinal, len(groups))
          │
          ├─ For each group: post or handle FloodWaitGroupSkip / FloodWaitPause
          │     On FloodWaitPause: report_session_paused → controller
          │                         _defer_groups_starter(remaining)  [process-local; other workers don't see]
          │                         break (then still report_cycle_done below)
          │
          ├─ Drain deferred (Enterprise): _pop_deferred_groups (same process only)
          │
          ├─ report_cycle_done(session_file, scheduled_run_ts)
          │
          └─ Sleep until next_scheduled; loop

[Controller] _worker_result_handler_async
    │ q.get() → _apply_worker_result(msg)
    ▼
_apply_worker_result
    │ session_paused → save session_pause_until; patch = {session_pause_until, active_session_files = _active_session_files(cfg_after)}
    │                  → cmd_q.put(config_patch) for all workers
    │ cycle_done      → update last_cycle_time; clear pause for that session only if already expired;
    │                  patch = {session_pause_until, active_session_files = _active_session_files(cfg_after)}
    │                  → cmd_q.put(config_patch) for all workers
    ▼
Next cycle in worker: get_config() includes new active_session_files → _assigned_groups_for_session uses it
    → If only one session active → that session gets full list (124) → FloodWait again.
```

---

## 8. Answers to Specific Questions

- **Sharding: deterministic?** Yes, by **index**: slice `[idx*N//T : (idx+1)*N//T]`. Not hash-based.
- **Session order affect outcome?** Yes. `idx = active_list.index(session_file)` so the **order of `active_session_files`** (and thus the order of non-paused sessions in cfg) determines which slice each session gets.
- **Removing one session reassign all?** Yes. When one session is paused, `active_list` shrinks; the **same** slice formula is applied with a smaller T, so every remaining session’s slice size increases (and one session can become “all” when T=1).
- **FloodWait trigger new cycle?** No. It triggers **config_patch**; the next cycle is the same scheduler loop, with updated cfg.
- **FloodWait clear shard state?** It doesn’t clear a separate “shard state”; it changes **active_session_files**, which is the input to shard calculation. So effectively yes: next cycle recomputes shard with fewer active sessions.
- **Reconnect / group cache:** Groups are loaded each cycle via `_load_groups(cfg)` (no persistent group cache). Reconnect does not reset a “group cache”; assignment is stateless per call.
- **Failed sessions trigger redistribution?** Yes: `cycle_failed` adds session to `excluded_sessions`; next snapshot/patch will have fewer sessions. And FloodWait makes sessions “paused,” so they drop out of `active_session_files`, which is the same mechanism (fewer active → larger slices for the rest).
- **Multiple cycles simultaneously?** No. Each worker runs one session loop; cycle boundaries are shared (same anchor), but each process runs one loop; there is no “multiple cycles at once” for the same session. Different sessions can be in different phases (one in post, one in wait).

---

## 9. Safe Architectural Fix (Summary)

- **Problem:** Using `total = len(active_list)` in Enterprise allows one remaining session to get 100% of groups when all others are paused.
- **Fix:** Keep partition **denominator** and **session index** based on the **full** session list (all configured sessions), not on `active_list`. So:
  - Compute `total_denom = len(cfg.get("sessions") or [])` (or `total_sessions` if that list is empty).
  - Compute this session’s index in the **full** list: e.g. `sessions_list = [s.get("file") or "" for s in (cfg.get("sessions") or [])]`, `idx_global = sessions_list.index(session_file)` if in list else skip.
  - Still return `[]` for excluded/paused/cooldown at the top of the function.
  - For Enterprise, use `start = idx_global * n // total_denom`, `end = (idx_global + 1) * n // total_denom` with `total_denom = max(1, len(sessions_list) or total_sessions or 1)`.
- **Effect:** No session ever gets more than `ceil(N / total_denom)` groups. Paused sessions get no groups (early return); their “slice” is simply not assigned to anyone that cycle. No single session can be given the full list because others are paused.

### 10. Code change (implemented)

- **File:** `code/users.py`, function `_assigned_groups_for_session` (Enterprise branch).
- **Change:** Partition denominator and index are now based on the **full** session list from `cfg.get("sessions")`:
  - `sessions_list` = list of session file names from `cfg["sessions"]`.
  - `total_denom = len(sessions_list)` (or `total_sessions` if list empty).
  - `idx_global` = index of `session_file` in `sessions_list` (or `session_index` if no list).
  - Slice: `start = idx_global * n // total_denom`, `end = (idx_global + 1) * n // total_denom`.
- **Unchanged:** Excluded/paused/cooldown still return `[]` at the top. If `active_list` is present and this session is not in it, still return `[]`. So “who gets groups” is unchanged; only the **size** of each session’s slice is capped by the full session count.
- **Effect:** No session can receive more than `ceil(N / total_denom)` groups, so `assigned=124` with `expected_shard=25` cannot occur when 5 sessions are configured.
