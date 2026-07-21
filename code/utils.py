"""Per-user JSON storage (data/user/, data/pool.json, data/index.json); session validation."""
import asyncio
import json
import logging
import os
import random
import shutil
import string
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Coroutine

try:
    from filelock import FileLock
except ImportError:
    FileLock = None  # type: ignore[misc, assignment]

# Set by users module: True if session is currently in use by a posting worker (do not open for validate/get_session_user)
_session_active_callback: Callable[[Path], bool] | None = None


def register_session_active_check(callback: Callable[[Path], bool]) -> None:
    """Register callback to check if a session path is currently in use by posting. Called from users."""
    global _session_active_callback
    _session_active_callback = callback

try:
    import orjson
    def _loads(raw: bytes) -> Any:
        return orjson.loads(raw)
    def _dumps(obj: dict[str, Any]) -> bytes:
        return orjson.dumps(obj, option=orjson.OPT_INDENT_2)
except ModuleNotFoundError:
    def _loads(raw: bytes) -> Any:
        return json.loads(raw.decode("utf-8"))
    def _dumps(obj: dict[str, Any]) -> bytes:
        return json.dumps(obj, indent=2).encode("utf-8")


# --- Per-user storage primitives ---

def name_to_filename(name: str) -> str:
    """Sanitize admin-provided name to a safe filename (lowercase, alphanumeric + underscore, max 64 chars)."""
    safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in (name or "").strip())[:64]
    return safe.lower() or "unknown"


def _default_pool() -> dict[str, Any]:
    """Return the default pool structure."""
    return {"free_sessions": [], "dead_sessions": [], "frozen_sessions": [], "limited_sessions": [], "unauth_sessions": [], "admin_alerts": []}


@contextmanager
def _file_lock(path: Path):
    """Cross-process lock for the given file path. Serializes writers; use for save_* to prevent lost updates."""
    lock_path = path.parent / (path.name + ".lock")
    if FileLock is None:
        yield
        return
    lock = FileLock(str(lock_path))
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def get_name_by_token(bot_token: str) -> str | None:
    """Resolve bot_token to display name from user config. Returns None if not found."""
    data = load_adbot()
    return (data.get("bots") or {}).get(bot_token, {}).get("name")


def get_token_by_name(name: str) -> str | None:
    """Resolve display name or safe filename to bot_token. Returns None if not found."""
    if not (name or "").strip():
        return None
    safe = name_to_filename((name or "").strip())
    data = load_adbot()
    for token, cfg in (data.get("bots") or {}).items():
        if not token:
            continue
        cfg_name = (cfg.get("name") or "").strip()
        if name_to_filename(cfg_name) == safe or cfg_name == (name or "").strip():
            return token
    return None


def _load_user_data_raw(safe: str) -> dict[str, Any] | None:
    """Load data/user/<safe>.json without migration. Used by save_user_data for merge-write."""
    path = config.DATA_USER_DIR / f"{safe}.json"
    if not path.exists():
        return None
    try:
        raw = path.read_bytes()
        data = _loads(raw)
        return data if isinstance(data, dict) else None
    except Exception as e:
        logger.warning("Could not load user data raw %s: %s", safe, e)
        return None


def load_user_data(name: str) -> dict[str, Any] | None:
    """Read data/user/<name>.json. Returns bot dict or None. Migrates to new structure (plan, history, stats, transactions) in-memory for compatibility."""
    safe = name_to_filename(name)
    path = config.DATA_USER_DIR / f"{safe}.json"
    if not path.exists():
        return None
    try:
        raw = path.read_bytes()
        data = _loads(raw)
        if not isinstance(data, dict):
            return None
        from .user_config import migrate_user_config, ensure_legacy_compatibility
        data = migrate_user_config(data)
        ensure_legacy_compatibility(data)
        return data
    except Exception as e:
        logger.warning("Could not load user data %s: %s", safe, e)
        return None


def save_user_data(name: str, bot_dict: dict[str, Any]) -> None:
    """
    Merge-write to data/user/<name>.json. Cross-process lock serializes writers; atomic write
    (temp + rename) prevents partial write on crash.
    """
    from .user_config import merge_for_save, migrate_user_config, ensure_legacy_compatibility
    safe = name_to_filename(name)
    path = config.DATA_USER_DIR / f"{safe}.json"
    config.DATA_USER_DIR.mkdir(parents=True, exist_ok=True)
    with _file_lock(path):
        existing = _load_user_data_raw(safe) or {}
        result = merge_for_save(existing, bot_dict)
        result = migrate_user_config(result)
        ensure_legacy_compatibility(result)
        # Stats and rolling event windows live in data/stats/<name>.json only; keep config small
        result.pop("stats", None)
        result.pop("session_recent_attempts", None)
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_bytes(_dumps(result))
        try:
            os.replace(tmp, path)
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            raise


def load_stats(name: str) -> dict[str, Any] | None:
    """Read data/stats/<name>.json. Returns None if missing (caller can use default)."""
    safe = name_to_filename(name)
    path = config.DATA_STATS_DIR / f"{safe}.json"
    if not path.exists():
        return None
    try:
        raw = path.read_bytes()
        data = _loads(raw)
        return data if isinstance(data, dict) else None
    except Exception as e:
        logger.warning("Could not load stats %s: %s", safe, e)
        return None


def save_stats(name: str, data: dict[str, Any]) -> None:
    """Write data/stats/<name>.json. Atomic write. Stats are counts only (no event list)."""
    safe = name_to_filename(name)
    path = config.DATA_STATS_DIR / f"{safe}.json"
    config.DATA_STATS_DIR.mkdir(parents=True, exist_ok=True)
    with _file_lock(path):
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_bytes(_dumps(data))
        try:
            os.replace(tmp, path)
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            raise


def load_pool() -> dict[str, Any]:
    """Read data/pool.json. Returns default if missing."""
    path = config.DATA_POOL_FILE
    if not path.exists():
        return _default_pool()
    try:
        raw = path.read_bytes()
        data = _loads(raw)
        if not isinstance(data, dict):
            return _default_pool()
        data.setdefault("free_sessions", [])
        data.setdefault("dead_sessions", [])
        data.setdefault("frozen_sessions", [])
        data.setdefault("limited_sessions", [])
        data.setdefault("unauth_sessions", [])
        data.setdefault("admin_alerts", [])
        return data
    except Exception as e:
        logger.warning("Could not load pool: %s", e)
        return _default_pool()


