# AdBot Deterministic Runtime Audit

Complete audit of scheduler, worker lifecycle, connect, queues, and health monitor. Goal: identify remaining causes of delayed first post, irregular cycle timing, workers stopping mid-cycle, inconsistent session behavior, and long blocking operations; then apply only minimal runtime-safety fixes.

---

## 1. End-to-end execution trace

Timeline: **Run click → scheduler start → worker spawn → START → loop start → cycle trigger → connect → assignment → first post.**

| Stage | File | Function | Blocking call | Max delay | Intentional? | Affects |
|-------|------|----------|---------------|-----------|--------------|---------|
| Run click | (PTB) | callback | — | 0 | — | — |
| Pending STOP | users.py | _start_posting | await asyncio.wait_for(pending, 50) | 0–50 s | Yes | First cycle only (after prior Stop) |
| Start guard | users.py | _start_posting | — | 0 | Yes | — |
| Teardown workers | users.py | _start_posting | cmd_q.put(stop), await asyncio.to_thread(_join_workers_sync) | 0–40 s | Yes | First cycle (replace run) |
| Teardown tasks | users.py | _start_posting | asyncio.wait(tasks, timeout=35) | 0–35 s | Yes | First cycle (replace run) |
| Status steps | users.py | _start_posting | await asyncio.sleep(0.2) × 4 | 0.8 s | Yes | First cycle |
| Zero-group filter | users.py | _start_posting | — | 0 | Yes | — |
| Anchor + snapshot | users.py | _start_posting | _save_bot_config, _get_cfg | 0 | — | — |
| Worker spawn | users.py | _start_posting | proc.start() | &lt;1 s | — | — |
| START sent | users.py | _start_posting | cmd_q.put(start) | 0 | — | — |
| Worker wait START | workers.py | worker_main_async | asyncio.wait([start_task, stop_task]) | 0 (queue has START) | Yes | First cycle |
| Command listener | workers.py | command_listener | asyncio.wait_for(run_in_executor(command_queue.get), 10) | 10 s (timeout, then continue) | Yes | — |
| Pre-warm start | users.py | _async_session_loop | asyncio.create_task(_prewarm_connect()) | 0 | Yes | First cycle (background) |
| Stagger | users.py | _async_session_loop | await asyncio.sleep(stagger_sec) | 0 when run_first; else up to 3600/300 s | Yes (skipped run_first) | First cycle only |
| Global pause | users.py | _async_session_loop | while… await asyncio.sleep(chunk) | Arbitrary | Yes | First/next |
| Cooldown | users.py | _async_session_loop | while… await asyncio.sleep(chunk) | ~15 min | Yes | First/next |
| next_cycle_time | users.py | _async_session_loop | run_first overrides to now_ts, delta_sec=0 | 0 | — | First cycle |
| Delta sleep | users.py | _async_session_loop | while delta_sec>0: sleep(chunk) | 0 when run_first | Yes | Next cycles |
| FloodWait (pre-post) | users.py | _async_session_loop | while… await asyncio.sleep(chunk); disconnect | Arbitrary | Yes | First/next |
| Ensure connected | users.py | _async_session_loop | session_ready.wait(timeout=30); or _connect_session_for_cycle | 0–30 s wait + 0–25 s per connect attempt | Yes | First/next (when not connected) |
| Connect | users.py | _connect_session_for_cycle | wait_for(connect_task, 25); heartbeat every 8 s; retry sleep 5 s | 25 s × 3 + 5 s × 2 = 85 s max | Yes (bounded) | First/next |
| Assignment | users.py | _async_session_loop | _assigned_groups_for_session (get_config) | 0 | — | Every cycle |
| First post | users.py | _async_session_loop | send_message, etc. | ~1–5 s | — | — |

---

## 2. Blocking call classification

