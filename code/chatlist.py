"""
Custom Chatlist system — lets users provide up to 2 Telegram chatlist (folder) links.
The bot joins the chatlists on all sessions, scrapes group IDs (including forum topics),
saves to a per-user custom group file, and posts only in those groups.

Limits:
  - Max 2 chatlist links active at a time
  - Max 100 groups per chatlist (excess trimmed)
  - Starter mode: max 80 groups total used for posting
  - Enterprise mode: all groups used, sharded across sessions

Flow:
  1. User sends chatlist link(s) via inline button
  2. Validate each link (CheckChatlistInviteRequest)
  3. For each session: leave old chatlist(s), join new one(s)
  4. Scrape group IDs from chatlists (with forum topic detection)
  5. Save to groups/custom_<user_name>.txt
  6. Set cfg["group_file"] = custom file
  7. User can later edit the file and re-upload
"""
import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Optional

from telethon import TelegramClient
from telethon.tl.types import Channel, Chat, PeerChannel, PeerChat, InputChannel, InputPeerChannel
from telethon.errors import (
    ChatAdminRequiredError,
    ChannelPrivateError,
    FloodWaitError,
    UserDeactivatedBanError,
    AuthKeyUnregisteredError,
    SessionRevokedError,
    UserBannedInChannelError,
)
try:
    from telethon.errors import UsernameInvalidError, UsernameNotOccupiedError
except ImportError:
    UsernameInvalidError = type("UsernameInvalidError", (Exception,), {})
    UsernameNotOccupiedError = type("UsernameNotOccupiedError", (Exception,), {})
from .telethon_compat import (
    ForumTopic, GetForumTopicsRequest,
    InputChatlistDialogFilter, DialogFilterChatlist,
    GetDialogFiltersRequest, GetChatlistUpdatesRequest,
    CheckChatlistInviteRequest, JoinChatlistInviteRequest,
    GetLeaveChatlistSuggestionsRequest, LeaveChatlistRequest,
)
try:
    from telethon.tl.functions.channels import JoinChannelRequest, LeaveChannelRequest
except Exception:
    JoinChannelRequest = None
    LeaveChannelRequest = None
try:
    from telethon.errors import UserAlreadyParticipantError, InviteRequestSentError
except Exception:
    UserAlreadyParticipantError = type("UserAlreadyParticipantError", (Exception,), {})
    InviteRequestSentError = type("InviteRequestSentError", (Exception,), {})

from . import config

logger = logging.getLogger(__name__)

MAX_CHATLIST_LINKS = 2
MAX_GROUPS_PER_CHATLIST = 100
STARTER_MAX_GROUPS = 80
RESOLVE_DELAY = 0.35
TOPICS_LIMIT = 100
LEAVE_JOIN_DELAY = 1.5


def extract_slug(link: str) -> str | None:
    link = (link or "").strip().rstrip("/")
    m = re.search(r"addlist/([A-Za-z0-9_-]+)", link)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]+", link):
        return link
    return None


def is_chatlist_link(text: str) -> bool:
    return bool(re.search(r"t\.me/addlist/[A-Za-z0-9_-]+", (text or "").strip()))


def _to_marked_id(peer) -> str:
    if isinstance(peer, Chat) or isinstance(peer, PeerChat):
        raw = peer.id if isinstance(peer, Chat) else peer.chat_id
        return f"-{raw}"
    raw = _raw_channel_id(peer)
    if raw is None:
        return ""
    return f"-100{raw}"


def _raw_channel_id(peer) -> int | None:
    if isinstance(peer, Channel):
        return peer.id
    if isinstance(peer, PeerChannel):
        return peer.channel_id
    if isinstance(peer, Chat):
        return peer.id
    if isinstance(peer, PeerChat):
        return peer.chat_id
    return getattr(peer, "id", None)


def parse_group_line(line: str) -> dict:
    """Parse a group file line into structured data.
    Formats: '-100xxx', '-100xxx | topic_id', '-100xxx | topic_id | Title', '-100xxx || Title'
    Returns {"id": str, "topic": str, "title": str}."""
    parts = [p.strip() for p in line.split("|")]
    gid = parts[0] if parts else line.strip()
    topic = parts[1] if len(parts) >= 2 and parts[1] else ""
    title = parts[2] if len(parts) >= 3 else ""
    return {"id": gid, "topic": topic, "title": title}


def _line_has_topic(line: str) -> bool:
    """Check if a group file line has a topic ID (non-empty second field)."""
    parts = line.split("|")
    return len(parts) >= 2 and parts[1].strip() != ""


def format_group_line(gid: str, topic: str = "", title: str = "") -> str:
    """Build a group file line from parts."""
    safe_title = (title or "").replace("|", "-").replace("\n", " ").strip()
    if topic and safe_title:
        return f"{gid} | {topic} | {safe_title}"
    if topic:
        return f"{gid} | {topic}"
    if safe_title:
        return f"{gid} || {safe_title}"
    return gid


def _peer_is_forum(peer) -> bool:
    return isinstance(peer, Channel) and bool(getattr(peer, "forum", False))


def _is_min(ch: Channel) -> bool:
    return bool(getattr(ch, "min", False))


