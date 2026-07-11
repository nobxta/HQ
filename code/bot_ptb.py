"""
Bot token clients using python-telegram-bot (PTB).
Used for: admin bot, log group sending (per-AdBot token), admin DM alerts.
Telethon remains only for user sessions (posting) and DM detection inside session workers.
"""
import asyncio
import logging
from typing import Any

from . import config

logger = logging.getLogger(__name__)

# Cache: bot_token -> Bot instance (for log group sending)
_ptb_bots: dict[str, Any] = {}

# Admin PTB runs in a background thread with its own event loop. When main loop calls
# send_admin_dm_alert, the Bot's httpx client can raise "Event bound to a different event loop".
# We schedule the send on the admin loop when called from another loop.
_admin_ptb_loop: asyncio.AbstractEventLoop | None = None


def set_admin_ptb_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    """Set by admin_ptb when its polling thread starts. Used to run admin DM sends on that loop."""
    global _admin_ptb_loop
    _admin_ptb_loop = loop


def _get_ptb_bot(bot_token: str) -> Any:
    """Return cached telegram.Bot for token. Creates if missing."""
    if bot_token not in _ptb_bots:
        try:
            from telegram import Bot
            _req = config.build_ptb_httpx_request()
            _ptb_bots[bot_token] = (
                Bot(token=bot_token, request=_req) if _req is not None else Bot(token=bot_token)
            )
        except Exception as e:
            logger.warning("PTB Bot create failed for token %s: %s", bot_token[:20], e)
            raise
    return _ptb_bots[bot_token]


def _get_admin_bot() -> Any:
    """Return Bot for ADMIN_BOT_TOKEN. Used for sending admin DM alerts."""
    token = getattr(config, "ADMIN_BOT_TOKEN", None) or ""
    if not token.strip():
        return None
    return _get_ptb_bot(token.strip())


def remove_ptb_bot(bot_token: str) -> None:
    """Remove cached bot (e.g. when AdBot is stopped)."""
    _ptb_bots.pop(bot_token, None)


def _normalize_log_chat_id_for_api(chat_id: int | str) -> int | str | None:
    """Convert log_group value to a chat_id the Bot API accepts. API accepts int or @username, not full URLs."""
    if chat_id is None:
        return None
    if isinstance(chat_id, int):
        return chat_id
    s = str(chat_id).strip()
    if not s:
        return None
    # Bot API does not accept https://t.me/... URLs; convert public group link to @username
    if s.startswith("http://") or s.startswith("https://"):
        if "joinchat/" in s or "invite/" in s:
            logger.warning("Log group is an invite link (joinchat/invite); Bot API cannot send to it. Use a public @username or numeric id.")
            return None
        # e.g. https://t.me/adbot_xyz -> @adbot_xyz
        part = s.rstrip("/").split("/")[-1]
        if part and not part.startswith("+"):
            return f"@{part}"
        return None
    # Already @username or numeric string
    if s.startswith("@"):
        return s
    if s.lstrip("-").isdigit():
        return int(s)
    return f"@{s}" if "/" not in s else None


async def send_log_message(
    bot_token: str,
    chat_id: int | str,
    text: str,
    parse_mode: str | None = None,
    reply_markup: Any = None,
    **kwargs: Any,
) -> bool:
    """Send a message to log group (or any chat) using PTB. Pass entities, disable_web_page_preview, etc. via **kwargs.
    chat_id can be numeric, @username, or https://t.me/username (converted to @username for API)."""
    try:
        resolved = _normalize_log_chat_id_for_api(chat_id)
        if resolved is None:
            logger.warning("PTB send_log_message: could not resolve chat_id for log group (value: %s)", repr(chat_id)[:80])
            return False
        bot = _get_ptb_bot(bot_token)
        payload: dict[str, Any] = {"chat_id": resolved, "text": text}
        try:
            from telegram import LinkPreviewOptions
            payload["link_preview_options"] = LinkPreviewOptions(is_disabled=True)
        except ImportError:
            payload["disable_web_page_preview"] = True
        if parse_mode is not None:
            payload["parse_mode"] = parse_mode
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        for k, v in kwargs.items():
            if v is not None:
                payload[k] = v
        await bot.send_message(**payload)
        return True
    except Exception as e:
        logger.warning("PTB send_log_message failed: %s", e)
        return False


