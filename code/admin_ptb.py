"""
Admin bot using python-telegram-bot (PTB).
Full admin UI: Create AdBot wizard, Manage Sessions, Manage AdBots. Alerts and daily reports via PTB.
Session validation and posting use Telethon; all bot APIs use PTB.
"""
import asyncio
import logging
import queue as queue_module
import shutil
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import config
from . import bot_ptb
from . import notify
from .admin import (
    _create_job_queue,
    _is_authorized,
    _result_queue,
    _session_counts,
    _session_counts_full,
    _create_status_text,
    _get_system_stats,
    load_adbot,
    save_adbot,
    _workers_alive,
    _start_create_worker_if_needed,
    _process_upload_standalone,
    _admin_validate_sessions,
    _admin_replace_dead,
    _admin_replace_error_sessions,
    _admin_recreate_log_group,
    _extract_zip_and_copy_sessions,
    _unique_session_path,
)
from .users import create_user_bot
from .utils import validate_bot_token, name_to_filename, get_token_by_name
from .user_config import get_plan_mode
from .repair import (
    repair_fix_log_group,
    repair_fix_config,
    repair_fix_bot_token,
    repair_fix_sessions,
    repair_replace_session,
    check_sessions_health_parallel,
)

# Queue for jobs that must run on the main asyncio loop (e.g. delete AdBot uses _stop_posting / BOT_CLIENTS)

BROADCAST_SESSION_TIMEOUT_SEC = getattr(config, "BROADCAST_SESSION_TIMEOUT_SEC", 600)

# PTB application lifecycle: never call application.shutdown/stop or request.shutdown/httpx_client.aclose
# from broadcast, workers, or background tasks. Guard sends with _admin_ptb_running().
_admin_application: Any = None
_admin_app_running = False


def _admin_ptb_running() -> bool:
    """True if admin PTB polling is active. Use to skip sends in background tasks when app is down."""
    return _admin_app_running


def _broadcast_clear(ud: dict) -> None:
    """Reset broadcast wizard state."""
    for k in ("broadcast_target", "broadcast_payload", "broadcast_ts", "broadcast_uids"):
        ud.pop(k, None)


def _broadcast_payload_from_message(msg: Any) -> dict:
    """Build broadcast payload from the admin's message: chat_id, message_id, content (with media file_id and file_unique_id), and source_bot_token."""
    chat_id = msg.chat.id if (msg and msg.chat) else None
    message_id = msg.message_id
    content = {}
    if msg.text is not None:
        content["text"] = msg.text
    if msg.caption is not None:
        content["caption"] = msg.caption
    for key, attr in (("entities", "entities"), ("caption_entities", "caption_entities")):
        val = getattr(msg, attr, None)
        if val:
            try:
                content[key] = [e.to_dict() if hasattr(e, "to_dict") else {"type": getattr(e, "type", None), "offset": getattr(e, "offset", 0), "length": getattr(e, "length", 0)} for e in val]
            except Exception:
                content[key] = []
    if getattr(msg, "photo", None):
        p = msg.photo[-1]
        content["photo_file_id"] = p.file_id
        content["photo_file_unique_id"] = getattr(p, "file_unique_id", None) or p.file_id
    if getattr(msg, "video", None):
        v = msg.video
        content["video_file_id"] = v.file_id
        content["video_file_unique_id"] = getattr(v, "file_unique_id", None) or v.file_id
    if getattr(msg, "document", None):
        d = msg.document
        content["document_file_id"] = d.file_id
        content["document_file_unique_id"] = getattr(d, "file_unique_id", None) or d.file_id
    source_bot_token = (getattr(config, "ADMIN_BOT_TOKEN", None) or "").strip()
    return {"chat_id": chat_id, "message_id": message_id, "content": content, "source_bot_token": source_bot_token or None}


async def _broadcast_resolve_media_and_send(
    bot: Any,
    chat_id: int,
    content: dict,
    source_bot_token: str | None,
    current_bot_token: str,
    media_cache: dict,
) -> Any:
    """Resolve media file_id for cross-bot use (cache or re-upload), then send. Returns sent Message or None."""
    from telegram import MessageEntity
    from io import BytesIO
    entities = None
    if content.get("entities"):
        try:
            entities = [MessageEntity(**e) for e in content["entities"]]
        except Exception:
            pass
    caption_entities = None
    if content.get("caption_entities"):
        try:
            caption_entities = [MessageEntity(**e) for e in content["caption_entities"]]
        except Exception:
            pass
    caption = content.get("caption") or ""

    def _cache_get(unique_key: str, file_id_key: str) -> str | None:
        if not current_bot_token or not source_bot_token or current_bot_token == source_bot_token:
            return content.get(file_id_key)
        unique_id = content.get(unique_key) or content.get(file_id_key)
        if not unique_id:
            return content.get(file_id_key)
        media_cache.setdefault(current_bot_token, {})
        return media_cache[current_bot_token].get(unique_id)

    def _cache_set(unique_key: str, new_file_id: str) -> None:
        if not current_bot_token:
            return
        media_cache.setdefault(current_bot_token, {})
        unique_id = content.get(unique_key) or content.get("photo_file_id") or content.get("video_file_id") or content.get("document_file_id")
        if unique_id:
            media_cache[current_bot_token][unique_id] = new_file_id

    async def _download_with_source_bot(file_id: str) -> bytes | None:
        if not source_bot_token:
            return None
        try:
            source_bot = bot_ptb._get_ptb_bot(source_bot_token)
            f = await source_bot.get_file(file_id)
            if hasattr(f, "download_as_bytearray"):
                buf = await f.download_as_bytearray()
                return bytes(buf)
            if hasattr(f, "download_to_drive"):
                import tempfile
                import os
                with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
                    await f.download_to_drive(tmp.name)
                    with open(tmp.name, "rb") as rf:
                        data = rf.read()
                    try:
                        os.unlink(tmp.name)
                    except Exception:
                        pass
                    return data
        except Exception as e:
            logger.warning("Broadcast media download failed (source_bot): %s", e)
        return None

    bot_label = (current_bot_token or "")[:20] if current_bot_token else ""
    orig_photo = content.get("photo_file_id")
    uid_photo = content.get("photo_file_unique_id") or orig_photo

    if content.get("photo_file_id"):
        photo_id = _cache_get("photo_file_unique_id", "photo_file_id")
        if not photo_id:
            photo_id = content["photo_file_id"]
        from_cache = bool(current_bot_token and media_cache.get(current_bot_token, {}).get(uid_photo) == photo_id)
        if from_cache:
            logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=True", bot_label, (orig_photo or "")[:20], (photo_id or "")[:20])
        try:
            return await bot.send_photo(chat_id=chat_id, photo=photo_id, caption=caption or None, caption_entities=caption_entities)
        except Exception as e:
            err = (str(e) or "").lower()
            if "wrong file identifier" in err or "wrong file" in err or "file identifier" in err or "http url" in err:
                data = await _download_with_source_bot(content["photo_file_id"])
                if data:
                    sent = await bot.send_photo(chat_id=chat_id, photo=BytesIO(data), caption=caption or None, caption_entities=caption_entities)
                    fid = sent.photo[-1].file_id if sent and getattr(sent, "photo", None) else None
                    if fid:
                        _cache_set("photo_file_unique_id", fid)
                        logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=False", bot_label, (content["photo_file_id"] or "")[:20], (fid or "")[:20])
                    return sent
            raise

    if content.get("video_file_id"):
        video_id = _cache_get("video_file_unique_id", "video_file_id")
        if not video_id:
            video_id = content["video_file_id"]
        uid_video = content.get("video_file_unique_id") or content.get("video_file_id")
        if current_bot_token and media_cache.get(current_bot_token, {}).get(uid_video) == video_id:
            logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=True", bot_label, (content["video_file_id"] or "")[:20], (video_id or "")[:20])
        try:
            return await bot.send_video(chat_id=chat_id, video=video_id, caption=caption or None, caption_entities=caption_entities)
        except Exception as e:
            err = (str(e) or "").lower()
            if "wrong file identifier" in err or "wrong file" in err or "file identifier" in err or "http url" in err:
                data = await _download_with_source_bot(content["video_file_id"])
                if data:
                    sent = await bot.send_video(chat_id=chat_id, video=BytesIO(data), caption=caption or None, caption_entities=caption_entities)
                    fid = sent.video.file_id if sent and getattr(sent, "video", None) else None
                    if fid:
                        _cache_set("video_file_unique_id", fid)
                        logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=False", bot_label, (content["video_file_id"] or "")[:20], (fid or "")[:20])
                    return sent
            raise

    if content.get("document_file_id"):
        doc_id = _cache_get("document_file_unique_id", "document_file_id")
        if not doc_id:
            doc_id = content["document_file_id"]
        uid_doc = content.get("document_file_unique_id") or content.get("document_file_id")
        if current_bot_token and media_cache.get(current_bot_token, {}).get(uid_doc) == doc_id:
            logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=True", bot_label, (content["document_file_id"] or "")[:20], (doc_id or "")[:20])
        try:
            return await bot.send_document(chat_id=chat_id, document=doc_id, caption=caption or None, caption_entities=caption_entities)
        except Exception as e:
            err = (str(e) or "").lower()
            if "wrong file identifier" in err or "wrong file" in err or "file identifier" in err or "http url" in err:
                data = await _download_with_source_bot(content["document_file_id"])
                if data:
                    sent = await bot.send_document(chat_id=chat_id, document=BytesIO(data), caption=caption or None, caption_entities=caption_entities)
                    fid = sent.document.file_id if sent and getattr(sent, "document", None) else None
                    if fid:
                        _cache_set("document_file_unique_id", fid)
                        logger.info("[MediaReupload] bot=%s original_file_id=%s new_file_id=%s cached=False", bot_label, (content["document_file_id"] or "")[:20], (fid or "")[:20])
                    return sent
            raise

    text = content.get("text") or ""
    return await bot.send_message(chat_id=chat_id, text=text, entities=entities)


async def _broadcast_send_content(
    bot: Any,
    chat_id: int,
    content: dict,
    source_bot_token: str | None = None,
    media_cache: dict | None = None,
    current_bot_token: str | None = None,
) -> Any:
    """Send message content (text/media) to chat_id using bot. Uses media_cache and re-upload when file_id belongs to another bot. Returns sent Message or None."""
    if not content:
        return None
    media_cache = media_cache if media_cache is not None else {}
    if content.get("photo_file_id") or content.get("video_file_id") or content.get("document_file_id"):
        try:
            return await _broadcast_resolve_media_and_send(
                bot, chat_id, content,
                source_bot_token=source_bot_token,
                current_bot_token=current_bot_token or "",
                media_cache=media_cache,
            )
        except Exception as e:
            logger.warning("Broadcast send_content failed to %s: %s", chat_id, e)
            return None
    try:
        from telegram import MessageEntity
        entities = None
        if content.get("entities"):
            try:
                entities = [MessageEntity(**e) for e in content["entities"]]
            except Exception:
                pass
        caption_entities = None
        if content.get("caption_entities"):
            try:
                caption_entities = [MessageEntity(**e) for e in content["caption_entities"]]
            except Exception:
                pass
        text = content.get("text") or ""
        return await bot.send_message(chat_id=chat_id, text=text, entities=entities)
    except Exception as e:
        logger.warning("Broadcast send_content failed to %s: %s", chat_id, e)
        return None


async def _broadcast_ensure_source_for_bot(
    bot: Any,
    admin_bot: Any,
    admin_id: int,
    payload: dict,
    source_cache: dict,
    cache_key: str,
    source_bot_token: str | None = None,
    media_cache: dict | None = None,
    current_bot_token: str | None = None,
) -> tuple[int | None, int | None]:
    """Ensure this bot has a source message it can copy from. Only Admin bot can use the original; others re-send to admin (with cross-bot media resolution). Returns (from_chat_id, message_id) or (None, None)."""
    if cache_key in source_cache:
        return source_cache[cache_key]
    from_chat_id = payload.get("chat_id")
    message_id = payload.get("message_id")
    content = payload.get("content") or {}
    if bot is admin_bot:
        source_cache[cache_key] = (from_chat_id, message_id)
        return (from_chat_id, message_id)
    sent = await _broadcast_send_content(
        bot, admin_id, content,
        source_bot_token=source_bot_token,
        media_cache=media_cache or {},
        current_bot_token=current_bot_token,
    )
    if sent:
        source_cache[cache_key] = (admin_id, sent.message_id)
        return (admin_id, sent.message_id)
    source_cache[cache_key] = (None, None)
    return (None, None)


