"""
Repair module for AdBot maintenance: Fix Log Group, Fix Sessions, Fix Config, Fix Bot Token.
Used by /fix command in admin and user controller bots.
"""
import asyncio
import hashlib
import logging
from datetime import datetime
import random
import shutil
import string
from pathlib import Path
from typing import Any, Awaitable, Callable

from telethon import TelegramClient
from telethon.errors import FloodError, FloodWaitError, PeerFloodError, UserRestrictedError
from telethon.tl.functions.account import UpdateProfileRequest
from telethon.tl.functions.channels import (
    CreateChannelRequest,
    EditAdminRequest,
    InviteToChannelRequest,
    UpdateUsernameRequest,
)
from telethon.tl.functions.photos import UploadProfilePhotoRequest
from telethon.tl.types import ChatAdminRights, InputChannel

from . import config
from .session_guard import SessionBusyError, guarded_client
from .utils import (
    add_admin_alert,
    claim_free_session,
    get_bot_log_path,
    get_name_by_token,
    join_chat_by_link,
    load_pool,
    probe_session_identity,
    record_session_meta,
    load_user_data,
    move_session_to_bucket,
    name_to_filename,
    save_pool,
    save_user_data,
    validate_bot_token,
    validate_session,
)
from .utils import log_bot_event

logger = logging.getLogger(__name__)

_CREATE_GROUP_RETRYABLE = (
    UserRestrictedError,
    FloodWaitError,
    FloodError,
    PeerFloodError,
)

# SpamBot status classifications
SPAM_ACTIVE = "ACTIVE"
SPAM_TEMP_LIMITED = "TEMP_LIMITED"
SPAM_HARD_LIMITED = "HARD_LIMITED"
SPAM_FROZEN = "FROZEN"
SPAM_UNKNOWN = "UNKNOWN"


# Phrases that indicate hard-limited accounts (SpamBot responses)
_HARD_LIMIT_PHRASES = (
    "hard limit",
    "permanently limited",
    "banned",
    "we have received complaints",
    "due to complaints",
    "your account is limited",
    "some of your messages were reported",
    "you will not be able to",
)


def classify_spambot_response(text: str) -> str:
    """Classify SpamBot response into ACTIVE, TEMP_LIMITED, HARD_LIMITED, FROZEN, UNKNOWN."""
    if not text or not isinstance(text, str):
        return SPAM_UNKNOWN
    t = text.strip().lower()
    if "good news" in t or "no limits" in t or "no restrictions" in t:
        return SPAM_ACTIVE
    if "temporarily limited" in t or ("temp" in t and "limit" in t):
        return SPAM_TEMP_LIMITED
    for phrase in _HARD_LIMIT_PHRASES:
        if phrase in t:
            return SPAM_HARD_LIMITED
    if "frozen" in t or ("spam" in t and "reported" in t):
        return SPAM_FROZEN
    logger.info("SpamBot UNKNOWN classification: %s", (text or "")[:120])
    return SPAM_UNKNOWN


async def _check_session_spambot(path: Path) -> tuple[str, str]:
    """Check a single session via SpamBot. Returns (session_name, status)."""
    name = path.stem
    try:
        client = guarded_client(path, "account health check (SpamBot)", wait_timeout=10, expected_sec=45)
        await client.connect()
        try:
            if not await client.is_user_authorized():
                return name, "UNKNOWN"
            try:
                await client.send_message("SpamBot", "/start")
                await asyncio.sleep(1.5)
                async for msg in client.iter_messages("SpamBot", limit=3):
                    if msg.text:
                        return name, classify_spambot_response(msg.text)
            except Exception as e:
                logger.debug("SpamBot check failed for %s: %s", name, e)
        finally:
            await client.disconnect()
    except SessionBusyError as e:
        logger.info("SpamBot check skipped for %s: %s", name, e)
    except Exception as e:
        logger.debug("Session connect failed for %s: %s", name, e)
    return name, SPAM_UNKNOWN


