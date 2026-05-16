# TAdbot System Architecture Analysis Report

Comprehensive analysis of the multi-tenant Telegram AdBot posting system per the 9-phase prompt. All code locations use the TAdbot workspace path.

---

## PHASE 1: POST LINK LOADING MECHANISM

### 1. Where is the post link/message stored?

- **Storage location:** Per-user JSON under `data/user/<name>.json` (via `save_user_data` / `load_user_data`). The merged view is built from `data/pool.json` + `data/index.json` + `data/user/*.json` by `load_adbot()` in `code/utils.py` (lines 653–672). Bot config is keyed by `bot_token` in memory; on disk it is keyed by user `name` from `index.json`.
- **Data structure:** String URL(s). Legacy: single `post_link` (string). Current: list `post_links` (list of strings). Example: `"https://t.me/HqAdzz/6"` or `"t.me/c/1234567890/6"`.
- **Code:** `_get_post_links_list(cfg)` in `code/users.py` (762–768) returns `cfg.get("post_links")` or falls back to `[cfg.get("post_link")]` if a single `post_link` is set.

### 2. How does the user set the post link?

- **Command / flow:** There is no `/setpost` or `/addlink` command. The user sets the post link via the **Set message** flow:
  1. User opens the bot → **Set message** (inline callback `CB_SET_MSG` or similar).
  2. User chooses **Add link** (e.g. `CB_SET_MSG_LINK`).
  3. Bot asks for a link; user sends plain text (e.g. `https://t.me/HqAdzz/6` or `t.me/c/123/456`).
  4. Handler in `code/users.py` (around 4194–4222): on NewMessage in "link" mode, `_parse_post_link(text)` validates; if valid, `add_post_link(c)` appends to `post_links` and sets `post_link` to first; then `_save_bot_config(bot_token, add_post_link)` persists.

**Code path:**

```
User sends link text
  → events.NewMessage handler (users.py ~4194)
  → _parse_post_link(text) validates
  → _save_bot_config(bot_token, add_post_link)
  → save_user_data(name, cfg) via utils (per-user JSON)
```

### 3. How is the post link converted for forwarding?

- **Parsing:** `_parse_post_link(link)` in `code/users.py` (740–758).
- **Patterns:**
  - `https?://t\.me/c/(\d+)/(\d+)` → `from_peer = int("-100" + chat_part)`, `message_id = int(m.group(2))`.
  - `https?://t\.me/([a-zA-Z0-9_]+)/(\d+)` → `from_peer = username` (string), `message_id = int(m.group(2))`.
  - Same without `https://` for `t.me/...`.
- **Return:** `(from_peer, message_id)` or `None` if invalid. Used in the posting loop as `from_peer` and `orig_msg_id` for `client.forward_messages(entity, orig_msg_id, from_peer)` or `_forward_messages_to_topic(...)`.

### 4. When is the post link validated?

- **When user sets it:** Yes — in the NewMessage handler, `_parse_post_link(text)` is called; if `None`, the bot replies "Invalid link. Send t.me/c/123/456 or t.me/channel/123." and does not save.
- **Before each posting cycle:** No explicit “validate post link” step. At post time the code does `parsed = _parse_post_link(post_link)`; if `parsed` is `None` it falls back to `send_message` with `message_text` (users.py ~1680–1712).
- **If source message is deleted:** No pre-check. Forward will fail at API call time and be handled by the existing error/retry path (e.g. skip or retry).

**Summary:**

```
POST LINK LOADING MECHANISM:
1. Storage location: data/user/<name>.json (per-user); merged via load_adbot() from pool + index + user files.
2. Storage format: "post_link" (string, legacy), "post_links" (list of strings); e.g. "https://t.me/HqAdzz/6".
3. User input method: Set message → Add link → user sends URL text; handler in users.py ~4194–4222; _save_bot_config → save_user_data.
4. Conversion logic: _parse_post_link (users.py 740–758): t.me/c/CHATID/MSGID → (-100+chat_id, msg_id); t.me/username/MSGID → (username, msg_id).
5. Validation timing: On set (must parse); at post time only used to choose forward vs send_message (no pre-validation of existence).
6. Code files involved: code/users.py (_parse_post_link, _get_post_links_list, Set message/link handlers, posting loop), code/utils.py (load_adbot, save_adbot, load_user_data, save_user_data).
```

---

## PHASE 2: GROUP FILE LOADING MECHANISM

### 1. Where is the group file stored?

- **Path:** `config.GROUPS_DIR / group_file`. `GROUPS_DIR = BASE_DIR / "groups"` (code/config.py 66). So typically `groups/Starter.txt` or `groups/<group_file>.txt`. In workers, `cfg["groups_dir"]` can override the base (snapshot passes `str(config.GROUPS_DIR)`).

