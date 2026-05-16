"""
AdBot user JSON configuration: schema, migration, and backward compatibility.

SCHEMA (target structure; legacy top-level keys are kept for compatibility):

{
  "name": "...",
  "bot_token": "...",
  "bot_username": "...",
  "valid_till": "DD/MM/YYYY",
  "cycle": 3600,
  "gap": 5,
  "mode": "Starter",
  "group_file": "Starter.txt",
  "log_group": "https://t.me/...",
  "log_file": "data/logs/<name>.log",
  "authorized": [],
  "sessions": [{"file": "...", "real_name": "...", "user_id": ..., "index": ...}],
  "state": "stopped" | "running" | "expired" | "dead",
  "last_cycle_time": {"<session_file>": "<iso_ts>"},
  "plan_name": "...",
  "plan_mode": "Starter",
  "session_count": 2,
  "renewal_price": "...",
  "last_renewal_at": "...",
  "last_renewal_days": 0,
  "renewal_history": [...],
  "excluded_sessions": [],

  "plan": {
    "name": "...",
    "mode": "Starter" | "Enterprise",
    "cycle": 3600,
    "gap": 5,
    "session_count": 2
  },
  "history": {
    "purchases": [{"order_id": "...", "date": "...", "plan": "...", "duration_days": ...}],
    "renewals": [{"at": "...", "days": ..., "order_id": "...", "source": "renewal"|"creation"}],
    "session_replacements": [{"at": "...", "old_session": "...", "new_session": "...", "reason": "...", "source": "..."}]
  },
  "stats": {
    "total_posts_success": 0,
    "total_posts_failed": 0,
    "total_data_used_mb": 0,
    "sessions": {
      "<session_file>": {"posts_success": 0, "posts_failed": 0, "data_used_mb": 0}
    }
  },
  "transactions": [
    {"order_id": "...", "tx_hash": "...", "amount": "...", "currency": "...", "date": "..."}
  ]
}

Canonical for plan-related fields: use "plan" object. Top-level "mode", "plan_mode", "cycle", "gap",
"session_count", "plan_name" are kept for backward compatibility and synced from "plan" when present.
"""
from __future__ import annotations

import copy
import logging
from typing import Any

from .config import MIN_CYCLE_SEC

logger = logging.getLogger(__name__)

# Keys that must not be overwritten by partial updates; only set when explicitly passed in the incoming dict.
PROTECTED_KEYS = ("history", "stats", "transactions")


