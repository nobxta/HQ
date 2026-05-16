# ENTERPRISE Mode Shard Behavior Under Session Pauses — Deep Audit

## 1. Location of _assigned_groups_for_session (Enterprise branch)

**File:** `code/users.py`  
**Function:** `_assigned_groups_for_session` (lines 977–1052)  
**Enterprise branch:** lines 1017–1051 (after `if mode != "Enterprise":` return).

Execution path for Enterprise:

1. Lines 986–1010: load groups, exclude excluded/paused/cooldown sessions (return `[], len(all_groups)` for those).
2. Line 1013: `mode = (cfg.get("mode") or "Starter").strip()`
3. Line 1014: `if mode != "Enterprise":` → skip (we are in Enterprise).
4. Lines 1017–1051: Enterprise logic (see below).

---

## 2. Shard denominator: what is used (current vs pre-fix)

### 2.1 Current code (post-fix) — lines 1033–1051

- **Partition denominator:** `total_denom` comes from **`len(sessions_list)`**, where `sessions_list` is built from **`cfg.get("sessions")`** (full configured session list), **not** from `active_session_files` or `total_workers`.

Exact code:

```python
# Line 1020
active_list = cfg.get("active_session_files")
# Lines 1026–1031: active_list only used to gate "allow assignment" (return [] if session not in active_list)
# Lines 1033–1043: partition uses sessions_list from cfg
sessions_list = [(s.get("file") or "").strip() for s in (cfg.get("sessions") or [])]
sessions_list = [f for f in sessions_list if f]
if not sessions_list:
    total_denom = max(1, total_sessions or 1)
    idx_global = max(0, min(session_index, total_denom - 1))
else:
    total_denom = len(sessions_list)
    if session_file not in sessions_list:
        return [], len(all_groups)
    idx_global = sessions_list.index(session_file)
n = len(all_groups)
start = idx_global * n // total_denom
end = (idx_global + 1) * n // total_denom
return list(all_groups[start:end]), len(all_groups)
```

So **currently:**

- **Shard denominator** = `len(cfg["sessions"]`) (after stripping empty filenames), or `total_sessions` if that list is empty.
- **Not used for partition size:** `len(active_session_files)` is **not** used for `total_denom` or slice math. `active_session_files` is only used to decide whether this session gets any groups at all (lines 1026–1031: if in `active_list` and session not in it → return `[]`).
- **`total_workers`** is only used when `sessions_list` is empty (fallback `total_denom = total_sessions or 1`). It is not used when `cfg["sessions"]` is non-empty.

### 2.2 Pre-fix (buggy) behavior — what caused assigned=N

Before the fix, the Enterprise block used **`len(active_list)`** as the partition denominator:

- `total = max(1, len(active_list))`
- `idx = active_list.index(session_file)`
- `start = idx * n // total`, `end = (idx + 1) * n // total`

So when **only one session was active** (e.g. 4 paused, 1 active), `active_list` had length 1 → `total = 1` → that session got `idx = 0` → slice `[0:n]` = **all groups** → **assigned = N**.

---

## 3. Scenario: 5 sessions configured, 4 paused, 1 active

### 3.1 How active_session_files is produced

**Function:** `_active_session_files(cfg)` — users.py 2096–2119.

Logic:

- Iterate `cfg.get("sessions") or []`.
- For each session file `f`: skip if excluded, or `(session_pause_until.get(f) or 0) > now`, or `(session_cooldown_until.get(f) or 0) > now`.
- Append remaining to `out`.
- Return `out`.

So with 5 sessions and 4 paused (their `session_pause_until` > now): **`_active_session_files(cfg)` returns a list of length 1** (the one non-paused session).

### 3.2 Pre-fix: denominator becomes 1

- Worker’s `get_config()` returns merged config including `active_session_files` from the latest patch (or snapshot).
- After 4 sessions report FloodWait, controller has saved `session_pause_until` for each and sent **config_patch** with `active_session_files = _active_session_files(cfg_after)` = **[that one session]**.
- All workers receive that patch and merge it into `local_config_patch`. So on the **next** cycle, `cfg = get_config()` has `active_session_files` = list of 1.
- In the **old** Enterprise code: `total = len(active_list) = 1`, `idx = 0` for that session → slice = `all_groups[0:n]` → **assigned = N**. So the shard denominator **did** become 1 in that scenario, and that single session received all groups.

### 3.3 Post-fix: denominator stays 5

- `sessions_list` is built from `cfg.get("sessions")` (the full 5-session list from snapshot). Snapshot and patches do **not** remove sessions from `cfg["sessions"]` when they pause; only `session_pause_until` and `active_session_files` change.
- So `total_denom = len(sessions_list) = 5` (unchanged by pauses).
- The one active session has `idx_global` = its index in the full list (e.g. 2) → slice size = `ceil(124/5)` or similar → **assigned ≤ 25**. So no session can get N.

