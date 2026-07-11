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
_settings_lock = threading.Lock()
_MAX_INBOX = 200
_MAX_NOTIFS = 50

# The locked HQAdz disclosure appended to every auto-reply. Admin-editable (stored in
# data/admin_settings.json under "dm_autoreply_footer"); users can never change it.
DEFAULT_AUTOREPLY_FOOTER = "For HQAdz AdBot, visit @HQAdz or HQAdz.io\nDirect support: @fairs"
_footer_cache: tuple[float, str] | None = None
_FOOTER_TTL = 60.0


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
    account_name: str = "",
    account_user_id: int = 0,
    sender_id: int,
    sender_name: str,
    sender_username: str,
    text: str,
    media_type: str,
    caption: str,
    reply_status: str = "",
    reply_text: str = "",
) -> dict:
    """Append a received DM; keep the newest _MAX_INBOX. Returns the stored entry."""
    entry = {
        "id": f"{int(time.time() * 1000)}_{sender_id}",
        "ts": time.time(),
        "session_file": session_file,
        "account_username": account_username,
        "account_name": account_name,
        "account_user_id": account_user_id,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_username": sender_username,
        "text": text,
        "media_type": media_type,
        "caption": caption,
        "reply_status": reply_status,
        "reply_text": reply_text,
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


# ── Admin-configurable auto-reply footer (data/admin_settings.json) ───────────
def _admin_settings_path():
    return config.DATA_DIR / "admin_settings.json"


def _load_admin_settings() -> dict:
    p = _admin_settings_path()
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def get_autoreply_footer(force: bool = False) -> str:
    """The current locked footer text (admin-set, or the default). Cached _FOOTER_TTL
    seconds so the posting worker (separate process) reads disk on a cadence, not per DM."""
    global _footer_cache
    now = time.time()
    if not force and _footer_cache and (now - _footer_cache[0]) < _FOOTER_TTL:
        return _footer_cache[1]
    ft = (_load_admin_settings().get("dm_autoreply_footer") or "").strip() or DEFAULT_AUTOREPLY_FOOTER
    _footer_cache = (now, ft)
    return ft


def get_autoreply_footer_meta() -> dict:
    """Footer text, its last-updated ISO time (or ''), and the default — for the admin UI."""
    s = _load_admin_settings()
    ft = (s.get("dm_autoreply_footer") or "").strip() or DEFAULT_AUTOREPLY_FOOTER
    return {"footer": ft, "updated_at": s.get("dm_autoreply_footer_updated_at", ""), "default": DEFAULT_AUTOREPLY_FOOTER}


def set_autoreply_footer(text: str) -> str:
    """Admin-only: change the footer. Empty falls back to the default (never truly blank).
    Read-modify-write so other admin settings are preserved. Records the update time."""
    from datetime import datetime
    global _footer_cache
    ft = (text or "").strip() or DEFAULT_AUTOREPLY_FOOTER
    with _settings_lock:
        s = _load_admin_settings()
        s["dm_autoreply_footer"] = ft
        s["dm_autoreply_footer_updated_at"] = datetime.utcnow().isoformat() + "Z"
        p = _admin_settings_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(s, indent=2), "utf-8")
    _footer_cache = (time.time(), ft)
    return ft


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