async def _resolve_full(client: TelegramClient, chat_obj: Channel) -> Channel | None:
    """Get a non-min Channel object with a valid access_hash."""
    username = getattr(chat_obj, "username", None)
    if not username:
        for u in (getattr(chat_obj, "usernames", None) or []):
            if getattr(u, "active", True):
                username = u.username
                break
    if username:
        try:
            full = await client.get_entity(username)
            if isinstance(full, Channel) and not _is_min(full):
                logger.debug("[Resolve] %s → resolved via username @%s (hash=%s)", chat_obj.id, username, full.access_hash)
                return full
        except (UsernameInvalidError, UsernameNotOccupiedError):
            logger.debug("[Resolve] %s → username @%s invalid/not found", chat_obj.id, username)
        except FloodWaitError as e:
            logger.warning("[Resolve] %s → FloodWait %ds on username resolve", chat_obj.id, e.seconds)
            await asyncio.sleep(e.seconds + 2)
        except Exception as e:
            logger.debug("[Resolve] %s → username resolve error: %s", chat_obj.id, e)
    try:
        full = await client.get_entity(PeerChannel(chat_obj.id))
        if isinstance(full, Channel) and not _is_min(full):
            logger.debug("[Resolve] %s → resolved via PeerChannel (hash=%s)", chat_obj.id, full.access_hash)
            return full
    except FloodWaitError as e:
        logger.warning("[Resolve] %s → FloodWait %ds on PeerChannel resolve", chat_obj.id, e.seconds)
        await asyncio.sleep(e.seconds + 2)
    except Exception as e:
        logger.warning("[Resolve] %s → PeerChannel resolve failed: %s", chat_obj.id, e)
    return None


async def _safe_get_entity(client: TelegramClient, peer_id: int):
    for attempt in range(3):
        try:
            return await client.get_entity(PeerChannel(peer_id))
        except FloodWaitError as e:
            await asyncio.sleep(e.seconds + 2)
        except (ChannelPrivateError, ChatAdminRequiredError):
            return None
        except Exception:
            return None
    return None


# ═══════════════════════════════════════════════════════════════════════════
#  TOPIC EXTRACTION — FAST VERSION
#  Optimized: cached imports, no redundant calls, parallel batching,
#  reduced history limit, minimal sleeps.
#  Old version: ~8 API calls + 3s sleeps PER forum = 10+ min for 40 forums
#  New version: ~2 API calls + 0.3s sleep PER forum + parallel batches
# ═══════════════════════════════════════════════════════════════════════════

HISTORY_LIMIT = 100  # 100 is plenty to detect most-active topic (was 300)
FORUM_BATCH_SIZE = 5  # process 5 forums in parallel


# ── Cached imports — resolved ONCE at module load, not per-call ──
_CACHED_GET_FORUM_TOPICS = "NOT_CHECKED"  # sentinel
_CACHED_FORUM_TOPIC_TYPE = "NOT_CHECKED"


def _get_forum_topics_request_class():
    global _CACHED_GET_FORUM_TOPICS
    if _CACHED_GET_FORUM_TOPICS != "NOT_CHECKED":
        return _CACHED_GET_FORUM_TOPICS
    for attempt_fn in [
        lambda: __import__("telethon.tl.functions.channels", fromlist=["GetForumTopicsRequest"]).GetForumTopicsRequest,
        lambda: getattr(getattr(__import__("telethon", fromlist=["functions"]).functions, "channels", None), "GetForumTopicsRequest", None),
        lambda: getattr(getattr(__import__("telethon", fromlist=["functions"]).functions, "channels", None), "get_forum_topics", None),
    ]:
        try:
            val = attempt_fn()
            if val is not None:
                _CACHED_GET_FORUM_TOPICS = val
                return val
        except Exception:
            pass
    _CACHED_GET_FORUM_TOPICS = None
    return None


def _get_forum_topic_type():
    global _CACHED_FORUM_TOPIC_TYPE
    if _CACHED_FORUM_TOPIC_TYPE != "NOT_CHECKED":
        return _CACHED_FORUM_TOPIC_TYPE
    try:
        from telethon.tl.types import ForumTopic as FT
        _CACHED_FORUM_TOPIC_TYPE = FT
        return FT
    except Exception:
        _CACHED_FORUM_TOPIC_TYPE = ForumTopic
        return ForumTopic


# Resolve once at module load + log
try:
    import telethon
    _tv = getattr(telethon, "__version__", "unknown")
    _gft = _get_forum_topics_request_class()
    logger.info("[Chatlist] Telethon v%s | GetForumTopicsRequest=%s", _tv, _gft is not None)
except Exception:
    pass

# Track whether GetForumTopics API actually works (tested on first call)
_API_TOPICS_WORKS: bool | None = None  # None = not tested, True/False = result


async def _call_get_forum_topics(client: TelegramClient, full_channel: Channel) -> int | None:
    """Try GetForumTopicsRequest API. Skips instantly if API was already proven broken."""
    global _API_TOPICS_WORKS
    if _API_TOPICS_WORKS is False:
        return None

    _ReqClass = _get_forum_topics_request_class()
    _TopicType = _get_forum_topic_type()
    if _ReqClass is None or _TopicType is None:
        _API_TOPICS_WORKS = False
        return None

    access_hash = getattr(full_channel, "access_hash", None)
    if not access_hash:
        return None

    try:
        result = await client(_ReqClass(
            channel=InputChannel(channel_id=full_channel.id, access_hash=access_hash),
            offset_date=0, offset_id=0, offset_topic=0, limit=100, q="",
        ))
    except FloodWaitError as e:
        await asyncio.sleep(e.seconds + 2)
        return None
    except Exception as e:
        if _API_TOPICS_WORKS is None:
            _API_TOPICS_WORKS = False
            logger.info("[Topics] GetForumTopicsRequest broken on this Telethon — disabled for all forums: %s", e)
        return None

    if not result or not result.topics:
        if _API_TOPICS_WORKS is None:
            _API_TOPICS_WORKS = True
        return None

    _API_TOPICS_WORKS = True
    real_topics = [t for t in result.topics if isinstance(t, _TopicType)]
    if not real_topics:
        return None
    return max(real_topics, key=lambda t: t.top_message).id