---

## 4. When and how active_session_files is generated and patched

### 4.1 When it is built

1. **At worker start (snapshot):**  
   `_build_worker_config_snapshot(cfg, total_sessions)` (2123–2155) calls `active_list = _active_session_files(cfg)` and sets `"active_session_files": active_list` in the snapshot. So at start, it reflects who is not paused/excluded/cooldown at that time.

2. **On controller when processing results:**  
   - **session_paused** (2244–2268): after saving `session_pause_until`, `cfg_after_pause = _get_cfg(bot_token)`, then `active_list_p = _active_session_files(cfg_after_pause)`. Patch = `{"session_pause_until": ..., "active_session_files": active_list_p}`. Sent to **all** workers via `cmd_q.put({"cmd": "config_patch", "patch": patch_p})`.
   - **cycle_done** (2199–2215): after updating last_cycle_time (and only clearing pause for that session if already expired), `cfg_after = _get_cfg(bot_token)`, then `active_list = _active_session_files(cfg_after)`. Patch = `{"session_pause_until": ..., "active_session_files": active_list}`. Sent to all workers.

So **active_session_files is rebuilt** on the controller whenever it handles `session_paused` or `cycle_done`, from the **current** bot config (with latest `session_pause_until`). It is **patched** by sending that list to every worker; workers merge it into `local_config_patch` (workers.py 284: `local_config_patch.update(patch)`).

### 4.2 Patch timing vs shard calculation

- **When shard is calculated:** At the **start** of each cycle in `_async_session_loop`: `cfg = get_config()` then `assigned, total_groups = _assigned_groups_for_session(...)`. So the config (and thus `active_session_files`) used for assignment is whatever `get_config()` returns at that moment.
- **When patch is applied:** When the worker’s `command_listener` receives `config_patch`, it does `local_config_patch.update(patch)`. So the **next** call to `get_config()` will include the new `active_session_files`.
- So: if a patch **arrives after** the worker has already read `get_config()` for this cycle, that cycle’s assignment does **not** use the new patch; the next cycle will. So there is a **one-cycle** window where a worker can still use the previous `active_session_files`. With the **current** (post-fix) logic, that does not change the **slice size** (because slice size uses `cfg["sessions"]`, not `active_session_files`). It can only affect whether this session gets 0 groups (if it was dropped from the new active list and the patch is applied before the next assignment). So with the fix, patch timing does **not** cause assigned=N; at worst it affects who gets 0 vs a capped slice.

---

## 5. Do paused sessions reduce the shard denominator? (current vs pre-fix)

- **Pre-fix:** Yes. Denominator was `len(active_session_files)`. When sessions paused, the controller sent a patch with a shorter `active_session_files`, so the denominator decreased and the remaining session(s) got a larger slice; with 1 active, denominator = 1 → one session got all groups.
- **Post-fix:** No. Denominator is `len(cfg["sessions"])` (or `total_sessions` if that list is empty). Paused sessions are still in `cfg["sessions"]`; only `session_pause_until` and `active_session_files` change. So the denominator does **not** shrink when sessions pause. Paused sessions simply get 0 groups (early return at 994–1003) and their slice is not given to anyone.

---

## 6. Verification: no session can exceed ceil(N / total_configured_sessions)

**Current code:**

- `total_denom = len(sessions_list)` with `sessions_list` from `cfg.get("sessions")` (all configured sessions). So `total_denom` = total configured sessions (or fallback).
- Slice for session with index `idx_global`: `start = idx_global * n // total_denom`, `end = (idx_global + 1) * n // total_denom`. So size = `end - start` ≤ `ceil(n / total_denom)` (integer division). So **no session can receive more than ceil(N / total_configured_sessions)**. Verified.

---

## 7. config_patch mid-cycle and stale state

- Assignment runs **once per cycle**, at cycle start, using `cfg = get_config()`. If a `config_patch` arrives **during** the cycle (e.g. while the worker is in the posting loop), the current cycle’s `groups` are already fixed; the patch will be reflected in `get_config()` on the **next** cycle.
- So **stale state** can only mean: the config used at cycle start was from an earlier patch (or snapshot). With the **current** logic, that does **not** allow assigned=N, because the slice size is bound by `len(cfg["sessions"])`, which is from the snapshot and not overwritten by pause patches. So even if `active_session_files` in the worker is stale (e.g. still has 5 entries), the slice is still computed with `total_denom = len(sessions_list)` from `cfg["sessions"]`. So shard calculation does **not** use a stale denominator that could collapse to 1, unless `cfg["sessions"]` itself had only one session (configuration issue, not pause-induced).