### 2. Format in the file

- **Per line:** One target per line. Either:
  - Normal group: numeric ID, e.g. `-1001356688328`.
  - Forum topic: `chat_id | topic_id`, e.g. `-1001356688328 | 34`.
- **Comments/headers:** Empty lines are skipped; no special comment syntax. Invalid lines (non-numeric chat_id, bad topic_id) are skipped with a warning (users.py 902–918).
- **Example (first 5 lines of groups/Starter.txt):**

```
-1001356688328
-1001272586182
-1001220106147
-1001465636127
-1001479210114
```

### 3. How groups are loaded into memory

- **Entry:** `_load_groups(cfg)` (users.py 925–926) which just calls `_parse_groups_file(cfg)`.
- **Reading:** `_parse_groups_file` (users.py 884–920): `path = (cfg["groups_dir"] if set else config.GROUPS_DIR) / cfg.get("group_file", "Starter.txt")`, then `path.read_text(encoding="utf-8", errors="replace").splitlines()`. Each line is normalized and validated; result is a list of `{"chat_id": int, "topic_id": int | None}`.
- **Duplicates:** No explicit deduplication; if the file has duplicate lines, duplicates remain in the list.
- **Invalid entries:** Skipped with `logger.warning`; only valid lines are appended.

### 4. When are groups loaded?

- **When:** On every cycle. `_assigned_groups_for_session` (users.py 984) calls `_load_groups(cfg)` at the start of each cycle. There is no “load once at startup” cache; the file is re-read each time.
- **Caching:** No. Each call to `_assigned_groups_for_session` → `_load_groups` → `_parse_groups_file` reads the file again.

### 5. How does the user specify which group file to use?

- **Config key:** `group_file` (e.g. `"Starter.txt"`). Set via admin/create flow (`admin_ptb.py` create step `group_file`, `admin.py` form `group_file`) or user bot `/group` (users.py: e.g. inline buttons or `/group Starter.txt`). Stored in bot config and passed in worker snapshot as `group_file`.

**Summary:**

```
GROUP FILE LOADING MECHANISM:
1. File location: groups/<group_file>, e.g. groups/Starter.txt; base from config.GROUPS_DIR or cfg["groups_dir"] in worker.
2. File format: One line per target: "-100123..." or "-100123... | topic_id"; empty lines skipped; invalid lines logged and skipped.
3. Loading code: _parse_groups_file (users.py 884–920), _load_groups (925–926); path.read_text().splitlines() then parse each line.
4. Data structure after load: list[dict] with {"chat_id": int, "topic_id": int | None}; no dedup.
5. Loading timing: Every cycle, inside _assigned_groups_for_session (no cache).
6. Caching: No.
7. User configuration: group_file in bot config; set via admin creation flow or /group in user bot.
```

---

## PHASE 3: GROUP ASSIGNMENT ARCHITECTURE

### 1. Group assignment function

- **Name/location:** `_assigned_groups_for_session(bot_token, cfg, session_file, session_index, total_sessions=None)` in `code/users.py` (975–1022). There is no separate `assign_groups` / `shard` / `distribute` / `split_groups`; this function is the only assignment logic.

**Relevant code (excerpt):**

```python
def _assigned_groups_for_session(...) -> tuple[list[dict], int]:
    all_groups = _load_groups(cfg)
    excluded = set(cfg.get("excluded_sessions") or [])
    if session_file in excluded:
        return [], len(all_groups)
    pause_until = (cfg.get("session_pause_until") or {}).get(session_file) or 0
    if pause_until > time.time():
        return [], len(all_groups)
    cooldown_until = (cfg.get("session_cooldown_until") or {}).get(session_file) or 0
    if cooldown_until and now_ts < cooldown_until:
        return [], len(all_groups)
    if not all_groups:
        return [], 0
    mode = (cfg.get("mode") or "Starter").strip()
    if mode != "Enterprise":
        cycle_sec = max(300, int(cfg.get("cycle", 3600)))
        rotated = _rotate_group_list_by_cycle_index(list(all_groups), cycle_sec)
        return rotated, len(all_groups)
    # Enterprise: partition among active_session_files or total_sessions
    active_list = cfg.get("active_session_files")
    if active_list:
        if session_file not in active_list:
            return [], len(all_groups)
        total = max(1, len(active_list))
        idx = active_list.index(session_file)
        idx = max(0, min(idx, total - 1))
    else:
        total = max(1, total_sessions or 1)
        idx = max(0, min(session_index, total - 1))
    n = len(all_groups)
    start = idx * n // total
    end = (idx + 1) * n // total
    return list(all_groups[start:end]), len(all_groups)
```

