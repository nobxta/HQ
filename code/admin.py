"""Admin bot logic (Telethon client with admin token)."""
import asyncio
import json
import logging
import queue as queue_module
import random
import shutil
import socket
import string
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Awaitable, Callable, Optional

# Bot profile text applied after creation (admin and shop)
BOT_PROFILE_DESCRIPTION = "This is a controller bot designed to control users ads.\nPowered by @HQAdz"
BOT_PROFILE_SHORT_DESCRIPTION = "Ad automation controller powered by HQAdz."

# Random bot profile pictures used during creation (paths relative to BASE_DIR)
BOT_PFP_REL = ["data/Bot 1.jpeg", "data/bot 2.jpeg"]

try:
    import psutil
except ImportError:
    psutil = None  # type: ignore[assignment]

from . import config

# Fix #2: Control-plane / data-plane split — admin enqueues create jobs, worker does the work.
_create_job_queue: queue_module.Queue = queue_module.Queue()
_result_queue: queue_module.Queue = queue_module.Queue()
_create_worker_started = threading.Lock()
# Serialize load_adbot + session assignment + save_pool so the same session cannot be assigned to two bots.
# This is the SHARED session-pool lock: the replacement and runtime session-death paths take the same
# lock (via code.utils helpers) for their brief claim/return steps, so no session binds to two bots.
from .utils import SESSION_POOL_LOCK as creation_pool_lock
_create_worker_threads: list = []  # list of threads; multiple for queue saturation limit
_create_worker_restart_requested = threading.Event()
MAX_CONCURRENT_CREATE_JOBS = 2  # limit concurrent creations to avoid API/session exhaustion
CREATE_HEARTBEAT_PATH = config.DATA_DIR / "create_worker_heartbeat.json"
CREATE_WATCHDOG_STALE_SEC = 900  # 15 minutes
CREATE_ORDER_STALE_CREATING_MIN = 5  # orders stuck in "creating" longer than this are reset to pending_creation


def _write_create_heartbeat() -> None:
    try:
        CREATE_HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        CREATE_HEARTBEAT_PATH.write_text(json.dumps({"ts": time.time()}), encoding="utf-8")
    except Exception as e:
        logger.debug("Create worker heartbeat write failed: %s", e)



from telethon import TelegramClient, events, Button
from telethon.errors import FloodError, FloodWaitError, PeerFloodError, UserRestrictedError
from telethon.tl.functions.channels import (
    CreateChannelRequest,
    EditAdminRequest,
    InviteToChannelRequest,
    UpdateUsernameRequest,
)
from telethon.tl.types import ChatAdminRights, InputChannel

# Errors that indicate a session cannot create groups — try next session
_CREATE_GROUP_RETRYABLE = (
    UserRestrictedError,
    FloodWaitError,
    FloodError,
    PeerFloodError,
)
from .session_guard import SessionBusyError, guarded_client
from .users import _stop_posting, create_user_bot, _workers_alive, disconnect_and_remove_controller_bot
from .utils import add_admin_alert, delete_bot_from_storage, get_name_by_token, get_session_user, join_chat_by_link, load_adbot, load_pool, name_to_filename, probe_session_identity, record_session_meta, register_for_shutdown, save_adbot, save_pool, save_user_data, validate_bot_token, validate_session
from .user_config import get_plan_mode

logger = logging.getLogger(__name__)

# Callback data bytes for inline buttons
CB_CREATE_ADBOTS = b"create_adbots"
CB_CREATE_PROCEED = b"create_proceed"
CB_CREATE_FINAL = b"create_final"
CB_CREATE_CANCEL = b"create_cancel"
CB_MODE_STARTER = b"mode:starter"
CB_MODE_ENTERPRISE = b"mode:enterprise"
PREFIX_GROUP_FILE = b"gf:"
CB_MANAGE_SESSIONS = b"manage_sessions"
CB_MANAGE_ADBOTS = b"manage_adbots"
CB_ADD_SESSIONS = b"add_sessions"
CB_REMOVE_SESSIONS = b"remove_sessions"
CB_BACK_SESSIONS = b"back_sessions"
CB_CANCEL_ADD = b"cancel_add"
PREFIX_DEL_FREE = b"del_f:"
PREFIX_DEL_DEAD = b"del_d:"
CB_MANAGE_ADBOT_VALIDATE = b"adb_validate"
CB_MANAGE_ADBOT_REPLACE = b"adb_replace"
CB_MANAGE_ADBOT_REPLACE_ERROR = b"adb_replace_err"
CB_MANAGE_ADBOT_RECREATE = b"adb_recreate"
CB_MANAGE_ADBOT_DELETE = b"adb_delete"
CB_MANAGE_ADBOT_BACK = b"adb_back"
CB_ADBOT_BACK_TO_LIST = b"adb_backlist"
PREFIX_ADBOT_SELECT = b"adb_sel:"
PREFIX_ADBOT_VALIDATE = b"adb_val:"
PREFIX_ADBOT_REPLACE = b"adb_rep:"
PREFIX_ADBOT_REPLACE_ERR = b"adb_repe:"
PREFIX_ADBOT_RECREATE = b"adb_rec:"
PREFIX_ADBOT_DELETE = b"adb_del:"
PREFIX_ADBOT_DEL_CONFIRM = b"adb_dconfirm:"

# User is waiting to send a file for Add Sessions
_add_mode: set[int] = set()
# Add Sessions: uid -> (added_f, added_d) this batch; uid -> (chat_id, msg_id) last status message (edit instead of spam)
_add_batch_totals: dict[int, tuple[int, int]] = {}
_add_last_msg: dict[int, tuple[int, int]] = {}  # (chat_id, msg_id)

# Manage AdBots: user_id -> [(name, bot_token), ...] (set when showing bot list / per-bot actions)
_manage_adbot_list: dict[int, list[tuple[str, str]]] = {}
# Recreate logs: user_id -> [(name, bot_token), ...]
_recreate_bot_list: dict[int, list[tuple[str, str]]] = {}
# Delete AdBot: user_id -> [(name, bot_token), ...]
_delete_adbot_list: dict[int, list[tuple[str, str]]] = {}

# Create AdBot conversation: user_id -> {step, data, chat_id, msg_id?}
_create_state: dict[int, dict] = {}


def _main_menu_buttons() -> list[list[Button]]:
    """Inline keyboard for main menu."""
    return [
        [Button.inline("Create AdBots", CB_CREATE_ADBOTS)],
        [Button.inline("Manage Sessions", CB_MANAGE_SESSIONS)],
        [Button.inline("Manage AdBots", CB_MANAGE_ADBOTS)],
    ]


def _is_authorized(sender_id: int | None) -> bool:
    """True if ADMIN_USER_ID is unset or matches sender."""
    if not config.ADMIN_USER_ID:
        return True
    return sender_id == config.ADMIN_USER_ID


def _session_counts(data: dict) -> tuple[int, int, int, int]:
    """Return (total, dead, assigned, free). Legacy; use _session_counts_full for all buckets."""
    from .utils import load_pool
    pool = load_pool()
    free = len(pool.get("free_sessions", []))
    dead = len(pool.get("dead_sessions", []))
    assigned = sum(len(b.get("sessions", [])) for b in data.get("bots", {}).values())
    total = free + dead + assigned
    return total, dead, assigned, free


def _session_counts_full(data: dict) -> dict[str, int]:
    """Return all session bucket counts."""
    from .utils import load_pool
    pool = load_pool()
    counts = {
        "free": len(pool.get("free_sessions", [])),
        "dead": len(pool.get("dead_sessions", [])),
        "frozen": len(pool.get("frozen_sessions", [])),
        "limited": len(pool.get("limited_sessions", [])),
        "unauth": len(pool.get("unauth_sessions", [])),
        "assigned": sum(len(b.get("sessions", [])) for b in data.get("bots", {}).values()),
    }
    counts["total"] = sum(counts.values())
    return counts


def _manage_sessions_text_and_buttons(data: dict) -> tuple[str, list[list[Button]]]:
    """Message text and buttons for Manage Sessions screen."""
    c = _session_counts_full(data)
    lines = [f"Sessions: {c['total']} total"]
    lines.append(f"  Free: {c['free']} | Assigned: {c['assigned']}")
    if c["dead"]:
        lines.append(f"  Dead: {c['dead']}")
    if c["frozen"]:
        lines.append(f"  Frozen: {c['frozen']}")
    if c["limited"]:
        lines.append(f"  Limited: {c['limited']}")
    if c["unauth"]:
        lines.append(f"  Unauth: {c['unauth']}")
    text = "\n".join(lines)
    buttons = [
        [Button.inline("Add Sessions", CB_ADD_SESSIONS), Button.inline("Remove Sessions", CB_REMOVE_SESSIONS)],
        [Button.inline("« Back", CB_BACK_SESSIONS)],
    ]
    return text, buttons


async def _handle_add_sessions(client: TelegramClient, event: events.CallbackQuery.Event, data: dict) -> None:
    """Prompt for file upload (single .session, bulk txt/zip)."""
    await event.answer()
    uid = event.sender_id
    _add_mode.add(uid)
    _add_batch_totals[uid] = (0, 0)
    _add_last_msg.pop(uid, None)
    await event.edit(
        "Send a single `.session` file, a `.txt` (one session filename per line), or a `.zip` containing session files.",
        buttons=[[Button.inline("Cancel", CB_CANCEL_ADD)]],
    )


async def _handle_remove_sessions(client: TelegramClient, event: events.CallbackQuery.Event, data: dict) -> None:
    """List free/dead sessions with delete buttons."""
    await event.answer()
    free_list = list(data.get("free_sessions", []))
    dead_list = list(data.get("dead_sessions", []))
    rows = []
    for name in free_list[:15]:
        rows.append([Button.inline(f"🗑 {name}", PREFIX_DEL_FREE + name.encode("utf-8"))])
    for name in dead_list[:15]:
        rows.append([Button.inline(f"🗑 {name} (dead)", PREFIX_DEL_DEAD + name.encode("utf-8"))])
    if not rows:
        await event.edit("No free or dead sessions. Add some first.", buttons=[[Button.inline("« Back", CB_BACK_SESSIONS)]])
        return
    rows.append([Button.inline("« Back", CB_BACK_SESSIONS)])
    await event.edit("Select session to remove:", buttons=rows)


async def _handle_back_sessions(client: TelegramClient, event: events.CallbackQuery.Event, data: dict) -> None:
    """Return to main Admin menu from Manage Sessions."""
    await event.answer()
    uid = event.sender_id
    _add_mode.discard(uid)
    _add_batch_totals.pop(uid, None)
    _add_last_msg.pop(uid, None)
    await event.edit("Admin menu:", buttons=_main_menu_buttons())