| Location | Call | Type | Notes |
|----------|------|------|--------|
| users.py 94, 101, 125, 147, 171 | asyncio.sleep (log drain) | Deterministic | Fixed intervals; controller only |
| users.py 1177 | asyncio.sleep(8) in heartbeat task | Deterministic | During connect only |
| users.py 1182 | asyncio.wait_for(connect_task, 25) | Deterministic | Bounded connect timeout |
| users.py 1227 | asyncio.sleep(5) retry delay | Deterministic | Between connect attempts |
| users.py 1276 | asyncio.sleep(stagger_sec) | Conditional | Skipped when run_first_cycle_immediately |
| users.py 1343 | asyncio.sleep(chunk) global pause | Conditional | Only when global_pause_until &gt; now |
| users.py 1373 | asyncio.sleep(chunk) cooldown | Conditional | Only when cooldown_until &gt; now |
| users.py 1419 | asyncio.sleep(chunk) delta_sec | Deterministic | Only when delta_sec &gt; 0 (not first when run_first) |
| users.py 1439 | asyncio.wait_for(session_ready.wait(), 30) | Deterministic | Bounded wait for pre-warm |
| users.py 1343, 1543, 1641 | asyncio.sleep FloodWait/pause | Conditional | Only when pause_until &gt; now |
| users.py 1653 | asyncio.sleep(final_wait) pacing | Deterministic | Per-post pacing |
| users.py 1922 | asyncio.sleep(gap) between posts | Deterministic | Per-post gap |
| users.py 1961 | asyncio.sleep(chunk) next cycle | Deterministic | Until next_scheduled |
| users.py 2623, 2653, 2707 | asyncio.sleep(0.2) status | Deterministic | 0.8 s total controller |
| users.py 2584 | asyncio.to_thread(_join_workers_sync) | Deterministic | 0–40 s; only on teardown |
| users.py 2490 | asyncio.sleep(0.5) restart poll | Deterministic | Short poll after STOP |
| users.py 2944, 2935 | asyncio.sleep health monitor | Deterministic | SESSION_HEALTH_CHECK_INTERVAL |
| workers.py 266–268 | asyncio.wait_for(run_in_executor(command_queue.get), 10) | Deterministic | 10 s timeout then continue; not blocking indefinitely |
| workers.py 271–272 | command_queue.get in executor | Conditional | Only until START received (already in queue at spawn) |
| users.py 2079 | cmd_q.put(config_patch) | Low risk | Queue to worker; typically non-blocking |
| workers.py (all) | result_queue.put(...) | Conditional risk | multiprocessing.Queue.put can block if queue full; controller drain must keep up. If handler is slow, worker could block. |

**Verdict:** All identified blocking is either deterministic (fixed timeouts/intervals), conditional (only under pause/cooldown/FloodWait), or low risk. The only conditional/dangerous delay is **result_queue.put** if the controller falls behind; recommend monitoring queue depth or using put with timeout in workers if issues appear (no code change in this audit unless needed).

---

## 3. Connection behavior audit

| Check | Status | File:line / note |
|-------|--------|-------------------|
| Connections reused between cycles | Yes | No disconnect at cycle end (users.py 1947–1961); only disconnect on FloodWait (1532) and in finally (1965). |
| Connect only when not connected | Yes | users.py 1436–1444: is_connected check; only call _connect_session_for_cycle when not is_connected. |
| Connect timeout enforced | Yes | users.py 1182: wait_for(connect_task, SESSION_CONNECT_TIMEOUT_SEC=25). |
| Heartbeat during connect | Yes | users.py 1174–1204: heartbeat task every 8 s; cancelled in finally. |
| No disconnect at cycle end | Yes | users.py 1947: comment and removed disconnect; only finally on exit. |
| Pre-warm exactly once per worker start | Yes | users.py 1286–1306: single asyncio.create_task(_prewarm_connect()) before while True. |
| Connect retries do not unboundedly block | Yes | 3 attempts × (25 s timeout + 5 s delay) max; then return False and worker can break out. |

**Scenario where connect could still delay posting:** (1) Pre-warm fails; first cycle waits session_ready 30 s then runs _connect_session_for_cycle; up to 3 × 25 s + 2 × 5 s. (2) Session returns from FloodWait; next cycle sees not is_connected, runs _connect_session_for_cycle (bounded by timeout). Both are bounded and intentional.

---

## 4. Worker lifecycle stability

| Restart condition | File:line | Can run while healthy? | Preserves anchor? | Skips cycle? | Loses assignment? |
|-------------------|-----------|--------------------------|-------------------|--------------|--------------------|
| Heartbeat timeout | users.py 2965–2988 | No (only when no heartbeat for timeout_sec) | Yes (snapshot from cfg) | No | No (same session chunk) |
| Startup failure | users.py 2992–3018 | No (after 600 s, and skip if FloodWait) | Yes (preserve_cycle_time) | No | No |
| alive &lt; expected | users.py 3019–3036 | No (only when process died) | Yes (preserve_cycle_time) | No | No (full restart, same config) |
| Manual Stop | users.py (Stop handler) | N/A (user intent) | N/A | N/A | N/A |