### 2. Assignment algorithm

- **Starter:** Every session gets the full list, rotated by cycle index: `_rotate_group_list_by_cycle_index(all_groups, cycle_sec)` so the “head” changes each cycle (fairness when FloodWait skips tail).
- **Enterprise:** Even sharding among “active” sessions. If `active_session_files` is present: `total = len(active_list)`, `idx = active_list.index(session_file)`, slice `all_groups[idx*n//total : (idx+1)*n//total]`. If not present: `total = total_sessions`, `idx = session_index`, same slice formula. So when some sessions are paused, `active_session_files` shrinks and remaining sessions get larger shards.

### 3. When assignment runs

- **Every cycle start** in the session loop: `users.py` 1545 — `assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`.
- **At Run (posting start)** in the controller: `users.py` 2676 — called once per session for diagnostic logging only (does not change worker config; workers recompute on their first and every subsequent cycle).

### 4. Where assignments are stored

- **Not persisted.** No `assigned_groups` in config or JSON. Each worker gets a config snapshot including `active_session_files` and `session_pause_until`; assignment is recomputed in-process each cycle from `get_config()` (which merges `config_snapshot` and `local_config_patch` in workers.py 91–97).

### 5. What triggers reassignment (change in who gets how many groups)

- **Bot start / Run:** Snapshot is built with `_active_session_files(cfg)` at that time; workers then run cycles and call `_assigned_groups_for_session` with that snapshot (and later with config_patch).
- **Session added/removed:** Only at next Run (new snapshot and worker spawn). No mid-run “add session” that pushes a new snapshot.
- **Session FloodWait:** Controller does **not** call `_assigned_groups_for_session`. It receives `session_paused`, persists `session_pause_until`, and when **any** worker sends `cycle_done`, controller sends `config_patch` with updated `session_pause_until` and `active_session_files` (users.py 2069–2079). Workers merge the patch (workers.py 281–284). On the **next cycle**, each worker’s `get_config()` returns the updated cfg, so `_assigned_groups_for_session` runs with a new `active_list` (paused sessions excluded). So **reassignment happens implicitly on the next cycle** when `active_session_files` has changed.
- **Manual command:** No command that explicitly “reassign”; Run/Stop changes workers and snapshot.

### 6. Assignment consistency / “bug” check

- **Stateless:** Yes. Same `(cfg, session_file, session_index, total_sessions)` and same `all_groups` content → same slice.
- **When `active_sessions` (or effective active list) changes:** Assignment **does** change. In Enterprise, if one or more sessions become paused, `active_session_files` sent in config_patch has fewer entries, so remaining sessions get a larger shard. So “same session 31 → 83” is expected when other sessions are paused: e.g. 124 groups, 4 sessions → 31 each; then 3 paused → 1 active gets 124, or 2 active get 62 each; 83 would match e.g. a different total_groups or 2 active with uneven split in another scenario. This is by design (redistribute work to non-paused sessions), not a logic bug.

**Summary:**

```
GROUP ASSIGNMENT ARCHITECTURE:
1. Function name and location: _assigned_groups_for_session in code/users.py 975–1022.
2. Assignment algorithm: Starter = full list rotated by cycle index; Enterprise = slice [idx*n//total : (idx+1)*n//total] with total/idx from active_session_files (if present) or total_sessions/session_index.
3. When called: Every cycle start in session loop (users.py 1545); at Run for logging (users.py 2676).
4. Storage: Not persisted; recomputed each cycle from cfg in worker (snapshot + config_patch).
5. Is it stateless? Yes (same inputs → same slice).
6. Does it recalculate when sessions change? Yes — when config_patch updates active_session_files (e.g. after FloodWait), next cycle uses new active list and remaining sessions get more groups. This is intentional.
```

---

## PHASE 4: FORWARDING/POSTING MECHANISM

### 1. Telegram API call

- **Normal channel/group:** `client.forward_messages(entity, orig_msg_id, from_peer)` (users.py 1710–1712) inside `with_retry(...)`.
- **Forum topic:** High-level `forward_messages` does not accept `top_msg_id`, so raw `ForwardMessagesRequest` is used via `_forward_messages_to_topic` (users.py 707–736):

```python
req = ForwardMessagesRequest(
    from_peer=from_input,
    id=ids,
    to_peer=to_input,
    random_id=random_ids,
    top_msg_id=topic_id,
)
updates = await client(req)
```

### 2. Posting loop structure

