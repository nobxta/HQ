# Posting Flow: Why Some Sessions Load But Never Start Posting

This document traces the execution flow from session discovery through group assignment and identifies every case where a session can be assigned but never actually post.

**Production-stable behavior (refactor):** Each worker gets the **full** group list (no partitioning that can yield zero groups). Startup validation runs before resume: all sessions in `sessions/active` (free + assigned) are validated; invalid are moved to `sessions/dead` and the admin receives a report. Runtime: if a session becomes invalid the admin is notified with standardized messages (e.g. `"<session>.session became UNAUTHORIZED"`). Heartbeat timeout triggers **per-worker** restart only (not full bot restart), and the admin is notified: `"Worker restarted for session XXX.session"`.

---

## 1. Execution Flow (Trace)

### 1.1 Session discovery

- **Where:** `utils.discover_local_sessions(data)` (startup in `main.py`) and admin **Add Sessions** (file/txt/zip).
- **Effect:** `.session` files in `sessions/active/` not already in `free_sessions` or any bot’s `sessions` are added to `free_sessions` in `adbot.json`.
- **Not used for posting directly:** Discovery only fills the pool. Posting uses sessions **assigned to a bot** in `cfg["sessions"]`.

### 1.2 Session assignment to workers

- **Where:** `users._start_posting(bot_token)`.
- **Steps:**
  1. `sessions = cfg.get("sessions", [])` — list of `{"file": "x.session", "real_name", "user_id", "index"}, ...`.
  2. `valid_sessions = [s for s in sessions if (s.get("file") or "") and config.resolve_session_path(s.get("file") or "").is_file()]` — only sessions with non-empty `file` and existing file path.
  3. `chunks = chunk_sessions(valid_sessions, per_worker=SESSIONS_PER_WORKER)` — with `SESSIONS_PER_WORKER=1`, each chunk has one session; worker_id `i` gets `chunks[i]`.

**Logged (controller):**  
`[posting] bot=… worker_id=… sessions_assigned=[...]` for each worker.

### 1.3 Worker creation

- **Where:** `users._start_posting` — `multiprocessing.Process(target=worker_entry, args=(bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, _worker_result_queue))`; `proc.start()` for each chunk.
- **If `proc.start()` raises** (e.g. OOM, fork error): the `except` block runs. It sends `{"cmd": "stop"}` to **already-started** workers, joins them, sets `state=stopped`, adds admin alert, and returns `False`. Workers that were never started (later chunks) never run; workers that were started never receive START (we only send START after the full `try` block).

**Logged (controller):**  
`[posting] START sent to worker_id=… bot=…` only when no exception occurred. On exception, no START is sent.

### 1.4 START command delivery

- **Where:** After all processes are started successfully, `for w_id, (_proc, cmd_q) in enumerate(workers_list): cmd_q.put({"cmd": "start"})`.
- **Worker side:** `workers.worker_main_async` runs `command_listener()` which blocks on `command_queue.get()`. When it receives `{"cmd": "start"}`, it sets `start_event.set()`. Phase 1 waits for `start_event` or `stop_event`; only after START does it proceed to Phase 2 (create session loop tasks).

**Logged:**  
- Controller: `[posting] START sent to worker_id=… bot=…` (and on failure: `[posting] START failed for worker_id=…`).  
- Worker: `[worker-N] received START`.

### 1.5 Group assignment per session

- **Where:** Inside `users._async_session_loop`, each cycle:  
  `groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)`.
- **Starter:** `_load_groups(cfg)` → full list; every session gets the same list.
- **Enterprise:** `_load_groups(cfg)` then partition by `session_ordinal` (global index): `start = idx * chunk`, `groups[start : start + chunk]`. If there are more workers than groups, some sessions get an **empty slice** (zero groups).

**Logged:**  
- Controller (before workers start): `[posting] bot=… worker_id=… session=… global_ordinal=… groups_count=…` and a **warning** if `groups_count=0`.  
- Session loop (each cycle): warning if `len(groups)==0`: *"Session … has ZERO groups this cycle …"*.

---

## 2. What Is Printed (Diagnostic Logs)

When posting starts, the following are logged.

### Controller (main process)

- **Sessions assigned to each worker:**  
  `[posting] bot=… worker_id=… sessions_assigned=[<file or "(no file)">, ...]`
- **Groups count per session (and zero-group warning):**  
  `[posting] bot=… worker_id=… session=… global_ordinal=… groups_count=N`  
  If `groups_count=0`:  
  `[posting] session assigned ZERO groups: bot=… worker_id=… session=… (group_file=… mode=…); session will run but never post`
