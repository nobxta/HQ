# STARTER Mode Posting Logic — Architectural Audit

## 1. Where shard calculation happens (Starter)

**There is no shard calculation in Starter mode.**

Assignment for Starter is done in the same function as Enterprise: `_assigned_groups_for_session` in `code/users.py`. The mode branch is:

- **Lines 1012–1016** (`code/users.py`):

```python
    mode = (cfg.get("mode") or "Starter").strip()
    if mode != "Enterprise":
        cycle_sec = max(300, int(cfg.get("cycle", 3600)))
        rotated = _rotate_group_list_by_cycle_index(list(all_groups), cycle_sec)
        return rotated, len(all_groups)
```

So for any mode that is not `"Enterprise"` (including `"Starter"`):

- There is **no** partition, **no** denominator, **no** slice index.
- The function returns the **entire** group list (rotated) and `len(all_groups)`.
- `session_index` and `total_sessions` are **not used** in this branch.

**Exact code path for Starter assignment:**

1. `_async_session_loop` (e.g. ~1575) calls `assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`.
2. Inside `_assigned_groups_for_session`: after exclusions/pause/cooldown and `if not all_groups`, `mode = (cfg.get("mode") or "Starter").strip()` then `if mode != "Enterprise":` → `rotated = _rotate_group_list_by_cycle_index(list(all_groups), cycle_sec)` → `return rotated, len(all_groups)`.
3. So every non-excluded, non-paused, non-cooldown session receives **the same full list** (with time-based rotation).

---

## 2. Shard denominator (Starter)

- **Starter does not use a shard denominator.** There is no “T” (number of sessions) in the assignment math; the full list is returned.
- So the question “total configured sessions vs active sessions” does not apply: neither is used for assignment in Starter.

---

## 3. Slicing logic (Starter)

- **No index-based slicing.** The returned value is `rotated` = full list, not a slice `all_groups[start:end]`.
- **No hash-based assignment.** No `hash(group_id) % T` or similar.
- **Only operation:** time-based rotation of the full list in `_rotate_group_list_by_cycle_index` (users.py 932–939):

```python
def _rotate_group_list_by_cycle_index(groups: list[dict], cycle_sec: int | float) -> list[dict]:
    if not groups:
        return []
    sec = max(1, int(cycle_sec))
    idx = int(time.time() // sec) % len(groups)
    return list(groups[idx:]) + list(groups[:idx])
```

- So the same full list is rotated by a **global** index derived from `time.time()` and `cycle_sec`. All sessions get the **same** rotated list (same moment → same `idx`). No per-session differentiation.

---

## 4. Session pauses (FloodWait) and denominator

- In Starter there is **no** denominator to shrink or grow.
- **Paused sessions:** Before the mode branch, `_assigned_groups_for_session` returns early for paused sessions (lines 994–1003): if `pause_until > time.time()` it returns `[], len(all_groups)`. So a paused session gets **0 groups**.
- **Non-paused sessions:** Unchanged: they still get the **full** rotated list. So when some sessions are paused, each remaining session still receives **all** groups (assigned = total_groups).
- So: **Session pauses do not change any “shard denominator” in Starter** (there is none). They only zero out assignment for the paused session; everyone else still gets the full list.

---

## 5. Full execution flow (Starter)

### 5.1 Scheduler trigger

- Same as Enterprise: in `_async_session_loop`, cycle boundary from `cycle_anchor_ts` and `cycle_sec`; wait until `next_cycle_time`; then one cycle runs. No separate scheduler process.

### 5.2 Config snapshot

- **Location:** `_build_worker_config_snapshot(cfg, total_sessions, ...)` (users.py 2123–2155).
- Snapshot includes `"mode": (cfg.get("mode") or "Starter").strip()` and `"active_session_files": active_list`. For Starter, assignment code **does not read** `active_session_files` (it never reaches the Enterprise branch). So snapshot is built the same for both modes, but Starter assignment ignores `active_session_files`.

### 5.3 Assignment

- Each cycle start (e.g. users.py 1544–1576): `cfg = get_config()` (snapshot + patch), then `assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`.
- For Starter: function returns `(rotated_full_list, len(all_groups))`. So `assigned` = full list, `total_groups` = N.
- Then `groups = pending_groups + list(assigned)` (and BUG-4 cap). So for Starter, `groups` is the full list (plus any pending rollover), and **assigned = total_groups** for the purpose of logging (len(groups) after cap).

### 5.4 Posting loop