- **Location:** Same cycle block in `_async_session_loop` (users.py): after assignment (1545), groups are in `groups`; then a single `for idx, g in enumerate(groups):` (1599) with gap sleep, entity resolve, then forward/send and error handling. Enterprise then has a drain loop for deferred groups (1815–1876).
- **Gap/delay:** `scheduled_for = cycle_start + idx * effective_gap_cycle`; `session_gap_wait = max(0, scheduled_for - now)` (with drift cap); `final_wait = max(global_wait, min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), retry_wait)`; then `await asyncio.sleep(final_wait)` (1616–1617). So one sleep per post, aligned to a per-session schedule.
- **Error handling:** `with_retry` around forward/send; on `FloodWaitPause` the loop breaks after defer (Enterprise) and session is marked paused; other errors go through `AdBotErrorHandler` (skip, retry, mark banned, etc.).

### 3. Sequential vs concurrent

- **Within one session:** Sequential — single `for` loop over `groups` with sleep then post.
- **Across sessions:** Concurrent — multiple workers (processes), each running one or more session loops (asyncio tasks). So multiple sessions can post at the same time; gap is per session only.

### 4. Gap implementation (exact pattern)

- **Pattern:** One sleep per post; next post scheduled at `cycle_start + idx * effective_gap_cycle`; wait until that time (or cycle end / FloodWait / stop). Code (users.py 1627–1617):

```python
scheduled_for = cycle_start + idx * effective_gap_cycle
session_gap_wait = max(0.0, scheduled_for - now) if now <= scheduled_for + MAX_DRIFT_SEC else 0.0
...
final_wait = max(global_wait, min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), retry_wait)
if final_wait > 0:
    await asyncio.sleep(final_wait)
```

### 5. Worker/process architecture

- **Processes:** Controller spawns one multiprocessing.Process per “worker” (users.py 2712–2718). Each process runs `worker_entry` (workers.py) with a chunk of sessions.
- **Threads:** No separate posting threads; inside each process it’s asyncio only.
- **Async:** Each worker runs `asyncio.create_task(_async_session_loop(...))` per session in its chunk (workers.py 338–365) and `asyncio.gather(listener, *tasks)`.

### 6. Session management during posting

- **One process** can run multiple sessions (by chunk); each session has its own `_async_session_loop` task. Sessions are distributed by `chunk_sessions(valid_sessions, per_worker=SESSIONS_PER_WORKER)` in the controller; session_file and global_ordinal identify the session for assignment.

**Summary:**

```
POSTING MECHANISM:
1. Telegram API call: client.forward_messages(entity, orig_msg_id, from_peer) or _forward_messages_to_topic (ForwardMessagesRequest with top_msg_id).
2. Loop structure: Sequential per session (for group in groups: sleep then post); concurrent across sessions (multiple workers × multiple session tasks).
3. Gap implementation: One asyncio.sleep(final_wait) per post; final_wait from scheduled_for = cycle_start + idx * effective_gap_cycle; session_gap_wait = scheduled_for - now; final_wait = max(..., session_gap_wait, ...).
4. Worker architecture: Multiprocessing (one Process per worker); each worker runs asyncio with one task per session in its chunk.
5. Session-to-worker mapping: chunk_sessions(valid_sessions, SESSIONS_PER_WORKER); session_chunk and worker_id passed to worker_entry; global_ordinal = worker_id * SESSIONS_PER_WORKER + local_ord.
6. Full posting loop: _async_session_loop in users.py (assignment at 1545, for loop 1599–1813, drain 1815–1876, cycle_done 1932–1935).
```

---

## PHASE 5: CYCLE SCHEDULING & TIMING

### 1. Cycle anchor

- **Formula:** `cycle_anchor = float(cfg.get("cycle_anchor_ts") or now_ts)`; `cycle_index = int((now_ts - cycle_anchor) // cycle_sec)`; `next_cycle_time = cycle_anchor + (cycle_index + 1) * cycle_sec` (users.py 1383–1385). So fixed interval from anchor: `anchor + (k * cycle_sec)` for the k-th cycle.
- **First cycle:** If `run_first_cycle_immediately` and not yet done, `next_cycle_time = now_ts`, `delta_sec = 0` (1389–1394).

### 2. Cycle start logic

- **Wait:** If `delta_sec > 0`, loop sleeps in chunks of `SCHEDULER_POLL_INTERVAL_SEC` until `scheduled_time` (1404–1423). Then one cycle runs (connect check, assignment, post loop, cycle_done).
- **Drift:** No drift correction; next run is always `cycle_anchor + (cycle_index+1)*cycle_sec` (or now_ts for first when run_first_cycle_immediately).
- **Overrun:** If posting doesn’t finish before `cycle_end_ts`, remaining groups are put in `pending_groups` and the loop breaks out of the for-loop (1599–1608); next cycle starts with `pending_groups + assigned` (1546–1547). So overrun does not skip the next cycle; it rolls remaining work to the next cycle.

