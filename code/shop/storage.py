"""Plans and orders persistence for Shop Bot."""
import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .. import config

logger = logging.getLogger(__name__)

# Order state machine: only these transitions are allowed. Rejects e.g. cancelled → paid.
ORDER_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "payment_waiting": {"confirming", "paid", "cancelled", "expired"},
    "confirming": {"paid", "cancelled", "expired"},
    "paid": {"creating", "pending_creation", "cancelled", "completed"},  # completed: renewals finish without a bot-creation step
    "pending_creation": {"creating", "cancelled"},
    "creating": {"completed", "failed", "pending_creation"},  # pending_creation for stale recovery (>5 min)
    "completed": set(),  # terminal
    "failed": set(),    # terminal
    "cancelled": set(), # terminal
    "expired": set(),   # terminal
}

_orders_lock = threading.Lock()
_temppay_lock = threading.Lock()


def _plans_path() -> Path:
    return config.DATA_PLANS_FILE


def _orders_path() -> Path:
    return config.DATA_ORDERS_FILE


def _temppay_path() -> Path:
    return getattr(config, "DATA_TEMPPAY_FILE", config.DATA_DIR / "temppay.json")


def save_plans(plans: dict[str, list[dict[str, Any]]]) -> None:
    """Save plans to data/plans.json. Overwrites existing file."""
    path = _plans_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(plans, indent=2), encoding="utf-8")


def load_plans() -> dict[str, list[dict[str, Any]]]:
    """Load plans from data/plans.json. Returns {starter: [...], enterprise: [...]}."""
    path = _plans_path()
    if not path.exists():
        default = {
            "starter": [
                {"id": "bronze", "sessions": 1, "cycle": 3600, "gap": 5, "price_week": 30, "price_month": 70},
                {"id": "silver", "sessions": 2, "cycle": 3600, "gap": 5, "price_week": 55, "price_month": 115},
            ],
            "enterprise": [
                {"id": "basic", "sessions": 3, "cycle": 900, "gap": 5, "price_week": 50, "price_month": 199},
            ],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(default, indent=2), encoding="utf-8")
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"starter": [], "enterprise": []}
        data.setdefault("starter", [])
        data.setdefault("enterprise", [])
        return data
    except Exception as e:
        logger.warning("Could not load plans: %s", e)
        return {"starter": [], "enterprise": []}


def _load_orders_raw() -> list[dict[str, Any]]:
    """Load orders from file without lock. Caller must hold _orders_lock when modifying."""
    path = _orders_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "orders" in data:
            return list(data["orders"]) if isinstance(data["orders"], list) else []
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        logger.warning("Could not load orders: %s", e)
        return []


def load_orders() -> list[dict[str, Any]]:
    """Load orders from data/orders.json. Returns list of order dicts. Safe for concurrent read."""
    with _orders_lock:
        return _load_orders_raw()


def save_orders(orders: list[dict[str, Any]]) -> None:
    """Write orders to data/orders.json. Caller should hold _orders_lock for consistency."""
    path = _orders_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"orders": orders}, indent=2), encoding="utf-8")


def _save_orders_under_lock(orders: list[dict[str, Any]]) -> None:
    path = _orders_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"orders": orders}, indent=2), encoding="utf-8")


def get_order(order_id: str) -> dict[str, Any] | None:
    """Return order by order_id or None."""
    for o in load_orders():
        if o.get("order_id") == order_id:
            return o
    return None


def get_order_by_payment_id(payment_id: str) -> dict[str, Any] | None:
    """Return first order with given payment_id or None. Used for idempotent temppay→orders."""
    pid = (payment_id or "").strip()
    if not pid:
        return None
    for o in load_orders():
        if (o.get("payment_id") or "").strip() == pid:
            return o
    return None


def get_order_by_user_and_awaiting(user_id: int, status: str, awaiting_field: str | None = None) -> dict[str, Any] | None:
    """Return first order for user with given status and optionally awaiting_field."""
    for o in load_orders():
        if o.get("user_id") != user_id or o.get("status") != status:
            continue
        if awaiting_field is not None and o.get("awaiting_field") != awaiting_field:
            continue
        return o
    return None