def save_pool(data: dict[str, Any]) -> None:
    """Write data/pool.json. Cross-process lock + atomic write."""
    data.setdefault("free_sessions", [])
    data.setdefault("dead_sessions", [])
    data.setdefault("frozen_sessions", [])
    data.setdefault("limited_sessions", [])
    data.setdefault("unauth_sessions", [])
    data.setdefault("admin_alerts", [])
    path = config.DATA_POOL_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with _file_lock(path):
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_bytes(_dumps(data))
        try:
            os.replace(tmp, path)
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            raise


# ── Session-pool transaction lock ──────────────────────────────────────────────
# Serializes every consumer that claims/returns sessions in data/pool.json so the
# SAME account is never bound to two bots. The bot-creation worker holds this for
# the whole build (its in-memory pool snapshot must stay consistent); replacement
# and runtime session-death swaps take it only for their brief claim/return steps.
#
# IMPORTANT: this lock can be held for the full duration of a bot build. Never
# acquire it directly on the asyncio event loop — call the helpers below via
# asyncio.to_thread() from async code so the loop is not frozen while waiting.
SESSION_POOL_LOCK = threading.RLock()

_POOL_BUCKETS = ("free_sessions", "dead_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions")


def claim_free_session() -> str | None:
    """Atomically pop and persist the next free session, returning its filename (or
    None if the pool is empty). The claim is committed to disk before returning, so
    no concurrent consumer can grab the same session. Blocking — call via
    asyncio.to_thread() from async code."""
    with SESSION_POOL_LOCK:
        pool = load_pool()
        free = pool.get("free_sessions", [])
        if not free:
            return None
        fn = free[0]
        pool["free_sessions"] = [x for x in free if x != fn]
        save_pool(pool)
        return fn


def move_session_to_bucket(fn: str, dest_bucket: str) -> None:
    """Atomically move a session filename to dest_bucket (e.g. 'dead_sessions',
    'frozen_sessions'), removing it from every other pool bucket first. Re-reads the
    pool fresh under the lock so it never clobbers a concurrent change. Blocking —
    call via asyncio.to_thread() from async code."""
    if not fn:
        return
    with SESSION_POOL_LOCK:
        pool = load_pool()
        for b in _POOL_BUCKETS:
            pool[b] = [x for x in pool.get(b, []) if x != fn]
        pool.setdefault(dest_bucket, [])
        if fn not in pool[dest_bucket]:
            pool[dest_bucket].append(fn)
        save_pool(pool)


async def delete_bot_from_storage(bot_token: str, move_to: str) -> bool:
    """Full bot deletion: return admin-pool sessions to free/dead, delete user-uploaded sessions,
    remove custom group file, clean pool references, delete user data/log/stats.
    move_to is 'free' or 'dead'. When 'free', validates admin-pool sessions before returning.
    User-uploaded sessions (users/...) are always deleted (they were provided by this user).
    Returns True if bot was found."""
    user_name = get_name_by_token(bot_token)
    if not user_name:
        return False
    cfg = load_user_data(user_name)
    if not cfg:
        return False
    safe = name_to_filename(user_name)

    pool = load_pool()
    pool.setdefault("free_sessions", [])
    pool.setdefault("dead_sessions", [])

    # --- 1. Handle sessions ---
    for s in cfg.get("sessions", []):
        fn = s.get("file")
        if not fn:
            continue
        src = config.resolve_session_path(fn)
        is_user_uploaded = fn.startswith("users/")

        if is_user_uploaded:
            # User-provided session: delete the file entirely (not admin's pool session)
            if src.is_file():
                try:
                    src.unlink()
                    logger.info("[Delete] Removed user-uploaded session file: %s", fn)
                except OSError as err:
                    logger.warning("[Delete] Could not delete user session %s: %s", fn, err)
            # Also remove journal file if exists
            journal = src.parent / (src.name + "-journal")
            if journal.is_file():
                try:
                    journal.unlink()
                except OSError:
                    pass
            # Clean up empty user directory
            if src.parent.is_dir() and not any(src.parent.iterdir()):
                try:
                    src.parent.rmdir()
                    logger.info("[Delete] Removed empty user session dir: %s", src.parent)
                except OSError:
                    pass
        else:
            # Admin-pool session: return to free or dead pool
            if move_to == "free":
                if src.is_file():
                    ok = await validate_session(src)
                    if ok:
                        if fn not in pool["free_sessions"]:
                            pool["free_sessions"].append(fn)
                        logger.info("[Delete] Returned session to free pool: %s", fn)
                    else:
                        if fn not in pool["dead_sessions"]:
                            pool["dead_sessions"].append(fn)
                        dest = config.SESSIONS_DEAD / Path(fn).name
                        try:
                            shutil.move(str(src), str(dest))
                        except OSError as err:
                            logger.warning("[Delete] Move session to dead failed %s: %s", fn, err)
                else:
                    if fn not in pool["dead_sessions"]:
                        pool["dead_sessions"].append(fn)
            else:
                if fn not in pool["dead_sessions"]:
                    pool["dead_sessions"].append(fn)
                if src.is_file():
                    dest = config.SESSIONS_DEAD / Path(fn).name
                    try:
                        shutil.move(str(src), str(dest))
                    except OSError as err:
                        logger.warning("[Delete] Move session to dead failed %s: %s", fn, err)

    # --- 2. Clean session references from other pool buckets ---
    session_files = {s.get("file") for s in cfg.get("sessions", []) if s.get("file")}
    for bucket in ("frozen_sessions", "limited_sessions", "unauth_sessions", "excluded_sessions"):
        if bucket in pool:
            pool[bucket] = [f for f in pool[bucket] if f not in session_files]

    save_pool(pool)

    # --- 3. Delete custom group file (chatlist) ---
    try:
        from .chatlist import custom_group_filename
        custom_gf = custom_group_filename(user_name)
        custom_gf_path = config.GROUPS_DIR / custom_gf
        if custom_gf_path.is_file():
            custom_gf_path.unlink()
            logger.info("[Delete] Removed custom group file: %s", custom_gf_path)
        # Clean up empty "user groups" dir
        if custom_gf_path.parent.is_dir() and not any(custom_gf_path.parent.iterdir()):
            try:
                custom_gf_path.parent.rmdir()
            except OSError:
                pass
    except Exception as e:
        logger.warning("[Delete] Could not clean custom group file for %s: %s", user_name, e)

    # --- 4. Delete user data file ---
    user_file = config.DATA_USER_DIR / f"{safe}.json"
    if user_file.exists():
        try:
            user_file.unlink()
            logger.info("[Delete] Removed user data: %s", user_file)
        except OSError:
            pass

    # --- 5. Delete log file ---
    log_file = config.DATA_LOGS_DIR / f"{safe}.log"
    if log_file.exists():
        try:
            log_file.unlink()
            logger.info("[Delete] Removed log file: %s", log_file)
        except OSError:
            pass

    # --- 6. Delete stats file ---
    stats_file = config.DATA_STATS_DIR / f"{safe}.json"
    if stats_file.exists():
        try:
            stats_file.unlink()
            logger.info("[Delete] Removed stats file: %s", stats_file)
        except OSError:
            pass

    # --- 6b. Delete name-scoped stores (portal bell + DM inbox) so they can't
    #     resurrect if a bot with the same name is created later. ---
    purge_name_scoped_stores(user_name)

    # --- 7. Release the pooled bot token (if this bot came from the pool) ---
    # The pooled token *is* the bot token, so free it directly — the delete path
    # doesn't always know the originating order id, and a stale "assigned" entry
    # would otherwise strand the token forever.
    try:
        from .shop.token_pool import release_by_token
        if release_by_token(bot_token):
            logger.info("[Delete] Released pooled bot token back to available")
    except Exception as e:
        logger.warning("[Delete] Could not release pooled token: %s", e)

    logger.info("[Delete] Bot '%s' fully deleted (sessions → %s pool)", user_name, move_to)
    return True


