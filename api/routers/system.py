"""System control endpoints: emergency, maintenance, workers, plans."""
import asyncio
import time
import json
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_current_admin
from api.services import wrappers
from api.services.serializers import serialize_plan
from api.services.events import emit_dashboard_event
from api.schemas import SystemActionResponse

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(get_current_admin)])


@router.post("/emergency-stop", response_model=SystemActionResponse)
async def emergency_stop():
    count, msg = await wrappers.emergency_stop(admin_id=0)
    emit_dashboard_event("emergency_stop", {"count": count})
    await wrappers.log_admin_action("web_admin", "emergency_stop")
    return SystemActionResponse(status="stopped", message=msg)


@router.post("/emergency-resume", response_model=SystemActionResponse)
async def emergency_resume():
    count, msg = await wrappers.emergency_resume(admin_id=0)
    emit_dashboard_event("emergency_resume", {"count": count})
    await wrappers.log_admin_action("web_admin", "emergency_resume")
    return SystemActionResponse(status="resumed", message=msg)


@router.get("/maintenance")
async def get_maintenance_status():
    enabled = await wrappers.is_maintenance_enabled()
    return {"maintenance_enabled": enabled}


@router.post("/maintenance", response_model=SystemActionResponse)
async def toggle_maintenance(enabled: bool):
    await wrappers.set_maintenance(enabled)
    emit_dashboard_event("maintenance_toggled", {"enabled": enabled})
    await wrappers.log_admin_action("web_admin", "maintenance", target=str(enabled))
    return SystemActionResponse(
        status="enabled" if enabled else "disabled",
        message=f"Maintenance mode {'enabled' if enabled else 'disabled'}",
    )


@router.get("/workers")
async def worker_status():
    from code.config import DATA_DIR

    result = {}
    for name in ("payment_worker_heartbeat", "create_worker_heartbeat"):
        path = DATA_DIR / f"{name}.json"
        if path.is_file():
            try:
                data = json.loads(await asyncio.to_thread(path.read_text, "utf-8"))
                ts = float(data.get("ts", 0))
                result[name] = {
                    "last_heartbeat": ts,
                    "age_sec": round(time.time() - ts, 1),
                    "healthy": (time.time() - ts) < 900,
                }
            except Exception:
                result[name] = {"last_heartbeat": 0, "age_sec": -1, "healthy": False}
        else:
            result[name] = {"last_heartbeat": 0, "age_sec": -1, "healthy": False}

    return result


@router.get("/plans")
async def get_plans():
    plans = await wrappers.load_plans()
    result = {}
    for mode, plan_list in plans.items():
        result[mode] = [serialize_plan(p) for p in plan_list]
    return result


@router.put("/plans")
async def update_plans(plans: dict):
    from code.shop.storage import save_plans
    await asyncio.to_thread(save_plans, plans)
    await wrappers.log_admin_action("web_admin", "update_plans")
    return {"status": "updated"}


ADMIN_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "admin_settings.json"


def _load_admin_settings() -> dict:
    if ADMIN_SETTINGS_FILE.is_file():
        try:
            return json.loads(ADMIN_SETTINGS_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {}


def _save_admin_settings(settings: dict) -> None:
    ADMIN_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ADMIN_SETTINGS_FILE.write_text(json.dumps(settings, indent=2), "utf-8")


@router.get("/admin-settings")
async def get_admin_settings():
    settings = await asyncio.to_thread(_load_admin_settings)
    return {
        "chatlist_links": settings.get("chatlist_links", {
            "starter": ["", ""],
            "enterprise": ["", ""],
        }),
        "session_replacement_price": settings.get("session_replacement_price", 2.0),
    }


@router.put("/admin-settings")
async def update_admin_settings(body: dict):
    settings = await asyncio.to_thread(_load_admin_settings)

    if "chatlist_links" in body:
        cl = body["chatlist_links"]
        # Validate: each mode has up to 2 links
        for mode in ("starter", "enterprise"):
            links = cl.get(mode, [])
            if not isinstance(links, list):
                links = [str(links)]
            # Clean: strip, limit to 2
            cl[mode] = [str(l).strip() for l in links[:2]]
        settings["chatlist_links"] = cl

        # Also update config module at runtime so creation pipeline picks up new values
        try:
            from code import config
            starter_links = cl.get("starter", ["", ""])
            enterprise_links = cl.get("enterprise", ["", ""])
            config.DEFAULT_CHATLIST_STARTER = starter_links[0] if starter_links else ""
            config.DEFAULT_CHATLIST_ENTERPRISE = enterprise_links[0] if enterprise_links else ""
        except Exception:
            pass

    if "session_replacement_price" in body:
        try:
            settings["session_replacement_price"] = float(body["session_replacement_price"])
        except (ValueError, TypeError):
            pass

    await asyncio.to_thread(_save_admin_settings, settings)
    await wrappers.log_admin_action("web_admin", "update_admin_settings")
    return {"status": "updated"}


# ── Replacement Queue ──

@router.get("/replacements")
async def get_replacement_queue():
    from code.replacement import load_replacement_queue
    queue = await asyncio.to_thread(load_replacement_queue)
    active = [e for e in queue if e.get("status") not in ("completed", "cancelled")]
    # Unpaid replacements are NOT actionable work — they wait for the buyer to pay.
    # Keep them out of the actionable queue so admins don't swap sessions before payment.
    awaiting_payment = [e for e in active if e.get("status") == "pending_payment"]
    actionable = [e for e in active if e.get("status") != "pending_payment"]
    completed = [e for e in queue if e.get("status") == "completed"]
    awaiting = [e for e in queue if e.get("status") == "awaiting_session"]
    return {
        "queue": actionable,
        "awaiting_payment": awaiting_payment,
        "awaiting_sessions": awaiting,
        "completed_recent": completed[-20:],
        "total_pending": len(actionable),
        "total_awaiting_payment": len(awaiting_payment),
        "total_awaiting": len(awaiting),
    }


@router.post("/replacements/process")
async def process_replacement_queue():
    from code.replacement import process_queue_by_admin
    result = await process_queue_by_admin()
    await wrappers.log_admin_action("web_admin", "process_replacement_queue")
    return result


@router.post("/replacements/{entry_id}/cancel")
async def cancel_replacement_entry(entry_id: str):
    from code.replacement import cancel_replacement
    ok = cancel_replacement(entry_id)
    if not ok:
        raise HTTPException(404, "Replacement entry not found")
    return {"status": "cancelled"}


@router.get("/audit")
async def get_audit_log(limit: int = 100):
    from code.config import DATA_DIR
    audit_path = DATA_DIR / "admin_audit.json"
    if not audit_path.is_file():
        return {"entries": [], "total": 0}

    try:
        data = json.loads(await asyncio.to_thread(audit_path.read_text, "utf-8"))
        entries = data.get("entries", [])
        entries.sort(key=lambda e: e.get("ts", ""), reverse=True)
        return {"entries": entries[:limit], "total": len(entries)}
    except Exception:
        return {"entries": [], "total": 0}
