"""Central guard for Telethon .session files (SQLite).

Problem this solves: many tasks (posting workers, chatlist sync, health checks,
log-group setup, the web portal account manager, session validation, …) open the
same .session file. SQLite allows one writer, so overlapping opens surface as
"sqlite3.OperationalError: database is locked" with no hint of who holds the
file or how long to wait.

Every open now goes through this module, which registers WHO is using the file
(task label), WHEN it started and HOW LONG it usually takes. Anyone else trying
to open the same session gets a SessionBusyError with a human explanation and
an estimated wait — or waits politely for the lock (wait_timeout).

Lock files live in sessions/locks/<session filename>.lock (JSON), so the guard
works across processes (main API process + posting worker processes).

Stale locks are recovered automatically:
- holder pid no longer alive → lock is broken immediately
- task ran far past its expected duration → lock is broken (hard TTL)

Usage:
    client = guarded_client(path, task="chatlist sync", wait_timeout=15)
    await client.connect()      # acquires the lock (or raises SessionBusyError)
    ...
    await client.disconnect()   # releases the lock, retries the final SQLite
                                # save if the DB is momentarily locked

    async with open_session(path, task="health check") as client:
        ...                     # connect+disconnect handled, no leaks
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from telethon import TelegramClient

from . import config

logger = logging.getLogger(__name__)

LOCKS_DIR = config.SESSIONS_DIR / "locks"
LOCKS_DIR.mkdir(parents=True, exist_ok=True)

# Seconds to let Telethon's internal cleanup finish after disconnect before the
# lock is handed to the next task (reduces disconnect-save vs next-open races).
SETTLE_SEC = 0.3
# Hard TTL floor: a lock with a known expected duration is force-broken after
# max(3 * expected, STALE_HARD_MIN_SEC) even if the holder pid is still alive.
STALE_HARD_MIN_SEC = 600
# Retries for transient SQLite locks during connect/disconnect
_SQLITE_RETRIES = 3
_SQLITE_RETRY_DELAY = 1.0

# In-process "soft" holders that can be released on demand (e.g. the web portal
# account manager keeps sessions connected for 5 min idle — when posting or a
# health check needs the session, we disconnect the idle holder instead of
# failing). Keyed by lock key; value releases the holder (disconnects).
_soft_release: dict[str, Callable[[], Awaitable[None]]] = {}

# Lock tokens held by this process: lock key -> token (proof of ownership)
_held_tokens: dict[str, str] = {}


class SessionBusyError(RuntimeError):
    """Session file is in use by another task. str(e) is a user-facing message
    that says which task holds it, for how long, and when to retry."""

    def __init__(self, session_label: str, holder: dict):
        self.session_label = session_label
        self.holder = holder
        super().__init__(format_busy_message(session_label, holder))


def _fmt_dur(sec: float) -> str:
    sec = max(0, int(sec))
    if sec < 60:
        return f"{sec}s"
    m, s = divmod(sec, 60)
    if m < 60:
        return f"{m}m {s:02d}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


def format_busy_message(session_label: str, holder: dict) -> str:
    """Human message: who holds the session, since when, and how long to wait."""
    task = holder.get("task") or "another task"
    held = time.time() - float(holder.get("started_at") or time.time())
    expected = holder.get("expected_sec")
    held_txt = _fmt_dur(held)
    if not expected:
        return (
            f"Session {session_label} is busy: {task} (running for {held_txt}; "
            f"it releases the session when the task finishes or the AdBot is stopped)"
        )
    expected = float(expected)
    remaining = expected - held
    if remaining > 0:
        return (
            f"Session {session_label} is busy: {task} (running for {held_txt}, "
            f"usually takes ~{_fmt_dur(expected)} — try again in ~{_fmt_dur(remaining)})"
        )
    return (
        f"Session {session_label} is busy: {task} (running for {held_txt}, "
        f"longer than the usual ~{_fmt_dur(expected)} — try again in ~30s)"
    )


def _lock_key(session_path: Path | str) -> str:
    """Lock key = bare session filename (unique across session dirs)."""
    name = Path(str(session_path)).name
    if not name.endswith(".session"):
        name += ".session"
    return name


def _lock_path(key: str) -> Path:
    return LOCKS_DIR / (key + ".lock")


def _session_label(key: str) -> str:
    return key[: -len(".session")] if key.endswith(".session") else key


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True  # exists but owned by someone else
    except OSError:
        return False
    except Exception:
        return True  # unknown platform behaviour: assume alive (TTL still applies)


def _read_lock(key: str) -> dict | None:
    try:
        raw = _lock_path(key).read_text(encoding="utf-8")
        holder = json.loads(raw)
        return holder if isinstance(holder, dict) else None
    except (OSError, ValueError):
        return None


def _is_stale(holder: dict) -> bool:
    pid = int(holder.get("pid") or 0)
    if not _pid_alive(pid):
        return True
    expected = holder.get("expected_sec")
    if expected:
        held = time.time() - float(holder.get("started_at") or 0)
        if held > max(3 * float(expected), STALE_HARD_MIN_SEC):
            return True
    return False


def _break_lock(key: str, holder: dict) -> None:
    logger.warning(
        "[SessionGuard] Clearing stale lock on %s (task=%s pid=%s held %.0fs)",
        key, holder.get("task"), holder.get("pid"),
        time.time() - float(holder.get("started_at") or time.time()),
    )
    try:
        _lock_path(key).unlink()
    except OSError:
        pass


def current_holder(session_path: Path | str) -> dict | None:
    """Live (non-stale) holder of this session, or None. Clears stale locks."""
    key = _lock_key(session_path)
    holder = _read_lock(key)
    if holder is None:
        return None
    if _is_stale(holder):
        _break_lock(key, holder)
        return None
    return holder


def busy_message(session_path: Path | str) -> str | None:
    """User-facing busy message if the session is locked by a live task, else None."""
    holder = current_holder(session_path)
    if holder is None:
        return None
    return format_busy_message(_session_label(_lock_key(session_path)), holder)


def describe_locks() -> list[dict]:
    """All live locks with elapsed/eta info (for API/debugging)."""
    out: list[dict] = []
    try:
        entries = list(LOCKS_DIR.glob("*.lock"))
    except OSError:
        return out
    for p in entries:
        key = p.name[: -len(".lock")]
        holder = current_holder(key)
        if holder is None:
            continue
        held = time.time() - float(holder.get("started_at") or time.time())
        expected = holder.get("expected_sec")
        out.append({
            "session_file": key,
            "task": holder.get("task"),
            "pid": holder.get("pid"),
            "held_sec": int(held),
            "expected_sec": int(expected) if expected else None,
            "eta_sec": max(0, int(float(expected) - held)) if expected else None,
            "message": format_busy_message(_session_label(key), holder),
        })
    return out


def register_soft_release(session_path: Path | str, release_cb: Callable[[], Awaitable[None]]) -> None:
    """Mark this process's hold on the session as releasable-on-demand.
    release_cb must disconnect the holding client (which releases the lock)."""
    _soft_release[_lock_key(session_path)] = release_cb


def unregister_soft_release(session_path: Path | str) -> None:
    _soft_release.pop(_lock_key(session_path), None)


async def release_soft_holders(session_files: list[str]) -> None:
    """Force-release any in-process releasable holders (e.g. idle portal account
    manager connections) for these sessions. Called before starting posting."""
    for fn in session_files:
        cb = _soft_release.pop(_lock_key(fn), None)
        if cb is None:
            continue
        try:
            await cb()
            logger.info("[SessionGuard] Released idle holder of %s for a new task", _lock_key(fn))
        except Exception as e:
            logger.warning("[SessionGuard] Soft release of %s failed: %s", _lock_key(fn), e)


def force_clear_locks(session_files: list[str]) -> list[str]:
    """Unconditionally break any on-disk locks for these session files and return
    the keys that were cleared.

    This is for the AdBot *start* path only: the caller has already stopped and
    joined every worker for the bot, so any surviving 'posting' lock on one of the
    bot's own sessions is orphaned — a crashed/killed worker, or (worse) a recorded
    PID that the OS has since reused, which makes `_pid_alive` report it alive
    forever. Because posting locks carry no expected duration, `_is_stale` can never
    break such a lock on its own, so the session would stay permanently "busy" and
    the freshly spawned worker could never acquire it. Clearing here is safe *only*
    because no live worker of this bot holds the lock at this point."""
    cleared: list[str] = []
    for fn in session_files:
        key = _lock_key(fn)
        holder = _read_lock(key)
        if holder is None:
            continue
        logger.warning(
            "[SessionGuard] Force-clearing lock on %s at start (task=%s pid=%s held %.0fs) — "
            "no worker of this bot is running, so this lock is orphaned",
            key, holder.get("task"), holder.get("pid"),
            time.time() - float(holder.get("started_at") or time.time()),
        )
        try:
            _lock_path(key).unlink()
            cleared.append(key)
        except OSError:
            pass
        _held_tokens.pop(key, None)
    return cleared


async def _acquire(key: str, task: str, wait_timeout: float, expected_sec: Optional[float]) -> None:
    """Acquire the cross-process lock for `key` or raise SessionBusyError."""
    deadline = time.monotonic() + max(0.0, wait_timeout)
    token = uuid.uuid4().hex
    payload = None
    while True:
        payload = json.dumps({
            "task": task,
            "pid": os.getpid(),
            "token": token,
            "started_at": time.time(),
            "expected_sec": expected_sec,
        })
        try:
            fd = os.open(_lock_path(key), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            _held_tokens[key] = token
            logger.info("[SessionGuard] %s acquired by task=%r", key, task)
            return
        except FileExistsError:
            pass
        holder = _read_lock(key)
        if holder is None:
            await asyncio.sleep(0.1)  # holder mid-write or just released
            continue
        if _is_stale(holder):
            _break_lock(key, holder)
            continue
        # Same-process releasable holder (e.g. idle portal connection): kick it out.
        if int(holder.get("pid") or 0) == os.getpid():
            cb = _soft_release.pop(key, None)
            if cb is not None:
                try:
                    await cb()
                    logger.info("[SessionGuard] Released idle holder of %s for task=%r", key, task)
                except Exception as e:
                    logger.warning("[SessionGuard] Soft release of %s failed: %s", key, e)
                continue
        if time.monotonic() < deadline:
            await asyncio.sleep(1.0)
            continue
        raise SessionBusyError(_session_label(key), holder)


def _release(key: str) -> None:
    token = _held_tokens.pop(key, None)
    if token is None:
        return
    holder = _read_lock(key)
    if holder is not None and holder.get("token") not in (None, token):
        return  # someone else broke and re-took the lock; not ours to delete
    try:
        _lock_path(key).unlink()
    except OSError:
        pass
    logger.info("[SessionGuard] %s released", key)


class GuardedTelegramClient(TelegramClient):
    """TelegramClient that holds the cross-process session lock while connected.

    - connect() acquires the lock first (waiting up to guard_wait_timeout),
      raising SessionBusyError with a clear who/why/how-long message if busy.
    - disconnect() releases the lock and retries the final SQLite save if the
      database is momentarily locked, so the session file is left clean.
    """

    def __init__(self, session_path: Path | str, *args: Any,
                 guard_task: str = "session task",
                 guard_wait_timeout: float = 0.0,
                 guard_expected_sec: Optional[float] = 60.0,
                 **kwargs: Any):
        self._guard_key = _lock_key(session_path)
        self._guard_task = guard_task
        self._guard_wait_timeout = guard_wait_timeout
        self._guard_expected_sec = guard_expected_sec
        self._guard_held = False
        super().__init__(str(Path(str(session_path)).with_suffix("")), *args, **kwargs)
        # Give SQLite more patience than the 5s default, so short overlaps
        # (e.g. Telethon's own save-on-disconnect) wait instead of erroring.
        try:
            conn = getattr(self.session, "_conn", None)
            if conn is not None:
                conn.execute("PRAGMA busy_timeout=15000")
        except Exception:
            pass

    async def connect(self) -> None:
        if not self._guard_held:
            await _acquire(self._guard_key, self._guard_task,
                           self._guard_wait_timeout, self._guard_expected_sec)
            self._guard_held = True
        last_exc: Exception | None = None
        for attempt in range(_SQLITE_RETRIES):
            try:
                await super().connect()
                return
            except sqlite3.OperationalError as e:
                if "locked" not in str(e).lower():
                    self._guard_release()
                    raise
                last_exc = e
                logger.warning(
                    "[SessionGuard] %s: transient SQLite lock on connect (attempt %s/%s), retrying",
                    self._guard_key, attempt + 1, _SQLITE_RETRIES,
                )
                await asyncio.sleep(_SQLITE_RETRY_DELAY * (attempt + 1))
            except BaseException:
                # includes CancelledError (e.g. connect timeout) — never leak the lock
                self._guard_release()
                raise
        self._guard_release()
        raise last_exc if last_exc else RuntimeError("connect failed")

    def _guard_release(self) -> None:
        if self._guard_held:
            self._guard_held = False
            _release(self._guard_key)
            unregister_soft_release(self._guard_key)

    def disconnect(self):
        base = None
        try:
            base = super().disconnect()
        except Exception as e:
            logger.warning("[SessionGuard] %s disconnect error: %s", self._guard_key, e)
        if inspect.isawaitable(base):
            return self._guarded_disconnect(base)
        # Sync path (loop not running) or sync failure: release immediately.
        self._guard_release()
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return base  # truly sync context; caller won't await
        return self._noop()  # caller will await → give it something awaitable

    @staticmethod
    async def _noop() -> None:
        return None

    async def _guarded_disconnect(self, base) -> None:
        try:
            await base
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower():
                # Final session save hit a transient lock; retry closing so the
                # SQLite file is actually committed and released.
                logger.warning(
                    "[SessionGuard] %s: SQLite locked during disconnect, retrying final save",
                    self._guard_key,
                )
                for _ in range(_SQLITE_RETRIES):
                    await asyncio.sleep(_SQLITE_RETRY_DELAY)
                    try:
                        self.session.close()
                        break
                    except sqlite3.OperationalError:
                        continue
                    except Exception:
                        break
            else:
                logger.warning("[SessionGuard] %s disconnect error: %s", self._guard_key, e)
        except Exception as e:
            logger.warning("[SessionGuard] %s disconnect error: %s", self._guard_key, e)
        finally:
            self._guard_release()
            await asyncio.sleep(SETTLE_SEC)


def guarded_client(session_path: Path | str, task: str, *,
                   wait_timeout: float = 0.0,
                   expected_sec: Optional[float] = 60.0,
                   **client_kwargs: Any) -> GuardedTelegramClient:
    """Create a TelegramClient for a user .session file that registers itself in
    the session guard. Drop-in replacement for TelegramClient(...) at call sites
    that already connect/disconnect correctly."""
    client_kwargs.setdefault("proxy", config.PROXY)
    return GuardedTelegramClient(
        session_path, config.API_ID, config.API_HASH,
        guard_task=task, guard_wait_timeout=wait_timeout,
        guard_expected_sec=expected_sec,
        **client_kwargs,
    )


@asynccontextmanager
async def open_session(session_path: Path | str, task: str, *,
                       wait_timeout: float = 0.0,
                       expected_sec: Optional[float] = 60.0,
                       **client_kwargs: Any):
    """Connect to a session under the guard and always disconnect (no leaks).
    Yields the connected client. Raises SessionBusyError if the session is held
    by another task and wait_timeout expires."""
    client = guarded_client(session_path, task, wait_timeout=wait_timeout,
                            expected_sec=expected_sec, **client_kwargs)
    await client.connect()
    try:
        yield client
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