- Same loop as Enterprise: iterate over `groups`, post, respect cycle window, gap, FloodWait.
- **FloodWaitPause (users.py 1832–1856):** On account-level FloodWait, session pauses, `remaining = groups[idx:]`. Then:
  - **Enterprise:** `_defer_groups_starter(bot_token, remaining)` and log redistribution.
  - **Starter:** the `if mode == "Enterprise":` block is **not** taken, so **remaining groups are not deferred**. They are effectively dropped for that cycle; no other session gets them in Starter.

### 5.5 FloodWait handling

- Pause is stored (in-memory and via `report_session_paused` → controller persists `session_pause_until` and sends `config_patch`).
- Next cycle: paused session gets 0 groups (early return in `_assigned_groups_for_session`). Other sessions still get the full list from the same function (Starter branch).
- **No redistribution in Starter:** deferred-group drain (users.py 1910–2021) runs only when `mode == "Enterprise"`. So in Starter there is no “drain deferred” and no reassignment of one session’s remaining groups to others.

### 5.6 Next cycle

- After `report_cycle_done`, loop continues; wait until next boundary; then next iteration: `get_config()` again, `_assigned_groups_for_session` again. So assignment is recomputed every cycle; no persistent shard state.

---

## 6. Can any session receive more than ceil(total_groups / total_configured_sessions)?

- **Yes. In Starter, every non-paused session receives exactly total_groups (the full list).**
- So for T sessions and N groups, each session gets N groups, not ceil(N/T). So every session receives **more** than ceil(N/T) whenever T > 1.
- **Exact line:** users.py 1016: `return rotated, len(all_groups)` returns the full list. So `assigned` in the caller has length `len(all_groups)` = total_groups.

---

## 7. Under what condition could assigned equal total_groups?

- **In Starter: for every non-excluded, non-paused, non-cooldown session, assigned equals total_groups every cycle.** So whenever the session is allowed to get groups, assigned == total_groups. This is by design.

---

## 8. Does STARTER mode use active_session_files?

- **No.** The Starter branch (lines 1014–1016) does not read `cfg.get("active_session_files")`. That is only read in the Enterprise block (1020+). So Starter assignment is unaffected by `active_session_files` or by controller patches that update it.

---

## 9. Does it shrink denominator dynamically?

- There is no denominator in Starter, so nothing “shrinks” or “grows.” Every active session always gets the full list.

---

## 10. Paused sessions and redistribution

- **Starter does not redistribute.** When a session hits FloodWaitPause, its remaining groups are **not** deferred (the defer is inside `if mode == "Enterprise":`). So other sessions do **not** get that session’s remaining groups. The remaining groups are simply not posted that cycle.
- On the next cycle, the paused session gets 0 groups; all other sessions again get the full list. So the only “effect” of a pause is that one session stops posting; the others still each have the full list and can each post to all groups, so you can get duplicate posts (multiple sessions posting to the same groups) and higher FloodWait risk.

---

## 11. Restart required for shard logic changes?

- **Mode and session list:** Workers get config from snapshot (built at start) plus `config_patch`. Snapshot includes `mode` and `sessions` (indirectly: snapshot is built from `cfg` which has the full bot config). So if you change **mode** (e.g. Enterprise → Starter) in the controller, workers keep their initial snapshot until they restart; patches today send `session_pause_until` and `active_session_files`, not `mode`. So **changing mode effectively requires restart** for workers to see the new mode.
- **Starter has no shard logic**, so there is no “shard denominator” to change. For Starter, “shard logic change” is N/A. Restart is relevant only if you change mode or session set so that the snapshot should change.

---

## 12. Concurrency and stale-config window

- Workers call `get_config()` at the start of each cycle. So they see the latest merged snapshot + patch. There is no extra “shard state” in Starter; assignment is just “return full list (rotated).”
- So there is no stale “session list” affecting a partition in Starter, because there is no partition. The only way assignment changes is: (1) excluded/paused/cooldown (early returns), (2) `all_groups` from `_load_groups(cfg)` (group file and cfg like `group_file`, `groups_dir`). If the worker never receives a patch that changes `group_file`, it keeps using the snapshot’s group file until restart. So for **group file** changes, a stale window exists until patch or restart; for “shard” in Starter there is no shard to go stale.

---

## 13. Exact code path summary (Starter)

