"""
Multiprocessing worker processes for posting. Each worker runs its own asyncio event loop
and handles exactly one Telegram session (SESSIONS_PER_WORKER=1). Isolation: one worker
crash or FloodWait does not affect other workers; session start times are reliable.
"""
import asyncio
import logging
import multiprocessing
import os
import time
from pathlib import Path
from typing import Any

from . import config
from .user_config import get_plan_mode

# Must import after config so worker process has correct paths
from .users import (
    ENTERPRISE_STAGGER_SEC,
    STAGGER_WINDOW_SEC,
    STAGGER_MAX_SEC,
    _async_session_loop,
    _starter_phase_offset,
    _target_key_for_skip,
)

SESSIONS_PER_WORKER = 1

logger = logging.getLogger(__name__)


class WorkerLogFilter(logging.Filter):
    """Prefix log records with worker id."""
    def __init__(self, worker_id: int) -> None:
        super().__init__()
        self.worker_id = worker_id

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = f"[worker-{self.worker_id}] " + (record.getMessage() if record.args else str(record.msg))
            record.args = ()
        except Exception:
            record.msg = f"[worker-{self.worker_id}] " + str(record.msg)
            record.args = ()
        return True


def worker_entry(
    bot_token: str,
    worker_id: int,
    session_chunk: list[dict],
    config_snapshot: dict,
    command_queue: multiprocessing.Queue,
    result_queue: multiprocessing.Queue,
) -> None:
    """
    Sync entry point for worker process. Runs asyncio event loop with 1 session.
    Called via multiprocessing.Process(target=worker_entry, args=(...)).
    """
    # Patch Telethon to skip unknown TL constructors so recv_loop does not crash (each worker is a fresh process)
    from code.telethon_compat import apply_telethon_unknown_type_patch
    apply_telethon_unknown_type_patch()
    # Ensure spawn context: fresh interpreter, no shared state
    asyncio.run(worker_main_async(bot_token, worker_id, session_chunk, config_snapshot, command_queue, result_queue))


