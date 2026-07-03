"""Session Client endpoints: use a .session file as a Telegram client.
Provides profile, chats, messages, and settings management.

Architecture (same as Telegram Desktop / AyuGram):
 1. Persistent connection pool — one TelegramClient per session, stays alive 5min
 2. Server-side data cache   — profile/chats cached in memory, served instantly
 3. Background refresh       — stale cache served immediately, Telegram fetched in bg
 4. Single /init endpoint    — frontend gets profile+chats in ONE request
"""
import asyncio
import base64
import logging
import time
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel

from api.deps import get_current_admin

logger = logging.getLogger("api.session_client")

# ═══════════════════════════════════════════════════════════════════
# Connection Pool — persistent TelegramClient instances
# ═══════════════════════════════════════════════════════════════════

IDLE_TIMEOUT = 300          # 5 min — auto-disconnect after idle

_pool: dict[str, "PooledClient"] = {}
_pool_lock = asyncio.Lock()


class PooledClient:
    """TelegramClient wrapper with idle tracking & auto-disconnect."""

    def __init__(self, client, filename: str):
        self.client = client
        self.filename = filename
        self.last_used = time.time()
        self._timer: Optional[asyncio.Task] = None
        self.lock = asyncio.Lock()

    def touch(self):
        self.last_used = time.time()
        # Reset idle timer
        if self._timer and not self._timer.done():
            self._timer.cancel()
        self._timer = asyncio.create_task(self._idle_check())

    async def _idle_check(self):
        try:
            await asyncio.sleep(IDLE_TIMEOUT)
            if time.time() - self.last_used >= IDLE_TIMEOUT - 1:
                logger.info("Idle timeout → disconnect %s", self.filename)
                _pool.pop(self.filename, None)
                _cache.pop(self.filename, None)
                await self.force_disconnect()
        except asyncio.CancelledError:
            pass

    async def force_disconnect(self):
        try:
            if self.client.is_connected():
                await self.client.disconnect()
        except Exception as e:
            logger.warning("Disconnect error %s: %s", self.filename, e)


async def _get_pc(filename: str) -> PooledClient:
    """Get or create a pooled client. Fast path avoids lock."""
    pc = _pool.get(filename)
    if pc and pc.client.is_connected():
        pc.touch()
        return pc

    async with _pool_lock:
        # Double-check
        pc = _pool.get(filename)
        if pc and pc.client.is_connected():
            pc.touch()
            return pc
        if pc:
            _pool.pop(filename, None)

        from code.session_guard import SessionBusyError, register_soft_release
        client = _make_client(filename)
        try:
            await client.connect()
        except SessionBusyError as e:
            # 423 Locked: tell the user who holds the session and how long to wait
            raise HTTPException(423, str(e))
        if not await client.is_user_authorized():
            await client.disconnect()
            raise HTTPException(401, "Session is not authorized")

        pc = PooledClient(client, filename)
        _pool[filename] = pc
        pc.touch()

        # Between requests this connection idles; let other tasks (posting start,
        # health check, chatlist) force-release it instead of seeing "busy".
        async def _release_for_other_task() -> None:
            _pool.pop(filename, None)
            _cache.pop(filename, None)
            async with pc.lock:  # let any in-flight portal request finish first
                await pc.force_disconnect()

        register_soft_release(filename, _release_for_other_task)
        logger.info("Connected → pool: %s", filename)
        return pc


def _evict(filename: str, pc: PooledClient):
    """Remove dead connection from pool."""
    _pool.pop(filename, None)
    asyncio.create_task(pc.force_disconnect())


# ═══════════════════════════════════════════════════════════════════
# Server-Side Data Cache — serve instantly, refresh in background
# ═══════════════════════════════════════════════════════════════════

CACHE_TTL_PROFILE = 120     # 2 min
CACHE_TTL_CHATS = 60        # 1 min
CACHE_TTL_MESSAGES = 30     # 30 sec

_cache: dict[str, dict] = {}  # { filename: { "profile": {...}, "profile_ts": float, ... } }


def _get_cache(filename: str) -> dict:
    if filename not in _cache:
        _cache[filename] = {}
    return _cache[filename]


def _cache_fresh(cache: dict, key: str, ttl: float) -> bool:
    ts = cache.get(f"{key}_ts", 0)
    return (time.time() - ts) < ttl


