"""Session management endpoints: list, upload, move, validate, delete."""
import asyncio
import shutil
import tempfile
import zipfile
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query

from api.deps import get_current_admin
from api.services import wrappers
from api.services.serializers import serialize_session, paginate
from api.services.events import emit_dashboard_event

router = APIRouter(prefix="/api/sessions", tags=["sessions"], dependencies=[Depends(get_current_admin)])


@router.get("")
async def list_sessions(
    status: str = Query(None, description="Filter by bucket status"),
    bot_name: str = Query(None, description="Filter by assigned bot"),
):
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


@router.post("/upload")
async def upload_sessions(files: list[UploadFile] = File(...)):
    from code.config import SESSIONS_ACTIVE
    from code.utils import load_pool, save_pool

    added = []
    duplicates = []
    errors = []

    pool = await asyncio.to_thread(load_pool)
    all_known = set(pool.get("free_sessions", []) + pool.get("dead_sessions", []) +
                    pool.get("frozen_sessions", []) + pool.get("limited_sessions", []))

    for upload_file in files:
        filename = upload_file.filename or "unknown.session"

        if filename.endswith(".zip"):
            with tempfile.TemporaryDirectory() as tmp_dir:
                zip_path = Path(tmp_dir) / filename
                content = await upload_file.read()
                await asyncio.to_thread(zip_path.write_bytes, content)
                try:
                    with zipfile.ZipFile(zip_path, "r") as zf:
                        for member in zf.namelist():
                            if member.endswith(".session") and not member.startswith("__"):
                                member_name = Path(member).name
                                if member_name in all_known:
                                    duplicates.append(member_name)
                                    continue
                                extracted = zf.extract(member, tmp_dir)
                                dest = SESSIONS_ACTIVE / member_name
                                if dest.exists():
                                    duplicates.append(member_name)
                                    continue
                                await asyncio.to_thread(shutil.copy2, extracted, str(dest))
                                pool.setdefault("free_sessions", []).append(member_name)
                                all_known.add(member_name)
                                added.append(member_name)
                except zipfile.BadZipFile:
                    errors.append(f"{filename}: invalid zip")
        elif filename.endswith(".session"):
            if filename in all_known:
                duplicates.append(filename)
                continue
            dest = SESSIONS_ACTIVE / filename
            if dest.exists():
                duplicates.append(filename)
                continue
            content = await upload_file.read()
            await asyncio.to_thread(dest.write_bytes, content)
            pool.setdefault("free_sessions", []).append(filename)
            all_known.add(filename)
            added.append(filename)
        else:
            errors.append(f"{filename}: unsupported file type (need .session or .zip)")

    if added:
        await asyncio.to_thread(save_pool, pool)
        emit_dashboard_event("sessions_added", {"count": len(added)})

    await wrappers.log_admin_action("web_admin", "upload_sessions", target=f"{len(added)} added")
    return {
        "added": added,
        "duplicates": duplicates,
        "errors": errors,
        "total_added": len(added),
    }


@router.delete("/{filename}")
async def delete_session(filename: str):
    from code.config import SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED
    from code.utils import load_pool, save_pool

    pool = await asyncio.to_thread(load_pool)
    removed_from = None

    for bucket_key in ("free_sessions", "dead_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
        if filename in pool.get(bucket_key, []):
            pool[bucket_key] = [x for x in pool[bucket_key] if x != filename]
            removed_from = bucket_key
            break

    if removed_from is None:
        raise HTTPException(404, f"Session '{filename}' not found in any pool bucket")

    for directory in (SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED):
        fp = directory / filename
        if fp.is_file():
            await asyncio.to_thread(fp.unlink)
            break

    await asyncio.to_thread(save_pool, pool)
    await wrappers.log_admin_action("web_admin", "delete_session", target=filename)
    return {"deleted": filename, "from_bucket": removed_from}


@router.post("/{filename}/move")
async def move_session(filename: str, body: dict):
    from_bucket = body.get("from_bucket", "")
    to_bucket = body.get("to_bucket", "")
    if not from_bucket or not to_bucket:
        raise HTTPException(400, "from_bucket and to_bucket required")

    success, msg = await wrappers.session_move(filename, from_bucket, to_bucket)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "move_session", target=f"{filename}: {from_bucket} → {to_bucket}")
    return {"status": "moved", "message": msg}


