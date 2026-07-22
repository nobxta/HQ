"""Session management endpoints.

Global (pool-level) session operations for the admin Sessions console: aggregated
overview, upload, validate, SpamBot check, move, delete and starring.

Safety model (see the admin Sessions audit):
  * Every pool read-modify-write runs inside ``code.utils.SESSION_POOL_LOCK`` via a
    small sync helper dispatched through ``asyncio.to_thread`` so it never freezes the
    event loop and never races the creation/replacement/runtime consumers.
  * Session file paths are always resolved with ``config.resolve_session_path`` so
    user-uploaded sessions stored under ``users/<uid>/...`` are handled correctly.
  * Sessions that are currently ASSIGNED to a bot are never mutated (moved, deleted,
    or force-validated) through the global endpoints — those must go through the
    bot-scoped endpoints in ``api/routers/bots.py``. The global endpoints reject or
    skip assigned sessions instead of orphaning a bot's ``cfg["sessions"]`` reference.
  * Validation reuses the canonical ``code.utils.validate_session_with_reason`` guarded
    validator (cross-process session lock aware) rather than duplicating the logic.
"""
import asyncio
import shutil
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query

from api.deps import get_current_admin
from api.services import wrappers
from api.services.serializers import serialize_session
from api.services.events import emit_dashboard_event

router = APIRouter(prefix="/api/sessions", tags=["sessions"], dependencies=[Depends(get_current_admin)])


# ─────────────────────────── shared helpers ───────────────────────────

# Pool bucket key -> filesystem directory (lazy: config paths need import-time init).
def _bucket_dir(bucket: str) -> Path:
    from code import config
    return {
        "free": config.SESSIONS_ACTIVE,
        "dead": config.SESSIONS_DEAD,
        "frozen": config.SESSIONS_FROZEN,
        "limited": config.SESSIONS_LIMITED,
        "unauth": config.SESSIONS_UNAUTH,
    }.get(bucket, config.SESSIONS_ACTIVE)


_BUCKET_KEYS = {
    "free": "free_sessions",
    "dead": "dead_sessions",
    "frozen": "frozen_sessions",
    "limited": "limited_sessions",
    "unauth": "unauth_sessions",
}


def _digits_from_file(fn: str) -> str | None:
    digits = "".join(ch for ch in fn.replace(".session", "") if ch.isdigit())
    return digits or None


def _build_assignment_map() -> dict[str, dict]:
    """{session_file: {bot_name, bot_token, state, running, plan_name, disabled}} for every
    session currently attached to a bot. Loads adbot.json once (sync)."""
    from code.utils import load_adbot
    adbot = load_adbot()
    out: dict[str, dict] = {}
    for token, cfg in adbot.get("bots", {}).items():
        name = cfg.get("name") or token[:15]
        state = cfg.get("state", "stopped")
        running = state in ("running", "activating")
        disabled = {(f or "").strip() for f in (cfg.get("disabled_sessions") or []) if f}
        for s in cfg.get("sessions", []):
            fn = (s.get("file") or "").strip()
            if fn:
                out[fn] = {
                    "bot_name": name,
                    "bot_token": token,
                    "state": state,
                    "running": running,
                    "plan_name": cfg.get("plan_name", "") or (cfg.get("plan", {}) or {}).get("name", ""),
                    "disabled": fn in disabled,
                }
    return out


async def _assignment_map() -> dict[str, dict]:
    return await asyncio.to_thread(_build_assignment_map)


def _assigned_conflict(fn: str, amap: dict[str, dict]) -> dict | None:
    """Return a structured 409-style payload if ``fn`` is assigned, else None."""
    info = amap.get(fn)
    if not info:
        return None
    return {
        "code": "assigned",
        "message": f"'{fn}' is assigned to '{info['bot_name']}'. Unassign it first.",
        "bot_name": info["bot_name"],
        "bot_running": info["running"],
    }


# ─────────────────────────── read endpoints ───────────────────────────

@router.get("")
async def list_sessions(
    status: str = Query(None, description="Filter by bucket status"),
    bot_name: str = Query(None, description="Filter by assigned bot"),
):
    """Legacy flat list (kept for backward compatibility). Prefer /overview."""
    sessions = await wrappers.session_full_list()
    results = []
    for s in sessions:
        if status and s.get("status") != status and s.get("bucket") != status:
            continue
        if bot_name and s.get("bot_name") != bot_name:
            continue
        results.append(serialize_session(s))
    return {"sessions": results, "total": len(results)}