def get_active_pending_order_for_user(user_id: int) -> dict[str, Any] | None:
    """
    Return active unpaid invoice for user: temppay entry first (new flow), then orders with payment_waiting/confirming (e.g. renewal).
    Returned dict has payment_chat_id, payment_message_id for editing message on cancel/expiry.
    """
    entry = temppay_get_by_user_id(user_id)
    if entry:
        return entry
    for o in load_orders():
        if o.get("user_id") != user_id:
            continue
        if o.get("status") in ("payment_waiting", "confirming"):
            return o
    return None


def get_active_pending_source(user_id: int) -> str | None:
    """Return 'temppay' if user has pending in temppay, 'orders' if in orders, else None."""
    if temppay_get_by_user_id(user_id):
        return "temppay"
    for o in load_orders():
        if o.get("user_id") == user_id and o.get("status") in ("payment_waiting", "confirming"):
            return "orders"
    return None


# --- temppay.json: active unpaid invoices (pending only). Atomic reads/writes. ---


def _load_temppay_raw() -> list[dict[str, Any]]:
    """Load temppay list without lock. Caller must hold _temppay_lock when modifying."""
    path = _temppay_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "invoices" in data:
            return list(data["invoices"]) if isinstance(data["invoices"], list) else []
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        logger.warning("Could not load temppay: %s", e)
        return []


def temppay_load_all() -> list[dict[str, Any]]:
    """Load all temppay entries. Worker uses this for polling. Safe for concurrent read."""
    with _temppay_lock:
        return _load_temppay_raw()


def _save_temppay_atomic(invoices: list[dict[str, Any]]) -> None:
    """Write temppay.json atomically (temp file + rename). Caller must hold _temppay_lock."""
    path = _temppay_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / ".temppay.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"invoices": invoices}, f, indent=2)
    try:
        os.replace(tmp, path)
    except Exception:
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass
        raise


def temppay_add(entry: dict[str, Any]) -> bool:
    """
    Add one unpaid invoice. Only one active per user allowed.
    Returns True if added, False if user_id already has an entry (no change).
    Atomic write.
    """
    with _temppay_lock:
        invoices = _load_temppay_raw()
        user_id = entry.get("user_id")
        if user_id is not None and any(str(inv.get("user_id")) == str(user_id) for inv in invoices):
            return False
        invoices.append(entry)
        _save_temppay_atomic(invoices)
    return True


def temppay_remove_by_invoice_id(invoice_id: str) -> bool:
    """Remove entry by invoice_id (payment_id). Atomic. Returns True if removed."""
    with _temppay_lock:
        invoices = _load_temppay_raw()
        before = len(invoices)
        invoices = [inv for inv in invoices if (inv.get("invoice_id") or inv.get("payment_id")) != invoice_id]
        if len(invoices) < before:
            _save_temppay_atomic(invoices)
            return True
    return False


def temppay_remove_by_user_id(user_id: int) -> dict[str, Any] | None:
    """Remove and return the entry for user_id if any. Atomic. Returns removed entry or None."""
    with _temppay_lock:
        invoices = _load_temppay_raw()
        removed = None
        kept = []
        for inv in invoices:
            if inv.get("user_id") == user_id:
                removed = inv
            else:
                kept.append(inv)
        if removed is not None:
            _save_temppay_atomic(kept)
        return removed


def temppay_get_by_user_id(user_id: int) -> dict[str, Any] | None:
    """Return first temppay entry for user_id or None."""
    with _temppay_lock:
        invoices = _load_temppay_raw()
        for inv in invoices:
            if inv.get("user_id") == user_id:
                return inv
    return None


def temppay_get_by_invoice_id(invoice_id: str) -> dict[str, Any] | None:
    """Return temppay entry by invoice_id (payment_id) or None."""
    with _temppay_lock:
        invoices = _load_temppay_raw()
        for inv in invoices:
            if (inv.get("invoice_id") or inv.get("payment_id")) == invoice_id:
                return inv
    return None