def _extract_topic_from_messages(messages, channel_id: int) -> int | None:
    """Pure function: extract most-active topic ID from a list of messages."""
    from collections import Counter
    counter: Counter = Counter()
    for msg in messages:
        reply = getattr(msg, "reply_to", None)
        if not reply:
            continue
        is_topic_msg = getattr(reply, "forum_topic", False)
        top_id = getattr(reply, "reply_to_top_id", None)
        msg_id = getattr(reply, "reply_to_msg_id", None)
        if is_topic_msg:
            topic_id = top_id or msg_id
            if topic_id:
                counter[topic_id] += 1
        elif top_id:
            counter[top_id] += 1
    if not counter:
        return None
    best = counter.most_common(1)[0][0]
    logger.debug("[Topics] ch=%s: topic %d from %d msgs, %d topic replies",
                 channel_id, best, len(messages), sum(counter.values()))
    return best


async def _read_history_fast(client: TelegramClient, full_channel: Channel) -> int | None:
    """Read recent messages and extract topic. Single target, no retries on non-flood errors."""
    access_hash = getattr(full_channel, "access_hash", None) or 0
    target = InputPeerChannel(channel_id=full_channel.id, access_hash=access_hash) if access_hash else full_channel
    try:
        msgs = await client.get_messages(target, limit=HISTORY_LIMIT)
        if msgs and len(msgs) > 0:
            return _extract_topic_from_messages(list(msgs), full_channel.id)
    except FloodWaitError as e:
        await asyncio.sleep(e.seconds + 2)
    except Exception as e:
        logger.debug("[Topics] ch=%s: history read failed: %s", full_channel.id, e)
    return None


async def _get_topic_for_forum(client: TelegramClient, chat_obj: Channel) -> int | None:
    """Fast single-forum topic extraction. Streamlined pipeline:
    1. Resolve entity if min (skip if already have access_hash)
    2. Try API (skips instantly if proven broken)
    3. Join → read history → leave
    """
    # Step 1: get a usable entity with access_hash
    access_hash = getattr(chat_obj, "access_hash", None)
    if not access_hash or _is_min(chat_obj):
        full = await _resolve_full(client, chat_obj)
        if full is None:
            return None
    else:
        full = chat_obj

    access_hash = getattr(full, "access_hash", None)
    if not access_hash:
        return None

    # Step 2: try API (instant skip if broken)
    topic_id = await _call_get_forum_topics(client, full)
    if topic_id is not None:
        return topic_id

    # Step 3: join → read → leave (the working strategy)
    if JoinChannelRequest is None or LeaveChannelRequest is None:
        return await _read_history_fast(client, full)

    input_ch = InputChannel(channel_id=full.id, access_hash=access_hash)
    joined_now = False
    try:
        await client(JoinChannelRequest(channel=input_ch))
        joined_now = True
        await asyncio.sleep(0.3)
    except UserAlreadyParticipantError:
        pass
    except (InviteRequestSentError, FloodWaitError):
        return None
    except Exception:
        return await _read_history_fast(client, full)

    # After joining, read history directly — no re-resolve, no second API attempt
    topic_id = await _read_history_fast(client, full)

    if joined_now:
        try:
            await client(LeaveChannelRequest(channel=input_ch))
        except Exception:
            pass

    return topic_id


async def _process_forum_batch(
    client: TelegramClient,
    forums: list[tuple[int, Channel, str, str]],
) -> dict[int, int | None]:
    """Process a batch of forums in parallel. Returns {idx: topic_id}."""
    async def _do_one(idx: int, peer: Channel) -> tuple[int, int | None]:
        try:
            tid = await _get_topic_for_forum(client, peer)
            return (idx, tid)
        except Exception as e:
            logger.debug("[Topics] batch item %d error: %s", idx, e)
            return (idx, None)

    tasks = [_do_one(idx, peer) for idx, peer, _, _ in forums]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: dict[int, int | None] = {}
    for r in results:
        if isinstance(r, tuple):
            out[r[0]] = r[1]
    return out