from telethon import TelegramClient
from telethon import errors as tl_errors
from telethon.tl.functions.channels import (
    CreateChannelRequest,
    EditAdminRequest,
    InviteToChannelRequest,
    JoinChannelRequest,
    UpdateUsernameRequest,
)
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.tl.types import ChatAdminRights, InputChannel

from . import config
from .rpc_errors import SESSION_DEAD_ERRORS, with_retry, AdBotErrorHandler

logger = logging.getLogger(__name__)

# FloodWait retry: max tries, exponential backoff multiplier
FLOODWAIT_MAX_TRIES = 3
FLOODWAIT_BACKOFF = 1.5

# Session-fatal errors: from rpc_errors (single source of truth)
_SESSION_DEAD_ERRORS = SESSION_DEAD_ERRORS

async def with_floodwait_retry(
    coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    max_tries: int = FLOODWAIT_MAX_TRIES,
    backoff: float = FLOODWAIT_BACKOFF,
) -> Any:
    """FloodWait handling: delegates to rpc_errors.with_retry (retry + session-dead re-raise)."""
    return await with_retry(coro_factory, max_tries=max_tries, backoff=backoff)


async def get_session_user(session_path: Path) -> tuple[int, str] | None:
    """Connect with session, return (user_id, first_name) or None on failure."""
    from .session_guard import open_session, busy_message
    session_path = session_path.resolve()
    if not session_path.is_file():
        return None
    if _session_active_callback and _session_active_callback(session_path):
        return None
    busy = busy_message(session_path)
    if busy:
        logger.info("get_session_user skipped: %s", busy)
        return None
    try:
        async with open_session(session_path, "reading account info", wait_timeout=5, expected_sec=20) as tc:
            if not await tc.is_user_authorized():
                return None
            me = await tc.get_me()
            return (me.id, (me.first_name or "").strip() or str(me.id))
    except Exception as e:
        logger.warning("get_session_user failed for %s: %s", session_path.name, e)
        return None


async def join_chat_by_link(client: TelegramClient, link: str | int) -> None:
    """Join a chat by t.me link, username, or legacy id. Uses JoinChannelRequest for public, ImportChatInviteRequest for invite hash."""
    if link is None:
        raise ValueError("Empty link")
    link = str(link).strip()
    if not link:
        raise ValueError("Empty link")
    low = link.lower()
    if "joinchat/" in low:
        hash_part = link.split("joinchat/")[-1].split("?")[0].strip()
        if len(hash_part) >= 10 and not hash_part.lstrip("-").isdigit():
            await client(ImportChatInviteRequest(hash_part))
            return
    elif ("/+" in low or link.lstrip().startswith("+")) and "t.me" in low:
        hash_part = (link.split("+")[-1].split("?")[0] or link.split("/")[-1]).strip()
        if len(hash_part) >= 10 and not hash_part.lstrip("-").isdigit():
            await client(ImportChatInviteRequest(hash_part))
            return
    # Public channel or legacy id: https://t.me/username, @username, or -100...
    ent = await client.get_input_entity(link)
    await client(JoinChannelRequest(ent))


async def validate_bot_token(token: str) -> tuple[bool, str]:
    """Validate bot token by starting temp client. Returns (ok, username_or_error).
    Uses a unique session name per token so different tokens always get fresh validation (no cached bot)."""
    import re
    token = (token or "").strip()
    if not token or not re.fullmatch(r"[0-9]+:[a-zA-Z0-9_-]+", token):
        return False, "Invalid token format."
    # Unique session per token so we never reuse a previous bot's session
    session_name = "_tmp_bot_" + str(abs(hash(token)))[:12]
    tc = TelegramClient(
        session_name, config.API_ID, config.API_HASH, proxy=config.PROXY
    )
    try:
        await tc.start(bot_token=token)
        me = await tc.get_me()
        username = (me.username or "").strip() or str(me.id)
        return True, username
    except Exception as e:
        return False, str(e) or "Invalid token."
    finally:
        await tc.disconnect()


def discover_local_sessions(data: dict[str, Any]) -> int:
    """Scan sessions/active/ for .session files not in free_sessions or any bot. Add them to free_sessions, save, return count added."""
    known: set[str] = set(data.get("free_sessions", []))
    for cfg in data.get("bots", {}).values():
        for s in cfg.get("sessions", []):
            fn = s.get("file")
            if fn:
                known.add(fn)
    new_files: list[str] = []
    try:
        for p in config.SESSIONS_ACTIVE.iterdir():
            if p.suffix.lower() == ".session" and p.is_file() and p.name not in known:
                new_files.append(p.name)
    except OSError as e:
        logger.warning("discover_local_sessions: %s", e)
        return 0
    if new_files:
        pool = load_pool()
        pool.setdefault("free_sessions", [])
        for fn in new_files:
            if fn not in pool["free_sessions"]:
                pool["free_sessions"].append(fn)
        save_pool(pool)
        logger.info("Discovered %s session(s) in sessions/active/ and added to free pool", len(new_files))
    return len(new_files)


