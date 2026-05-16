# Enterprise Sharding and Cycle Analysis

**Update:** Enterprise was redesigned for **deterministic per-group scheduling**. Each session now processes only its shard (no rollover, no pending). Per-group interval = `cycle_sec`. See code comments in `users.py` (search for "DETERMINISTIC ENTERPRISE") and the new log fields `shard_size`, `groups_posted_this_cycle`, `cycle_start_ts`, `cycle_end_ts`, `expected_next_run_ts`.

---

This document answers: why `assigned_this_session=124` used to appear, why group assignment looked dynamic, and why the effective per-group posting interval was ~1 hour instead of 10 minutes (before the deterministic redesign).

---

## 1. How Group Sharding Is Implemented

**Location:** `code/users.py`, `_assigned_groups_for_session` (lines 980–1063).

- **Enterprise branch:** Uses the **full** session list from config (`sessions_list`), not the active list, for the **partition denominator**:
  - `total_denom = len(sessions_list)` (e.g. 5)
  - `idx_global = sessions_list.index(session_file)` (0..4)
  - `start = idx_global * n // total_denom`, `end = (idx_global + 1) * n // total_denom`
  - Returns `all_groups[start:end]` → **shard of size ≈ 25** for 124 groups and 5 sessions.

- **Who gets a shard:** Before the partition, the function returns early with `[], len(all_groups)` if:
  - session is in `excluded_sessions`
  - session is in **FloodWait pause** (`session_pause_until[session_file] > now`)
  - session is in cooldown
  - **Enterprise only:** `active_list = cfg.get("active_session_files")` and `if active_list and session_file not in active_list` → return `[], len(all_groups)`.

So **shard math is fixed** (index in full session list, denominator = total sessions). Assignment is **recomputed every cycle** from current config (including `session_pause_until` and `active_session_files`). There is no persistent “group → session” map; each cycle, each session calls `_assigned_groups_for_session` and gets its slice.

---

## 2. Why You See `assigned_this_session=124`

**The log line is misleading:** it reports **groups this cycle**, not **shard size**.

- **Assignment:** `assigned, total_groups = _assigned_groups_for_session(...)` → `assigned` is the shard (~25).
- **Combined list:** `groups = pending_groups + list(assigned)`, then capped (see below).
- **Verification report:** `_verify_assignment_report(mode, total_workers, total_groups, session_ordinal, len(groups), report_user_log)`.

So the 5th argument is **`len(groups)`**, i.e. **assigned + pending**, not `len(assigned)`. That is why you see `assigned_this_session=124` when a session has a lot of **rollover** from previous cycles.

**Where pending comes from:** If the session doesn’t finish its list before the cycle window ends:

```python
# users.py ~1650–1658
if time.time() >= cycle_end_ts:
    remaining = groups[idx:]
    pending_groups.extend(remaining)
    ...
    break
```

So **pending_groups** = groups not posted this cycle. Next cycle:

```python
_combined = pending_groups + list(assigned)
_max_groups = max(len(assigned), total_groups, 1)  # = max(25, 124, 1) = 124
groups = _combined   # can be up to 124
_verify_assignment_report(..., len(groups), ...)   # reports 124 as "assigned_this_session"
```

So:

- **Shard size is still ~25** (from `_assigned_groups_for_session`).
- **Reported “assigned_this_session”** is actually **groups this cycle** (assigned + pending), so it can be 105, 122, 124, etc., when there is heavy rollover.

---

## 3. How Cycle Scheduling Is Triggered

**Location:** `_async_session_loop` in `code/users.py` (~1416–1460).

- **Anchor:** `cycle_anchor = float(cfg.get("cycle_anchor_ts") or now_ts)` (set once at Run).
- **Next run time:**  
  `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec`  
  with `cycle_index = int((now_ts - cycle_anchor) // cycle_sec)`.
- **First cycle:** If `run_first_cycle_immediately`, first `next_cycle_time = now_ts` (no wait).
- **Waiting:** Loop sleeps in chunks until `scheduled_time` (i.e. `next_cycle_time`), then runs **one** cycle (assign → post → cycle_done), then waits for **next** boundary.

So:

- **Trigger:** Time-based only; cycle runs at **anchor + k·cycle_sec**, not when the previous loop “finishes”.
- **next_run** is **fixed** to that boundary (not “loop completion time”).
- **cycle_due_in** is computed as `(scheduled_run_ts + cycle_sec) - now` (~1696), i.e. time until the **current** cycle window ends. So `cycle_due_in=600` is correct for a 600 s cycle; it does not imply that each group is posted every 600 s (see below).