@router.get("/map")
async def session_bot_map():
    from code.admin_control import session_to_bot_map as _map
    mapping = await asyncio.to_thread(_map)
    return {"map": [{"file": f, "bot_name": b} for f, b in mapping]}


@router.get("/pool")
async def pool_overview():
    pool = await wrappers.load_pool()
    return {
        "free": len(pool.get("free_sessions", [])),
        "dead": len(pool.get("dead_sessions", [])),
        "frozen": len(pool.get("frozen_sessions", [])),
        "limited": len(pool.get("limited_sessions", [])),
        "unauth": len(pool.get("unauth_sessions", [])),
        "free_list": pool.get("free_sessions", []),
        "dead_list": pool.get("dead_sessions", []),
    }


# Time-range keys accepted by /overview → activity window length in seconds. None = lifetime.
_RANGE_SECONDS: dict[str, int | None] = {
    "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * 86400, "all": None,
}


def _health_from(pool: str, validation_status: str | None, spam_status: str | None = None) -> str:
    """Map (pool bucket, persisted validation, persisted SpamBot flag) to a single health
    class. Assignment is NOT health; the free pool alone is NOT health.

    Assigned sessions never live in a pool bucket, so their health comes entirely from
    persisted signals on the assignment entry: a failed validation (banned/logged out)
    always wins as "dead"; otherwise a SpamBot flag from the bot-scoped check surfaces
    as "limited"/"frozen" without ever moving the session's file or bucket.
    """
    if pool == "dead":
        return "dead"
    if pool == "frozen":
        return "frozen"
    if pool == "limited":
        return "limited"
    if pool == "unauth":
        return "unauthorized"
    vs = (validation_status or "").lower()
    if vs == "invalid":
        return "dead"
    # SpamBot / validation statuses arrive raw (ACTIVE / TEMP_LIMITED / HARD_LIMITED / FROZEN /
    # UNAUTHORIZED / DEAD) — match by substring so admin + portal agree on the state.
    ss = (spam_status or "").lower()
    if "frozen" in ss:
        return "frozen"
    if "unauthorized" in ss:
        return "unauthorized"
    if "limited" in ss:
        return "limited"
    if ss == "dead":
        return "dead"
    if vs in ("valid", "active"):
        return "healthy"
    return "unknown"