async def _fetch_profile(pc: PooledClient) -> dict:
    """Fetch profile from Telegram."""
    from telethon.tl.functions.users import GetFullUserRequest

    me = await pc.client.get_me()
    full = await pc.client(GetFullUserRequest(me.id))
    full_user = full.full_user

    avatar_b64 = None
    try:
        photo = await pc.client.download_profile_photo(me, bytes)
        if photo:
            avatar_b64 = base64.b64encode(photo).decode()
    except Exception:
        pass

    return {
        "user_id": me.id,
        "first_name": me.first_name or "",
        "last_name": me.last_name or "",
        "username": me.username or "",
        "phone": me.phone or "",
        "bio": full_user.about or "",
        "premium": bool(me.premium),
        "restricted": bool(me.restricted),
        "avatar": avatar_b64,
    }


async def _fetch_chats(pc: PooledClient, limit: int = 80) -> list[dict]:
    """Fetch chat list from Telegram."""
    from telethon.tl.types import User, Chat, Channel

    dialogs = await pc.client.get_dialogs(limit=limit)
    chats = []
    for d in dialogs:
        entity = d.entity
        chat_type = "user"
        if isinstance(entity, Channel):
            chat_type = "channel" if entity.broadcast else "group"
        elif isinstance(entity, Chat):
            chat_type = "group"

        chats.append({
            "id": d.id,
            "name": d.name or "Unknown",
            "type": chat_type,
            "unread_count": d.unread_count,
            "last_message": d.message.text[:100] if d.message and d.message.text else "",
            "last_date": d.message.date.isoformat() if d.message and d.message.date else None,
            "pinned": d.pinned,
            "muted": d.archived,
        })
    return chats


async def _fetch_messages(pc: PooledClient, chat_id: int, limit: int = 50, offset_id: int = 0) -> list[dict]:
    """Fetch messages from Telegram."""
    messages = await pc.client.get_messages(chat_id, limit=limit, offset_id=offset_id)
    result = []
    for m in messages:
        sender_name = ""
        if m.sender:
            if hasattr(m.sender, "first_name"):
                sender_name = f"{m.sender.first_name or ''} {m.sender.last_name or ''}".strip()
            elif hasattr(m.sender, "title"):
                sender_name = m.sender.title or ""
        result.append({
            "id": m.id,
            "text": m.text or "",
            "date": m.date.isoformat() if m.date else None,
            "out": m.out,
            "sender_id": m.sender_id,
            "sender_name": sender_name,
            "reply_to": m.reply_to_msg_id if m.reply_to else None,
            "media_type": type(m.media).__name__ if m.media else None,
            "edited": bool(m.edit_date),
        })
    return list(reversed(result))


async def _bg_refresh(filename: str, what: str):
    """Background task to refresh cache without blocking the response."""
    try:
        pc = await _get_pc(filename)
        cache = _get_cache(filename)
        async with pc.lock:
            if what == "profile":
                data = await _fetch_profile(pc)
                cache["profile"] = data
                cache["profile_ts"] = time.time()
            elif what == "chats":
                data = await _fetch_chats(pc)
                cache["chats"] = data
                cache["chats_ts"] = time.time()
    except Exception as e:
        logger.debug("bg_refresh %s/%s failed: %s", filename, what, e)


# ═══════════════════════════════════════════════════════════════════
# Session path resolution
# ═══════════════════════════════════════════════════════════════════

def _find_session_path(filename: str) -> Path:
    from code.config import (
        resolve_session_path, SESSIONS_DIR,
        SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN,
        SESSIONS_LIMITED, SESSIONS_UNAUTH, SESSIONS_BY_USER,
    )
    resolved = resolve_session_path(filename)
    if resolved.exists():
        return resolved
    for directory in [SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED, SESSIONS_UNAUTH]:
        candidate = directory / filename
        if candidate.exists():
            return candidate
    if SESSIONS_BY_USER.exists():
        for user_dir in SESSIONS_BY_USER.iterdir():
            if user_dir.is_dir():
                candidate = user_dir / filename
                if candidate.exists():
                    return candidate
    from code.utils import load_adbot
    adbot = load_adbot()
    for cfg in adbot.get("bots", {}).values():
        for s in cfg.get("sessions", []):
            s_file = s.get("file", "")
            bare_name = Path(s_file).name
            if bare_name == filename or s_file == filename:
                real_path = resolve_session_path(s_file)
                if real_path.exists():
                    return real_path
    for match in SESSIONS_DIR.rglob(filename):
        if match.is_file():
            return match
    return None