async def validate_chatlist_link(client: TelegramClient, link: str) -> dict:
    """Validate a chatlist link. Returns {"valid": bool, "slug": str, "peer_count": int, "error": str, "invite_result": ...}.
    The invite_result is the raw Telegram response — must be captured BEFORE joining
    because after joining, CheckChatlistInviteRequest returns ChatlistInviteAlready
    which has stripped-down channel objects without the forum flag."""
    slug = extract_slug(link)
    if not slug:
        return {"valid": False, "slug": "", "peer_count": 0, "error": "Invalid chatlist link format.", "invite_result": None}
    if CheckChatlistInviteRequest is None:
        return {"valid": False, "slug": slug, "peer_count": 0, "error": "Telethon version does not support chatlist APIs.", "invite_result": None}
    try:
        result = await client(CheckChatlistInviteRequest(slug=slug))
        peer_ids: set[int] = set()
        for attr in ("peers", "already_peers", "missing_peers"):
            for p in (getattr(result, attr, None) or []):
                cid = getattr(p, "channel_id", None) or getattr(p, "chat_id", None)
                if cid:
                    peer_ids.add(cid)
        if not peer_ids:
            for c in (getattr(result, "chats", None) or []):
                peer_ids.add(c.id)
        count = len(peer_ids)
        if count == 0:
            return {"valid": False, "slug": slug, "peer_count": 0, "error": "Chatlist is empty or expired.", "invite_result": None}
        # Log what we got for debugging
        chats = getattr(result, "chats", None) or []
        forum_count = sum(1 for c in chats if isinstance(c, Channel) and getattr(c, "forum", False))
        logger.info("[Validate] slug=%s: %d peers, %d chats, %d forums (type=%s)",
                    slug, count, len(chats), forum_count, type(result).__name__)
        return {"valid": True, "slug": slug, "peer_count": count, "error": "", "invite_result": result}
    except Exception as e:
        return {"valid": False, "slug": slug, "peer_count": 0, "error": _friendly_join_error(e), "invite_result": None}


async def scrape_chatlist_groups(
    client: TelegramClient,
    link: str,
    progress_cb: Optional[callable] = None,
    invite_result=None,
) -> list[str]:
    """Scrape group IDs from a chatlist — ported from reference script.

    Uses the SAME logic as the working extract.py:
    1. CheckChatlistInviteRequest → build raw_peers list
    2. For each peer: if it's already a Channel/Chat → use directly;
       otherwise resolve via get_entity(PeerChannel(id))
    3. Check peer_is_forum() on the RESOLVED entity
    4. For forums: call get_most_active_topic (GetForumTopics + history fallback)
    """
    slug = extract_slug(link)
    if not slug:
        return []

    result = invite_result
    if result is None:
        if CheckChatlistInviteRequest is None:
            logger.warning("scrape_chatlist_groups: CheckChatlistInviteRequest not available")
            return []
        try:
            result = await client(CheckChatlistInviteRequest(slug=slug))
        except Exception as e:
            logger.warning("scrape_chatlist_groups: CheckChatlistInvite failed: %s", e)
            return []

    # ── Build chats_map from result.chats — FULL Channel objects with forum flag ──
    # This is the KEY fix: result.chats has full Channel objects (for ChatlistInvite)
    # or min objects (for ChatlistInviteAlready). We use this as PRIMARY source
    # for entity resolution, avoiding the entity cache issue entirely.
    chats_map: dict[int, Channel | Chat] = {}
    for c in (getattr(result, "chats", None) or []):
        chats_map[c.id] = c
    forum_in_map = sum(1 for c in chats_map.values() if _peer_is_forum(c))
    logger.info("[Scrape] chats_map: %d entries, %d with forum=True, result_type=%s",
                len(chats_map), forum_in_map, type(result).__name__)

    # ── Build raw_peers exactly like reference script ──
    already = list(getattr(result, "already_peers", None) or [])
    missing = list(getattr(result, "missing_peers", None) or [])
    direct = list(getattr(result, "peers", None) or [])

    if already or missing:
        raw_peers = already + missing
        logger.info("[Scrape] ChatlistInviteAlready — %d already + %d missing = %d peers",
                    len(already), len(missing), len(raw_peers))
    elif direct:
        raw_peers = direct
        logger.info("[Scrape] ChatlistInvite — %d peers", len(raw_peers))
    elif chats_map:
        raw_peers = list(chats_map.values())
        logger.info("[Scrape] Using chats directly — %d chats", len(raw_peers))
    else:
        logger.warning("[Scrape] No peers returned for slug=%s", slug)
        return []

    total = min(len(raw_peers), MAX_GROUPS_PER_CHATLIST)
    output_lines: list[str] = []
    forum_count = 0
    forum_with_topic = 0
    skipped = 0

    # ── Phase 1: resolve all peers (fast — mostly from chats_map) ──
    pending_forums: list[tuple[int, Channel, str, str]] = []  # forums needing topic extraction

    for idx, raw_peer in enumerate(raw_peers[:total]):
        if isinstance(raw_peer, (Channel, Chat)):
            peer = raw_peer
        else:
            peer_id = _raw_channel_id(raw_peer)
            if peer_id is None:
                skipped += 1
                continue
            peer = chats_map.get(peer_id)
            if peer is None or (isinstance(peer, Channel) and _is_min(peer)):
                resolved = await _safe_get_entity(client, peer_id)
                if resolved is not None:
                    peer = resolved
            if peer is None:
                marked = _to_marked_id(raw_peer)
                output_lines.append(marked)
                continue

        marked = _to_marked_id(peer)
        title = getattr(peer, "title", "?") or "?"
        safe_title = title.replace("|", "-").replace("\n", " ").strip()

        if _peer_is_forum(peer):
            forum_count += 1
            pending_forums.append((idx, peer, marked, safe_title))
        else:
            output_lines.append(f"{marked} || {safe_title}" if safe_title else marked)

    logger.info("[Scrape] Resolved %d peers: %d plain groups, %d forums to scan, %d skipped",
                total, len(output_lines), len(pending_forums), skipped)

    if progress_cb:
        try:
            await progress_cb(f"__step:scrape_progress:0:{len(pending_forums)}:{forum_count}:0")
        except Exception:
            pass

    # ── Phase 2: extract topics from forums in parallel batches ──
    forum_results: list[str] = []
    for batch_start in range(0, len(pending_forums), FORUM_BATCH_SIZE):
        batch = pending_forums[batch_start:batch_start + FORUM_BATCH_SIZE]
        results = await _process_forum_batch(client, batch)

        for idx, peer, marked, safe_title in batch:
            topic_id = results.get(idx)
            if topic_id is not None:
                forum_results.append(f"{marked} | {topic_id} | {safe_title}")
                forum_with_topic += 1
                logger.info("[Scrape] FORUM %s \"%s\" → topic %d", marked, safe_title, topic_id)
            else:
                forum_results.append(f"{marked} || {safe_title}")
                logger.debug("[Scrape] FORUM %s \"%s\" → no topic", marked, safe_title)

        done_so_far = min(batch_start + FORUM_BATCH_SIZE, len(pending_forums))
        if progress_cb:
            try:
                await progress_cb(
                    f"__step:scrape_progress:{done_so_far}:{len(pending_forums)}:{forum_count}:{forum_with_topic}"
                )
            except Exception:
                pass

        if batch_start + FORUM_BATCH_SIZE < len(pending_forums):
            await asyncio.sleep(0.2)

    output_lines.extend(forum_results)

    logger.info("[Scrape] Done: %d groups, %d forums, %d with topic, %d skipped",
                len(output_lines), forum_count, forum_with_topic, skipped)
    return output_lines[:MAX_GROUPS_PER_CHATLIST]


