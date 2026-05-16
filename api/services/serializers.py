"""Convert internal data structures to API-safe JSON-serializable dicts."""
from typing import Any, Optional
import time


def serialize_bot_summary(token: str, cfg: dict) -> dict:
    """Convert per-bot config to safe summary (no token exposed)."""
    sessions = cfg.get("sessions", [])
    return {
        "name": cfg.get("name", ""),
        "bot_username": cfg.get("bot_username", ""),
        "state": cfg.get("state", "stopped"),
        "mode": cfg.get("mode", "starter"),
        "sessions_count": len(sessions),
        "sessions_assigned": len(sessions),
        "cycle": cfg.get("cycle", 300),
        "gap": cfg.get("gap", 5),
        "valid_till": cfg.get("valid_till", ""),
        "plan_name": cfg.get("plan_name", ""),
        "running": cfg.get("state") == "running",
        "frozen": cfg.get("frozen", False),
        "suspended": cfg.get("suspended", False),
        "owner_id": cfg.get("owner_id"),
        "log_group": cfg.get("log_group"),
        "group_file": cfg.get("group_file", ""),
        "created_at": cfg.get("created_at", ""),
    }


def serialize_bot_detail(token: str, cfg: dict) -> dict:
    """Full bot detail (still no raw token)."""
    base = serialize_bot_summary(token, cfg)
    base.update({
        "sessions": [
            {
                "file": s.get("file", ""),
                "real_name": s.get("real_name", ""),
                "user_id": s.get("user_id"),
                "index": s.get("index"),
            }
            for s in cfg.get("sessions", [])
        ],
        "authorized": cfg.get("authorized", []),
        "excluded_groups": cfg.get("excluded_groups", []),
        "excluded_sessions": cfg.get("excluded_sessions", []),
        "custom_chatlist": cfg.get("custom_chatlist"),
        "plan": cfg.get("plan"),
        "history": cfg.get("history"),
        "web_token": cfg.get("web_token", ""),
        "last_web_login": cfg.get("last_web_login"),
        "web_login_history": cfg.get("web_login_history", []),
    })
    return base


def serialize_session(entry: dict) -> dict:
    """Convert session_full_list() entry to API format."""
    return {
        "filename": entry.get("file", entry.get("filename", "")),
        "status": entry.get("status", "unknown"),
        "bot_name": entry.get("bot_name", ""),
        "real_name": entry.get("real_name", ""),
        "user_id": entry.get("user_id"),
        "bucket": entry.get("bucket", ""),
    }


def serialize_order(order: dict) -> dict:
    """Convert order dict to API format (strip sensitive fields)."""
    return {
        "order_id": order.get("order_id", ""),
        "user_id": order.get("user_id"),
        "status": order.get("status", ""),
        "order_type": order.get("order_type", "purchase"),
        "plan_name": order.get("plan_name", ""),
        "plan_id": order.get("plan_id", ""),
        "mode": order.get("mode", ""),
        "duration_days": order.get("duration_days"),
        "amount_usd": order.get("amount_usd"),
        "pay_currency": order.get("pay_currency", ""),
        "pay_amount": order.get("pay_amount", ""),
        "tx_hash": order.get("tx_hash", ""),
        "created_at": order.get("created_at", ""),
        "paid_at": order.get("paid_at", ""),
        "bot_username": order.get("created_bot_username", ""),
    }


def serialize_alert(alert: dict) -> dict:
    return {
        "ts": alert.get("ts", 0),
        "type": alert.get("type", ""),
        "msg": alert.get("msg", ""),
        "age_sec": round(time.time() - alert.get("ts", time.time()), 1),
    }


def serialize_plan(plan: dict) -> dict:
    return {
        "id": plan.get("id", ""),
        "sessions": plan.get("sessions", 0),
        "cycle": plan.get("cycle", 0),
        "gap": plan.get("gap", 0),
        "price_week": plan.get("price_week", 0),
        "price_month": plan.get("price_month", 0),
    }


def serialize_stats(stats: dict) -> dict:
    """Normalize stats for API display."""
    return {
        "lifetime_sent": stats.get("lifetime_sent", stats.get("total_posts_sent", 0)),
        "lifetime_failed": stats.get("lifetime_failed", stats.get("total_posts_failed", 0)),
        "cycles": stats.get("cycles", 0),
        "session_stats": stats.get("session_stats", stats.get("sessions", {})),
        "hourly_buckets": stats.get("hourly_buckets", []),
    }


def paginate(items: list, page: int, per_page: int) -> dict:
    total = len(items)
    pages = max(1, (total + per_page - 1) // per_page)
    start = (page - 1) * per_page
    end = start + per_page
    return {
        "items": items[start:end],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
    }