### 3. Per-session vs system-wide

- **Anchor:** One `cycle_anchor_ts` per bot (in config); all workers get the same snapshot, so cycles are aligned to the same boundary.
- **Stagger:** First cycle can be staggered (e.g. Enterprise: second half of sessions delayed by ENTERPRISE_STAGGER_SEC) (workers.py 332–337). So “when” the first cycle runs can differ by session, but the anchor is shared.

### 4. If posting isn’t finished before next cycle

- Remaining groups are rolled to `pending_groups`; next cycle runs at the next boundary and processes `pending_groups + assigned`. So no skip and no overlap of “cycle start” (one cycle run per boundary); work can span two boundaries via rollover.

**Summary:**

```
CYCLE SCHEDULING:
1. Anchor calculation: next_cycle_time = cycle_anchor_ts + (cycle_index+1)*cycle_sec; cycle_index = (now_ts - cycle_anchor)//cycle_sec.
2. Cycle start logic: Sleep in chunks until scheduled_time; then one cycle (connect, assign, post, cycle_done); first cycle can be immediate when run_first_cycle_immediately.
3. Synchronization: One anchor per bot; all sessions share it; first-cycle stagger can delay first run per session.
4. Overrun handling: Remaining groups stored in pending_groups; next cycle runs on schedule and processes pending_groups + newly assigned.
5. First cycle: Immediate when run_first_cycle_immediately and not done; otherwise wait until next boundary.
```

---

## PHASE 6: FLOODWAIT ERROR HANDLING

### 1. FloodWait exception handlers

- **rpc_errors.py:** Inside `with_retry` (302–347): on retryable error, `handler.handle(e)` returns action and seconds. If `seconds > FLOODWAIT_THRESHOLD_SEC` (300), raises `FloodWaitPause(seconds)` instead of sleeping (326–333).
- **users.py:** In the posting loop, `except FloodWaitPause as e:` at 1747–1763: sets `unblock_time = time.time() + e.seconds`, calls `set_session_paused(bot_token, session_file, unblock_time)`, `report_session_paused(session_file, unblock_time, e.seconds)`, and in Enterprise `_defer_groups_starter(bot_token, remaining)` and log `[RedistributionCheck]`, then `break`.

### 2. What happens when FloodWait is caught

- **In worker:** Session is marked paused (in-memory and via `report_session_paused` → result_queue). Remaining groups are deferred (Enterprise only). Loop breaks.
- **Controller:** On `session_paused` message, `_apply_worker_result` (users.py 2107–2115) does `_save_bot_config(bot_token, upd)` with `upd` setting `session_pause_until[session_file] = unblock_time`. So state is persisted. Controller does **not** call `_assigned_groups_for_session` or any assign function.

### 3. FloodWait state tracking

- **In-memory:** `_session_pause_until` dict in users.py (see get_session_pause_until / set_session_paused).
- **Persisted:** `cfg["session_pause_until"][session_file] = unblock_time` in bot config (user JSON). Snapshot and config_patch include `session_pause_until` and `active_session_files`.

### 4. Resume after FloodWait

- **At cycle start:** `maybe_reactivate_session` and `get_session_pause_until` (users.py 1516–1517). If `pause_until > time.time()`, session skips posting and sleeps in chunks until `pause_until`, then `continue` to next loop iteration (1315–1543). So it resumes when the clock passes `pause_until`.
- **Rejoining assignment:** When any worker sends `cycle_done`, controller clears that session’s `session_pause_until` for the completed session and sends `config_patch` with updated `session_pause_until` and `active_session_files`. Workers merge the patch; on the next cycle, a session that has passed its pause_until is back in `_active_session_files` and gets a shard again. No manual step required.

### 5. Does FloodWait trigger reassignment?

- **Direct call:** No. The controller never calls `_assigned_groups_for_session` on FloodWait.
- **Indirect effect:** Yes. FloodWait → `session_paused` → controller saves `session_pause_until` → that session is excluded from `_active_session_files(cfg)` (users.py 1994–1997). When the next `cycle_done` is processed, controller sends `config_patch` with updated `active_session_files`. Next cycle, each worker’s `_assigned_groups_for_session(..., get_config())` sees a smaller `active_list`, so remaining sessions get more groups. So “reassignment” is implicit (recompute with updated cfg), not an explicit reassign call.

**Summary:**