**Confirmation:** Restart does not happen while worker is healthy (alive == expected skips full restart; grace period and FloodWait skip startup-failure). _restart_single_worker builds snapshot with current cfg (users.py 2507) so cycle_anchor_ts is preserved; no run_first_cycle_immediately so next cycle is anchor-based. No silent cycle skip; no session loses assignment (same session_chunk and config_patch keeps active_session_files).

---

## 5. Assignment correctness

| Check | Status | File:line / note |
|-------|--------|-------------------|
| active_session_files in config_patch | Yes | users.py 2074–2079: patch includes active_list from _active_session_files(cfg_after). |
| Workers merge config_patch | Yes | workers.py 276–281: config_patch updates local_config_patch; get_config merges (90–97). |
| FloodWait-cleared rejoin without restart | Yes | cycle_done clears session_pause_until (2055–2058), then patch sends updated active_session_files; next cycle worker sees updated list. |
| No active session gets 0 groups when groups exist | Yes | Enterprise partition (users.py 1007–1018): session in active_list gets slice; if active_list correct (from patch), slice non-empty. |
| Assignment every cycle | Yes | _assigned_groups_for_session called each cycle from get_config() (workers merge patch). |
| Snapshot cannot stay stale | Yes | config_patch after every cycle_done updates session_pause_until and active_session_files. |

---

## 6. Deterministic scheduler enforcement

| Check | Status | File:line / note |
|-------|--------|-------------------|
| cycle_anchor_ts set only on fresh Run | Yes | users.py 2662–2663: only when not preserve_cycle_time. |
| next_cycle_time anchor-based | Yes | users.py 1383–1389; override only for run_first_cycle_immediately first cycle (1389–1394). |
| First cycle immediate when run_first_cycle_immediately | Yes | users.py 1389–1394: next_cycle_time = now_ts, delta_sec = 0; stagger skipped 1272–1276. |
| Health restarts do not reset anchor | Yes | _start_posting(preserve_cycle_time=True); 2662 not run; snapshot from cfg (2507) keeps anchor. |
| No drift across cycles | Yes | next_scheduled = scheduled_run_ts + cycle_sec (1949); sleep until next_scheduled; anchor not recomputed. |

---

## 7. Determinism audit table (blocking points and risks)

| # | Location | Blocking / risk | Max delay | Class | Mitigation |
|---|----------|------------------|-----------|--------|------------|
| 1 | users.py 2552–2554 | Pending STOP cleanup | 50 s | Deterministic | Intentional; only after Stop. |
| 2 | users.py 2582–2584 | Join workers (teardown) | 40 s | Deterministic | Intentional. |
| 3 | users.py 2623, 2653, 2707 | Status sleeps | 0.8 s | Deterministic | Reduced for latency. |
| 4 | users.py 1276 | Stagger | 0 when run_first | Conditional | Skipped when run_first. |
| 5 | users.py 1343, 1373, 1543, 1641 | Global/cooldown/FloodWait sleeps | Arbitrary / 15 min | Conditional | Intentional safety. |
| 6 | users.py 1439 | session_ready.wait(30) | 30 s | Deterministic | Bounded wait for pre-warm. |
| 7 | users.py 1182, 1227 | Connect timeout + retry delay | 25 s × 3 + 5 × 2 | Deterministic | Bounded. |
| 8 | workers.py 266–268 | command_queue.get (timeout 10) | 10 s | Deterministic | No indefinite block. |
| 9 | workers.py result_queue.put | Queue full block | Unbounded if handler slow | Nondeterministic risk | Monitor; optional: put with timeout. |
| 10 | users.py 2588–2592 | asyncio.wait(tasks, 35) teardown | 35 s | Deterministic | Intentional. |

---

## 8. Remaining root causes of nondeterministic behavior

- **Delayed first post:** Addressed by pre-warm, session_ready wait (30 s), connect timeout (25 s), and no disconnect at cycle end. Remaining delay is at most ~30 s (wait for pre-warm) + one connect attempt (25 s) if pre-warm fails.
- **Irregular cycle timing:** Addressed by anchor set once, next_cycle_time from anchor, no anchor reset on health restart.
- **Workers stopping mid-cycle:** Addressed by restart only on heartbeat timeout (worker frozen), startup failure (after 600 s, skip FloodWait), or alive &lt; expected (process dead). Grace period avoids restart during init.
- **Inconsistent session posting:** Addressed by config_patch with active_session_files so FloodWait-cleared sessions get groups; assignment recalculates from get_config() each cycle.
- **Long blocking in workers:** Connect bounded to 25 s; heartbeat during connect; session_ready wait 30 s. **Only remaining theoretical risk:** result_queue.put blocking if controller is very slow (queue full). Not observed in provided logs; optional hardening: use put with timeout or larger queue.

