"""Convert internal data structures to API-safe JSON-serializable dicts."""
from typing import Any, Optional
from datetime import datetime, timedelta
import time

# Grace window after a plan's valid_till passes before the bot is purged. Mirrors
# GRACE_PERIOD_HOURS in code/shop/workers.py — kept in sync intentionally.
_GRACE_HOURS = 48


def _expiry_fields(cfg: dict) -> dict:
    """Server-authoritative expiry state for the portal gate.
    - expired: plan is past valid_till (or already flagged state=expired).
    - in_grace: inside the 48h grace window (posting stopped, bot not yet purged).
    - grace_hours_left: whole hours until purge (from expired_at), or None if not yet tracked.
    """
    state = cfg.get("state", "stopped")
    vt = (cfg.get("valid_till") or "").strip()
    expired_at_raw = str(cfg.get("expired_at") or "").strip()
    expired = state == "expired"
    if not expired and vt:
        try:
            expired = datetime.now() > datetime.strptime(vt, "%d/%m/%Y")
        except ValueError:
            pass
    grace_hours_left = None
    in_grace = False
    if expired_at_raw:
        try:
            started = datetime.fromisoformat(expired_at_raw.replace("Z", "").split(".")[0])
            left = (started + timedelta(hours=_GRACE_HOURS)) - datetime.utcnow()
            grace_hours_left = max(0, int(left.total_seconds() // 3600))
            in_grace = left.total_seconds() > 0
        except ValueError:
            pass
    return {
        "expired": expired,
        "in_grace": in_grace,
        "grace_hours_left": grace_hours_left,
        "expired_at": expired_at_raw,
    }


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
        **_expiry_fields(cfg),
    }


def serialize_bot_detail(token: str, cfg: dict) -> dict:
    """Full bot detail (still no raw token)."""
    base = serialize_bot_summary(token, cfg)
    disabled_set = {(f or "").strip() for f in (cfg.get("disabled_sessions") or []) if f}
    base.update({
        "sessions": [
            {
                "file": s.get("file", ""),
                "real_name": s.get("real_name", ""),
                "user_id": s.get("user_id"),
                "index": s.get("index"),
                "disabled": (s.get("file", "") or "").strip() in disabled_set,
            }
            for s in cfg.get("sessions", [])
        ],
        "authorized": cfg.get("authorized", []),
        "excluded_groups": cfg.get("excluded_groups", []),
        "excluded_sessions": cfg.get("excluded_sessions", []),
        "disabled_sessions": cfg.get("disabled_sessions", []),
        "custom_chatlist": cfg.get("custom_chatlist"),
        # Live posting content the user configured via the portal / shop bot.
        # "link" mode forwards one of post_links; "text" mode posts message_text.
        "message_mode": cfg.get("message_mode", "link"),
        "message_text": cfg.get("message_text", ""),
        "post_links": cfg.get("post_links", []),
        "post_link": cfg.get("post_link", ""),  # legacy single-link fallback
        "plan": cfg.get("plan"),
        "history": cfg.get("history"),
        "renewal_price": cfg.get("renewal_price", ""),
        "legacy_renewal_price": cfg.get("legacy_renewal_price", ""),
        "renewal_prices": cfg.get("renewal_prices") or {"7d": None, "30d": None},
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
    """Convert order dict to API format (admin-only endpoints, so payment fields are included)."""
    return {
        "order_id": order.get("order_id", ""),
        "user_id": order.get("user_id"),
        "status": order.get("status", ""),
        "order_type": order.get("order_type", "purchase"),
        "source": order.get("source", ""),
        "plan_name": order.get("plan_name", ""),
        "plan_id": order.get("plan_id", ""),
        "plan_mode": order.get("plan_mode", "") or order.get("mode", ""),
        "mode": order.get("mode", ""),
        "duration_days": order.get("duration_days"),
        "amount_usd": order.get("amount_usd"),
        "base_amount_usd": order.get("base_amount_usd"),
        "coupon": order.get("coupon", ""),
        "coupon_percent": order.get("coupon_percent", 0),
        # NOWPayments / crypto fields
        "payment_id": order.get("payment_id", ""),
        "pay_currency": order.get("pay_currency", ""),
        "pay_amount": order.get("pay_amount", ""),
        "amount_received": order.get("amount_received", 0),
        "pay_address": order.get("pay_address", ""),
        "network": order.get("network", ""),
        "tx_hash": order.get("tx_hash", ""),
        "invoice_expires_at": order.get("invoice_expires_at", ""),
        # reference / fulfillment
        "ref_name": order.get("ref_name", ""),
        "ref_email": order.get("ref_email", ""),
        "ref_username": order.get("ref_username", ""),
        "bot_name": order.get("bot_name", ""),
        "web_token": order.get("web_token", ""),
        "creation_step": order.get("creation_step", ""),
        "queued": bool(order.get("queued")),
        "created_at": order.get("created_at", ""),
        "paid_at": order.get("paid_at", ""),
        "bot_username": order.get("created_bot_username", ""),
        # Live Shop Bot invoice (still in temppay.json, not yet a real order) — admin
        # actions like sync/mark-paid/cancel don't apply until payment confirms.
        "is_temppay": bool(order.get("is_temppay")),
        # Paid session-replacement request surfaced from the replacement queue (read-only row).
        "is_replacement": bool(order.get("is_replacement")),
        "real_name": order.get("real_name", ""),
        "session_file": order.get("session_file", ""),
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
        "group_file": plan.get("group_file", ""),
        "free_replacements": plan.get("free_replacements", 0),
    }


def serialize_stats(stats: dict) -> dict:
    """Normalize stats for API display."""
    return {
        "lifetime_sent": stats.get("lifetime_sent", stats.get("total_posts_sent", 0)),
        "lifetime_failed": stats.get("lifetime_failed", stats.get("total_posts_failed", 0)),
        "last24h_sent": stats.get("last24h_sent", 0),
        "last24h_failed": stats.get("last24h_failed", 0),
        "cycles": stats.get("cycles", 0),
        "total_cycles": stats.get("total_cycles", 0),
        "created_at": stats.get("created_at", 0),
        "last_cycle_ts": stats.get("last_cycle_ts", 0),
        "last_cycle_session": stats.get("last_cycle_session", ""),
        "session_stats": stats.get("session_stats", stats.get("sessions", {})),
        # Time-series for the Performance chart. Hourly buckets cover the last 24h;
        # daily buckets accumulate long-term history for 7d/30d views.
        "last24h_buckets": stats.get("last24h_buckets", []),
        "daily_buckets": stats.get("daily_buckets", []),
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
