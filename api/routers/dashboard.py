"""Dashboard endpoints: stats, alerts, health."""
import time
import json
from datetime import datetime, timezone
from pathlib import Path

import psutil
from fastapi import APIRouter, Depends, Query

from api.deps import get_current_admin, Pagination
from api.services import wrappers
from api.services.serializers import serialize_alert, paginate

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_admin)])


def _aggregate_all_bot_stats() -> dict:
    """Scan all stats files and aggregate posting data across all bots."""
    from code.config import DATA_STATS_DIR
    now = time.time()
    cutoff_24h = int((now - 86400) // 3600)

    total_sent = 0
    total_failed = 0
    today_sent = 0
    today_failed = 0
    hourly_buckets: dict[int, dict] = {}
    per_bot: list[dict] = []

    stats_dir = DATA_STATS_DIR
    if not stats_dir.exists():
        return {
            "total_sent": 0, "total_failed": 0,
            "today_sent": 0, "today_failed": 0,
            "hourly": [], "per_bot": [],
        }

    for f in stats_dir.glob("*.json"):
        try:
            raw = json.loads(f.read_bytes())
            if not isinstance(raw, dict):
                continue
        except Exception:
            continue

        bot_name = f.stem
        ls = int(raw.get("lifetime_sent", 0))
        lf = int(raw.get("lifetime_failed", 0))
        total_sent += ls
        total_failed += lf

        bot_24h_sent = 0
        bot_24h_failed = 0
        for bucket in (raw.get("last24h_buckets") or []):
            hour_ts = int(bucket.get("hour_ts", 0))
            sent = int(bucket.get("sent", 0))
            failed = int(bucket.get("failed", 0))
            if hour_ts >= cutoff_24h:
                today_sent += sent
                today_failed += failed
                bot_24h_sent += sent
                bot_24h_failed += failed
                if hour_ts not in hourly_buckets:
                    hourly_buckets[hour_ts] = {"hour_ts": hour_ts, "sent": 0, "failed": 0}
                hourly_buckets[hour_ts]["sent"] += sent
                hourly_buckets[hour_ts]["failed"] += failed

        per_bot.append({
            "name": bot_name,
            "lifetime_sent": ls,
            "lifetime_failed": lf,
            "today_sent": bot_24h_sent,
            "today_failed": bot_24h_failed,
        })

    sorted_hourly = sorted(hourly_buckets.values(), key=lambda x: x["hour_ts"])

    return {
        "total_sent": total_sent,
        "total_failed": total_failed,
        "today_sent": today_sent,
        "today_failed": today_failed,
        "hourly": sorted_hourly,
        "per_bot": per_bot,
    }


def _disk_and_logs() -> dict:
    """Disk usage for the drive the app lives on, plus total size of the per-bot log
    dir (those logs are append-only and never rotate, so they're the main fill risk)."""
    from code.config import BASE_DIR, DATA_LOGS_DIR
    out = {"disk_percent": None, "disk_used_gb": None, "disk_total_gb": None, "logs_size_mb": None}
    try:
        d = psutil.disk_usage(str(BASE_DIR))
        out["disk_percent"] = d.percent
        out["disk_used_gb"] = round(d.used / 1024 ** 3, 1)
        out["disk_total_gb"] = round(d.total / 1024 ** 3, 1)
    except Exception:
        pass
    try:
        total = 0
        for f in DATA_LOGS_DIR.glob("*.log"):
            try:
                total += f.stat().st_size
            except OSError:
                pass
        out["logs_size_mb"] = round(total / 1024 / 1024, 1)
    except Exception:
        pass
    return out


def _get_renewals_soon(bots: dict, days_ahead: int = 14) -> list:
    """Find bots with valid_till within the next N days."""
    now = datetime.now()
    renewals = []
    for name, cfg in bots.items():
        vt = cfg.get("valid_till")
        if not vt:
            continue
        try:
            exp_date = datetime.strptime(vt, "%d/%m/%Y")
        except (ValueError, TypeError):
            continue
        days_left = (exp_date - now).days
        if days_left <= days_ahead:
            renewals.append({
                "name": name,
                "valid_till": vt,
                "days_left": max(days_left, 0),
                "plan_name": cfg.get("plan_name", ""),
                "renewal_price": cfg.get("renewal_price", 0),
                "expired": days_left < 0,
            })
    renewals.sort(key=lambda x: x["days_left"])
    return renewals


@router.get("")
async def dashboard_stats():
    counts = await wrappers.dashboard_counts()
    data = await wrappers.load_adbot()
    pool = await wrappers.load_pool()

    bots = data.get("bots", {})
    bot_states = {"total": 0, "running": 0, "stopped": 0, "expired": 0, "dead": 0}
    for cfg in bots.values():
        bot_states["total"] += 1
        state = cfg.get("state", "stopped")
        if state in bot_states:
            bot_states[state] += 1

    free = len(pool.get("free_sessions", []))
    dead = len(pool.get("dead_sessions", []))
    frozen = len(pool.get("frozen_sessions", []))
    limited = len(pool.get("limited_sessions", []))
    unauth = len(pool.get("unauth_sessions", []))
    assigned = sum(len(cfg.get("sessions", [])) for cfg in bots.values())

    sessions = {
        "assigned": assigned,
        "free": free,
        "dead": dead,
        "frozen": frozen,
        "limited": limited,
        "unauth": unauth,
        "total": assigned + free + dead + frozen + limited + unauth,
    }

    # Orders & Revenue (fix: use amount_usd not price_usd)
    from code.shop.storage import load_orders
    import asyncio
    all_orders = await asyncio.to_thread(load_orders)
    orders_by_status = counts.get("orders_by_status") or {}
    completed = orders_by_status.get("completed", 0)
    pending = orders_by_status.get("pending_creation", 0) + orders_by_status.get("creating", 0) + orders_by_status.get("paid", 0)
    total_orders = sum(orders_by_status.values())
    revenue = sum(float(o.get("amount_usd") or 0) for o in all_orders if o.get("status") == "completed")

    # Revenue split: today / this month (by paid_at) + value sitting in pending orders.
    _now = datetime.now(timezone.utc)
    _today0 = _now.replace(hour=0, minute=0, second=0, microsecond=0)
    _month0 = _today0.replace(day=1)

    def _parse_iso(s: str):
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "").split(".")[0]).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return None

    _pending_states = {"payment_waiting", "confirming", "paid", "pending_creation", "creating"}
    revenue_today = revenue_month = pending_value = 0.0
    for o in all_orders:
        amt = float(o.get("amount_usd") or 0)
        st = o.get("status")
        if st == "completed":
            t = _parse_iso(o.get("paid_at") or o.get("created_at"))
            if t is not None:
                if t >= _today0:
                    revenue_today += amt
                if t >= _month0:
                    revenue_month += amt
        elif st in _pending_states:
            pending_value += amt

    # Recent orders (last 10)
    sorted_orders = sorted(all_orders, key=lambda o: o.get("created_at", ""), reverse=True)
    recent_orders = []
    for o in sorted_orders[:10]:
        recent_orders.append({
            "order_id": o.get("order_id", ""),
            "user_id": o.get("user_id"),
            "status": o.get("status", ""),
            "order_type": o.get("order_type", ""),
            "plan_name": o.get("plan_name", ""),
            "amount_usd": float(o.get("amount_usd") or 0),
            "created_at": o.get("created_at", ""),
            "paid_at": o.get("paid_at", ""),
        })

    # System
    cpu_percent = psutil.cpu_percent(interval=0.1)
    mem = psutil.virtual_memory()
    boot_time = psutil.boot_time()

    # Workers
    create_ok = counts.get("create_worker_ok", False)
    payment_ok = counts.get("payment_worker_ok", False)

    # Posting stats (aggregate from all bot stats files)
    posting = await asyncio.to_thread(_aggregate_all_bot_stats)

    # Disk + log-dir size (fill risk: per-bot logs never rotate)
    disk_info = await asyncio.to_thread(_disk_and_logs)

    # Renewals coming soon
    renewals_soon = _get_renewals_soon(bots)

    # Top failing bots (sorted by 24h failure rate)
    top_failing = sorted(
        [b for b in posting["per_bot"] if b["today_failed"] > 0],
        key=lambda x: x["today_failed"],
        reverse=True,
    )[:10]

    return {
        "bots": bot_states,
        "sessions": sessions,
        "orders": {
            "total": total_orders,
            "completed": completed,
            "pending": pending,
            "revenue_usd": round(revenue, 2),
            "revenue_today": round(revenue_today, 2),
            "revenue_month": round(revenue_month, 2),
            "pending_value": round(pending_value, 2),
        },
        "system": {
            "cpu_percent": cpu_percent,
            "memory_used_mb": round(mem.used / 1024 / 1024, 1),
            "memory_total_mb": round(mem.total / 1024 / 1024, 1),
            "memory_percent": mem.percent,
            "uptime_seconds": round(time.time() - boot_time),
            "disk_percent": disk_info["disk_percent"],
            "disk_used_gb": disk_info["disk_used_gb"],
            "disk_total_gb": disk_info["disk_total_gb"],
            "logs_size_mb": disk_info["logs_size_mb"],
        },
        "workers": {
            "create_worker_ok": create_ok,
            "payment_worker_ok": payment_ok,
        },
        "posting": {
            "total_sent": posting["total_sent"],
            "total_failed": posting["total_failed"],
            "today_sent": posting["today_sent"],
            "today_failed": posting["today_failed"],
            "hourly": posting["hourly"],
        },
        "renewals_soon": renewals_soon,
        "top_failing": top_failing,
        "recent_orders": recent_orders,
    }