async def _run_broadcast(context: "ContextTypes.DEFAULT_TYPE", update: "Update", target: str, payload: dict) -> tuple[int, int]:
    """Execute broadcast loop. Only two sending rules:
    - all_users: send using Shop Bot token.
    - plan_users: send using each recipient's assigned bot token (per plan).
    Returns (sent, failed). Handles RetryAfter. Fallback to send_message/send_photo on copy_message failure.
    Never call application.shutdown/stop here. Skip if admin app not running."""
    if not _admin_ptb_running():
        return 0, 0
    from .admin_control import broadcast_recipients_all_users, broadcast_recipients_plan_users, broadcast_log_append
    try:
        from telegram.error import RetryAfter
    except ImportError:
        RetryAfter = type("RetryAfter", (Exception,), {})
    from_chat_id = payload.get("chat_id")
    message_id = payload.get("message_id")
    content = payload.get("content") or {}
    admin_id = (update.callback_query and update.callback_query.from_user and update.callback_query.from_user.id) or (update.effective_user and update.effective_user.id) or 0
    preview_exists = bool(from_chat_id and message_id)
    logger.info(
        "[BroadcastSourceCheck] from_chat_id=%s message_id=%s preview_exists=%s",
        from_chat_id, message_id, preview_exists,
    )
    rate_per_min = getattr(config, "BROADCAST_RATE_LIMIT_PER_MIN", 30)
    interval = 60.0 / max(1, rate_per_min)
    sent, failed = 0, 0
    if target == "all_users":
        recipients = [(uid, None) for uid in broadcast_recipients_all_users()]
    else:
        recipients = broadcast_recipients_plan_users()
    total = len(recipients)
    if total == 0:
        return 0, 0
    if update.callback_query and update.callback_query.message:
        try:
            await context.bot.edit_message_text(
                chat_id=update.callback_query.message.chat.id,
                message_id=update.callback_query.message.message_id,
                text="Sending…",
            )
        except Exception:
            pass
    shop_token = (getattr(config, "SHOP_BOT_TOKEN", None) or "").strip()
    admin_bot = context.bot
    source_cache = {}
    source_bot_token = payload.get("source_bot_token") or (getattr(config, "ADMIN_BOT_TOKEN", None) or "").strip() or None
    media_cache = {}
    for item in recipients:
        user_id = item[0]
        bot_token = item[1] if len(item) > 1 else None
        if target == "all_users":
            bot = bot_ptb._get_ptb_bot(shop_token) if shop_token else None
            cache_key = "shop"
            current_bot_token = shop_token or ""
        else:
            bot = bot_ptb._get_ptb_bot(bot_token) if bot_token else None
            cache_key = str(bot_token or "")
            current_bot_token = bot_token or ""
        if bot is None:
            failed += 1
            continue
        fcid, mid = await _broadcast_ensure_source_for_bot(
            bot, admin_bot, admin_id, payload, source_cache, cache_key,
            source_bot_token=source_bot_token,
            media_cache=media_cache,
            current_bot_token=current_bot_token,
        )
        if fcid is None or mid is None:
            if content and await _broadcast_send_content(
                bot, user_id, content,
                source_bot_token=source_bot_token,
                media_cache=media_cache,
                current_bot_token=current_bot_token,
            ):
                sent += 1
            else:
                failed += 1
            await asyncio.sleep(interval)
            continue
        copy_fn = getattr(bot, "copy_message", None)
        ok = False
        for attempt in range(3):
            try:
                await copy_fn(chat_id=user_id, from_chat_id=fcid, message_id=mid)
                sent += 1
                ok = True
                break
            except RetryAfter as e:
                wait = getattr(e, "retry_after", 60) or 60
                wait = min(wait, 120)
                await asyncio.sleep(wait)
                continue
            except Exception as e:
                err_text = (str(e) or "").lower()
                if "message to copy not found" in err_text or "not found" in err_text:
                    if content:
                        if await _broadcast_send_content(
                            bot, user_id, content,
                            source_bot_token=source_bot_token,
                            media_cache=media_cache,
                            current_bot_token=current_bot_token,
                        ):
                            sent += 1
                            ok = True
                            logger.info("Broadcast fallback_used=True for user_id=%s", user_id)
                    if not ok:
                        logger.warning("Broadcast to %s failed (no fallback content): %s", user_id, e)
                    break
                logger.warning("Broadcast to %s failed: %s", user_id, e)
                break
        if not ok:
            failed += 1
        await asyncio.sleep(interval)
    broadcast_log_append(target, total, sent, failed)
    return sent, failed


def _md_escape(text) -> str:
    """Escape user-provided text for Telegram MarkdownV2 to prevent parse errors."""
    from telegram.helpers import escape_markdown
    return escape_markdown(str(text or ""), version=2)
_main_loop_job_queue: queue_module.Queue = queue_module.Queue()


def submit_main_loop_job(job_type: str, payload: tuple) -> None:
    """Submit a job for the main loop to run (e.g. delete_bot). Consumer runs in main.py."""
    _main_loop_job_queue.put((job_type, payload))


logger = logging.getLogger(__name__)


def _main_menu_buttons_ptb():
    """Inline keyboard for main menu (PTB format)."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("Control Center", callback_data="control_center")],
        [InlineKeyboardButton("Create AdBots", callback_data="create_adbots"), InlineKeyboardButton("Manage AdBots", callback_data="manage_adbots")],
        [InlineKeyboardButton("Manage Sessions", callback_data="manage_sessions"), InlineKeyboardButton("Pending Orders", callback_data="pending_orders")],
        [InlineKeyboardButton("Groups", callback_data="groups_menu")],
    ])


def _validate_group_file_content(text: str) -> tuple[bool, str, int]:
    """Validate group file: one group ID per line, must start with -100. Optional: -100123 | topic_id.
    Returns (ok, error_message, valid_line_count)."""
    lines = (text or "").strip().splitlines()
    valid = 0
    for ln in lines:
        raw = (ln or "").strip()
        if not raw:
            continue
        if "|" in raw:
            parts = raw.split("|", 1)
            chat_part = (parts[0] or "").strip()
            topic_part = (parts[1] or "").strip() if len(parts) > 1 else ""
        else:
            chat_part = raw
            topic_part = ""
        if not chat_part:
            return False, f"Invalid line (empty chat ID): {raw[:50]}", 0
        if not (chat_part.startswith("-100") and chat_part[4:].isdigit()):
            return False, f"Invalid line (each line must start with -100...): {raw[:50]}", 0
        if topic_part and not topic_part.isdigit():
            return False, f"Invalid line (topic ID must be numeric): {raw[:50]}", 0
        valid += 1
    return True, "", valid


def _groups_menu_markup():
    """Inline keyboard for Groups menu: list .txt files with Delete, Upload new, Back."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    config.GROUPS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
    rows = []
    for f in files[:25]:
        rows.append([InlineKeyboardButton(f"📄 {f.name} — Delete", callback_data="groups_del:" + f.name)])
    rows.append([InlineKeyboardButton("Upload new .txt", callback_data="groups_upload")])
    rows.append([InlineKeyboardButton("« Back", callback_data="groups_back")])
    return InlineKeyboardMarkup(rows)


async def _alert_forward_loop_ptb() -> None:
    """Every 30s send pending admin_alerts to admin DM via PTB, then clear. Started from main."""
    if not config.ADMIN_USER_ID:
        return
    while True:
        try:
            if not _admin_ptb_running():
                await asyncio.sleep(30)
                continue
            data = load_adbot()
            alerts = data.get("admin_alerts", [])
            if alerts:
                for a in alerts:
                    msg = (a.get("msg") or str(a))[:4000]
                    await notify.notify_admin_send(msg, parse_mode=None)
                data["admin_alerts"] = []
                save_adbot(data)
        except Exception as e:
            logger.warning("Alert forward failed: %s", e)
        await asyncio.sleep(30)


async def _daily_report_loop_ptb() -> None:
    """Run daily report at 00:00; send via PTB to ADMIN_USER_ID."""
    if not config.ADMIN_USER_ID:
        return
    while True:
        now = datetime.now()
        next_midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        secs = (next_midnight - now).total_seconds()
        await asyncio.sleep(max(1, secs))
        try:
            if not _admin_ptb_running():
                continue
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
                f"*Daily report* \\({_md_escape(today)}\\)\n"
                f"Active bots: {_md_escape(active)} / {_md_escape(len(bots))}\n"
                f"Sessions working: {_md_escape(total_sessions)}\n"
                f"Total posts \\(all\\-time\\): {_md_escape(total_sent)}\n"
                f"Posts since last report: {_md_escape(posts_since_last)}"
            )
            await notify.notify_admin_send(msg, parse_mode="MarkdownV2")
            data["last_report_snapshot"] = {"date": today, "total_sent": total_sent}
            save_adbot(data)
        except Exception as e:
            logger.warning("Daily report send failed: %s", e)


async def _result_consumer_ptb() -> None:
    """Consume create-job results from _result_queue; edit final message via PTB and start user bot. Started from main. Never call application.shutdown/stop here."""
    from .shop.storage import update_order_status, get_order
    from .shop.workers import (
        QUEUE_EDIT_MESSAGE,
        FAILURE_CREATION_MESSAGE,
        SUCCESS_ACTIVATED_MESSAGE,
    )
    from .shop.handlers import _shop_ptb_running
    shop_token = (getattr(config, "SHOP_BOT_TOKEN", None) or "").strip()
    logger.info("[CREATE_PIPELINE] _result_consumer_ptb started")
    while True:
        chat_id, msg_id, username, form = await asyncio.to_thread(_result_queue.get)
        order_id = form.get("order_id", "")
        logger.info(
            "[CREATE_PIPELINE] result_consumer received chat_id=%s msg_id=%s username=%s order_id=%s",
            chat_id, msg_id, username or "(none)", order_id,
        )
        can_send_admin = _admin_ptb_running()
        can_send_shop = _shop_ptb_running()
        bot_token = (form.get("bot_token") or "").strip()
        order_id = form.get("order_id")
        is_shop = form.get("source") == "shop" or order_id
        edit_bot_token = shop_token if is_shop and shop_token else None
        bot_name = form.get("name", "")
        # Pool reservation from admin-web "use from pool" creation: settle it here.
        # On success the token is now a live bot (mark assigned); on failure it
        # returns to the pool so the stock count stays accurate.
        pool_order_id = form.get("_pool_order_id")
        if pool_order_id:
            try:
                from .shop.token_pool import mark_assigned as _pool_mark, release_order as _pool_release
                if username:
                    _pool_mark(pool_order_id)
                else:
                    _pool_release(pool_order_id)
            except Exception:
                pass
        if bot_name:
            try:
                from api.services.events import emit_create_progress
                if username:
                    web_token = form.get("_web_token", "")
                    emit_create_progress(bot_name, f"Bot created: @{username}", status="success")
                else:
                    reason = form.get("_result_reason", "")
                    emit_create_progress(bot_name, reason or "Creation failed", status="failed")
            except Exception:
                pass
        if username:
            if bot_token:
                asyncio.create_task(create_user_bot(bot_token))
            if order_id:
                update_order_status(order_id, "completed", created_bot_username=username, bot_token=bot_token, web_token=form.get("_web_token", ""))
                try:
                    order = get_order(order_id)
                    uid = order.get("user_id") if order else None
                    if uid is not None:
                        from .broadcast_users import add_plan_user
                        add_plan_user(uid)
                except Exception:
                    pass
            if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                try:
                    msg = SUCCESS_ACTIVATED_MESSAGE.format(username=username)
                    web_token = form.get("_web_token", "")
                    if web_token:
                        website_url = (getattr(config, "WEBSITE_URL", "") or "").rstrip("/")
                        if website_url:
                            direct_url = f"{website_url}/login?token={web_token}"
                            msg += f"\n\nWeb Panel: {direct_url}"
                        else:
                            msg += f"\n\nWeb Access Code: {web_token}"
                    await notify.notify_edit_message(chat_id, msg_id, msg, parse_mode=None, bot_token=edit_bot_token)
                    logger.info("[CREATE_PIPELINE] result_consumer notify_edit_message success (completed) chat_id=%s msg_id=%s", chat_id, msg_id)
                except Exception as e:
                    logger.warning("[CREATE_PIPELINE] result_consumer edit failed (success msg): %s", e)
            if is_shop and order_id and can_send_admin:
                try:
                    order = get_order(order_id)
                    user_id = order.get("user_id") if order else None
                    if config.ADMIN_USER_ID:
                        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
                        plan_name = (order or {}).get("plan_name") or form.get("plan_name") or "—"
                        duration_days = (order or {}).get("duration_days") or "—"
                        amount_usd = (order or {}).get("amount_usd")
                        amount_str = f"${amount_usd:.2f}" if amount_usd is not None else "—"
                        renewal_price = form.get("renewal_price") or (order or {}).get("amount_usd")
                        renewal_str = f"${float(renewal_price):.2f}" if renewal_price not in (None, "") else "—"
                        bot_name = form.get("name") or "—"
                        lines = [
                            "🟢 AdBot created (Shop)",
                            f"Order: {order_id}",
                            f"Bot: @{username} ({bot_name})",
                            f"Plan: {plan_name}",
                            f"Duration: {duration_days} days",
                            f"Amount: {amount_str}",
                            f"Renewal: {renewal_str}",
                        ]
                        if user_id:
                            lines.append(f"Buyer: {user_id}")
                        text = "\n".join(lines)
                        profile_url = f"tg://user?id={user_id}" if user_id else None
                        kb = InlineKeyboardMarkup([[InlineKeyboardButton("Profile", url=profile_url)]]) if profile_url else None
                        await notify.notify_admin_send(text, parse_mode=None, reply_markup=kb)
                except Exception as e:
                    logger.debug("Admin creation notification failed: %s", e)
        else:
            if order_id:
                reason = form.get("_result_reason")
                need = form.get("_required_count")
                got = form.get("_assigned_count", 0)
                if reason == "insufficient_valid_sessions" and need is not None:
                    update_order_status(order_id, "pending_creation")
                    from ..utils import add_admin_alert
                    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
                    add_admin_alert(
                        "queue_sessions",
                        f"📋 Queue: Order {order_id} — need {need} valid sessions, only {got} available. Add more sessions to pool, then use Recreate for this order.",
                    )
                    if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                        support_id = getattr(config, "SUPPORT_CHAT_ID", 0) or getattr(config, "SUPPORT_USER_ID", 0) or 0
                        support_btn = (
                            InlineKeyboardButton("Contact Support", url=f"tg://user?id={support_id}")
                            if support_id
                            else InlineKeyboardButton("Contact Support", callback_data="shop_support")
                        )
                        support_markup = InlineKeyboardMarkup([[support_btn]])
                        try:
                            await notify.notify_edit_message(
                                chat_id, msg_id,
                                QUEUE_EDIT_MESSAGE,
                                parse_mode=None,
                                reply_markup=support_markup,
                                bot_token=edit_bot_token,
                            )
                        except Exception:
                            pass
                elif reason == "bot_token_already_registered":
                    update_order_status(order_id, "failed")
                    try:
                        from .shop.token_pool import release_order as _release_tok
                        _release_tok(order_id)
                    except Exception:
                        pass
                    if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                        dup_msg = "This bot token is already linked to an AdBot. Please use a different token from @BotFather or manage your existing bot."
                        try:
                            await notify.notify_edit_message(chat_id, msg_id, dup_msg, parse_mode=None, bot_token=edit_bot_token)
                        except Exception:
                            pass
                elif reason == "already_creating":
                    if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                        in_progress_msg = "Creation is already in progress. This message will update when it finishes."
                        try:
                            await notify.notify_edit_message(chat_id, msg_id, in_progress_msg, parse_mode=None, bot_token=edit_bot_token)
                        except Exception:
                            pass
                else:
                    update_order_status(order_id, "failed")
                    try:
                        from .shop.token_pool import release_order as _release_tok
                        _release_tok(order_id)
                    except Exception:
                        pass
                    if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                        try:
                            await notify.notify_edit_message(chat_id, msg_id, FAILURE_CREATION_MESSAGE, parse_mode=None, bot_token=edit_bot_token)
                        except Exception:
                            pass
            else:
                if chat_id and msg_id and ((edit_bot_token and can_send_shop) or (not edit_bot_token and can_send_admin)):
                    try:
                        fail_msg = FAILURE_CREATION_MESSAGE if is_shop else "Creation failed. Check the message above or contact support."
                        await notify.notify_edit_message(chat_id, msg_id, fail_msg, parse_mode=None, bot_token=edit_bot_token)
                    except Exception:
                        pass