async def _do_send_admin_dm_alert(
    text: str,
    parse_mode: str | None = "Markdown",
    reply_markup: Any = None,
    **kwargs: Any,
) -> bool:
    """Actual send on current loop. Used by send_admin_dm_alert."""
    admin_user_id = getattr(config, "ADMIN_USER_ID", None)
    if not admin_user_id:
        return False
    bot = _get_admin_bot()
    if bot is None:
        return False
    payload: dict[str, Any] = {"chat_id": admin_user_id, "text": text}
    if parse_mode is not None:
        payload["parse_mode"] = parse_mode
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    for k, v in kwargs.items():
        if v is not None:
            payload[k] = v
    await bot.send_message(**payload)
    return True


async def send_admin_dm_alert(
    text: str,
    parse_mode: str | None = "Markdown",
    reply_markup: Any = None,
    **kwargs: Any,
) -> bool:
    """Send an alert to ADMIN_USER_ID via admin bot (PTB). When called from a different event loop
    (e.g. main loop), schedules the send on the admin PTB loop to avoid 'Event bound to a different event loop'."""
    try:
        current = asyncio.get_running_loop()
    except RuntimeError:
        current = None
    target_loop = _admin_ptb_loop
    if target_loop is not None and current is not target_loop:
        async def _safe_send() -> bool:
            try:
                return await _do_send_admin_dm_alert(
                    text, parse_mode=parse_mode, reply_markup=reply_markup, **kwargs
                )
            except Exception as e:
                logger.warning("PTB send_admin_dm_alert (admin loop) failed: %s", e)
                return False

        asyncio.run_coroutine_threadsafe(_safe_send(), target_loop)
        return True  # scheduled on admin loop; don't block this loop
    try:
        return await _do_send_admin_dm_alert(
            text, parse_mode=parse_mode, reply_markup=reply_markup, **kwargs
        )
    except Exception as e:
        logger.warning("PTB send_admin_dm_alert failed: %s", e)
        return False


async def send_admin_dm_received(
    session_file: str,
    from_name: str,
    user_id: int,
    message_text: str,
    account_username: str = "",
    sender_username: str = "",
    media_type: str = "",
    caption: str = "",
) -> bool:
    """Send 'New DM received' alert to ADMIN_USER_ID with an 'Open Sender Profile' button (PTB).
    Uses the same rich format as the owner notification (Account / From @username / Message)."""
    account = account_username or session_file.replace(".session", "")
    text = _format_owner_dm(account, from_name, sender_username, message_text, media_type, caption)
    text += f"\nUser ID: {user_id}"
    try:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Open Sender Profile", url=f"tg://user?id={user_id}")],
        ])
        return await send_admin_dm_alert(text, parse_mode=None, reply_markup=keyboard)
    except Exception as e:
        logger.warning("send_admin_dm_received failed: %s", e)
        return await send_admin_dm_alert(text, parse_mode=None)


def _format_owner_dm(
    account_username: str, from_name: str, from_username: str,
    text: str, media_type: str, caption: str,
) -> str:
    """Owner-facing 'New DM Received' text (no parse_mode — plain text)."""
    account = f"@{account_username}" if account_username else "an ad account"
    who = from_name or "Unknown User"
    if from_username:
        who += f" @{from_username}"
    lines = ["New DM Received", "", f"Account: {account}", f"From: {who}"]
    if media_type:
        lines.append(f"Media: {media_type}")
        if caption:
            lines.append(f"Caption: {caption}")
    else:
        lines.append(f'Message: {text}' if text else "Message: (empty)")
    return "\n".join(lines)


