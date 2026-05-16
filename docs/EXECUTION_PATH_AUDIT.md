# Execution-Path Audit: Posting Reliability, Skip Scenarios, Silent Failures

## Part 1 — Session Loop Execution Trace

Full flow: `_async_session_loop` (users.py:1065) → connect → assignment → main group loop → (Enterprise) drain loop → disconnect → sleep.

**Every branch where a group may not be attempted during a cycle:**

| # | Condition | File:Line | Effect | Permanent or temporary skip | Recovered next cycle? |
|---|-----------|-----------|--------|-----------------------------|------------------------|
| 1 | `stop_event.is_set()` at loop start | 1115–1119 | Session exits; no groups attempted this cycle | Temporary (session stopped) | No (session no longer runs) |
| 2 | No config / `cfg` missing | 1126–1130 | Session exits | Temporary (config issue) | No (until config fixed) |
| 3 | `state != "running"` (controller only) | 1132–1136 | Session exits | Temporary | Yes (when state set back to running) |
| 4 | `global_flood_pause_until` active | 1138–1150 | Cycle skipped; `continue` to next iteration | Temporary | Yes (after pause + stagger) |
| 5 | Subscription expired `valid_till` | 1151–1162 | Session exits | Permanent (until plan renewed) | No |
| 6 | Session in cooldown `session_cooldown_until` | 1164–1181 | Cycle skipped; sleep until cooldown ends then `continue` | Temporary | Yes |
| 7 | Scheduler: `delta_sec > 0` (not due yet) | 1201–1219 | Cycle delayed; sleep then re-evaluate | Temporary | Yes (cycle runs when due) |
| 8 | Connect failure `_connect_session_for_cycle` | 1236–1245 | Session exits; no groups attempted | Temporary | No (session stopped) |
| 9 | Session PAUSED (FloodWait) at cycle start | 1304–1317 | Entire cycle skipped; `continue` | Temporary | Yes (next cycle when unpaused) |
| 10 | `len(groups) == 0` (excluded / cooldown / empty file) | 1328–1334 | No groups to post; connect/sleep only | Depends (exclusion permanent for that session until config change; cooldown temporary) | Yes if cause is cooldown or empty file later filled |
| 11 | `stop_event` or state != running inside loop | 1353–1356 | Break out of group loop; remaining not attempted | Temporary | Yes (next cycle) |
| 12 | `get_ban_skip` / `_should_skip_target_for_ban` | 1358–1361 | This group skipped; `continue` | Permanent for this (session, group) | No for this session; other sessions (Starter) may still attempt |
| 13 | `get_entity` returns None (main loop) | 1387–1394 | Ban/entity recorded; `continue` | Permanent for this session (ban count) | No for this session |
| 14 | `result is None` (with_retry gave up) | 1419–1441 | `_log_post_result` failure; optional ban increment; `continue` | Depends (topic ban → permanent for session) | Next cycle same session will retry unless ban |
| 15 | **FloodWaitPause** (main loop) | 1458–1469 | Session paused; `remaining = groups[idx:]`; Enterprise: deferred; Starter: **not** deferred; `break` | Temporary | **Starter**: Yes (next cycle full list). **Enterprise**: Yes (drain or next cycle shard) |
| 16 | **Exception → MARK_SESSION_BANNED** (main loop) | 1472–1492 | `_log_post_result` then `return`; session exits | Permanent for this session (session dead) | No (session replaced/restarted separately) |
| 17 | Other exception in main loop (non-banned) | 1495–1519 | `_log_post_result`; ban pattern check; `continue` | Temporary or permanent (if ban pattern) | Next cycle unless ban |
| 18 | Drain (Enterprise): `_should_skip_target_for_ban` | 1533–1534 | This deferred group skipped; `continue` | Permanent for this (session, group) | No for this session |
| 19 | Drain: `get_entity` returns None | 1547–1550 | `_increment_ban_error_count`; `continue` | Permanent for this session | No for this session |
| 20 | Drain: FloodWaitPause | 1595–1599 | Push group back; `drain_flood_paused = True`; break drain | Temporary | Yes (same or other session will pop again) |
| 21 | Drain: MARK_SESSION_BANNED | 1602–1610 | `return`; session exits | Permanent for session | No |
| 22 | Worker crash / process kill mid-cycle | (external) | No defer; in-memory state lost | Temporary | Yes (next cycle fresh assignment) |
| 23 | Controller restart / stop bot | 2194, 2367 | `_deferred_groups.pop(bot_token)` in controller; workers terminated | Temporary (deferred queue lost in worker memory) | Yes (next cycle; Enterprise reshards) |