def _build_overview(range_key: str) -> dict:
    """Aggregate the full session inventory in one pass (sync — file + log I/O).

    Merges: pool buckets, bot assignment + persisted validation, admin disable flags,
    posting activity parsed from the durable logs, and per-session cycle stats. No live
    Telethon and no secrets. Reuses ``_derive_session_status`` from the bots router so
    runtime status is derived in exactly one place.
    """
    from code import config
    from code.utils import load_pool, load_adbot
    from api.routers.bots import _derive_session_status
    from api.services.log_stats import compute_session_activity

    window = _RANGE_SECONDS.get(range_key, 24 * 3600)
    now = time.time()
    since_ts = 0.0 if window is None else (now - window)

    pool = load_pool()
    adbot = load_adbot()
    starred = set(pool.get("starred_sessions", []) or [])
    # Per-session identity/health cache — read once here; NEVER open a session on this path.
    session_meta_all = pool.get("session_meta") or {}

    sessions: list[dict] = []

    def _emit(fn: str, *, pool_bucket: str, entry: dict | None,
              assign: dict | None, activity: dict, stats: dict) -> dict:
        entry = entry or {}
        meta = session_meta_all.get(fn) or {}
        act = activity.get(fn) or {}
        sstat = stats.get(fn) or {}
        disabled = bool(assign["disabled"]) if assign else False
        # Cache is the source of truth for identity/health; fall back to the legacy cfg entry
        # (assigned sessions only) so nothing regresses before the cache is first populated.
        validation_status = meta.get("validation_status") or (entry.get("validation_status") if assign else None)
        pause_until = 0.0
        cooldown_until = 0.0
        if assign:
            bcfg = adbot.get("bots", {}).get(assign["bot_token"], {})
            pause_until = float((bcfg.get("session_pause_until") or {}).get(fn, 0) or 0)
            cooldown_until = float((bcfg.get("session_cooldown_until") or {}).get(fn, 0) or 0)

        if assign:
            derived = _derive_session_status(
                fn,
                disabled=disabled,
                validation_status=("invalid" if validation_status == "invalid" else "unknown"),
                bot_running=assign["running"],
                pause_until={fn: pause_until},
                cooldown_until={fn: cooldown_until},
                now=now,
            )
        else:
            derived = {"free": "ready"}.get(pool_bucket, {
                "dead": "dead", "frozen": "frozen",
                "limited": "limited", "unauth": "unauthorized",
            }.get(pool_bucket, "unknown"))

        pool_label = "assigned" if assign else pool_bucket
        spam_status = meta.get("spam_status") or (entry.get("spam_status") if assign else None)
        health = _health_from(pool_bucket if not assign else "assigned", validation_status, spam_status)
        # Resolve real file presence (assigned-but-missing is an attention state).
        path = config.resolve_session_path(fn)
        file_present = path.is_file()

        attention = (
            health in ("dead", "frozen", "limited", "unauthorized")
            or validation_status == "invalid"
            or (assign is not None and not file_present)
        )
        attention_reason = None
        if assign is not None and not file_present:
            attention_reason = "assigned_missing_file"
        elif health != "healthy" and health != "unknown":
            attention_reason = health
        elif validation_status == "invalid":
            attention_reason = "failed_validation"

        if window is None:
            sent = int(sstat.get("lifetime_sent", 0)) or int(act.get("sent", 0))
            failed = int(sstat.get("lifetime_failed", 0)) or int(act.get("failed", 0))
        else:
            sent = int(act.get("sent", 0))
            failed = int(act.get("failed", 0))
        flood = int(act.get("flood", 0))
        total = sent + failed
        success_rate = round(sent / total * 100, 1) if total else None
        last_active = max(
            float(act.get("last_active_ts", 0) or 0),
            float(sstat.get("last_cycle_ts", 0) or 0),
        ) or None

        pause_remaining = None
        pause_at = max(pause_until, cooldown_until)
        if pause_at > now:
            pause_remaining = int(pause_at - now)

        # resolved_path_type describes where the file physically lives (never the path).
        if fn.startswith("users/"):
            rpt = "user"
        elif pool_bucket in ("dead", "frozen", "limited", "unauth"):
            rpt = pool_bucket
        else:
            rpt = "active"

        return {
            "filename": fn,
            "resolved_path_type": rpt,
            "file_present": file_present,
            "pool": pool_label,
            "starred": fn in starred,

            # Identity — from the per-session cache (populated on any real touchpoint), with a
            # legacy cfg fallback for assigned sessions. Phone is the VERIFIED number or null —
            # never guessed from the filename.
            "full_name": (meta.get("full_name") or (entry.get("real_name") if assign else None) or None),
            "real_name": (meta.get("full_name") or (entry.get("real_name") if assign else None) or None),
            "user_id": (meta.get("user_id") if meta.get("user_id") is not None else (entry.get("user_id") if assign else None)) or None,
            "username": meta.get("username") or None,
            "phone": meta.get("phone") or None,
            "bio": meta.get("bio") or None,
            "premium": bool(meta.get("premium")) if meta else False,
            "restricted": bool(meta.get("restricted")) if meta else False,
            "authorized": meta.get("authorized") if meta else None,

            "bot_name": assign["bot_name"] if assign else None,
            "bot_state": assign["state"] if assign else None,
            "bot_plan": (assign["plan_name"] or None) if assign else None,
            "disabled": disabled,

            "health": health,
            "validation_status": validation_status or None,
            "validation_reason": (meta.get("validation_reason") or (entry.get("validation_reason") if assign else None) or None),
            "last_validated_at": (meta.get("last_checked") or (entry.get("last_validated_at") if assign else None) or None),
            "last_checked": meta.get("last_checked") or None,
            "spam_status": spam_status or None,
            "last_spambot_check_at": (entry.get("last_spambot_check_at") or None) if assign else None,
            "last_released_from": meta.get("last_released_from") or None,
            "last_released_at": meta.get("last_released_at") or None,

            "derived_status": derived,
            "pause_until": (pause_at or None) if pause_at > now else None,
            "pause_remaining_sec": pause_remaining,

            "attention": attention,
            "attention_reason": attention_reason,

            "sent": sent,
            "failed": failed,
            "flood": flood,
            "success_rate": success_rate,
            "last_active_at": last_active,
            "last_error": act.get("last_error") or None,
            "last_error_at": (act.get("last_error_ts") or None) if act.get("last_error") else None,
            "last_cycle_ts": float(sstat.get("last_cycle_ts", 0) or 0) or None,
        }

    # ── assigned sessions (grouped by bot so logs/stats are read once per bot) ──
    assigned_files: set[str] = set()
    for token, cfg in adbot.get("bots", {}).items():
        name = cfg.get("name") or token[:15]
        state = cfg.get("state", "stopped")
        running = state in ("running", "activating")
        disabled_set = {(f or "").strip() for f in (cfg.get("disabled_sessions") or []) if f}
        plan_name = cfg.get("plan_name", "") or (cfg.get("plan", {}) or {}).get("name", "")
        cfg_sessions = cfg.get("sessions") or []
        if not cfg_sessions:
            continue
        try:
            activity = compute_session_activity(name, since_ts)
        except Exception:
            activity = {}
        # Per-session cycle stats live on the durable stats file via the users module.
        stats: dict = {}
        try:
            from code.users import _get_stats_for_display
            stats = (_get_stats_for_display(token) or {}).get("session_stats") or {}
        except Exception:
            stats = {}
        for s in cfg_sessions:
            fn = (s.get("file") or "").strip()
            if not fn:
                continue
            assigned_files.add(fn)
            assign = {
                "bot_name": name, "bot_token": token, "state": state,
                "running": running, "plan_name": plan_name, "disabled": fn in disabled_set,
            }
            sessions.append(_emit(fn, pool_bucket="assigned", entry=s, assign=assign,
                                  activity=activity, stats=stats))

    # ── unassigned pool sessions ──
    for bucket in ("free", "dead", "frozen", "limited", "unauth"):
        for fn in pool.get(_BUCKET_KEYS[bucket], []) or []:
            fn = (fn or "").strip()
            if not fn or fn in assigned_files:
                continue
            sessions.append(_emit(fn, pool_bucket=bucket, entry=None, assign=None,
                                  activity={}, stats={}))

    # ── summary ──
    summary = {
        "total": len(sessions),
        "ready": sum(1 for s in sessions if s["pool"] == "free"),
        "assigned": sum(1 for s in sessions if s["bot_name"]),
        "enabled": sum(1 for s in sessions if s["bot_name"] and not s["disabled"]),
        "disabled": sum(1 for s in sessions if s["bot_name"] and s["disabled"]),
        "needs_attention": sum(1 for s in sessions if s["attention"]),
        "dead": sum(1 for s in sessions if s["health"] == "dead"),
        "frozen": sum(1 for s in sessions if s["health"] == "frozen"),
        "limited": sum(1 for s in sessions if s["health"] == "limited"),
        "unauthorized": sum(1 for s in sessions if s["health"] == "unauthorized"),
        "healthy": sum(1 for s in sessions if s["health"] == "healthy"),
        "unknown": sum(1 for s in sessions if s["health"] == "unknown"),
        "starred": sum(1 for s in sessions if s["starred"]),
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "range": range_key if range_key in _RANGE_SECONDS else "24h",
        "summary": summary,
        "sessions": sessions,
    }


