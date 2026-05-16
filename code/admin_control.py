"""
Admin Control System: order search/actions, user search/actions, broadcast segments,
session operations, bot operations, observability dashboard, emergency stop/resume.
Backend logic only; UI is in admin_ptb.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import config
from .utils import load_adbot, save_adbot, load_pool, save_pool, load_user_data, save_user_data, get_name_by_token, name_to_filename

logger = logging.getLogger(__name__)

# --- Order & payment ---
def _orders_search(order_id: str | None = None, payment_id: str | None = None, user_id: int | None = None):
    from .shop.storage import search_orders
    return search_orders(order_id=order_id, payment_id=payment_id, user_id=user_id, limit=50)


def order_mark_paid(order_id: str, trigger_creation: bool = True) -> tuple[bool, str]:
    """Mark order as paid. If trigger_creation, transition to creating and return (True, 'created') for admin to submit job."""
    from .shop.storage import get_order, update_order_status, ORDER_STATUS_TRANSITIONS
    o = get_order(order_id)
    if not o:
        return False, "Order not found"
    s = (o.get("status") or "").strip()
    if s not in ("payment_waiting", "confirming"):
        return False, f"Order status is {s}, cannot mark paid"
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if not update_order_status(order_id, "paid", paid_at=now):
        return False, "Transition rejected"
    if trigger_creation:
        update_order_status(order_id, "creating")
    return True, "Marked paid" + ("; set to creating for job submission" if trigger_creation else "")


def order_cancel(order_id: str) -> tuple[bool, str]:
    from .shop.storage import get_order, update_order_status
    o = get_order(order_id)
    if not o:
        return False, "Order not found"
    s = (o.get("status") or "").strip()
    if s not in ("payment_waiting", "confirming", "paid", "pending_creation"):
        return False, f"Cannot cancel order with status {s}"
    if s == "paid" or s == "pending_creation":
        update_order_status(order_id, "cancelled")
        return True, "Order cancelled"
    update_order_status(order_id, "cancelled")
    return True, "Order cancelled"


# --- User search & actions ---
def user_search_by_telegram_id(user_id: int) -> list[dict[str, Any]]:
    """Return list of bot configs where user is in authorized."""
    adbot = load_adbot()
    bots = adbot.get("bots", {})
    out = []
    for token, cfg in bots.items():
        if user_id in (cfg.get("authorized") or []):
            out.append({"bot_token": token, "name": cfg.get("name"), "bot_username": cfg.get("bot_username"), "valid_till": cfg.get("valid_till"), "suspended": cfg.get("suspended"), "frozen": cfg.get("frozen")})
    return out


def user_search_by_bot_username(username: str) -> dict[str, Any] | None:
    """Return bot config for @username (strip @)."""
    username = (username or "").strip().lstrip("@").lower()
    if not username:
        return None
    adbot = load_adbot()
    for token, cfg in adbot.get("bots", {}).items():
        if (cfg.get("bot_username") or "").strip().lower() == username:
            return {"bot_token": token, **cfg}
    return None


def user_search_by_plan_type(plan_name: str) -> list[dict[str, Any]]:
    """Return list of bot configs with plan_name (plan_name or plan_name in plan)."""
    plan_name = (plan_name or "").strip().lower()
    if not plan_name:
        return []
    adbot = load_adbot()
    out = []
    for token, cfg in adbot.get("bots", {}).items():
        pn = (cfg.get("plan_name") or cfg.get("plan", {}).get("name") or "").strip().lower()
        if plan_name in pn or pn in plan_name:
            out.append({"bot_token": token, "name": cfg.get("name"), "bot_username": cfg.get("bot_username"), "valid_till": cfg.get("valid_till"), "plan_name": cfg.get("plan_name")})
    return out


def user_extend_plan(bot_token: str, add_days: int) -> tuple[bool, str]:
    """Extend valid_till by add_days. valid_till format dd/mm/yyyy."""
    name = get_name_by_token(bot_token)
    if not name:
        return False, "Bot not found"
    cfg = load_user_data(name)
    if not cfg:
        return False, "Config not found"
    vt = (cfg.get("valid_till") or "").strip()
    if not vt:
        try:
            base = datetime.now()
        except Exception:
            return False, "Invalid valid_till"
    else:
        try:
            base = datetime.strptime(vt, "%d/%m/%Y")
        except ValueError:
            return False, "valid_till format must be dd/mm/yyyy"
    new_dt = base + timedelta(days=add_days)
    new_vt = new_dt.strftime("%d/%m/%Y")
    cfg["valid_till"] = new_vt
    save_user_data(name, cfg)
    return True, f"Extended to {new_vt}"


def user_freeze(bot_token: str, freeze: bool) -> tuple[bool, str]:
    """Set frozen flag on bot config (freeze=True or unfreeze=False)."""
    name = get_name_by_token(bot_token)
    if not name:
        return False, "Bot not found"
    cfg = load_user_data(name)
    if not cfg:
        return False, "Config not found"
    cfg["frozen"] = bool(freeze)
    save_user_data(name, cfg)
    return True, "Frozen" if freeze else "Unfrozen"


def user_set_suspended(bot_token: str, suspended: bool) -> tuple[bool, str]:
    """Set suspended flag (admin suspend/resume bot). When suspending, also submit stop_posting job."""
    name = get_name_by_token(bot_token)
    if not name:
        return False, "Bot not found"
    cfg = load_user_data(name)
    if not cfg:
        return False, "Config not found"
    cfg["suspended"] = bool(suspended)
    save_user_data(name, cfg)
    adbot = load_adbot()
    if bot_token in adbot.get("bots", {}):
        adbot["bots"][bot_token]["suspended"] = bool(suspended)
        save_adbot(adbot)
    if suspended:
        from .admin_ptb import submit_main_loop_job
        submit_main_loop_job("stop_posting", (bot_token,))
    return True, "Suspended" if suspended else "Resumed"


def user_transfer_ownership(bot_token: str, new_user_id: int) -> tuple[bool, str]:
    """Set authorized to [new_user_id]."""
    name = get_name_by_token(bot_token)
    if not name:
        return False, "Bot not found"
    cfg = load_user_data(name)
    if not cfg:
        return False, "Config not found"
    cfg["authorized"] = [int(new_user_id)]
    save_user_data(name, cfg)
    adbot = load_adbot()
    if bot_token in adbot.get("bots", {}):
        adbot["bots"][bot_token]["authorized"] = [int(new_user_id)]
        save_adbot(adbot)
    return True, f"Ownership transferred to {new_user_id}"


# --- Broadcast segments (persistent DB only; no recomputation at send time) ---
def _broadcast_validate_user_ids(raw_ids: list[Any]) -> tuple[list[int], int]:
    """Coerce IDs to int; return (valid_list, invalid_count). Invalid: None, non-numeric, float, negative, zero."""
    valid: list[int] = []
    invalid = 0
    for x in raw_ids:
        try:
            if x is None:
                invalid += 1
                continue
            uid = int(x)
            if uid <= 0:
                invalid += 1
                continue
            valid.append(uid)
        except (TypeError, ValueError):
            invalid += 1
    return valid, invalid


def broadcast_segment_user_ids(segment: str) -> list[int]:
    """Return list of user_id for segment from broadcast_users.json only: all_users, plan_users. Invalid IDs filtered out."""
    valid, _, _ = broadcast_segment_user_ids_validated(segment)
    return valid


def broadcast_segment_user_ids_validated(segment: str) -> tuple[list[int], int, int]:
    """Load segment IDs, validate to int; return (valid_ids, total_loaded, invalid_count). For [BroadcastDebug] logging."""
    from .broadcast_users import load_broadcast_users
    db = load_broadcast_users()
    raw: list[Any] = []
    if segment == "all_users":
        raw = list(db.get("all_users") or [])
    elif segment == "plan_users":
        raw = list(db.get("plan_users") or [])
    valid, invalid = _broadcast_validate_user_ids(raw)
    return valid, len(raw), invalid


def broadcast_recipients_all_users() -> list[int]:
    """Recipient user IDs for 'All Users' (shop visitors). Notifications must be sent using the Shop Bot token."""
    return broadcast_segment_user_ids("all_users")


def broadcast_recipients_bot_users() -> list[tuple[int, str]]:
    """Legacy alias: use broadcast_recipients_plan_users."""
    return broadcast_recipients_plan_users()


def broadcast_recipients_plan_users() -> list[tuple[int, str]]:
    """Recipients for 'Plan Users': (user_id, bot_token). Each user's assigned bot token per plan. Sent via that bot. Deduplicated by user_id (first bot wins)."""
    data = load_adbot()
    user_to_token: dict[int, str] = {}
    for bot_token, cfg in data.get("bots", {}).items():
        for uid in cfg.get("authorized", []):
            try:
                u = int(uid)
                if u > 0 and u not in user_to_token:
                    user_to_token[u] = bot_token
            except (TypeError, ValueError):
                continue
    return [(uid, token) for uid, token in user_to_token.items()]