async def send_owner_dm_received(
    bot_token: str,
    owner_id: int,
    account_username: str,
    from_name: str,
    from_username: str,
    sender_id: int,
    text: str = "",
    media_type: str = "",
    caption: str = "",
) -> bool:
    """DM the AdBot owner about an incoming DM to one of their posting accounts, via the
    AdBot's own control bot, with an 'Open Sender Profile' button. Best-effort."""
    if not (bot_token and owner_id):
        return False
    body = _format_owner_dm(account_username, from_name, from_username, text, media_type, caption)
    try:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Open Sender Profile", url=f"tg://user?id={sender_id}")],
        ])
        return await send_message_with_bot(owner_id, body, bot_token=bot_token, reply_markup=keyboard)
    except Exception as e:
        logger.warning("send_owner_dm_received failed: %s", e)
        try:
            return await send_message_with_bot(owner_id, body, bot_token=bot_token)
        except Exception:
            return False


async def send_owner_dm_followup(
    bot_token: str, owner_id: int, account_username: str,
    from_name: str, from_username: str, sender_id: int, extra_count: int,
) -> bool:
    """Coalesced follow-up after the instant notification: 'N more messages from X'."""
    if not (bot_token and owner_id) or extra_count <= 0:
        return False
    who = from_name or "Unknown User"
    if from_username:
        who += f" @{from_username}"
    account = f"@{account_username}" if account_username else "an ad account"
    body = f"+{extra_count} more message{'s' if extra_count != 1 else ''} from {who} to {account}"
    try:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Open Sender Profile", url=f"tg://user?id={sender_id}")],
        ])
        return await send_message_with_bot(owner_id, body, bot_token=bot_token, reply_markup=keyboard)
    except Exception as e:
        logger.warning("send_owner_dm_followup failed: %s", e)
        return False


async def edit_admin_message(chat_id: int, message_id: int, text: str, parse_mode: str | None = None) -> bool:
    """Edit a message sent by the admin bot (e.g. Create AdBot progress/result). Uses PTB."""
    return await edit_message_with_bot(chat_id, message_id, text, parse_mode=parse_mode, bot_token=None)


async def edit_message_with_bot(
    chat_id: int, message_id: int, text: str, **kwargs: Any
) -> bool:
    """
    Edit a message. Pass any Telegram edit_message_text parameters in kwargs.
    bot_token in kwargs selects the bot (None = admin bot; else use that token, e.g. Shop Bot).
    """
    api_kwargs = dict(kwargs)
    bot_token = api_kwargs.pop("bot_token", None)
    if bot_token and str(bot_token).strip():
        bot = _get_ptb_bot(str(bot_token).strip())
    else:
        bot = _get_admin_bot()
    if bot is None:
        return False
    try:
        payload: dict[str, Any] = {"chat_id": chat_id, "message_id": message_id, "text": text}
        for k, v in api_kwargs.items():
            if v is not None:
                payload[k] = v
        await bot.edit_message_text(**payload)
        return True
    except Exception as e:
        logger.debug("PTB edit_message_with_bot failed: %s", e)
        return False


async def send_message_with_bot(chat_id: int, text: str, **kwargs: Any) -> bool:
    """Send a message. Pass any Telegram send_message params in kwargs (e.g. parse_mode, entities, disable_web_page_preview). Use bot_token=... to select bot."""
    ok, _ = await send_message_with_bot_return_id(chat_id, text, **kwargs)
    return ok


async def send_message_with_bot_return_id(chat_id: int, text: str, **kwargs: Any) -> tuple[bool, int | None]:
    """Send a message; returns (success, message_id or None). Forwards all kwargs to bot.send_message except bot_token (used to select bot)."""
    api_kwargs = dict(kwargs)
    bot_token = api_kwargs.pop("bot_token", None)
    if bot_token and str(bot_token).strip():
        bot = _get_ptb_bot(str(bot_token).strip())
    else:
        bot = _get_admin_bot()
    if bot is None:
        return False, None
    try:
        payload: dict[str, Any] = {"chat_id": chat_id, "text": text}
        for k, v in api_kwargs.items():
            if v is not None:
                payload[k] = v
        msg = await bot.send_message(**payload)
        return True, msg.message_id if msg else None
    except Exception as e:
        logger.debug("PTB send_message_with_bot_return_id failed: %s", e)
        return False, None