def _friendly_join_error(e: Exception) -> str:
    """Convert a Telegram exception to a short human-readable reason."""
    name = type(e).__name__
    msg = str(e)

    # Session dead / deactivated / revoked
    if isinstance(e, (UserDeactivatedBanError,)):
        return "Session deactivated/banned by Telegram"
    if isinstance(e, (AuthKeyUnregisteredError,)):
        return "Session expired or logged out"
    if isinstance(e, (SessionRevokedError,)):
        return "Session revoked"
    if "USER_DEACTIVATED" in msg.upper():
        return "Session deactivated by Telegram"
    if "AUTH_KEY" in msg.upper():
        return "Session auth key invalid — re-login needed"

    # Folder / chatlist limits
    if "DIALOG_FILTERS_TOO_MUCH" in msg.upper() or "filters_too_much" in msg.lower():
        return "Too many folders — max folder limit reached"
    if "CHATLISTS_TOO_MUCH" in msg.upper():
        return "Too many chatlist folders on this session"

    # Channel join limits
    if "CHANNELS_TOO_MUCH" in msg.upper():
        return "Joined too many channels/groups — limit reached"
    if "CHANNELS_ADMIN_PUBLIC_TOO_MUCH" in msg.upper():
        return "Too many public channels"

    # Invalid / expired link
    if "INVITE_SLUG_EXPIRED" in msg.upper():
        return "Chatlist link expired"
    if "INVITE_SLUG_EMPTY" in msg.upper():
        return "Chatlist link is invalid or empty"
    if "INVITE_HASH_EXPIRED" in msg.upper():
        return "Invite link expired"

    # Spam / flood / restricted
    if "PEER_FLOOD" in msg.upper():
        return "Spam restriction — account flagged by Telegram"
    if "PREMIUM_ACCOUNT_REQUIRED" in msg.upper():
        return "Premium account required for this chatlist"

    # Privacy / banned
    if isinstance(e, ChannelPrivateError):
        return "Private channel — access denied"
    if isinstance(e, UserBannedInChannelError):
        return "Account banned from channel"

    # Frozen / connection issues
    if "CONNECTION" in msg.upper() or "TIMEOUT" in msg.upper():
        return f"Connection error — {msg[:60]}"
    if "FROZEN" in msg.upper():
        return "Session frozen by Telegram"

    # Fallback — truncate
    short = msg[:120] if len(msg) > 120 else msg
    return short or name


async def join_chatlist_on_session(
    client: TelegramClient,
    slug: str,
    session_file: str,
) -> tuple[bool, str]:
    """Join a chatlist on a single connected session. Returns (success, error_msg)."""
    if CheckChatlistInviteRequest is None or JoinChatlistInviteRequest is None:
        return False, "Telethon version does not support chatlist APIs"
    try:
        result = await client(CheckChatlistInviteRequest(slug=slug))
        # ChatlistInvite → has peers (all new, not yet joined)
        # ChatlistInviteAlready → has already_peers + missing_peers
        already = list(getattr(result, "already_peers", None) or [])
        missing = list(getattr(result, "missing_peers", None) or [])
        direct = list(getattr(result, "peers", None) or [])

        if direct:
            # Fresh chatlist (not yet joined) — join all peers
            peers_to_join = direct
        elif missing:
            # Already joined but some peers missing — join those
            peers_to_join = missing
        elif already:
            # Fully joined already — re-join with all peers to refresh entity cache
            peers_to_join = already
        else:
            peers_to_join = []

        logger.info("[Chatlist] slug=%s on %s: type=%s direct=%d already=%d missing=%d joining=%d",
                    slug, session_file, type(result).__name__,
                    len(direct), len(already), len(missing), len(peers_to_join))

        if peers_to_join:
            await client(JoinChatlistInviteRequest(
                slug=slug,
                peers=peers_to_join,
            ))
            logger.info("[Chatlist] Joined slug=%s on %s with %d peers", slug, session_file, len(peers_to_join))
        return True, ""
    except FloodWaitError as e:
        return False, f"FloodWait {e.seconds}s — rate limited"
    except Exception as e:
        return False, _friendly_join_error(e)