def broadcast_log_append(segment: str, count: int, sent: int, failed: int) -> None:
    path = getattr(config, "DATA_BROADCAST_LOG_FILE", config.DATA_DIR / "broadcast_log.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = {"logs": []}
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {"logs": []}
        data.setdefault("logs", [])
        data["logs"].append({
            "at": datetime.now(timezone.utc).isoformat(),
            "segment": segment,
            "recipient_count": count,
            "sent": sent,
            "failed": failed,
        })
        data["logs"] = data["logs"][-500:]
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning("Broadcast log append failed: %s", e)


# --- Session operations ---
# All valid session buckets and their pool.json keys + filesystem directories
SESSION_BUCKETS = {
    "free": {"pool_key": "free_sessions", "dir": None},       # dir set below (config import timing)
    "dead": {"pool_key": "dead_sessions", "dir": None},
    "frozen": {"pool_key": "frozen_sessions", "dir": None},
    "limited": {"pool_key": "limited_sessions", "dir": None},
    "unauth": {"pool_key": "unauth_sessions", "dir": None},
}

def _bucket_dirs() -> dict[str, "Path"]:
    """Return bucket -> directory mapping (lazy so config is loaded)."""
    return {
        "free": config.SESSIONS_ACTIVE,
        "dead": config.SESSIONS_DEAD,
        "frozen": config.SESSIONS_FROZEN,
        "limited": config.SESSIONS_LIMITED,
        "unauth": config.SESSIONS_UNAUTH,
    }

def _bucket_pool_keys() -> dict[str, str]:
    """Return bucket -> pool.json key mapping."""
    return {b: v["pool_key"] for b, v in SESSION_BUCKETS.items()}


def session_full_list() -> list[dict[str, Any]]:
    """Return list of {file, status, bot_name} for all sessions. status: free, dead, frozen, limited, unauth, assigned."""
    pool = load_pool()
    adbot = load_adbot()
    result = []
    for bucket, pool_key in _bucket_pool_keys().items():
        for fn in pool.get(pool_key, []):
            result.append({"file": fn, "status": bucket, "bot_name": None})
    for token, cfg in adbot.get("bots", {}).items():
        name = cfg.get("name") or token[:15]
        for s in cfg.get("sessions", []):
            fn = s.get("file")
            if fn:
                result.append({"file": fn, "status": "assigned", "bot_name": name})
    return result


def session_to_bot_map() -> list[tuple[str, str]]:
    """Return list of (session_file, bot_name)."""
    adbot = load_adbot()
    out = []
    for token, cfg in adbot.get("bots", {}).items():
        name = cfg.get("name") or token[:15]
        for s in cfg.get("sessions", []):
            fn = s.get("file")
            if fn:
                out.append((fn, name))
    return out


def session_move(file_name: str, from_bucket: str, to_bucket: str, bot_token: str | None = None) -> tuple[bool, str]:
    """Move session between any bucket (free, dead, frozen, limited, unauth). If assigned->*, pass bot_token to remove from bot."""
    import shutil
    pool = load_pool()
    adbot = load_adbot()
    fn = (file_name or "").strip()
    if not fn.endswith(".session"):
        fn = fn + ".session" if fn else fn
    file_name_orig = file_name or fn
    bucket_keys = _bucket_pool_keys()
    dirs = _bucket_dirs()

    if to_bucket not in bucket_keys:
        return False, f"Invalid target bucket: {to_bucket}"

    def remove_from_bot(bt: str) -> bool:
        cfg = adbot.get("bots", {}).get(bt)
        if not cfg:
            return False
        sess = [x for x in cfg.get("sessions", []) if (x.get("file") or "").strip() != file_name_orig and (x.get("file") or "").strip() != fn]
        if len(sess) == len(cfg.get("sessions", [])):
            return False
        cfg["sessions"] = sess
        name = get_name_by_token(bt)
        if name:
            save_user_data(name, cfg)
        return True

    if from_bucket == "assigned" and bot_token:
        if not remove_from_bot(bot_token):
            return False, "Bot not found or session not in bot"
        save_adbot(adbot)

    # Remove from source bucket
    for b, key in bucket_keys.items():
        if from_bucket == b:
            lst = list(pool.get(key, []))
            pool[key] = [x for x in lst if x != fn and x != file_name_orig]
    # Add to destination bucket
    dest_key = bucket_keys[to_bucket]
    dest_lst = list(pool.get(dest_key, []))
    if fn not in dest_lst and file_name_orig not in dest_lst:
        dest_lst.append(fn)
        pool[dest_key] = dest_lst
    save_pool(pool)

    # Move actual file between directories
    src_dir = dirs.get(from_bucket)
    dest_dir = dirs.get(to_bucket)
    if src_dir and dest_dir and src_dir != dest_dir:
        for candidate in (fn, file_name_orig):
            src = src_dir / candidate
            if src.is_file():
                try:
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), str(dest_dir / candidate))
                except OSError as e:
                    logger.warning("Move session file %s: %s", candidate, e)
                break
    return True, f"Moved to {to_bucket}"