---

## 4. How Assigned Groups Are Stored Per Session

- **Not persisted.** Each cycle, the worker calls `get_config()` (snapshot + patch), then `_assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`. The returned list is used only for that cycle.
- **Pending:** Only **pending_groups** (rollover) is kept in the worker between cycles; it’s in-memory per session. It is **prepended** to the next cycle’s `assigned`, so the **same** groups can be at the head of the list again and get posted first, while the **new** shard is at the tail.

So:

- **Group–session mapping:** Effectively persistent by **index**: session `i` always gets slice `[i*N//T : (i+1)*N//T]` of the **current** `all_groups` list (same order every time). So the same group stays in the same session’s shard unless the group file or session list changes.
- **What changes across cycles:** Only which sessions are **active** (not paused). When a session is paused it gets 0 groups; when it’s active again it gets the same slice as before.

---

## 5. How State Is Reset Between Cycles

- **Per cycle:** `posted_this_cycle` is a **local** set, cleared implicitly each cycle (new variable scope each loop iteration). So “already_posted_this_cycle” does **not** block the next cycle; it only prevents posting the same group **twice in the same cycle**.
- **Rollover:** `pending_groups` is **not** cleared at cycle boundary; it’s cleared only when we **use** it: `groups = _combined; pending_groups.clear()` at the start of the cycle. So rollover is the only state that carries over (groups we didn’t reach before `cycle_end_ts`).
- **FloodWait:** `session_pause_until` is persisted in config; when it’s in the future, that session gets 0 groups and sleeps at the top of the loop until `pause_until`.

---

## 6. Group Iteration Loop and Cycle Window

- **Order:** `for idx, g in enumerate(groups)` with `groups = pending_groups + list(assigned)`. So we iterate **rollover first**, then the **new shard**.
- **Window:** `cycle_end_ts = scheduled_run_ts + cycle_sec` (600 s). If `time.time() >= cycle_end_ts` we stop, put `groups[idx:]` into `pending_groups`, and break.
- **Gap:** ~6 s per post (with jitter). So in 600 s we can do at most ~100 posts. If a session has 124 groups, it will post ~100 and roll ~24 to the next cycle.

So:

- When there is a lot of rollover, **one session can have 124 groups in a cycle** (pending + assigned).
- That session posts in order: first the pending (from previous cycles), then its 25 from the new shard. So the **new shard** is at the **end** of the list. If we only finish ~100 posts, we may only touch a few of the 25 “new” groups; the rest roll over again. So the **same** shard groups can sit at the tail and get posted only every few cycles or when rollover shrinks.

---

## 7. Why Effective Per-Group Interval Is ~1 Hour (Not 10 Minutes)

Expected (if everything were ideal):

- 5 sessions, 124 groups, 600 s cycle.
- Each session posts ~25 groups in ~150 s, then waits until next boundary.
- Each group would be posted every 600 s.

What actually happens:

1. **FloodWait and 0-group cycles**  
   When a session hits long FloodWait, the controller sets `session_pause_until`. That session then gets **0 groups** for several cycles (until pause expires). So only the **other** sessions post. For a group in a **paused** session’s shard, the next post is the **next cycle when that session is active again**, which can be 20–45+ minutes later. So **effective interval = time until my session’s next active cycle**, which is often 30–60+ minutes when FloodWait is frequent.

2. **Rollover and tail groups**  
   When a session has 124 groups (pending + assigned), it posts in order. In 600 s it does ~100 posts. So the **last ~24** groups (the tail of the list, which includes much of the “new” shard) are not reached and roll over. Next cycle it gets 25 new + 24 pending = 49; it might finish those, or again roll. So **groups that consistently land at the tail** get posted only when that session eventually “catches up” (fewer paused sessions, or a cycle with few groups). That can add another 10–30 minutes between posts for those groups.

3. **Combined effect**  
   For a group like GLOBAL MARKETING (-1001355636382):

- It belongs to one session’s shard (fixed by index).
- That session might be paused (FloodWait) for 20–45 min → no post.
- When the session is active, it might have 100+ groups in the list (rollover + shard), so this group might be near the tail and not reached in that cycle → rollover again.
- So the **next** time that group is actually posted can be “next cycle after session wakes up” plus “cycle(s) until we reach it in the list”, which easily reaches **~1 hour** even with a 10-minute cycle.