async def leave_chatlist_on_session(
    client: TelegramClient,
    slug: str,
    session_file: str,
) -> tuple[bool, str]:
    """Leave ALL chatlist folders on a single session. Best-effort: find all DialogFilterChatlist
    from dialog filters, then call LeaveChatlistRequest for each. Removes all to free up folder
    slots before joining new ones."""
    try:
        if not all((InputChatlistDialogFilter, DialogFilterChatlist, GetDialogFiltersRequest,
                     GetLeaveChatlistSuggestionsRequest, LeaveChatlistRequest)):
            logger.debug("[Chatlist] leave_chatlist: some compat imports missing, skipping")
            return True, ""
        filters_result = await client(GetDialogFiltersRequest())
        filters = getattr(filters_result, "filters", None) or filters_result
        chatlist_filters = [f for f in filters if isinstance(f, DialogFilterChatlist)]
        if not chatlist_filters:
            return True, ""
        removed = 0
        for target_filter in chatlist_filters:
            try:
                chatlist_input = InputChatlistDialogFilter(filter_id=target_filter.id)
                peers = await client(GetLeaveChatlistSuggestionsRequest(
                    chatlist=chatlist_input,
                ))
                await client(LeaveChatlistRequest(
                    chatlist=chatlist_input,
                    peers=peers or [],
                ))
                removed += 1
                await asyncio.sleep(0.5)
            except Exception as e:
                logger.debug("[Chatlist] leave filter_id=%s failed: %s", target_filter.id, e)
        logger.info("[Chatlist] leave_chatlist_on_session %s: removed %d/%d filters", session_file, removed, len(chatlist_filters))
        return True, ""
    except Exception as e:
        logger.debug("[Chatlist] leave_chatlist_on_session best-effort failed: %s", e)
        return True, ""


USER_GROUPS_DIR = config.GROUPS_DIR / "user groups"


def custom_group_filename(user_name: str) -> str:
    """Generate the custom group filename for a user (relative to groups/)."""
    from .utils import name_to_filename
    safe = name_to_filename(user_name)
    return f"user groups/{safe}.txt"


def save_custom_groups(user_name: str, lines: list[str]) -> Path:
    """Save scraped group lines to groups/user groups/<user>.txt. Returns the file path."""
    fn = custom_group_filename(user_name)
    path = config.GROUPS_DIR / fn
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info("[Chatlist] Saved %d groups to %s", len(lines), path)
    return path


def load_custom_groups(user_name: str) -> list[str]:
    """Load existing custom group file lines (empty list if not exists)."""
    fn = custom_group_filename(user_name)
    path = config.GROUPS_DIR / fn
    if not path.is_file():
        return []
    return [ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]


def get_chatlist_config(cfg: dict) -> dict:
    """Read the chatlist config from user cfg. Returns {"links": [...], "slugs": [...], "active": bool}."""
    cl = cfg.get("custom_chatlist") or {}
    return {
        "links": list(cl.get("links") or []),
        "slugs": list(cl.get("slugs") or []),
        "active": bool(cl.get("active", False)),
    }


def set_chatlist_config(cfg: dict, links: list[str], slugs: list[str], active: bool = True) -> None:
    """Write chatlist config into user cfg (in-place mutation)."""
    cfg["custom_chatlist"] = {
        "links": links[:MAX_CHATLIST_LINKS],
        "slugs": slugs[:MAX_CHATLIST_LINKS],
        "active": active,
        "updated_at": time.time(),
    }


def clear_chatlist_config(cfg: dict) -> None:
    """Remove chatlist config and revert to default group file."""
    cfg.pop("custom_chatlist", None)


