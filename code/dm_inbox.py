"""Per-AdBot inbox of DMs received by posting accounts, plus the shared web
notification writer. Flat-JSON stores under data/, same convention as plans/notifs.

Written by the controller process (on a worker's dm_alert) and read by the API
(user portal + admin). Both processes share the disk; each write is lock-guarded
read-modify-write (cross-process races are acceptable and match existing patterns)."""
import json
import threading
import time
from typing import Any, Optional

from . import config

_inbox_lock = threading.Lock()
_notif_lock = threading.Lock()
_MAX_INBOX = 200
_MAX_NOTIFS = 50


# ── DM inbox ──────────────────────────────────────────────────────────────────
def _inbox_dir():
    return config.DATA_DIR / "dm_inbox"


def _inbox_path(bot_name: str):
    return _inbox_dir() / f"{bot_name.lower()}.json"


def load_inbox(bot_name: str) -> list[dict]:
    p = _inbox_path(bot_name)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def add_dm(
    bot_name: str,
    *,
    session_file: str,
    account_username: str,
    sender_id: int,
    sender_name: str,
    sender_username: str,
    text: str,
    media_type: str,
    caption: str,
) -> dict:
    """Append a received DM; keep the newest _MAX_INBOX. Returns the stored entry."""
    entry = {
        "id": f"{int(time.time() * 1000)}_{sender_id}",
        "ts": time.time(),
        "session_file": session_file,
        "account_username": account_username,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_username": sender_username,
        "text": text,
        "media_type": media_type,
        "caption": caption,
        "read": False,
    }
    with _inbox_lock:
        items = load_inbox(bot_name)
        items.append(entry)
        if len(items) > _MAX_INBOX:
            items = items[-_MAX_INBOX:]
        p = _inbox_path(bot_name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(items, indent=2), "utf-8")
    return entry


def mark_inbox_read(bot_name: str) -> None:
    with _inbox_lock:
        items = load_inbox(bot_name)
        changed = False
        for it in items:
            if not it.get("read"):
                it["read"] = True
                changed = True
        if changed:
            _inbox_path(bot_name).write_text(json.dumps(items, indent=2), "utf-8")


def list_inbox_bots() -> list[str]:
    """Bot names (file stems) that have a DM inbox on disk."""
    d = _inbox_dir()
    if not d.exists():
        return []
    try:
        return [p.stem for p in d.glob("*.json")]
    except OSError:
        return []


# ── Web notification writer (shared with the portal bell) ─────────────────────
def _notif_path(bot_name: str):
    return config.DATA_DIR / "notifications" / f"{bot_name.lower()}.json"


def _load_notifs(bot_name: str) -> list[dict]:
    p = _notif_path(bot_name)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def add_portal_notification(
    bot_name: str,
    title: str,
    message: str,
    type: str = "info",
    icon: str = "",
) -> None:
    """Append a notification to the portal bell store (data/notifications/<bot>.json).
    Same format the API's NotificationBell polls. Callable from any process."""
    with _notif_lock:
        notifs = _load_notifs(bot_name)
        notifs.append({
            "id": f"{int(time.time() * 1000)}_{len(notifs)}",
            "title": title,
            "message": message,
            "type": type,
            "icon": icon,
            "ts": time.time(),
            "read": False,
        })
        p = _notif_path(bot_name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(notifs[-_MAX_NOTIFS:], indent=2), "utf-8")
