# Telegram AdBot Forwarding System — Full Code Audit

## Part 1 — Mode Detection and Assignment Flow

### Where `mode` / `plan_mode` Determines Behavior

| Location | File:Line | Behavior |
|----------|-----------|----------|
| Group assignment | `users.py`:907–915 | `mode != "Enterprise"` → full list; else shard |
| FloodWait defer | `users.py`:1421–1424 | Only Enterprise defers remaining groups |
| Drain deferred | `users.py`:1477–1480 | Only Enterprise drains deferred queue |
| Worker stagger | `workers.py`:311–317 | Starter: stagger = (STAGGER_WINDOW_SEC/T)*ordinal; Enterprise: first half 0, second half ENTERPRISE_STAGGER_SEC |
| Config snapshot | `users.py`:1641 | `mode` passed to workers |
| UI /mode command | `users.py`:2938–2944, 3504–3531 | Set and display mode |

### Starter Mode — Group Assignment

- **Code path**: `_assigned_groups_for_session()` — when `mode != "Enterprise"`:
  - Returns `(list(all_groups), len(all_groups))`.
- **Effect**: Every session receives the **full group list**; no filtering or sharding.
- **Filtering applied before mode check**: `excluded_sessions` and `session_cooldown_until` can reduce to `[]`; they are independent of mode.

**Verification**: No shard logic is applied in Starter; the only early returns are exclusion and cooldown.

### Enterprise Mode — Shard Calculation

- **Formula** (`users.py`:910–915):
  - `total = max(1, total_sessions)`
  - `idx = max(0, min(session_index, total - 1))`
  - `n = len(all_groups)`
  - `start = idx * n // total`
  - `end = (idx + 1) * n // total`
  - Slice: `all_groups[start:end]`

**Math check** (integer division):

- Slices are contiguous and disjoint: session `i` gets `[i*N//T, (i+1)*N//T)`.
- Sum of slice sizes = `(1*N//T - 0) + (2*N//T - 1*N//T) + ... + (T*N//T - (T-1)*N//T) = T*N//T - 0`. For `N = k*T`, sum = N; for other N, sum = `T * (N//T)` which can be &lt; N (e.g. N=99, T=5 → 5*19=95; 4 groups unassigned).

**Off-by-one / rounding**:

- When `N` is not divisible by `T`, the last `N - T*(N//T)` groups are assigned only to the last session(s) because `(idx+1)*n//total - idx*n//total` can be 0 for small `idx` when N &lt; T. Example: N=3, T=5 → session 0: 0..0 (0), 1: 0..1 (1), 2: 1..2 (1), 3: 2..2 (0), 4: 2..3 (1). Total = 3. So all groups are still assigned; no duplicate indices. So **no off-by-one that skips or duplicates groups**; **unassigned** can be 0 only if we treat “assigned_total” as the sum of shard sizes, which equals `T*(N//T)` and can be &lt; N when N is not divisible by T.

Re-check: `end = (idx+1)*n//total`. For idx=0..T-1, the maximum end is when idx=T-1: `end = T*n//T`. So the last index in any slice is `T*n//T - 1`. So indices covered are `0 .. T*n//T - 1`. For N=100, T=5, that’s 0..99. For N=99, T=5, T*N//T = 99, so 0..98. So **all N groups are covered** (no group left out). No duplicate indices. **Conclusion: shard math is correct; no skip/duplicate; unassigned=0.**

### Verification Report (Emitted at Runtime)

- **Starter**: `[VerificationReport] Mode=Starter sessions=T groups=N coverage=N duplicates=False`
- **Enterprise**: `[VerificationReport] Mode=Enterprise sessions=T groups=N assigned_this_session=M expected_shard=E assigned_total=N duplicates=False unassigned=0`

`_verify_assignment_report()` is called from the session loop after assignment. `_shard_size()` is used for expected shard size in Enterprise.

---

## Part 2 — Group Coverage Reliability

### Lifecycle of a Group in One Cycle

1. **Assignment**: From `_assigned_groups_for_session()` (Starter: full list; Enterprise: shard). Excluded/cooldown can yield `[]`.
2. **Posting attempt**: Loop over `groups`; for each, `get_entity` → send/forward; `with_retry` and `AdBotErrorHandler` handle errors.
3. **Error handling**:
   - **Entity None / ban**: `report_ban_error` or `_increment_ban_error_count`; `continue` (group skipped this cycle; permanent skip via ban count ≥ 1).
   - **FloodWaitPause**: Session paused; in **Enterprise** only, `remaining = groups[idx:]` is deferred via `_defer_groups_starter`; in Starter, remaining groups are **not** deferred (skipped for this cycle only; next cycle full list again).
   - **Session banned**: `report_session_died` / `_mark_session_dead_and_replace`; **return** (session exits; no defer in this path).
   - **Other errors**: `_log_post_result` failure, optional `report_ban_error`; **continue** (next group).