def order_from_temppay_entry(entry: dict[str, Any], status: str = "confirming") -> dict[str, Any]:
    """
    Build an order dict from a temppay entry for appending to orders.json.
    Used when payment status becomes confirming (move from temppay to orders).
    """
    order_id = entry.get("order_id") or str(uuid.uuid4())[:12]
    created_at = (entry.get("created_at") or "").strip() or datetime.utcnow().isoformat() + "Z"
    expiry_time = (entry.get("expiry_time") or entry.get("expiry_at") or "").strip() or _expiry_from_created(created_at, 12)
    return {
        "order_id": order_id,
        "user_id": entry.get("user_id"),
        "plan_id": entry.get("plan_id", ""),
        "plan_name": entry.get("plan_name", ""),
        "plan_mode": (entry.get("plan_mode") or "starter").strip().capitalize(),
        "duration_days": int(entry.get("duration_days") or 0),
        "amount_usd": float(entry.get("amount_usd") or 0),
        "payment_id": (entry.get("invoice_id") or entry.get("payment_id") or "").strip(),
        "currency": (entry.get("currency") or "").strip(),
        "status": status,
        "bot_token": "",
        "created_at": created_at,
        "expiry_time": expiry_time,
        "paid_at": "",
        "created_bot_username": "",
        "invoice_url": entry.get("invoice_url") or "",
        "pay_address": entry.get("address") or entry.get("pay_address") or "",
        "pay_amount": entry.get("amount") or entry.get("pay_amount"),
        "pay_currency": (entry.get("currency") or "").strip().upper(),
        "payment_chat_id": entry.get("payment_chat_id") or 0,
        "payment_message_id": entry.get("payment_message_id") or 0,
    }


def append_order_from_temppay(entry: dict[str, Any], status: str = "confirming") -> dict[str, Any]:
    """Build order from temppay entry, append to orders.json, return the new order. Thread-safe."""
    order = order_from_temppay_entry(entry, status=status)
    with _orders_lock:
        orders = _load_orders_raw()
        orders.append(order)
        _save_orders_under_lock(orders)
    return order


def update_order(order_id: str, updates: dict[str, Any]) -> bool:
    """Update an order by order_id. Merges updates into the order. Returns True if found. Thread-safe."""
    with _orders_lock:
        orders = _load_orders_raw()
        for i, o in enumerate(orders):
            if o.get("order_id") == order_id:
                orders[i] = {**o, **updates}
                _save_orders_under_lock(orders)
                return True
        return False


def _order_transition_allowed(current_status: str, new_status: str) -> bool:
    """True if transition from current_status to new_status is allowed by the state machine."""
    if current_status == new_status:
        return True
    allowed = ORDER_STATUS_TRANSITIONS.get(current_status)
    if allowed is None:
        return True  # unknown/legacy/empty: allow so new orders and migration work
    return new_status in allowed


def update_order_status(order_id: str, status: str, **extra: Any) -> bool:
    """Set order status and optional fields. Rejects illegal transitions (e.g. cancelled → paid)."""
    with _orders_lock:
        orders = _load_orders_raw()
        for i, o in enumerate(orders):
            if o.get("order_id") != order_id:
                continue
            current = (o.get("status") or "").strip()
            if not _order_transition_allowed(current, status):
                logger.warning(
                    "Order %s: illegal transition %s → %s rejected",
                    order_id, current or "(empty)", status,
                )
                return False
            updates: dict[str, Any] = {"status": status}
            if "paid_at" in extra:
                updates["paid_at"] = extra["paid_at"]
            if "created_bot_username" in extra:
                updates["created_bot_username"] = extra["created_bot_username"]
            if "bot_token" in extra:
                updates["bot_token"] = extra["bot_token"]
            for k, v in extra.items():
                if k not in ("paid_at", "created_bot_username", "bot_token"):
                    updates[k] = v
            orders[i] = {**o, **updates}
            _save_orders_under_lock(orders)
            return True
        return False


def _expiry_from_created(created_at_iso: str, hours: int = 12) -> str:
    """Return expiry_time ISO string (created_at + hours)."""
    try:
        s = (created_at_iso or "").replace("Z", "").strip().split(".")[0]
        dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
        exp = dt + timedelta(hours=hours)
        return exp.strftime("%Y-%m-%dT%H:%M:%S") + "Z"
    except Exception:
        return ""