def _manage_adbots_buttons() -> list[list[Button]]:
    """Legacy: direct action buttons (used when returning from flows that don't have a selected bot)."""
    return [
        [Button.inline("Validate Sessions", CB_MANAGE_ADBOT_VALIDATE)],
        [Button.inline("Replace Dead Sessions", CB_MANAGE_ADBOT_REPLACE)],
        [Button.inline("Replace Error Sessions", CB_MANAGE_ADBOT_REPLACE_ERROR)],
        [Button.inline("Recreate Logs", CB_MANAGE_ADBOT_RECREATE)],
        [Button.inline("Delete AdBot", CB_MANAGE_ADBOT_DELETE)],
        [Button.inline("« Back", CB_MANAGE_ADBOT_BACK)],
    ]


def _manage_adbot_actions_buttons(bot_index: int) -> list[list[Button]]:
    """Per-bot actions: Validate, Replace, Recreate, Delete for the bot at index."""
    i = str(bot_index).encode()
    return [
        [Button.inline("Validate this bot's sessions", PREFIX_ADBOT_VALIDATE + i)],
        [Button.inline("Replace dead sessions", PREFIX_ADBOT_REPLACE + i)],
        [Button.inline("Replace error sessions", PREFIX_ADBOT_REPLACE_ERR + i)],
        [Button.inline("Recreate log group", PREFIX_ADBOT_RECREATE + i)],
        [Button.inline("Delete this AdBot", PREFIX_ADBOT_DELETE + i)],
        [Button.inline("« Back to list", CB_ADBOT_BACK_TO_LIST)],
    ]


async def _admin_validate_sessions(
    data: dict,
    *,
    log: Optional[Callable[[str], Awaitable[None]]] = None,
    bot_token: Optional[str] = None,
) -> tuple[int, int]:
    """Validate sessions; move invalid to dead. If bot_token is set, only that bot's sessions; else all free + assigned. Returns (ok_count, dead_count)."""
    ok_count, dead_count = 0, 0
    data.setdefault("dead_sessions", [])
    if bot_token is None:
        free = list(data.get("free_sessions", []))
        total_assigned = sum(len(c.get("sessions", [])) for c in data.get("bots", {}).values())
        if log:
            await log(f"⏳ Validating {len(free)} free + {total_assigned} assigned sessions…")
        for i, fn in enumerate(free):
            if log and (i + 1) % 5 == 0:
                await log(f"⏳ Free: {i + 1}/{len(free)} checked…")
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                if fn not in data["dead_sessions"]:
                    data["dead_sessions"].append(fn)
                data["free_sessions"] = [x for x in data["free_sessions"] if x != fn]
                dead_count += 1
                continue
            if await validate_session(path):
                ok_count += 1
            else:
                dead_count += 1
                data["free_sessions"] = [x for x in data["free_sessions"] if x != fn]
                if fn not in data["dead_sessions"]:
                    data["dead_sessions"].append(fn)
        if log:
            await log("⏳ Checking assigned sessions per bot…")
    bots_iter: list[tuple[str, dict]] = (
        [(bot_token, data["bots"][bot_token])] if bot_token in data.get("bots", {}) else []
    ) if bot_token else list(data.get("bots", {}).items())
    for bt, cfg in bots_iter:
        if log:
            await log(f"⏳ {cfg.get('name', (bt or '')[:15])}…")
        for s in list(cfg.get("sessions", [])):
            fn = s.get("file")
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                cfg["sessions"] = [x for x in cfg["sessions"] if x.get("file") != fn]
                if fn not in data["dead_sessions"]:
                    data["dead_sessions"].append(fn)
                dead_count += 1
                continue
            if await validate_session(path):
                ok_count += 1
            else:
                cfg["sessions"] = [x for x in cfg["sessions"] if x.get("file") != fn]
                if fn not in data["dead_sessions"]:
                    data["dead_sessions"].append(fn)
                dead_count += 1
    save_adbot(data)
    return ok_count, dead_count


async def _admin_replace_dead(
    data: dict,
    *,
    log: Optional[Callable[[str], Awaitable[None]]] = None,
    bot_token: Optional[str] = None,
) -> str:
    """Replace missing sessions (file not in active/) from free_sessions. If bot_token set, only that bot; else all bots. Returns summary."""
    lines = []
    bots_items = [(bot_token, data["bots"][bot_token])] if bot_token and bot_token in data.get("bots", {}) else list(data.get("bots", {}).items())
    bots_with_missing = [
        (bt, cfg)
        for bt, cfg in bots_items
        if any(not (config.SESSIONS_ACTIVE / (s.get("file") or "")).is_file() for s in cfg.get("sessions", []))
    ]
    if log and bots_with_missing:
        await log(f"⏳ Replacing dead sessions for {len(bots_with_missing)} bot(s)…")
    for bot_token, cfg in bots_with_missing:
        if log:
            await log(f"⏳ {cfg.get('name', bot_token[:15])}…")
        sessions = list(cfg.get("sessions", []))
        missing = [s for s in sessions if not (config.SESSIONS_ACTIVE / (s.get("file") or "")).is_file()]
        if not missing:
            continue
        free = list(data.get("free_sessions", []))  # fresh each bot
        added = 0
        cfg.setdefault("session_replacements", [])
        for s in missing:
            old_fn = s.get("file") or ""
            sessions = [x for x in sessions if x != s]
            if not free:
                continue
            fn = free.pop(0)
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                free.insert(0, fn)
                continue
            if not await validate_session(path):
                data.setdefault("dead_sessions", []).append(fn)
                continue
            probe = await probe_session_identity(path)
            real_name = probe.get("full_name") or fn
            user_id = int(probe.get("user_id") or 0)
            if probe.get("status") != "busy":
                record_session_meta(fn, probe, validation_status="valid" if probe.get("status") == "active" else "unknown")
            new_s = {"file": fn, "real_name": real_name, "user_id": user_id, "index": len(sessions) + 1}
            sessions.append(new_s)
            data["free_sessions"] = [x for x in data.get("free_sessions", []) if x != fn]
            added += 1
            cfg["session_replacements"].append({
                "at": datetime.utcnow().isoformat() + "Z",
                "old_session": old_fn,
                "new_session": fn,
                "reason": "dead",
                "source": "admin_replace_dead",
            })
        cfg["sessions"] = sessions
        if cfg.get("session_replacements"):
            cfg["session_replacements"] = cfg["session_replacements"][-100:]
        if added:
            lines.append(f"{cfg.get('name', bot_token[:15])}: +{added} session(s)")
    save_adbot(data)
    return "Replace dead: " + ("; ".join(lines) if lines else "none replaced")


async def _admin_replace_error_sessions(
    data: dict,
    *,
    log: Optional[Callable[[str], Awaitable[None]]] = None,
    bot_token: Optional[str] = None,
) -> str:
    """Replace error sessions: remove invalid (validate fails), assign from free pool. If bot_token set, only that bot; else all bots."""
    lines = []
    data.setdefault("dead_sessions", [])
    bots_list = [(bot_token, data["bots"][bot_token])] if bot_token and bot_token in data.get("bots", {}) else list(data.get("bots", {}).items())
    if log:
        await log("⏳ Checking sessions for errors…")
    for bot_token, cfg in bots_list:
        sessions = list(cfg.get("sessions", []))
        to_remove = []
        for s in sessions:
            fn = s.get("file")
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                to_remove.append((s, fn))
                continue
            if not await validate_session(path):  # invalid → file already moved to dead/
                to_remove.append((s, fn))
        if not to_remove:
            continue
        if log:
            await log(f"⏳ Replacing error sessions: {cfg.get('name', bot_token[:15])}…")
        cfg.setdefault("session_replacements", [])
        free = list(data.get("free_sessions", []))  # fresh for each bot
        for s, fn in to_remove:
            sessions = [x for x in sessions if x != s]
            if fn not in data["dead_sessions"]:
                data["dead_sessions"].append(fn)
            candidate = None
            if free:
                candidate = free.pop(0)
                path = config.SESSIONS_ACTIVE / candidate
                if not path.is_file():
                    free.insert(0, candidate)
                    candidate = None
                elif not await validate_session(path):
                    data["dead_sessions"].append(candidate)
                    candidate = None
            if candidate:
                path = config.SESSIONS_ACTIVE / candidate
                probe = await probe_session_identity(path)
                real_name = probe.get("full_name") or candidate
                user_id = int(probe.get("user_id") or 0)
                if probe.get("status") != "busy":
                    record_session_meta(candidate, probe, validation_status="valid" if probe.get("status") == "active" else "unknown")
                sessions.append({"file": candidate, "real_name": real_name, "user_id": user_id, "index": len(sessions) + 1})
                data["free_sessions"] = [x for x in data.get("free_sessions", []) if x != candidate]
                cfg["session_replacements"].append({
                    "at": datetime.utcnow().isoformat() + "Z",
                    "old_session": fn,
                    "new_session": candidate,
                    "reason": "error",
                    "source": "admin_replace_error",
                })
        cfg["sessions"] = sessions
        if cfg.get("session_replacements"):
            cfg["session_replacements"] = cfg["session_replacements"][-100:]
        replaced = len(to_remove)
        if replaced:
            lines.append(f"{cfg.get('name', bot_token[:15])}: replaced {replaced} error session(s)")
    save_adbot(data)
    return "Replace error: " + ("; ".join(lines) if lines else "none replaced")