async def worker_main_async(
    bot_token: str,
    worker_id: int,
    session_chunk: list[dict],
    config_snapshot: dict,
    command_queue: multiprocessing.Queue,
    result_queue: multiprocessing.Queue,
) -> None:
    """
    Worker's asyncio main: setup logging, build get_config/report_* callbacks.
    Phase 1: Wait for START from controller (no Telethon connect yet; avoids connection storms).
    Phase 2: On START, apply stagger and run 1 session loop task. On STOP: set shutting_down,
    break out cleanly, disconnect all clients, then exit. No shared storage writes.
    """
    # Per-worker logging prefix
    for h in logging.root.handlers:
        h.addFilter(WorkerLogFilter(worker_id))

    total_sessions = config_snapshot.get("total_sessions") or max(1, len(session_chunk))
    start_event = asyncio.Event()
    stop_event = asyncio.Event()
    shutting_down = False

    # Local state: last_cycle_time (worker reports to controller; merge into get_config for next cycle)
    local_last_cycle: dict[str, float] = {}
    # Config patches from controller (e.g. session_pause_until after FloodWait clear) so workers reintegrate without restart
    local_config_patch: dict = {}
    ban_snapshot = dict(config_snapshot.get("ban_error_count_by_session") or {})
    local_ban_set: set[tuple[str, str]] = set()

    def get_config() -> dict:
        merged = dict(config_snapshot)
        merged["last_cycle_time"] = {**(config_snapshot.get("last_cycle_time") or {}), **local_last_cycle}
        if local_config_patch:
            for k, v in local_config_patch.items():
                if v is not None:
                    merged[k] = v
        return merged

    def report_cycle_done(session_file: str, timestamp: float, **kwargs: object) -> None:
        """kwargs can include posts_success, posts_failed for controller to update stats."""
        local_last_cycle[session_file] = timestamp
        result_queue.put({
            "type": "cycle_done",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "timestamp": timestamp,
            **kwargs,
        })

    def report_cycle_progress(session_file: str, cycle_ts: float, posted_keys: list) -> None:
        """Mid-cycle checkpoint: which group keys this session already posted in the cycle that
        started at cycle_ts. Controller persists it (stats file) so a crash/restart mid-cycle can
        resume the same cycle from where it left off instead of re-posting from the first group."""
        result_queue.put({
            "type": "cycle_progress",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "cycle_ts": float(cycle_ts),
            "posted": list(posted_keys),
        })

    def report_cycle_failed(session_file: str) -> None:
        """Session attempted zero posts this cycle (frozen or no groups assigned). Controller will exclude from next assignment. Only called when attempted_count==0; zero success with attempted>0 does not exclude."""
        result_queue.put({
            "type": "cycle_failed",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
        })

    def report_session_died(session_file: str, reason: str) -> None:
        result_queue.put({
            "type": "session_died",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "reason": reason,
        })

    def report_expired() -> None:
        result_queue.put({"type": "expired", "bot_token": bot_token, "worker_id": worker_id})

    def get_ban_skip(session_file: str, g: dict) -> bool:
        """Return True if this target should be skipped for this session based on ban_error_count_by_session.
        Entries are considered active only within BAN_ERROR_TTL_SEC and use the same structured format as controller."""
        from .users import BAN_ERROR_TTL_SEC, _target_key_for_skip  # local import to avoid cycles at module import
        key = _target_key_for_skip(g)
        if (session_file, key) in local_ban_set:
            return True
        sess_map = ban_snapshot.get(session_file) or {}
        entry = sess_map.get(key)
        now = time.time()
        if isinstance(entry, dict):
            ts = float(entry.get("ts") or 0.0)
            if ts and (now - ts) > BAN_ERROR_TTL_SEC:
                return False
            return (entry.get("c") or 0) >= 1
        # Legacy plain int entries are treated as expired so they do not blacklist forever.
        return False

    def report_ban_error(session_file: str, chat_id: int, topic_id: int | None) -> None:
        key = f"{chat_id}#{topic_id}" if topic_id is not None else str(chat_id)
        local_ban_set.add((session_file, key))
        result_queue.put({
            "type": "ban_error",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "chat_id": chat_id,
            "topic_id": topic_id,
        })

    def report_permanent_exclusion(session_file: str, group_key: str, reason: str) -> None:
        """Enterprise: persist permanently failed group so controller can add to excluded_groups."""
        result_queue.put({
            "type": "permanent_exclusion",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "group_key": group_key,
            "reason": reason,
        })

    def report_alert(kind: str, message: str) -> None:
        result_queue.put({
            "type": "admin_alert",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "kind": kind,
            "message": message,
        })

    def report_log(
        bt: str,
        msg: str,
        parse_mode: str | None = None,
        buttons: list[tuple[str, str]] | None = None,
        entity_spec: list[tuple] | None = None,
    ) -> None:
        """entity_spec: plain (kind, offset, length, key) tuples only (pickle-safe across the
        worker process boundary) — converted to real telegram.MessageEntity objects on the
        controller (main) process side; never construct PTB objects here."""
        payload = {
            "type": "log",
            "bot_token": bt,
            "worker_id": worker_id,
            "message": msg,
            "parse_mode": parse_mode,
        }
        if buttons is not None:
            payload["buttons"] = buttons
        if entity_spec is not None:
            payload["entity_spec"] = entity_spec
        result_queue.put(payload)

    def report_user_log(message: str) -> None:
        """Send a line to the user's log file only (no Telegram log group). Used for [Scheduler] diagnostics."""
        result_queue.put({
            "type": "user_log",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "message": message,
        })

    def report_post_attempt(
        session_file: str,
        group_id: int,
        topic_id: int | None,
        success: bool,
        error_message: str,
        group_name: str = "",
        wait_seconds: int | None = None,
    ) -> None:
        """Send structured post attempt for operator-readable user log: account, group_name, group_id, result, flood wait."""
        payload = {
            "type": "post_attempt",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "group_id": group_id,
            "topic_id": topic_id,
            "success": success,
            "error_message": error_message or "",
            "timestamp": time.time(),
            "group_name": group_name or "",
        }
        if wait_seconds is not None:
            payload["wait_seconds"] = int(wait_seconds)
        result_queue.put(payload)

    def report_scheduler_health(session_file: str, next_run: float, delay_sec: float) -> None:
        """Report scheduler health: next_run timestamp, delay_sec (positive = late). Controller may restart if delay exceeds threshold."""
        result_queue.put({
            "type": "scheduler_health",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "next_run": next_run,
            "delay_sec": delay_sec,
            "worker_alive": True,
        })

    def report_dm_alert(session_file: str, from_name: str, user_id: int, message_text: str) -> None:
        """Notify admin of new DM (private message to ADMIN_USER_ID via PTB); not sent to log group."""
        result_queue.put({
            "type": "dm_alert",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "from_name": from_name,
            "user_id": user_id,
            "message_text": message_text,
        })

    def report_audit_log(session_file: str, event: str, **kwargs: object) -> None:
        """Send session lifecycle event to controller so it is written to adbot.log (forensic audit)."""
        result_queue.put({
            "type": "audit_log",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "event": event,
            "timestamp": time.time(),
            **kwargs,
        })

    def report_heartbeat() -> None:
        result_queue.put({
            "type": "heartbeat",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "timestamp": time.time(),
        })

    def report_session_paused(session_file: str, unblock_time: float, wait_seconds: int) -> None:
        """Persist FloodWait pause so controller stores session_pause_until and snapshot survives restart."""
        result_queue.put({
            "type": "session_paused",
            "bot_token": bot_token,
            "worker_id": worker_id,
            "session_file": session_file,
            "unblock_time": unblock_time,
            "wait_seconds": wait_seconds,
        })

    async def command_listener() -> None:
        nonlocal shutting_down
        loop = asyncio.get_event_loop()
        while not shutting_down:
            try:
                cmd = await asyncio.wait_for(
                    loop.run_in_executor(None, command_queue.get),
                    timeout=10.0,
                )
            except asyncio.TimeoutError:
                continue
            if isinstance(cmd, dict):
                if cmd.get("cmd") == "stop":
                    shutting_down = True
                    stop_event.set()
                    return
                if cmd.get("cmd") == "start":
                    logger.info("[worker-%s] received START", worker_id)
                    start_event.set()
                    # Keep listening for STOP
                if cmd.get("cmd") == "config_patch":
                    patch = cmd.get("patch") or {}
                    if patch:
                        local_config_patch.update(patch)

    # Phase 1: Start command listener, then wait for START (or STOP before start). No Telethon clients connected yet.
    # Python 3.11+: asyncio.wait() requires Tasks/Futures, not raw coroutines.
    listener = asyncio.create_task(command_listener())
    start_task = asyncio.create_task(start_event.wait())
    stop_task = asyncio.create_task(stop_event.wait())
    try:
        done, pending = await asyncio.wait(
            [start_task, stop_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
    finally:
        start_task.cancel()
        stop_task.cancel()
        try:
            await start_task
        except asyncio.CancelledError:
            pass
        try:
            await stop_task
        except asyncio.CancelledError:
            pass
    # Rule 3: Only exit without running if we never got START. If we got START (even if STOP arrived too),
    # run session tasks at least once so they enter the loop, log "stopping (stop_event)", and exit cleanly.
    if stop_event.is_set() and not start_event.is_set():
        listener.cancel()
        try:
            await listener
        except asyncio.CancelledError:
            pass
        return  # Stopped before start; exit cleanly, no connections

    # Phase 2: START received. Create session loop tasks (stagger applied inside each loop).
    logger.info("[worker-%s] session_chunk=%s", worker_id, [s.get("file") or "(no file)" for s in session_chunk])
    tasks: list[asyncio.Task] = []
    for local_ord, session_info in enumerate(session_chunk):
        session_file = session_info.get("file") or ""
        if not session_file:
            logger.warning("[worker-%s] skipping session with empty file: dict keys=%s", worker_id, list(session_info.keys()))
            continue
        global_ordinal = worker_id * SESSIONS_PER_WORKER + local_ord
        mode = get_plan_mode(config_snapshot)
        if mode == "Enterprise":
            # First half start immediately, second half after 5 min. Each runs on its own time.
            half = max(1, total_sessions) // 2
            stagger_sec = 0.0 if global_ordinal < half else float(ENTERPRISE_STAGGER_SEC)
        else:
            # Starter: even-spread phase = ordinal * (cycle/N). Matches the per-cycle anchor phase in
            # _async_session_loop so cycle 1 is already correctly spaced and never collides.
            _cycle_sec = max(config.MIN_CYCLE_SEC, int(config_snapshot.get("cycle", 3600)))
            stagger_sec = _starter_phase_offset(global_ordinal, total_sessions, _cycle_sec)
        t = asyncio.create_task(
            _async_session_loop(
                bot_token,
                global_ordinal,
                total_sessions,
                session_file,
                stagger_sec,
                stop_event,
                get_config=get_config,
                report_cycle_done=report_cycle_done,
                report_cycle_progress=report_cycle_progress,
                report_cycle_failed=report_cycle_failed,
                report_session_died=report_session_died,
                report_expired=report_expired,
                get_ban_skip=get_ban_skip,
                report_ban_error=report_ban_error,
                report_alert=report_alert,
                report_log=report_log,
                report_user_log=report_user_log,
                report_post_attempt=report_post_attempt,
                report_scheduler_health=report_scheduler_health,
                report_dm_alert=report_dm_alert,
                report_audit_log=report_audit_log,
                report_heartbeat=report_heartbeat,
                report_session_paused=report_session_paused,
                report_permanent_exclusion=report_permanent_exclusion,
            ),
        )
        tasks.append(t)

    try:
        await asyncio.gather(listener, *tasks)
    except asyncio.CancelledError:
        shutting_down = True
        stop_event.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def chunk_sessions(sessions: list[dict], per_worker: int = SESSIONS_PER_WORKER) -> list[list[dict]]:
    """Split session list into chunks of at most per_worker (1 session per worker). 10 sessions -> 10 workers."""
    chunks: list[list[dict]] = []
    for i in range(0, len(sessions), per_worker):
        chunks.append(sessions[i : i + per_worker])
    return chunks