@router.get("/overview")
async def sessions_overview(range: str = Query("24h")):
    """Single aggregated read for the admin Sessions console (avoids N+1 per-bot calls)."""
    range_key = range if range in _RANGE_SECONDS else "24h"
    return await asyncio.to_thread(_build_overview, range_key)


# ─────────────────────────── starring ───────────────────────────

@router.get("/starred")
async def get_starred():
    pool = await wrappers.load_pool()
    return {"starred": pool.get("starred_sessions", [])}


def _toggle_star(filename: str, on: bool) -> bool:
    from code.utils import SESSION_POOL_LOCK, load_pool, save_pool
    with SESSION_POOL_LOCK:
        pool = load_pool()
        starred = pool.setdefault("starred_sessions", [])
        if on and filename not in starred:
            starred.append(filename)
            save_pool(pool)
        elif not on and filename in starred:
            starred.remove(filename)
            save_pool(pool)
        return on


@router.post("/{filename}/star")
async def star_session(filename: str):
    await asyncio.to_thread(_toggle_star, filename, True)
    return {"starred": True, "filename": filename}


@router.delete("/{filename}/star")
async def unstar_session(filename: str):
    await asyncio.to_thread(_toggle_star, filename, False)
    return {"starred": False, "filename": filename}


# ─────────────────────────── upload ───────────────────────────

