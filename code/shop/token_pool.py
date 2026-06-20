"""Bot-token pool for web purchases.

Admins pre-create bots in @BotFather and add their tokens here. When a user buys
an AdBot from the website, one available token is reserved, then assigned once the
bot is created. Tokens are released back to the pool if the purchase is abandoned,
the payment never confirms, a renewal lapses, or an admin deletes the bot.

Storage: data/bot_token_pool.json
  { "tokens": [ {token, username, status, order_id, added_at, assigned_at} ] }

status: "available" | "reserved" | "assigned"
"""
import json
import logging
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from .. import config

logger = logging.getLogger(__name__)

_lock = threading.Lock()


def _pool_path() -> Path:
    return config.DATA_DIR / "bot_token_pool.json"


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _load_raw() -> dict[str, Any]:
    path = _pool_path()
    if not path.exists():
        return {"tokens": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("tokens"), list):
            return {"tokens": []}
        return data
    except Exception as exc:
        logger.warning("[TOKEN_POOL] Failed to load %s: %s", path, exc)
        return {"tokens": []}


def _save_raw(data: dict[str, Any]) -> None:
    path = _pool_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _mask(token: str) -> str:
    """Mask a bot token for display: 1234567:AAE...xyz."""
    token = (token or "").strip()
    if ":" in token:
        head, tail = token.split(":", 1)
        return f"{head}:{tail[:3]}...{tail[-3:]}" if len(tail) > 8 else f"{head}:***"
    return token[:4] + "***" if len(token) > 4 else "***"


def add_token(token: str, username: str = "") -> tuple[bool, str]:
    """Add a token to the pool. Returns (ok, message). Rejects duplicates."""
    token = (token or "").strip()
    if not token:
        return False, "Empty token"
    with _lock:
        data = _load_raw()
        for t in data["tokens"]:
            if t.get("token") == token:
                return False, "Token already in pool"
        data["tokens"].append({
            "id": uuid.uuid4().hex[:10],
            "token": token,
            "username": (username or "").strip(),
            "status": "available",
            "order_id": "",
            "added_at": _now(),
            "assigned_at": "",
        })
        _save_raw(data)
    return True, "Added"


def remove_by_id(token_id: str) -> bool:
    """Remove a token by its pool id (used by the admin UI, which only sees masked tokens)."""
    token_id = (token_id or "").strip()
    with _lock:
        data = _load_raw()
        before = len(data["tokens"])
        data["tokens"] = [t for t in data["tokens"] if t.get("id") != token_id]
        if len(data["tokens"]) == before:
            return False
        _save_raw(data)
    return True


def remove_token(token: str) -> bool:
    """Remove a token entirely from the pool."""
    token = (token or "").strip()
    with _lock:
        data = _load_raw()
        before = len(data["tokens"])
        data["tokens"] = [t for t in data["tokens"] if t.get("token") != token]
        if len(data["tokens"]) == before:
            return False
        _save_raw(data)
    return True


def list_tokens(mask: bool = True) -> list[dict[str, Any]]:
    """Return all pool entries. Tokens masked by default (for admin display)."""
    data = _load_raw()
    out = []
    for t in data["tokens"]:
        entry = dict(t)
        if mask:
            entry["token"] = _mask(t.get("token", ""))
        out.append(entry)
    return out


def counts() -> dict[str, int]:
    data = _load_raw()
    c = {"available": 0, "reserved": 0, "assigned": 0, "total": len(data["tokens"])}
    for t in data["tokens"]:
        st = t.get("status", "available")
        if st in c:
            c[st] += 1
    return c


def count_available() -> int:
    return counts()["available"]


def reserve_token(order_id: str) -> Optional[dict[str, Any]]:
    """Reserve the first available token for an order. Returns the entry, or None if pool empty."""
    with _lock:
        data = _load_raw()
        # If this order already holds a token, return it (idempotent).
        for t in data["tokens"]:
            if t.get("order_id") == order_id and t.get("status") in ("reserved", "assigned"):
                return dict(t)
        for t in data["tokens"]:
            if t.get("status") == "available":
                t["status"] = "reserved"
                t["order_id"] = order_id
                _save_raw(data)
                return dict(t)
    return None


def mark_assigned(order_id: str) -> bool:
    """Mark a reserved token as assigned (bot created)."""
    with _lock:
        data = _load_raw()
        for t in data["tokens"]:
            if t.get("order_id") == order_id:
                t["status"] = "assigned"
                t["assigned_at"] = _now()
                _save_raw(data)
                return True
    return False


def release_order(order_id: str) -> bool:
    """Release any token held by an order back to the pool (abandoned/failed/deleted)."""
    if not order_id:
        return False
    with _lock:
        data = _load_raw()
        changed = False
        for t in data["tokens"]:
            if t.get("order_id") == order_id:
                t["status"] = "available"
                t["order_id"] = ""
                t["assigned_at"] = ""
                changed = True
        if changed:
            _save_raw(data)
        return changed


def get_by_order(order_id: str) -> Optional[dict[str, Any]]:
    if not order_id:
        return None
    data = _load_raw()
    for t in data["tokens"]:
        if t.get("order_id") == order_id:
            return dict(t)
    return None