async def _admin_recreate_log_group(
    admin_client: Optional[TelegramClient], chat_id: int, bot_token: str, data: dict,
    *,
    log: Optional[Callable[[str], Awaitable[None]]] = None,
) -> str:
    """Recreate log group for one bot: new megagroup, invite bot, join sessions, update log_group."""
    cfg = data.get("bots", {}).get(bot_token)
    if not cfg:
        return "Bot not found."
    name = cfg.get("name", "AdBot")
    bot_username = cfg.get("bot_username", "")
    sessions = cfg.get("sessions", [])
    if not sessions:
        return "No sessions to join log group."
    first = config.SESSIONS_ACTIVE / sessions[0]["file"]
    if not first.is_file():
        return "First session file missing."
    creator = guarded_client(first, "log group setup", wait_timeout=20, expected_sec=120)
    try:
        if log:
            await log("⏳ Connecting first session…")
        await creator.connect()
        if not await creator.is_user_authorized():
            return "First session not authorized."
        from telethon.tl.types import Channel
        if log:
            await log("⏳ Creating log channel…")
        title = f"{name} AdBot Log"
        create_result = await creator(CreateChannelRequest(title=title, about="Hosted by @HQAdz", megagroup=True))
        channel = create_result.chats[0]
        if not isinstance(channel, Channel):
            return "Could not create channel."
        ch_id = channel.id
        ch_access = getattr(channel, "access_hash", 0) or 0
        input_ch = InputChannel(ch_id, ch_access)
        username = "adbot_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
        await creator(UpdateUsernameRequest(input_ch, username))
        entity = await creator.get_entity(ch_id)
        if log:
            await log("⏳ Inviting bot and setting admin…")
        bot_input = await creator.get_input_entity("@" + bot_username)
        await creator(InviteToChannelRequest(input_ch, [bot_input]))
        rights = ChatAdminRights(
            change_info=True, post_messages=True, edit_messages=True, delete_messages=True,
            invite_users=True, pin_messages=True, manage_call=True,
        )
        await creator(EditAdminRequest(input_ch, bot_input, rights, "AdBot"))
        invite_link = f"https://t.me/{username}"
        await creator.disconnect()
        # All assigned sessions must join the new log group
        if log:
            await log("⏳ Joining all assigned sessions to log group…")
        joined_count = 0
        failed: list[str] = []
        for i, s in enumerate(sessions):
            fn = s.get("file") or ""
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                failed.append(fn)
                continue
            if i > 0:
                await asyncio.sleep(1.5)
            c2 = guarded_client(path, "joining log group", wait_timeout=15, expected_sec=60)
            try:
                await c2.connect()
                if not await c2.is_user_authorized():
                    failed.append(fn)
                    continue
                try:
                    await join_chat_by_link(c2, invite_link)
                    joined_count += 1
                except Exception as je:
                    if "already" in str(je).lower():
                        joined_count += 1
                    else:
                        logger.warning("Join log group failed for %s: %s", fn, je)
                        failed.append(fn)
                        if log:
                            await log(f"⚠ Join failed for {fn}: {je!s}")
            finally:
                await c2.disconnect()
        data["bots"][bot_token]["log_group"] = f"https://t.me/{username}"
        save_adbot(data)
        total = len(sessions)
        if failed:
            return f"Log group recreated for {name}. {joined_count} of {total} sessions joined. Failed: {', '.join(failed)}."
        return f"Log group recreated for {name}. All {total} sessions joined."
    except Exception as e:
        logger.exception("Recreate log group: %s", e)
        return f"Error: {e}"
    finally:
        try:
            await creator.disconnect()
        except Exception:
            pass


async def _handle_del_session(
    client: TelegramClient, event: events.CallbackQuery.Event, data: dict, prefix: bytes, key: str, base_dir: Path
) -> None:
    """Remove session from list and delete file. prefix in (PREFIX_DEL_FREE, PREFIX_DEL_DEAD)."""
    raw = event.data
    if not raw.startswith(prefix):
        return
    name = raw[len(prefix) :].decode("utf-8", errors="replace")
    lst = data.get(key, [])
    if name not in lst:
        await event.answer("Already removed.", alert=True)
        return
    data[key] = [x for x in lst if x != name]
    save_adbot(data)
    path = base_dir / name
    if path.is_file():
        try:
            path.unlink()
        except OSError as e:
            logger.warning("Could not delete %s: %s", path, e)
    await event.answer("Removed.")
    text, buttons = _manage_sessions_text_and_buttons(data)
    await event.edit(text, buttons=buttons)


def _unique_session_path(base_name: str) -> Path:
    """Return a path in SESSIONS_ACTIVE for base_name (e.g. 'x.session'), unique so uploads don't overwrite."""
    return _unique_path_in_dir(config.SESSIONS_ACTIVE, base_name)


def _unique_path_in_dir(dest_dir: Path, base_name: str) -> Path:
    """Return a path in dest_dir for base_name, unique so uploads don't overwrite."""
    p = dest_dir / base_name
    if not p.exists():
        return p
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix or ".session"
    n = 1
    while True:
        p = dest_dir / f"{stem}_{n}{suffix}"
        if not p.exists():
            return p
        n += 1