async def _progress_consumer_web(
    progress_queue: queue_module.Queue,
    bot_name: str,
    order_id: str = "",
) -> None:
    """Consume (chat_id, msg_id, msg) from progress_queue, publish to pub/sub AND persist the
    latest step onto the order so the website can poll/show it live; stop on None."""
    from api.services.events import emit_create_progress
    while True:
        item = await asyncio.to_thread(progress_queue.get)
        if item is None:
            emit_create_progress(bot_name, "done", status="done")
            return
        _chat_id, _msg_id, msg = item
        emit_create_progress(bot_name, msg, status="progress")
        if order_id:
            try:
                from .shop.storage import update_order
                update_order(order_id, {"creation_step": msg})
            except Exception:
                pass
        logger.info("[CREATE_PROGRESS] web consumer published bot=%s msg=%s", bot_name, msg[:80])


async def _progress_consumer_ptb(
    progress_queue: queue_module.Queue,
    notification_bot_token: str | None = None,
) -> None:
    """Consume (chat_id, msg_id, msg) from progress_queue and edit progress message via PTB; stop on None.
    notification_bot_token: if set (e.g. Shop Bot), edit with that bot; else admin bot.
    Skips edit when chat_id=0 or msg_id=0 or when PTB app is not running. Never call application.shutdown/stop here."""
    from .shop.handlers import _shop_ptb_running
    while True:
        item = await asyncio.to_thread(progress_queue.get)
        if item is None:
            return
        chat_id, msg_id, msg = item
        if not chat_id or not msg_id:
            logger.debug(
                "[CREATE_PROGRESS] consumer skipping edit (chat_id=%s msg_id=%s)",
                chat_id, msg_id,
            )
            continue
        can_send = _shop_ptb_running() if notification_bot_token else _admin_ptb_running()
        if not can_send:
            continue
        try:
            if notification_bot_token:
                from .ui.emoji_entities import build_emoji_message
                progress_text, progress_entities = build_emoji_message(msg, "rocket")
                ok = await notify.notify_edit_message(
                    chat_id, msg_id, progress_text,
                    entities=progress_entities, bot_token=notification_bot_token
                )
            else:
                ok = await notify.notify_edit_message(
                    chat_id, msg_id, msg, parse_mode=None, bot_token=notification_bot_token
                )
            logger.info(
                "[CREATE_PROGRESS] consumer edited chat_id=%s msg_id=%s ok=%s msg_preview=%s",
                chat_id, msg_id, ok, (msg[:50] + "…" if len(msg) > 50 else msg),
            )
            if not ok and not notification_bot_token and _admin_ptb_running():
                await notify.notify_admin_send(msg[:4000], parse_mode=None)
        except Exception as e:
            logger.warning("[CREATE_PROGRESS] consumer edit failed chat_id=%s msg_id=%s: %s", chat_id, msg_id, e)
            if not notification_bot_token and _admin_ptb_running():
                try:
                    await notify.notify_admin_send(msg[:4000], parse_mode=None)
                except Exception:
                    pass


def submit_create_job(
    chat_id: int,
    msg_id: int,
    form: dict,
    notification_bot_token: str | None = None,
    web: bool = False,
) -> None:
    """Enqueue a Create AdBot job and start progress consumer. Call from PTB wizard, Shop Bot, or Web API.
    notification_bot_token: when set (e.g. SHOP_BOT_TOKEN), progress/result messages are edited with that bot.
    web: when True, progress is published to pub/sub for the web UI instead of Telegram."""
    _start_create_worker_if_needed()
    progress_queue: queue_module.Queue = queue_module.Queue()
    if web:
        bot_name = form.get("name", "unknown")
        asyncio.create_task(_progress_consumer_web(progress_queue, bot_name, form.get("order_id", "")))
    else:
        asyncio.create_task(_progress_consumer_ptb(progress_queue, notification_bot_token))
    _create_job_queue.put((chat_id, msg_id, form, progress_queue))
    try:
        qsize = _create_job_queue.qsize()
    except Exception:
        qsize = "?"
    logger.info(
        "[CREATE_PIPELINE] submit_create_job called chat_id=%s msg_id=%s order_id=%s queue_size=%s web=%s",
        chat_id, msg_id, form.get("order_id", ""), qsize, web,
    )