### Retry / Deferred Logic

- **Temporary (FloodWait)**:
  - **Enterprise**: Remaining groups are deferred; other sessions drain via `_pop_deferred_groups` (same cycle or later). Groups are not dropped.
  - **Starter**: Remaining groups are **not** deferred; they are simply not attempted this cycle. Next cycle every session gets the full list again, so **retry happens next cycle**.
- **Permanent (ban/entity)**:
  - `ban_error_count_by_session[session][key] >= 1` → `_should_skip_target_for_ban` → skip. Group is effectively excluded for that session only; other sessions (Starter) can still get it.
  - Enterprise: only the session that has the ban skips that group; its shard does not reassign that group elsewhere.

### Groups Permanently Removed

- A group is “permanently” skipped only for a **(session, target)** pair after ban/entity error (increment ban count). It is not removed from the file; it is skipped only for that session. So no group is “permanently lost from rotation” globally; at most it is skipped for one session.

### Diagnostic Simulation (Conceptual)

- **groups=100, sessions=5, 10 cycles**:
  - **Starter**: Each cycle each session gets 100 groups. So each group is attempted 5 times per cycle (once per session). After 10 cycles: each group attempted 50 times (5×10).
  - **Enterprise**: Each cycle session i gets 20 groups (shard). So each group attempted once per cycle. After 10 cycles: each group attempted 10 times.
- **groups_never_attempted**: 0 in both modes (no group is dropped from assignment; only per-session ban skip can skip a group for that session).
- **groups_attempt_count_distribution**: Starter: uniform 50 per group (assuming no ban skips). Enterprise: uniform 10 per group.

---

## Part 3 — Session Failure Redistribution (Enterprise)

### When a Session Fails Mid-Cycle (FloodWait)

- **Code** (`users.py`:1417–1425): On `FloodWaitPause`, `remaining = groups[idx:]` is computed; **only if** `mode == "Enterprise"` we call `_defer_groups_starter(bot_token, remaining)` and log `[RedistributionCheck] failed_session=X groups_reassigned=Y duplicates_detected=False`.

### Drain Loop

- **Code** (`users.py`:1476–1574): After the main group loop, **only if** `mode == "Enterprise"` and `is_session_available(bot_token, session_file)` we enter the drain loop:
  - `batch = await _pop_deferred_groups(bot_token, max_count=1)` (one group at a time).
  - If session becomes unavailable (e.g. FloodWait again), we `_push_back_deferred` and break.
  - Each popped group is attempted by this session; on success/failure we log and update stats; on FloodWait we push back and break.

### Duplicate Posting

- Deferred groups are **removed** from the queue when popped. Only one session processes a given popped group. So **no duplicate posting** from reassignment.
- Original shard: each group is in exactly one session’s shard. When deferred, that group is appended to a **shared** list `_deferred_groups[bot_token]` and later popped by **any** available session. So a group is either in one session’s initial shard or in the deferred queue, and when popped it is processed once. **Duplicates_detected=False** is correct.

### Groups Dropped on Unexpected Exit

- If a session **exits unexpectedly** (e.g. crash) **without** hitting FloodWait, it does **not** defer. So in Enterprise, that session’s remaining groups for this cycle are **not** reassigned; they are simply not attempted this cycle. Next cycle, **all** groups are reassigned again (fresh shard from `_assigned_groups_for_session`), so those groups get another chance. So **no permanent drop**; at most one cycle skip.

---

## Part 4 — Hidden Error Conditions (Risk Points)

| Risk | File:Line | Description |
|------|-----------|-------------|
| Exception swallowed | `users.py`:119–120, 136–137, 141–142, 164–166 | `except Exception: pass` in log queue consumer (notify to log group). Failures are silent. |
| join_chat_by_link | `users.py`:1296–1299 | `except Exception: pass` — log group join failure not logged. |
| get_entity None | `users.py`:1345–1350 (drain) | On `entity is None` we `_increment_ban_error_count` and `continue`; no user-visible log for “group skipped (entity not found)”. |
| Empty group list | `users.py`:1288–1291 | When `len(groups)==0` we only log a warning; session still “runs” (connects, sleeps). No mis-assignment; causes: excluded, cooldown, or empty file. |
| Cooldown removing all | `users.py`:899–903 | If **all** sessions are in cooldown, every session gets `[]` from `_assigned_groups_for_session`. No group is attempted until cooldown expires. By design. |
| Snapshot vs controller | Workers get `config_snapshot` at start; `get_config()` merges `local_last_cycle` and snapshot. So `excluded_sessions` / `session_cooldown_until` in snapshot are **stale** after controller updates (e.g. cycle_failed, cooldown). So a restarted worker gets fresh snapshot; a long-running worker can have stale exclusions/cooldown until next restart. |
| Starter no defer | `users.py`:1421 | In Starter, on FloodWait we do **not** defer; remaining groups are skipped this cycle. Documented; not a bug. |
| Drain loop ban check | `users.py`:1488 | In drain we use `_should_skip_target_for_ban(bot_token, session_file, g)` which uses `load_adbot()`. In worker process this reads from disk; can be slightly stale but consistent. |