---

## 9. Minimal patch set

**Current codebase already includes:**

- run_first_cycle_immediately and first-cycle override (users.py 1389–1394, 1272–1276).
- config_patch with active_session_files (users.py 2070–2080, workers.py 276–281, 90–97).
- Pre-warm background + session_ready wait (users.py 1286–1310, 1438–1444).
- Connect timeout 25 s + heartbeat during connect (users.py 1081–1083, 1174–1204, 1182).
- No disconnect at cycle end (users.py 1947–1961).
- Health: skip when alive == expected, not running, FloodWait for startup-failure (users.py 2956–2962, 2995–2997).
- cycle_anchor_ts only on fresh Run; preserve on restart (users.py 2662–2663, 2507).

**Optional (only if result_queue blocking is observed):**

- In workers.py, replace `result_queue.put(msg)` with a put that has a short timeout (e.g. put with timeout=5 or use a bounded queue with non-blocking put and drop/log after retries). **Not applied** in this audit; add only if logs show worker stalls while sending results.

**No other code changes required** for determinism; architecture unchanged.

---

## 10. Benchmark expectation

| Metric | Expected |
|--------|----------|
| **Run → first post** | With pre-warm: typically **2–30 s** (pre-warm completes in background; first cycle waits up to 30 s for ready then posts, or connects with 25 s timeout). Without pre-warm success: up to **30 + 25 = 55 s** for first connect attempt. |
| **Steady-state cycle accuracy** | Cycles at `cycle_anchor_ts + k * cycle_sec`; sleep until next_scheduled; no drift from anchor. |
| **First cycle** | Immediate when run_first_cycle_immediately (no boundary wait, no stagger). |

---

## 11. Verification checklist for runtime testing

- [ ] **Run → first post:** Run with ≥1 session and ≥1 group; no FloodWait/cooldown/global pause. First post within ~2–30 s (or up to ~55 s if pre-warm fails and one connect attempt needed). Log: first `[SESSION] ... post_attempt [STATUS] success` or “Posted in …”.
- [ ] **Pre-warm:** User log shows `[Connect] session=... prewarm_start` then `prewarm_ready` (or `prewarm_failed`) before or shortly after first cycle trigger.
- [ ] **Connect timing:** Logs show `[Connect] session=... connect_end duration_sec=X`; no unbounded connect.
- [ ] **Cycles on time:** After first cycle, next cycle at anchor + 2*cycle_sec; log `[NextCycle] session=... next_cycle_ts=...` and verify timestamps.
- [ ] **No mid-cycle stop:** While posting, no health restart (heartbeat sent every 8 s during connect, and at loop start; grace period 90 s).
- [ ] **FloodWait rejoin:** One session hits FloodWait; after unblock, config_patch sent (cycle_done); that session gets groups next cycle without bot restart (log VerificationReport with assigned &gt; 0 for that session).
- [ ] **No zero groups for active:** Enterprise with all sessions active; each session has assigned &gt; 0 when groups exist (VerificationReport).
- [ ] **Stop then Run:** After Stop, Run waits for pending STOP cleanup (if any) then starts; first post again within expected range.

---

---

## 12. Log correlation (nobi (3).log)

- **Run → first post (before):** Run at 11:03:55 / 12:37:13; first post 10:05:14 UTC / 11:39:01 UTC → **~77–108 s** delay; matches connect in critical path (no pre-warm, connect every cycle).
- **Scheduler trigger:** Log shows `[Scheduler] triggering cycle` then `[Connect]` or ShardCheck then post; delay was between trigger and first post = connect.
- **FloodWait / 0 groups:** Sessions 919831367490, 917897620233 show FloodWait and later `assigned=0` with `sessions=4` (Enterprise); expected until pause clears; config_patch (active_session_files) ensures rejoin after cycle_done.
- **No heartbeat/restart mid-post in log:** No WORKER_FROZEN or restart between Run and first post in the sampled runs; health logic is not the cause of delay.

---

**References:** CONNECT_LATENCY_REPORT.md, EXECUTION_FLOW_AUDIT.md, ROOT_CAUSE_REPORT.md, DETERMINISTIC_PATCH_SET.md. Log file: `nobi (3).log` (path: c:\Users\NCS\Downloads\Telegram Desktop\nobi (3).log).