@router.get("/analytics")
async def dashboard_analytics(
    start: float = Query(..., description="Range start, unix seconds"),
    end: float = Query(..., description="Range end, unix seconds"),
):
    """All-bots posting analytics over a custom time range, parsed from the durable
    per-bot log files. Returns a bucketed sent/failed series plus totals and a
    per-bot breakdown for the window."""
    import asyncio
    from api.services.log_stats import compute_range_analytics

    now = time.time()
    # Validate / clamp the window so a bad or huge request can't hammer the log parser.
    if end > now:
        end = now
    if start >= end:
        start = end - 86400
    max_span = 366 * 86400  # 1 year
    if end - start > max_span:
        start = end - max_span

    # load_adbot() keys bots by bot_token, but log files are named by display name
    # (data/logs/<name>.log). Resolve names, deduped by their sanitized filename so
    # two configs that map to the same log aren't double-counted.
    from code.utils import name_to_filename
    data = await wrappers.load_adbot()
    bots = data.get("bots") or {}
    seen: set[str] = set()
    bot_names: list[str] = []
    for cfg in bots.values():
        nm = (cfg.get("name") or "").strip()
        if not nm:
            continue
        key = name_to_filename(nm)
        if key in seen:
            continue
        seen.add(key)
        bot_names.append(nm)
    return await asyncio.to_thread(compute_range_analytics, bot_names, start, end)