So: **cycle_due_in=600** is correct (next boundary in 600 s), but **per-group frequency** is dominated by (a) how often that session is **not** paused, and (b) whether that group is in the **head** of the list (posted this cycle) or the **tail** (rollover). That’s why you see ~1 hour between posts for that group.

---

## 8. Summary Table

| Question | Answer |
|--------|--------|
| Why `assigned_this_session=124`? | The log reports **len(groups)** (assigned + pending), not shard size. With rollover, groups can be 124. |
| Is sharding overridden each cycle? | No. Shard is recomputed each cycle with the same formula; denominator is always full session count. |
| Is group–session mapping persistent? | Yes. Session index in `sessions_list` determines the slice; same group stays in same session’s shard. |
| Does already_posted_this_cycle block next cycle? | No. It’s per-cycle; next cycle gets a fresh assignment and can post the same groups again. |
| Is cycle timer based on trigger or loop end? | **Trigger.** Next run is anchor + (k+1)*cycle_sec; we do not wait for “loop completion”. |
| Can cycles overlap? | No. One cycle runs per boundary; if the loop overruns, we break and roll over; next run is the next boundary. |
| Is the group list filtered/mutated at runtime? | Only by: rollover (tail becomes pending), ban/cooldown skip, and config_patch (session_pause_until, active_session_files). The file list is not mutated; assignment is recomputed from it. |
| Where is cycle_due_in calculated? | In the posting loop: `cycle_due_in = max(0, (scheduled_run_ts + cycle_sec) - now)` (~1696). |
| Is next_run fixed or dynamic? | **Fixed** to the next boundary: `cycle_anchor + (cycle_index+1)*cycle_sec`. |

---

## 9. Recommendations (High Level)

1. **Logging:** Report **shard size** and **pending count** separately (e.g. `assigned_shard=25 pending_rollover=99 groups_this_cycle=124`) so “assigned_this_session” is not confused with shard size.
2. **Cap:** Consider capping `groups` per cycle to **shard size** (e.g. `min(len(_combined), len(assigned))` or a fixed cap like 25 in Enterprise) so one session cannot carry 124 groups and create long tails. That would force rollover to be dropped or handled differently (e.g. only allow rollover up to shard size).
3. **FloodWait:** Reducing posts per cycle (fewer groups per session or longer cycle) and/or increasing gap can reduce FloodWait and thus the number of cycles where a session gets 0 groups, bringing per-group frequency closer to 10 minutes.
4. **Order:** If you want each shard’s groups to be hit every cycle, avoid building a 124-group list (assigned + large pending). Capping at shard size would ensure each cycle we only iterate the real shard (~25), so each group is attempted every 10 minutes when the session is active.

If you want, the next step can be a concrete patch (e.g. verification report args + cap at shard size in Enterprise) and where to add the log lines.

---

## 10. Why Effective Interval Was 2× cycle_sec (Bug, Fixed)

**Observed:** With cycle = 600 sec, groups (e.g. SuperSFS) were posted at 08:41, 09:01, 09:21, 09:41 — **20 minutes** apart instead of 10.

**Cause:** At the **top of each loop** the scheduler computed the **next** boundary:

- `cycle_index = (now_ts - cycle_anchor) // cycle_sec`
- `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec`  ← **next** boundary
- `scheduled_time = next_cycle_time`
- After posting: `next_scheduled = scheduled_run_ts + cycle_sec`; sleep until `next_scheduled`.

When we **woke from sleep**, we were at `now_ts ≈ next_scheduled` = the boundary we had slept until. The code then recomputed:

- `cycle_index` = index of that boundary
- `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec` = the **following** boundary
- So we targeted the boundary **after** the one we had just woken at → slept another full `cycle_sec` → ran at the next boundary. So we ran at boundary k, then k+2 (skipped k+1) → **effective interval = 2 × cycle_sec**.

**Fix (in code):** Use the **current** boundary as the run time, not the next:

- `current_boundary = cycle_anchor + cycle_index * cycle_sec`
- `next_cycle_time = current_boundary` (run at this boundary; we are at or past it, or wait until it)
- When we wake at `next_scheduled`, we are exactly at that boundary, so `delta_sec ≤ 0` and we run immediately. No extra sleep.

**Failure stats (Sent: 320, Failed: 2211):** Permanent errors (TOPIC_CLOSED, CHAT_SEND_PLAIN_FORBIDDEN, You can't write in this chat, etc.) do **not** change cycle timing. The scheduler sleeps until `scheduled_run_ts + cycle_sec` regardless of how many posts succeeded or failed. Failures only affect counts; they do not introduce the 2× interval.