**FloodWait handling:**  
- Cycle start: if session PAUSED, skip whole cycle (9).  
- Main loop: on FloodWaitPause, remaining groups deferred only in Enterprise (15); Starter skips remaining this cycle.  
- Drain: on FloodWaitPause, push current group back and stop draining (20).

**session_died paths:**  
- MARK_SESSION_BANNED in main loop (16) or drain (21) → `report_session_died` or `_mark_session_dead_and_replace` → `return`. No defer; remaining groups (main loop) not deferred in Starter; in Enterprise already deferred only for that session’s remaining.

**empty group assignment:**  
- From excluded_sessions, session_cooldown_until, or empty group file (10). Session still runs (connects, sleeps).

**entity None:**  
- Main loop (13): report_ban_error / _increment_ban_error_count, `continue` — **no** `_log_post_result` (no post_attempt log).  
- Drain (19): same — no post_attempt log.

**cooldown / exclusion:**  
- Cooldown at cycle start (6); exclusion and cooldown at assignment (10) via `_assigned_groups_for_session` (users.py:896–903).

**unexpected worker exit:**  
- (22) Process kill/crash: no defer; next cycle new process gets fresh assignment. Groups not attempted this cycle are attempted next cycle.

---

## Part 2 — Starter Mode Reliability Risk

**Behavior:**  
- All sessions receive the **same** full group list (same order every cycle).  
- FloodWait: remaining groups in that session are **not** deferred; they are skipped for this cycle. Next cycle every session again gets the full list.

**Worst-case % of groups skipped per cycle under heavy FloodWait:**  
- If **every** session hits FloodWait on its **first** group, then 0 groups are posted this cycle (100% skipped).  
- If session order is fixed and group order is fixed, the **same** session tends to hit FloodWait at a similar position each time (e.g. always at group 10). Then that session skips groups 10..N every cycle until FloodWait eases. So **one session** can repeatedly skip the **tail** of the list (e.g. 90% of groups if N=100 and it fails at index 10).  
- Other sessions still process the full list (until they hit FloodWait). So worst-case **per session**: up to 100% of its list skipped (tail). **Globally**: depends how many sessions hit FloodWait and where; in the extreme, if all sessions hit at the same index, that cycle we get only that many attempts total.

**Can some groups repeatedly fall near the end and be skipped many consecutive cycles?**  
- **Yes.** In Starter, list order is stable (from file + same parse order). Session A might always hit FloodWait after group 5. Then groups 6..N are **always** skipped by session A. Other sessions (B, C, …) each have the **same** list; if they run later (stagger), they might also hit FloodWait at a similar position (e.g. after 5). So groups 6..N could be attempted only by sessions that haven’t hit FloodWait yet. If **all** sessions hit FloodWait early in the list, the **tail** groups (e.g. 6..N) can be skipped **every** cycle by **every** session — i.e. **repeatedly starved** until FloodWait backs off.

**Would rotating group order each cycle improve fairness?**  
- **Yes.** If the list is rotated by a cycle-based index, then the “tail” (groups that would be skipped when FloodWait hits) changes each cycle. Over K cycles, each group would appear in the “tail” roughly equally often, so no group is systematically last and starved.