def _make_client(filename: str):
    from code.session_guard import guarded_client
    path = _find_session_path(filename)
    if not path:
        raise HTTPException(404, f"Session file not found: {filename}")
    # expected_sec = idle timeout: other tasks see "account manager (web portal)"
    # with a realistic wait estimate; idle holds are also soft-releasable below.
    return guarded_client(
        path, "account manager (web portal)",
        wait_timeout=5, expected_sec=IDLE_TIMEOUT,
    )


# ═══════════════════════════════════════════════════════════════════
# Router
# ═══════════════════════════════════════════════════════════════════

router = APIRouter(
    prefix="/api/session-client",
    tags=["session-client"],
    dependencies=[Depends(get_current_admin)],
)


# ── INIT — single request for initial page load ──

@router.get("/{filename}/init")
async def init_session(filename: str):
    """Returns profile + chats in ONE request. Serves cache instantly,
    triggers background refresh if stale. First call connects & fetches live."""
    cache = _get_cache(filename)

    has_cached_profile = "profile" in cache
    has_cached_chats = "chats" in cache
    profile_fresh = _cache_fresh(cache, "profile", CACHE_TTL_PROFILE)
    chats_fresh = _cache_fresh(cache, "chats", CACHE_TTL_CHATS)

    # If we have cached data, serve it immediately
    if has_cached_profile and has_cached_chats:
        # Schedule background refresh for stale data
        if not profile_fresh:
            asyncio.create_task(_bg_refresh(filename, "profile"))
        if not chats_fresh:
            asyncio.create_task(_bg_refresh(filename, "chats"))

        return {
            "profile": cache["profile"],
            "chats": cache["chats"],
            "cached": True,
            "profile_age": int(time.time() - cache.get("profile_ts", 0)),
            "chats_age": int(time.time() - cache.get("chats_ts", 0)),
        }

    # No cache — must fetch live (first connection)
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            # Fetch profile and chats sequentially (same connection)
            profile_data = await _fetch_profile(pc)
            chats_data = await _fetch_chats(pc)

            cache["profile"] = profile_data
            cache["profile_ts"] = time.time()
            cache["chats"] = chats_data
            cache["chats_ts"] = time.time()

            return {
                "profile": profile_data,
                "chats": chats_data,
                "cached": False,
            }
        except Exception as e:
            logger.error("init error %s: %s", filename, e)
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Profile ──

@router.get("/{filename}/profile")
async def get_profile(filename: str):
    cache = _get_cache(filename)
    if "profile" in cache:
        if not _cache_fresh(cache, "profile", CACHE_TTL_PROFILE):
            asyncio.create_task(_bg_refresh(filename, "profile"))
        return cache["profile"]

    # No cache — fetch live
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            data = await _fetch_profile(pc)
            cache["profile"] = data
            cache["profile_ts"] = time.time()
            return data
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


class ProfileUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


@router.put("/{filename}/profile")
async def update_profile(filename: str, body: ProfileUpdate):
    from telethon.tl.functions.account import UpdateProfileRequest, UpdateUsernameRequest

    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            updates = {}
            if body.first_name is not None:
                updates["first_name"] = body.first_name
            if body.last_name is not None:
                updates["last_name"] = body.last_name
            if body.bio is not None:
                updates["about"] = body.bio
            if updates:
                await pc.client(UpdateProfileRequest(**updates))
            if body.username is not None:
                try:
                    await pc.client(UpdateUsernameRequest(body.username))
                except Exception as e:
                    return {"status": "partial", "message": f"Profile updated but username failed: {e}"}
            # Invalidate cache so next read fetches fresh
            _get_cache(filename).pop("profile", None)
            return {"status": "ok", "message": "Profile updated"}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


@router.post("/{filename}/avatar")
async def update_avatar(filename: str, file: UploadFile = File(...)):
    from telethon.tl.functions.photos import UploadProfilePhotoRequest
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            file_data = await file.read()
            uploaded = await pc.client.upload_file(BytesIO(file_data), file_name="avatar.jpg")
            await pc.client(UploadProfilePhotoRequest(file=uploaded))
            _get_cache(filename).pop("profile", None)
            return {"status": "ok"}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