async def check_all_active_sessions(data: dict[str, Any]) -> tuple[int, int]:
    """Startup: quick auth + can_send to SavedMessages for all free and assigned sessions.
    Move invalid to dead/. Returns (ok_count, moved_to_dead_count).
    """
    ok_count, dead_count = 0, 0
    pool = load_pool()
    pool.setdefault("free_sessions", [])
    pool.setdefault("dead_sessions", [])
    for fn in list(pool.get("free_sessions", [])):
        path = config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
            if fn not in pool["dead_sessions"]:
                pool["dead_sessions"].append(fn)
            dead_count += 1
            continue
        if await validate_session(path):
            ok_count += 1
        else:
            dead_count += 1
            pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
            if fn not in pool["dead_sessions"]:
                pool["dead_sessions"].append(fn)
    for bot_token, cfg in data.get("bots", {}).items():
        name = cfg.get("name")
        for s in list(cfg.get("sessions", [])):
            fn = s.get("file")
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                cfg["sessions"] = [x for x in cfg.get("sessions", []) if x.get("file") != fn]
                if fn not in pool["dead_sessions"]:
                    pool["dead_sessions"].append(fn)
                dead_count += 1
                continue
            if await validate_session(path):
                ok_count += 1
            else:
                cfg["sessions"] = [x for x in cfg.get("sessions", []) if x.get("file") != fn]
                if fn not in pool["dead_sessions"]:
                    pool["dead_sessions"].append(fn)
                dead_count += 1
        if name:
            save_user_data(name, cfg)
    save_pool(pool)
    return ok_count, dead_count


def _move_session_to_dead(session_path: Path) -> None:
    """Move session file to dead/ (caller ensures path is file)."""
    dest = config.SESSIONS_DEAD / session_path.name
    try:
        shutil.move(str(session_path), str(dest))
        logger.info("Moved invalid session to dead: %s", session_path.name)
    except OSError as err:
        logger.warning("Could not move %s to dead: %s", session_path.name, err)


def record_sold_bot(cfg: dict, bot_token: str, reason: str = "grace_purge") -> None:
    """Append a permanent sales record to data/sold_bots.json before a bot is purged.

    Keeps the business history ("we sold this plan, to this owner, on this date") even
    after the bot, its logs and its config are deleted. Append-only; deduped per bot_token."""
    path = config.DATA_SOLD_FILE
    record = {
        "bot_token_hint": (bot_token or "")[:12] + "…",
        "name": cfg.get("name"),
        "owner_id": cfg.get("owner_id"),
        "bot_username": cfg.get("bot_username"),
        "plan_mode": cfg.get("plan_mode"),
        "sessions_count": len(cfg.get("sessions", []) or []),
        "created_at": cfg.get("created_at") or cfg.get("provisioned_at"),
        "valid_till": cfg.get("valid_till"),
        "expired_at": cfg.get("expired_at"),
        "renewal_price": cfg.get("renewal_price"),
        "renewals_count": len((cfg.get("renewal_history") or [])) + len(((cfg.get("history") or {}).get("renewals") or [])),
        "retired_at": datetime.utcnow().isoformat() + "Z",
        "retired_reason": reason,
    }
    with _file_lock(path):
        ledger: list = []
        if path.exists():
            try:
                loaded = _loads(path.read_bytes())
                if isinstance(loaded, list):
                    ledger = loaded
            except Exception:
                ledger = []
        # Dedupe: same token retired at the same expiry shouldn't be recorded twice.
        key = (record["bot_token_hint"], record["expired_at"])
        if not any((r.get("bot_token_hint"), r.get("expired_at")) == key for r in ledger if isinstance(r, dict)):
            ledger.append(record)
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_bytes(_dumps(ledger))
        try:
            os.replace(tmp, path)
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            raise
    logger.info("[Sold] Recorded sale history for %s (owner=%s, reason=%s)", cfg.get("name"), cfg.get("owner_id"), reason)


def purge_name_scoped_stores(user_name: str) -> None:
    """Delete every per-bot store keyed by the bot's (display) name that the main
    teardown does not otherwise remove: the portal bell (data/notifications/<name>.json)
    and the DM inbox (data/dm_inbox/<name>.json).

    These use the raw lowercased display name (NOT name_to_filename), so we resolve
    them via the same helpers that write them to guarantee we hit the exact files.
    Called from BOTH teardown paths (manual delete + grace purge). Best-effort;
    never raises — a missing/locked file must not abort a bot teardown."""
    if not user_name:
        return
    try:
        from .dm_inbox import _notif_path, _inbox_path
        for p in (_notif_path(user_name), _inbox_path(user_name)):
            try:
                if p.is_file():
                    p.unlink()
                    logger.info("[Teardown] Removed name-scoped store: %s", p.name)
            except OSError as e:
                logger.warning("[Teardown] Could not remove %s: %s", p, e)
    except Exception as e:
        logger.warning("[Teardown] purge_name_scoped_stores(%s) failed: %s", user_name, e)