**Proposal: `rotate_group_list_by_cycle_index()`**  
- Implement in assignment path for **Starter** only:  
  - Compute `cycle_index = int(time.time() // max(1, cycle_sec)) % max(1, len(all_groups))`.  
  - Return `order[cycle_index:] + order[:cycle_index]` so the logical “start” of the list rotates each cycle.  
- This does not change total work; it only changes which groups are at the front vs back when a session hits FloodWait, improving long-term fairness.

---

## Part 3 — Enterprise Mode Redistribution Completeness

**If a worker crashes mid-cycle without FloodWait defer:**  
- The groups that were assigned to that worker (its shard) but not yet attempted are **not** deferred (defer only happens on FloodWaitPause). So those groups are **not** attempted this cycle.  
- Next cycle: assignment is **fresh** from `_assigned_groups_for_session` (new shard from current group file). Every group is in exactly one shard. So **all** groups, including those that were in the crashed worker’s shard, are assigned again.  
- **Conclusion:** Those groups **are** guaranteed to be attempted next cycle. No permanent loss.

**Deferred queue integrity if controller restarts mid-cycle:**  
- Deferred queue lives in **worker process** memory (`_deferred_groups` in users.py). Controller has its **own** module-level `_deferred_groups`; when controller calls `_deferred_groups.pop(bot_token, None)` on stop/start, it clears only the **controller’s** dict. Worker processes are terminated on stop; when they exit, their in-memory `_deferred_groups` is lost.  
- On controller **restart** (or stop then start), new worker processes start with **empty** `_deferred_groups`. So any groups that were in the deferred queue (in the old workers) are **lost** from that queue.  
- Those groups are **not** lost from the rotation: next cycle, each is again in some session’s shard. So we lose **only** the optimization of having them attempted in the same cycle via drain.  
- **Conclusion:** Deferred queue is **not** persisted; controller restart mid-cycle **loses** the in-worker deferred list for that cycle only. Coverage is recovered next cycle.

**Does `_deferred_groups` require persistence to disk to avoid loss?**  
- **For correctness (no group permanently missed):** No. Every group is re-assigned every cycle; no group is ever only in the deferred queue forever.  
- **For same-cycle completeness (all deferred groups attempted before next cycle):** Yes. If we want “no group dropped from the current cycle’s work when controller or worker restarts,” we would need to persist the deferred queue (e.g. to disk or shared store) and reload it when workers start.

**Output:**  
- **DeferredQueuePersistenceRequired** = **False** for coverage correctness (no permanent loss).  
- **DeferredQueuePersistenceRequired** = **True** if the product requirement is “deferred groups must be attempted before next cycle even across controller/worker restart.”  
- **PotentialLossScenario** = Controller restart or worker crash while deferred queue is non-empty: those deferred groups are not attempted this cycle; they are attempted next cycle via normal assignment.

---

## Part 4 — Posting Attempt Observability

**Structured post_attempt log:**  
- Emitted by `_log_post_result()` which calls `report_post_attempt(session_file, chat_id, topic_id, success, reason)` (users.py:753–754).  
- In workers, `report_post_attempt` puts a message on `result_queue`; controller handles `msg_type == "post_attempt"` and writes to user log + flood/cooldown logic (users.py:1780–1827).

**Paths where a posting failure or skip may occur WITHOUT generating a post_attempt log:**

| Path | File:Line | Reason |
|------|-----------|--------|
| Skip due to ban (`get_ban_skip` / `_should_skip_target_for_ban`) | 1358–1361 | `continue` without calling `_log_post_result` or `report_post_attempt`. |
| `get_entity` returns None (main loop) | 1387–1394 | `report_ban_error` / `_increment_ban_error_count`; `continue`. No `_log_post_result`. |
| Drain: `get_entity` returns None | 1547–1550 | `_increment_ban_error_count`; `continue`. No `_log_post_result`. |
| Drain: skip for ban | 1533–1534 | `continue`. No `_log_post_result`. |

All other failure paths (result is None, exception with _log_post_result, MARK_SESSION_BANNED with _log_post_result before return) **do** produce a post_attempt (via _log_post_result).

