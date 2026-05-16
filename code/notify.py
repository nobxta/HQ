"""
Unified notification gateway. All control-plane notifications (admin DM, log group, DM received)
route through PTB. No Telethon dependency for admin/log sending.
"""
from typing import Any

from . import bot_ptb
from .utils import add_admin_alert


def notify_admin(alert_type: str, msg: str) -> None:
    """Queue an admin alert (stored in pool.json; alert_forward_loop sends via PTB)."""
    add_admin_alert(alert_type, msg)


async def notify_admin_send(
    text: str,
    parse_mode: str | None = "Markdown",
    reply_markup: Any = None,
) -> bool:
    """Send a message to ADMIN_USER_ID immediately via PTB (used by alert loop and daily report)."""
    return await bot_ptb.send_admin_dm_alert(text, parse_mode=parse_mode, reply_markup=reply_markup)


async def notify_log_group(
    bot_token: str,
    chat_id: int | str,
    text: str,
    parse_mode: str | None = None,
    reply_markup: Any = None,
) -> bool:
    """Send a message to a log group (or any chat) via PTB."""
    return await bot_ptb.send_log_message(
        bot_token, chat_id, text, parse_mode=parse_mode, reply_markup=reply_markup
    )


async def notify_dm_received(
    session_file: str,
    from_name: str,
    user_id: int,
    message_text: str,
) -> bool:
    """Send 'New DM received' alert to admin via PTB (with Open User Profile button)."""
    return await bot_ptb.send_admin_dm_received(session_file, from_name, user_id, message_text)


async def notify_edit_admin_message(
    chat_id: int, message_id: int, text: str, parse_mode: str | None = None
) -> bool:
    """Edit a message previously sent by the admin bot (e.g. Create AdBot progress/result)."""
    return await bot_ptb.edit_admin_message(chat_id, message_id, text, parse_mode=parse_mode)


async def notify_edit_message(chat_id: int, message_id: int, text: str, **kwargs: Any) -> bool:
    """
    Edit a message. Pass any Telegram edit_message_text parameters (e.g. parse_mode,
    disable_web_page_preview, reply_markup, entities). Use bot_token=... to choose bot
    (None = admin bot; SHOP_BOT_TOKEN = Shop Bot).
    """
    return await bot_ptb.edit_message_with_bot(chat_id, message_id, text, **kwargs)


async def notify_send_to_chat(chat_id: int, text: str, **kwargs: Any) -> bool:
    """Send a message to a chat. Pass any Telegram send_message params (parse_mode, entities, disable_web_page_preview, etc.). Use bot_token=... to select bot."""
    return await bot_ptb.send_message_with_bot(chat_id, text, **kwargs)
