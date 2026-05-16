# AdBot Stats Architecture Audit

This document explains where stats are stored, when they are updated, and why they can appear wrong or inconsistent. It is the baseline for any redesign.

---

## 1. Where are stats stored?

| Store | Location | Scope | Persisted |
|-------|----------|--------|-----------|
| **stats** | Bot config JSON: `data/user/<name>.json` under key `"stats"` | Lifetime (since bot creation / never reset by Run) | Yes, on every update |
| **stats_runtime** | Same JSON under key `"stats_runtime"` | Current run only (reset when Run starts unless `preserve_cycle_time`) | Yes, on every post_attempt |
| **In-memory (controller)** | None. Controller has no separate in-memory stats cache. | — | — |
| **In-memory (workers)** | Per-cycle counters only: `posts_success_cycle`, `posts_failed_cycle`, `posts_skipped_cycle`. Sent to controller in `cycle_done`; not persisted in worker. | Single cycle | No |

**Schema (stats):**

- `stats.total_sent` — total successful posts (lifetime)
- `stats.total_failed` — total failed posts (lifetime)
- `stats.total_skipped` — total skipped (e.g. FloodWait) (lifetime)
- `stats.by_session[session_file].posts` — success count per session (lifetime)
- `stats.by_session[session_file].errors` — failure count per session (lifetime)
- `stats.by_session[session_file].cycles` — completed cycles per session (lifetime)
- `stats.last_stats_update` — ISO timestamp of last update (debug)

**Schema (stats_runtime):**

- `stats_runtime.cycle_success` — successful posts in current run
- `stats_runtime.cycle_failed` — failed posts in current run
- `stats_runtime.groups_completed` — groups posted to this run
- `stats_runtime.groups_total` — total groups at run start
- `stats_runtime.groups_remaining` — derived
- `stats_runtime.posting_speed_per_min`, `last_post_ts`, `cycle_started_ts` — live metrics

So: **everything is stored in the same JSON file**. There is no separate in-memory stats layer in the controller; each read is `load_user_data(name)` (from disk) and each write is `save_user_data(name, cfg)` (to disk).

---

## 2. When are Sent / Failed counters incremented?

### 2.1 Worker mode (multiprocessing)

- **stats (lifetime: total_sent, total_failed, by_session)**  
  - **Only when the controller processes a `cycle_done` message.**  
  - Worker calls `report_cycle_done(session_file, scheduled_run_ts, posts_success=N, posts_failed=M, posts_skipped=K)` at **end of each cycle**.  
  - Controller in `_apply_worker_result` (branch `msg_type == "cycle_done"`) does:
    - `_inc_stat_total(bot_token, "total_sent", posts_success)`
    - `_inc_stat(bot_token, session_file, "posts", posts_success)`
    - `_inc_stat_total(bot_token, "total_failed", posts_failed)`
    - `_inc_stat(bot_token, session_file, "errors", posts_failed)`
    - (and total_skipped if present)  
  - So lifetime stats are updated **once per cycle per session**, in **batch**, when the controller handles `cycle_done`.

- **stats_runtime (current run)**  
  - **On every post attempt.**  
  - Worker calls `report_post_attempt(session_file, group_id, topic_id, success, error_message)` for **every** post (success or failure).  
  - Controller (branch `msg_type == "post_attempt"`) updates `stats_runtime`: `cycle_success` / `cycle_failed`, `groups_completed`, `last_post_ts`, speed, etc., then calls `_save_bot_config(bot_token, _upd_runtime)`.  
  - So runtime stats are updated **per post** and **persisted on every post**.

### 2.2 Non-worker mode (single process, legacy)

- **stats**  
  - Incremented **per post** inside the posting loop: `if not is_worker: _inc_stat(...); _inc_stat_total(...)` on each success/failure.  
- **stats_runtime**  
  - Not used in the same way (no worker → controller post_attempt flow).  
- So in single-process mode, lifetime stats are written to disk **on every post**.

---

## 3. Per-worker vs central

- **Workers never write to disk.** They only push messages to the controller’s `_worker_result_queue`.
- **All persistence is in the controller process:** `_apply_worker_result` runs in the main asyncio loop and calls `_save_bot_config` → `load_user_data` / `save_user_data`.
- So: **stats are central** (controller) and **persisted only by the controller** when it handles worker messages.

---

## 4. Persistence: immediate or buffered?

- **stats (lifetime):**  
  - Worker mode: one `_save_bot_config` per **cycle_done** (batch for that session’s cycle).  
  - So one write per cycle per session, not per post.
- **stats_runtime:**  
  - One `_save_bot_config` per **post_attempt** message.  
  - So **immediate write per post** (no batching). With many workers and many posts, this causes many small writes to the same JSON file.

Each `_save_bot_config` does:

1. `load_user_data(name)` (read full JSON)
2. run updater (mutate stats or stats_runtime)
3. `save_user_data(name, cfg)` (merge with existing, then atomic write: temp file + rename)

So every update is a **full read-modify-write** of the bot’s user JSON.

---

## 5. Why might stats show “error” or incorrect values?

### 5.1 Two different UIs, two different sources

- **/config** (and the “STATS” section there) uses **stats**: `total_sent`, `total_failed` from `cfg.get("stats", {})`.  
  - These are **lifetime** and only change when **cycle_done** is processed (worker mode) or per-post (non-worker).
- **/stat** (and /stats) uses **_stats_dashboard**, which reads **stats_runtime**: `cycle_success`, `cycle_failed`, `groups_completed`, etc.  
  - These are **current run** and are **reset to zero** when Run is started without `preserve_cycle_time` (see `_init_stats_runtime` in the Run flow).

So:

- **/config** can show large lifetime numbers (e.g. Sent: 320, Failed: 2211) while **/stat** shows small or zero (e.g. Success: 0, Failed: 0) right after Run, until post_attempt messages are processed.
- If the user expects “current run” everywhere, **/config** will look “wrong” (lifetime). If they expect “lifetime” everywhere, **/stat** will look “wrong” after a new Run (reset).

### 5.2 Literal “error” on screen

- If the UI shows the string “error”, it is likely from:
  - **Exception in the result handler:** `_apply_worker_result` can raise; the handler logs it and continues. The **message that triggered the exception is not applied** (e.g. one cycle_done or post_attempt is skipped). That can leave stats behind or inconsistent.
  - **Missing or wrong type in config:** e.g. `stats` or `stats_runtime` missing or not a dict after a bad write/migration; code using `.get(..., 0)` may still show numbers, but formatting or later logic could raise and show an error message.
  - **“Bot config not found.”** when `get_cfg()` returns None (e.g. index lookup by token fails).

### 5.3 Sent/Failed don’t match real behavior

- **cycle_done not received:**  
  If a worker crashes or the process is killed **after** posting but **before** sending `cycle_done`, that cycle’s successes/failures are **never** added to **stats**. So lifetime total_sent/total_failed will be low; logs may show posts that never get counted.
- **cycle_done applied twice:**  
  The queue is processed sequentially, so duplicate application only happens if the worker sends duplicate cycle_done (e.g. bug or reconnect). Then stats would be overcounted.
- **post_attempt vs cycle_done mismatch:**  
  **stats_runtime** is updated from **post_attempt** (every post). **stats** is updated from **cycle_done** (batch per cycle). If some post_attempt messages are lost or not processed, stats_runtime will be lower than the real count for the run. If a cycle_done is lost, stats (lifetime) will be lower than the real count. So **stats_runtime** and **stats** can diverge for the same run if messages are lost.
- **Failure definition:**  
  In the loop, `posts_failed_cycle = attempted - success - skipped`. So “failed” = attempted minus success minus skipped (FloodWait/cooldown). If “skipped” is misclassified (e.g. permanent error counted as skipped), failed can look wrong.

---

## 6. Race conditions between workers and controller

- **Single consumer:** One asyncio task runs `_worker_result_handler_async` and calls `_apply_worker_result(msg)` for each message. So **all updates to the same bot’s config are sequential** in the controller. No concurrent updates to the same file from the controller.
- **Read path:** When the user runs /stat or /config, `get_cfg()` is called, which does `_get_cfg(bot_token)` → `load_user_data(name)` and reads the file again. So there is no in-memory cache; we always see the last completed write.
- **Possible race:** If the controller is in the middle of `_save_bot_config` (has read the file, is about to write), and the Telegram client (same process) calls `get_cfg()` for /stat, it will get the **previous** content until the write completes. So you can briefly see “one write behind” but not corrupted values.
- **No cross-process write:** Workers do not touch the file; only the controller does. So no multi-process write race to the same file.

---

## 7. Worker results overwritten or lost?

- **Overwritten:**  
  Each `_save_bot_config` does a **full read-modify-write**. The updater only changes specific keys (e.g. stats, stats_runtime). So we don’t overwrite “other” stats with stale data **unless** the updater or merge logic is wrong.  
  - **merge_for_save** (in save_user_data): `stats` is a PROTECTED_KEY. So when merging, we only overwrite `stats` if the **incoming** dict has `"stats"` and it’s not None. The incoming dict is the full cfg we just read and modified; so we replace the whole `stats` object with the one we just updated. No other process is writing at the same time, so no overwrite from another worker.