def create_renewal_order(parent_order_id: str, user_id: int, duration_days: int, amount_usd: float, payment_id: str, currency: str, invoice_url: str | None = None) -> dict[str, Any]:
    """Create a renewal order (status payment_waiting). Stores created_at, expiry_time (created_at + 12h), next_poll_at set by worker."""
    order_id = str(uuid.uuid4())[:12]
    now = datetime.utcnow().isoformat() + "Z"
    order = {
        "order_id": order_id,
        "user_id": user_id,
        "parent_order_id": parent_order_id,
        "order_type": "renewal",
        "duration_days": duration_days,
        "amount_usd": amount_usd,
        "payment_id": payment_id,
        "currency": currency,
        "status": "payment_waiting",
        "created_at": now,
        "expiry_time": _expiry_from_created(now, 12),
        "paid_at": "",
        "invoice_url": invoice_url or "",
    }
    with _orders_lock:
        orders = _load_orders_raw()
        orders.append(order)
        _save_orders_under_lock(orders)
    return order


def create_order(
    user_id: int,
    plan_id: str,
    plan_name: str,
    plan_mode: str,
    duration_days: int,
    amount_usd: float,
    payment_id: str,
    currency: str,
    invoice_url: str | None = None,
) -> dict[str, Any]:
    """Append a new order with status payment_waiting. Stores created_at, expiry_time (created_at + 12h). next_poll_at set by worker. Thread-safe."""
    order_id = str(uuid.uuid4())[:12]
    now = datetime.utcnow().isoformat() + "Z"
    order = {
        "order_id": order_id,
        "user_id": user_id,
        "plan_id": plan_id,
        "plan_name": plan_name,
        "plan_mode": plan_mode,
        "duration_days": duration_days,
        "amount_usd": amount_usd,
        "payment_id": payment_id,
        "currency": currency,
        "status": "payment_waiting",
        "bot_token": "",
        "created_at": now,
        "expiry_time": _expiry_from_created(now, 12),
        "paid_at": "",
        "created_bot_username": "",
        "invoice_url": invoice_url or "",
    }
    with _orders_lock:
        orders = _load_orders_raw()
        orders.append(order)
        _save_orders_under_lock(orders)
    return order


def orders_pending_creation() -> list[dict[str, Any]]:
    """Return orders with status pending_creation (insufficient sessions at payment time)."""
    return [o for o in load_orders() if o.get("status") == "pending_creation"]


def orders_by_user(user_id: int) -> list[dict[str, Any]]:
    """Return orders for a user (for renewal: find bot by order)."""
    return [o for o in load_orders() if o.get("user_id") == user_id]


def search_orders(
    order_id: str | None = None,
    payment_id: str | None = None,
    user_id: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search orders by order_id (exact), payment_id (exact), or user_id. Returns up to limit matches."""
    orders = load_orders()
    out = []
    for o in orders:
        if order_id is not None and (o.get("order_id") or "").strip() != (order_id or "").strip():
            continue
        if payment_id is not None and (o.get("payment_id") or "").strip() != (payment_id or "").strip():
            continue
        if user_id is not None and o.get("user_id") != user_id:
            continue
        out.append(o)
        if len(out) >= limit:
            break
    return out


def orders_count_by_status() -> dict[str, int]:
    """Return counts per status for dashboard. Keys: payment_waiting, confirming, paid, creating, pending_creation, completed, failed, cancelled, expired."""
    counts: dict[str, int] = {}
    for o in load_orders():
        s = (o.get("status") or "unknown").strip() or "unknown"
        counts[s] = counts.get(s, 0) + 1
    return counts


def cleanup_old_expired_cancelled_orders(hours_old: int = 48) -> int:
    """
    Remove orders that are expired or cancelled, older than hours_old, and have no bot_token.
    Never touches: completed, creating, pending_creation, paid.
    Returns number of orders removed.
    """
    from datetime import datetime, timedelta
    cutoff = datetime.utcnow() - timedelta(hours=hours_old)
    with _orders_lock:
        orders = _load_orders_raw()
        kept = []
        removed = 0
        for o in orders:
            status = o.get("status") or ""
            if status not in ("expired", "cancelled"):
                kept.append(o)
                continue
            bot_token = (o.get("bot_token") or "").strip()
            if bot_token:
                kept.append(o)
                continue
            created = (o.get("created_at") or "").strip()
            if not created:
                kept.append(o)
                continue
            try:
                created_dt = datetime.strptime(created.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
                if created_dt >= cutoff:
                    kept.append(o)
                    continue
            except ValueError:
                kept.append(o)
                continue
            removed += 1
        if removed:
            _save_orders_under_lock(kept)
    return removed