**Worker crash mid-send:**  
- If the worker crashes **after** `result_queue.put(...)` for the post_attempt, the controller can still process it; attempt is visible.  
- If the worker crashes **before** or during the put (e.g. during `_log_post_result` or inside `with_retry` before any log), that attempt is **not** visible. So **worker crash mid-send can lose attempt visibility** for the in-flight attempt.

**Controller-level logging fallback if worker logging fails:**  
- Controller’s result handler writes to user log via `append_to_user_log`; if that raises, the handler is in a try/except. Checking: the loop that processes result_queue (e.g. _worker_result_handler_async) — if one message handling fails, does it log?  
- users.py ~1766: `enqueue_log` / `append_to_user_log`; exceptions in the handler could be caught by an outer try/except. If the handler does **not** catch and log exceptions, a controller-side failure (e.g. disk full) could drop the log without a fallback.  
- **Recommendation:** Ensure the result handler has a catch-all that logs to at least logger/stdio so that “worker sent post_attempt but controller failed to write” is visible.

**Uncovered paths (no post_attempt):**  
1. Ban skip (main loop) — users.py:1358–1361  
2. Entity None (main loop) — users.py:1387–1394  
3. Ban skip (drain) — users.py:1533–1534  
4. Entity None (drain) — users.py:1547–1550  
5. Worker crash before/during _log_post_result — no code path; inherent.

---

## Part 5 — Coverage Assurance Simulation

**Analytical verification functions (code/coverage_sim.py):**  
- `simulate_cycles(groups=N, sessions=T, cycles=K, mode="Starter"|"Enterprise", flood_prob_per_attempt=0.0)`  
  - Simulates assignment + optional FloodWait: each “attempt” has a configurable probability of FloodWait; on FloodWait (Starter) remaining groups of that session are skipped for that cycle; (Enterprise) deferred and drained.  
  - Returns per-group attempt counts, groups_never_attempted, per_cycle_skipped, and mode/params.  
- `estimate_attempt_distribution(attempt_counts)`  
  - Returns min, max, mean, variance, and histogram of how many times each group was attempted.  
- `estimate_skipped_probability(attempt_counts, total_cycles, sessions, mode)`  
  - For Starter: expected attempts per group per cycle = sessions; for Enterprise = 1. Returns groups_with_zero_attempts and skip_probability_estimate (fraction of groups with zero attempts).

**Run:** `python -m code.coverage_sim [groups] [sessions] [cycles] [Starter|Enterprise] [flood_prob]`  
Example: `python -m code.coverage_sim 100 5 10 Starter 0.05` → report includes groups_never_attempted, attempt_distribution, skip_estimate, per_cycle_skipped.

Simulation uses the same assignment logic (Starter: full list rotated by cycle index; Enterprise: shard) and a simple FloodWait model (random per attempt) to estimate long-term coverage fairness and variance.

---

## Summary Deliverables

1. **Complete “group skip path” table** — Part 1 table above (23 rows).  
2. **Starter vs Enterprise coverage reliability comparison:**  
   - **Starter:** Same list for all; FloodWait causes tail skip; risk of repeated starvation for tail groups; rotation recommended.  
   - **Enterprise:** Sharded; FloodWait defers and drains; crash/restart loses deferred queue for current cycle only; next cycle full coverage.  
3. **Repeated starvation:** Yes in Starter when group order is fixed and sessions repeatedly hit FloodWait at similar positions; rotation by cycle index mitigates.  
4. **Deferred queue persistence:** Not required for correctness; required for same-cycle completeness across restarts.  
5. **Recommended improvements:**  
   - Add `rotate_group_list_by_cycle_index()` for Starter and use it in assignment.  
   - Add post_attempt (or explicit “skip” log) for ban-skip and entity-None paths so every skip is observable.  
   - Ensure controller result handler logs any exception when processing post_attempt so worker success + controller write failure is visible.