async def check_sessions_health_parallel(session_files: list[str]) -> dict[str, str]:
    """Run SpamBot health check for sessions in parallel. Returns {session_file: status}."""
    tasks: list[tuple[str, asyncio.Task]] = []
    for fn in session_files:
        path = config.resolve_session_path(fn)
        if path.is_file():
            tasks.append((fn, asyncio.create_task(_check_session_spambot(path))))
    if not tasks:
        return {fn: SPAM_UNKNOWN for fn in session_files}
    out: dict[str, str] = {}
    for fn, task in tasks:
        try:
            _, status = await task
            out[fn] = status
        except Exception:
            out[fn] = SPAM_UNKNOWN
    for fn in session_files:
        if fn not in out:
            out[fn] = SPAM_UNKNOWN
    return out


def _get_session_dest_dir(status: str) -> Path:
    """Return destination directory for session based on status."""
    if status == SPAM_FROZEN:
        return config.SESSIONS_FROZEN
    if status in (SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED):
        return config.SESSIONS_LIMITED
    return config.SESSIONS_UNAUTH


async def repair_fix_log_group(
    bot_token: str,
    log_async: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Validate log group; if invalid, recreate using retry-across-sessions. Returns result message."""
    name = get_name_by_token(bot_token)
    if not name:
        return "Bot not found."
    cfg = load_user_data(name)
    if not cfg:
        return "Config not found."
    display_name = cfg.get("name", "AdBot")
    bot_username = (cfg.get("bot_username") or "").strip().lstrip("@")
    sessions = cfg.get("sessions", [])
    log_group = cfg.get("log_group") or ""

    async def _log(msg: str) -> None:
        if log_async:
            await log_async(msg)
        log_bot_event(bot_token, f"[Fix Log Group] {msg}")

    if not sessions:
        return "No sessions to validate or create log group."

    # Validate current log group if present
    if log_group:
        try:
            for s in sessions[:1]:
                fn = s.get("file")
                if not fn:
                    continue
                path = config.SESSIONS_ACTIVE / fn
                if not path.is_file():
                    continue
                client = guarded_client(path, "log group check", wait_timeout=15, expected_sec=60)
                await client.connect()
                if not await client.is_user_authorized():
                    await client.disconnect()
                    break
                try:
                    entity = await client.get_entity(log_group)
                    if entity:
                        try:
                            ic = InputChannel(entity.id, getattr(entity, "access_hash", 0) or 0)
                            await client(InviteToChannelRequest(ic, [await client.get_input_entity("@" + bot_username)]))
                        except Exception as inv:
                            if "already" not in str(inv).lower() and "participant" not in str(inv).lower():
                                raise
                        await client.disconnect()
                        await _log("Log group validated: exists and accessible.")
                        return "Log group is valid."
                except Exception as e:
                    logger.debug("Log group validation failed: %s", e)
                await client.disconnect()
                break
        except Exception as e:
            logger.debug("Log group validation: %s", e)

    # Recreate log group with retry across sessions
    await _log("Log group invalid or missing. Creating new one…")
    title = f"{display_name} AdBot Log"
    about = "Hosted by @HQAdz"
    username = "adbot_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    creator = None
    input_ch = None
    ch_id = None

    for s in sessions:
        fn = s.get("file") or ""
        if not fn:
            continue
        path = config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            continue
        client = guarded_client(path, "log group setup", wait_timeout=15, expected_sec=120)
        try:
            await client.connect()
            if not await client.is_user_authorized():
                continue
            try:
                from telethon.tl.types import Channel
                create_result = await client(CreateChannelRequest(title=title, about=about, megagroup=True))
                channel = create_result.chats[0]
                if not isinstance(channel, Channel):
                    continue
                ch_id = channel.id
                ch_access = getattr(channel, "access_hash", 0) or 0
                input_ch = InputChannel(ch_id, ch_access)
                creator = client
                logger.info("Log group created using session: %s", fn)
                await _log(f"Log group created with session {fn}")
                break
            except _CREATE_GROUP_RETRYABLE as e:
                logger.warning("Log group creation failed for %s: %s", fn, e)
                await _log(f"Session {fn} cannot create: {e!s}. Trying next…")
            except Exception as e:
                if "spam" in str(e).lower() or "restricted" in str(e).lower():
                    await _log(f"Session {fn} restricted. Trying next…")
                else:
                    await _log(f"Session {fn} failed: {e!s}. Trying next…")
        except Exception as e:
            logger.warning("Creator connect failed for %s: %s", fn, e)
        finally:
            if creator is not client:
                try:
                    await client.disconnect()
                except Exception:
                    pass

    if creator is None or input_ch is None:
        msg = "All sessions failed to create log group."
        await _log(msg)
        add_admin_alert("fix_log_group_failed", msg)
        return msg

    try:
        await creator(UpdateUsernameRequest(input_ch, username))
        await creator.get_entity(ch_id)
        bot_input = await creator.get_input_entity("@" + bot_username)
        await creator(InviteToChannelRequest(input_ch, [bot_input]))
        rights = ChatAdminRights(
            change_info=True, post_messages=True, edit_messages=True, delete_messages=True,
            invite_users=True, pin_messages=True, manage_call=True,
        )
        await creator(EditAdminRequest(input_ch, bot_input, rights, "AdBot"))
        invite_link = f"https://t.me/{username}"
        await creator.disconnect()

        await _log("Joining sessions to log group…")
        joined = 0
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
                    joined += 1
                except Exception as je:
                    if "already" in str(je).lower():
                        joined += 1
                    else:
                        failed.append(fn)
            finally:
                await c2.disconnect()

        cfg["log_group"] = f"https://t.me/{username}"
        save_user_data(name, cfg)
        total = len(sessions)
        await _log(f"Log group recreated. {joined}/{total} sessions joined.")
        if failed:
            return f"Log group recreated. {joined}/{total} joined. Failed: {', '.join(failed)}"
        return f"Log group recreated. All {total} sessions joined."
    except Exception as e:
        logger.exception("repair_fix_log_group: %s", e)
        await _log(f"Error: {e}")
        return f"Error: {e}"
    finally:
        try:
            await creator.disconnect()
        except Exception:
            pass


async def repair_fix_sessions(
    bot_token: str,
    log_async: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run SpamBot health check and return session statuses. Used for interactive replacement."""
    name = get_name_by_token(bot_token)
    if not name:
        return {"error": "Bot not found", "sessions": {}}
    cfg = load_user_data(name)
    if not cfg:
        return {"error": "Config not found", "sessions": {}}
    sessions = cfg.get("sessions", [])
    files = [s.get("file") for s in sessions if s.get("file")]
    statuses = await check_sessions_health_parallel(files)
    return {"sessions": statuses, "cfg": cfg, "name": name}


async def repair_replace_session(
    bot_token: str,
    old_session_file: str,
    status: str,
    log_async: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Replace a session with a new one from pool. Move old to frozen/limited/unauth."""
    name = get_name_by_token(bot_token)
    if not name:
        return "Bot not found."
    cfg = load_user_data(name)
    if not cfg:
        return "Config not found."
    sessions = cfg.get("sessions", [])
    idx = next((i for i, s in enumerate(sessions) if s.get("file") == old_session_file), None)
    # idx is None when the old session was already removed from the bot (e.g. a runtime
    # death moved it to sessions/dead/ before the owner chose to replace). In that case we
    # ADD a fresh session instead of swapping one in place, so a dead account still flows
    # through the same free/paid replacement path.
    add_mode = idx is None

    # Atomically claim a free session (removed from the pool and persisted before we
    # return) so a concurrent creation/replacement can never grab the same account.
    new_fn = await asyncio.to_thread(claim_free_session)
    if not new_fn:
        return "No free sessions available for replacement."

    new_path = config.SESSIONS_ACTIVE / new_fn
    if not new_path.is_file():
        # Claimed session's file is gone → park it as dead, don't leak it back to free.
        await asyncio.to_thread(move_session_to_bucket, new_fn, "dead_sessions")
        return "Replacement session file missing."

    ok = await validate_session(new_path)
    if not ok:
        await asyncio.to_thread(move_session_to_bucket, new_fn, "dead_sessions")
        return "Replacement session failed validation."

    probe = await probe_session_identity(new_path)
    real_name = probe.get("full_name") or new_fn
    user_id = int(probe.get("user_id") or 0)
    if probe.get("status") != "busy":
        await asyncio.to_thread(
            record_session_meta, new_fn, probe,
            validation_status="valid" if probe.get("status") == "active" else "unknown",
        )

    if not add_mode:
        # Swap-in-place: move the old (frozen/limited/unauth) session out of active/ and
        # record it in the matching pool bucket.
        dest_dir = _get_session_dest_dir(status)
        old_path = config.SESSIONS_ACTIVE / old_session_file
        if old_path.is_file():
            try:
                dest_path = dest_dir / old_session_file
                shutil.move(str(old_path), str(dest_path))
            except Exception as e:
                logger.warning("Move session to %s failed: %s", dest_dir, e)

        # Track moved session in the correct pool bucket (atomic, re-reads pool fresh).
        _pool_bucket_for_status = {
            SPAM_FROZEN: "frozen_sessions",
            SPAM_TEMP_LIMITED: "limited_sessions",
            SPAM_HARD_LIMITED: "limited_sessions",
        }
        dest_bucket = _pool_bucket_for_status.get(status, "unauth_sessions")
        await asyncio.to_thread(move_session_to_bucket, old_session_file, dest_bucket)

        sessions[idx] = {"file": new_fn, "real_name": real_name, "user_id": user_id, "index": idx + 1}
    else:
        # Add-mode: the dead session is already gone (moved to dead/ at time of death), so
        # just append the fresh account to restore the bot to full strength.
        sessions.append({"file": new_fn, "real_name": real_name, "user_id": user_id, "index": len(sessions) + 1})
    cfg["sessions"] = sessions
    cfg.setdefault("session_replacements", [])
    cfg["session_replacements"].append({
        "at": datetime.utcnow().isoformat() + "Z",
        "old_session": old_session_file,
        "new_session": new_fn,
        "reason": status,
        "source": "admin_fix_sessions",
    })
    cfg["session_replacements"] = cfg["session_replacements"][-100:]
    save_user_data(name, cfg)

    log_group = cfg.get("log_group")
    if log_group:
        client = guarded_client(new_path, "session replacement", wait_timeout=15, expected_sec=60)
        try:
            await client.connect()
            if await client.is_user_authorized():
                try:
                    await join_chat_by_link(client, log_group)
                except Exception as je:
                    if "already" not in str(je).lower():
                        logger.warning("New session join log group failed: %s", je)
        finally:
            await client.disconnect()

    log_bot_event(bot_token, f"[Fix Sessions] Replaced {old_session_file} with {new_fn} (status was {status})")
    if log_async:
        await log_async(f"Replaced {old_session_file} with {new_fn}")
    return f"Replaced {old_session_file} with {new_fn}."


async def repair_fix_config(
    bot_token: str,
    log_async: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Validate and auto-repair user config. Returns repair summary."""
    name = get_name_by_token(bot_token)
    if not name:
        return "Bot not found."
    cfg = load_user_data(name)
    if not cfg:
        return "Config not found."

    async def _log(msg: str) -> None:
        if log_async:
            await log_async(msg)
        log_bot_event(bot_token, f"[Fix Config] {msg}")

    fixes: list[str] = []
    safe = name_to_filename(name)

    # Log file path
    expected_log = f"data/logs/{safe}.log"
    if cfg.get("log_file") != expected_log:
        cfg["log_file"] = expected_log
        fixes.append("log_file path")

    # Ensure log dir exists
    log_path = config.DATA_LOGS_DIR / f"{safe}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    # Session index validity
    sessions = cfg.get("sessions", [])
    valid_sessions = []
    for i, s in enumerate(sessions):
        if not isinstance(s, dict):
            continue
        fn = s.get("file")
        if not fn:
            continue
        path = config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            continue
        valid_sessions.append({
            "file": fn,
            "real_name": s.get("real_name", fn),
            "user_id": s.get("user_id", 0),
            "index": i + 1,
        })
    if len(valid_sessions) != len(sessions):
        cfg["sessions"] = valid_sessions
        fixes.append("session index")

    # Group file exists
    gf = cfg.get("group_file")
    if gf:
        gf_path = config.GROUPS_DIR / gf
        if not gf_path.is_file():
            fixes.append(f"group_file {gf} missing (kept in config)")

    # Required fields
    required = ["name", "bot_token", "bot_username", "valid_till", "cycle", "gap", "mode", "group_file", "log_group", "log_file", "authorized", "sessions", "state"]
    for k in required:
        if k not in cfg:
            if k == "authorized":
                cfg[k] = []
            elif k == "sessions":
                cfg[k] = []
            elif k == "state":
                cfg[k] = "stopped"
            else:
                cfg[k] = ""
            fixes.append(f"added missing {k}")

    save_user_data(name, cfg)
    await _log(f"Config repair: {', '.join(fixes) if fixes else 'no changes needed'}")
    return "Config repair: " + (", ".join(fixes) if fixes else "no changes needed")


async def repair_fix_bot_token(
    bot_token: str,
    new_token: str,
    log_async: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """Update bot token, restart worker, add new bot to log group."""
    name = get_name_by_token(bot_token)
    if not name:
        return "Bot not found."
    cfg = load_user_data(name)
    if not cfg:
        return "Config not found."

    ok, username_or_err = await validate_bot_token(new_token)
    if not ok:
        return f"Invalid token: {username_or_err}"

    new_username = username_or_err.strip().lstrip("@")
    old_username = (cfg.get("bot_username") or "").strip().lstrip("@")
    cfg["bot_token"] = new_token.strip()
    cfg["bot_username"] = new_username
    cfg.setdefault("bot_token_replacements", [])
    cfg["bot_token_replacements"].append({
        "at": datetime.utcnow().isoformat() + "Z",
        "old_bot_username": old_username or None,
        "new_bot_username": new_username,
        "source": "admin_fix_bot_token",
    })
    cfg["bot_token_replacements"] = cfg["bot_token_replacements"][-50:]

    cfg["bot_token"] = new_token.strip()
    save_user_data(name, cfg)

    from .users import _stop_posting, create_user_bot, disconnect_and_remove_controller_bot
    await _stop_posting(bot_token)
    await asyncio.sleep(1)
    # Tears down the old controller bot AND removes its dashboard mini app button.
    await disconnect_and_remove_controller_bot(bot_token)
    # Retire the old bot: rename it so it no longer looks like an active AdBot.
    try:
        from .miniapp import set_bot_name_not_in_use
        await set_bot_name_not_in_use(bot_token)
    except Exception as e:
        logger.warning("Fix Bot Token: could not rename old bot to '%s': %s", "NOT IN USE", e)
    # New controller bot activates via create_user_bot, which re-links the mini app
    # (menu button) to the same dashboard using the bot's existing web_token.
    asyncio.create_task(create_user_bot(new_token.strip()))

    # Set new bot's name/photo/bio to match the standard AdBot profile (same as at creation)
    from .admin import BOT_PFP_REL, BOT_PROFILE_DESCRIPTION, BOT_PROFILE_SHORT_DESCRIPTION, _set_bot_profile_via_api
    display_name = cfg.get("name", "AdBot")
    tmp_path = config.DATA_DIR / f"_fix_bot_token_tmp_{hashlib.sha256(new_token.encode()).hexdigest()[:8]}"
    profile_client = TelegramClient(str(tmp_path), config.API_ID, config.API_HASH, proxy=config.PROXY)
    try:
        await profile_client.start(bot_token=new_token.strip())
        try:
            await profile_client(UpdateProfileRequest(first_name=f"{display_name} Bot", about=BOT_PROFILE_DESCRIPTION))
        except Exception as e:
            logger.warning("Fix Bot Token: set name/about failed: %s", e)
        pfp_set = False
        pfp_candidates = list(BOT_PFP_REL)
        random.shuffle(pfp_candidates)
        for pfp_rel in pfp_candidates:
            pfp_path = config.BASE_DIR / pfp_rel
            if not pfp_path.is_file():
                continue
            try:
                uploaded = await profile_client.upload_file(str(pfp_path))
                await profile_client(UploadProfilePhotoRequest(file=uploaded))
                pfp_set = True
                break
            except Exception as e:
                logger.warning("Fix Bot Token: set profile photo failed (path=%s): %s", pfp_rel, e)
        if not pfp_set:
            add_admin_alert(
                "fix_bot_token_pfp_failed",
                f"Bot token for {display_name} replaced but profile photo could not be set on new bot @{new_username}.",
            )
    except Exception as e:
        logger.warning("Fix Bot Token: profile setup failed: %s", e)
    finally:
        try:
            await profile_client.disconnect()
        except Exception:
            pass
        for ext in ("", ".session", ".session-journal"):
            p = Path(str(tmp_path) + ext)
            if p.exists():
                try:
                    p.unlink()
                except OSError as e:
                    logger.warning("Could not remove temp session %s: %s", p, e)
    _set_bot_profile_via_api(
        new_token.strip(),
        bot_name=f"{display_name} Bot",
        description=BOT_PROFILE_DESCRIPTION,
        short_description=BOT_PROFILE_SHORT_DESCRIPTION,
    )

    log_group = cfg.get("log_group")
    if log_group and cfg.get("sessions"):
        added = False
        tried: list[str] = []
        for s in cfg["sessions"]:
            fn = s.get("file")
            if not fn:
                continue
            path = config.SESSIONS_ACTIVE / fn
            if not path.is_file():
                continue
            client = guarded_client(path, "bot token fix (log group invite)", wait_timeout=15, expected_sec=60)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    continue
                entity = await client.get_entity(log_group)
                input_ch = InputChannel(entity.id, getattr(entity, "access_hash", 0) or 0)
                bot_input = await client.get_input_entity("@" + new_username)
                await client(InviteToChannelRequest(input_ch, [bot_input]))
                rights = ChatAdminRights(
                    change_info=True, post_messages=True, edit_messages=True, delete_messages=True,
                    invite_users=True, pin_messages=True, manage_call=True,
                )
                await client(EditAdminRequest(input_ch, bot_input, rights, "AdBot"))
                added = True
                logger.info("New bot added to log group using session: %s", fn)
                break
            except Exception as e:
                msg = str(e)
                if "already" in msg.lower() or "participant" in msg.lower():
                    added = True
                    break
                tried.append(f"{fn}: {msg}")
                logger.warning("Add new bot to log group failed with session %s: %s", fn, e)
            finally:
                await client.disconnect()

        if not added:
            fail_msg = (
                f"Could not add new bot @{new_username} to log group — "
                f"all {len(tried)} session(s) failed: " + "; ".join(tried) if tried
                else f"Could not add new bot @{new_username} to log group — no usable sessions."
            )
            logger.warning(fail_msg)
            log_bot_event(bot_token, f"[Fix Bot Token] {fail_msg}")
            add_admin_alert("fix_bot_token_log_group_failed", fail_msg)
            if log_async:
                await log_async(fail_msg)

    log_bot_event(bot_token, f"[Fix Bot Token] Migrated from {old_username} to {new_username}")
    if log_async:
        await log_async(f"Bot token updated. New bot: @{new_username}")
    return f"Bot token updated. New bot: @{new_username}"
