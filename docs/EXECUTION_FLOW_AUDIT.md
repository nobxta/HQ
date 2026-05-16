# AdBot Scheduler & Posting Engine — Full Execution-Flow Audit

**Goal:** Guarantee deterministic posting where **Run → first post within 1–2 seconds** when at least one active session and one group exist.

---

## PHASE 1 — Execution Timeline Reconstruction

Trace: **Run button → callback → _start_posting() → worker spawn → START → _async_session_loop() → _assigned_groups_for_session() → first post**.

| Stage | File | Wait condition | Delay range | Should exist? |
|-------|------|----------------|-------------|----------------|
| 1. Run callback | users.py | — | 0 | — |
| 2. Pending STOP cleanup | users.py ~2455–2460 | `_pending_stop_cleanup`; await previous stop | 0–50 s | Yes (avoid spawn during teardown) |
| 3. Start guard (duplicate Run) | users.py ~2462–2464 | None | 0 | Yes |
| 4. Teardown old workers | users.py ~2483–2489 | STOP sent, `_join_workers_sync` | 0–15 s (join_timeout) | Yes |
| 5. Status: "Checking configuration..." | users.py ~2528–2530 | `await asyncio.sleep(0.2)` | 0.2 s | Yes (UI only; reduced for determinism) |
| 6. Zero-group filter | users.py ~2533–2546 | None | 0 | Yes |
| 7. Status: "Checking sessions..." | users.py ~2558–2560 | `await asyncio.sleep(0.2)` | 0.2 s | Yes |
| 8. Snapshot + anchor | users.py ~2564–2568 | None | 0 | — |
| 9. Status: "Assigning groups..." | users.py ~2612–2614 | `await asyncio.sleep(0.2)` | 0.2 s | Yes |
| 10. Worker process spawn | users.py ~2618–2625 | `proc.start()` per worker | &lt;1 s | — |
| 11. Status: "Starting workers..." | users.py ~2647–2649 | `await asyncio.sleep(0.2)` | 0.2 s | Yes |
| 12. START sent | users.py ~2664–2669 | None | 0 | — |
| 13. Worker: wait for START | workers.py ~284–296 | `asyncio.wait([start_task, stop_task])`; START already in queue | 0 (queue already has START) | Yes |
| 14. Stagger (first cycle) | users.py ~1209–1214 | `stagger_sec` sleep **only if** `not run_first_cycle_immediately` | 0 when run_first; else up to STAGGER_WINDOW_SEC or ENTERPRISE_STAGGER_SEC | No for first cycle (skipped) |
| 15. Global flood shield | users.py ~1247–1261 | `global_pause_until > now` → sleep until `wait_until` | Arbitrary (safety) | Yes (intentional) |
| 16. Cooldown | users.py ~1274–1291 | `cooldown_until > now` → sleep in chunks | Up to ~15 min | Yes (intentional) |
| 17. next_cycle_time / first cycle | users.py ~1299–1312 | With `run_first_cycle_immediately`: `next_cycle_time = now_ts`, `delta_sec = 0` | 0 | — |
| 18. Delta sleep (not due) | users.py ~1322–1342 | `while delta_sec > 0: sleep(chunk)` | 0 when run_first | Yes |
| 19. Per-session FloodWait | users.py ~1420–1446 | `pause_until > now` → sleep until unblock | Arbitrary | Yes (intentional) |
| 20. Connect + assign + first post | users.py ~1346–1446+ | Connect, `_assigned_groups_for_session`, post loop | ~0.3–1 s | — |

**Controller-only delay (before first post):** 4 × 0.2 s = **0.8 s** (status steps). With no pending STOP and no global/cooldown/FloodWait, **Run → first post in ~1–2 s** is achievable.

---

## PHASE 2 — Hidden Delay Conditions Audit

For each pattern: **can delay first cycle?** | **can interrupt a running cycle?** | **can silently skip a cycle?** | **unsafe/nondeterministic?**