def _upload_commit(added: list[str]) -> None:
    """Append newly-saved active-pool session filenames to free_sessions under lock."""
    from code.utils import SESSION_POOL_LOCK, load_pool, save_pool
    with SESSION_POOL_LOCK:
        pool = load_pool()
        free = pool.setdefault("free_sessions", [])
        for fn in added:
            if fn not in free:
                free.append(fn)
        save_pool(pool)


def _known_names() -> set[str]:
    from code.utils import load_pool
    pool = load_pool()
    known = set()
    for b in ("free_sessions", "dead_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
        known.update(pool.get(b, []) or [])
    # also treat assigned files as known (dedup)
    known.update(_build_assignment_map().keys())
    return known


@router.post("/upload")
async def upload_sessions(files: list[UploadFile] = File(...)):
    """Upload `.session` files or `.zip` archives into the ready (free) pool.

    Duplicate detection is by filename only (honest — no user-id/hash dedup here).
    Writes are committed to the pool under the shared lock.
    """
    from code.config import SESSIONS_ACTIVE

    known = await asyncio.to_thread(_known_names)
    added: list[str] = []
    duplicates: list[str] = []
    invalid: list[str] = []
    errors: list[dict] = []
    extracted = 0

    for upload_file in files:
        filename = upload_file.filename or "unknown.session"

        if filename.endswith(".zip"):
            with tempfile.TemporaryDirectory() as tmp_dir:
                zip_path = Path(tmp_dir) / Path(filename).name
                content = await upload_file.read()
                await asyncio.to_thread(zip_path.write_bytes, content)
                try:
                    with zipfile.ZipFile(zip_path, "r") as zf:
                        for member in zf.namelist():
                            if not member.endswith(".session") or member.startswith("__"):
                                continue
                            member_name = Path(member).name
                            extracted += 1
                            if member_name in known or (SESSIONS_ACTIVE / member_name).exists():
                                duplicates.append(member_name)
                                continue
                            ex = zf.extract(member, tmp_dir)
                            dest = SESSIONS_ACTIVE / member_name
                            await asyncio.to_thread(shutil.copy2, ex, str(dest))
                            known.add(member_name)
                            added.append(member_name)
                except zipfile.BadZipFile:
                    errors.append({"filename": filename, "code": "bad_zip", "message": "Invalid or corrupt archive"})
        elif filename.endswith(".session"):
            safe_name = Path(filename).name
            if safe_name in known or (SESSIONS_ACTIVE / safe_name).exists():
                duplicates.append(safe_name)
                continue
            content = await upload_file.read()
            if not content:
                invalid.append(safe_name)
                errors.append({"filename": safe_name, "code": "empty", "message": "Empty file"})
                continue
            dest = SESSIONS_ACTIVE / safe_name
            await asyncio.to_thread(dest.write_bytes, content)
            known.add(safe_name)
            added.append(safe_name)
        else:
            invalid.append(filename)
            errors.append({"filename": filename, "code": "unsupported", "message": "Only .session or .zip accepted"})

    if added:
        await asyncio.to_thread(_upload_commit, added)
        emit_dashboard_event("sessions_added", {"count": len(added)})
        await wrappers.log_admin_action("web_admin", "upload_sessions", target=f"{len(added)} added")

    return {
        "added": added,
        "duplicates": duplicates,
        "invalid": invalid,
        "errors": errors,
        "extracted": extracted,
        "uploaded": len(files),
        "total_added": len(added),
        "summary": {
            "uploaded": len(files),
            "extracted": extracted,
            "added": len(added),
            "duplicates": len(duplicates),
            "invalid": len(invalid),
            "failed": len(errors),
        },
    }


# ─────────────────────────── delete ───────────────────────────

def _delete_locked(filename: str) -> str | None:
    """Remove one unassigned session from its pool bucket + unlink the file. Returns the
    bucket it was removed from, or None if not found. Runs under the pool lock."""
    from code.utils import SESSION_POOL_LOCK, load_pool, save_pool
    from code.config import resolve_session_path
    with SESSION_POOL_LOCK:
        pool = load_pool()
        removed_from = None
        for bucket, key in _BUCKET_KEYS.items():
            if filename in pool.get(key, []):
                pool[key] = [x for x in pool[key] if x != filename]
                removed_from = bucket
                break
        if removed_from is None:
            return None
        # star cleanup
        if filename in pool.get("starred_sessions", []):
            pool["starred_sessions"] = [x for x in pool["starred_sessions"] if x != filename]
        save_pool(pool)

    # Unlink the physical file (bucket dir first, then resolved path for users/*).
    candidates = [_bucket_dir(removed_from) / Path(filename).name, resolve_session_path(filename)]
    for fp in candidates:
        try:
            if fp.is_file():
                fp.unlink()
                break
        except OSError:
            pass
    return removed_from


@router.delete("/{filename}")
async def delete_session(filename: str):
    amap = await _assignment_map()
    conflict = _assigned_conflict(filename, amap)
    if conflict:
        raise HTTPException(409, conflict)

    removed_from = await asyncio.to_thread(_delete_locked, filename)
    if removed_from is None:
        raise HTTPException(404, f"Session '{filename}' not found in any pool bucket")

    await wrappers.log_admin_action("web_admin", "delete_session", target=filename)
    emit_dashboard_event("sessions_added", {"count": 0})
    return {"deleted": filename, "from_bucket": removed_from}


@router.post("/bulk-delete")
async def bulk_delete_sessions(body: dict):
    """Delete multiple unassigned sessions. Assigned sessions are skipped, not deleted."""
    filenames = [f for f in (body.get("filenames") or []) if f]
    if not filenames:
        raise HTTPException(400, "No filenames provided")

    amap = await _assignment_map()
    success: list[str] = []
    failed: list[dict] = []
    skipped: list[dict] = []

    for fn in filenames:
        conflict = _assigned_conflict(fn, amap)
        if conflict:
            skipped.append({"filename": fn, **conflict})
            continue
        removed = await asyncio.to_thread(_delete_locked, fn)
        if removed is None:
            failed.append({"filename": fn, "code": "not_found", "message": "Not in any pool bucket"})
        else:
            success.append(fn)

    if success:
        await wrappers.log_admin_action("web_admin", "bulk_delete_sessions", target=f"{len(success)} deleted")

    return {
        "success": success,
        "failed": failed,
        "skipped": skipped,
        "summary": {
            "requested": len(filenames),
            "succeeded": len(success),
            "failed": len(failed),
            "skipped": len(skipped),
        },
    }


# ─────────────────────────── move ───────────────────────────

def _locked_session_move(fn: str, from_bucket: str, to_bucket: str) -> tuple[bool, str]:
    """Serialize the canonical session_move under the shared pool lock."""
    from code.utils import SESSION_POOL_LOCK
    from code.admin_control import session_move
    with SESSION_POOL_LOCK:
        return session_move(fn, from_bucket, to_bucket)


@router.post("/{filename}/move")
async def move_session(filename: str, body: dict):
    from_bucket = body.get("from_bucket", "")
    to_bucket = body.get("to_bucket", "")
    if not from_bucket or not to_bucket:
        raise HTTPException(400, "from_bucket and to_bucket required")
    if to_bucket not in _BUCKET_KEYS:
        raise HTTPException(400, f"Invalid target pool: {to_bucket}")

    amap = await _assignment_map()
    conflict = _assigned_conflict(filename, amap)
    if conflict:
        conflict["message"] = f"'{filename}' is assigned to '{conflict['bot_name']}'. Unassign it before moving."
        raise HTTPException(409, conflict)

    success, msg = await asyncio.to_thread(_locked_session_move, filename, from_bucket, to_bucket)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "move_session", target=f"{filename}: {from_bucket} → {to_bucket}")
    return {"status": "moved", "message": msg}