```
FLOODWAIT HANDLING:
1. Exception handlers: rpc_errors.py 326–333 (with_retry raises FloodWaitPause when seconds > 300); users.py 1747–1763 (catch FloodWaitPause, set paused, defer, break).
2. Immediate actions: set_session_paused; report_session_paused (→ controller); Enterprise: _defer_groups_starter(remaining); break.
3. State tracking: In-memory _session_pause_until; persisted in bot config session_pause_until[session_file]; snapshot/config_patch carry it.
4. Resume logic: At cycle start, if pause_until > now, sleep until pause_until then continue; after cycle_done, config_patch restores active_session_files so next cycle assigns groups again.
5. DOES IT REASSIGN GROUPS?: Not by a direct call; next cycle _assigned_groups_for_session runs with patched cfg, so remaining (non-paused) sessions get a new, larger shard when active_session_files shrinks.
6. Code path: FloodWaitPause → set_session_paused + report_session_paused → result_queue → _apply_worker_result session_paused → save session_pause_until; later cycle_done → config_patch with active_session_files → workers merge patch → next cycle _assigned_groups_for_session uses new active_list.
```

---

## PHASE 7: CONTROLLER & RESULT QUEUE

### 1. Controller structure

- **Main loop:** No single “controller main loop” that only processes results. The main asyncio loop runs `_worker_result_handler_async` (users.py 2354–2380), which does `q.get()` (via asyncio.to_thread) and `_apply_worker_result(msg)` for each message. So the controller is the main process that started workers and that runs this handler.

### 2. Result queue message types

- From workers (workers.py / users.py session loop): `cycle_done`, `cycle_failed`, `session_died`, `session_paused`, `expired`, `admin_alert`, `dm_alert`, `log`, `user_log`, `post_attempt`, `heartbeat`, `ban_error`, etc. Format: dict with `type`, `bot_token`, and type-specific fields (e.g. `session_file`, `timestamp`, `unblock_time`, `wait_seconds` for session_paused).

### 3. How controller reacts to events

- **cycle_done:** Update last_cycle_time, clear session_pause_until for that session, update stats; then push config_patch (session_pause_until + active_session_files) to all workers (users.py 2044–2080).
- **session_paused:** Persist session_pause_until only (2110–2115). No assign call.
- **session_died:** _mark_session_dead_and_replace (2102–2105).
- **cycle_failed:** Add session to excluded_sessions (2091–2101).
- **heartbeat:** Used for liveness; no reassignment.

### 4. Worker restart logic

- **When:** Health check (e.g. heartbeat timeout) triggers `_restart_single_worker(bot_token, worker_id)` (users.py 2462–2537). Also on Run, workers are started fresh (no “restart” of existing ones; old ones are stopped first if bot was running).
- **Restart process:** Stop command to worker, join, spawn new process with same session_chunk and new config_snapshot from `_build_worker_config_snapshot(cfg, total_sessions)` (2507). So new worker gets current cfg (including current active_session_files at restart time), not “reassign groups” as a separate step. Assignment is again recomputed each cycle inside the worker.

### 5. Does controller trigger reassignment?

- It never calls `_assigned_groups_for_session` in response to events. It only updates config (session_pause_until, excluded_sessions, etc.) and sends config_patch. Reassignment is always done inside workers at cycle start.

**Summary:**

```
CONTROLLER ARCHITECTURE:
1. Main loop structure: _worker_result_handler_async (users.py 2354–2380): loop over result_queue.get(), _apply_worker_result(msg).
2. Event types: cycle_done, cycle_failed, session_died, session_paused, expired, admin_alert, dm_alert, log, user_log, post_attempt, heartbeat, ban_error.
3. Event handlers: cycle_done → update config + config_patch to all workers; session_paused → persist session_pause_until; session_died → mark dead/replace; cycle_failed → exclude session; no assign calls.
4. Worker restart: On heartbeat timeout (or similar), _restart_single_worker: stop old process, spawn new with _build_worker_config_snapshot(cfg, total_sessions); new worker recalculates assignment each cycle from get_config().
5. DOES IT TRIGGER REASSIGNMENT?: No explicit call; config_patch (after cycle_done) updates active_session_files so workers’ next _assigned_groups_for_session run reassigns implicitly.
```

---

## PHASE 8: CONFIGURATION STRUCTURE

### 1. “adbot.json” structure (actual storage)