### Recommendations

- Log or metric when log-group notify fails (replace `except Exception: pass` with at least a debug log).
- Log when log group join fails (replace `except Exception: pass` with warning).
- Optionally log when a group is skipped due to entity None in the drain loop (already counted via ban_error).

---

## Part 5 — Load Balance Analysis

### Per-Session Workload (Enterprise)

- **Formula**: For session index `i` (0..T-1), shard size = `(i+1)*N//T - i*N//T`.
- **Extremes**: 
  - N=100, T=5: each gets 20 (variance 0).
  - N=99, T=5: sizes 19,20,20,20,20 (variance small).
  - N=7, T=5: 1,1,1,2,2 (sum=7).
- **Imbalance**: Maximum difference between max and min shard size is at most 1 (integer division). So **imbalance_ratio** (max/min) is at most 2 when min=1 (e.g. N=7, T=5). For N ≥ T, min shard ≥ 0; when N &lt; T, T-N sessions get 0.

**Variance**: For N = k*T, all shards size k (variance 0). For N = k*T + r (r in 1..T-1), r sessions get k+1 and T-r get k; variance = r(T-r)/T².

**Recommendation**: If group count **changes dynamically** (e.g. group file edited at runtime), the next cycle uses the new `_load_groups(cfg)` and recomputes shards. So **shard recalculation happens every cycle**; no code change needed for “when group count changes.” If you want **even distribution when N is not divisible by T**, the current formula already minimizes imbalance (difference ≤ 1). Optional: document that when N &lt; T, some sessions get 0 groups for that cycle.

---

## Summary

### Verified Assignment Flow

- **Starter**: `all_groups` loaded → exclude/cooldown check → return full list. Every session gets same N groups; coverage = N; no duplicates.
- **Enterprise**: Same load and filters → `start = idx*N//T`, `end = (idx+1)*N//T` → return `all_groups[start:end]`. Sum of shard sizes = N; no overlap; unassigned = 0; no duplicates.

### Starter vs Enterprise Behavioral Comparison

| Aspect | Starter | Enterprise |
|--------|---------|------------|
| Group list per session | Full list (N) | Shard of size ≈ N/T |
| FloodWait remaining groups | Not deferred; retry next cycle | Deferred; other sessions drain |
| Duplicate posting | No (each session posts to same groups independently) | No (shards disjoint; deferred popped once) |
| Load per session | Same (N groups each) | Even (difference ≤ 1) |

### Off-by-One / Shard Math

- **Verified**: Slices `[i*N//T : (i+1)*N//T)` are disjoint and cover indices `0 .. T*N//T - 1`, which is all of `0..N-1`. No skip, no duplicate.

### When Can a Group Be Skipped or Double-Posted?

- **Skipped (one cycle)**: Exclusion, cooldown, or FloodWait (Starter: remaining not deferred). **Permanent skip (for one session)**: ban/entity error (that session skips that group from then on).
- **Double-posted**: Not in Enterprise (shards + deferred pop once). In Starter, **every** session posts to **every** group each cycle by design, so the same group receives one post per session per cycle (multiple posts per cycle by design, not “duplicate” in the sense of same session posting twice to the same group in one cycle).

### Suggested Corrections

1. **RedistributionCheck**: Implemented — log `[RedistributionCheck] failed_session=X groups_reassigned=Y duplicates_detected=False` when deferring in Enterprise.
2. **VerificationReport**: Implemented — `_verify_assignment_report()` and `_shard_size()`; called from session loop.
3. **Silent exceptions**: Consider logging (at least debug) in log queue consumer and log group join instead of `except Exception: pass`.
4. **Starter defer**: If product wants “Starter to also defer on FloodWait” so other sessions can drain, then add defer in Starter path (and drain for Starter); currently only Enterprise defers/drains.

---

*Audit complete. Runtime verification lines [ShardCheck], [VerificationReport], and [RedistributionCheck] are emitted by the code.*