@router.post("/bulk-move")
async def bulk_move_sessions(body: dict):
    filenames = [f for f in (body.get("filenames") or []) if f]
    from_bucket = body.get("from_bucket", "")
    to_bucket = body.get("to_bucket", "")
    if not filenames or not to_bucket:
        raise HTTPException(400, "filenames and to_bucket required")
    if to_bucket not in _BUCKET_KEYS:
        raise HTTPException(400, f"Invalid target pool: {to_bucket}")

    amap = await _assignment_map()
    success: list[str] = []
    failed: list[dict] = []
    skipped: list[dict] = []

    for fn in filenames:
        conflict = _assigned_conflict(fn, amap)
        if conflict:
            skipped.append({"filename": fn, **conflict})
            continue
        # Resolve the real source bucket per file so a mixed selection still moves correctly.
        src = from_bucket or _source_bucket_for(fn)
        ok, msg = await asyncio.to_thread(_locked_session_move, fn, src, to_bucket)
        if ok:
            success.append(fn)
        else:
            failed.append({"filename": fn, "code": "move_failed", "message": msg})

    if success:
        await wrappers.log_admin_action("web_admin", "bulk_move", target=f"{len(success)} → {to_bucket}")

    return {
        "success": success,
        "failed": failed,
        "skipped": skipped,
        "summary": {
            "requested": len(filenames),
            "succeeded": len(success),
            "failed": len(failed),
            "skipped": len(skipped),
        },
    }