@router.get("/starred")
async def get_starred():
    pool = await wrappers.load_pool()
    return {"starred": pool.get("starred_sessions", [])}


@router.post("/{filename}/star")
async def star_session(filename: str):
    pool = await wrappers.load_pool()
    starred = pool.setdefault("starred_sessions", [])
    if filename not in starred:
        starred.append(filename)
        await wrappers.save_pool(pool)
    return {"starred": True, "filename": filename}


@router.delete("/{filename}/star")
async def unstar_session(filename: str):
    pool = await wrappers.load_pool()
    starred = pool.setdefault("starred_sessions", [])
    if filename in starred:
        starred.remove(filename)
        await wrappers.save_pool(pool)
    return {"starred": False, "filename": filename}


@router.post("/bulk-move")
async def bulk_move_sessions(body: dict):
    filenames = body.get("filenames", [])
    from_bucket = body.get("from_bucket", "")
    to_bucket = body.get("to_bucket", "")
    if not filenames or not from_bucket or not to_bucket:
        raise HTTPException(400, "filenames, from_bucket and to_bucket required")

    moved = []
    failed = []
    for fn in filenames:
        success, msg = await wrappers.session_move(fn, from_bucket, to_bucket)
        if success:
            moved.append(fn)
        else:
            failed.append({"file": fn, "error": msg})

    await wrappers.log_admin_action("web_admin", "bulk_move", target=f"{len(moved)} sessions: {from_bucket} → {to_bucket}")
    return {"moved": len(moved), "failed": len(failed), "failed_details": failed}


@router.post("/validate")
async def validate_sessions(body: dict = None):
    """Validate selected sessions (or all free). Returns full info + status per session.
    Body: {"filenames": ["a.session", ...]} or empty for all free sessions."""
    from code.config import resolve_session_path, API_ID, API_HASH, PROXY
    from code.utils import load_pool, save_pool
    from telethon import TelegramClient
    from telethon.tl.functions.users import GetFullUserRequest

    pool = await asyncio.to_thread(load_pool)
    filenames = (body or {}).get("filenames") or pool.get("free_sessions", [])[:]
    results = []
    dead_files = []

    for fn in filenames[:100]:
        info = {
            "file": fn,
            "real_name": "",
            "user_id": None,
            "username": "",
            "phone": "",
            "bio": "",
            "premium": False,
            "restricted": False,
            "status": "unknown",
            "reason": "",
        }
        path = resolve_session_path(fn)
        if not path.is_file():
            info["status"] = "dead"
            info["reason"] = "Session file missing"
            dead_files.append(fn)
            results.append(info)
            continue

        client = None
        try:
            from code.session_guard import guarded_client
            client = guarded_client(path, "session validation", wait_timeout=5, expected_sec=30)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                info["status"] = "dead"
                info["reason"] = "Not authorized (logged out / banned)"
                dead_files.append(fn)
                results.append(info)
                continue
            # Send test
            try:
                await client.send_message("me", ".")
            except Exception as send_err:
                from code.rpc_errors import SESSION_DEAD_ERRORS
                if type(send_err) in SESSION_DEAD_ERRORS:
                    await client.disconnect()
                    info["status"] = "dead"
                    info["reason"] = str(send_err)[:150]
                    dead_files.append(fn)
                    results.append(info)
                    continue
                info["reason"] = f"Send test failed: {str(send_err)[:100]}"

            me = await client.get_me()
            if me:
                info["status"] = "active"
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["username"] = me.username or ""
                info["phone"] = me.phone or ""
                info["user_id"] = me.id
                info["premium"] = bool(getattr(me, "premium", False))
                info["restricted"] = bool(getattr(me, "restricted", False))
                try:
                    full = await client(GetFullUserRequest(me.id))
                    info["bio"] = getattr(full.full_user, "about", "") or ""
                except Exception:
                    pass
            await client.disconnect()
        except Exception as e:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            from code.session_guard import SessionBusyError
            if isinstance(e, SessionBusyError) or "database is locked" in str(e).lower():
                # In use by another task — do NOT mark dead or move the file
                info["status"] = "busy"
                info["reason"] = str(e)[:200]
            else:
                info["status"] = "dead"
                info["reason"] = str(e)[:150]
                dead_files.append(fn)

        results.append(info)

    # Move dead sessions from free to dead pool
    if dead_files:
        from code.config import SESSIONS_DEAD
        for fn in dead_files:
            for bucket in ("free_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
                if fn in pool.get(bucket, []):
                    pool[bucket] = [x for x in pool[bucket] if x != fn]
            if fn not in pool.get("dead_sessions", []):
                pool.setdefault("dead_sessions", []).append(fn)
            # Move file to dead dir
            src = resolve_session_path(fn)
            if src.is_file():
                dest = SESSIONS_DEAD / Path(fn).name
                try:
                    await asyncio.to_thread(shutil.move, str(src), str(dest))
                except OSError:
                    pass
        await asyncio.to_thread(save_pool, pool)

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["status"] == "active"),
        "dead": len(dead_files),
        "dead_moved": dead_files,
    }