async def expire_bot_return_sessions_to_pool(bot_token: str) -> tuple[int, int]:
    """On bot expiry: return ADMIN-assigned sessions to free/dead pool; leave USER-uploaded sessions untouched
    (user owns them — they stay on disk for re-subscription). Archive config instead of deleting.
    Returns (returned_count, dead_count). Call after _stop_posting(bot_token)."""
    user_name = get_name_by_token(bot_token)
    if not user_name:
        return 0, 0
    cfg = load_user_data(user_name)
    if not cfg:
        return 0, 0
    sessions = list(cfg.get("sessions", []))
    pool = load_pool()
    pool.setdefault("free_sessions", [])
    pool.setdefault("dead_sessions", [])
    returned = 0
    dead = 0
    user_sessions_kept: list[str] = []
    for s in sessions:
        fn = s.get("file")
        if not fn:
            continue
        # User-uploaded sessions (path starts with "users/") belong to the user, NOT the admin pool.
        # Do NOT return them to free_sessions — leave files in place so user can re-subscribe.
        if fn.startswith("users/"):
            user_sessions_kept.append(fn)
            continue
        # Admin-assigned sessions: return to pool
        path = config.resolve_session_path(fn)
        if path.is_file():
            # A raising validation must never abort the purge before the deletion
            # steps below — treat an errored validation as "dead" and move on.
            try:
                ok = await validate_session(path)
            except Exception as e:
                logger.warning("[Expiry] Session validation errored for %s (treated as dead): %s", fn, e)
                ok = False
            if ok:
                if fn not in pool["free_sessions"]:
                    pool["free_sessions"].append(fn)
                returned += 1
            else:
                if fn not in pool["dead_sessions"]:
                    pool["dead_sessions"].append(fn)
                dead += 1
        else:
            if fn not in pool["dead_sessions"]:
                pool["dead_sessions"].append(fn)
            dead += 1
    save_pool(pool)
    if user_sessions_kept:
        logger.info(
            "[Expiry] User-owned sessions kept in place (not pooled): %s for bot %s",
            user_sessions_kept, bot_token[:20],
        )
    safe = name_to_filename(user_name)

    # --- Keep the permanent sales record (who/what/when) before deleting everything else ---
    try:
        record_sold_bot(cfg, bot_token, reason="grace_purge")
    except Exception as e:
        logger.warning("[Expiry] Could not record sold-bot history for %s: %s", user_name, e)

    # --- Delete the local group list. Do NOT leave the Telegram groups — leaving would cost
    #     one API call per group per account and risk rate limits; the accounts simply stay
    #     joined. We only drop our stored copy of the list. ---
    try:
        from .chatlist import custom_group_filename
        gf_path = config.GROUPS_DIR / custom_group_filename(user_name)
        if gf_path.is_file():
            gf_path.unlink()
            logger.info("[Expiry] Removed group list for %s", user_name)
        if gf_path.parent.is_dir() and gf_path.parent.name == "user groups" and not any(gf_path.parent.iterdir()):
            try:
                gf_path.parent.rmdir()
            except OSError:
                pass
    except Exception as e:
        logger.warning("[Expiry] Could not remove group list for %s: %s", user_name, e)

    # --- Delete logs (not retained after purge) ---
    log_file = config.DATA_LOGS_DIR / f"{safe}.log"
    if log_file.exists():
        try:
            log_file.unlink()
            logger.info("[Expiry] Removed log file for %s", user_name)
        except OSError:
            pass

    # --- Delete per-user stats file too (counts only; not needed once retired) ---
    stats_file = config.DATA_STATS_DIR / f"{safe}.json"
    if stats_file.exists():
        try:
            stats_file.unlink()
        except OSError:
            pass

    # --- Delete name-scoped stores the loop above never touches (portal bell + DM inbox).
    #     Without this they survive the purge and resurrect on a same-name recreate. ---
    purge_name_scoped_stores(user_name)

    # --- Replace the live config with a slim 'dead' tombstone in archived/. The portal then
    #     shows "removed" (no live config resolves), while admin keeps a lightweight marker
    #     that this bot existed and was retired. Heavy data (sessions, groups) is stripped. ---
    archive_dir = config.DATA_DIR / "archived"
    archive_dir.mkdir(parents=True, exist_ok=True)
    tombstone = {
        "name": f"{cfg.get('name') or user_name} ☠ (dead)",
        "state": "dead",
        "owner_id": cfg.get("owner_id"),
        "bot_username": cfg.get("bot_username"),
        "plan_mode": cfg.get("plan_mode"),
        "valid_till": cfg.get("valid_till"),
        "expired_at": cfg.get("expired_at"),
        "retired_at": datetime.utcnow().isoformat() + "Z",
        "retired_reason": "grace_purge",
    }
    try:
        ts_tag = str(int(time.time()))
        (archive_dir / f"{safe}_{ts_tag}.dead.json").write_bytes(_dumps(tombstone))
    except OSError as e:
        logger.warning("[Expiry] Could not write dead tombstone for %s: %s", user_name, e)
    user_file = config.DATA_USER_DIR / f"{safe}.json"
    if user_file.exists():
        try:
            user_file.unlink()
            logger.info("[Expiry] Removed live config for %s (marked dead)", user_name)
        except OSError:
            pass
    return returned, dead


# Telethon uses SQLite for .session files; magic header is "SQLite format 3\x00"
_SQLITE_MAGIC = b"SQLite format 3\x00"


def _is_sqlite_session_file(path: Path) -> bool:
    """Return True if path is a file and starts with SQLite magic (valid Telethon session format)."""
    try:
        with open(path, "rb") as f:
            return f.read(len(_SQLITE_MAGIC)) == _SQLITE_MAGIC
    except OSError:
        return False


def _session_failure_reason(exc: Exception) -> str:
    """Map exception to admin-facing reason: UNAUTHORIZED, FROZEN, or revoked."""
    t = type(exc)
    err_str = str(exc).lower()
    if getattr(t, "__name__", "").startswith("AuthKey") or "revoked" in err_str or "unregistered" in err_str:
        return "revoked"
    if "deactivated" in err_str or "banned" in err_str or "frozen" in err_str or "PhoneNumberBanned" in t.__name__:
        return "FROZEN"
    return "UNAUTHORIZED"


async def validate_session_with_reason(session_path: Path) -> tuple[bool, str]:
    """Validate session; return (ok, reason). If invalid, move to dead/ and return (False, reason).
    Reason is one of: '' (ok), 'UNAUTHORIZED', 'FROZEN', 'revoked', or a short message for other failures."""
    from .session_guard import SessionBusyError, busy_message, guarded_client
    session_path = session_path.resolve()
    if not session_path.is_file():
        return False, "file missing"
    if _session_active_callback and _session_active_callback(session_path):
        return False, "in use by posting"
    busy = busy_message(session_path)
    if busy:
        # In use by another task — NOT dead; report who holds it and do not move the file.
        logger.info("Session %s validation skipped: %s", session_path.name, busy)
        return False, busy
    if not _is_sqlite_session_file(session_path):
        logger.warning(
            "Session file is not a valid Telethon session (SQLite format required): %s",
            session_path.name,
        )
        _move_session_to_dead(session_path)
        return False, "invalid format (not SQLite)"
    client = guarded_client(session_path, "session validation", wait_timeout=5, expected_sec=30)
    ok = False
    busy_skip = False
    reason = ""
    try:
        await client.connect()
        if not await client.is_user_authorized():
            logger.warning("Session %s failed validation: not authorized", session_path.name)
            return False, "UNAUTHORIZED"
        await with_floodwait_retry(lambda: client.send_message("me", "."))
        ok = True
        return True, ""
    except SessionBusyError as e:
        busy_skip = True
        logger.info("Session %s validation skipped: %s", session_path.name, e)
        return False, str(e)
    except Exception as e:
        reason = _session_failure_reason(e)
        if type(e) in _SESSION_DEAD_ERRORS:
            logger.warning("Session %s failed validation: %s", session_path.name, e)
        else:
            logger.warning("Session %s failed validation: %s", session_path.name, e)
        return False, reason
    finally:
        await client.disconnect()
        if not ok and not busy_skip and session_path.is_file():
            _move_session_to_dead(session_path)


async def validate_session(session_path: Path) -> bool:
    """Validate session: authorized + can_send_message to SavedMessages.
    Uses FloodWait retry (max 3, exponential backoff) for the send. SessionRevoked/AuthKey* etc.
    → move to dead/ and return False. Skips if session is currently in use by posting (avoids SQLite lock).
    Rejects non-SQLite files before opening to avoid sqlite3.DatabaseError (e.g. wrong upload format)."""
    ok, _ = await validate_session_with_reason(session_path)
    return ok