- **START delivery:**  
  `[posting] START sent to worker_id=… bot=…` for each worker, or  
  `[posting] START failed for worker_id=… bot=…: …` if `cmd_q.put` raises.

### Worker process

- **Sessions in chunk:**  
  `[worker-N] session_chunk=[<file or "(no file)">, ...]`
- **START received:**  
  `[worker-N] received START`
- **Empty file skip:**  
  `[worker-N] skipping session with empty file: dict keys=…` (session in chunk has no `"file"` or empty string).

### Session loop (in worker)

- **Zero groups at runtime:**  
  `Session … has ZERO groups this cycle (group_file=… mode=…); will connect and sleep without posting`

---

## 3. Cases Where a Session Is Assigned But Never Starts Posting

### A. Worker not created

- **When:** `proc.start()` raises for some worker index `K` (e.g. OOM, resource limit, spawn failure).
- **Effect:** Workers `0..K-1` were already started; we then send them STOP and join. Workers `K..N-1` are never started. So **all** sessions in chunks `0..N-1` effectively do not run (first K get STOP before START, rest never run).
- **Detection:** Admin alert `worker_start_failed`; log exception; no `[posting] START sent` for any worker.

### B. Worker created but did not receive START

- **When:**  
  1. Exception during the `try` block (worker creation) — we never reach the loop that does `cmd_q.put({"cmd": "start"})`, so no worker receives START.  
  2. `cmd_q.put({"cmd": "start"})` raises (e.g. queue or process issue) — that specific worker does not receive START.
- **Effect:** That worker stays in Phase 1 (waiting on `start_event`). If it later receives STOP, it exits without ever running a session loop. If it never receives START (e.g. controller crashed after creating workers), it waits until timeout/listener or process kill.
- **Detection:** Controller logs `[posting] START sent to worker_id=…` per worker; if one is missing or you see `[posting] START failed for worker_id=…`, that worker did not get START. Worker side: no `[worker-N] received START` for that N.

### C. Session in chunk has empty `"file"`

- **Where:** `workers.worker_main_async` Phase 2: `for local_ord, session_info in enumerate(session_chunk): session_file = session_info.get("file") or ""; if not session_file: continue`.
- **When:** A session dict in `session_chunk` has no `"file"` key or it’s empty. (Controller’s `valid_sessions` filter should prevent this for file-based sessions; only a corrupted or inconsistent adbot.json / config could leave such a dict in a chunk.)
- **Effect:** No task is created for that session; the worker runs only `command_listener` and possibly other sessions in the same chunk (with SESSIONS_PER_WORKER=1, that means this worker does nothing).
- **Detection:** Worker log `[worker-N] skipping session with empty file: dict keys=…`. Controller log `[posting] bot=… worker_id=… session skipped (empty file)` (we added this in the controller’s pre-check loop).

### D. Session assigned zero groups

- **When:**  
  1. **Group file missing or empty:** `_parse_groups_file(cfg)` returns `[]` (path not a file or no valid lines). All sessions get 0 groups.  
  2. **Enterprise mode and more workers than groups:** Partition: `chunk = ceil(len(all_groups)/n)`, `start = idx * chunk`. For worker index `idx` with `start >= len(all_groups)`, the slice is empty. Example: 10 workers, 3 groups → workers 3–9 get 0 groups.
- **Effect:** Session runs (connects, cycle loop), but `for idx, g in enumerate(groups):` never runs; it reports cycle_done and sleeps. So session “loads” and “runs” but **never posts**.
- **Detection:** Controller: `[posting] session assigned ZERO groups: …` and `groups_count=0` in the same run. Session loop: `Session … has ZERO groups this cycle …` every cycle.

---

## 4. Summary Table

| Case | Session assigned? | Worker created? | START received? | Groups > 0? | Result |
|------|-------------------|-----------------|------------------|-------------|--------|
| A. Worker start failed | Yes (in config) | No (or later workers no) | No | N/A | No posting |
| B. START not sent / put failed | Yes | Yes | No | N/A | Worker waits or exits without running loop |
| C. Empty `file` in chunk | Yes (in chunk) | Yes | Yes | N/A | No task for that session in worker |
| D. Zero groups | Yes | Yes | Yes | No | Loop runs but never posts |

Use the diagnostic logs above to see which of these applies when a session appears to be loaded but never starts posting.