def session_force_disconnect(session_file: str) -> tuple[bool, str]:
    """Return (True, bot_token) if session is assigned so caller can submit main_loop job to stop that bot."""
    adbot = load_adbot()
    for token, cfg in adbot.get("bots", {}).items():
        for s in cfg.get("sessions", []):
            if (s.get("file") or "") == session_file:
                return True, token
    return False, ""


def session_force_disconnect_submit(session_file: str) -> tuple[bool, str]:
    """Submit job to main loop to stop bot using this session. Returns (True, msg) if submitted."""
    ok, token = session_force_disconnect(session_file)
    if not ok:
        return False, "Session not assigned to any bot"
    from .admin_ptb import submit_main_loop_job
    submit_main_loop_job("stop_posting", (token,))
    return True, f"Stop requested for bot using {session_file}"


# --- Observability dashboard ---
def dashboard_counts() -> dict[str, Any]:
    """Aggregated counts for admin dashboard."""
    from .shop.storage import orders_count_by_status
    import time
    adbot = load_adbot()
    pool = load_pool()
    bots = adbot.get("bots", {})
    total_bots = len(bots)
    running = sum(1 for c in bots.values() if c.get("state") == "running")
    stopped = total_bots - running
    free = len(pool.get("free_sessions", []))
    dead = len(pool.get("dead_sessions", []))
    frozen = len(pool.get("frozen_sessions", []))
    limited = len(pool.get("limited_sessions", []))
    unauth = len(pool.get("unauth_sessions", []))
    assigned = sum(len(c.get("sessions", [])) for c in bots.values())
    orders_by_status = orders_count_by_status()
    CREATE_HEARTBEAT_PATH = config.DATA_DIR / "create_worker_heartbeat.json"
    PAYMENT_HEARTBEAT_PATH = config.DATA_DIR / "payment_worker_heartbeat.json"
    def read_ts(path):
        try:
            if path and path.exists():
                d = json.loads(path.read_text(encoding="utf-8"))
                return float(d.get("ts", 0) or 0)
        except Exception:
            pass
        return None
    create_ts = read_ts(CREATE_HEARTBEAT_PATH)
    payment_ts = read_ts(PAYMENT_HEARTBEAT_PATH)
    now = time.time()
    create_ok = (create_ts is not None and (now - create_ts) < 900) if create_ts else False
    payment_ok = (payment_ts is not None and (now - payment_ts) < 900) if payment_ts else False
    return {
        "total_bots": total_bots,
        "running_bots": running,
        "stopped_bots": stopped,
        "free_sessions": free,
        "dead_sessions": dead,
        "frozen_sessions": frozen,
        "limited_sessions": limited,
        "unauth_sessions": unauth,
        "assigned_sessions": assigned,
        "orders_by_status": orders_by_status,
        "create_worker_ok": create_ok,
        "payment_worker_ok": payment_ok,
        "create_heartbeat_ts": create_ts,
        "payment_heartbeat_ts": payment_ts,
    }


