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
                t["reserved_at"] = _now()
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


def _reset_entry(t: dict[str, Any]) -> None:
    """Return a pool entry to the available state (in place)."""
    t["status"] = "available"
    t["order_id"] = ""
    t["assigned_at"] = ""
    t["reserved_at"] = ""


def release_by_token(token: str) -> bool:
    """Release a specific token (by its raw value) back to the pool.

    Used when a bot is deleted so its pooled token is freed for reuse even when
    the deletion path doesn't know the originating order id.
    """
    token = (token or "").strip()
    if not token:
        return False
    with _lock:
        data = _load_raw()
        changed = False
        for t in data["tokens"]:
            if t.get("token") == token and t.get("status") != "available":
                _reset_entry(t)
                changed = True
        if changed:
            _save_raw(data)
        return changed


def _parse_iso(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", ""))
    except Exception:
        return None


def reconcile(
    live_bot_tokens,
    active_order_ids=None,
    reserved_grace_seconds: int = 600,
) -> dict[str, list[str]]:
    """Bring the pool back in sync with reality.

    A pooled token only stays out of circulation while something real is holding
    it. This releases entries whose backing bot/order no longer exists, so a
    deleted bot or a cleared order can't strand a token as "assigned"/"reserved"
    forever.

    The pooled token *is* the bot token, so a live registered bot is the primary
    proof that a token is genuinely in use. A token can also be legitimately held
    by an order that hasn't produced its bot yet (e.g. a "pending_creation" order
    waiting on stock), so an entry whose order is still active is kept too.

    Rules per entry:
      - "assigned": released only when its token is NOT a live bot AND its order
        is no longer active. (An order is set "assigned" at submit time, before
        the bot exists — so we must not release those while the order lives.)
      - "reserved":
          * token is now a live bot  → promote to "assigned" (creation finished
            but the status was never advanced, e.g. after a crash).
          * owning order gone/terminal and the reservation is older than
            ``reserved_grace_seconds`` → released. The grace window protects an
            in-flight reservation from being pulled out from under a creation
            that's still running.
          * otherwise left untouched.

    ``active_order_ids`` is the set of non-terminal order ids. When it is None
    (couldn't be loaded), no releasing is done — only the safe reserved→assigned
    promotion — so a transient read failure can never strand a live order's token.

    Returns {"released": [...], "promoted": [...]}.
    """
    live = {(t or "").strip() for t in (live_bot_tokens or [])}
    active_orders = (
        {(o or "").strip() for o in active_order_ids}
        if active_order_ids is not None
        else None
    )
    now = datetime.utcnow()
    released: list[str] = []
    promoted: list[str] = []
    with _lock:
        data = _load_raw()
        changed = False
        for t in data["tokens"]:
            tok = (t.get("token") or "").strip()
            status = t.get("status", "available")
            oid = (t.get("order_id") or "").strip()
            order_active = active_orders is not None and oid in active_orders
            if status == "assigned":
                if active_orders is not None and tok not in live and not order_active:
                    _reset_entry(t)
                    released.append(tok)
                    changed = True
            elif status == "reserved":
                if tok in live:
                    t["status"] = "assigned"
                    if not t.get("assigned_at"):
                        t["assigned_at"] = _now()
                    promoted.append(tok)
                    changed = True
                elif active_orders is not None and not order_active:
                    reserved_at = _parse_iso(t.get("reserved_at", ""))
                    aged_out = (
                        reserved_at is None
                        or (now - reserved_at).total_seconds() >= reserved_grace_seconds
                    )
                    if aged_out:
                        _reset_entry(t)
                        released.append(tok)
                        changed = True
        if changed:
            _save_raw(data)
    return {"released": released, "promoted": promoted}