def _default_merged() -> dict[str, Any]:
    """Return the default merged structure (for load_adbot compatibility)."""
    return {
        "bots": {},
        "free_sessions": [],
        "dead_sessions": [],
        "admin_alerts": [],
    }


async def run_startup_validation(data: dict[str, Any]) -> tuple[int, int, list[tuple[str, str]]]:
    """Validate every session in sessions/active that appears in data (free_sessions or any bot's sessions).
    Invalid sessions are moved to sessions/dead and removed from pool/bots; dead_sessions updated.
    Returns (valid_count, invalid_count, invalid_list) where invalid_list is [(session_filename, reason), ...]."""
    pool = load_pool()
    pool.setdefault("free_sessions", [])
    pool.setdefault("dead_sessions", [])
    invalid_list: list[tuple[str, str]] = []
    valid_count = 0
    to_validate: list[tuple[str, str]] = []  # (filename, "free" | bot_token)
    for fn in list(pool.get("free_sessions", [])):
        path = config.SESSIONS_ACTIVE / fn
        if path.is_file():
            to_validate.append((fn, "free"))
    for bot_token, cfg in data.get("bots", {}).items():
        for s in list(cfg.get("sessions", [])):
            fn = s.get("file") or ""
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if path.is_file():
                to_validate.append((fn, bot_token))
    seen = set()
    for fn, owner in to_validate:
        if fn in seen:
            continue
        seen.add(fn)
        path = config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            continue
        ok, reason = await validate_session_with_reason(path)
        if not ok and ("is busy:" in reason or reason == "in use by posting"):
            # Session held by a live task (posting/chatlist/portal) — cannot check now,
            # but that also means it works. Do not mark dead.
            valid_count += 1
            logger.info("Startup validation: %s counted valid (%s)", fn, reason)
            continue
        if ok:
            valid_count += 1
        else:
            invalid_list.append((fn, reason))
            if fn not in pool["dead_sessions"]:
                pool["dead_sessions"].append(fn)
            if owner == "free":
                pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
            else:
                cfg = data.get("bots", {}).get(owner, {})
                cfg["sessions"] = [x for x in cfg.get("sessions", []) if (x.get("file") or "") != fn]
                name = cfg.get("name")
                if name:
                    save_user_data(name, cfg)
            logger.warning("Session %s failed validation: %s", fn if fn.endswith(".session") else fn + ".session", reason)
    invalid_count = len(invalid_list)
    save_pool(pool)
    return valid_count, invalid_count, invalid_list


def load_adbot() -> dict[str, Any]:
    """Load merged runtime data from data/pool.json + data/user/*.json.
    Returns {bots, free_sessions, dead_sessions, admin_alerts}. Bots keyed by bot_token from each user JSON."""
    if not config.DATA_POOL_FILE.exists():
        save_pool(_default_pool())
    pool = load_pool()
    config.DATA_USER_DIR.mkdir(parents=True, exist_ok=True)
    bots: dict[str, dict[str, Any]] = {}
    for path in config.DATA_USER_DIR.glob("*.json"):
        safe = path.stem
        cfg = load_user_data(safe)
        if not cfg or not isinstance(cfg, dict):
            continue
        token = (cfg.get("bot_token") or "").strip()
        if not token:
            logger.warning("User file %s has no bot_token, skipping", safe)
            continue
        bots[token] = cfg
    return {
        "bots": bots,
        "free_sessions": pool.get("free_sessions", []),
        "dead_sessions": pool.get("dead_sessions", []),
        "frozen_sessions": pool.get("frozen_sessions", []),
        "limited_sessions": pool.get("limited_sessions", []),
        "unauth_sessions": pool.get("unauth_sessions", []),
        "admin_alerts": pool.get("admin_alerts", []),
    }


def save_adbot(data: dict[str, Any]) -> None:
    """Save merged data to pool + user files. Each bot config must have 'name' and is stored with bot_token in user JSON."""
    save_pool({
        "free_sessions": data.get("free_sessions", []),
        "dead_sessions": data.get("dead_sessions", []),
        "frozen_sessions": data.get("frozen_sessions", []),
        "limited_sessions": data.get("limited_sessions", []),
        "unauth_sessions": data.get("unauth_sessions", []),
        "admin_alerts": data.get("admin_alerts", []),
    })
    for bot_token, cfg in data.get("bots", {}).items():
        name = (cfg.get("name") or "").strip()
        if not name:
            continue
        merged = dict(cfg)
        merged["bot_token"] = bot_token
        save_user_data(name, merged)


def _norm_session_file(fn: str) -> str:
    """Normalize session filename for comparison (always .session suffix)."""
    fn = (fn or "").strip()
    return fn if fn.endswith(".session") else (fn + ".session" if fn else "")


def run_session_ownership_integrity_scan() -> dict[str, Any]:
    """
    Nightly scan: no session in two bots; assigned + free == total session files; orphans returned to free pool.
    Returns report dict (duplicates_removed, orphans_returned, errors).
    """
    report: dict[str, Any] = {"duplicates_removed": 0, "orphans_returned": 0, "errors": []}
    try:
        pool = load_pool()
        data = load_adbot()
        bots_map = data.get("bots") or {}
        free_list = list(pool.get("free_sessions") or [])
        free_set = {_norm_session_file(f) for f in free_list}
        session_to_bots: dict[str, list[str]] = {}  # session_file (normalized) -> [bot_token]
        assigned_set: set[str] = set()
        for bot_token, cfg in bots_map.items():
            if not cfg:
                continue
            for s in cfg.get("sessions", []) or []:
                fn = (s.get("file") or "").strip()
                if not fn:
                    continue
                n = _norm_session_file(fn)
                assigned_set.add(n)
                session_to_bots.setdefault(n, []).append(bot_token)
        for fn, bots in list(session_to_bots.items()):
            if len(bots) <= 1:
                continue
            report["duplicates_removed"] += 1
            add_admin_alert(
                "session_integrity",
                f"Session {fn} was in {len(bots)} bots; removed from all but first. Bots: {', '.join(b[:15] for b in bots)}",
            )
            for bot_token in bots[1:]:
                bot_cfg = bots_map.get(bot_token, {})
                name = bot_cfg.get("name")
                if name:
                    cfg = load_user_data(name)
                    if cfg and isinstance(cfg.get("sessions"), list):
                        cfg["sessions"] = [x for x in cfg["sessions"] if _norm_session_file(x.get("file") or "") != fn]
                        save_user_data(name, cfg)
            if fn not in free_set:
                free_set.add(fn)
                pool.setdefault("free_sessions", [])
                if fn not in pool["free_sessions"]:
                    pool["free_sessions"].append(fn)
        on_disk = set()
        try:
            for p in config.SESSIONS_ACTIVE.iterdir():
                if p.is_file() and p.suffix.lower() == ".session":
                    on_disk.add(p.name)
        except OSError as e:
            report["errors"].append(str(e))
            return report
        orphans = on_disk - assigned_set - free_set
        if orphans:
            report["orphans_returned"] = len(orphans)
            pool.setdefault("free_sessions", [])
            for f in orphans:
                if f not in pool["free_sessions"]:
                    pool["free_sessions"].append(f)
            save_pool(pool)
            add_admin_alert("session_integrity", f"Returned {len(orphans)} orphan session(s) to free pool: {', '.join(sorted(orphans)[:10])}{'…' if len(orphans) > 10 else ''}.")
    except Exception as e:
        logger.exception("Session integrity scan failed: %s", e)
        report["errors"].append(str(e))
    return report


