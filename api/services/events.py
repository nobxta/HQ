"""Event hooks: bridge existing system events to WebSocket pub/sub."""
import logging
from api.runtime.pubsub import publish_sync

logger = logging.getLogger(__name__)

CHANNEL_DASHBOARD = "dashboard"
CHANNEL_BOT_LOGS = "bot.{name}.logs"
CHANNEL_BOT_POSTING = "bot.{name}.posting"
CHANNEL_CREATE_PROGRESS = "create.{name}"
CHANNEL_CHATLIST_PROGRESS = "chatlist.{name}"
CHANNEL_BOT_CONTROL = "control.{name}"


def emit_dashboard_event(event_type: str, data: dict = None) -> None:
    publish_sync(CHANNEL_DASHBOARD, {"event": event_type, "data": data or {}})


def emit_bot_log(bot_name: str, message: str, level: str = "info") -> None:
    channel = CHANNEL_BOT_LOGS.format(name=bot_name)
    publish_sync(channel, {"event": "log_line", "message": message, "level": level})


def emit_posting_event(bot_name: str, event_type: str, data: dict = None) -> None:
    channel = CHANNEL_BOT_POSTING.format(name=bot_name)
    publish_sync(channel, {"event": event_type, "data": data or {}})


def emit_create_progress(bot_name: str, message: str, status: str = "progress") -> None:
    channel = CHANNEL_CREATE_PROGRESS.format(name=bot_name)
    publish_sync(channel, {"event": "create_progress", "message": message, "status": status})


def emit_bot_control(bot_name: str, message: str, status: str = "progress", action: str = "") -> None:
    channel = CHANNEL_BOT_CONTROL.format(name=bot_name)
    publish_sync(channel, {"event": "bot_control", "message": message, "status": status, "action": action})


def emit_chatlist_progress(bot_name: str, message: str, status: str = "progress") -> None:
    channel = CHANNEL_CHATLIST_PROGRESS.format(name=bot_name)
    publish_sync(channel, {"event": "chatlist_progress", "message": message, "status": status})


def emit_alert(alert_type: str, message: str) -> None:
    publish_sync(CHANNEL_DASHBOARD, {
        "event": "alert",
        "alert_type": alert_type,
        "message": message,
    })