def _extract_zip_and_copy_sessions(zip_path: Path, tmp_path: Path, dest_dir: Path) -> list[Path]:
    """Sync: open zip, extractall, copy each .session to dest_dir with unique name. Must run off main loop (Fix #3). Returns list of dest paths."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(tmp_path)
    dests: list[Path] = []
    for extracted in Path(tmp_path).rglob("*.session"):
        if not extracted.is_file():
            continue
        base = extracted.name
        dest = _unique_path_in_dir(dest_dir, base)
        shutil.copy2(extracted, dest)
        dests.append(dest)
    return dests


def _all_known_session_files(data: dict) -> set[str]:
    """Session filenames that are already in free_sessions or assigned to any bot. Skip these on upload."""
    known: set[str] = set(data.get("free_sessions", []))
    for cfg in data.get("bots", {}).values():
        for s in cfg.get("sessions", []):
            fn = s.get("file")
            if fn:
                known.add(fn)
    return known


async def _process_upload(
    client: TelegramClient, event: events.NewMessage.Event, path: Path, data: dict
) -> tuple[int, int]:
    """Validate session at path, add to free_sessions or dead_sessions. Skip if already known. Return (added_free, added_dead)."""
    return await _process_upload_standalone(path, data)


async def _process_upload_standalone(path: Path, data: dict) -> tuple[int, int]:
    """Validate session at path, add to free_sessions or dead_sessions. No Telethon event. Return (added_free, added_dead). Used by PTB admin."""
    added_f, added_d = 0, 0
    path = path.resolve()
    if not path.suffix.lower() == ".session":
        return 0, 0
    name = path.name
    known = _all_known_session_files(data)
    if name in known:
        return 0, 0
    dest = config.SESSIONS_ACTIVE / name
    if path != dest:
        shutil.copy2(path, dest)
        work = dest
    else:
        work = path
    ok = await validate_session(work)
    if ok:
        if name not in data["free_sessions"]:
            data["free_sessions"].append(name)
            added_f += 1
    else:
        if name not in data["dead_sessions"]:
            data["dead_sessions"].append(name)
            added_d += 1
    return added_f, added_d


def _create_status_text(data: dict) -> str:
    """Status line for Create AdBot screen."""
    t, dead, assigned, free = _session_counts(data)
    hosted = len(data.get("bots", {}))
    return f"Hosted bots: {hosted} | Total: {t} | Dead: {dead} | Assigned: {assigned} | Free: {free}"


def _clear_create_state(uid: int) -> None:
    _create_state.pop(uid, None)


async def _create_send(client: TelegramClient, chat_id: int, text: str, buttons: list | None = None) -> None:
    """Send or edit a message in create flow; no buttons if None."""
    await client.send_message(chat_id, text, buttons=buttons or [])


def _set_bot_profile_via_api(bot_token: str, bot_name: str, description: str, short_description: str) -> None:
    """Set bot name, description, and short description via Telegram Bot API. Sync, safe to call from worker thread."""
    base = f"https://api.telegram.org/bot{bot_token}"
    for method, param, value in (
        ("setMyName", "name", bot_name),
        ("setMyDescription", "description", description),
        ("setMyShortDescription", "short_description", short_description),
    ):
        try:
            url = f"{base}/{method}?{urllib.parse.urlencode({param: value})}"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status != 200:
                    logger.debug("Bot API %s returned %s", method, resp.status)
        except Exception as e:
            logger.debug("Bot API %s failed: %s", method, e)


def _cleanup_creation_temp_sessions(session_base_path: Path) -> None:
    """Remove temporary session files used during creation (not in pool, not assigned). Runs even on failure."""
    for ext in ("", ".session", ".session-journal"):
        p = Path(str(session_base_path) + ext)
        if p.exists():
            try:
                p.unlink()
                logger.debug("Removed creation temp session file: %s", p)
            except OSError as e:
                logger.warning("Could not remove temp session %s: %s", p, e)


async def _core_create_adbot_async(
    form: dict, adbot_data: dict, log_async: Callable[[str], Awaitable[None]]
) -> str | None:
    """Core create workflow; does NOT touch main-loop clients. log_async(msg) is awaited for progress. Returns @username or None."""
    name = form.get("name", "").strip()
    bot_token = form.get("bot_token", "").strip()
    bot_username = form.get("bot_username", "")
    # Reject duplicate token: avoid orphan user files and broken index
    if bot_token and get_name_by_token(bot_token):
        form["_result_reason"] = "bot_token_already_registered"
        await log_async("This bot token is already linked to an AdBot. Use a different token or manage the existing bot.")
        return None
    sessions_count = min(
        max(1, int(form.get("sessions_count", 0))), config.MAX_SESSIONS_PER_BOT
    )
    cycle = max(1, int(form.get("cycle", 3600)))
    gap = max(1, int(form.get("gap", 5)))
    valid_till = form.get("valid_till", "")
    mode = (form.get("mode") or "Starter").strip().capitalize()
    group_file = form.get("group_file", "Starter.txt")
    creation_tmp_path = config.DATA_DIR / "_creation_tmp_bot"

    try:
        gf_path = config.GROUPS_DIR / group_file
        if not gf_path.is_file():
            await log_async("Group file does not exist. Posting will have no groups.")
        elif gf_path.stat().st_size == 0:
            await log_async("Group file is empty. Posting will have no groups.")
        await log_async("Starting AdBot setup…")
        await log_async("Configuring bot profile…")
        bot_client = TelegramClient(
            str(creation_tmp_path), config.API_ID, config.API_HASH, proxy=config.PROXY
        )
        await bot_client.start(bot_token=bot_token)
        if not bot_username:
            try:
                me = await bot_client.get_me()
                bot_username = (me.username or "").strip()
            except Exception:
                pass
        try:
            from telethon.tl.functions.account import UpdateProfileRequest
            await bot_client(UpdateProfileRequest(first_name=f"{name} Bot", about=BOT_PROFILE_DESCRIPTION))
        except Exception:
            pass
        # Set random bot profile picture from uploaded images (skip on any error; notify admin once)
        pfp_candidates = list(BOT_PFP_REL)
        random.shuffle(pfp_candidates)
        pfp_set = False
        pfp_alert_sent = False
        for pfp_rel in pfp_candidates:
            pfp_path = config.BASE_DIR / pfp_rel
            if not pfp_path.is_file():
                continue
            try:
                from telethon.tl.functions.photos import UploadProfilePhotoRequest
                # TL photos.uploadProfilePhoto: file=InputFile (from client.upload_file)
                uploaded = await bot_client.upload_file(str(pfp_path))
                await bot_client(UploadProfilePhotoRequest(file=uploaded))
                pfp_set = True
                break
            except Exception as e:
                err_msg = str(e).strip() or type(e).__name__
                logger.warning("Bot profile photo failed (skip): path=%s error=%s", pfp_rel, err_msg)
                if not pfp_alert_sent:
                    pfp_alert_sent = True
                    add_admin_alert(
                        "bot_pfp_failed",
                        f"AdBot {name} created but profile photo could not be set. Error: {err_msg}. You can set it manually in BotFather.",
                    )
        if not pfp_set and not any((config.BASE_DIR / p).is_file() for p in BOT_PFP_REL):
            logger.debug("No bot pfp file found (data/Bot 1.jpeg or data/bot 2.jpeg), skipping profile photo.")
        await bot_client.disconnect()
        _set_bot_profile_via_api(
            bot_token,
            bot_name=f"{name} Bot",
            description=BOT_PROFILE_DESCRIPTION,
            short_description=BOT_PROFILE_SHORT_DESCRIPTION,
        )

        skip_health_check = bool(form.get("skip_health_check"))
        skip_chatlist_join = bool(form.get("skip_chatlist_join"))
        await log_async("Assigning sessions…" if not skip_health_check else "Assigning sessions (health check skipped)…")
        free_list = list(adbot_data.get("free_sessions", []))
        assigned: list[dict] = []
        for fn in free_list:
            if len(assigned) >= sessions_count:
                break
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                adbot_data["free_sessions"] = [x for x in adbot_data["free_sessions"] if x != fn]
                adbot_data.setdefault("dead_sessions", [])
                if fn not in adbot_data["dead_sessions"]:
                    adbot_data["dead_sessions"].append(fn)
                await log_async(f"Session {fn} missing; trying next.")
                continue
            if not skip_health_check:
                ok = await validate_session(path)
                if not ok:
                    adbot_data["free_sessions"] = [x for x in adbot_data["free_sessions"] if x != fn]
                    adbot_data.setdefault("dead_sessions", [])
                    if fn not in adbot_data["dead_sessions"]:
                        adbot_data["dead_sessions"].append(fn)
                    await log_async(f"Session {fn} invalid; trying next.")
                    continue
            if fn in adbot_data.get("free_sessions", []):
                adbot_data["free_sessions"] = [x for x in adbot_data["free_sessions"] if x != fn]
            probe = await probe_session_identity(path)
            if probe.get("status") not in ("active", "busy") and skip_health_check:
                await log_async(f"Session {fn} info lookup failed (using anyway): {probe.get('error', '')}")
            real_name = probe.get("full_name") or fn
            user_id = int(probe.get("user_id") or 0)
            if probe.get("status") != "busy":
                record_session_meta(fn, probe, validation_status="valid" if probe.get("status") == "active" else "unknown")
            assigned.append({"file": fn, "real_name": real_name, "user_id": user_id, "index": len(assigned) + 1})

        if len(assigned) < sessions_count:
            await log_async(f"Not enough valid sessions: need {sessions_count}, got {len(assigned)}. Order queued; add more sessions and use Recreate.")
            form["_result_reason"] = "insufficient_valid_sessions"
            form["_assigned_count"] = len(assigned)
            form["_required_count"] = sessions_count
            # Return the sessions we already claimed back to the free pool. Without this
            # they were popped out of free_sessions but never bound to a bot — leaking good
            # accounts into limbo until the nightly integrity scan recovers them.
            for _s in assigned:
                _fn = _s.get("file")
                if _fn and _fn not in adbot_data.get("free_sessions", []):
                    adbot_data.setdefault("free_sessions", []).append(_fn)
            save_adbot(adbot_data)
            return None
        if not assigned:
            await log_async("No valid sessions could be assigned.")
            return None

        await log_async("Creating log group…")
        from telethon.tl.types import Channel
        title = f"{name} AdBot Log"
        about = "Hosted by @HQAdz"
        username = "adbot_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))

        creator = None
        input_ch = None
        ch_id = None
        created_with_session: str | None = None

        for s in assigned:
            fn = s.get("file") or ""
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                continue
            client = guarded_client(path, "log group setup", wait_timeout=20, expected_sec=120)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    logger.debug("Log group creator attempt: session %s not authorized", fn)
                    continue
                try:
                    create_result = await client(CreateChannelRequest(title=title, about=about, megagroup=True))
                    channel = create_result.chats[0]
                    if not isinstance(channel, Channel):
                        continue
                    ch_id = channel.id
                    ch_access = getattr(channel, "access_hash", 0) or 0
                    input_ch = InputChannel(ch_id, ch_access)
                    creator = client
                    created_with_session = fn
                    logger.info("Log group created using session: %s", fn)
                    break
                except _CREATE_GROUP_RETRYABLE as e:
                    logger.warning("Log group creation failed for session %s (trying next): %s", fn, e)
                    await log_async(f"Session {fn} cannot create group: {e!s}. Trying next.")
                except Exception as e:
                    if "spam" in str(e).lower() or "restricted" in str(e).lower():
                        logger.warning("Log group creation failed for session %s (restriction, trying next): %s", fn, e)
                        await log_async(f"Session {fn} restricted: {e!s}. Trying next.")
                    else:
                        logger.warning("Log group creation failed for session %s (trying next): %s", fn, e)
                        await log_async(f"Session {fn} failed: {e!s}. Trying next.")
            except Exception as e:
                logger.warning("Log group creator connect/check failed for %s: %s", fn, e)
            finally:
                if creator is not client:
                    try:
                        await client.disconnect()
                    except Exception:
                        pass

        if creator is None or input_ch is None:
            err_msg = "All available sessions are unable to create the log group. Please replace restricted accounts."
            await log_async(err_msg)
            add_admin_alert("create_failed", err_msg)
            return None

        try:
            await creator(UpdateUsernameRequest(input_ch, username))
            entity = await creator.get_entity(ch_id)

            bot_input = await creator.get_input_entity("@" + bot_username)
            await creator(InviteToChannelRequest(input_ch, [bot_input]))
            rights = ChatAdminRights(
                change_info=True, post_messages=True, edit_messages=True, delete_messages=True,
                invite_users=True, pin_messages=True, manage_call=True,
            )
            await creator(EditAdminRequest(input_ch, bot_input, rights, "AdBot"))

            invite_link = f"https://t.me/{username}"
            await creator.disconnect()

            await log_async("Joining all assigned sessions to log group…")
            joined_files: list[str] = []
            failed_joins: list[tuple[str, str]] = []
            for i, s in enumerate(assigned):
                fn = s.get("file") or ""
                if not fn:
                    continue
                path = config.SESSIONS_ACTIVE / fn
                if not path.is_file():
                    failed_joins.append((fn, "file missing"))
                    continue
                if i > 0:
                    await asyncio.sleep(1.5)
                c2 = guarded_client(path, "joining log group", wait_timeout=15, expected_sec=60)
                try:
                    await c2.connect()
                    if not await c2.is_user_authorized():
                        failed_joins.append((fn, "not authorized"))
                        continue
                    try:
                        await join_chat_by_link(c2, invite_link)
                        joined_files.append(fn)
                    except Exception as je:
                        if "already" in str(je).lower():
                            joined_files.append(fn)
                        else:
                            logger.warning("Join log group failed for %s: %s", fn, je)
                            failed_joins.append((fn, str(je)))
                            await log_async(f"Join failed for {fn}: {je!s}")
                finally:
                    await c2.disconnect()
            total = len(assigned)
            n_joined = len(joined_files)
            if total > 0:
                if failed_joins:
                    await log_async(f"Log group joins: {n_joined} of {total} sessions joined. Failed: {', '.join(f[0] for f in failed_joins)}.")
                else:
                    await log_async(f"All {total} assigned sessions joined the log group.")
        finally:
            try:
                await creator.disconnect()
            except Exception:
                pass

        log_group_link = f"https://t.me/{username}"
        safe_name = name_to_filename(name)
        existing_safe = {p.stem for p in config.DATA_USER_DIR.glob("*.json")}
        suffix = 2
        while safe_name in existing_safe:
            safe_name = f"{name_to_filename(name)}_{suffix}"
            suffix += 1
        plan_name = str(form.get("plan_name") or "Custom").strip()
        renewal_price = str(form.get("renewal_price") or "0").strip()
        renewal_prices = form.get("renewal_prices") if isinstance(form.get("renewal_prices"), dict) else {"7d": None, "30d": None}
        plan_mode = str(form.get("mode") or "Starter").strip().capitalize()
        session_count_val = int(form.get("sessions_count") or len(assigned))
        authorized = []
        owner_id_val = 0
        if form.get("source") == "shop" and form.get("user_id") is not None:
            try:
                uid = int(form["user_id"])
                if uid and uid not in authorized:
                    authorized.append(uid)
                    owner_id_val = uid  # save the Telegram buyer as the bot owner
            except (TypeError, ValueError):
                pass
        from datetime import datetime as _dt
        last_renewal_at = _dt.utcnow().isoformat() + "Z" if form.get("source") == "shop" else ""
        last_renewal_days = int(form.get("duration_days", 0)) if form.get("source") == "shop" else 0
        from .user_config import build_plan_section, build_history_section, build_stats_section
        plan = build_plan_section(
            name=plan_name,
            mode=plan_mode,
            cycle=cycle,
            gap=gap,
            session_count=session_count_val,
        )
        history = build_history_section()
        if last_renewal_at and last_renewal_days:
            history["renewals"] = [{"at": last_renewal_at, "days": last_renewal_days, "order_id": str(form.get("order_id", "")), "source": "creation"}]
        web_token = (form.get("_web_token") or "").strip() or "".join(random.choices(string.ascii_letters + string.digits, k=8))
        entry = {
            "name": name,
            "bot_token": bot_token,
            "bot_username": bot_username,
            "valid_till": valid_till,
            "cycle": cycle,
            "gap": gap,
            "mode": mode,
            "group_file": group_file,
            "log_group": log_group_link,
            "log_file": f"data/logs/{safe_name}.log",
            "authorized": authorized,
            "owner_id": owner_id_val,
            "sessions": assigned,
            "state": "stopped",
            "last_cycle_time": {},
            "plan_name": plan_name,
            "renewal_price": renewal_price,
            "legacy_renewal_price": renewal_price if renewal_price not in ("", "0", "0.0") else "",
            "renewal_prices": {
                "7d": renewal_prices.get("7d"),
                "30d": renewal_prices.get("30d"),
            },
            "plan_mode": plan_mode,
            "session_count": session_count_val,
            "plan": plan,
            "free_replacements_limit": int(plan.get("free_replacements", 0)) if isinstance(plan, dict) else 0,
            "replacements_used": 0,
            "history": history,
            "stats": build_stats_section(),
            "transactions": [],
            "web_token": web_token,
        }
        if last_renewal_at:
            entry["last_renewal_at"] = last_renewal_at
        if last_renewal_days:
            entry["last_renewal_days"] = last_renewal_days
            entry["renewal_history"] = history["renewals"]
        await log_async("Finalizing setup…")
        pool = load_pool()
        pool["free_sessions"] = list(adbot_data.get("free_sessions", []))
        pool["dead_sessions"] = list(adbot_data.get("dead_sessions", []))
        pool.setdefault("admin_alerts", [])
        save_pool(pool)
        save_user_data(safe_name, entry)
        logger.info("[CREATE_PIPELINE] user JSON created name=%s order_id=%s", safe_name, form.get("order_id", ""))
        # Auto-join default chatlist for this mode (so sessions have the right groups)
        if skip_chatlist_join:
            await log_async("Default chatlist auto-join skipped.")
        try:
            from .chatlist import default_chatlist_links_for_mode, join_default_chatlist_on_sessions
            default_links = [] if skip_chatlist_join else default_chatlist_links_for_mode(mode)
            if default_links:
                await log_async(f"Joining {len(default_links)} default chatlist folder(s) on sessions…")
                joined, failed = await join_default_chatlist_on_sessions(entry, mode, progress_cb=log_async)
                await log_async(f"Default chatlist: {joined} joined, {failed} failed.")
                # Save updated config (group_file may have changed)
                save_user_data(safe_name, entry)
        except Exception as e:
            logger.warning("[CREATE_PIPELINE] Default chatlist join failed (non-fatal): %s", e)
        add_admin_alert("bot_created", f"AdBot {name} created: @{bot_username}")
        await log_async(f"AdBot successfully created: @{bot_username}")
        form["_web_token"] = web_token
        return f"@{bot_username}"
    except Exception as e:
        logger.exception("_core_create_adbot_async: %s", e)
        await log_async(f"Error: {e}")
        return None
    finally:
        _cleanup_creation_temp_sessions(creation_tmp_path)


async def _progress_consumer(
    progress_queue: queue_module.Queue,
    admin_client: TelegramClient,
) -> None:
    """Run on main loop: consume (chat_id, msg_id, msg) from queue and edit progress message; stop on None."""
    while True:
        item = await asyncio.to_thread(progress_queue.get)
        if item is None:
            return
        chat_id, msg_id, msg = item
        try:
            await admin_client.edit_message(chat_id, msg_id, msg)
        except Exception:
            try:
                await admin_client.send_message(chat_id, msg)
            except Exception:
                pass


def _sync_execute_create_adbot(
    chat_id: int, msg_id: int, form: dict, adbot_data: dict,
    progress_queue: queue_module.Queue,
) -> str | None:
    """Run full create workflow in a background thread; does NOT touch main-loop clients. Progress via progress_queue (chat_id, msg_id, msg); puts None when done. Returns @username or None."""
    order_id = form.get("order_id", "")

    async def log_async(msg: str) -> None:
        logger.info("[CREATE_PROGRESS] worker step order_id=%s msg=%s", order_id, msg[:80])
        progress_queue.put((chat_id, msg_id, msg))

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_core_create_adbot_async(form, adbot_data, log_async))
    finally:
        progress_queue.put(None)
        loop.close()


def _get_system_stats() -> list[str]:
    """Sync: CPU, RAM, disk, uptime, connectivity. Run off main loop (e.g. asyncio.to_thread). Returns list of lines."""
    lines: list[str] = []
    issues: list[str] = []
    if not psutil:
        return ["`psutil` not installed. Run: pip install psutil"]
    try:
        # CPU (1s sample — blocks)
        cpu = psutil.cpu_percent(interval=1)
        cpu_status = "⚠ High" if cpu >= 90 else ("⚡ Elevated" if cpu >= 70 else "✓ Normal")
        if cpu >= 90:
            issues.append("High CPU")
        lines.append(f"**CPU:** {cpu:.1f}% — {cpu_status}")

        # RAM
        vm = psutil.virtual_memory()
        used_gb = vm.used / (1024**3)
        total_gb = vm.total / (1024**3)
        ram_status = "⚠ Heavy" if vm.percent >= 90 else ("⚡ High" if vm.percent >= 75 else "✓ Normal")
        if vm.percent >= 90:
            issues.append("High RAM")
        lines.append(f"**RAM:** {vm.percent:.1f}% ({used_gb:.2f} / {total_gb:.2f} GB) — {ram_status}")

        # Disk (project root or /)
        try:
            du = psutil.disk_usage(str(config.BASE_DIR))
        except Exception:
            du = psutil.disk_usage("/")
        used_disk_gb = du.used / (1024**3)
        total_disk_gb = du.total / (1024**3)
        disk_status = "⚠ Low space" if du.percent >= 90 else ("⚡ High" if du.percent >= 80 else "✓ Normal")
        if du.percent >= 90:
            issues.append("Low disk")
        lines.append(f"**Storage:** {du.percent:.1f}% ({used_disk_gb:.2f} / {total_disk_gb:.2f} GB) — {disk_status}")

        # Uptime (this process)
        try:
            proc = psutil.Process()
            uptime_sec = time.time() - proc.create_time()
            days = int(uptime_sec // 86400)
            hours = int((uptime_sec % 86400) // 3600)
            mins = int((uptime_sec % 3600) // 60)
            if days > 0:
                lines.append(f"**Uptime:** {days}d {hours}h {mins}m")
            else:
                lines.append(f"**Uptime:** {hours}h {mins}m")
        except Exception:
            lines.append("**Uptime:** —")

        # Connectivity (Telegram API)
        try:
            start = time.perf_counter()
            sock = socket.create_connection(("api.telegram.org", 443), timeout=5)
            sock.close()
            latency_ms = (time.perf_counter() - start) * 1000
            conn_status = "⚠ Slow" if latency_ms > 2000 else ("✓ OK" if latency_ms < 500 else "⚡ OK")
            if latency_ms > 2000:
                issues.append("Slow connectivity")
            lines.append(f"**Telegram API:** {latency_ms:.0f} ms — {conn_status}")
        except Exception as e:
            issues.append("Connectivity issue")
            lines.append(f"**Telegram API:** unreachable — _{str(e)[:50]}_")

        if issues:
            lines.append("")
            lines.append("**Issues:** " + ", ".join(issues))
    except Exception as e:
        logger.exception("_get_system_stats: %s", e)
        lines.append(f"Error: {e}")
    return lines


async def execute_create_adbot(
    admin_client: TelegramClient, chat_id: int, msg_id: int, form: dict, adbot_data: dict
) -> str | None:
    """Run the full create workflow on the main loop (legacy path); edit one progress message for real-time updates. Returns @username or None on failure."""
    async def log(msg: str) -> None:
        try:
            await admin_client.edit_message(chat_id, msg_id, msg)
        except Exception:
            await admin_client.send_message(chat_id, msg)
    return await _core_create_adbot_async(form, adbot_data, log)


def _create_worker_loop() -> None:
    """Background thread: consume create jobs, run _sync_execute_create_adbot, push result. Idempotent by order_id. Exits when _create_worker_restart_requested is set."""
    while True:
        try:
            job = _create_job_queue.get(timeout=60)
        except queue_module.Empty:
            _write_create_heartbeat()
            if _create_worker_restart_requested.is_set():
                break
            continue
        if job is None or (isinstance(job, tuple) and len(job) >= 1 and job[0] is None):
            break
        chat_id, msg_id, form, progress_queue = job
        logger.info("[CREATE_PIPELINE] job→worker started order_id=%s chat_id=%s msg_id=%s", form.get("order_id", ""), chat_id, msg_id)
        try:
            from .maintenance import is_maintenance_enabled
            if is_maintenance_enabled():
                logger.info("[CREATE_PIPELINE] worker deferred (maintenance mode) order_id=%s", form.get("order_id", ""))
                _create_job_queue.put(job)
                time.sleep(30)
                continue
        except Exception as e:
            logger.warning("[CREATE_PIPELINE] worker maintenance check failed: %s", e)
        _write_create_heartbeat()
        order_id = form.get("order_id")
        if order_id:
            try:
                from .shop.storage import get_order, update_order_status
                order = get_order(order_id)
                if order and order.get("status") == "completed":
                    logger.info("[CREATE_PIPELINE] worker skipping (order already completed) order_id=%s", order_id)
                    _result_queue.put((chat_id, msg_id, order.get("created_bot_username") or "", form))
                    continue
                if order and order.get("status") == "creating":
                    creating_since = order.get("creating_since") or ""
                    try:
                        parsed = datetime.fromisoformat(creating_since.replace("Z", "+00:00"))
                        if parsed.tzinfo is None:
                            parsed = parsed.replace(tzinfo=timezone.utc)
                        now_utc = datetime.now(timezone.utc)
                        if (now_utc - parsed) <= timedelta(minutes=CREATE_ORDER_STALE_CREATING_MIN):
                            logger.info("[CREATE_PIPELINE] worker skipping (already_creating) order_id=%s", order_id)
                            form["_result_reason"] = "already_creating"
                            _result_queue.put((chat_id, msg_id, None, form))
                            continue
                    except Exception:
                        pass
                    # Stale or no timestamp: reset so this job can run
                    logger.info("[CREATE_PIPELINE] worker resetting stuck creating→pending_creation order_id=%s", order_id)
                    update_order_status(order_id, "pending_creation")
                update_order_status(order_id, "creating", creating_since=datetime.utcnow().isoformat() + "Z")
            except Exception as e:
                logger.warning("Create worker order idempotency check: %s", e)
        logger.debug("[CREATE_PIPELINE] worker acquiring creation_pool_lock order_id=%s", order_id or "")
        with creation_pool_lock:
            adbot_data = load_adbot()
            username = _sync_execute_create_adbot(chat_id, msg_id, form, adbot_data, progress_queue)
        logger.debug("[CREATE_PIPELINE] worker released creation_pool_lock order_id=%s", order_id or "")
        _write_create_heartbeat()
        _result_queue.put((chat_id, msg_id, username, form))
        logger.info("[CREATE_PIPELINE] worker result_queued order_id=%s username=%s", order_id or "", username or "(failed)")


def _start_create_worker_if_needed() -> None:
    """Start create worker threads (up to MAX_CONCURRENT_CREATE_JOBS). Queue saturation protection."""
    global _create_worker_threads
    with _create_worker_started:
        alive = [t for t in _create_worker_threads if t.is_alive()]
        if len(alive) >= MAX_CONCURRENT_CREATE_JOBS:
            return
        _create_worker_threads = alive
        for _ in range(MAX_CONCURRENT_CREATE_JOBS - len(_create_worker_threads)):
            t = threading.Thread(target=_create_worker_loop, daemon=True)
            t.start()
            _create_worker_threads.append(t)
        logger.info("Create worker threads started: %s concurrent", len(_create_worker_threads))


def request_create_worker_restart() -> None:
    """Ask create worker threads to exit; caller should then _start_create_worker_if_needed(). Used by watchdog."""
    _create_worker_restart_requested.set()
    with _create_worker_started:
        to_join = list(_create_worker_threads)
        _create_worker_threads.clear()
    for t in to_join:
        t.join(timeout=70)
    _create_worker_restart_requested.clear()


async def _result_consumer(admin_client: TelegramClient) -> None:
    """Main loop: consume result queue, edit final message and start user bot. Fix #2."""
    while True:
        chat_id, msg_id, username, form = await asyncio.to_thread(_result_queue.get)
        bot_token = (form.get("bot_token") or "").strip()
        if username:
            if bot_token:
                asyncio.create_task(create_user_bot(bot_token))
            try:
                await admin_client.edit_message(
                    chat_id, msg_id,
                    f"✅ Bot created: {username}\nYou can send /start to the bot now.",
                )
            except Exception:
                pass
        else:
            try:
                await admin_client.edit_message(chat_id, msg_id, "❌ Create failed. Check message above.")
            except Exception:
                pass