# --- Emergency stop / resume all posting (submit to main loop) ---
EMERGENCY_STOPPED_FILE = config.DATA_DIR / "emergency_stopped.json"


def emergency_stop_all_posting(admin_id: int | None = None) -> tuple[int, str]:
    """Submit job to main loop to stop all running bots. admin_id for audit. Returns (n, message) immediately."""
    from .admin_ptb import submit_main_loop_job
    adbot = load_adbot()
    running_tokens = [t for t, c in adbot.get("bots", {}).items() if c.get("state") == "running"]
    submit_main_loop_job("emergency_stop_all", (running_tokens, admin_id))
    return len(running_tokens), f"Stop requested for {len(running_tokens)} bot(s). You will be notified when done."


def emergency_resume_all_posting(admin_id: int | None = None) -> tuple[int, str]:
    """Submit job to main loop to resume all emergency-stopped bots. admin_id for audit."""
    from .admin_ptb import submit_main_loop_job
    if not EMERGENCY_STOPPED_FILE.exists():
        return 0, "No emergency-stopped bots recorded"
    try:
        data = json.loads(EMERGENCY_STOPPED_FILE.read_text(encoding="utf-8"))
        tokens = data.get("tokens", [])
    except Exception:
        tokens = []
    submit_main_loop_job("emergency_resume_all", (tokens, admin_id))
    return len(tokens), f"Resume requested for {len(tokens)} bot(s)."