- There is **no single adbot.json**. Storage is:
  - **data/pool.json:** free_sessions, dead_sessions, frozen_sessions, admin_alerts.
  - **data/index.json:** by_token → user name (bot_token → name).
  - **data/user/<name>.json:** full bot config for that user (name, bot_token, bot_username, valid_till, cycle, gap, mode, group_file, log_group, log_file, authorized, sessions, state, last_cycle_time, ban_error_count_by_session, message_text, post_link, post_links, session_pause_until, session_cooldown_until, excluded_sessions, cycle_anchor_ts, stats, etc.). No `assigned_groups` key; no `assignment_locked` flag.

### 2. Load / save

- **Load:** `load_adbot()` in code/utils.py 653–672: reads pool, index, then for each bot_token loads `load_user_data(name)` into `bots[bot_token]`.
- **Save:** `save_adbot(data)` in code/utils.py 676–688: saves pool from data; for each bot in data["bots"], looks up name and calls `save_user_data(name, cfg)`. Per-bot config is also updated by `_save_bot_config(bot_token, upd)` in users.py, which loads current adbot, updates the bot’s cfg with `upd(c)`, and calls save_adbot (or equivalent) so only that bot’s user file is written.

### 3. Assignments persisted?

- **No.** Assignments are not stored; they are recomputed each cycle from group_file, active_session_files, session_pause_until, excluded_sessions, etc.

### 4. Save triggers

- Any call to `_save_bot_config` or `save_adbot` (e.g. cycle_done upd, session_paused upd, session_died, config changes from admin/user, stats flush, etc.).

**Summary:**

```
CONFIGURATION STRUCTURE:
1. Current storage: data/pool.json + data/index.json + data/user/<name>.json; no adbot.json. Per-bot: name, bot_token, cycle, gap, mode, group_file, sessions, state, session_pause_until, session_cooldown_until, excluded_sessions, cycle_anchor_ts, post_link, post_links, message_text, etc. No assigned_groups; no assignment_locked.
2. Load function: load_adbot in code/utils.py 653–672 (pool + index + load_user_data per bot).
3. Save function: save_adbot in code/utils.py 676–688; _save_bot_config in users.py (load, upd(cfg), save).
4. Assignments persisted?: No.
5. Save triggers: On cycle_done, session_paused, session_died, config edits, stats flush, etc.
```

---

## PHASE 9: LOG ANALYSIS CORRELATION

(The prompt referred to specific log lines like “Line 24: [ShardCheck] … assigned=31” and “Line 1017: … assigned=83”. The repo’s current log files do not contain those exact lines; the correlation below is from code paths that would produce such lines.)

### 1. [ShardCheck] total_groups=124 session=... assigned=31

- **Where printed:** `code/users.py` 1549–1551, inside `_async_session_loop` right after `assigned, total_groups = _assigned_groups_for_session(...)` and `groups = pending_groups + list(assigned)`.
- **Variables:** `total_groups` is the second return value (len(all_groups)); `len(groups)` is what is logged as `assigned=` (pending_groups + assigned for this session).

### 2. Same session later assigned=83

- **Why it can change:** `_assigned_groups_for_session` is called again the next cycle. In Enterprise, if `active_session_files` (or effective active list) has changed—e.g. other sessions paused—then `total = len(active_list)` is smaller and this session’s slice is larger. Example: 124 groups, 4 sessions → 31 each; after 3 sessions paused, 1 active → 124, or 2 active → 62 each. 83 could be from a different total_groups (e.g. 166/2) or a different number of active sessions. So the “reassignment” is the normal next-cycle recomputation with updated cfg (smaller active list), not a separate bug.

### 3. [FloodWait] session=... pause_until=... wait_seconds=3000

- **Where printed:** Either (1) users.py 1316–1320 (at cycle start when session is still paused: “wait_seconds=…”) or (2) users.py 1750–1752 (right after catching FloodWaitPause in the post loop: “pause_until=… wait_seconds=…”). The “wait_seconds=3000” suggests the handler that catches FloodWaitPause (1750–1752) or the cycle-start pause log (1316).
- **What runs after:** In the except block (1747–1763): set_session_paused, report_session_paused, defer (Enterprise), break. No direct reassign call; next cycle other workers get config_patch and their next _assigned_groups_for_session uses fewer active sessions → larger shards.

### 4. Multiple sessions posting within 1 second (e.g. lines 50–57)

- **Why:** Each session runs in its own task/process with its own gap; gaps are per session. So multiple sessions can hit “post” at the same wall-clock second. There is no global “only one post per second across all sessions” lock. So this is expected concurrency, not missing gap enforcement.

**Summary:**