- **Lost:**  
  - If the controller process crashes **after** a worker sends cycle_done but **before** or **during** _save_bot_config, that cycle’s batch is never persisted.  
  - If _apply_worker_result raises (e.g. bug, or bad data in msg), the handler logs and continues; that one message is **not** applied, so those increments are effectively lost.  
  - Multiprocessing queue: if the controller is slow, the queue can build up; if the process is killed, messages still in the queue are lost. So in theory, **cycle_done** or **post_attempt** messages can be lost on crash or kill.

---

## 8. Summary table

| Question | Answer |
|----------|--------|
| Where are stats stored? | In the bot’s JSON file: `data/user/<name>.json` under `"stats"` (lifetime) and `"stats_runtime"` (current run). |
| When are Sent/Failed incremented? | **Lifetime (stats):** when controller processes **cycle_done** (worker mode) or on each post (non-worker). **Current run (stats_runtime):** when controller processes **post_attempt** (every post in worker mode). |
| Per-worker or central? | Central: only the controller reads/writes the JSON; workers only send messages. |
| Persistence | **stats:** one write per cycle per session (batch). **stats_runtime:** one write per post (no batching). |
| Why “error” or wrong values? | Two UIs (lifetime vs current run); reset of stats_runtime on Run; lost cycle_done/post_attempt (crash/exception); or exception in handler so one message is skipped. |
| Race? | No concurrent writes; single consumer. Possible brief “one write behind” when reading during a write. |
| Results overwritten/lost? | Not overwritten by another process. Can be lost if controller crashes before/during save, or if _apply_worker_result raises for a message. |

---

## 9. Recommendations for redesign (high level)

1. **Clarify semantics:** Decide and document whether each UI is “lifetime” or “current run” and stick to one set of names (e.g. “Lifetime sent/failed” vs “This run success/failed”).
2. **Single source of truth:** Prefer one place that is authoritative (e.g. lifetime in stats; derive “current run” from cycle_done batches or a dedicated run_id/run_start_ts and only count events after that).
3. **Batch persistence:** Avoid writing to disk on every post; e.g. apply post_attempt in memory and flush to disk on cycle_done or on a timer.
4. **Idempotency / deduplication:** Ensure cycle_done (and any future events) can be applied safely even if the same cycle is reported more than once (e.g. by session_file + cycle_ts).
5. **Health of pipeline:** Log or metric when cycle_done/post_attempt are applied vs dropped (exception or missing data), so lost updates are visible.

This audit is the basis for implementing a clearer and more robust stats system.

---

## 10. Stats redesign (implemented)

The stats system was redesigned for clarity and analytics. The following is in effect.

### 10.1 Storage model (no permanent daily history)

- **Lifetime:** `stats.lifetime_sent`, `stats.lifetime_failed`, `stats.created_at` (timestamp).
- **Per-session:** `stats.session_stats[session_file].lifetime_sent`, `lifetime_failed`.
- **Rolling last 24h:** `stats.recent_events` — list of `{ts, session, success}`. Only events from the last 24 hours are kept; list is pruned on every flush and when loading, and capped at 20,000 events.

No stats are taken from **cycle_done**. All increments happen in the controller when handling **post_attempt** (buffer event, then flush when batch size or interval is reached).

### 10.2 Batching and crash safety

- **In-memory buffer:** Each post_attempt appends an event to a per-bot pending deque and updates in-memory deltas for lifetime and session_stats.
- **Flush triggers:** Stats are flushed to disk when (1) pending events reach `STATS_BATCH_SIZE` (e.g. 50), or (2) at least `STATS_FLUSH_INTERVAL_SEC` (e.g. 5 seconds) have passed since the last flush. A periodic asyncio task also flushes every 5 seconds for all bots with non-empty pending events.
- **Crash safety:** At most one flush interval (and up to one batch) of events can be lost if the process exits before the next flush.

### 10.3 Rolling window

- On each flush, `recent_events` is filtered to `ts >= now - 24*3600` and trimmed to the last `RECENT_EVENTS_MAX` (20,000) entries. The same 24h prune (and cap) is applied when reading for display.

### 10.4 Reset behavior

- **Reset Stats** clears lifetime_sent, lifetime_failed, session_stats, and recent_events. **created_at** is kept (not reset), so “since bot creation” remains meaningful after a reset.

### 10.5 UI

- **/stats** main view: GLOBAL (Lifetime) Sent/Failed/Total Attempts/Success Rate; LAST 24 HOURS Sent/Failed/Success Rate, Posts per Hour (avg), Estimated Posts per Day; buttons [Per Session] [Analyze] [Reset Stats].
- **Per Session:** List of sessions (Account N → Sent | Failed | %); clicking a session shows LIFETIME + LAST 24 HOURS for that session.
- **Analyze:** From recent_events: posts in last 60 min, 6 h, 24 h; peak posting hour; average posts/hour; current rate (last 15 min extrapolated to hour). Numeric only.
- **Reset:** Confirmation then reset; created_at is preserved (documented in UI and here).