| Location | Pattern | Delay first cycle? | Interrupt cycle? | Skip cycle? | Notes |
|---------|--------|-------------------|------------------|-------------|--------|
| users.py ~2530,2560,2614,2649 | `sleep(0.2)` | Yes (0.8 s total) | No | No | Intentional UI; reduced from 0.35 for &lt;2 s target. |
| users.py ~1210–1214 | stagger `sleep(stagger_sec)` | Yes **unless** `run_first_cycle_immediately` | No | No | Skipped when run_first; deterministic. |
| users.py ~1254–1260 | global_pause_until loop | Yes | No | No | Intentional flood shield. |
| users.py ~1282–1290 | cooldown_until loop | Yes | No | No | Intentional; persisted. |
| users.py ~1300–1304, 1322–1336 | next_cycle_time / delta_sec sleep | No when run_first | No | No | run_first sets delta_sec=0. |
| users.py ~1336 | `sleep(chunk)` in delta loop | No (run_first) | No | No | Only when delta_sec &gt; 0. |
| users.py ~1420–1446 | pause_until (FloodWait) | Yes | No | No | Intentional; session sleeps until unblock. |
| users.py ~1528–1544, 1556 | pause_until in post loop | No (first cycle already started) | No (same cycle continues after wait) | No | Mid-cycle FloodWait; cycle not skipped. |
| users.py ~1825 | `sleep(gap)` between posts | No (within cycle) | No | No | Per-post gap. |
| users.py ~1860–1868 | heartbeat_interval sleep in post loop | No (chunk ≤ remaining) | No | No | Keeps cycle alive. |
| users.py ~1165 | SESSION_RECONNECT_DELAY_SEC | Only if connect fails and retry | No | No | Reconnect retry. |
| workers.py ~271–272 | command_listener `wait_for(..., timeout=10)` | No | No | No | Just waits for next command. |
| users.py ~2456–2460 | pending STOP cleanup | Yes (0–50 s) | N/A | No | Only after Stop; next Run waits. |
| users.py ~2868, 2851 | run_session_health_monitor sleep | No (background) | No | No | Health check interval. |
| users.py ~2874–2882 | grace_until (startup grace) | No | No | No | Prevents restart during init. |
| users.py ~2890–2906 | heartbeat timeout → restart | No | **Yes** (restart worker) | No | Only when worker truly frozen. |
| users.py ~2922–2946 | startup_failure restart | No (after 600 s, and skip if FloodWait) | Yes (restart worker) | No | Does not fire during first cycle. |
| users.py ~2952–2965 | alive &lt; expected → full restart | No | Yes (full restart) | No | Only when process died. |
| users.py ~2565–2566 | cycle_anchor_ts (set on Run) | No | No | No | Deterministic anchor. |
| users.py ~1930 | cycle_anchor_ts in snapshot | No | No | No | Read-only. |
| users.py ~2503–2506 | preserve_cycle_time (no reset last_cycle_time) | No | No | No | Health restart keeps anchor. |
| users.py ~1977–1987 | config_patch (session_pause_until + active_session_files) | No | No | No | After cycle_done; no skip. |

**Unsafe / nondeterministic logic (addressed):**

- **Stale `active_session_files` in workers** — Fixed: config_patch now sends `active_session_files` after cycle_done so FloodWait-cleared sessions get groups without restart.
- **Controller status sleeps** — Reduced to 0.2 s each so total 0.8 s; keeps first post within 1–2 s when run_first and no other delays.

---

## PHASE 3 — Cycle Determinism Verification

**Invariant:**  
If `run_first_cycle_immediately == True` **and** session not in FloodWait **and** groups exist **⇒** first post must happen within 1–2 seconds after Run.

**Verification:**

1. **run_first_cycle_immediately** — Set in snapshot when `not preserve_cycle_time` (users.py ~2568). Worker receives it in `get_config()`.
2. **Stagger** — Skipped when `run_first_cycle_immediately` (users.py ~1209–1214): worker reads config before stagger; if flag set, no initial sleep.
3. **next_cycle_time** — Overridden to `now_ts` and `delta_sec = 0` for first cycle only (users.py ~1305–1311).
4. **Delta sleep** — Not entered when `delta_sec == 0`.
5. **FloodWait / cooldown / global shield** — Not skipped by run_first (intentional); they can delay first post only when session is actually in those states.

