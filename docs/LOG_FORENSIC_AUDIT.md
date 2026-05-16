# AdBot Runtime Log Forensic Audit

**Audit date:** Based on logs in `logs/` and `logs/bots/`  
**Claimed runtime:** ~24 hours continuous  
**Scope:** Correctness, scheduling, execution behavior, mode accuracy, silent freezes/drift.

---

## 0. Log Inventory & Coverage

| Source | Content | Date range |
|--------|--------|------------|
| `logs/adbot.log` | Controller: Started/Stopped posting, Post failed, Session dead, Shutting down; Telethon connections; Admin/crash/resume | 2026-01-28 00:04 → 01:47 (**~1h 43m**) |
| `logs/adbot.log.2026-01-27` | Older format + 2026-01-27 evening runs | 2026-01-27 |
| `logs/bots/Adcoal_bot (1).log` | User actions only: /start, Run, Stop, post link | 2026-01-30 23:04 → 2026-01-31 07:20 |
| `logs/bots/Minecraft_AfkBot.log` | User actions only: /start, Run, Stop | 2026-01-30 22:59 → 2026-01-31 07:37 |

**Critical gap:**  
- **No session-level cycle logs** in any file: no "Session X starting cycle", "delayed start Xs", "stopping (stop_event)", "PAUSED (FloodWait)". These are emitted inside worker processes; worker logs do **not** appear in `adbot.log` (spawned children do not inherit the controller’s file handlers).  
- **No heartbeat / worker_frozen** entries: controller-side heartbeat handling exists in code but no such events appear in logs.  
- **No cycle_done** timestamps in logs: cycle completion is sent via result queue and applied in memory; it is not written to the log files provided.

**Conclusion:**  
The available logs are **insufficient** for a full session-activity and scheduling audit. The audit below is based **only on what is present**: controller Start/Stop, Post failed by session, Session dead, Shutting down, and user-action logs. Where evidence is missing, it is stated explicitly.

---

## 1. Session Activity Verification (Critical)

**Configured sessions (from adbot.log):**  
- **Kartik:** 1 worker → 1 session: `919732692692.session`.  
- **Nobi:** 5 workers (then 2, then 1) → sessions: `919705421071`, `919732692692`, `919732711551`, `919749080844`, `919815616110`, `919756745291`, `919826134471`.  
- Stale journals at restart also mention these 5 session files (919705421071, 919732692692, 919732711551, 919749080844, 919815616110).

**Evidence from logs:**

| Session | Evidence of posting | Exit / dead | Silent gap? |
|---------|---------------------|------------|-------------|
| 919732692692 | Post failed ×2 (entity not found) | No dead log | Unknown (no cycle boundaries) |
| 919815616110 | Post failed ×1 (entity not found) | No | Unknown |
| 919705421071 | Post failed ×4 (entity/topic) | No | Unknown |
| 919732711551 | Post failed ×6 (entity) | No | Unknown |
| 919732692692 | Post failed ×4 more (entity) | No | Unknown |
| 919749080844 | Post failed ×2 | **Session dead** (entity -1002178340194) | No |
| 919756745291 | Post failed ×3 (TOPIC_CLOSED, reply_to, FloodWait 551s) | No | Unknown |
| 919826134471 | Post failed ×8 (TOPIC_CLOSED, entity, banned) | **Session dead** (banned) | No |
| 919784428049 | — | Moved to dead (invalid session) | N/A |

**Expected cycles / actual posts:**  
- **Cannot be computed.** No cycle boundaries or cycle_done timestamps in logs; no "starting cycle" / "delayed start" lines.  
- **Silent gaps:** Cannot verify "silent for longer than cycle_sec × 2" — no per-session cycle timestamps.  
- **Exit without stop/pause/ban:** Two sessions have explicit **Session dead** (919749080844, 919826134471). Others: no exit log in these files; if they exited, it may be logged only in worker process (not captured).

**Verdict:**  
- **Partial:** Multiple sessions **did** attempt posts (Post failed proves loop execution). Two sessions correctly logged as dead (entity error, banned).  
- **Not verifiable from logs:** Per-session cycle count, silent gaps, and whether every exit was logged (missing worker/session lifecycle logs).

---

## 2. Posting Smoothness & Freeze Detection

**Observable:** Only "Post failed" timestamps per session; no "starting cycle" or cycle boundaries.

- **919705421071, 919815616110:** Multiple Post failed in a short window (00:57–00:59), then no further entries in this file → consistent with one cycle of attempts then next activity not in this 1h43m window or in another worker.  
- **919732692692, 919732711551, 919749080844:** Bursts of Post failed within ~2 minutes → no evidence of long freeze; could be one cycle.  
- **919756745291:** Post failed at 01:14, 01:23, 01:29 → multiple cycles or retries; FloodWait 551s at 01:29 → expected pause, not a silent freeze.  
- **919826134471:** Many failures in ~1 minute then Session dead → single cycle then exit.

**Burst → freeze → burst:**  
- Not identifiable: no cycle start/end or heartbeat timestamps.  
- **worker_frozen:** No occurrences in logs; freeze detection cannot be validated from logs.

**Verdict:**  
- **Smooth/jittery/unstable:** Cannot categorize from current logs; need session-level "starting cycle" and cycle_done or heartbeat in a single log stream.

---

## 3. Time Alignment & Scheduling Accuracy

**Evidence:**  
- None. No "starting cycle (immediate)", "delayed start Xs (align next cycle)", or "starting cycle (immediate, late)" in any log.  
- No cycle start timestamps, no last_cycle_time or next_start in logs.