def get_bot_log_path(bot_token: str) -> Path | None:
    """Return path to this bot's dedicated log file: data/logs/<name>.log"""
    name = get_name_by_token(bot_token)
    if not name:
        return None
    safe = name_to_filename(name)
    return config.DATA_LOGS_DIR / f"{safe}.log"


# Max size (bytes) for user log file before rotation (default 10 MB)
USER_LOG_MAX_BYTES = 10 * 1024 * 1024
# Buffered batching: flush every 2s or when queue size exceeds this (reduces I/O under heavy posting)
USER_LOG_BATCH_SIZE = 50
USER_LOG_FLUSH_INTERVAL_SEC = 2.0
_user_log_queues: dict[str, list[str]] = {}
_user_log_queues_lock = threading.Lock()


def _resolve_user_log_path(bot_token: str) -> Path | None:
    """Resolve path to this bot's user log file (config.log_file or data/logs/<name>.log)."""
    path = get_bot_log_path(bot_token)
    if not path:
        return None
    name = get_name_by_token(bot_token)
    if name:
        cfg = load_user_data(name)
        if cfg and cfg.get("log_file"):
            raw = cfg["log_file"].replace("\\", "/")
            path = config.BASE_DIR / raw if not (raw.startswith("/") or (len(raw) > 1 and raw[1] == ":")) else Path(raw)
    return path


def _fallback_user_log_failure(bot_token: str, path: Path | None, details: str) -> None:
    """On user log write failure, append to global adbot.log so failures are never lost."""
    try:
        adbot_log = config.LOGS_DIR / "adbot.log"
        adbot_log.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        path_str = str(path) if path else "unknown"
        msg = f"{ts} USER LOG WRITE FAILURE bot_token={bot_token[:20]}... path={path_str} details={details}\n"
        with open(adbot_log, "a", encoding="utf-8") as f:
            f.write(msg)
            f.flush()
    except OSError:
        pass


def _append_batch_to_user_log_under_lock(path: Path, lines: list[str], max_size_bytes: int) -> None:
    """Write multiple lines in one open/flush/close. Caller must hold file lock. Preserves order."""
    if not lines:
        return
    if path.exists() and path.stat().st_size >= max_size_bytes:
        rot = path.with_suffix(path.suffix + ".1")
        if rot.exists():
            rot.unlink(missing_ok=True)
        path.rename(rot)
    with open(path, "a", encoding="utf-8", buffering=1) as f:
        for line in lines:
            if not line.endswith("\n"):
                line = line + "\n"
            f.write(line)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass


def flush_user_log_queues_for_bot(bot_token: str) -> None:
    """Flush this bot's buffered log queue (one lock acquisition, batch write). Safe to call from any thread."""
    with _user_log_queues_lock:
        queue = _user_log_queues.get(bot_token)
        if not queue:
            return
        lines = list(queue)
        queue.clear()
    if not lines:
        return
    path = _resolve_user_log_path(bot_token)
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = [ln if ln.endswith("\n") else ln + "\n" for ln in lines]
    if FileLock is None:
        try:
            _append_batch_to_user_log_under_lock(path, normalized, USER_LOG_MAX_BYTES)
        except Exception as e:
            _fallback_user_log_failure(bot_token, path, str(e))
        return
    lock = FileLock(str(path.parent / (path.name + ".lock")))
    try:
        lock.acquire()
        try:
            _append_batch_to_user_log_under_lock(path, normalized, USER_LOG_MAX_BYTES)
        except Exception as e:
            _fallback_user_log_failure(bot_token, path, str(e))
    finally:
        try:
            lock.release()
        except Exception:
            pass


def flush_user_log_queues() -> None:
    """Flush all bots' buffered log queues. Call periodically (e.g. every USER_LOG_FLUSH_INTERVAL_SEC)."""
    with _user_log_queues_lock:
        tokens = list(_user_log_queues.keys())
    for bot_token in tokens:
        flush_user_log_queues_for_bot(bot_token)