@router.delete("/{filename}/avatar")
async def delete_avatar(filename: str):
    from telethon.tl.functions.photos import GetUserPhotosRequest, DeletePhotosRequest
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            me = await pc.client.get_me()
            photos = await pc.client(GetUserPhotosRequest(user_id=me, offset=0, max_id=0, limit=1))
            if photos.photos:
                await pc.client(DeletePhotosRequest(id=[photos.photos[0]]))
            _get_cache(filename).pop("profile", None)
            return {"status": "ok"}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Chats ──

@router.get("/{filename}/chats")
async def get_chats(filename: str, limit: int = 80):
    cache = _get_cache(filename)
    if "chats" in cache:
        if not _cache_fresh(cache, "chats", CACHE_TTL_CHATS):
            asyncio.create_task(_bg_refresh(filename, "chats"))
        return {"chats": cache["chats"], "total": len(cache["chats"]), "cached": True}

    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            data = await _fetch_chats(pc, limit)
            cache["chats"] = data
            cache["chats_ts"] = time.time()
            return {"chats": data, "total": len(data), "cached": False}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Messages ──

@router.get("/{filename}/chat/{chat_id}/messages")
async def get_messages(filename: str, chat_id: int, limit: int = 50, offset_id: int = 0):
    cache = _get_cache(filename)
    msg_key = f"msgs_{chat_id}"

    # Serve cached messages if fresh (only for default offset)
    if offset_id == 0 and msg_key in cache and _cache_fresh(cache, msg_key, CACHE_TTL_MESSAGES):
        return {"messages": cache[msg_key], "chat_id": chat_id, "cached": True}

    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            data = await _fetch_messages(pc, chat_id, limit, offset_id)
            if offset_id == 0:
                cache[msg_key] = data
                cache[f"{msg_key}_ts"] = time.time()
            return {"messages": data, "chat_id": chat_id, "cached": False}
        except Exception as e:
            # If we have cached data, return it despite error
            if msg_key in cache:
                return {"messages": cache[msg_key], "chat_id": chat_id, "cached": True, "stale": True}
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


class SendMessage(BaseModel):
    text: str
    reply_to: Optional[int] = None


@router.post("/{filename}/chat/{chat_id}/send")
async def send_message(filename: str, chat_id: int, body: SendMessage):
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            msg = await pc.client.send_message(chat_id, body.text, reply_to=body.reply_to)
            # Invalidate message cache for this chat
            cache = _get_cache(filename)
            cache.pop(f"msgs_{chat_id}", None)
            cache.pop(f"msgs_{chat_id}_ts", None)
            return {
                "status": "ok",
                "message_id": msg.id,
                "date": msg.date.isoformat() if msg.date else None,
            }
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


@router.post("/{filename}/chat/{chat_id}/read")
async def mark_read(filename: str, chat_id: int):
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            await pc.client.send_read_acknowledge(chat_id)
            return {"status": "ok"}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Privacy ──

@router.get("/{filename}/privacy")
async def get_privacy(filename: str):
    from telethon.tl.functions.account import GetPrivacyRequest
    from telethon.tl.types import (
        InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp,
        InputPrivacyKeyProfilePhoto, InputPrivacyKeyChatInvite,
        InputPrivacyKeyForwards, InputPrivacyKeyPhoneCall,
        PrivacyValueAllowAll, PrivacyValueAllowContacts, PrivacyValueDisallowAll,
    )

    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            def rule_to_str(rules):
                for r in rules:
                    if isinstance(r, PrivacyValueAllowAll):
                        return "everyone"
                    if isinstance(r, PrivacyValueAllowContacts):
                        return "contacts"
                    if isinstance(r, PrivacyValueDisallowAll):
                        return "nobody"
                return "unknown"

            keys = {
                "phone_number": InputPrivacyKeyPhoneNumber(),
                "last_seen": InputPrivacyKeyStatusTimestamp(),
                "profile_photo": InputPrivacyKeyProfilePhoto(),
                "group_invite": InputPrivacyKeyChatInvite(),
                "forwarded": InputPrivacyKeyForwards(),
                "calls": InputPrivacyKeyPhoneCall(),
            }

            privacy = {}
            for name, key in keys.items():
                try:
                    result = await pc.client(GetPrivacyRequest(key))
                    privacy[name] = rule_to_str(result.rules)
                except Exception:
                    privacy[name] = "unknown"

            return {"privacy": privacy}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