async def run_admin_bot() -> None:
    """Start the admin bot using ADMIN_BOT_TOKEN; runs until disconnected."""
    session_path = str(config.SESSIONS_DIR / "admin_bot")
    client = TelegramClient(
        session_path,
        config.API_ID,
        config.API_HASH,
        proxy=config.PROXY,
    )
    register_for_shutdown(client)

    @client.on(events.NewMessage(pattern=r"^/start\s*$"))
    async def on_start(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id):
            await event.reply("Unauthorized.")
            return
        uid = event.sender_id
        _add_mode.discard(uid)
        _add_batch_totals.pop(uid, None)
        _add_last_msg.pop(uid, None)
        await event.reply(
            "Admin menu:",
            buttons=_main_menu_buttons(),
        )

    @client.on(events.NewMessage(pattern=r"^/cmd\s*$"))
    async def on_cmd(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id):
            return
        lines = [
            "**Admin commands**",
            "/start — Main menu",
            "/cmd — This list",
            "/health — Overview of all bots, valid till, sessions, alerts",
            "/cpu — CPU, RAM, disk, uptime, connectivity",
            "/logs — Send today's log files (main + per-bot)",
            "",
            "**Actions (via menu)**",
            "Create AdBots — New AdBot wizard",
            "Manage Sessions — Add/remove session files",
            "Manage AdBots — Validate, Replace dead/error, Recreate logs",
        ]
        await event.reply("\n".join(lines), parse_mode="md")

    @client.on(events.NewMessage(pattern=r"^/cpu\s*$"))
    async def on_cpu(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id):
            return
        progress = await event.reply("Checking CPU, RAM, disk, uptime, connectivity…")
        try:
            lines = await asyncio.to_thread(_get_system_stats)
            text = "\n".join(lines) if lines else "No data."
            try:
                await progress.edit(text, parse_mode="md")
            except Exception:
                await progress.edit(text)
        except Exception as e:
            logger.exception("on_cpu: %s", e)
            try:
                await progress.edit(f"Error: {e}")
            except Exception:
                pass

    @client.on(events.NewMessage(pattern=r"^/health\s*$"))
    async def on_health(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id):
            return
        data = load_adbot()
        bots = data.get("bots", {})
        lines = ["**Health overview**"]
        for token, cfg in bots.items():
            name = cfg.get("name") or token[:15]
            state = cfg.get("state", "stopped")
            valid = cfg.get("valid_till", "—")
            sessions = cfg.get("sessions", [])
            active = sum(1 for s in sessions if (config.SESSIONS_ACTIVE / (s.get("file") or "")).is_file())
            dead = len(sessions) - active
            workers = _workers_alive(token) if state == "running" else 0
            lines.append(f"• **{name}** — {state} | valid: {valid} | sessions: {active} ok / {dead} dead | workers: {workers}/{len(sessions)}")
            if cfg.get("state") == "dead" and cfg.get("dead_reason"):
                lines.append(f"  _reason: {cfg['dead_reason'][:80]}…_" if len(cfg.get("dead_reason", "")) > 80 else f"  _reason: {cfg['dead_reason']}_")
        alerts = data.get("admin_alerts", [])[-10:]
        if alerts:
            lines.append("\n**Recent alerts**")
            for a in reversed(alerts):
                msg = (a.get("msg") or str(a))[:100]
                lines.append(f"  {msg}")
        await event.reply("\n".join(lines) if lines else "No bots.", parse_mode="md")

    @client.on(events.NewMessage(pattern=r"^/logs\s*$"))
    async def on_logs(event: events.NewMessage.Event) -> None:
        """Send today's log files: main adbot.log and all per-bot logs."""
        if not _is_authorized(event.sender_id):
            return
        progress = await event.reply("Collecting log files…")
        try:
            to_send = []
            main_log = config.LOGS_DIR / "adbot.log"
            if main_log.is_file():
                to_send.append(main_log)
            bots_dir = config.LOGS_DIR / "bots"
            if bots_dir.is_dir():
                for p in sorted(bots_dir.glob("*.log")):
                    if p.is_file():
                        to_send.append(p)
            if not to_send:
                await progress.edit("No log files found for today.")
                return
            await progress.edit(f"Sending {len(to_send)} log file(s)…")
            for path in to_send:
                try:
                    await client.send_file(event.chat_id, path, caption=path.name)
                except Exception as e:
                    logger.warning("Failed to send log %s: %s", path.name, e)
                    try:
                        await client.send_message(event.chat_id, f"Could not send {path.name}: {e}")
                    except Exception:
                        pass
            try:
                await progress.delete()
            except Exception:
                pass
        except Exception as e:
            logger.exception("on_logs: %s", e)
            try:
                await progress.edit(f"Error: {e}")
            except Exception:
                pass

    @client.on(events.CallbackQuery())
    async def on_callback(event: events.CallbackQuery.Event) -> None:
        if not _is_authorized(event.sender_id):
            await event.answer("Unauthorized.", alert=True)
            return
        data = load_adbot()
        raw = event.data

        if raw == CB_CREATE_ADBOTS:
            await event.answer()
            text = _create_status_text(data) + "\n\nProceed to create a new AdBot?"
            _create_state[event.sender_id] = {"step": "ask_proceed", "data": {}, "chat_id": event.chat_id}
            await event.edit(text, buttons=[[Button.inline("Proceed", CB_CREATE_PROCEED), Button.inline("Cancel", CB_CREATE_CANCEL)]])
        elif raw == CB_CREATE_PROCEED:
            st = _create_state.get(event.sender_id)
            if not st or st.get("step") != "ask_proceed":
                await event.answer("Start from Create AdBots again.", alert=True)
                return
            await event.answer()
            t, dead, assigned, free = _session_counts(data)
            if free == 0:
                await event.edit("❌ No free sessions. Add sessions in **Manage Sessions** first.", parse_mode="md", buttons=_main_menu_buttons())
                return
            _create_state[event.sender_id]["step"] = "name"
            await event.edit("Enter internal name (e.g. buyer2):")
        elif raw == CB_CREATE_CANCEL:
            uid = event.sender_id
            _clear_create_state(uid)
            await event.answer()
            await event.edit("Cancelled.", buttons=_main_menu_buttons())
        elif raw == CB_MODE_STARTER:
            st = _create_state.get(event.sender_id)
            if not st:
                await event.answer()
                return
            await event.answer()
            st["data"]["mode"] = "Starter"
            st["step"] = "group_file"
            data = load_adbot()
            files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
            if not files:
                await event.edit("No .txt files in groups/. Create one and try again.", buttons=[[Button.inline("« Back", CB_CREATE_CANCEL)]])
                return
            rows = [[Button.inline(f.name, PREFIX_GROUP_FILE + f.name.encode("utf-8"))] for f in files[:20]]
            rows.append([Button.inline("Cancel", CB_CREATE_CANCEL)])
            await event.edit("Choose group file:", buttons=rows)
        elif raw == CB_MODE_ENTERPRISE:
            st = _create_state.get(event.sender_id)
            if not st:
                await event.answer()
                return
            await event.answer()
            st["data"]["mode"] = "Enterprise"
            st["step"] = "group_file"
            data = load_adbot()
            files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
            if not files:
                await event.edit("No .txt files in groups/. Create one and try again.", buttons=[[Button.inline("« Back", CB_CREATE_CANCEL)]])
                return
            rows = [[Button.inline(f.name, PREFIX_GROUP_FILE + f.name.encode("utf-8"))] for f in files[:20]]
            rows.append([Button.inline("Cancel", CB_CREATE_CANCEL)])
            await event.edit("Choose group file:", buttons=rows)
        elif raw.startswith(PREFIX_GROUP_FILE):
            st = _create_state.get(event.sender_id)
            if not st:
                await event.answer()
                return
            fn = raw[len(PREFIX_GROUP_FILE) :].decode("utf-8", errors="replace")
            st["data"]["group_file"] = fn
            st["step"] = "summary"
            d = st["data"]
            # Always refresh bot_username from the token so summary shows the actual bot for this token
            bot_tok = (d.get("bot_token") or "").strip()
            if bot_tok:
                ok, out = await validate_bot_token(bot_tok)
                if ok:
                    d["bot_username"] = out
            summary = (
                f"**Summary**\nName: {d.get('name')}\nBot: @{d.get('bot_username', '')}\nSessions: {d.get('sessions_count')}\n"
                f"Cycle: {d.get('cycle')}s | Gap: {d.get('gap')}s\n"
                f"Valid till: {d.get('valid_till')}\nMode: {d.get('mode')}\nGroup file: {fn}\n"
            )
            path = config.GROUPS_DIR / fn
            if not path.is_file():
                summary += "\n⚠ Group file does not exist."
            else:
                try:
                    lines = [ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
                    if not lines:
                        summary += "\n⚠ Group file is empty."
                    elif len(lines) > 5000:
                        summary += f"\n⚠ List has {len(lines)} groups (>5000). Consider splitting."
                except Exception:
                    summary += "\n⚠ Could not read group file."
            # Keep under Telegram limit so "Proceed?" and buttons are always visible
            suffix = "\n\nProceed?"
            if len(summary) + len(suffix) > 4090:
                summary = summary[: 4090 - len(suffix) - 20] + "\n…(truncated)"
            summary += suffix
            await event.answer()
            await event.edit(summary, buttons=[[Button.inline("Proceed", CB_CREATE_FINAL), Button.inline("Cancel", CB_CREATE_CANCEL)]])
        elif raw == CB_CREATE_FINAL:
            st = _create_state.get(event.sender_id)
            if not st or st.get("step") != "summary":
                await event.answer("Start from Create AdBots again.", alert=True)
                return
            await event.answer()
            form = st["data"]
            chat_id = st["chat_id"]
            _clear_create_state(event.sender_id)
            progress_msg = await client.send_message(chat_id, "⏳ Create queued. I'll update this message when done.")
            msg_id = progress_msg.id
            adbot_data = load_adbot()
            free_count = len(adbot_data.get("free_sessions", []))
            if free_count == 0:
                await client.edit_message(chat_id, msg_id, "❌ No free sessions. Add sessions in Manage Sessions first.")
                return
            if form.get("bot_token", "").strip() in adbot_data.get("bots", {}):
                await client.edit_message(chat_id, msg_id, "❌ This bot token is already registered.")
                return
            # Fix #1 + #2: Enqueue create job; worker runs off main loop; admin replies instantly.
            progress_queue: queue_module.Queue = queue_module.Queue()
            asyncio.create_task(_progress_consumer(progress_queue, client))
            _create_job_queue.put((chat_id, msg_id, form, progress_queue))
        elif raw == CB_MANAGE_SESSIONS:
            await event.answer()
            text, buttons = _manage_sessions_text_and_buttons(data)
            await event.edit(text, buttons=buttons)
        elif raw == CB_ADD_SESSIONS:
            await _handle_add_sessions(client, event, data)
        elif raw == CB_REMOVE_SESSIONS:
            await _handle_remove_sessions(client, event, data)
        elif raw == CB_BACK_SESSIONS:
            await _handle_back_sessions(client, event, data)
        elif raw == CB_CANCEL_ADD:
            uid = event.sender_id
            _add_mode.discard(uid)
            batch = _add_batch_totals.pop(uid, (0, 0))
            _add_last_msg.pop(uid, None)
            await event.answer()
            data = load_adbot()
            text, buttons = _manage_sessions_text_and_buttons(data)
            if batch[0] or batch[1]:
                text += f"\n\n_This batch: +{batch[0]} free, +{batch[1]} dead._"
            await event.edit(text, buttons=buttons)
        elif raw.startswith(PREFIX_DEL_FREE):
            await _handle_del_session(client, event, data, PREFIX_DEL_FREE, "free_sessions", config.SESSIONS_ACTIVE)
        elif raw.startswith(PREFIX_DEL_DEAD):
            await _handle_del_session(client, event, data, PREFIX_DEL_DEAD, "dead_sessions", config.SESSIONS_DEAD)
        elif raw == CB_MANAGE_ADBOTS:
            await event.answer()
            data = load_adbot()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await event.edit("No AdBots.", buttons=[[Button.inline("« Back", CB_MANAGE_ADBOT_BACK)]])
                return
            uid = event.sender_id
            _manage_adbot_list[uid] = bots
            _recreate_bot_list[uid] = bots
            _delete_adbot_list[uid] = bots
            rows = [[Button.inline(name, PREFIX_ADBOT_SELECT + str(i).encode())] for i, (name, _) in enumerate(bots)]
            rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
            await event.edit("Manage AdBots — pick a bot:", buttons=rows)
        elif raw == CB_ADBOT_BACK_TO_LIST:
            await event.answer()
            data = load_adbot()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await event.edit("No AdBots.", buttons=[[Button.inline("« Back", CB_MANAGE_ADBOT_BACK)]])
                return
            uid = event.sender_id
            _manage_adbot_list[uid] = bots
            _recreate_bot_list[uid] = bots
            _delete_adbot_list[uid] = bots
            rows = [[Button.inline(name, PREFIX_ADBOT_SELECT + str(i).encode())] for i, (name, _) in enumerate(bots)]
            rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
            await event.edit("Manage AdBots — pick a bot:", buttons=rows)
        elif raw.startswith(PREFIX_ADBOT_SELECT):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_SELECT):].decode())
            except Exception:
                data = load_adbot()
                bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
                if not bots:
                    await event.edit("No AdBots.", buttons=[[Button.inline("« Back", CB_MANAGE_ADBOT_BACK)]])
                else:
                    rows = [[Button.inline(name, PREFIX_ADBOT_SELECT + str(ii).encode())] for ii, (name, _) in enumerate(bots)]
                    rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
                    await event.edit("Manage AdBots — pick a bot:", buttons=rows)
                return
            bl = _manage_adbot_list.get(event.sender_id, [])
            if i < 0 or i >= len(bl):
                data = load_adbot()
                bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
                if bots:
                    _manage_adbot_list[event.sender_id] = bots
                    rows = [[Button.inline(name, PREFIX_ADBOT_SELECT + str(ii).encode())] for ii, (name, _) in enumerate(bots)]
                    rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
                    await event.edit("Manage AdBots — pick a bot:", buttons=rows)
                return
            name, _ = bl[i]
            await event.edit(f"**{name}** — pick an action:", buttons=_manage_adbot_actions_buttons(i), parse_mode="md")
        elif raw == CB_MANAGE_ADBOT_BACK:
            await event.answer()
            _manage_adbot_list.pop(event.sender_id, None)
            _delete_adbot_list.pop(event.sender_id, None)
            _recreate_bot_list.pop(event.sender_id, None)
            await event.edit("Admin menu:", buttons=_main_menu_buttons())
        elif raw.startswith(PREFIX_ADBOT_VALIDATE):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_VALIDATE):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            bl = _manage_adbot_list.get(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            _, token = bl[i]
            await event.edit("⏳ Validating this bot's sessions…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            ok, dead = await _admin_validate_sessions(d, log=progress, bot_token=token)
            await event.edit(f"✅ Validate: {ok} ok, {dead} moved to dead.", buttons=_manage_adbot_actions_buttons(i))
        elif raw.startswith(PREFIX_ADBOT_REPLACE_ERR):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_REPLACE_ERR):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            bl = _manage_adbot_list.get(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            _, token = bl[i]
            await event.edit("⏳ Replacing error sessions…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            msg = await _admin_replace_error_sessions(d, log=progress, bot_token=token)
            await event.edit(msg, buttons=_manage_adbot_actions_buttons(i))
        elif raw.startswith(PREFIX_ADBOT_REPLACE):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_REPLACE):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            bl = _manage_adbot_list.get(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=[[Button.inline("« Back", CB_ADBOT_BACK_TO_LIST)]])
                return
            _, token = bl[i]
            await event.edit("⏳ Replacing dead sessions…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            msg = await _admin_replace_dead(d, log=progress, bot_token=token)
            await event.edit(msg, buttons=_manage_adbot_actions_buttons(i))
        elif raw == CB_MANAGE_ADBOT_VALIDATE:
            await event.answer()
            await event.edit("⏳ Validating…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            ok, dead = await _admin_validate_sessions(d, log=progress)
            await event.edit(f"✅ Validate: {ok} ok, {dead} moved to dead.", buttons=_manage_adbots_buttons())
        elif raw == CB_MANAGE_ADBOT_REPLACE:
            await event.answer()
            await event.edit("⏳ Replacing dead sessions…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            msg = await _admin_replace_dead(d, log=progress)
            await event.edit(msg, buttons=_manage_adbots_buttons())
        elif raw == CB_MANAGE_ADBOT_REPLACE_ERROR:
            await event.answer()
            await event.edit("⏳ Replacing error sessions…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            msg = await _admin_replace_error_sessions(d, log=progress)
            await event.edit(msg, buttons=_manage_adbots_buttons())
        elif raw == CB_MANAGE_ADBOT_RECREATE:
            await event.answer()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await event.edit("No bots.", buttons=_manage_adbots_buttons())
                return
            _recreate_bot_list[event.sender_id] = bots
            rows = [[Button.inline(name, PREFIX_ADBOT_RECREATE + str(i).encode())] for i, (name, _) in enumerate(bots)]
            rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
            await event.edit("Recreate log group — pick bot:", buttons=rows)
        elif raw.startswith(PREFIX_ADBOT_RECREATE):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_RECREATE):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            bl = _recreate_bot_list.pop(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            _, bot_token = bl[i]
            await event.edit("⏳ Recreating log group…")
            d = load_adbot()

            async def progress(m: str) -> None:
                try:
                    await client.edit_message(event.chat_id, event.id, m)
                except Exception:
                    await client.send_message(event.chat_id, m)

            msg = await _admin_recreate_log_group(client, event.chat_id, bot_token, d, log=progress)
            return_buttons = _manage_adbot_actions_buttons(i) if (event.sender_id in _manage_adbot_list and i < len(_manage_adbot_list[event.sender_id])) else _manage_adbots_buttons()
            await event.edit(msg, buttons=return_buttons)
        elif raw == CB_MANAGE_ADBOT_DELETE:
            await event.answer()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await event.edit("No AdBots to delete.", buttons=_manage_adbots_buttons())
                return
            _delete_adbot_list[event.sender_id] = bots
            rows = [[Button.inline(name, PREFIX_ADBOT_DELETE + str(i).encode())] for i, (name, _) in enumerate(bots)]
            rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
            await event.edit("Delete AdBot — pick one:", buttons=rows)
        elif raw.startswith(PREFIX_ADBOT_DELETE):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_DELETE):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            bl = _delete_adbot_list.get(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            name, bot_token = bl[i]
            data = load_adbot()
            cfg = (data.get("bots") or {}).get(bot_token) or {}
            bot_username = (cfg.get("bot_username") or "").strip() or "—"
            valid_till = (cfg.get("valid_till") or "").strip() or "—"
            plan_name = (cfg.get("plan_name") or "").strip() or "—"
            mode = get_plan_mode(cfg) if cfg else "—"
            token_display = (bot_token[:20] + "…") if len(bot_token) > 20 else bot_token
            sessions = [s.get("file") or "?" for s in cfg.get("sessions", []) if s.get("file")]
            sessions_line = ", ".join(sessions[:10]) if sessions else "—"
            if len(sessions) > 10:
                sessions_line += f" … (+{len(sessions) - 10} more)"
            lines = [
                f"**Bot username:** @{bot_username}",
                f"**Bot name:** {name}",
                f"**Bot token:** `{token_display}`",
                f"**Plan name:** {plan_name}",
                f"**Validity:** {valid_till}",
                f"**Mode:** {mode}",
                f"**Sessions:** {sessions_line}",
                "",
                "Are you sure? This will stop the bot, remove it from DB (logs, stats), and return sessions to the free pool.",
            ]
            rows = [
                [Button.inline("🗑 Delete", PREFIX_ADBOT_DEL_CONFIRM + str(i).encode())],
                [Button.inline("« Cancel", CB_MANAGE_ADBOT_BACK)],
            ]
            await event.edit("\n".join(lines), buttons=rows, parse_mode="md")
        elif raw.startswith(PREFIX_ADBOT_DEL_CONFIRM):
            await event.answer()
            try:
                i = int(raw[len(PREFIX_ADBOT_DEL_CONFIRM):].decode())
            except Exception:
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            bl = _delete_adbot_list.pop(event.sender_id, [])
            if i < 0 or i >= len(bl):
                await event.edit("Invalid.", buttons=_manage_adbots_buttons())
                return
            name, bot_token = bl[i]
            await event.edit("Deleting…")
            await _stop_posting(bot_token)
            await asyncio.sleep(1)  # allow posting session disconnects and DB lock release
            await disconnect_and_remove_controller_bot(bot_token)
            await delete_bot_from_storage(bot_token, "free")
            data = load_adbot()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await event.edit(f"Deleted **{name}**. Sessions moved to free pool.", buttons=[[Button.inline("« Back", CB_MANAGE_ADBOT_BACK)]], parse_mode="md")
            else:
                uid = event.sender_id
                _manage_adbot_list[uid] = bots
                _recreate_bot_list[uid] = bots
                _delete_adbot_list[uid] = bots
                rows = [[Button.inline(n, PREFIX_ADBOT_SELECT + str(ii).encode())] for ii, (n, _) in enumerate(bots)]
                rows.append([Button.inline("« Back", CB_MANAGE_ADBOT_BACK)])
                await event.edit(f"Deleted **{name}**. Sessions moved to free pool.", buttons=rows, parse_mode="md")
        else:
            await event.answer()

    @client.on(events.NewMessage())
    async def on_message(event: events.NewMessage.Event) -> None:
        uid = event.sender_id
        if not _is_authorized(uid):
            return
        # Create AdBot conversation
        if uid in _create_state:
            st = _create_state[uid]
            chat_id = st.get("chat_id")
            if chat_id != event.chat_id:
                return
            text = (event.text or "").strip()
            if text == "/cancel":
                _clear_create_state(uid)
                await event.reply("Cancelled.")
                return
            step = st.get("step", "")
            d = st.setdefault("data", {})
            data = load_adbot()
            t, dead, assigned, free = _session_counts(data)
            if step == "name":
                if not text:
                    await event.reply("Enter a non-empty internal name.")
                    return
                if free == 0:
                    await event.reply("❌ No free sessions. Add sessions in Manage Sessions first.")
                    return
                d["name"] = text
                st["step"] = "sessions_count"
                await event.reply(f"Enter number of sessions to assign.\nAvailable sessions: {free}")
                return
            if step == "sessions_count":
                try:
                    n = int(text)
                    if n < 1:
                        await event.reply("Enter a positive number.")
                        return
                except ValueError:
                    await event.reply("Enter a number.")
                    return
                d["sessions_count"] = n
                st["step"] = "cycle"
                await event.reply("Cycle time (seconds, positive integer):")
                return
            if step == "cycle":
                try:
                    n = int(text)
                    if n < 1:
                        await event.reply("Enter a positive number.")
                        return
                except ValueError:
                    await event.reply("Enter a number.")
                    return
                d["cycle"] = n
                st["step"] = "gap"
                await event.reply("Gap (seconds, positive integer):")
                return
            if step == "gap":
                try:
                    n = int(text)
                    if n < 1:
                        await event.reply("Enter a positive number.")
                        return
                except ValueError:
                    await event.reply("Enter a number.")
                    return
                d["gap"] = n
                st["step"] = "bot_token"
                await event.reply("Send bot token:")
                return
            if step == "bot_token":
                ok, out = await validate_bot_token(text)
                if not ok:
                    await event.reply(f"Invalid token: {out}")
                    return
                if text.strip() in data.get("bots", {}):
                    await event.reply("This bot token is already registered.")
                    return
                d["bot_token"] = text.strip()
                d["bot_username"] = out
                st["step"] = "valid_till"
                await event.reply("Valid till (dd/mm/yyyy):")
                return
            if step == "valid_till":
                try:
                    dt = datetime.strptime(text, "%d/%m/%Y")
                    d["valid_till"] = dt.strftime("%d/%m/%Y")
                except ValueError:
                    await event.reply("Use format dd/mm/yyyy (e.g. 02/06/2026).")
                    return
                st["step"] = "mode"
                await event.reply("Mode:", buttons=[
                    [Button.inline("Starter", CB_MODE_STARTER), Button.inline("Enterprise", CB_MODE_ENTERPRISE)],
                    [Button.inline("Cancel", CB_CREATE_CANCEL)],
                ])
                return
            if step in ("mode", "group_file", "summary", "ask_proceed"):
                await event.reply("Use the buttons above for this step.")
                return
            return
        # Add Sessions file upload — stay in _add_mode; one status message (edit), unique names, zip rglob
        if not event.document or uid not in _add_mode:
            return
        data = load_adbot()
        name = (event.file and event.file.name) or "document"
        name_lower = name.lower()
        mime = getattr(event.document, "mime_type", "") or ""
        is_zip = name_lower.endswith(".zip") or "zip" in mime
        added_f, added_d = 0, 0

        try:
            if name_lower.endswith(".session"):
                base = name if name_lower.endswith(".session") else (Path(name).stem + ".session")
                dest = _unique_session_path(base)
                path = await event.download_media(file=str(dest))
                if path and Path(path).is_file():
                    p = Path(path)
                    if p.suffix.lower() != ".session":
                        dest = _unique_session_path(p.stem + ".session")
                        if p != dest:
                            shutil.move(str(p), str(dest))
                            p = dest
                    a, b = await _process_upload(client, event, p, data)
                    added_f += a
                    added_d += b
            elif is_zip:
                with tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    zip_path = tmp_path / "upload.zip"
                    await event.download_media(file=str(zip_path))
                    # Zip extraction must not block the main loop (Fix #3).
                    dests = await asyncio.to_thread(
                        _extract_zip_and_copy_sessions, zip_path, tmp_path, config.SESSIONS_ACTIVE
                    )
                    for dest in dests:
                        a, b = await _process_upload(client, event, dest, data)
                        added_f += a
                        added_d += b
            elif name_lower.endswith(".txt"):
                path = await event.download_media(file=str(config.SESSIONS_ACTIVE))
                if path and Path(path).is_file():
                    lines = Path(path).read_text(encoding="utf-8", errors="replace").strip().splitlines()
                    for line in lines:
                        fn = line.strip()
                        if not fn or not fn.lower().endswith(".session"):
                            continue
                        p = config.SESSIONS_ACTIVE / fn
                        if p.is_file():
                            a, b = await _process_upload(client, event, p, data)
                            added_f += a
                            added_d += b
                    Path(path).unlink(missing_ok=True)
            else:
                _add_mode.add(event.sender_id)
                await event.reply("Send a .session, .txt, or .zip file.", buttons=[[Button.inline("Cancel", CB_CANCEL_ADD)]])
                return
        except Exception as e:
            logger.exception("Add sessions failed: %s", e)
            _add_mode.add(event.sender_id)
            err_msg = str(e).strip().lower()
            if "file is not a database" in err_msg or (type(e).__name__ == "DatabaseError" and "database" in err_msg):
                reply = (
                    "Invalid session file: the uploaded file is not a valid Telethon session. "
                    "Use a .session file created by Telethon (SQLite format). "
                    "Old string sessions or files from other apps are not supported."
                )
            else:
                reply = f"Error processing file: {e}"
            await event.reply(reply, buttons=[[Button.inline("Cancel", CB_CANCEL_ADD)]])
            return

        save_adbot(data)
        tot = _add_batch_totals.get(uid, (0, 0))
        _add_batch_totals[uid] = (tot[0] + added_f, tot[1] + added_d)
        total_f, total_d = _add_batch_totals[uid]
        status = f"Added to free: {total_f}, to dead: {total_d} (this batch). Send more or Cancel."
        buttons = [[Button.inline("Cancel", CB_CANCEL_ADD)]]
        last = _add_last_msg.get(uid)
        if last:
            try:
                await client.edit_message(last[0], last[1], status, buttons=buttons)
            except Exception:
                m = await event.reply(status, buttons=buttons)
                _add_last_msg[uid] = (event.chat_id, m.id)
        else:
            m = await event.reply(status, buttons=buttons)
            _add_last_msg[uid] = (event.chat_id, m.id)

    async def _send_daily_report() -> None:
        """Build and send daily report to admin (active bots, sessions working, total posts, posts since last report)."""
        if not config.ADMIN_USER_ID:
            return
        data = load_adbot()
        bots = data.get("bots", {})
        active = sum(1 for c in bots.values() if c.get("state") == "running")
        total_sessions = 0
        total_sent = 0
        for cfg in bots.values():
            sessions = cfg.get("sessions", [])
            working = sum(1 for s in sessions if (config.SESSIONS_ACTIVE / (s.get("file") or "")).is_file())
            total_sessions += working
            total_sent += cfg.get("stats", {}).get("total_sent", 0)
        last = data.get("last_report_snapshot") or {}
        posts_since_last = total_sent - last.get("total_sent", 0)
        today = datetime.now().strftime("%Y-%m-%d")
        msg = (
            f"**Daily report** ({today})\n"
            f"Active bots: {active} / {len(bots)}\n"
            f"Sessions working: {total_sessions}\n"
            f"Total posts (all-time): {total_sent}\n"
            f"Posts since last report: {posts_since_last}"
        )
        try:
            await client.send_message(config.ADMIN_USER_ID, msg, parse_mode="md")
            data["last_report_snapshot"] = {"date": today, "total_sent": total_sent}
            save_adbot(data)
        except Exception as e:
            logger.warning("Daily report send failed: %s", e)

    async def _daily_report_loop() -> None:
        """Run daily report at 00:00 server time."""
        while True:
            now = datetime.now()
            next_midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            secs = (next_midnight - now).total_seconds()
            await asyncio.sleep(max(1, secs))
            await _send_daily_report()

    async def _alert_forward_loop() -> None:
        """Every 30s send pending admin_alerts to admin DM, then clear. First run immediately."""
        if not config.ADMIN_USER_ID:
            return
        while True:
            try:
                data = load_adbot()
                alerts = data.get("admin_alerts", [])
                if alerts:
                    for a in alerts:
                        msg = (a.get("msg") or str(a))[:4000]
                        try:
                            await client.send_message(config.ADMIN_USER_ID, msg, parse_mode="md")
                        except Exception:
                            await client.send_message(config.ADMIN_USER_ID, msg)
                    data["admin_alerts"] = []
                    save_adbot(data)
            except Exception as e:
                logger.warning("Alert forward failed: %s", e)
            await asyncio.sleep(30)

    await client.start(bot_token=config.ADMIN_BOT_TOKEN)
    logger.info("Admin bot running")
    _start_create_worker_if_needed()
    asyncio.create_task(_result_consumer(client))
    asyncio.create_task(_alert_forward_loop())
    asyncio.create_task(_daily_report_loop())
    await client.run_until_disconnected()