@router.post("/spambot-check")
async def spambot_check(body: dict = None):
    """Run SpamBot health check on selected sessions (or all free).
    Body: {"filenames": ["a.session", ...]} or empty for all free.
    Moves LIMITED/FROZEN sessions out of free pool into correct buckets."""
    from code.repair import (
        check_sessions_health_parallel, SPAM_ACTIVE,
        SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED, SPAM_FROZEN,
    )
    from code.config import SESSIONS_ACTIVE, SESSIONS_FROZEN as FROZEN_DIR, SESSIONS_LIMITED as LIMITED_DIR
    from code.utils import load_pool, save_pool

    pool = await asyncio.to_thread(load_pool)
    filenames = (body or {}).get("filenames") or pool.get("free_sessions", [])[:]

    if not filenames:
        return {"sessions": [], "total": 0}

    statuses = await check_sessions_health_parallel(filenames[:100])

    results = []
    moved_limited = []
    moved_frozen = []

    for fn in filenames[:100]:
        spam_status = statuses.get(fn, "UNKNOWN")
        results.append({
            "file": fn,
            "spambot_status": spam_status,
        })

        # Move sessions to correct pool buckets based on status
        if spam_status in (SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED):
            # Remove from free pool, add to limited
            if fn in pool.get("free_sessions", []):
                pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
            if fn not in pool.get("limited_sessions", []):
                pool.setdefault("limited_sessions", []).append(fn)
            # Move file to limited directory
            src = SESSIONS_ACTIVE / fn
            if src.is_file():
                dest = LIMITED_DIR / fn
                try:
                    await asyncio.to_thread(shutil.move, str(src), str(dest))
                except OSError:
                    pass
            moved_limited.append(fn)

        elif spam_status == SPAM_FROZEN:
            # Remove from free pool, add to frozen
            if fn in pool.get("free_sessions", []):
                pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
            if fn not in pool.get("frozen_sessions", []):
                pool.setdefault("frozen_sessions", []).append(fn)
            # Move file to frozen directory
            src = SESSIONS_ACTIVE / fn
            if src.is_file():
                dest = FROZEN_DIR / fn
                try:
                    await asyncio.to_thread(shutil.move, str(src), str(dest))
                except OSError:
                    pass
            moved_frozen.append(fn)

    # Save pool if any sessions were moved
    if moved_limited or moved_frozen:
        await asyncio.to_thread(save_pool, pool)

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["spambot_status"] == SPAM_ACTIVE),
        "limited": sum(1 for r in results if "LIMITED" in r["spambot_status"]),
        "frozen": sum(1 for r in results if r["spambot_status"] == SPAM_FROZEN),
        "moved_limited": moved_limited,
        "moved_frozen": moved_frozen,
    }