def _source_bucket_for(fn: str) -> str:
    from code.utils import load_pool
    pool = load_pool()
    for bucket, key in _BUCKET_KEYS.items():
        if fn in pool.get(key, []):
            return bucket
    return "free"


# ─────────────────────────── validate ───────────────────────────

def _reconcile_dead(fn: str) -> None:
    """After the canonical validator moves an invalid file to dead/, sync the pool
    (remove from every bucket, add to dead) under the lock."""
    from code.utils import move_session_to_bucket
    move_session_to_bucket(fn, "dead_sessions")


@router.post("/validate")
async def validate_sessions(body: dict = None):
    """Validate unassigned sessions with the canonical guarded validator.

    Assigned sessions are SKIPPED here — validate them through the safe bot-scoped route
    (/api/bots/{name}/sessions/{file}/validate). Busy sessions (held by a running worker)
    are reported as ``busy`` and left untouched.
    """
    from code.config import resolve_session_path
    from code.utils import validate_session_with_reason, probe_session_identity, record_session_meta

    pool = await wrappers.load_pool()
    requested = (body or {}).get("filenames") or list(pool.get("free_sessions", []))
    requested = [f for f in requested if f][:200]

    amap = await _assignment_map()
    results: list[dict] = []
    dead_moved: list[str] = []
    skipped: list[dict] = []

    for fn in requested:
        conflict = _assigned_conflict(fn, amap)
        if conflict:
            conflict["message"] = f"'{fn}' is assigned — validate it from its AdBot page."
            skipped.append({"filename": fn, **conflict})
            continue

        path = resolve_session_path(fn)
        if not path.is_file():
            results.append({"file": fn, "status": "dead", "reason": "Session file missing"})
            await asyncio.to_thread(record_session_meta, fn, None, validation_status="invalid")
            await asyncio.to_thread(_reconcile_dead, fn)
            dead_moved.append(fn)
            continue

        try:
            valid, reason = await validate_session_with_reason(path)
        except Exception as e:  # defensive — validator handles its own cleanup
            results.append({"file": fn, "status": "error", "reason": str(e)[:150]})
            continue

        low = (reason or "").lower()
        if valid:
            results.append({"file": fn, "status": "active", "reason": ""})
            # Session is authorized+reachable — capture fresh identity into the cache.
            probe = await probe_session_identity(path)
            if probe.get("status") != "busy":
                await asyncio.to_thread(record_session_meta, fn, probe, validation_status="valid")
        elif "in use" in low or "busy" in low or "locked" in low:
            results.append({"file": fn, "status": "busy", "reason": reason})
        else:
            results.append({"file": fn, "status": "dead", "reason": reason})
            await asyncio.to_thread(record_session_meta, fn, None,
                                    validation_status="invalid", validation_reason=reason)
            # canonical validator already moved the file to dead/ — sync the pool
            await asyncio.to_thread(_reconcile_dead, fn)
            dead_moved.append(fn)

    await wrappers.log_admin_action("web_admin", "validate_sessions", target=f"{len(results)} checked")

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["status"] == "active"),
        "dead": sum(1 for r in results if r["status"] == "dead"),
        "busy": sum(1 for r in results if r["status"] == "busy"),
        "dead_moved": dead_moved,
        "skipped": skipped,
    }


# ─────────────────────────── spambot check ───────────────────────────

def _spambot_apply(fn: str, dest_bucket: str) -> None:
    """Move an unassigned session to limited/frozen: pool (under lock) + physical file."""
    from code.utils import SESSION_POOL_LOCK, load_pool, save_pool
    from code.config import resolve_session_path
    key = _BUCKET_KEYS[dest_bucket]
    with SESSION_POOL_LOCK:
        pool = load_pool()
        for b in _BUCKET_KEYS.values():
            pool[b] = [x for x in pool.get(b, []) if x != fn]
        pool.setdefault(key, [])
        if fn not in pool[key]:
            pool[key].append(fn)
        save_pool(pool)
    src = resolve_session_path(fn)
    if src.is_file():
        dest = _bucket_dir(dest_bucket) / Path(fn).name
        try:
            shutil.move(str(src), str(dest))
        except OSError:
            pass