---

## 8. Does FloodWaitPause trigger redistribution?

- **Controller:** On `session_paused`, the controller saves the pause and sends a **config_patch** with updated `session_pause_until` and `active_session_files`. So workers see a shorter “active” list on the next cycle. With the **current** assignment logic, that does **not** redistribute slice size (denominator is full session list). It only causes the paused session to get 0 groups (early return) and optionally “not in active_list” return for consistency.
- **Deferred groups:** When a session hits FloodWaitPause in the posting loop (users.py 1848–1856), it calls `_defer_groups_starter(bot_token, remaining)` (Enterprise only). So “redistribution” in the sense of “defer remaining for others to drain” is triggered. But see next section for who can actually drain.

---

## 9. Are deferred groups shared across worker processes?

**No.**

- `_deferred_groups` and `_deferred_lock` are module-level globals in `users.py` (357–358). Each **worker process** is a separate Python process that imports `users` and runs `_async_session_loop`. So each process has its **own** copy of `_deferred_groups`.
- When session A (worker process 0) hits FloodWait and calls `_defer_groups_starter(bot_token, remaining)`, the groups are appended to **process 0’s** `_deferred_groups[bot_token]`. Process 1’s `_deferred_groups` is a different dict (empty or unrelated).
- The drain loop (1910–2021) runs in each worker: `_pop_deferred_groups(bot_token, max_count=1)`. So each worker only pops from **its own** process’s `_deferred_groups`. So **no session can inherit another session’s slice** via the deferred queue across processes; only the same session (when it resumes in the same process) could drain the groups it had deferred. So “redistribution” to other **sessions** does not work in the current multiprocessing design; deferred groups are **not** shared across workers.

---

## 10. Can a session inherit other sessions’ slices?

- **Via assignment:** No. Each session’s slice is determined by its **own** `session_file` and its index in `sessions_list`. There is no code that assigns slice A to session B. So under the current (and pre-fix) assignment logic, a session does not “inherit” another’s slice in the sense of getting that slice from the partition formula.
- **Pre-fix:** When 4 sessions paused, the **one** remaining session got a slice that was the **whole** list (because denominator became 1). So that one session effectively got “everyone’s” groups not by inheritance but because the partition formula gave it 100% when T=1.
- **Via deferred:** In theory, if deferred were shared, a “healthy” session could drain groups deferred by a paused session and thus post to more than its own slice. But deferred is **not** shared (see above), so in practice a session does not inherit other sessions’ groups via deferred either.

---

## 11. Full flow diagram (scheduler → worker → controller → patch → next cycle)

```
[Worker process]
  _async_session_loop(session_ordinal, total_workers, session_file)
    │
    ├─ while True:
    │     │
    │     ├─ cfg = get_config()   ← merge(config_snapshot, local_config_patch)
    │     │     (local_config_patch updated when command_listener receives config_patch)
    │     │
    │     ├─ Wait until next_cycle_time (anchor + k*cycle_sec)
    │     │
    │     ├─ assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)
    │     │     │
    │     │     ├─ Enterprise: active_list = cfg.get("active_session_files")
    │     │     ├─ if active_list and session_file not in active_list → return [], len(all_groups)
    │     │     ├─ sessions_list = [s["file"] for s in cfg.get("sessions") or []]
    │     │     ├─ total_denom = len(sessions_list)  [or total_sessions if empty]
    │     │     ├─ idx_global = sessions_list.index(session_file)
    │     │     ├─ start, end = idx_global*n//total_denom, (idx_global+1)*n//total_denom
    │     │     └─ return all_groups[start:end], len(all_groups)
    │     │
    │     ├─ groups = pending_groups + list(assigned)  [capped by BUG-4]
    │     ├─ [ShardCheck] assigned=len(groups)
    │     │
    │     ├─ Posting loop over groups
    │     │     On FloodWaitPause:
    │     │       report_session_paused(...) → result_queue
    │     │       _defer_groups_starter(bot_token, remaining)  [process-local list]
    │     │       break
    │     │
    │     ├─ Drain deferred (Enterprise): _pop_deferred_groups(bot_token)  [same process only]
    │     │
    │     └─ report_cycle_done(session_file, scheduled_run_ts) → result_queue

[Controller process]
  _worker_result_handler_async: q.get() → _apply_worker_result(msg)
    │
    ├─ msg_type == "session_paused":
    │     _save_bot_config(bot_token, upd)  # session_pause_until[session_file] = unblock_time
    │     cfg_after_pause = _get_cfg(bot_token)
    │     active_list_p = _active_session_files(cfg_after_pause)  # excludes paused
    │     patch_p = { "session_pause_until": ..., "active_session_files": active_list_p }
    │     for each worker: cmd_q.put({"cmd": "config_patch", "patch": patch_p})
    │
    └─ msg_type == "cycle_done":
          _save_bot_config(bot_token, upd)  # last_cycle_time, optionally clear expired pause
          cfg_after = _get_cfg(bot_token)
          active_list = _active_session_files(cfg_after)
          patch = { "session_pause_until": ..., "active_session_files": active_list }
          for each worker: cmd_q.put({"cmd": "config_patch", "patch": patch})

[Worker process]
  command_listener: on cmd["cmd"] == "config_patch":
    local_config_patch.update(patch)  # next get_config() returns merged with new active_session_files

[Next cycle]
  get_config() includes patched active_session_files and session_pause_until
  _assigned_groups_for_session uses:
    - active_session_files only to allow/deny (return [] if not in list)
    - cfg["sessions"] for total_denom and idx_global → slice size capped by full session count
```