**Blocking logic that could still delay first cycle (intentional, not bugs):**

- Pending STOP cleanup (0–50 s) — only after a previous Stop.
- Global flood shield, cooldown, or per-session FloodWait — safety/rate limits.

**Minimal patch already applied:**  
None required for invariant; controller status sleeps reduced to 0.2 s (4 × 0.2 = 0.8 s) so that with no other delays, first post occurs within 1–2 s.

**Later cycles:** Remain anchor-based; `cycle_anchor_ts` set once at Run; `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec`; no recalculation of anchor inside worker loop.

---

## PHASE 4 — Active Session Assignment Correctness

**_active_session_files:**  
users.py ~1891–1906. Returns session files that are not excluded, not paused (`session_pause_until` ≤ now), and not in cooldown. Used for Enterprise partition.

**_assigned_groups_for_session:**  
users.py ~976–1019. Excluded → []. FloodWait (pause_until &gt; now) → []. Cooldown → []. Starter: full list rotated. Enterprise: if `active_session_files` present, session must be in list else []; partition by `len(active_session_files)`.

**Checks:**

1. **Sessions that exit FloodWait rejoin automatically** — Yes. On cycle_done, controller clears `session_pause_until` for that session and pushes **config_patch** with both `session_pause_until` and **active_session_files** (users.py ~1977–1987). Workers merge patch in `get_config()`; next assignment uses updated active list.
2. **active_session_files updated in workers via config_patch** — Yes. workers.py ~276–281: `config_patch` command updates `local_config_patch`; `get_config()` merges it (91–97). Patch includes `active_session_files` (users.py ~1983).
3. **No active session gets zero groups when groups ≥ active_sessions** — Yes, provided snapshot/patch are correct. Enterprise partition: `total = len(active_list)`, each active session gets slice `[idx*n//total : (idx+1)*n//total]`; if session is in active_list and groups exist, slice non-empty.
4. **No stale snapshot after cycle_done** — Addressed. Previously only `session_pause_until` was patched; workers kept stale `active_session_files`. Now patch sends both; no restart needed.

**Race condition:**  
The only subtlety is timing: config_patch is sent after cycle_done; the *next* cycle in each worker will see updated config. There is no race that leaves an active session with zero groups indefinitely once FloodWait is cleared and patch is applied.

---

## PHASE 5 — Worker Lifecycle Stability

**Heartbeat restart (users.py ~2873–2906):**  
If `now < grace_until` → skip. Else if no heartbeat for `timeout_sec` (max(120, 2*cycle_sec)) → `_restart_single_worker`.  
- **Interrupt active cycle?** Yes — sends STOP, joins process, spawns new one. Intended only when worker is actually frozen (e.g. stuck in long blocking call).  
- **Cycle skip?** Restart builds new snapshot with same `cycle_anchor_ts` (from cfg); new worker continues from same anchor; no skip.  
- **Anchor preserved?** Yes; _restart_single_worker uses `_build_worker_config_snapshot(cfg, total_sessions)` with current cfg (preserves cycle_anchor_ts); no `run_first_cycle_immediately` so next run is anchor-based.

**Startup failure restart (users.py ~2915–2942):**  
After grace, if not in `_worker_first_cycle_or_post` and `now > start_ts + 600`, and **session not in FloodWait** (pause_until ≤ now), restart that worker.  
- **Interrupt active cycle?** Only after 600 s with no cycle/post; does not fire during normal first cycle.  
- **Skip if FloodWait?** Yes — `if pause_until > now: continue` (2931–2932).  
- **Anchor preserved?** Same as above; restart uses preserve_cycle_time path when health monitor calls _start_posting.