async def process_chatlist_setup(
    bot_token: str,
    user_name: str,
    links: list[str],
    cfg: dict,
    progress_cb: Optional[callable] = None,
) -> tuple[bool, str, int]:
    """Full chatlist setup flow:
    1. Validate links
    2. Join chatlist on first session (so it becomes a member of all groups)
    3. Scrape groups WITH forum topic detection (fast — already a member)
    4. Join chatlists on remaining sessions
    5. Save custom group file + update config

    Returns (success, message, group_count).
    """
    links = [l.strip() for l in links if l.strip()][:MAX_CHATLIST_LINKS]
    if not links:
        return False, "No valid chatlist links provided.", 0

    sessions = cfg.get("sessions") or []
    if not sessions:
        return False, "No sessions configured. Cannot process chatlist.", 0

    mode = (cfg.get("mode") or "Starter").strip()
    total_sessions = sum(1 for s in sessions if s.get("file"))

    # Step 1: Connect first available session
    first_session = None
    first_client = None
    for s in sessions:
        fn = s.get("file", "")
        if not fn:
            continue
        path = config.resolve_session_path(fn)
        if not path.is_file():
            continue
        try:
            client = TelegramClient(str(path.with_suffix("")), config.API_ID, config.API_HASH, proxy=config.PROXY)
            await client.connect()
            if await client.is_user_authorized():
                # Critical: get_me() fully initializes the session + entity cache,
                # matching the reference script's client.start() behavior.
                await client.get_me()
                first_session = fn
                first_client = client
                break
            await client.disconnect()
        except Exception:
            continue
    if not first_client:
        return False, "No authorized session available to validate chatlist.", 0

    try:
        # ── Step 1: LEAVE old chatlists FIRST ──
        # This is critical: if the session already has this chatlist from a
        # previous run, CheckChatlistInviteRequest returns ChatlistInviteAlready
        # which has stripped channel objects WITHOUT forum flags.
        # By leaving first, the next CheckChatlistInviteRequest returns
        # ChatlistInvite with FULL Channel objects including forum=True.
        if progress_cb:
            await progress_cb("__step:validate")

        try:
            await leave_chatlist_on_session(first_client, "", first_session)
            await asyncio.sleep(0.5)
            logger.info("[Chatlist] Left old chatlists on first session")
        except Exception as e:
            logger.warning("[Chatlist] leave_chatlist failed (non-fatal): %s", e)

        # ── Step 2: Validate links (AFTER leaving → gets fresh ChatlistInvite) ──
        validated_slugs: list[str] = []
        invite_results: dict[str, object] = {}
        for link in links:
            info = await validate_chatlist_link(first_client, link)
            if not info["valid"]:
                await first_client.disconnect()
                return False, f"Invalid chatlist: {link}\n{info['error']}", 0
            validated_slugs.append(info["slug"])
            if info.get("invite_result"):
                invite_results[link] = info["invite_result"]

        if progress_cb:
            peer_count = info["peer_count"]
            await progress_cb(f"__step:validate:done:{peer_count}")

        # ── Step 3: Join chatlist on FIRST session ──
        if progress_cb:
            await progress_cb("__step:join_first")

        for slug in validated_slugs:
            ok, err = await join_chatlist_on_session(first_client, slug, first_session)
            if not ok:
                logger.warning("[Chatlist] First session join failed: %s", err)

        await asyncio.sleep(1.0)

        if progress_cb:
            await progress_cb("__step:join_first:done")

        # Step 3: Scrape groups (FAST — first session is now a member)
        if progress_cb:
            await progress_cb("__step:scrape")

        all_lines: list[str] = []
        for link in links:
            lines = await scrape_chatlist_groups(
                first_client, link,
                progress_cb=progress_cb,
                invite_result=invite_results.get(link),
            )
            all_lines.extend(lines)

        # Deduplicate by chat_id
        seen: set[str] = set()
        unique_lines: list[str] = []
        for line in all_lines:
            chat_part = line.split("|")[0].strip()
            if chat_part not in seen:
                seen.add(chat_part)
                unique_lines.append(line)

        # Enforce limits
        if mode == "Starter" and len(unique_lines) > STARTER_MAX_GROUPS:
            unique_lines = unique_lines[:STARTER_MAX_GROUPS]

        total_limit = MAX_GROUPS_PER_CHATLIST * MAX_CHATLIST_LINKS
        unique_lines = unique_lines[:total_limit]

        forum_lines = sum(1 for l in unique_lines if _line_has_topic(l))
        plain_lines = len(unique_lines) - forum_lines

        if not unique_lines:
            await first_client.disconnect()
            return False, "No groups found in the chatlist(s).", 0

        if progress_cb:
            await progress_cb(f"__step:scrape:done:{len(unique_lines)}:{forum_lines}")

        # Step 4: Join chatlists on ALL remaining sessions
        join_success = 1  # first session already joined
        join_failed = 0

        remaining = []
        for s in sessions:
            fn = s.get("file", "")
            if fn and fn != first_session:
                remaining.append(fn)

        if remaining:
            if progress_cb:
                await progress_cb(f"__step:join_rest:{total_sessions}")

            for fn in remaining:
                path = config.resolve_session_path(fn)
                if not path.is_file():
                    join_failed += 1
                    continue

                try:
                    sc = TelegramClient(str(path.with_suffix("")), config.API_ID, config.API_HASH, proxy=config.PROXY)
                    await sc.connect()
                    if not await sc.is_user_authorized():
                        join_failed += 1
                        await sc.disconnect()
                        continue
                    await sc.get_me()

                    try:
                        await leave_chatlist_on_session(sc, "", fn)
                    except Exception:
                        pass

                    all_ok = True
                    for slug in validated_slugs:
                        ok, err = await join_chatlist_on_session(sc, slug, fn)
                        if not ok:
                            all_ok = False
                            logger.warning("[Chatlist] Join failed on %s: %s", fn, err)
                        await asyncio.sleep(0.3)

                    await sc.disconnect()
                    if all_ok:
                        join_success += 1
                    else:
                        join_failed += 1

                    if progress_cb:
                        await progress_cb(f"__step:join_session:{join_success}:{total_sessions}")

                except Exception as e:
                    join_failed += 1
                    logger.warning("[Chatlist] Session %s error: %s", fn, e)
        else:
            # Only one session, skip join_rest step
            if progress_cb and total_sessions <= 1:
                pass  # no remaining sessions to sync

        await first_client.disconnect()

        # Step 5: Save custom group file
        save_custom_groups(user_name, unique_lines)
        group_fn = custom_group_filename(user_name)

        # Step 6: Update config
        set_chatlist_config(cfg, links, validated_slugs, active=True)
        cfg["group_file"] = group_fn

        if progress_cb:
            await progress_cb(
                f"__step:done:{len(unique_lines)}:{forum_lines}:{join_success}:{join_failed}:{group_fn}"
            )

        return True, f"{len(unique_lines)} groups ({forum_lines} forums with topics). Joined on {join_success}/{total_sessions} sessions.", len(unique_lines)

    except Exception as e:
        logger.exception("[Chatlist] process_chatlist_setup error: %s", e)
        try:
            await first_client.disconnect()
        except Exception:
            pass
        return False, f"Error: {e}", 0


