# AdBot Observability (Forensic Audit)

This document describes how worker/session lifecycle and heartbeat data are written into **one persistent log** (`logs/adbot.log`) so a 24h run can be fully audited from logs alone.

---

## What Was Missing (Before)

- **Worker/session logs were not in adbot.log**  
  Session lifecycle (cycle start, delayed start, pause, stop) and worker heartbeats were emitted inside worker processes. Spawned worker processes do not inherit the controller’s file handlers, so those logs never reached `adbot.log`.

- **No cycle boundaries in logs**  
  Cycle completion was applied in memory only; there was no log line per session per cycle, so expected vs actual cycles and silent gaps could not be computed from logs.

- **No heartbeat/freeze visibility**  
  Heartbeat was used internally for the watchdog; it was not written to the audit log. Worker freeze (WORKER_FROZEN) was logged but not in a standardized `[audit]` form.

- **Start posting lacked mode/cycle/sessions**  
  "Started posting for bot X: N workers" did not include execution_mode, cycle_sec, or total_sessions, so post-run verification of mode and stagger was not possible from logs alone.

---

## What Was Added (Minimal, Logging Only)

### 1. Unified worker → controller logging (Option A)

- **Workers** send structured messages via the existing **result_queue** with `type: "audit_log"` (and optionally `type: "heartbeat"` for rate-limited log).
- **Controller** in `_apply_worker_result()` handles `audit_log` and **writes one line to the same logger** that backs `adbot.log`, so all audit lines go into one file.
- No new threads, no new files, no change to scheduling or safety; only forwarding of worker events into the controller’s log.

### 2. Mandatory session lifecycle audit events (per session)

Every session now emits at least one **audit** event per cycle (or per stop/pause). Events are sent from the worker to the controller and written to `adbot.log` with an `[audit]` prefix:

| Event               | When |
|---------------------|------|
| `SESSION_CYCLE_START` | Start of a posting cycle (immediate or immediate late). |
| `SESSION_DELAYED`     | Delayed start; includes `seconds=…`. |
| `SESSION_PAUSED`      | FloodWait skip; includes `reason=FloodWait`. |
| `SESSION_STOPPED`     | Exit; includes `reason=` (stop_event, no_config, state_not_running, stop_event_after_delay, banned). |
| `SESSION_CYCLE_DONE`  | Cycle completed (after report_cycle_done). |

Each audit log line includes: `bot`, `worker_id`, `session`, `event`, `ts` (timestamp), and when applicable `seconds`, `reason`.

- **Worker:** `report_audit_log(session_file, event, **kwargs)` in `workers.py` pushes `{ type: "audit_log", bot_token, worker_id, session_file, event, timestamp, **kwargs }` onto the result queue.
- **Session loop** in `users.py` calls `report_audit_log` at every lifecycle point above when running inside a worker (when `report_audit_log` is provided). Silent cycles are not allowed: every cycle produces at least one of these events.

### 3. Cycle boundary logging

- **SESSION_CYCLE_START** marks the start of a cycle.
- **SESSION_CYCLE_DONE** is emitted when `report_cycle_done(session_file, timestamp)` is called (same timestamp).
- Auditors can count `SESSION_CYCLE_START` or `SESSION_CYCLE_DONE` per session over time to get **expected vs actual cycles** and detect **silent gaps** (e.g. > 2× cycle_sec with no event).

### 4. Heartbeat and freeze visibility

- **Heartbeat:** On each `heartbeat` result, the controller updates `_worker_last_heartbeat` and, **rate-limited** (e.g. every `HEARTBEAT_LOG_INTERVAL_SEC` per worker), writes a line:  
  `[audit] HEARTBEAT bot=… worker_id=… ts=…`  
  So the log shows that the worker is alive without flooding the file.

- **WORKER_FROZEN:** When the health monitor detects a frozen worker (alive PID, no heartbeat for timeout), it logs:  
  `[audit] WORKER_FROZEN bot=… worker_id=… timeout_sec=… last_hb_ts=…`  
  So freezes are explicitly visible in the same audit log.

### 5. Execution mode and start parameters

When posting starts, the controller logs:  
`Started posting for bot …: N worker(s) M sessions execution_mode=Starter|Enterprise cycle_sec=…`  
So from logs alone you can verify:

- Which mode (Starter vs Enterprise) was used.
- Cycle length and total sessions for stagger/mode checks.

---

## Why This Guarantees Auditability

- **Single log file:** All controller and worker-derived audit data (session lifecycle, cycle boundaries, heartbeat, WORKER_FROZEN, start parameters) are written through the same logger into `adbot.log`.
- **No silent cycles:** Every cycle produces at least one of SESSION_CYCLE_START, SESSION_DELAYED, SESSION_PAUSED, SESSION_STOPPED, or SESSION_CYCLE_DONE; missing events imply the session did not run or the worker died.
- **Cycle boundaries:** SESSION_CYCLE_START and SESSION_CYCLE_DONE with timestamps allow computing expected vs actual cycles and silent gaps (e.g. gaps > 2× cycle_sec).
- **Freezes are visible:** Heartbeat (rate-limited) and WORKER_FROZEN are explicitly in the log, so “alive PID but no progress” is detectable after the fact.
- **Mode and scheduling:** execution_mode, cycle_sec, and total_sessions at start allow post-run verification of Starter vs Enterprise and stagger logic without touching config or code.

Runtime behavior (scheduling, gaps, safety, multiprocessing) is unchanged; only logging and forwarding were added.