@router.post("/spambot-check")
async def spambot_check(body: dict = None):
    """SpamBot health check on unassigned sessions. LIMITED/FROZEN results are moved to
    the matching pool. Assigned sessions are skipped (never move a file out from under a
    running bot) — disable or unassign them first, then check from the AdBot page."""
    from code.repair import (
        check_sessions_health_parallel, SPAM_ACTIVE,
        SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED, SPAM_FROZEN,
    )

    pool = await wrappers.load_pool()
    requested = (body or {}).get("filenames") or list(pool.get("free_sessions", []))
    requested = [f for f in requested if f][:200]

    amap = await _assignment_map()
    to_check: list[str] = []
    skipped: list[dict] = []
    for fn in requested:
        conflict = _assigned_conflict(fn, amap)
        if conflict:
            conflict["message"] = f"'{fn}' is assigned — disable or unassign it before a SpamBot check."
            skipped.append({"filename": fn, **conflict})
        else:
            to_check.append(fn)

    if not to_check:
        return {"sessions": [], "total": 0, "skipped": skipped,
                "summary": {"requested": len(requested), "checked": 0, "skipped": len(skipped)}}

    statuses = await check_sessions_health_parallel(to_check)
    results: list[dict] = []
    moved_limited: list[str] = []
    moved_frozen: list[str] = []

    from code.utils import record_session_meta

    for fn in to_check:
        st = statuses.get(fn, "UNKNOWN")
        results.append({"file": fn, "spambot_status": st})
        # Cache the SpamBot outcome so the dashboard shows health without reconnecting.
        if st and st != "UNKNOWN":
            await asyncio.to_thread(record_session_meta, fn, None, spam_status=st)
        if st in (SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED):
            await asyncio.to_thread(_spambot_apply, fn, "limited")
            moved_limited.append(fn)
        elif st == SPAM_FROZEN:
            await asyncio.to_thread(_spambot_apply, fn, "frozen")
            moved_frozen.append(fn)

    await wrappers.log_admin_action("web_admin", "spambot_check", target=f"{len(results)} checked")

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["spambot_status"] == SPAM_ACTIVE),
        "limited": sum(1 for r in results if "LIMITED" in r["spambot_status"]),
        "frozen": sum(1 for r in results if r["spambot_status"] == SPAM_FROZEN),
        "moved_limited": moved_limited,
        "moved_frozen": moved_frozen,
        "skipped": skipped,
        "summary": {
            "requested": len(requested),
            "checked": len(results),
            "moved": len(moved_limited) + len(moved_frozen),
            "skipped": len(skipped),
        },
    }


# ─────────────────────────── quick info ───────────────────────────

@router.get("/info")
async def get_sessions_info(filenames: str = Query(None, description="Comma-separated session filenames")):
    """Live identity refresh (connect + get_me/GetFullUser via the guarded client, no send test).
    This is the manual 'Refresh identity' path: every successful probe is persisted into the
    per-session metadata cache (pool.json['session_meta']) so subsequent dashboard reads are
    served from cache without reconnecting. Safe on any session — a busy session reports 'busy'
    and its cached record is left untouched."""
    from code.config import resolve_session_path
    from code.utils import probe_session_identity, record_session_meta

    pool = await wrappers.load_pool()
    fns = [f.strip() for f in filenames.split(",")] if filenames else list(pool.get("free_sessions", []))
    fns = [f for f in fns if f][:100]

    results = []
    for fn in fns:
        probe = await probe_session_identity(resolve_session_path(fn))
        st = probe.get("status")
        # Persist real results (never a busy skip — that would clobber good cache).
        if st != "busy":
            validation_status = "valid" if st == "active" else "invalid" if st in ("unauthorized", "dead") else "unknown"
            await asyncio.to_thread(record_session_meta, fn, probe, validation_status=validation_status)
        results.append({
            "file": fn,
            "real_name": probe.get("full_name") or "",
            "full_name": probe.get("full_name"),
            "user_id": probe.get("user_id"),
            "username": probe.get("username") or "",
            "phone": probe.get("phone") or "",
            "bio": probe.get("bio") or "",
            "premium": probe.get("premium", False),
            "restricted": probe.get("restricted", False),
            "authorized": probe.get("authorized", False),
            "status": st,
            "error": probe.get("error", ""),
        })

    return {"sessions": results}