async def run_admin_bot_ptb() -> None:
    """Start admin bot using PTB: run polling in a thread, run alert and daily report loops via bot_ptb."""
    if not (getattr(config, "ADMIN_BOT_TOKEN", None) or "").strip():
        logger.warning("ADMIN_BOT_TOKEN not set; admin bot (PTB) not started")
        return

    from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
    from telegram.error import BadRequest, Forbidden, NetworkError
    from telegram.ext import (
        Application,
        CommandHandler,
        CallbackQueryHandler,
        MessageHandler,
        ContextTypes,
        filters,
    )

    def _clear_create_state(context: ContextTypes.DEFAULT_TYPE) -> None:
        ud = context.user_data
        ud.pop("create_step", None)
        ud.pop("create_data", None)
        ud.pop("add_sessions", None)

    async def _safe_callback_answer(callback_query) -> None:
        """Answer callback query; on NetworkError log and continue so the flow does not break."""
        try:
            await callback_query.answer()
        except NetworkError as e:
            logger.warning("[AdminPTB] callback answer failed (network), continuing: %s", e)
        except Exception as e:
            if "ReadError" in type(e).__name__ or "NetworkError" in type(e).__name__:
                logger.warning("[AdminPTB] callback answer failed (network), continuing: %s", e)
            else:
                raise

    async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            try:
                await update.message.reply_text("Unauthorized.")
            except Forbidden:
                logger.debug("Admin bot: cannot reply to unauthorized user (blocked or deleted chat).")
            return
        _clear_create_state(context)
        await update.message.reply_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())

    async def cmd_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        lines = [
            "*Admin commands*",
            "/start — Main menu",
            "/cmd — This list",
            "/dashboard or /dashboard\\_refresh — Dashboard counts \\+ Refresh button",
            "/health — Overview of all bots, valid till, sessions, alerts",
            "/cpu — CPU, RAM, disk, uptime, connectivity",
            "/logs — Send today's log files (main + per-bot)",
            "/order\\_id, /order\\_payment, /order\\_user — Search orders",
            "/user\\_id, /user\\_bot, /user\\_plan, /user\\_extend, /user\\_freeze — Users",
            "/fix <bot\\_name> — Repair menu for AdBot",
            "",
            "*Actions \\(via menu\\)*",
            "Control Center — System, Orders, Users, Sessions, Bots, Broadcast, Dashboard",
            "Create AdBots, Manage Sessions, Manage AdBots",
        ]
        await update.message.reply_text("\n".join(lines), parse_mode="MarkdownV2")

    async def cmd_health(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        data = load_adbot()
        bots = data.get("bots", {})
        lines = ["*Health overview*"]
        for token, cfg in bots.items():
            name = cfg.get("name") or token[:15]
            state = cfg.get("state", "stopped")
            valid = cfg.get("valid_till", "—")
            sessions = cfg.get("sessions", [])
            active = sum(1 for s in sessions if (config.SESSIONS_ACTIVE / (s.get("file") or "")).is_file())
            dead = len(sessions) - active
            workers = _workers_alive(token) if state == "running" else 0
            lines.append(
                f"• *{_md_escape(name)}* — {_md_escape(state)} \\| valid: {_md_escape(valid)} \\| sessions: "
                f"{_md_escape(active)} ok / {_md_escape(dead)} dead \\| workers: {_md_escape(workers)}/{_md_escape(len(sessions))}"
            )
            if cfg.get("state") == "dead" and cfg.get("dead_reason"):
                r = cfg.get("dead_reason", "")
                r_short = _md_escape(r[:80] + "…" if len(r) > 80 else r)
                lines.append(f"  _reason: {r_short}_")
        alerts = data.get("admin_alerts", [])[-10:]
        if alerts:
            lines.append("\n*Recent alerts*")
            for a in reversed(alerts):
                msg = (a.get("msg") or str(a))[:100]
                lines.append(f"  {_md_escape(msg)}")
        text = "\n".join(lines) if lines else "No bots."
        await update.message.reply_text(text, parse_mode="MarkdownV2")

    async def cmd_fix(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        bot_name = " ".join(args).strip() if args else ""
        data = load_adbot()
        bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
        if not bots:
            await update.message.reply_text("No AdBots.", reply_markup=_main_menu_buttons_ptb())
            return
        if not bot_name:
            context.user_data["fix_list"] = bots
            rows = [[InlineKeyboardButton(n, callback_data="fix_sel:" + str(i))] for i, (n, _) in enumerate(bots)]
            rows.append([InlineKeyboardButton("Cancel", callback_data="fix_cancel")])
            await update.message.reply_text(
                "Select AdBot to repair:",
                reply_markup=InlineKeyboardMarkup(rows),
            )
            return
        safe = name_to_filename(bot_name)
        bot_token = get_token_by_name(safe) or get_token_by_name(bot_name)
        if not bot_token:
            await update.message.reply_text(f"AdBot '{bot_name}' not found.")
            return
        name = next((n for n, t in bots if t == bot_token), bot_name)
        context.user_data["fix_bot_token"] = bot_token
        context.user_data["fix_bot_name"] = name
        rows = [
            [InlineKeyboardButton("Fix Log Group", callback_data="fix_log")],
            [InlineKeyboardButton("Fix Sessions", callback_data="fix_sess")],
            [InlineKeyboardButton("Fix Config", callback_data="fix_cfg")],
            [InlineKeyboardButton("Fix Bot Token", callback_data="fix_tok")],
            [InlineKeyboardButton("Cancel", callback_data="fix_cancel")],
        ]
        await update.message.reply_text(
            f"Repair menu for *{_md_escape(name)}*:",
            reply_markup=InlineKeyboardMarkup(rows),
            parse_mode="MarkdownV2",
        )

    async def cmd_cpu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        progress = await update.message.reply_text("Checking CPU, RAM, disk, uptime, connectivity…")
        try:
            lines = await asyncio.to_thread(_get_system_stats)
            text = "\n".join(_md_escape(line) for line in (lines or ["No data."]))
            await progress.edit_text(text, parse_mode="MarkdownV2")
        except Exception as e:
            logger.exception("on_cpu: %s", e)
            await progress.edit_text(f"Error: {e}")

    async def cmd_logs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        progress = await update.message.reply_text("Collecting log files…")
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
                await progress.edit_text("No log files found for today.")
                return
            await progress.edit_text(f"Sending {len(to_send)} log file(s)…")
            bot = bot_ptb._get_admin_bot()
            for path in to_send:
                try:
                    with open(path, "rb") as f:
                        await bot.send_document(chat_id=update.effective_chat.id, document=f, filename=path.name)
                except Exception as e:
                    logger.warning("Failed to send log %s: %s", path.name, e)
                    await update.message.reply_text(f"Could not send {path.name}: {e}")
            await progress.delete()
        except Exception as e:
            logger.exception("cmd_logs: %s", e)
            await progress.edit_text(f"Error: {e}")

    def _sessions_menu_ptb():
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        return InlineKeyboardMarkup([
            [InlineKeyboardButton("Add Sessions", callback_data="add_sessions"), InlineKeyboardButton("Remove Sessions", callback_data="remove_sessions")],
            [InlineKeyboardButton("Session Status", callback_data="session_status_overview")],
            [InlineKeyboardButton("« Back", callback_data="back_sessions")],
        ])

    def _manage_sessions_text(data) -> str:
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
        return "\n".join(lines)

    async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.callback_query or not update.effective_user or not _is_authorized(update.effective_user.id):
            if update.callback_query:
                await update.callback_query.answer("Unauthorized.", show_alert=True)
            return
        data = load_adbot()
        raw = update.callback_query.data or ""
        q = update.callback_query
        chat_id = update.effective_chat.id if update.effective_chat else (update.effective_user.id if update.effective_user else 0)
        logger.info("[AdminPTB] callback raw=%r", raw)

        if raw == "create_adbots":
            await _safe_callback_answer(q)
            status = _create_status_text(data)
            text = f"{status}\n\nProceed to create a new AdBot?"
            kb = InlineKeyboardMarkup([
                [InlineKeyboardButton("Proceed", callback_data="create_proceed"), InlineKeyboardButton("Cancel", callback_data="create_cancel")],
            ])
            await q.edit_message_text(text, reply_markup=kb)
            context.user_data["create_step"] = "ask_proceed"
            context.user_data["create_data"] = {}
            return
        if raw == "create_proceed":
            await _safe_callback_answer(q)
            if context.user_data.get("create_step") != "ask_proceed":
                await q.edit_message_text("Start from Create AdBots again.", reply_markup=_main_menu_buttons_ptb())
                _clear_create_state(context)
                return
            t, dead, assigned, free = _session_counts(data)
            if free == 0:
                await q.edit_message_text("No free sessions. Add sessions in Manage Sessions first.", reply_markup=_main_menu_buttons_ptb())
                _clear_create_state(context)
                return
            context.user_data["create_step"] = "name"
            await q.edit_message_text("Enter internal name (e.g. buyer2):\n\nType /cancel to abort.")
            return
        if raw == "create_cancel":
            await _safe_callback_answer(q)
            _clear_create_state(context)
            await q.edit_message_text("Cancelled.", reply_markup=_main_menu_buttons_ptb())
            return
        if raw in ("mode:starter", "mode:enterprise"):
            await q.answer()
            if context.user_data.get("create_step") != "mode":
                return
            context.user_data["create_data"]["mode"] = "Enterprise" if "enterprise" in raw else "Starter"
            files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
            if not files:
                await q.edit_message_text("No .txt files in groups/. Create one and try again.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="create_cancel")]]))
                return
            rows = [[InlineKeyboardButton(f.name, callback_data="gf:" + f.name)] for f in files[:20]]
            rows.append([InlineKeyboardButton("Cancel", callback_data="create_cancel")])
            await q.edit_message_text("Choose group file:", reply_markup=InlineKeyboardMarkup(rows))
            context.user_data["create_step"] = "group_file"
            return
        if raw.startswith("gf:"):
            fn = raw[3:]
            await q.answer()
            if context.user_data.get("create_step") != "group_file":
                return
            d = context.user_data.get("create_data", {})
            d["group_file"] = fn
            bot_tok = (d.get("bot_token") or "").strip()
            if bot_tok:
                ok, out = await validate_bot_token(bot_tok)
                if ok:
                    d["bot_username"] = out
            summary = (
                f"*Summary*\nName: {_md_escape(d.get('name'))}\nBot: @{_md_escape(d.get('bot_username', ''))}\n"
                f"Sessions: {_md_escape(d.get('sessions_count'))}\n"
                f"Cycle: {_md_escape(d.get('cycle'))}s \\| Gap: {_md_escape(d.get('gap'))}s\n"
                f"Valid till: {_md_escape(d.get('valid_till'))}\nRenewal price: {_md_escape(d.get('renewal_price', '0'))} USD\nMode: {_md_escape(d.get('mode'))}\n"
                f"Group file: {_md_escape(fn)}\n\nProceed?"
            )
            gf_path = config.GROUPS_DIR / fn
            if not gf_path.is_file():
                summary += "\nGroup file does not exist\\."
            context.user_data["create_step"] = "summary"
            await q.edit_message_text(summary, reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("Proceed", callback_data="create_final"), InlineKeyboardButton("Cancel", callback_data="create_cancel")],
            ]), parse_mode="MarkdownV2")
            return
        if raw == "create_final":
            await q.answer()
            if context.user_data.get("create_step") != "summary":
                await q.edit_message_text("Start from Create AdBots again.", reply_markup=_main_menu_buttons_ptb())
                _clear_create_state(context)
                return
            form = dict(context.user_data.get("create_data", {}))
            form["plan_name"] = "Custom"
            form["renewal_price"] = str(form.get("renewal_price") or "0")
            _clear_create_state(context)
            progress_msg = await context.bot.send_message(chat_id, "Create queued. I'll update this message when done.")
            msg_id = progress_msg.message_id
            adbot_data = load_adbot()
            if len(adbot_data.get("free_sessions", [])) == 0:
                await context.bot.edit_message_text(chat_id=chat_id, message_id=msg_id, text="No free sessions.")
                return
            if form.get("bot_token", "").strip() in adbot_data.get("bots", {}):
                await context.bot.edit_message_text(chat_id=chat_id, message_id=msg_id, text="This bot token is already registered.")
                return
            submit_create_job(chat_id, msg_id, form)
            return

        if raw == "manage_sessions":
            await q.answer()
            _clear_create_state(context)
            await q.edit_message_text(_manage_sessions_text(data), reply_markup=_sessions_menu_ptb())
            return
        if raw == "add_sessions":
            await q.answer()
            context.user_data["add_sessions"] = True
            await q.edit_message_text(
                "Send a single .session file, a .txt (one session filename per line), or a .zip containing session files.",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="cancel_add")]]),
            )
            return
        if raw == "cancel_add":
            await q.answer()
            context.user_data.pop("add_sessions", None)
            await q.edit_message_text(_manage_sessions_text(load_adbot()), reply_markup=_sessions_menu_ptb())
            return
        if raw == "back_sessions":
            await q.answer()
            context.user_data.pop("add_sessions", None)
            await q.edit_message_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())
            return

        if raw == "groups_menu":
            await q.answer()
            config.GROUPS_DIR.mkdir(parents=True, exist_ok=True)
            files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
            if not files:
                text = "Groups — no .txt files yet.\n\nUpload a .txt file with one group ID per line (must start with -100). Optional: -100123 | topic_id for forum topics."
            else:
                text = "Groups — group files (.txt):\n\n" + "\n".join(f.name for f in files)
            await q.edit_message_text(text, reply_markup=_groups_menu_markup())
            return
        if raw == "groups_back":
            await q.answer()
            context.user_data.pop("groups_await_upload", None)
            await q.edit_message_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())
            return
        if raw == "groups_upload":
            await q.answer()
            context.user_data["groups_await_upload"] = True
            await q.edit_message_text(
                "Send a .txt file.\n\nFormat: one group ID per line, must start with -100 (e.g. -1001234567890).\n"
                "For forum topics: -1001234567890 | 34\n\nType /cancel to abort.",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="groups_back")]]),
            )
            return
        if raw.startswith("groups_del:"):
            fn = raw[11:].strip()
            if not fn.endswith(".txt") or ".." in fn or "/" in fn or "\\" in fn:
                await q.answer("Invalid filename.", show_alert=True)
                return
            await q.answer()
            path = config.GROUPS_DIR / fn
            if path.is_file():
                try:
                    path.unlink()
                except OSError as e:
                    logger.warning("Could not delete group file %s: %s", path, e)
                    await q.answer(f"Delete failed: {e}", show_alert=True)
            files = sorted(config.GROUPS_DIR.glob("*.txt"), key=lambda p: p.name)
            text = "Groups — group files (.txt):\n\n" + "\n".join(f.name for f in files) if files else "Groups — no .txt files yet."
            await q.edit_message_text(text, reply_markup=_groups_menu_markup())
            return

        if raw == "remove_sessions":
            await q.answer()
            free_list = list(data.get("free_sessions", []))[:15]
            dead_list = list(data.get("dead_sessions", []))[:15]
            rows = []
            for name in free_list:
                rows.append([InlineKeyboardButton(" " + name, callback_data="del_f:" + name)])
            for name in dead_list:
                rows.append([InlineKeyboardButton(" " + name + " (dead)", callback_data="del_d:" + name)])
            if not rows:
                await q.edit_message_text("No free or dead sessions. Add some first.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="back_sessions")]]))
                return
            rows.append([InlineKeyboardButton("Back", callback_data="back_sessions")])
            await q.edit_message_text("Select session to remove:", reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw.startswith("del_f:") or raw.startswith("del_d:"):
            name = raw[6:] if raw.startswith("del_d:") else raw[6:]
            key, base_dir = ("free_sessions", config.SESSIONS_ACTIVE) if raw.startswith("del_f:") else ("dead_sessions", config.SESSIONS_DEAD)
            await q.answer("Removed.")
            d = load_adbot()
            lst = d.get(key, [])
            if name in lst:
                d[key] = [x for x in lst if x != name]
                save_adbot(d)
                p = base_dir / name
                if p.is_file():
                    try:
                        p.unlink()
                    except OSError as e:
                        logger.warning("Could not delete %s: %s", p, e)
            data = load_adbot()
            await q.edit_message_text(_manage_sessions_text(data), reply_markup=_sessions_menu_ptb())
            return

        # --- Session Status Overview + Move between buckets ---
        if raw == "session_status_overview":
            await q.answer()
            from .admin_control import session_full_list
            from .utils import load_pool
            pool = load_pool()
            # Build per-bucket lists
            buckets_info = [
                ("free", pool.get("free_sessions", [])),
                ("dead", pool.get("dead_sessions", [])),
                ("frozen", pool.get("frozen_sessions", [])),
                ("limited", pool.get("limited_sessions", [])),
                ("unauth", pool.get("unauth_sessions", [])),
            ]
            lines = ["Session Status Overview\n"]
            for bname, blist in buckets_info:
                icon = {"free": "🟢", "dead": "💀", "frozen": "🧊", "limited": "⚠️", "unauth": "🔒"}.get(bname, "•")
                lines.append(f"{icon} {bname.upper()}: {len(blist)}")
            # Show assigned count
            assigned_count = sum(len(c.get("sessions", [])) for c in data.get("bots", {}).values())
            lines.append(f"📌 ASSIGNED: {assigned_count}")
            rows = []
            # Only show buckets with sessions as expandable
            for bname, blist in buckets_info:
                if blist:
                    icon = {"free": "🟢", "dead": "💀", "frozen": "🧊", "limited": "⚠️", "unauth": "🔒"}.get(bname, "•")
                    rows.append([InlineKeyboardButton(f"{icon} View {bname.upper()} ({len(blist)})", callback_data=f"sess_view:{bname}")])
            rows.append([InlineKeyboardButton("« Back to Sessions", callback_data="back_sessions")])
            await q.edit_message_text("\n".join(lines), reply_markup=InlineKeyboardMarkup(rows))
            return

        if raw.startswith("sess_view:"):
            await q.answer()
            bucket = raw[10:]
            from .utils import load_pool
            pool = load_pool()
            pool_key_map = {"free": "free_sessions", "dead": "dead_sessions", "frozen": "frozen_sessions", "limited": "limited_sessions", "unauth": "unauth_sessions"}
            pool_key = pool_key_map.get(bucket)
            if not pool_key:
                await q.edit_message_text("Invalid bucket.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="session_status_overview")]]))
                return
            sessions_list = list(pool.get(pool_key, []))[:20]
            icon = {"free": "🟢", "dead": "💀", "frozen": "🧊", "limited": "⚠️", "unauth": "🔒"}.get(bucket, "•")
            lines = [f"{icon} {bucket.upper()} sessions ({len(pool.get(pool_key, []))})\n"]
            if not sessions_list:
                lines.append("(empty)")
            rows = []
            for i, fn in enumerate(sessions_list):
                short = fn[:30] + "…" if len(fn) > 30 else fn
                lines.append(f"{i+1}. {short}")
                rows.append([InlineKeyboardButton(f"Move: {short}", callback_data=f"sess_pick:{bucket}:{i}")])
            rows.append([InlineKeyboardButton("« Back to Overview", callback_data="session_status_overview")])
            await q.edit_message_text("\n".join(lines), reply_markup=InlineKeyboardMarkup(rows))
            return

        if raw.startswith("sess_pick:"):
            await q.answer()
            parts = raw.split(":", 2)
            if len(parts) < 3:
                return
            from_bucket = parts[1]
            try:
                idx = int(parts[2])
            except ValueError:
                return
            from .utils import load_pool
            pool = load_pool()
            pool_key_map = {"free": "free_sessions", "dead": "dead_sessions", "frozen": "frozen_sessions", "limited": "limited_sessions", "unauth": "unauth_sessions"}
            pool_key = pool_key_map.get(from_bucket)
            if not pool_key:
                return
            sessions_list = list(pool.get(pool_key, []))
            if idx < 0 or idx >= len(sessions_list):
                await q.edit_message_text("Session not found.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="session_status_overview")]]))
                return
            fn = sessions_list[idx]
            short = fn[:30] + "…" if len(fn) > 30 else fn
            # Show move options: all other buckets
            target_labels = {"free": "🟢 Free (Active)", "dead": "💀 Dead", "frozen": "🧊 Frozen", "limited": "⚠️ Limited", "unauth": "🔒 Unauth"}
            rows = []
            for target_bucket, label in target_labels.items():
                if target_bucket != from_bucket:
                    rows.append([InlineKeyboardButton(f"→ {label}", callback_data=f"sess_move:{from_bucket}:{idx}:{target_bucket}")])
            rows.append([InlineKeyboardButton("« Cancel", callback_data=f"sess_view:{from_bucket}")])
            await q.edit_message_text(f"Move session:\n{fn}\n\nCurrently: {from_bucket.upper()}\nSelect destination:", reply_markup=InlineKeyboardMarkup(rows))
            return

        if raw.startswith("sess_move:"):
            await q.answer()
            parts = raw.split(":", 3)
            if len(parts) < 4:
                return
            from_bucket = parts[1]
            try:
                idx = int(parts[2])
            except ValueError:
                return
            to_bucket = parts[3]
            from .utils import load_pool
            from .admin_control import session_move
            pool = load_pool()
            pool_key_map = {"free": "free_sessions", "dead": "dead_sessions", "frozen": "frozen_sessions", "limited": "limited_sessions", "unauth": "unauth_sessions"}
            pool_key = pool_key_map.get(from_bucket)
            if not pool_key:
                return
            sessions_list = list(pool.get(pool_key, []))
            if idx < 0 or idx >= len(sessions_list):
                await q.edit_message_text("Session not found.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="session_status_overview")]]))
                return
            fn = sessions_list[idx]
            ok, msg = session_move(fn, from_bucket, to_bucket)
            icon = {"free": "🟢", "dead": "💀", "frozen": "🧊", "limited": "⚠️", "unauth": "🔒"}.get(to_bucket, "•")
            result_text = f"{'✅' if ok else '❌'} {fn}\n{msg}" if ok else f"❌ Failed: {msg}"
            await q.edit_message_text(result_text, reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("« Back to Overview", callback_data="session_status_overview")],
            ]))
            return

        if raw == "manage_adbots":
            await q.answer()
            _clear_create_state(context)
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            if not bots:
                await q.edit_message_text("No AdBots.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="adb_back")]]))
                return
            context.user_data["adb_list"] = bots
            rows = [[InlineKeyboardButton(n, callback_data="adb_sel:" + str(i))] for i, (n, _) in enumerate(bots)]
            rows.append([InlineKeyboardButton("Back", callback_data="adb_back")])
            await q.edit_message_text("Manage AdBots - pick one:", reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw == "adb_back":
            await q.answer()
            await q.edit_message_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())
            return

        if raw == "control_center":
            await q.answer()
            await q.edit_message_text(
                "Control Center:",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("System", callback_data="cc_system"), InlineKeyboardButton("Orders", callback_data="cc_orders")],
                    [InlineKeyboardButton("Users", callback_data="cc_users"), InlineKeyboardButton("Sessions", callback_data="cc_sessions")],
                    [InlineKeyboardButton("Bots", callback_data="manage_adbots"), InlineKeyboardButton("Broadcast", callback_data="cc_broadcast")],
                    [InlineKeyboardButton("Dashboard", callback_data="cc_dashboard")],
                    [InlineKeyboardButton("« Back", callback_data="cc_back")],
                ]),
            )
            return
        if raw == "cc_back":
            await q.answer()
            await q.edit_message_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())
            return

        if raw == "cc_system":
            await q.answer()
            from .maintenance import load_maintenance, save_maintenance, is_maintenance_enabled, process_maintenance_queue_and_clear, load_maintenance_queue
            from .admin_control import emergency_stop_all_posting, emergency_resume_all_posting
            m = load_maintenance()
            enabled = m.get("enabled", False)
            queue_count = len(load_maintenance_queue())
            status = "ON" if enabled else "OFF"
            text = f"System control\n\nMaintenance: {status}\nQueue to notify when off: {queue_count}"
            async def send_maintenance_complete(uid: int, msg: str):
                try:
                    await context.bot.send_message(chat_id=uid, text=msg)
                    return True
                except Exception:
                    return False
            rows = []
            if enabled:
                rows.append([InlineKeyboardButton("Turn maintenance OFF", callback_data="maint_off")])
            else:
                rows.append([InlineKeyboardButton("Turn maintenance ON", callback_data="maint_on")])
            rows.append([InlineKeyboardButton("Emergency: Stop all posting", callback_data="emergency_stop")])
            rows.append([InlineKeyboardButton("Emergency: Resume all posting", callback_data="emergency_resume")])
            rows.append([InlineKeyboardButton("« Back", callback_data="control_center")])
            await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw == "maint_on":
            await q.answer()
            from .maintenance import save_maintenance
            from .audit import log_admin_action
            save_maintenance(True)
            admin_id = update.effective_user.id if update.effective_user else None
            log_admin_action(admin_id or 0, "maintenance_on", target=None)
            await q.edit_message_text("Maintenance mode is ON. Users will see the maintenance message.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_system")]]))
            return
        if raw == "maint_off":
            await q.answer()
            from .maintenance import save_maintenance, process_maintenance_queue_and_clear, load_maintenance_queue
            from .audit import log_admin_action
            save_maintenance(False)
            admin_id = update.effective_user.id if update.effective_user else None
            log_admin_action(admin_id or 0, "maintenance_off", target=None)
            queue = load_maintenance_queue()
            if queue:
                await q.edit_message_text(f"Notifying {len(queue)} user(s)… Rate-limited.")
                async def send_func(uid: int, msg: str):
                    try:
                        await context.bot.send_message(chat_id=uid, text=msg)
                        return True
                    except Exception:
                        return False
                sent, failed = await process_maintenance_queue_and_clear(send_func)
                await q.edit_message_text(f"Maintenance OFF. Notified: {sent} sent, {failed} failed.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_system")]]))
            else:
                await q.edit_message_text("Maintenance mode is OFF.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_system")]]))
            return
        if raw == "emergency_stop":
            await q.answer()
            from .admin_control import emergency_stop_all_posting
            admin_id = update.effective_user.id if update.effective_user else None
            n, msg = emergency_stop_all_posting(admin_id=admin_id)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_system")]]))
            return
        if raw == "emergency_resume":
            await q.answer()
            from .admin_control import emergency_resume_all_posting
            admin_id = update.effective_user.id if update.effective_user else None
            n, msg = emergency_resume_all_posting(admin_id=admin_id)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_system")]]))
            return

        if raw == "cc_dashboard" or raw == "cc_dashboard_refresh":
            await q.answer()
            from .admin_control import dashboard_counts
            c = dashboard_counts()
            lines = [
                "Dashboard",
                f"Bots: {c['total_bots']} total, {c['running_bots']} running, {c['stopped_bots']} stopped",
                f"Sessions: {c['free_sessions']} free, {c['assigned_sessions']} assigned, {c['dead_sessions']} dead, {c['frozen_sessions']} frozen",
                "Orders: " + ", ".join(f"{k}={v}" for k, v in sorted(c["orders_by_status"].items())),
                f"Create worker: {'OK' if c.get('create_worker_ok') else 'Stale'}",
                f"Payment worker: {'OK' if c.get('payment_worker_ok') else 'Stale'}",
            ]
            await q.edit_message_text(
                "\n".join(lines),
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Refresh", callback_data="cc_dashboard_refresh")],
                    [InlineKeyboardButton("« Back", callback_data="control_center")],
                ]),
            )
            return

        if raw == "cc_orders":
            await q.answer()
            await q.edit_message_text(
                "Order search: use /order_id <id>, /order_payment <payment_id>, /order_user <user_id> to search. Or:",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Pending creations", callback_data="pending_orders")],
                    [InlineKeyboardButton("« Back", callback_data="control_center")],
                ]),
            )
            return

        if raw == "cc_users":
            await q.answer()
            await q.edit_message_text(
                "User search: use /user_id <telegram_id>, /user_bot @username, /user_plan <plan_name>",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="control_center")]]),
            )
            return

        if raw == "cc_sessions":
            await q.answer()
            from .admin_control import session_full_list, session_to_bot_map
            slist = session_full_list()
            smap = session_to_bot_map()
            lines = [f"Sessions: {len(slist)} total. Map: {len(smap)} assigned."]
            for s in slist[:20]:
                lines.append(f"  {s['file'][:30]} — {s['status']}" + (f" ({s['bot_name']})" if s.get("bot_name") else ""))
            if len(slist) > 20:
                lines.append("  …")
            await q.edit_message_text(
                "\n".join(lines),
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Full list (next 20)", callback_data="sess_list:20")],
                    [InlineKeyboardButton("Session → Bot map", callback_data="sess_map")],
                    [InlineKeyboardButton("Manage Sessions", callback_data="manage_sessions")],
                    [InlineKeyboardButton("« Back", callback_data="control_center")],
                ]),
            )
            return
        if raw == "cc_broadcast":
            await q.answer()
            await q.edit_message_text(
                "Select Broadcast Target:",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("All Users", callback_data="bc_target:all_users"), InlineKeyboardButton("Plan Users", callback_data="bc_target:plan_users")],
                    [InlineKeyboardButton("Cancel", callback_data="bc_cancel")],
                ]),
            )
            return
        if raw.startswith("bc_target:"):
            await q.answer()
            target = raw[10:]
            if target not in ("all_users", "plan_users"):
                await q.edit_message_text("Invalid target.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_broadcast")]]))
                return
            from .admin_control import broadcast_recipients_all_users, broadcast_recipients_plan_users
            if target == "all_users":
                n = len(broadcast_recipients_all_users())
            else:
                n = len(broadcast_recipients_plan_users())
            context.user_data["broadcast_target"] = target
            context.user_data["broadcast_ts"] = time.time()
            context.user_data.pop("broadcast_payload", None)
            target_label = "All Users (Shop Bot)" if target == "all_users" else "Plan Users (assigned bot per user)"
            await q.edit_message_text(
                f"Target: {target_label}\nRecipients: {n}\n\nSend the broadcast message (text, photo, video, document, caption, premium emoji supported).\n\nOr /cancel to cancel.",
            )
            return
        if raw == "bc_send":
            await q.answer()
            ud = context.user_data
            payload = ud.get("broadcast_payload")
            target = ud.get("broadcast_target")
            if not target:
                await q.edit_message_text("Session expired. Start again from Control Center → Broadcast.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_broadcast")]]))
                _broadcast_clear(ud)
                return
            if not payload or "chat_id" not in payload or "message_id" not in payload:
                await q.edit_message_text("Missing message. Send the broadcast content first, then press Send.")
                return
            broadcast_ts = ud.get("broadcast_ts") or 0
            if time.time() - broadcast_ts > BROADCAST_SESSION_TIMEOUT_SEC:
                await q.edit_message_text(f"Broadcast session expired ({BROADCAST_SESSION_TIMEOUT_SEC // 60} min). Start again from Control Center → Broadcast.")
                _broadcast_clear(ud)
                return
            if ud.get("broadcast_sending"):
                await q.answer("Broadcast already in progress.", show_alert=True)
                return
            ud["broadcast_sending"] = True
            try:
                sent, failed = await _run_broadcast(context, update, target, payload)
                await context.bot.send_message(
                    chat_id=update.effective_user.id,
                    text=f"Broadcast Completed\n\nSent: {sent}\nFailed: {failed}",
                )
            except Exception as e:
                logger.exception("Broadcast error: %s", e)
                await context.bot.send_message(chat_id=update.effective_user.id, text=f"Broadcast error: {e}")
            finally:
                ud.pop("broadcast_sending", None)
                _broadcast_clear(ud)
            return
        if raw == "bc_cancel":
            await q.answer()
            _broadcast_clear(context.user_data)
            await q.edit_message_text("Broadcast cancelled.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_broadcast")]]))
            return
        if raw.startswith("sess_list:"):
            await q.answer()
            from .admin_control import session_full_list
            offset = int(raw.split(":")[1] or "0")
            slist = session_full_list()
            chunk = slist[offset:offset + 20]
            lines = [f"Sessions (offset {offset}):"]
            for s in chunk:
                lines.append(f"  {s['file'][:40]} — {s['status']}" + (f" ({s['bot_name']})" if s.get("bot_name") else ""))
            next_btn = [InlineKeyboardButton("Next 20", callback_data="sess_list:" + str(offset + 20))] if offset + 20 < len(slist) else []
            await q.edit_message_text("\n".join(lines) or "No sessions.", reply_markup=InlineKeyboardMarkup([next_btn, [InlineKeyboardButton("« Back", callback_data="cc_sessions")]]))
            return
        if raw == "sess_map":
            await q.answer()
            from .admin_control import session_to_bot_map
            smap = session_to_bot_map()
            lines = ["Session → Bot"]
            for fn, bname in smap[:30]:
                lines.append(f"  {fn[:35]} → {bname}")
            if len(smap) > 30:
                lines.append("  …")
            await q.edit_message_text("\n".join(lines), reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_sessions")]]))
            return
        if raw.startswith("order_act:"):
            await q.answer()
            parts = raw[10:].split(":")
            if len(parts) < 2:
                return
            order_id, action = parts[0], parts[1]
            from .admin_control import order_mark_paid, order_cancel
            from .shop.handlers import recreate_pending_order
            from .shop.storage import get_order
            o = get_order(order_id)
            if not o:
                await q.edit_message_text("Order not found.")
                return
            admin_id = update.effective_user.id if update.effective_user else None
            if action == "mark_paid":
                from .audit import log_admin_action
                ok, msg = order_mark_paid(order_id, trigger_creation=True)
                log_admin_action(admin_id or 0, "mark_paid", target=order_id)
                await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_orders")]]))
                return
            if action == "cancel":
                from .audit import log_admin_action
                ok, msg = order_cancel(order_id)
                log_admin_action(admin_id or 0, "cancel_order", target=order_id)
                await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="cc_orders")]]))
                return
            if action == "rerun":
                from .audit import log_admin_action
                ok, msg = await recreate_pending_order(order_id)
                log_admin_action(admin_id or 0, "rerun_creation", target=order_id)
                await q.edit_message_text(msg if ok else f"Failed: {msg}")
                return
            return

        if raw == "pending_orders":
            await q.answer()
            from code.shop.storage import orders_pending_creation
            pending = orders_pending_creation()
            if not pending:
                await q.edit_message_text("No pending shop orders.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="adb_back")]]))
                return
            rows = []
            for o in pending[:20]:
                oid = o.get("order_id", "")[:8]
                rows.append([InlineKeyboardButton(f"Order {oid} — Recreate", callback_data="shop_recreate:" + o.get("order_id", ""))])
            rows.append([InlineKeyboardButton("Back", callback_data="adb_back")])
            await q.edit_message_text(
                "Pending creations (insufficient sessions at payment). Add sessions then press Recreate:",
                reply_markup=InlineKeyboardMarkup(rows),
            )
            return
        if raw.startswith("shop_recreate:"):
            order_id = raw.split(":", 1)[1]
            await q.answer()
            from code.shop.handlers import recreate_pending_order
            ok, msg = await recreate_pending_order(order_id)
            if ok:
                await q.edit_message_text(f"Recreate submitted for order {order_id}. The buyer will see progress.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="pending_orders")]]))
            else:
                await q.edit_message_text(f"Recreate failed: {msg}", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="pending_orders")]]))
            return

        if raw.startswith("adb_sel:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            context.user_data["adb_selected_index"] = i
            from .users import get_bot_last_activity_ts
            last_act = get_bot_last_activity_ts(token)
            rows = [
                [InlineKeyboardButton("📂 Groups / Chatlist", callback_data="adb_groups:" + str(i))],
                [InlineKeyboardButton("Validate sessions", callback_data="adb_val:" + str(i))],
                [InlineKeyboardButton("Replace dead sessions", callback_data="adb_rep:" + str(i))],
                [InlineKeyboardButton("Replace error sessions", callback_data="adb_repe:" + str(i))],
                [InlineKeyboardButton("Recreate log group", callback_data="adb_rec:" + str(i))],
                [InlineKeyboardButton("Suspend", callback_data="adb_suspend:" + str(i)), InlineKeyboardButton("Resume", callback_data="adb_resume:" + str(i))],
                [InlineKeyboardButton("Force restart", callback_data="adb_restart:" + str(i)), InlineKeyboardButton("Transfer ownership", callback_data="adb_transfer:" + str(i))],
                [InlineKeyboardButton("Delete this AdBot", callback_data="adb_del:" + str(i))],
                [InlineKeyboardButton("Back to list", callback_data="adb_backlist")],
            ]
            last_act_ago = f"Last activity: {int(time.time() - last_act)}s ago" if last_act else "Last activity: —"
            await q.edit_message_text(
                f"*{_md_escape(name)}* \\- {_md_escape(last_act_ago)}\nActions:",
                reply_markup=InlineKeyboardMarkup(rows),
                parse_mode="MarkdownV2",
            )
            return
        # ── Admin Groups / Chatlist management for a specific bot ──
        if raw.startswith("adb_groups:"):
            try:
                i = int(raw[11:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            from .utils import load_user_data, get_name_by_token
            from .chatlist import get_chatlist_config, load_custom_groups, MAX_CHATLIST_LINKS, MAX_GROUPS_PER_CHATLIST, STARTER_MAX_GROUPS
            bot_name = get_name_by_token(token)
            cfg = load_user_data(bot_name) if bot_name else {}
            cl = get_chatlist_config(cfg) if cfg else {"links": [], "slugs": [], "active": False}
            mode = get_plan_mode(cfg)
            lines = [f"📂 Groups — {name}\n"]
            if cl["active"] and cl["links"]:
                for li, link in enumerate(cl["links"]):
                    lines.append(f"Folder {li+1}: {link}")
                custom_groups = load_custom_groups(bot_name) if bot_name else []
                lines.append(f"Groups loaded: {len(custom_groups)}")
                lines.append(f"Group file: {cfg.get('group_file', '')}")
            else:
                lines.append("No custom chatlist active.")
                lines.append(f"Current file: {cfg.get('group_file', 'Starter.txt')}")
            lines.append(f"\nMode: {mode}")
            if mode == "Starter":
                lines.append(f"Starter limit: max {STARTER_MAX_GROUPS} groups")
            else:
                lines.append("Enterprise: all groups used, sharded across sessions")
            lines.append(f"Limits: {MAX_CHATLIST_LINKS} chatlist links, {MAX_GROUPS_PER_CHATLIST} groups each")
            buttons = []
            if cl["active"]:
                buttons.append([InlineKeyboardButton("📋 View Groups", callback_data="adb_cl_view:" + str(i))])
                buttons.append([InlineKeyboardButton("➕ Change Chatlist", callback_data="adb_cl_add:" + str(i))])
                buttons.append([InlineKeyboardButton("📤 Upload Group File", callback_data="adb_cl_upload:" + str(i))])
                buttons.append([InlineKeyboardButton("🔄 Revert to Default", callback_data="adb_cl_revert:" + str(i))])
            else:
                buttons.append([InlineKeyboardButton("➕ Add Chatlist", callback_data="adb_cl_add:" + str(i))])
                buttons.append([InlineKeyboardButton("📤 Upload Group File", callback_data="adb_cl_upload:" + str(i))])
            buttons.append([InlineKeyboardButton("« Back", callback_data="adb_sel:" + str(i))])
            await q.edit_message_text("\n".join(lines), reply_markup=InlineKeyboardMarkup(buttons))
            return
        if raw.startswith("adb_cl_view:"):
            try:
                i = int(raw[12:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            from .utils import get_name_by_token
            from .chatlist import load_custom_groups
            bot_name = get_name_by_token(token)
            custom = load_custom_groups(bot_name) if bot_name else []
            if not custom:
                await q.edit_message_text("No custom groups loaded.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="adb_groups:" + str(i))]]))
                return
            preview = custom[:40]
            text = "Custom Groups (first 40):\n\n" + "\n".join(preview)
            if len(custom) > 40:
                text += f"\n… and {len(custom) - 40} more."
            text += f"\n\nTotal: {len(custom)} groups"
            await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="adb_groups:" + str(i))]]))
            return
        if raw.startswith("adb_cl_add:"):
            try:
                i = int(raw[11:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            context.user_data["adb_cl_token"] = token
            context.user_data["adb_cl_name"] = name
            context.user_data["adb_cl_index"] = i
            await q.edit_message_text(
                f"Send chatlist link(s) for {name}\n\n"
                "Send 1 or 2 Telegram chatlist links (t.me/addlist/…).\n"
                "Send them in a single message, one per line.\n\n"
                "Example:\nhttps://t.me/addlist/JC_cD1R7ibYwZmI0\n\n"
                "⚠️ Current chatlist will be replaced.\n"
                "Type /cancel to abort.",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="adb_groups:" + str(i))]]),
            )
            return
        if raw.startswith("adb_cl_upload:"):
            try:
                i = int(raw[14:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            context.user_data["adb_cl_upload_token"] = token
            context.user_data["adb_cl_upload_name"] = name
            context.user_data["adb_cl_upload_index"] = i
            await q.edit_message_text(
                f"Upload a .txt group file for {name}\n\n"
                "Format: one group ID per line, must start with -100.\n"
                "For forum topics: -1001234567890 | 34\n\n"
                "Type /cancel to abort.",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="adb_groups:" + str(i))]]),
            )
            return
        if raw.startswith("adb_cl_revert:"):
            try:
                i = int(raw[14:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            from .utils import load_user_data, save_user_data, get_name_by_token
            from .chatlist import clear_chatlist_config, default_group_file_for_mode
            bot_name = get_name_by_token(token)
            if not bot_name:
                await q.edit_message_text("Bot not found.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="adb_groups:" + str(i))]]))
                return
            cfg = load_user_data(bot_name)
            mode = get_plan_mode(cfg)
            default_gf = default_group_file_for_mode(mode)
            clear_chatlist_config(cfg)
            cfg["group_file"] = default_gf
            save_user_data(bot_name, cfg)
            await q.edit_message_text(
                f"✓ Chatlist removed for {name}.\nReverted to default: {default_gf}",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back", callback_data="adb_groups:" + str(i))]]),
            )
            return

        if raw == "adb_backlist":
            await q.answer()
            data = load_adbot()
            bots = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
            context.user_data["adb_list"] = bots
            if not bots:
                await q.edit_message_text("No AdBots.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="adb_back")]]))
                return
            rows = [[InlineKeyboardButton(n, callback_data="adb_sel:" + str(i))] for i, (n, _) in enumerate(bots)]
            rows.append([InlineKeyboardButton("Back", callback_data="adb_back")])
            await q.edit_message_text("Manage AdBots - pick one:", reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw.startswith("adb_val:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            _, token = bl[i]
            await q.edit_message_text("Validating this bot sessions...")
            d = load_adbot()
            async def progress(m: str):
                try:
                    await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=m)
                except Exception:
                    pass
            ok, dead = await _admin_validate_sessions(d, log=progress, bot_token=token)
            save_adbot(d)
            await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=f"Validate: {ok} ok, {dead} moved to dead.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_rep:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            _, token = bl[i]
            await q.edit_message_text("Replacing dead sessions...")
            d = load_adbot()
            async def progress(m: str):
                try:
                    await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=m)
                except Exception:
                    pass
            msg = await _admin_replace_dead(d, log=progress, bot_token=token)
            save_adbot(d)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_repe:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            _, token = bl[i]
            await q.edit_message_text("Replacing error sessions...")
            d = load_adbot()
            async def progress(m: str):
                try:
                    await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=m)
                except Exception:
                    pass
            msg = await _admin_replace_error_sessions(d, log=progress, bot_token=token)
            save_adbot(d)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_rec:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            _, token = bl[i]
            await q.edit_message_text("Recreating log group...")
            d = load_adbot()
            async def progress(m: str):
                try:
                    await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=m)
                except Exception:
                    pass
            msg = await _admin_recreate_log_group(None, chat_id, token, d, log=progress)
            save_adbot(d)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_suspend:"):
            try:
                i = int(raw[11:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            from .admin_control import user_set_suspended
            from .audit import log_admin_action
            ok, msg = user_set_suspended(token, True)
            log_admin_action(update.effective_user.id if update.effective_user else None, "bot_suspend", target=name)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_resume:"):
            try:
                i = int(raw[10:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            from .admin_control import user_set_suspended
            from .audit import log_admin_action
            ok, msg = user_set_suspended(token, False)
            log_admin_action(update.effective_user.id if update.effective_user else None, "bot_resume", target=name)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_restart:"):
            try:
                i = int(raw[11:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            submit_main_loop_job("restart_bot", (token,))
            await q.edit_message_text(f"Restart requested for {name}. The main loop will stop and start posting shortly.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to list", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_transfer:"):
            try:
                i = int(raw[12:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            bl = context.user_data.get("adb_list", [])
            if i < 0 or i >= len(bl):
                return
            name, token = bl[i]
            context.user_data["adb_transfer_token"] = token
            context.user_data["adb_transfer_name"] = name
            await q.edit_message_text("Send the new owner Telegram user ID (numeric):", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="adb_backlist")]]))
            return
        if raw.startswith("adb_del:"):
            await q.answer()
            logger.info("[AdminPTB] delete confirm screen: raw=%r", raw)
            try:
                i = int(raw[8:])
            except ValueError:
                logger.warning("[AdminPTB] adb_del invalid index: raw=%r", raw)
                await q.edit_message_text("Invalid. Go to Manage AdBots and try again.", reply_markup=_main_menu_buttons_ptb())
                return
            bl = context.user_data.get("adb_list", [])
            if not bl:
                data = load_adbot()
                bl = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
                context.user_data["adb_list"] = bl
            if i < 0 or i >= len(bl):
                await q.edit_message_text("Session expired. Go to Manage AdBots and try again.", reply_markup=_main_menu_buttons_ptb())
                return
            name, token = bl[i]
            data = load_adbot()
            cfg = (data.get("bots") or {}).get(token) or {}
            bot_username = (cfg.get("bot_username") or "").strip() or "—"
            valid_till = (cfg.get("valid_till") or "").strip() or "—"
            plan_name = (cfg.get("plan_name") or "").strip() or "—"
            mode = get_plan_mode(cfg) if cfg else "—"
            token_display = (token[:20] + "…") if len(token) > 20 else token
            sessions = [s.get("file") or "?" for s in cfg.get("sessions", []) if s.get("file")]
            sessions_line = ", ".join(sessions[:10]) if sessions else "—"
            if len(sessions) > 10:
                sessions_line += f" … (+{len(sessions) - 10} more)"
            lines = [
                f"*Bot username:* @{_md_escape(bot_username)}",
                f"*Bot name:* {_md_escape(name)}",
                f"*Bot token:* `{_md_escape(token_display)}`",
                f"*Plan name:* {_md_escape(plan_name)}",
                f"*Validity:* {_md_escape(valid_till)}",
                f"*Mode:* {_md_escape(mode)}",
                f"*Sessions:* {_md_escape(sessions_line)}",
                "",
                "Are you sure? This will stop the bot, remove it from DB \\(logs, stats\\), and return sessions to the free pool\\.",
            ]
            await q.edit_message_text(
                "\n".join(lines),
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🗑 Delete", callback_data="adb_dconfirm:" + str(i))],
                    [InlineKeyboardButton("Cancel", callback_data="adb_backlist")],
                ]),
                parse_mode="MarkdownV2",
            )
            return
        if raw.startswith("adb_dconfirm:"):
            await q.answer()
            logger.info("[AdminPTB] delete execute: raw=%r", raw)
            prefix = "adb_dconfirm:"
            try:
                i = int(raw[len(prefix):])
            except ValueError:
                logger.warning("[AdminPTB] adb_dconfirm invalid index: raw=%r", raw)
                await q.edit_message_text("Invalid. Go to Manage AdBots and try again.", reply_markup=_main_menu_buttons_ptb())
                return
            bl = context.user_data.get("adb_list", [])
            if not bl:
                data = load_adbot()
                bl = [(c.get("name") or t[:15], t) for t, c in data.get("bots", {}).items()]
                context.user_data["adb_list"] = bl
            if i < 0 or i >= len(bl):
                await q.edit_message_text("Session expired. Go to Manage AdBots and try again.", reply_markup=_main_menu_buttons_ptb())
                return
            name, bot_token = bl[i]
            submit_main_loop_job("delete_bot", (bot_token, chat_id, q.message.message_id, "free", name))
            await q.edit_message_text("Deleting AdBot… I'll update this message when done.")
            return

        # /fix repair menu callbacks
        if raw == "fix_cancel":
            await q.answer()
            for k in ("fix_bot_token", "fix_bot_name", "fix_list", "fix_wait_token"):
                context.user_data.pop(k, None)
            await q.edit_message_text("Cancelled.", reply_markup=_main_menu_buttons_ptb())
            return
        if raw.startswith("fix_sel:"):
            try:
                i = int(raw[8:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            fl = context.user_data.get("fix_list", [])
            if i < 0 or i >= len(fl):
                await q.edit_message_text("Invalid.", reply_markup=_main_menu_buttons_ptb())
                return
            name, bot_token = fl[i]
            context.user_data["fix_bot_token"] = bot_token
            context.user_data["fix_bot_name"] = name
            rows = [
                [InlineKeyboardButton("Fix Log Group", callback_data="fix_log")],
                [InlineKeyboardButton("Fix Sessions", callback_data="fix_sess")],
                [InlineKeyboardButton("Fix Config", callback_data="fix_cfg")],
                [InlineKeyboardButton("Fix Bot Token", callback_data="fix_tok")],
                [InlineKeyboardButton("Cancel", callback_data="fix_cancel")],
            ]
            await q.edit_message_text(
                f"Repair menu for *{_md_escape(name)}*:",
                reply_markup=InlineKeyboardMarkup(rows),
                parse_mode="MarkdownV2",
            )
            return
        if raw == "fix_log":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            if not bot_token:
                await q.edit_message_text("Session expired. Use /fix again.")
                return
            await q.edit_message_text("Fixing log group…")
            async def progress(m: str):
                try:
                    await context.bot.edit_message_text(chat_id=chat_id, message_id=q.message.message_id, text=m)
                except Exception:
                    pass
            msg = await repair_fix_log_group(bot_token, log_async=progress)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
            return
        if raw == "fix_sess":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            if not bot_token:
                await q.edit_message_text("Session expired. Use /fix again.")
                return
            await q.edit_message_text("Checking sessions…")
            result = await repair_fix_sessions(bot_token)
            if "error" in result:
                await q.edit_message_text(result["error"], reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
                return
            statuses = result.get("sessions", {})
            sfiles = list(statuses.keys())
            context.user_data["fix_sess_statuses"] = statuses
            context.user_data["fix_sess_files"] = sfiles
            rows = []
            for i, fn in enumerate(sfiles):
                status = statuses.get(fn, "UNKNOWN")
                rows.append([InlineKeyboardButton(f"{fn} — {status}", callback_data=f"fix_sess:{i}")])
            rows.append([InlineKeyboardButton("Back", callback_data="fix_back")])
            if not rows:
                await q.edit_message_text("No sessions.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
                return
            await q.edit_message_text("Sessions (select to replace):", reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw.startswith("fix_sess:"):
            try:
                idx = int(raw[9:])
            except ValueError:
                await q.answer()
                return
            await q.answer()
            sfiles = context.user_data.get("fix_sess_files", [])
            statuses = context.user_data.get("fix_sess_statuses", {})
            if idx < 0 or idx >= len(sfiles):
                await q.edit_message_text("Invalid.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_sess_back")]]))
                return
            fn = sfiles[idx]
            status = statuses.get(fn, "UNKNOWN")
            context.user_data["fix_sess_file"] = fn
            context.user_data["fix_sess_status"] = status
            rows = [
                [InlineKeyboardButton("Replace", callback_data="fix_sess_rep")],
                [InlineKeyboardButton("Cancel", callback_data="fix_sess_back")],
            ]
            await q.edit_message_text(f"Session {fn} — {status}. Replace?", reply_markup=InlineKeyboardMarkup(rows))
            return
        if raw == "fix_sess_rep":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            fn = context.user_data.pop("fix_sess_file", None)
            status = context.user_data.pop("fix_sess_status", "UNKNOWN")
            if not bot_token or not fn:
                await q.edit_message_text("Session expired.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
                return
            await q.edit_message_text("Replacing…")
            msg = await repair_replace_session(bot_token, fn, status)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
            return
        if raw == "fix_sess_back":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            name = context.user_data.get("fix_bot_name", "AdBot")
            rows = [
                [InlineKeyboardButton("Fix Log Group", callback_data="fix_log")],
                [InlineKeyboardButton("Fix Sessions", callback_data="fix_sess")],
                [InlineKeyboardButton("Fix Config", callback_data="fix_cfg")],
                [InlineKeyboardButton("Fix Bot Token", callback_data="fix_tok")],
                [InlineKeyboardButton("Cancel", callback_data="fix_cancel")],
            ]
            await q.edit_message_text(f"Repair menu for *{_md_escape(name)}*:", reply_markup=InlineKeyboardMarkup(rows), parse_mode="MarkdownV2")
            return
        if raw == "fix_cfg":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            if not bot_token:
                await q.edit_message_text("Session expired. Use /fix again.")
                return
            await q.edit_message_text("Fixing config…")
            msg = await repair_fix_config(bot_token)
            await q.edit_message_text(msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="fix_back")]]))
            return
        if raw == "fix_tok":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            if not bot_token:
                await q.edit_message_text("Session expired. Use /fix again.")
                return
            context.user_data["fix_wait_token"] = True
            await q.edit_message_text(
                "Send the new bot token. This will deactivate the old controller bot and activate the new one.",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Cancel", callback_data="fix_cancel")]]),
            )
            return
        if raw == "fix_back":
            await q.answer()
            bot_token = context.user_data.get("fix_bot_token")
            name = context.user_data.get("fix_bot_name", "AdBot")
            rows = [
                [InlineKeyboardButton("Fix Log Group", callback_data="fix_log")],
                [InlineKeyboardButton("Fix Sessions", callback_data="fix_sess")],
                [InlineKeyboardButton("Fix Config", callback_data="fix_cfg")],
                [InlineKeyboardButton("Fix Bot Token", callback_data="fix_tok")],
                [InlineKeyboardButton("Cancel", callback_data="fix_cancel")],
            ]
            await q.edit_message_text(f"Repair menu for *{_md_escape(name)}*:", reply_markup=InlineKeyboardMarkup(rows), parse_mode="MarkdownV2")
            return

        await q.answer()
        await q.edit_message_text("Admin menu:", reply_markup=_main_menu_buttons_ptb())

    async def on_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        uid = update.effective_user.id
        chat_id = update.effective_chat.id if update.effective_chat else uid
        text = (update.message.text or "").strip()
        ud = context.user_data

        if text == "/cancel":
            _clear_create_state(context)
            ud.pop("add_sessions", None)
            ud.pop("groups_await_upload", None)
            ud.pop("fix_wait_token", None)
            ud.pop("adb_transfer_token", None)
            ud.pop("adb_cl_token", None)
            ud.pop("adb_cl_name", None)
            ud.pop("adb_cl_index", None)
            ud.pop("adb_cl_upload_token", None)
            ud.pop("adb_cl_upload_name", None)
            ud.pop("adb_cl_upload_index", None)
            _broadcast_clear(ud)
            await update.message.reply_text("Cancelled.")
            return

        if ud.get("adb_transfer_token"):
            token = ud.pop("adb_transfer_token", None)
            name = ud.pop("adb_transfer_name", "")
            if not token:
                await update.message.reply_text("Session expired.")
                return
            try:
                new_uid = int(text.strip())
            except ValueError:
                await update.message.reply_text("Send a numeric Telegram user ID.")
                ud["adb_transfer_token"] = token
                ud["adb_transfer_name"] = name
                return
            from .admin_control import user_transfer_ownership
            from .audit import log_admin_action
            ok, msg = user_transfer_ownership(token, new_uid)
            log_admin_action(uid, "transfer_ownership", target=name, new_owner_id=new_uid)
            await update.message.reply_text(msg)
            return

        # Admin chatlist link input for a specific bot
        if ud.get("adb_cl_token") and text:
            token = ud.get("adb_cl_token")
            name = ud.get("adb_cl_name", "")
            idx = ud.get("adb_cl_index", 0)
            import re as _re
            links = [ln.strip() for ln in text.strip().splitlines() if "t.me/addlist/" in ln or "addlist/" in ln]
            if not links:
                await update.message.reply_text("No valid chatlist links found. Send links containing t.me/addlist/…")
                return
            ud.pop("adb_cl_token", None)
            ud.pop("adb_cl_name", None)
            ud.pop("adb_cl_index", None)
            from .utils import get_name_by_token, load_user_data, save_user_data
            from .chatlist import process_chatlist_setup
            bot_name = get_name_by_token(token)
            if not bot_name:
                await update.message.reply_text("Bot not found.")
                return
            cfg = load_user_data(bot_name)
            progress_msg = await update.message.reply_text(f"Processing chatlist for {name}…\nLinks: {len(links)}")
            async def admin_progress(m: str):
                try:
                    await progress_msg.edit_text(m)
                except Exception:
                    pass
            try:
                ok, result_msg, count = await process_chatlist_setup(token, bot_name, links, cfg, progress_cb=admin_progress)
                cfg = load_user_data(bot_name)
                if ok:
                    save_user_data(bot_name, cfg)
                    await progress_msg.edit_text(
                        f"✓ Chatlist set for {name}\n{result_msg}\nGroups loaded: {count}",
                        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back to Groups", callback_data="adb_groups:" + str(idx))]]),
                    )
                else:
                    await progress_msg.edit_text(
                        f"✗ Failed: {result_msg}",
                        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back to Groups", callback_data="adb_groups:" + str(idx))]]),
                    )
            except Exception as e:
                logger.exception("Admin chatlist setup error: %s", e)
                await progress_msg.edit_text(
                    f"Error: {str(e)[:200]}",
                    reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back to Groups", callback_data="adb_groups:" + str(idx))]]),
                )
            return

        # Admin group file upload for a specific bot
        if ud.get("adb_cl_upload_token") and update.message and update.message.document:
            token = ud.get("adb_cl_upload_token")
            name = ud.get("adb_cl_upload_name", "")
            idx = ud.get("adb_cl_upload_index", 0)
            doc = update.message.document
            fname = (doc.file_name or "").strip()
            if not fname.lower().endswith(".txt"):
                await update.message.reply_text("Please send a .txt file only.")
                return
            ud.pop("adb_cl_upload_token", None)
            ud.pop("adb_cl_upload_name", None)
            ud.pop("adb_cl_upload_index", None)
            from .utils import get_name_by_token, load_user_data, save_user_data
            from .chatlist import custom_group_filename, clear_chatlist_config, STARTER_MAX_GROUPS
            bot_name = get_name_by_token(token)
            if not bot_name:
                await update.message.reply_text("Bot not found.")
                return
            try:
                file = await context.bot.get_file(doc.file_id)
                if hasattr(file, "download_as_bytearray"):
                    buf = await file.download_as_bytearray()
                else:
                    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
                        await file.download_to_drive(tmp.name)
                        buf = Path(tmp.name).read_bytes()
                        Path(tmp.name).unlink(missing_ok=True)
                content = bytes(buf).decode("utf-8", errors="replace")
            except Exception as e:
                await update.message.reply_text(f"Download failed: {e}")
                return
            ok, err, count = _validate_group_file_content(content)
            if not ok:
                await update.message.reply_text(f"Invalid format: {err}\n\nFix and send again.")
                return
            custom_fn = custom_group_filename(bot_name)
            dest = config.GROUPS_DIR / custom_fn
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                dest.write_text(content, encoding="utf-8")
            except Exception as e:
                await update.message.reply_text(f"Save failed: {e}")
                return
            cfg = load_user_data(bot_name)
            clear_chatlist_config(cfg)
            cfg["group_file"] = custom_fn
            save_user_data(bot_name, cfg)
            await update.message.reply_text(
                f"✓ Group file uploaded for {name}\n"
                f"Groups: {count}\nFile: {custom_fn}",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("« Back to Groups", callback_data="adb_groups:" + str(idx))]]),
            )
            return

        if ud.get("broadcast_target") is not None and ud.get("broadcast_payload") is None:
            broadcast_ts = ud.get("broadcast_ts") or 0
            if time.time() - broadcast_ts > BROADCAST_SESSION_TIMEOUT_SEC:
                _broadcast_clear(ud)
                await update.message.reply_text(f"Broadcast session expired ({BROADCAST_SESSION_TIMEOUT_SEC // 60} min). Start again from Control Center → Broadcast.")
                return
            msg = update.message
            has_media = bool(msg.photo or msg.video or msg.document)
            has_text = bool((msg.text or msg.caption or "").strip())
            if not has_media and not has_text:
                await update.message.reply_text("Send a message with text, photo, video, or document to broadcast.")
                return
            ud["broadcast_payload"] = _broadcast_payload_from_message(msg)
            target = ud.get("broadcast_target", "?")
            from .admin_control import broadcast_recipients_all_users, broadcast_recipients_plan_users
            n = len(broadcast_recipients_all_users()) if target == "all_users" else len(broadcast_recipients_plan_users())
            await update.message.reply_text(
                f"Broadcast Preview — {n} recipient(s)\n\nRecipients will see the message above. Confirm to send?",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Send", callback_data="bc_send"), InlineKeyboardButton("Cancel", callback_data="bc_cancel")],
                ]),
            )
            return

        if ud.get("fix_wait_token"):
            bot_token = ud.get("fix_bot_token")
            if not bot_token:
                ud.pop("fix_wait_token", None)
                await update.message.reply_text("Session expired.")
                return
            new_token = text.strip()
            ud.pop("fix_wait_token", None)
            await update.message.reply_text("Updating bot token…")
            try:
                msg = await repair_fix_bot_token(bot_token, new_token)
                await update.message.reply_text(msg)
            except Exception as e:
                logger.exception("repair_fix_bot_token: %s", e)
                await update.message.reply_text(f"Error: {e}")
            return

        # Create wizard text steps
        step = ud.get("create_step")
        if step and step not in ("ask_proceed", "mode", "group_file", "summary"):
            data = load_adbot()
            t, dead, assigned, free = _session_counts(data)
            d = ud.setdefault("create_data", {})

            if step == "name":
                if not text:
                    await update.message.reply_text("Enter a non-empty internal name.")
                    return
                if free == 0:
                    await update.message.reply_text("No free sessions. Add sessions in Manage Sessions first.")
                    return
                d["name"] = text
                ud["create_step"] = "sessions_count"
                await update.message.reply_text(f"Enter number of sessions to assign.\nAvailable sessions: {free}")
                return
            if step == "sessions_count":
                try:
                    n = int(text)
                    if n < 1:
                        await update.message.reply_text("Enter a positive number.")
                        return
                except ValueError:
                    await update.message.reply_text("Enter a number.")
                    return
                d["sessions_count"] = n
                ud["create_step"] = "cycle"
                await update.message.reply_text("Cycle time (seconds, positive integer):")
                return
            if step == "cycle":
                try:
                    n = int(text)
                    if n < 1:
                        await update.message.reply_text("Enter a positive number.")
                        return
                except ValueError:
                    await update.message.reply_text("Enter a number.")
                    return
                d["cycle"] = n
                ud["create_step"] = "gap"
                await update.message.reply_text("Gap (seconds, positive integer):")
                return
            if step == "gap":
                try:
                    n = int(text)
                    if n < 1:
                        await update.message.reply_text("Enter a positive number.")
                        return
                except ValueError:
                    await update.message.reply_text("Enter a number.")
                    return
                d["gap"] = n
                ud["create_step"] = "bot_token"
                await update.message.reply_text("Send bot token:")
                return
            if step == "bot_token":
                ok, out = await validate_bot_token(text)
                if not ok:
                    await update.message.reply_text(f"Invalid token: {out}")
                    return
                if text.strip() in data.get("bots", {}):
                    await update.message.reply_text("This bot token is already registered.")
                    return
                d["bot_token"] = text.strip()
                d["bot_username"] = out
                ud["create_step"] = "valid_till"
                await update.message.reply_text("Valid till (dd/mm/yyyy):")
                return
            if step == "valid_till":
                try:
                    from datetime import datetime as dt
                    dt.strptime(text, "%d/%m/%Y")
                    d["valid_till"] = text
                except ValueError:
                    await update.message.reply_text("Use format dd/mm/yyyy (e.g. 02/06/2026).")
                    return
                ud["create_step"] = "renewal_price"
                await update.message.reply_text("Renewal price (USD, number, e.g. 70):")
                return
            if step == "renewal_price":
                try:
                    p = float(text.replace(",", ".").strip())
                    if p < 0:
                        await update.message.reply_text("Enter a non-negative number.")
                        return
                    d["renewal_price"] = str(p)
                except ValueError:
                    await update.message.reply_text("Enter a number (e.g. 70).")
                    return
                ud["create_step"] = "mode"
                await update.message.reply_text(
                    "Mode:",
                    reply_markup=InlineKeyboardMarkup([
                        [InlineKeyboardButton("Starter", callback_data="mode:starter"), InlineKeyboardButton("Enterprise", callback_data="mode:enterprise")],
                        [InlineKeyboardButton("Cancel", callback_data="create_cancel")],
                    ]),
                )
                return

        # Groups: upload .txt file (one group ID per line, -100...)
        if ud.get("groups_await_upload") and update.message.document:
            doc = update.message.document
            fname = (doc.file_name or "").strip()
            if not fname.lower().endswith(".txt"):
                await update.message.reply_text("Please send a .txt file only.")
                return
            ud.pop("groups_await_upload", None)
            import re
            safe_name = re.sub(r"[^\w\-.]", "_", fname).strip().lower()
            if not safe_name.endswith(".txt"):
                safe_name = safe_name + ".txt" if safe_name else "groups.txt"
            if not safe_name:
                safe_name = "groups.txt"
            try:
                file = await context.bot.get_file(doc.file_id)
                if hasattr(file, "download_as_bytearray"):
                    buf = await file.download_as_bytearray()
                else:
                    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
                        await file.download_to_drive(tmp.name)
                        buf = Path(tmp.name).read_bytes()
                        Path(tmp.name).unlink(missing_ok=True)
                content = bytes(buf).decode("utf-8", errors="replace")
            except Exception as e:
                logger.warning("Groups upload download failed: %s", e)
                await update.message.reply_text(f"Download failed: {e}")
                return
            ok, err, count = _validate_group_file_content(content)
            if not ok:
                await update.message.reply_text(f"Invalid format. {err}\n\nFile not saved. Fix and send again.")
                return
            dest = config.GROUPS_DIR / safe_name
            config.GROUPS_DIR.mkdir(parents=True, exist_ok=True)
            try:
                dest.write_text(content, encoding="utf-8")
            except Exception as e:
                logger.warning("Groups upload save failed: %s", e)
                await update.message.reply_text(f"Save failed: {e}")
                return
            await update.message.reply_text(
                f"Saved {safe_name} with {count} group ID(s).",
                reply_markup=_main_menu_buttons_ptb(),
            )
            return

        # Add Sessions: document upload
        if ud.get("add_sessions") and update.message.document:
            doc = update.message.document
            fname = (doc.file_name or "").strip().lower()
            data = load_adbot()
            added_f, added_d = 0, 0
            try:
                if fname.endswith(".session"):
                    dest = _unique_session_path(doc.file_name or "upload.session")
                    file = await context.bot.get_file(doc.file_id)
                    await file.download_to_drive(str(dest))
                    a, b = await _process_upload_standalone(dest, data)
                    added_f += a
                    added_d += b
                elif fname.endswith(".zip"):
                    with tempfile.TemporaryDirectory() as tmp:
                        tmp_path = Path(tmp)
                        zip_path = tmp_path / "upload.zip"
                        file = await context.bot.get_file(doc.file_id)
                        await file.download_to_drive(zip_path)
                        dests = _extract_zip_and_copy_sessions(zip_path, tmp_path, config.SESSIONS_ACTIVE)
                        for dest in dests:
                            a, b = await _process_upload_standalone(dest, data)
                            added_f += a
                            added_d += b
                elif fname.endswith(".txt"):
                    file = await context.bot.get_file(doc.file_id)
                    buf = await file.download_as_bytearray()
                    lines = buf.decode("utf-8", errors="replace").strip().splitlines()
                    for line in lines:
                        fn = line.strip()
                        if not fn or not fn.lower().endswith(".session"):
                            continue
                        p = config.SESSIONS_ACTIVE / fn
                        if p.is_file():
                            a, b = await _process_upload_standalone(p, data)
                            added_f += a
                            added_d += b
                else:
                    await update.message.reply_text("Send a .session, .txt, or .zip file.")
                    return
            except Exception as e:
                logger.exception("Add sessions failed: %s", e)
                await update.message.reply_text(f"Error: {e}")
                return
            save_adbot(data)
            await update.message.reply_text(f"Added to free: {added_f}, to dead: {added_d}. Send more or tap Cancel in the menu.")
            return

    def _error_context(update: object, context: ContextTypes.DEFAULT_TYPE) -> str:
        """Build a short context string for error logs: where the error came from (user, callback, etc.)."""
        parts = ["bot=admin_ptb"]
        if update is not None:
            u = getattr(update, "effective_user", None)
            if u is not None and getattr(u, "id", None) is not None:
                parts.append(f"user_id={u.id}")
            cq = getattr(update, "callback_query", None)
            if cq is not None and getattr(cq, "data", None):
                data = (cq.data or "")[:40]
                parts.append(f"callback={data!r}")
            if getattr(update, "message", None) and getattr(update.message, "text", None):
                text = (update.message.text or "")[:30].replace("\n", " ")
                parts.append(f"message={text!r}")
        return " ".join(parts)

    async def _error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        err = context.error
        if err is None:
            return
        if isinstance(err, Forbidden):
            # User blocked the bot or chat is inaccessible; expected in production.
            logger.debug("Admin bot: Forbidden when sending (user may have blocked bot): %s", err)
            return
        if isinstance(err, BadRequest) and "message to edit not found" in str(err).lower():
            logger.debug("Admin bot: message to edit not found (likely deleted): %s", err)
            return
        ctx_str = _error_context(update, context)
        logger.exception("Admin bot unhandled error [%s]: %s", ctx_str, err)

    global _admin_application, _admin_app_running
    _b = Application.builder().token(config.ADMIN_BOT_TOKEN)
    _ptb_req = config.build_ptb_httpx_request()
    if _ptb_req is not None:
        _b = _b.request(_ptb_req)
        logger.info("Admin bot PTB using SOCKS proxy for Bot API (socks5h / remote DNS)")
    app = _b.build()
    _admin_application = app
    app.add_error_handler(_error_handler)
    async def cmd_order_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /order_id <order_id>")
            return
        from .admin_control import _orders_search
        orders = _orders_search(order_id=args[0].strip())
        await _reply_orders_list(update, context, orders)

    async def cmd_order_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /order_payment <payment_id>")
            return
        from .admin_control import _orders_search
        orders = _orders_search(payment_id=args[0].strip())
        await _reply_orders_list(update, context, orders)

    async def cmd_order_user(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /order_user <telegram_user_id>")
            return
        try:
            uid = int(args[0].strip())
        except ValueError:
            await update.message.reply_text("user_id must be numeric.")
            return
        from .admin_control import _orders_search
        orders = _orders_search(user_id=uid)
        await _reply_orders_list(update, context, orders)

    async def _reply_orders_list(update, context, orders):
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        if not orders:
            await update.message.reply_text("No orders found.")
            return
        o = orders[0]
        order_id = o.get("order_id", "")
        lines = [f"Order: {order_id}", f"Status: {o.get('status')}", f"User: {o.get('user_id')}", f"Payment ID: {o.get('payment_id')}", f"Amount: {o.get('amount_usd')} {o.get('currency')}", f"Created: {o.get('created_at')}", f"Paid at: {o.get('paid_at') or '—'}", f"Bot: {o.get('created_bot_username') or '—'}"]
        rows = []
        if o.get("status") in ("payment_waiting", "confirming"):
            rows.append([InlineKeyboardButton("Mark paid", callback_data="order_act:" + order_id + ":mark_paid")])
        if o.get("status") in ("payment_waiting", "confirming", "paid", "pending_creation"):
            rows.append([InlineKeyboardButton("Cancel order", callback_data="order_act:" + order_id + ":cancel")])
        if o.get("status") == "pending_creation":
            rows.append([InlineKeyboardButton("Re-run creation", callback_data="order_act:" + order_id + ":rerun")])
        rows.append([InlineKeyboardButton("« Orders", callback_data="cc_orders")])
        await update.message.reply_text("\n".join(lines), reply_markup=InlineKeyboardMarkup(rows))

    async def cmd_user_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /user_id <telegram_id>")
            return
        try:
            uid = int(args[0].strip())
        except ValueError:
            await update.message.reply_text("user_id must be numeric.")
            return
        from .admin_control import user_search_by_telegram_id, user_extend_plan, user_freeze
        bots = user_search_by_telegram_id(uid)
        if not bots:
            await update.message.reply_text(f"No bots for user {uid}.")
            return
        lines = [f"User {uid} — {len(bots)} bot(s):"]
        for b in bots:
            lines.append(f"  @{b.get('bot_username')} — {b.get('name')} — valid: {b.get('valid_till')} — suspended: {b.get('suspended')} — frozen: {b.get('frozen')}")
        await update.message.reply_text("\n".join(lines))

    async def cmd_user_bot(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /user_bot @username")
            return
        from .admin_control import user_search_by_bot_username
        bot_cfg = user_search_by_bot_username(args[0].strip())
        if not bot_cfg:
            await update.message.reply_text("Bot not found.")
            return
        lines = [f"Bot: @{bot_cfg.get('bot_username')}", f"Name: {bot_cfg.get('name')}", f"Valid till: {bot_cfg.get('valid_till')}", f"Authorized: {bot_cfg.get('authorized')}"]
        await update.message.reply_text("\n".join(lines))

    async def cmd_user_plan(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if not args:
            await update.message.reply_text("Use: /user_plan <plan_name>")
            return
        from .admin_control import user_search_by_plan_type
        bots = user_search_by_plan_type(" ".join(args))
        if not bots:
            await update.message.reply_text("No bots with that plan.")
            return
        lines = [f"Plan \"{' '.join(args)}\" — {len(bots)} bot(s):"]
        for b in bots[:15]:
            lines.append(f"  @{b.get('bot_username')} — {b.get('name')}")
        if len(bots) > 15:
            lines.append("  …")
        await update.message.reply_text("\n".join(lines))

    async def cmd_user_extend(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if len(args) < 2:
            await update.message.reply_text("Use: /user_extend @bot_username <days>")
            return
        from .admin_control import user_search_by_bot_username, user_extend_plan
        bot_cfg = user_search_by_bot_username(args[0])
        if not bot_cfg:
            await update.message.reply_text("Bot not found.")
            return
        try:
            days = int(args[1].strip())
        except ValueError:
            await update.message.reply_text("Days must be a number.")
            return
        token = bot_cfg.get("bot_token")
        from .audit import log_admin_action
        ok, msg = user_extend_plan(token, days)
        log_admin_action(update.effective_user.id if update.effective_user else 0, "extend_plan", target=args[0], add_days=days)
        await update.message.reply_text(msg)

    async def cmd_user_freeze(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        args = (context.args or [])
        if len(args) < 2:
            await update.message.reply_text("Use: /user_freeze @bot_username on|off")
            return
        from .admin_control import user_search_by_bot_username, user_freeze
        bot_cfg = user_search_by_bot_username(args[0])
        if not bot_cfg:
            await update.message.reply_text("Bot not found.")
            return
        on_off = (args[1] or "").strip().lower()
        freeze = on_off in ("1", "on", "yes", "true")
        token = bot_cfg.get("bot_token")
        from .audit import log_admin_action
        ok, msg = user_freeze(token, freeze)
        log_admin_action(update.effective_user.id if update.effective_user else 0, "user_freeze", target=args[0], freeze=freeze)
        await update.message.reply_text(msg)

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("cmd", cmd_cmd))
    app.add_handler(CommandHandler("health", cmd_health))
    app.add_handler(CommandHandler("cpu", cmd_cpu))
    app.add_handler(CommandHandler("logs", cmd_logs))
    app.add_handler(CommandHandler("fix", cmd_fix))
    app.add_handler(CommandHandler("order_id", cmd_order_id))
    app.add_handler(CommandHandler("order_payment", cmd_order_payment))
    app.add_handler(CommandHandler("order_user", cmd_order_user))
    app.add_handler(CommandHandler("user_id", cmd_user_id))
    app.add_handler(CommandHandler("user_bot", cmd_user_bot))
    app.add_handler(CommandHandler("user_plan", cmd_user_plan))
    async def cmd_dashboard(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.effective_user or not _is_authorized(update.effective_user.id):
            return
        from .admin_control import dashboard_counts
        c = dashboard_counts()
        lines = [
            "Dashboard",
            f"Bots: {c['total_bots']} total, {c['running_bots']} running, {c['stopped_bots']} stopped",
            f"Sessions: {c['free_sessions']} free, {c['assigned_sessions']} assigned, {c['dead_sessions']} dead, {c['frozen_sessions']} frozen",
            "Orders: " + ", ".join(f"{k}={v}" for k, v in sorted(c["orders_by_status"].items())),
            f"Create worker: {'OK' if c.get('create_worker_ok') else 'Stale'}",
            f"Payment worker: {'OK' if c.get('payment_worker_ok') else 'Stale'}",
        ]
        await update.message.reply_text(
            "\n".join(lines),
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("Refresh", callback_data="cc_dashboard_refresh")],
                [InlineKeyboardButton("Control Center", callback_data="control_center")],
            ]),
        )

    app.add_handler(CommandHandler("user_extend", cmd_user_extend))
    app.add_handler(CommandHandler("user_freeze", cmd_user_freeze))
    app.add_handler(CommandHandler("dashboard", cmd_dashboard))
    app.add_handler(CommandHandler("dashboard_refresh", cmd_dashboard))
    async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.effective_user and _is_authorized(update.effective_user.id):
            _clear_create_state(context)
            context.user_data.pop("add_sessions", None)
            await update.message.reply_text("Cancelled.")
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    app.add_handler(MessageHandler(filters.Document.ALL, on_message))
    app.add_handler(MessageHandler(filters.PHOTO | filters.VIDEO, on_message))

    _start_create_worker_if_needed()

    def run_polling():
        global _admin_app_running
        # PTB's run_polling() uses asyncio.get_event_loop(); the worker thread has none by default.
        # On Unix, add_signal_handler() only works in the main thread — disable signal handling
        # when running in a background thread (e.g. Pterodactyl/Docker) to avoid RuntimeError.
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        from . import bot_ptb
        bot_ptb.set_admin_ptb_loop(loop)
        _admin_app_running = True
        logger.info("[AppLifecycle] application_started=True executor_alive=True")
        try:
            app.run_polling(
                allowed_updates=Update.ALL_TYPES,
                stop_signals=(),  # do not register SIGINT/SIGTERM in this thread
            )
        finally:
            _admin_app_running = False
            loop.close()

    thread = threading.Thread(target=run_polling, daemon=True)
    thread.start()
    logger.info("Admin bot (PTB) polling started in background thread")

    # Block until shutdown (main loop cancels this task). Exit cleanly on cancel so task is not "destroyed while pending".
    shutdown = asyncio.Event()
    try:
        await shutdown.wait()
    except asyncio.CancelledError:
        shutdown.set()
        raise