```
LOG-TO-CODE CORRELATION:
1. Assignment log location: code/users.py 1549–1551 (report_user_log or logger.info "[ShardCheck] total_groups=... session=... assigned=...").
2. Reassignment trigger: Same function _assigned_groups_for_session on a later cycle; changed assigned count due to updated active_session_files (fewer active sessions → larger shard for this session).
3. FloodWait handler: users.py 1747–1763 (set_session_paused, report_session_paused, defer, break); no assign call.
4. Concurrent posting cause: Multiple sessions each with their own gap; no global serialization, so multiple sessions can post in the same second by design.
```

---

## FINAL OUTPUT: COMPREHENSIVE ANALYSIS REPORT

```
====================================
TADBOT SYSTEM ARCHITECTURE ANALYSIS
====================================

SUMMARY OF FINDINGS:

1. POST LINK MECHANISM
   - Storage: Per-user JSON (data/user/<name>.json) via load_adbot/save_adbot; keys post_link (legacy), post_links (list).
   - Loading: _get_post_links_list(cfg); at post time _parse_post_link(link) → (from_peer, message_id) for forward.
   - Issues found: No validation that source message still exists; if deleted, forward fails at API time.

2. GROUP LOADING
   - File format: groups/<group_file>, one line per target: -100... or "chat_id | topic_id"; empty/invalid lines skipped.
   - Loading logic: _parse_groups_file / _load_groups; called every cycle from _assigned_groups_for_session; no cache.
   - Issues found: None critical; duplicate lines in file would result in duplicate targets.

3. ASSIGNMENT ARCHITECTURE
   - Algorithm: Starter = full list rotated by cycle; Enterprise = slice by active_session_files (or total_sessions) so remaining sessions get more groups when some are paused.
   - Is stateless?: Yes (same cfg/session_index → same slice).
   - Triggers: Every cycle start in worker (1545); at Run for logging (2676). No explicit trigger on FloodWait; config_patch after cycle_done updates active_session_files so next cycle recomputes.
   - Reassignment when sessions change: Yes — by design. When active_session_files shrinks (e.g. FloodWait), next cycle _assigned_groups_for_session gives remaining sessions a larger shard. Not a bug.

4. POSTING MECHANISM
   - Structure: Sequential per session; concurrent across sessions (multiple workers × multiple session tasks).
   - Gap enforcement: Per-session schedule (cycle_start + idx * effective_gap_cycle); one asyncio.sleep(final_wait) per post.
   - No bug: Gaps are enforced per session; multiple sessions can post in the same second by design.

5. FLOODWAIT HANDLING
   - Current logic: with_retry raises FloodWaitPause when wait > 300s; session loop catches, marks paused, reports to controller, defers (Enterprise), breaks. Controller persists session_pause_until; on cycle_done sends config_patch so workers see updated active_session_files next cycle.
   - State tracking: session_pause_until in config; snapshot/config_patch; in-memory in users.py.
   - Does not directly reassign: Controller does not call _assigned_groups_for_session; next cycle workers recompute with patched cfg, so remaining sessions get more groups (intended).

6. CYCLE SCHEDULING
   - Logic: next_cycle_time = cycle_anchor_ts + (cycle_index+1)*cycle_sec; first cycle can be immediate; overrun rolls remaining groups to next cycle.
   - Issues found: None identified.

7. CONTROLLER
   - Event handling: _apply_worker_result for cycle_done, session_paused, session_died, etc.; updates config and sends config_patch; no assign calls.
   - No bug: Reassignment is implicit (workers recompute next cycle); controller does not call assignment.

CONFIRMED BUGS (from this analysis):
- None that match the “reassignment on FloodWait is wrong” hypothesis. Assignment is recomputed every cycle from current config; when sessions are paused, giving remaining sessions more groups is intentional.
- Possible improvements: (1) Validate post link / source message existence when user sets it or at cycle start (optional). (2) Optionally deduplicate group file lines. (3) Document that “assigned=31” → “assigned=83” can happen after other sessions pause (Enterprise).

FILES REQUIRING CHANGES (for the above improvements only):
- code/users.py: Optional post-link validation or docs.
- docs: Document Enterprise reassignment when sessions pause (and that ShardCheck assigned count can increase).

ROOT CAUSE (of “31 → 83” style behavior):
Assignment is stateless and recomputed every cycle. In Enterprise, the partition is based on active_session_files (sessions that are not excluded, not paused, not in cooldown). When one or more sessions hit FloodWait, they are persisted as paused; when the next cycle_done is applied, the controller sends a config_patch with the updated active_session_files list (without the paused sessions). On the next cycle, each worker calls _assigned_groups_for_session with this updated config, so the same session can receive a larger shard (e.g. 31 → 83) because the denominator (number of active sessions) decreased. This is by design to redistribute work to non-paused sessions, not a bug.
```

---

End of report.