**alive &lt; expected (users.py ~2948–2965):**  
Full restart only when `alive < expected`. Skips if `not running` or `alive == expected`.  
- **Interrupt?** Yes — full teardown and _start_posting(preserve_cycle_time=True).  
- **Cycle skip?** No; anchor preserved; new workers get same anchor from cfg.  
- **Restart while actively posting?** Only when a process has actually died (alive &lt; expected), so acceptable.

**Conclusion:**  
- Worker restart does not happen “while actively posting” unless the worker is actually dead or frozen (heartbeat timeout / startup failure after 600 s).  
- Restart does not cause cycle skipping; anchor is preserved.  
- No patch required for Phase 5 beyond existing logic (grace, FloodWait skip for startup failure, alive == expected skip).

---

## PHASE 6 — Final Required Outcome

### Root causes of nondeterministic timing (addressed)

1. **Stagger before first cycle** — Fixed: skip stagger when `run_first_cycle_immediately` (users.py ~1209–1214).  
2. **First cycle waiting for cycle boundary** — Fixed: when run_first, set `next_cycle_time = now_ts`, `delta_sec = 0` (users.py ~1305–1311).  
3. **Stale `active_session_files` in workers after FloodWait clear** — Fixed: config_patch after cycle_done includes `active_session_files` (users.py ~1977–1987, 1983).  
4. **Controller status sleeps** — Reduced from 0.35 s to 0.2 s each (users.py ~2530, 2560, 2614, 2649) so total 0.8 s; keeps Run → first post within 1–2 s when no other delays.

### Exact file/line patches applied

| File | Location | Change |
|------|----------|--------|
| users.py | ~2529–2530 | `await asyncio.sleep(0.35)` → `await asyncio.sleep(0.2)` (Checking configuration) |
| users.py | ~2559–2560 | `await asyncio.sleep(0.35)` → `await asyncio.sleep(0.2)` (Checking sessions) |
| users.py | ~2613–2614 | `await asyncio.sleep(0.35)` → `await asyncio.sleep(0.2)` (Assigning groups) |
| users.py | ~2648–2649 | `await asyncio.sleep(0.35)` → `await asyncio.sleep(0.2)` (Starting workers) |
| users.py | (existing) | config_patch after cycle_done: include `active_session_files` (~1977–1987) |
| users.py | (existing) | run_first_cycle_immediately in snapshot and first-cycle branch (~1305–1311, ~1209–1214) |

(All other behavior was already correct per Phases 1–5.)

### Verification checklist (deterministic behavior)

- [ ] **Run → posting starts immediately**  
  Press Run with ≥1 active session and ≥1 group; no FloodWait/cooldown/global shield. First post occurs within 1–2 s (check log "Posted in..." or post_attempt in user log).
- [ ] **Cycles every cycle_sec**  
  After first cycle, next cycle at `cycle_anchor_ts + 2*cycle_sec`, etc. Check logs for [CycleStart] and timestamps.
- [ ] **FloodWait sessions rejoin**  
  One session hits FloodWait; after unblock, controller sends config_patch with cleared pause and updated active_session_files. That session gets groups again on next cycle without bot restart.
- [ ] **No silent cycle skip**  
  No extra long gap between cycles unless FloodWait/cooldown/global shield (check scheduler_health / user log).
- [ ] **No random posting delays**  
  With run_first and no safety delays, first post within 1–2 s; no unexplained multi-minute delay.
- [ ] **No worker restart while actively posting**  
  Health monitor restarts only when: process dead (alive &lt; expected), heartbeat frozen (after timeout), or startup failure (after 600 s and not in FloodWait). Grace period prevents restart during init.
- [ ] **No session with zero groups while active**  
  Enterprise: after FloodWait clear, config_patch updates active_session_files; that session gets non-empty slice when groups exist.

---

**Summary:**  
Deterministic posting is achieved by: (1) running the first cycle immediately when `run_first_cycle_immediately` is set and skipping stagger for it, (2) pushing `active_session_files` in config_patch after cycle_done so FloodWait-cleared sessions get groups without restart, and (3) reducing controller status sleeps to 0.2 s so total pre-worker delay is 0.8 s. No new features were added; only scheduler determinism and posting timing fixes.