def merge_for_save(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """
    Merge incoming into existing for save. Runtime/plan and other keys are taken from incoming.
    For PROTECTED_KEYS (history, stats, transactions): only overwrite when key is present in
    incoming and not None (explicitly passed); otherwise keep existing to prevent accidental wipe.
    """
    result = copy.deepcopy(existing)
    for k, v in incoming.items():
        if k in PROTECTED_KEYS:
            if v is not None:
                result[k] = copy.deepcopy(v) if isinstance(v, (dict, list)) else v
        else:
            result[k] = copy.deepcopy(v) if isinstance(v, (dict, list)) else v
    return result


def get_plan_mode(cfg: dict[str, Any]) -> str:
    """Canonical read for plan mode: plan.mode > mode > plan_mode. Default 'Starter'."""
    if not cfg:
        return "Starter"
    plan = cfg.get("plan") or {}
    if isinstance(plan, dict) and plan.get("mode"):
        return str(plan.get("mode", "Starter")).strip()
    return (cfg.get("mode") or cfg.get("plan_mode") or "Starter").strip()


def _default_stats() -> dict[str, Any]:
    """Default stats dict: lifetime + session_stats + recent_events (no permanent daily history)."""
    import time as _t
    return {
        "lifetime_sent": 0,
        "lifetime_failed": 0,
        "created_at": _t.time(),
        "session_stats": {},
        "recent_events": [],
    }


def migrate_user_config(data: dict[str, Any]) -> dict[str, Any]:
    """
    Idempotent migration: only initialize missing structures. Never overwrite existing
    history.*, stats.*, or transactions. Preserves all original keys. Call after load_user_data.
    """
    if not data or not isinstance(data, dict):
        return data
    out = copy.deepcopy(data)

    # --- plan (canonical): only setdefault, never overwrite existing ---
    if "plan" not in out or not isinstance(out.get("plan"), dict):
        out["plan"] = {}
    plan = out["plan"]
    plan.setdefault("name", (out.get("plan_name") or "").strip())
    mode_val = (out.get("mode") or out.get("plan_mode") or "Starter").strip()
    plan.setdefault("mode", mode_val)
    plan.setdefault("cycle", max(MIN_CYCLE_SEC, int(out.get("cycle", 3600))))
    plan.setdefault("gap", max(0, int(out.get("gap", 5))))
    plan.setdefault("session_count", max(1, int(out.get("session_count", 1))))

    # --- history: only initialize missing; never replace existing non-empty ---
    if "history" not in out or not isinstance(out.get("history"), dict):
        out["history"] = {"purchases": [], "renewals": [], "session_replacements": []}
    hist = out["history"]
    hist.setdefault("purchases", [])
    if not isinstance(hist.get("purchases"), list):
        hist["purchases"] = []
    hist.setdefault("renewals", [])
    if not hist["renewals"] and out.get("renewal_history"):
        hist["renewals"] = list(out.get("renewal_history") or [])
    hist.setdefault("session_replacements", [])
    if not hist["session_replacements"] and out.get("session_replacements"):
        hist["session_replacements"] = list(out.get("session_replacements") or [])

    # --- stats: new schema (lifetime + session_stats + recent_events). Migrate from old if present. ---
    if "stats" not in out or not isinstance(out.get("stats"), dict):
        out["stats"] = _default_stats()
    st = out["stats"]
    # Migrate legacy keys to new schema (idempotent)
    if "lifetime_sent" not in st and "total_sent" in st:
        import time as _t
        st["lifetime_sent"] = int(st.get("total_sent", 0))
        st["lifetime_failed"] = int(st.get("total_failed", 0))
        st["created_at"] = float(st["created_at"]) if isinstance(st.get("created_at"), (int, float)) else _t.time()
        by_session = st.get("by_session") or {}
        st["session_stats"] = {
            s: {"lifetime_sent": int((by_session.get(s) or {}).get("posts", 0)), "lifetime_failed": int((by_session.get(s) or {}).get("errors", 0))}
            for s in by_session
        }
        st["recent_events"] = []
    st.setdefault("lifetime_sent", 0)
    st.setdefault("lifetime_failed", 0)
    st.setdefault("created_at", 0.0)
    st.setdefault("session_stats", {})
    st.setdefault("recent_events", [])

    # --- transactions: only initialize if missing; never reset or rebuild ---
    if "transactions" not in out or not isinstance(out.get("transactions"), list):
        out["transactions"] = []

    return out


def ensure_legacy_compatibility(cfg: dict[str, Any]) -> None:
    """
    In-place: sync top-level legacy keys from plan/history so existing posting engine,
    admin flow, and creation flow keep working. Call before save_user_data.
    User changes to mode/cycle/gap (e.g. via /config or /mode, /cycle, /gap) are stored
    at top-level; we sync those into plan first so they are not overwritten by stale plan.
    """
    if not cfg or not isinstance(cfg, dict):
        return
    plan = cfg.get("plan")
    if not isinstance(plan, dict):
        plan = {}
        cfg["plan"] = plan
    # Sync top-level mode/cycle/gap into plan so /config and commands actually persist
    if cfg.get("mode") is not None:
        plan["mode"] = (cfg.get("mode") or "Starter").strip() or "Starter"
    if cfg.get("cycle") is not None:
        plan["cycle"] = max(MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
    if cfg.get("gap") is not None:
        plan["gap"] = max(0, int(cfg.get("gap", 5)))
    # Now sync plan -> top-level for legacy readers
    cfg["mode"] = plan.get("mode") or cfg.get("mode") or "Starter"
    cfg["plan_mode"] = plan.get("plan_mode") or plan.get("mode") or cfg.get("plan_mode") or "Starter"
    if "cycle" in plan:
        cfg["cycle"] = plan["cycle"]
    if "gap" in plan:
        cfg["gap"] = plan["gap"]
    if "session_count" in plan:
        cfg["session_count"] = plan["session_count"]
    if plan.get("name") is not None:
        cfg["plan_name"] = plan.get("name") or cfg.get("plan_name") or ""
    hist = cfg.get("history")
    if isinstance(hist, dict):
        leg_renewals = cfg.get("renewal_history") or []
        hist_renewals = hist.get("renewals") or []
        if isinstance(leg_renewals, list) and len(leg_renewals) > len(hist_renewals):
            seen = {(e.get("at"), e.get("order_id")) for e in hist_renewals}
            for e in leg_renewals:
                if isinstance(e, dict) and (e.get("at"), e.get("order_id")) not in seen:
                    hist_renewals.append(e)
                    seen.add((e.get("at"), e.get("order_id")))
            hist["renewals"] = hist_renewals[-500:]
        cfg["renewal_history"] = list(hist.get("renewals") or [])
        leg_sr = cfg.get("session_replacements") or []
        hist_sr = hist.get("session_replacements") or []
        if isinstance(leg_sr, list) and len(leg_sr) > len(hist_sr):
            seen = {(e.get("at"), e.get("old_session")) for e in hist_sr}
            for e in leg_sr:
                if isinstance(e, dict) and (e.get("at"), e.get("old_session")) not in seen:
                    hist_sr.append(e)
                    seen.add((e.get("at"), e.get("old_session")))
            hist["session_replacements"] = hist_sr[-100:]
        cfg["session_replacements"] = list(hist.get("session_replacements") or [])


def validate_user_config(cfg: dict[str, Any], *, for_new_bot: bool = False) -> list[str]:
    """
    Return list of validation errors (empty if valid).
    Always checks: plan.mode exists (or legacy mode), stats is dict, history is dict, transactions is list.
    for_new_bot=True: also require bot_token, name, valid_till.
    """
    errors: list[str] = []
    if not cfg or not isinstance(cfg, dict):
        return ["Config must be a non-empty dict"]
    plan = cfg.get("plan")
    if plan is not None and not isinstance(plan, dict):
        errors.append("plan must be a dict")
    elif isinstance(plan, dict) and not (plan.get("mode") or cfg.get("mode") or cfg.get("plan_mode")):
        errors.append("plan.mode (or legacy mode/plan_mode) must exist")
    if "stats" in cfg and not isinstance(cfg.get("stats"), dict):
        errors.append("stats must be a dict")
    if "history" in cfg and not isinstance(cfg.get("history"), dict):
        errors.append("history must be a dict")
    if "transactions" in cfg and not isinstance(cfg.get("transactions"), list):
        errors.append("transactions must be a list")
    if for_new_bot:
        if not (cfg.get("bot_token") or "").strip():
            errors.append("bot_token is required")
        if not (cfg.get("name") or "").strip():
            errors.append("name is required")
        if not (cfg.get("valid_till") or "").strip():
            errors.append("valid_till is required")
        has_plan = isinstance(plan, dict) and (plan.get("mode") or plan.get("session_count"))
        has_legacy = cfg.get("mode") or cfg.get("cycle") is not None or cfg.get("session_count") is not None
        if not has_plan and not has_legacy:
            errors.append("plan (or legacy mode/cycle/session_count) is required")
    if "sessions" in cfg and not isinstance(cfg["sessions"], list):
        errors.append("sessions must be a list")
    return errors


def build_plan_section(
    *,
    name: str = "",
    mode: str = "Starter",
    cycle: int = 3600,
    gap: int = 5,
    session_count: int = 1,
) -> dict[str, Any]:
    """Build a plan object for new bots (improved structure)."""
    return {
        "name": name,
        "mode": (mode or "Starter").strip(),
        "cycle": max(MIN_CYCLE_SEC, int(cycle)),
        "gap": max(0, int(gap)),
        "session_count": max(1, int(session_count)),
    }


def build_history_section() -> dict[str, Any]:
    """Build empty history section."""
    return {"purchases": [], "renewals": [], "session_replacements": []}


def build_stats_section() -> dict[str, Any]:
    """Build empty stats section. last_stats_update helps debug 'why stats not updating' (worker stopped)."""
    return {
        "total_posts_success": 0,
        "total_posts_failed": 0,
        "total_data_used_mb": 0,
        "sessions": {},
        "last_stats_update": "",
    }


def append_renewal_to_history(cfg: dict[str, Any], at: str, days: int, order_id: str, source: str = "renewal") -> None:
    """Append a renewal entry to history.renewals and legacy renewal_history. In-place."""
    hist = cfg.get("history")
    if not isinstance(hist, dict):
        cfg["history"] = {"purchases": [], "renewals": [], "session_replacements": []}
        hist = cfg["history"]
    hist.setdefault("renewals", [])
    entry = {"at": at, "days": days, "order_id": str(order_id), "source": source}
    hist["renewals"].append(entry)
    if len(hist["renewals"]) > 500:
        hist["renewals"] = hist["renewals"][-500:]
    cfg.setdefault("renewal_history", [])
    cfg["renewal_history"].append(entry)
    if len(cfg["renewal_history"]) > 500:
        cfg["renewal_history"] = cfg["renewal_history"][-500:]


def append_session_replacement_to_history(
    cfg: dict[str, Any],
    *,
    at: str,
    old_session: str,
    new_session: str | None = "",
    reason: str = "",
    source: str = "",
) -> None:
    """Append a session replacement to history.session_replacements and legacy session_replacements. In-place. new_session may be empty for dead-only replacements."""
    hist = cfg.get("history")
    if not isinstance(hist, dict):
        cfg["history"] = {"purchases": [], "renewals": [], "session_replacements": []}
        hist = cfg["history"]
    hist.setdefault("session_replacements", [])
    entry = {"at": at, "old_session": old_session, "new_session": str(new_session or ""), "reason": reason, "source": source}
    hist["session_replacements"].append(entry)
    if len(hist["session_replacements"]) > 100:
        hist["session_replacements"] = hist["session_replacements"][-100:]
    cfg.setdefault("session_replacements", [])
    cfg["session_replacements"].append(entry)
    if len(cfg["session_replacements"]) > 100:
        cfg["session_replacements"] = cfg["session_replacements"][-100:]


def append_transaction(
    cfg: dict[str, Any],
    *,
    order_id: str = "",
    tx_hash: str = "",
    amount: str = "",
    currency: str = "",
    date: str = "",
) -> bool:
    """
    Append a transaction to transactions list. In-place. Call when payment is confirmed.
    Returns True if appended, False if order_id already exists (idempotent for webhook retries).
    Never rebuild or reset the list; only append when order_id is new.
    """
    if "transactions" not in cfg or not isinstance(cfg.get("transactions"), list):
        cfg["transactions"] = []
    order_id_str = str(order_id or "").strip()
    if order_id_str and any(
        str(t.get("order_id") or "").strip() == order_id_str for t in cfg["transactions"] if isinstance(t, dict)
    ):
        return False
    cfg["transactions"].append({
        "order_id": order_id_str or order_id,
        "tx_hash": str(tx_hash or ""),
        "amount": str(amount or ""),
        "currency": str(currency or ""),
        "date": str(date or ""),
    })
    if len(cfg["transactions"]) > 200:
        cfg["transactions"] = cfg["transactions"][-200:]
    return True


def record_post_stats(
    cfg: dict[str, Any],
    *,
    session_file: str,
    success: bool,
    data_used_bytes: float = 0,
) -> None:
    """
    Update stats after a post attempt. In-place. Posting engine should call this to:
    - Increment total_posts_success or total_posts_failed
    - Update per-session stats in stats.sessions[session_file]
    - Add data_used_bytes to total_data_used_mb (converted to MB).
    """
    if "stats" not in cfg or not isinstance(cfg.get("stats"), dict):
        cfg["stats"] = {"total_posts_success": 0, "total_posts_failed": 0, "total_data_used_mb": 0, "sessions": {}, "last_stats_update": ""}
    st = cfg["stats"]
    st.setdefault("total_posts_success", 0)
    st.setdefault("total_posts_failed", 0)
    st.setdefault("total_data_used_mb", 0)
    st.setdefault("sessions", {})
    from datetime import datetime as _dt
    st["last_stats_update"] = _dt.utcnow().strftime("%Y-%m-%dT%H:%M:%S") + "Z"
    if success:
        st["total_posts_success"] = st["total_posts_success"] + 1
    else:
        st["total_posts_failed"] = st["total_posts_failed"] + 1
    if data_used_bytes > 0:
        st["total_data_used_mb"] = st["total_data_used_mb"] + (data_used_bytes / (1024 * 1024))
    sess = st["sessions"]
    if session_file not in sess or not isinstance(sess.get(session_file), dict):
        sess[session_file] = {"posts_success": 0, "posts_failed": 0, "data_used_mb": 0}
    if success:
        sess[session_file]["posts_success"] = sess[session_file].get("posts_success", 0) + 1
    else:
        sess[session_file]["posts_failed"] = sess[session_file].get("posts_failed", 0) + 1
    if data_used_bytes > 0:
        sess[session_file]["data_used_mb"] = sess[session_file].get("data_used_mb", 0) + (data_used_bytes / (1024 * 1024))