| Step | Location | What happens (Starter) |
|------|----------|------------------------|
| Scheduler | users.py ~1404–1452 | Same as Enterprise; next_cycle_time from anchor + cycle_sec |
| Config | users.py ~1544 | `cfg = get_config()` (snapshot + patch) |
| Assignment | users.py 1012–1016 | `mode != "Enterprise"` → `rotated = _rotate_group_list_by_cycle_index(list(all_groups), cycle_sec)` → `return rotated, len(all_groups)` |
| ShardCheck / VerificationReport | users.py 1596–1601 | Logs `assigned=len(groups)` (= total_groups in Starter); VerificationReport for Starter: "Mode=Starter ... coverage=total_groups" (no expected_shard) |
| Posting loop | users.py 1642+ | Same loop; each session iterates over full list |
| FloodWaitPause | users.py 1848–1856 | `remaining = groups[idx:]`; **no** `_defer_groups_starter` (Enterprise only); break |
| Drain deferred | users.py 1910 | `if mode == "Enterprise"` → **not run in Starter** |
| Next cycle | Same loop | Again `get_config()` → `_assigned_groups_for_session` → full list |

---

## 14. Line responsible if “unsafe”

- The behavior “every session gets all groups” comes from **users.py 1014–1016**:

```python
    if mode != "Enterprise":
        cycle_sec = max(300, int(cfg.get("cycle", 3600)))
        rotated = _rotate_group_list_by_cycle_index(list(all_groups), cycle_sec)
        return rotated, len(all_groups)
```

- So the **exact line** that gives every Starter session the full list is **1016**: `return rotated, len(all_groups)` with `rotated` = full list. That is by design for Starter (“all sessions post to all groups”), but it implies:
  - **assigned = total_groups** for every active session.
  - When several sessions pause, the remaining session(s) still get the full list → one or more sessions each posting to all groups → FloodWait risk.

So the “unsafe” aspect (one session can get total_groups and then hit FloodWait) is the **intended** Starter semantics, not a bug. The **design** is vulnerable when T > 1 and many sessions pause.

---

## 15. Is STARTER mode safe or vulnerable?

- **Vulnerable by design** in the following sense:
  - Every non-paused session receives **all** groups every cycle.
  - So **assigned = total_groups** is normal and expected.
  - If multiple sessions exist and several pause (FloodWait), the remaining session(s) still each get the full list (e.g. 124 groups). So a single session can post to every group and trigger FloodWait again.
- Starter does **not** have the Enterprise bug (denominator shrinking to 1 when only one session is active); in Starter there is no denominator. But the **outcome** can look similar: one session ends up with the full list and hits FloodWait. In Starter that is because **every** session is supposed to get the full list; when only one is active, that one still gets the full list.

---

## 16. Concrete fix (optional)

If you want Starter to **never** assign more than `ceil(total_groups / total_configured_sessions)` per session (to avoid FloodWait cascade when many sessions pause), you can apply a **cap** in the Starter branch:

- After computing `rotated`, derive a per-session cap from the full session list (same idea as Enterprise: use `cfg.get("sessions")` or `total_sessions`).
- Cap: `cap = ceil(len(all_groups) / max(1, total_configured_sessions))`.
- Return `rotated[:cap], len(all_groups)` (or a deterministic slice so that different sessions get different segments; that would make Starter partition like Enterprise. If you only want to cap and not partition, you could return `rotated[:cap]` so every session gets the same first `cap` groups — that would duplicate work across sessions. So the consistent approach is: in Starter, **partition** by session index when you want to cap, e.g. use the same `sessions_list` / `total_denom` / `idx_global` logic as Enterprise and return `all_groups[start:end]` with a rotated list if you still want rotation, or simply apply the same slice as Enterprise so Starter also gets at most ceil(N/T) per session).

**Minimal change (Starter cap, same partition as Enterprise):** In `_assigned_groups_for_session`, when `mode != "Enterprise"`, instead of returning the full rotated list, compute the same `sessions_list`, `total_denom`, `idx_global` as in the Enterprise block (from `cfg.get("sessions")` and `session_file`), and return `rotated[idx_global * n // total_denom : (idx_global + 1) * n // total_denom]` and `len(all_groups)`. Then Starter would still use rotation but each session would get at most ceil(N/T) groups. That would make Starter safe from “one session gets all” while keeping rotation for fairness.

**Exact change (sketch):** Before `return rotated, len(all_groups)` (line 1016), add the same `sessions_list` / `total_denom` / `idx_global` logic (or a shared helper), then `start = idx_global * len(rotated) // total_denom`, `end = (idx_global + 1) * len(rotated) // total_denom`, and `return list(rotated[start:end]), len(all_groups)`. That way Starter uses the same partition and cap as Enterprise, with rotation applied before slicing.