@router.get("/info")
async def get_sessions_info(filenames: str = Query(None, description="Comma-separated session filenames")):
    """Quick info check (connect + get_me, no send test). Fast.
    Pass ?filenames=a.session,b.session or omit for all free sessions."""
    from code.config import resolve_session_path, API_ID, API_HASH, PROXY
    from code.utils import load_pool
    from telethon import TelegramClient
    from telethon.tl.functions.users import GetFullUserRequest

    pool = await asyncio.to_thread(load_pool)
    fns = filenames.split(",") if filenames else pool.get("free_sessions", [])[:]

    results = []
    for fn in fns[:100]:
        fn = fn.strip()
        if not fn:
            continue
        info = {
            "file": fn,
            "real_name": "",
            "user_id": None,
            "username": "",
            "phone": "",
            "bio": "",
            "premium": False,
            "restricted": False,
            "status": "unknown",
            "error": "",
        }
        path = resolve_session_path(fn)
        if not path.is_file():
            info["status"] = "dead"
            info["error"] = "Session file missing"
            results.append(info)
            continue
        client = None
        try:
            from code.session_guard import guarded_client
            client = guarded_client(path, "session details check", wait_timeout=5, expected_sec=30)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                info["status"] = "dead"
                info["error"] = "Not authorized"
                results.append(info)
                continue
            me = await client.get_me()
            if me:
                info["status"] = "active"
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["username"] = me.username or ""
                info["phone"] = me.phone or ""
                info["user_id"] = me.id
                info["premium"] = bool(getattr(me, "premium", False))
                info["restricted"] = bool(getattr(me, "restricted", False))
                try:
                    full = await client(GetFullUserRequest(me.id))
                    info["bio"] = getattr(full.full_user, "about", "") or ""
                except Exception:
                    pass
            else:
                info["status"] = "dead"
                info["error"] = "Could not get user info"
            await client.disconnect()
        except Exception as e:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            from code.session_guard import SessionBusyError
            if isinstance(e, SessionBusyError) or "database is locked" in str(e).lower():
                info["status"] = "busy"
                info["error"] = str(e)[:200]
            else:
                info["status"] = "error"
                info["error"] = str(e)[:150]
        results.append(info)

    return {"sessions": results}


@router.post("/bulk-delete")
async def bulk_delete_sessions(body: dict):
    """Delete multiple sessions at once. Body: {"filenames": ["a.session", ...]}"""
    from code.config import SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED
    from code.utils import load_pool, save_pool

    filenames = body.get("filenames", [])
    if not filenames:
        raise HTTPException(400, "No filenames provided")

    pool = await asyncio.to_thread(load_pool)
    deleted = []
    not_found = []

    for filename in filenames:
        found = False
        for bucket_key in ("free_sessions", "dead_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
            if filename in pool.get(bucket_key, []):
                pool[bucket_key] = [x for x in pool[bucket_key] if x != filename]
                found = True
                break
        if not found:
            not_found.append(filename)
            continue

        for directory in (SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED):
            fp = directory / filename
            if fp.is_file():
                try:
                    await asyncio.to_thread(fp.unlink)
                except OSError:
                    pass
                break
        deleted.append(filename)

    if deleted:
        await asyncio.to_thread(save_pool, pool)
        await wrappers.log_admin_action("web_admin", "bulk_delete_sessions", target=f"{len(deleted)} deleted")

    return {"deleted": deleted, "not_found": not_found, "total_deleted": len(deleted)}
