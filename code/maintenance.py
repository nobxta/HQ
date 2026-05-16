"""
Global maintenance mode and notification queue.
When maintenance is enabled, Shop Bot and Controller Bot return a single message and add users to the queue.
When disabled, admin triggers rate-limited notification to all queued users, then the queue is cleared.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

logger = logging.getLogger(__name__)

MAINTENANCE_MESSAGE = "System is currently under maintenance. Please try again later."
MAINTENANCE_COMPLETE_MESSAGE = "Maintenance is complete. You may now continue."


def _maintenance_path() -> Path:
    return getattr(config, "DATA_MAINTENANCE_FILE", config.DATA_DIR / "maintenance.json")


def _queue_path() -> Path:
    return getattr(config, "DATA_MAINTENANCE_QUEUE_FILE", config.DATA_DIR / "maintenance_notify_queue.json")


def load_maintenance() -> dict[str, Any]:
    """Load maintenance state. Returns {enabled: bool, updated_at: str}."""
    path = _maintenance_path()
    if not path.exists():
        return {"enabled": False, "updated_at": ""}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("enabled", False)
            data.setdefault("updated_at", "")
            return data
    except Exception as e:
        logger.warning("Could not load maintenance.json: %s", e)
    return {"enabled": False, "updated_at": ""}


def save_maintenance(enabled: bool) -> None:
    """Set maintenance mode on or off. Does not process queue; caller must call process_maintenance_queue when disabling."""
    path = _maintenance_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "enabled": bool(enabled),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def is_maintenance_enabled() -> bool:
    """True if maintenance mode is on."""
    return bool(load_maintenance().get("enabled"))


def _load_queue_raw() -> list[dict[str, Any]]:
    """Load queue as list of {user_id, chat_id}. Dedupe by user_id."""
    path = _queue_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "user_ids" in data:
            # New format: list of {user_id, chat_id}
            items = data.get("items", [])
            if not items and "user_ids" in data:
                for uid in data["user_ids"]:
                    items.append({"user_id": uid, "chat_id": uid})
            return items
        if isinstance(data, list):
            return [x if isinstance(x, dict) else {"user_id": x, "chat_id": x} for x in data]
    except Exception as e:
        logger.warning("Could not load maintenance queue: %s", e)
    return []


def load_maintenance_queue() -> list[dict[str, Any]]:
    """Return list of {user_id, chat_id} (deduplicated by user_id)."""
    seen: set[int] = set()
    out = []
    for item in _load_queue_raw():
        uid = item.get("user_id")
        if uid is None:
            continue
        try:
            uid = int(uid)
        except (TypeError, ValueError):
            continue
        if uid in seen:
            continue
        seen.add(uid)
        chat_id = item.get("chat_id", uid)
        try:
            chat_id = int(chat_id)
        except (TypeError, ValueError):
            chat_id = uid
        out.append({"user_id": uid, "chat_id": chat_id})
    return out


def add_to_maintenance_queue(user_id: int, chat_id: int | None = None) -> None:
    """Add user to the notify queue (deduplicated by user_id)."""
    if chat_id is None:
        chat_id = user_id
    queue = load_maintenance_queue()
    seen = {item["user_id"] for item in queue}
    if user_id in seen:
        return
    queue.append({"user_id": user_id, "chat_id": chat_id})
    path = _queue_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"items": queue, "updated_at": datetime.now(timezone.utc).isoformat()}, indent=2), encoding="utf-8")


def clear_maintenance_queue() -> None:
    """Clear the queue after notifications are sent."""
    path = _queue_path()
    if path.exists():
        path.write_text(json.dumps({"items": [], "updated_at": datetime.now(timezone.utc).isoformat()}, indent=2), encoding="utf-8")


async def process_maintenance_queue_and_clear(send_message_func, rate_per_min: int | None = None) -> tuple[int, int]:
    """
    Send MAINTENANCE_COMPLETE_MESSAGE to each queued user with rate limiting, then clear the queue.
    send_message_func(chat_id: int, text: str) -> bool (True if sent).
    Returns (sent_count, failed_count).
    """
    rate_per_min = rate_per_min or getattr(config, "BROADCAST_RATE_LIMIT_PER_MIN", 30)
    interval = 60.0 / max(1, rate_per_min)
    queue = load_maintenance_queue()
    sent, failed = 0, 0
    for item in queue:
        chat_id = item.get("chat_id", item.get("user_id"))
        try:
            ok = await send_message_func(int(chat_id), MAINTENANCE_COMPLETE_MESSAGE)
            if ok:
                sent += 1
            else:
                failed += 1
        except Exception as e:
            logger.warning("Maintenance notify to %s failed: %s", chat_id, e)
            failed += 1
        await asyncio.sleep(interval)
    clear_maintenance_queue()
    return sent, failed