---

## 12. Exact failure condition that caused assigned=N (pre-fix)

- **Condition:** Enterprise mode; at least one session active; **all other** sessions paused (or excluded/cooldown) so that `_active_session_files(cfg)` returns a list of length **1**.
- **Mechanism:** Controller sent a **config_patch** with `active_session_files` = that single session (after processing `session_paused` and/or `cycle_done`). Workers merged the patch. On the **next** cycle, `_assigned_groups_for_session` used the **pre-fix** logic: `total = len(active_list) = 1`, `idx = active_list.index(session_file) = 0` → slice = `all_groups[0 : n]` → **assigned = N**.
- **Exact code path (pre-fix):** In `_assigned_groups_for_session`, Enterprise branch: `total = max(1, len(active_list))` → 1; `idx = active_list.index(session_file)` → 0; `start = 0`, `end = n`; return `all_groups[0:n]` → length N. So the **exact** failure was using **active_list** for both “who gets groups” and “partition denominator,” so when only one session was active the denominator became 1 and that session received the entire list.

---

## 13. Correct architectural fix (already in place)

- **Principle:** The **partition denominator** and **session index** for slice calculation must **not** depend on who is currently paused. They must be fixed to the **full configured session set** so that slice size is always at most ceil(N / T).
- **Implementation:** In `_assigned_groups_for_session` (Enterprise), do **not** use `len(active_session_files)` for the partition. Use `sessions_list` from `cfg.get("sessions")` and set `total_denom = len(sessions_list)`, `idx_global = sessions_list.index(session_file)`. Compute `start = idx_global * n // total_denom`, `end = (idx_global + 1) * n // total_denom` and return `all_groups[start:end]`. Keep using `active_session_files` only to **gate** assignment (return `[]` if this session is not in the active list). So paused sessions still get 0 groups (early return or “not in active_list”), but the **size** of the slice for any non-paused session is always bounded by ceil(N / total_configured_sessions). This prevents overload collapse permanently regardless of how many sessions pause.

---

## 14. Summary table

| Question | Answer |
|----------|--------|
| Shard denominator (current) | `len(cfg["sessions"])` (full list); fallback `total_sessions` if empty. |
| Shard denominator (pre-fix) | `len(active_session_files)` → became 1 when 4 paused, 1 active. |
| 5 sessions, 4 paused, 1 active (pre-fix) | `active_session_files` has 1 element → total=1 → one session gets all groups. |
| 5 sessions, 4 paused, 1 active (post-fix) | `total_denom = 5`, slice size ≤ ceil(N/5); no session gets N. |
| When is active_session_files patched? | On every `session_paused` and every `cycle_done` (controller sends to all workers). |
| When is it rebuilt? | Each time controller handles session_paused or cycle_done, via `_active_session_files(cfg_after)`. |
| Does patch timing affect shard? | Post-fix: no (denominator from cfg["sessions"]). Pre-fix: yes (stale patch could delay denominator=1 by one cycle). |
| Do paused sessions reduce denominator? | Pre-fix: yes. Post-fix: no. |
| No session &gt; ceil(N/T)? | Post-fix: verified. Pre-fix: false when only 1 active. |
| config_patch mid-cycle → stale? | Next cycle uses new config; post-fix slice size still capped by cfg["sessions"]. |
| FloodWaitPause trigger redistribution? | Triggers config_patch (active list shrinks); Enterprise also defers remaining (process-local). |
| Deferred shared across workers? | No; each process has its own _deferred_groups. |
| Session inherit other’s slice? | No; slice is by session index in full list; deferred not shared. |
| Exact failure for assigned=N | active_list length 1 → total=1, idx=0 → return all_groups[0:n]. |
| Fix | Use cfg["sessions"] for total_denom and idx_global; keep active_session_files for allow/deny only. |