def append_to_user_log(
    bot_token: str,
    line: str,
    *,
    critical: bool = False,
    max_size_bytes: int = USER_LOG_MAX_BYTES,
) -> None:
    """Append a line to the user's configured log file.
    If critical=True: immediate write with lock and fsync (for errors/failures).
    If critical=False: enqueue; flush every 2s or when queue size > USER_LOG_BATCH_SIZE (reduces I/O)."""
    if not line.strip():
        return
    import re as _re
    from datetime import datetime as _dt, timezone as _tz
    if not _re.match(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", line.lstrip()):
        ts = _dt.now(_tz.utc).strftime("%Y-%m-%d %H:%M:%S")
        line = f"{ts} {line}"
    if critical:
        path = _resolve_user_log_path(bot_token)
        if not path:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if not line.endswith("\n"):
            line = line + "\n"
        lock_path = path.parent / (path.name + ".lock")
        if FileLock is None:
            try:
                _append_to_user_log_under_lock(path, line, max_size_bytes)
            except Exception as e:
                _fallback_user_log_failure(bot_token, path, str(e))
            return
        lock = FileLock(str(lock_path))
        try:
            lock.acquire()
            try:
                _append_to_user_log_under_lock(path, line, max_size_bytes)
            except Exception as e:
                _fallback_user_log_failure(bot_token, path, str(e))
        finally:
            try:
                lock.release()
            except Exception:
                pass
        return
    with _user_log_queues_lock:
        q = _user_log_queues.setdefault(bot_token, [])
        q.append(line)
        if len(q) >= USER_LOG_BATCH_SIZE:
            lines = list(q)
            q.clear()
        else:
            lines = None
    if lines is not None:
        path = _resolve_user_log_path(bot_token)
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            normalized = [ln if ln.endswith("\n") else ln + "\n" for ln in lines]
            if FileLock is None:
                try:
                    _append_batch_to_user_log_under_lock(path, normalized, max_size_bytes)
                except Exception as e:
                    _fallback_user_log_failure(bot_token, path, str(e))
            else:
                lock = FileLock(str(path.parent / (path.name + ".lock")))
                try:
                    lock.acquire()
                    try:
                        _append_batch_to_user_log_under_lock(path, normalized, max_size_bytes)
                    except Exception as e:
                        _fallback_user_log_failure(bot_token, path, str(e))
                finally:
                    try:
                        lock.release()
                    except Exception:
                        pass


def _append_to_user_log_under_lock(path: Path, line: str, max_size_bytes: int) -> None:
    """Perform rotation (if needed) and atomic append. Caller must hold the file lock. Flush after write."""
    if path.exists() and path.stat().st_size >= max_size_bytes:
        rot = path.with_suffix(path.suffix + ".1")
        if rot.exists():
            rot.unlink(missing_ok=True)
        path.rename(rot)
    with open(path, "a", encoding="utf-8", buffering=1) as f:
        f.write(line)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass


def log_bot_event(bot_token: str, message: str) -> None:
    """Append a timestamped line to this bot's log file (data/logs/<name>.log)."""
    path = get_bot_log_path(bot_token)
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # Bug 4: use UTC to match append_to_user_log() (scheduler/posting lines). Mixing local time here with
    # UTC there produced an out-of-order, non-monotonic timeline in the same log file.
    from datetime import timezone as _tz
    ts = datetime.now(_tz.utc).strftime("%Y-%m-%d %H:%M:%S")
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{ts} {message}\n")
            f.flush()
    except OSError:
        pass
    name = get_name_by_token(bot_token)
    if name:
        cfg = load_user_data(name)
        if cfg and not cfg.get("log_file"):
            try:
                rel = path.relative_to(config.BASE_DIR)
            except ValueError:
                rel = path
            cfg["log_file"] = str(rel).replace("\\", "/")
            save_user_data(name, cfg)


# Clients to disconnect on shutdown (admin + user bots); posting workers disconnect themselves when stopped
_shutdown_clients: list = []


def register_for_shutdown(client: Any) -> None:
    """Register a TelegramClient to be disconnected when the process stops (Ctrl+C)."""
    _shutdown_clients.append(client)


def unregister_for_shutdown(client: Any) -> None:
    """Remove a TelegramClient from shutdown list (e.g. when controller bot is disconnected on AdBot delete)."""
    try:
        _shutdown_clients.remove(client)
    except ValueError:
        pass


def get_shutdown_clients() -> list:
    """Return list of registered clients for shutdown cleanup."""
    return list(_shutdown_clients)


def format_session_death_admin_message(session_file: str, reason: str) -> str:
    """Format runtime session death for admin notification. Returns one of:
    '<session>.session became UNAUTHORIZED' | 'became FROZEN' | 'revoked'."""
    name = (session_file or "session").rstrip()
    if not name.endswith(".session"):
        name = name + ".session"
    r = (reason or "").strip().upper()
    if "REVOKED" in r or "AUTHKEY" in r or "UNREGISTERED" in r:
        return f"{name} revoked"
    if "FROZEN" in r or "BANNED" in r or "DEACTIVATED" in r:
        return f"{name} became FROZEN"
    return f"{name} became UNAUTHORIZED"


def add_admin_alert(alert_type: str, msg: str) -> None:
    """Append a critical event to admin_alerts in pool. Admin bot forwards these to admin DM."""
    import time
    pool = load_pool()
    pool.setdefault("admin_alerts", [])
    pool["admin_alerts"].append({"ts": time.time(), "type": alert_type, "msg": msg[:500]})
    pool["admin_alerts"] = pool["admin_alerts"][-100:]
    save_pool(pool)


async def recreate_log_group_for_bot(bot_token: str) -> bool:
    """Recreate log group for one bot using its first session (channel deleted/banned). Returns True if ok."""
    from telethon.tl.types import Channel
    name = get_name_by_token(bot_token)
    if not name:
        return False
    cfg = load_user_data(name)
    if not cfg or not cfg.get("sessions"):
        return False
    first_fn = cfg["sessions"][0].get("file")
    if not first_fn:
        return False
    path = config.SESSIONS_ACTIVE / first_fn
    if not path.is_file():
        return False
    display_name = cfg.get("name", "AdBot")
    bot_username = (cfg.get("bot_username") or "").strip().lstrip("@")
    if not bot_username:
        return False
    from .session_guard import guarded_client
    client = guarded_client(path, "log group setup", wait_timeout=20, expected_sec=120)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            return False
        create_result = await client(CreateChannelRequest(
            title=f"{display_name} AdBot Log", about="Hosted by @HQAdz", megagroup=True
        ))
        channel = create_result.chats[0]
        if not isinstance(channel, Channel):
            return False
        input_ch = InputChannel(channel.id, getattr(channel, "access_hash", 0) or 0)
        username = "adbot_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
        await client(UpdateUsernameRequest(input_ch, username))
        entity = await client.get_entity(channel.id)
        bot_input = await client.get_input_entity("@" + bot_username)
        await client(InviteToChannelRequest(input_ch, [bot_input]))
        rights = ChatAdminRights(
            change_info=True, post_messages=True, edit_messages=True, delete_messages=True,
            invite_users=True, pin_messages=True, manage_call=True,
        )
        await client(EditAdminRequest(input_ch, bot_input, rights, "AdBot"))
        cfg["log_group"] = f"https://t.me/{username}"
        save_user_data(name, cfg)
        return True
    except Exception as e:
        logger.warning("recreate_log_group_for_bot %s: %s", display_name, e)
        return False
    finally:
        await client.disconnect()


# Per-bot entry schema (for reference / validation helpers if needed later):
# "bots": {
#   "bot_token1": {
#     "name": "buyer2",
#     "bot_token": "...",
#     "bot_username": "...",
#     "valid_till": "02/06/2026",
#     "cycle": 3600,
#     "gap": 5,
#     "mode": "Enterprise",
#     "group_file": "Starter.txt",
#     "log_group": "https://t.me/adbot_xxxxxxxx",  # t.me link to log megagroup; legacy: -100... peer id
#     "log_file": "logs/bots/bot_username.log",   # per-bot log: user actions, posting, errors
#     "authorized": [123456789, ...],
#     "sessions": [ {"file": "acc1.session", "real_name": "Name", "user_id": 12345, "index": 1}, ... ],
#     "state": "stopped",  # or "running"
#     "last_cycle_time": {...},
#   },
# },