@router.get("/alerts")
async def get_alerts(pagination: Pagination = Depends()):
    pool = await wrappers.load_pool()
    alerts = pool.get("admin_alerts", [])
    alerts_sorted = sorted(alerts, key=lambda a: a.get("ts", 0), reverse=True)
    serialized = [serialize_alert(a) for a in alerts_sorted]
    return paginate(serialized, pagination.page, pagination.per_page)


@router.post("/alerts/clear")
async def clear_alerts():
    pool = await wrappers.load_pool()
    count = len(pool.get("admin_alerts", []))
    pool["admin_alerts"] = []
    await wrappers.save_pool(pool)
    return {"cleared": count}


@router.get("/health")
async def system_health():
    cpu_percent = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/") if hasattr(psutil, "disk_usage") else None
    boot_time = psutil.boot_time()

    return {
        "cpu_percent": cpu_percent,
        "cpu_count": psutil.cpu_count(),
        "memory": {
            "used_mb": round(mem.used / 1024 / 1024, 1),
            "total_mb": round(mem.total / 1024 / 1024, 1),
            "percent": mem.percent,
        },
        "disk": {
            "used_gb": round(disk.used / 1024 / 1024 / 1024, 2) if disk else None,
            "total_gb": round(disk.total / 1024 / 1024 / 1024, 2) if disk else None,
            "percent": disk.percent if disk else None,
        },
        "uptime_hours": round((time.time() - boot_time) / 3600, 1),
        "process_count": len(psutil.pids()),
    }