def default_group_file_for_mode(mode: str) -> str:
    """Return the default group file name for a mode ('Starter' or 'Enterprise')."""
    if mode.strip().lower() == "enterprise":
        return config.DEFAULT_GROUP_FILE_ENTERPRISE
    return config.DEFAULT_GROUP_FILE_STARTER


def _load_admin_chatlist_links() -> dict:
    """Load chatlist links from admin_settings.json. Returns {"starter": [...], "enterprise": [...]}."""
    settings_path = config.DATA_DIR / "admin_settings.json"
    if settings_path.is_file():
        try:
            import json
            data = json.loads(settings_path.read_text("utf-8"))
            return data.get("chatlist_links", {})
        except Exception:
            pass
    return {}


def default_chatlist_links_for_mode(mode: str) -> list[str]:
    """Return admin-configured default chatlist links for a mode (up to 2). Falls back to env var."""
    admin_links = _load_admin_chatlist_links()
    key = "enterprise" if mode.strip().lower() == "enterprise" else "starter"
    links = admin_links.get(key, [])
    # Filter out empty strings
    links = [l.strip() for l in links if l and l.strip()]
    if links:
        return links
    # Fallback to env var (single link)
    fallback = config.DEFAULT_CHATLIST_ENTERPRISE if key == "enterprise" else config.DEFAULT_CHATLIST_STARTER
    return [fallback] if fallback else []


def default_chatlist_link_for_mode(mode: str) -> str:
    """Return the first admin-configured default chatlist link for a mode, or '' if not set."""
    links = default_chatlist_links_for_mode(mode)
    return links[0] if links else ""


async def join_default_chatlist_on_sessions(
    cfg: dict,
    mode: str,
    progress_cb: Optional[callable] = None,
) -> tuple[int, int]:
    """Join ALL default chatlist links for the given mode on all bot sessions.
    Scrapes group IDs (with forum topic detection) and saves to user's custom group file.
    Returns (joined_count, failed_count). Skips if no default chatlist is configured."""
    links = default_chatlist_links_for_mode(mode)
    if not links:
        return 0, 0

    slugs = []
    for link in links:
        slug = extract_slug(link)
        if slug:
            slugs.append(slug)
    if not slugs:
        return 0, 0

    sessions = cfg.get("sessions") or []
    joined_total = 0
    failed_total = 0
    all_group_lines: list[str] = []
    scrape_done = False

    for s in sessions:
        fn = s.get("file", "")
        if not fn:
            continue
        path = config.resolve_session_path(fn)
        if not path.is_file():
            failed_total += 1
            continue

        try:
            client = TelegramClient(str(path.with_suffix("")), config.API_ID, config.API_HASH, proxy=config.PROXY)
            await client.connect()
            if not await client.is_user_authorized():
                failed_total += 1
                await client.disconnect()
                if progress_cb:
                    await progress_cb(f"✗ {fn}: Not authorized — skipping")
                continue

            # Leave existing chatlist folders first to free slots
            try:
                await leave_chatlist_on_session(client, "", fn)
                await asyncio.sleep(LEAVE_JOIN_DELAY)
            except Exception:
                pass

            session_ok = True
            for slug in slugs:
                ok, err = await join_chatlist_on_session(client, slug, fn)
                if not ok:
                    session_ok = False
                    if progress_cb:
                        await progress_cb(f"✗ {fn}: {err}")
                await asyncio.sleep(LEAVE_JOIN_DELAY)

            # Scrape group IDs once using the first successful session
            if session_ok and not scrape_done:
                try:
                    for link in links:
                        lines = await scrape_chatlist_groups(client, link, progress_cb=progress_cb)
                        all_group_lines.extend(lines)
                    scrape_done = True
                except Exception as e:
                    logger.warning("[DefaultChatlist] Group scrape failed: %s", e)

            await client.disconnect()
            if session_ok:
                joined_total += 1
                if progress_cb:
                    await progress_cb(f"✓ {fn}: Joined all chatlist folders")
            else:
                failed_total += 1
        except Exception as e:
            failed_total += 1
            logger.warning("[DefaultChatlist] Session %s error: %s", fn, e)
            if progress_cb:
                await progress_cb(f"✗ {fn}: {e}")
        await asyncio.sleep(LEAVE_JOIN_DELAY)

    # Deduplicate by chat_id and save
    if all_group_lines:
        seen: set[str] = set()
        unique_lines: list[str] = []
        for line in all_group_lines:
            chat_part = line.split("|")[0].strip()
            if chat_part not in seen:
                seen.add(chat_part)
                unique_lines.append(line)

        user_name = cfg.get("name", "")
        if user_name and unique_lines:
            save_custom_groups(user_name, unique_lines)
            set_chatlist_config(cfg, links, slugs, active=True)
            cfg["group_file"] = custom_group_filename(user_name)
            logger.info("[DefaultChatlist] Saved %d group IDs for %s", len(unique_lines), user_name)
            if progress_cb:
                await progress_cb(f"Saved {len(unique_lines)} group IDs (with forum topics) from chatlist folders")

    if progress_cb:
        try:
            await progress_cb(f"Default chatlist: {joined_total}/{len(sessions)} sessions joined, {len(all_group_lines)} groups saved.")
        except Exception:
            pass
    logger.info("[DefaultChatlist] mode=%s joined=%d failed=%d groups=%d total=%d",
                mode, joined_total, failed_total, len(all_group_lines), len(sessions))
    return joined_total, failed_total
