"""Dashboard endpoints: stats, alerts, health."""
import time
import psutil
from fastapi import APIRouter, Depends

from api.deps import get_current_admin, Pagination
from api.services import wrappers
from api.services.serializers import serialize_alert, paginate

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_admin)])


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

    orders_by_status = counts.get("orders_by_status") or {}
    completed = orders_by_status.get("completed", 0)
    pending = orders_by_status.get("pending_creation", 0) + orders_by_status.get("creating", 0) + orders_by_status.get("paid", 0)
    total_orders = sum(orders_by_status.values())

    from code.shop.storage import load_orders
    import asyncio
    all_orders = await asyncio.to_thread(load_orders)
    revenue = sum(float(o.get("price_usd") or 0) for o in all_orders if o.get("status") == "completed")

    cpu_percent = psutil.cpu_percent(interval=0.1)
    mem = psutil.virtual_memory()
    boot_time = psutil.boot_time()

    create_ok = counts.get("create_worker_ok", False)
    payment_ok = counts.get("payment_worker_ok", False)

    return {
        "bots": bot_states,
        "sessions": sessions,
        "orders": {
            "total": total_orders,
            "completed": completed,
            "pending": pending,
            "revenue_usd": round(revenue, 2),
        },
        "system": {
            "cpu_percent": cpu_percent,
            "memory_used_mb": round(mem.used / 1024 / 1024, 1),
            "memory_total_mb": round(mem.total / 1024 / 1024, 1),
            "memory_percent": mem.percent,
            "uptime_seconds": round(time.time() - boot_time),
        },
        "workers": {
            "create_worker_ok": create_ok,
            "payment_worker_ok": payment_ok,
        },
    }


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