**Verdict:**  
- **Cannot verify** scheduling accuracy, preserve_cycle_time, or drift from the provided logs.

---

## 4. Starter Mode Validation

**Evidence:**  
- No log line states "Starter" or "Enterprise".  
- Post failed lines show **multiple sessions** posting to the **same** group (e.g. -1002060897480, -1001976519716, -1001896085289 appear for more than one session) → consistent with **all sessions posting to all groups** (Starter).  
- No evidence of group-to-session partitioning in the failure messages.

**Stagger / parallel:**  
- Cannot verify "60 min ÷ total_sessions" or stagger spacing — no session start timestamps.  
- Multiple sessions have Post failed in overlapping minutes → consistent with parallel execution, not sequential.

**Verdict:**  
- **Compatible with Starter:** Same groups targeted by multiple sessions; no log evidence of Enterprise-style partitioning.  
- **Not fully verifiable:** Stagger formula and strict parallel start times would require session start logs.

---

## 5. Enterprise Mode Validation

- **Nobi** (and Kartik) logs do not indicate Enterprise; same groups receive attempts from multiple sessions.  
- **No evidence** of single-session-per-group or load distribution tables in logs.

**Verdict:** Not applicable for this run; mode appears Starter.

---

## 6. STOP / Restart / Health Monitor Behavior

**Shutdown sequence:**  
- `Shutting down: stopping posting and disconnecting all sessions…` at 00:44:53, 00:45:28 (after 00:44:34 resume), 01:20:29, 01:26:05.  
- After each, a new "Starting AdBot system" and startup session check → clean process restart.  
- No "Post failed" or Session dead **after** a "Shutting down" line within the same run → no evidence of sessions continuing after STOP.

**Resume:**  
- 00:44:34: "Resume: started posting for Nobi" (and "Resume: 1 bot(s) loaded") → crash resume correctly restarted posting.  
- No "worker_frozen" or heartbeat timeout; no false restart or restart loop visible.

**Verdict:**  
- **STOP:** Clean shutdown log; no evidence of posting after STOP.  
- **Restart/health:** One justified resume; no evidence of preserve_cycle_time or burst after restart (no cycle timestamps).

---

## 7. Final Verdict (Evidence-Based)

### Working correctly

- **Controller Start/Stop:** Started/Stopped posting and worker counts (1, 2, 5 workers) logged.  
- **Post failure handling:** Per-session, per-target Post failed and Session dead logged; two Session dead (entity, banned) and one Moved to dead (invalid session).  
- **Shutdown:** "Shutting down: stopping posting and disconnecting all sessions…" present; no posts logged after it.  
- **Crash resume:** Resume restarted posting for Nobi; no duplicate or conflicting start.  
- **Starter-like behavior:** Multiple sessions posting to same groups; no log evidence of Enterprise partitioning.

### Partially working / not verifiable

- **Session activity:** Sessions did run (Post failed proves it); **cannot** verify expected vs actual cycles or silent gaps (no cycle logs).  
- **Scheduling:** **Cannot** verify alignment, preserve_cycle_time, or drift (no cycle start/delay logs).  
- **Smoothness/freeze:** **Cannot** classify smooth/jittery/unstable or validate heartbeat/frozen worker (no session lifecycle or heartbeat in logs).

### Broken or missing (observability)

- **Session lifecycle not in logs:** No "Session X starting cycle", "delayed start", "stopping (stop_event)", "PAUSED (FloodWait)" in any file → **logging/observability issue**: worker process logs are not in the same file as the controller.  
- **Heartbeat/freeze not visible:** No heartbeat or worker_frozen entries → either not triggered or not written to the provided logs (observability).  
- **Cycle boundaries not visible:** cycle_done and next_start are in-memory only; no table of "expected cycles vs actual" can be built from logs.

---

## 8. Recommendations (Minimal, Correctness & Observability Only)

1. **Worker logs in one place**  
   Ensure every session loop log ("starting cycle", "delayed start", "stopping", "PAUSED") and worker heartbeat/freeze is visible in a single audit log (e.g. controller forwards worker result-queue "log" entries to the same file, or workers attach to a shared log file/handler so adbot.log receives them). No change to scheduling or safety logic.

2. **Log cycle_done or cycle start in controller**  
   When applying cycle_done (or on cycle start), log one line per session per cycle (e.g. "cycle_start bot=X session=Y ts=Z" or "cycle_done bot=X session=Y") so expected vs actual cycles and silent gaps can be audited from logs alone.

3. **Log mode and cycle_sec at Start**  
   When logging "Started posting for bot X: N workers", add mode (Starter/Enterprise) and cycle_sec so audits can verify mode and scheduling without config access.

4. **Capture a true 24h run**  
   For a "24h continuous" audit, provide logs that span a full 24h without gaps; current adbot.log is ~1h43m.

5. **No architecture or safety changes**  
   No redesign of multiprocessing, no change to posting speed or safety gaps; only add/fix logging so the next forensic pass can fully answer session activity, scheduling, and freeze detection from logs.

---

**Summary:**  
From the **existing logs**, controller behavior (Start/Stop, shutdown, resume), post-failure handling, and Session dead handling look correct and are Starter-consistent. **Session-level scheduling, cycle counts, silent gaps, and freeze detection cannot be validated** because worker/session lifecycle and heartbeat logs are missing from the provided files. The main blocker for claiming "production-ready after 24h" on the basis of logs is **observability**: getting session cycle and worker heartbeat data into a single, auditable log stream.