class PrivacyUpdate(BaseModel):
    key: str
    value: str  # "everyone", "contacts", "nobody"


@router.put("/{filename}/privacy")
async def update_privacy(filename: str, body: PrivacyUpdate):
    from telethon.tl.functions.account import SetPrivacyRequest
    from telethon.tl.types import (
        InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp,
        InputPrivacyKeyProfilePhoto, InputPrivacyKeyChatInvite,
        InputPrivacyKeyForwards, InputPrivacyKeyPhoneCall,
        InputPrivacyValueAllowAll, InputPrivacyValueAllowContacts,
        InputPrivacyValueDisallowAll,
    )
    key_map = {
        "phone_number": InputPrivacyKeyPhoneNumber(),
        "last_seen": InputPrivacyKeyStatusTimestamp(),
        "profile_photo": InputPrivacyKeyProfilePhoto(),
        "group_invite": InputPrivacyKeyChatInvite(),
        "forwarded": InputPrivacyKeyForwards(),
        "calls": InputPrivacyKeyPhoneCall(),
    }
    value_map = {
        "everyone": [InputPrivacyValueAllowAll()],
        "contacts": [InputPrivacyValueAllowContacts()],
        "nobody": [InputPrivacyValueDisallowAll()],
    }
    if body.key not in key_map:
        raise HTTPException(400, f"Invalid privacy key: {body.key}")
    if body.value not in value_map:
        raise HTTPException(400, f"Invalid value: {body.value}. Use everyone/contacts/nobody")

    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            await pc.client(SetPrivacyRequest(key=key_map[body.key], rules=value_map[body.value]))
            return {"status": "ok", "key": body.key, "value": body.value}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Contacts ──

@router.get("/{filename}/contacts")
async def get_contacts(filename: str):
    from telethon.tl.functions.contacts import GetContactsRequest
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            result = await pc.client(GetContactsRequest(hash=0))
            contacts = []
            for u in getattr(result, "users", []):
                contacts.append({
                    "user_id": u.id, "first_name": u.first_name or "",
                    "last_name": u.last_name or "", "username": u.username or "",
                    "phone": u.phone or "", "bot": bool(u.bot),
                })
            return {"contacts": contacts, "total": len(contacts)}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


# ── Account actions ──

@router.post("/{filename}/logout")
async def logout_session(filename: str):
    from telethon.tl.functions.auth import LogOutRequest
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            await pc.client(LogOutRequest())
            _pool.pop(filename, None)
            _cache.pop(filename, None)
            await pc.force_disconnect()
            return {"status": "ok", "message": "Session logged out"}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


@router.get("/{filename}/active-sessions")
async def get_active_sessions(filename: str):
    from telethon.tl.functions.account import GetAuthorizationsRequest
    pc = await _get_pc(filename)
    async with pc.lock:
        try:
            result = await pc.client(GetAuthorizationsRequest())
            sessions = []
            for auth in result.authorizations:
                sessions.append({
                    "hash": str(auth.hash), "device": auth.device_model or "",
                    "platform": auth.platform or "", "system_version": auth.system_version or "",
                    "api_id": auth.api_id, "app_name": auth.app_name or "",
                    "app_version": auth.app_version or "",
                    "date_created": auth.date_created.isoformat() if auth.date_created else None,
                    "date_active": auth.date_active.isoformat() if auth.date_active else None,
                    "ip": auth.ip or "", "country": auth.country or "",
                    "region": auth.region or "", "current": bool(auth.current),
                })
            return {"sessions": sessions, "total": len(sessions)}
        except Exception as e:
            _evict(filename, pc)
            raise HTTPException(500, f"Telegram error: {e}")


@router.post("/{filename}/disconnect")
async def disconnect_session(filename: str):
    """Manually disconnect session & clear cache."""
    pc = _pool.pop(filename, None)
    _cache.pop(filename, None)
    if pc:
        await pc.force_disconnect()
    return {"status": "ok"}
