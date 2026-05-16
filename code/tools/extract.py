"""
Telegram Chatlist Group ID Extractor  (with Forum Topic Detection)
===================================================================
Extracts group/channel IDs from a Telegram chatlist invite link and saves them
with the -100 prefix.

For any group that is a FORUM (has multiple topics), it finds the most-active
topic and saves the entry as:

    -100xxxxxxxxxx | <topic_id>

Plain groups / channels are saved as:

    -100xxxxxxxxxx

Requirements:
    pip install telethon

Usage:
    1. Fill in the CONFIG block below.
    2. Run:  python extract_chatlist_groups.py
    3. On first run you will be asked for your phone + OTP (and 2FA if set).
    4. Results are written to OUTPUT_FILE (default: group_ids.txt next to this script).
"""

import asyncio
import os
import re
from telethon import TelegramClient, functions
from telethon.tl.types import (
    Channel,
    Chat,
    PeerChannel,
    PeerChat,
)
from telethon.errors import (
    ChatAdminRequiredError,
    ChannelPrivateError,
    FloodWaitError,
    UsernameInvalidError,
)

try:
    from telethon.tl.types import ForumTopic
except ImportError:
    ForumTopic = None  # type: ignore

try:
    from telethon.tl.functions.channels import GetForumTopicsRequest
except ImportError:
    GetForumTopicsRequest = getattr(getattr(functions, "channels", None), "GetForumTopicsRequest", None)

# =============================================================================
#  CONFIG  <-- Edit these values before running
# =============================================================================

API_ID        = 33592373                            # Your API ID (integer)
API_HASH      = "7f06d56847fc6902a41696bc10ea5c8c"  # Your API Hash (string)
SESSION_PATH  = r"C:\Users\NCS\Downloads\Brontz.session"  # Full path to .session file
CHATLIST_LINK = "https://t.me/addlist/JC_cD1R7ibYwZmI0"  # Chat list/folder invite link

# Output file — saved in the same folder as this script by default
OUTPUT_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "group_ids.txt")

# Delay between get_entity calls to avoid flood limits (seconds)
RESOLVE_DELAY = 0.3

# How many topics to fetch per forum (100 is the Telegram API max per call)
TOPICS_LIMIT  = 100

# =============================================================================


# ── helpers ───────────────────────────────────────────────────────────────────

def resolve_session(path: str) -> str:
    path = path.strip()
    path = os.path.expandvars(os.path.expanduser(path))
    path = os.path.normpath(path)
    if path.lower().endswith(".session"):
        path = path[:-8]
    return path


def extract_slug(link: str) -> str:
    link = link.strip().rstrip("/")
    match = re.search(r"addlist/([A-Za-z0-9_-]+)", link)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]+", link):
        return link
    raise ValueError(f"Cannot parse chatlist slug from: {link!r}")


def raw_channel_id(peer) -> int | None:
    """Extract the bare channel_id from any peer object."""
    if isinstance(peer, Channel):
        return peer.id
    if isinstance(peer, PeerChannel):
        return peer.channel_id
    if isinstance(peer, Chat):
        return peer.id
    if isinstance(peer, PeerChat):
        return peer.chat_id
    return getattr(peer, "id", None)


def to_marked_id(peer) -> str:
    """Return Bot-API-style -100xxxxxxx string."""
    if isinstance(peer, Chat) or isinstance(peer, PeerChat):
        raw = peer.id if isinstance(peer, Chat) else peer.chat_id
        return f"-{raw}"
    raw = raw_channel_id(peer)
    return f"-100{raw}"


def peer_is_forum(peer) -> bool:
    return isinstance(peer, Channel) and bool(getattr(peer, "forum", False))


async def safe_get_entity(client: TelegramClient, peer_id: int, idx: int, total: int):
    """
    Resolve a raw channel_id to a full Channel object using get_entity.
    Handles FloodWait automatically with retry.
    Returns the full entity or None on failure.
    """
    for attempt in range(3):
        try:
            entity = await client.get_entity(PeerChannel(peer_id))
            return entity
        except FloodWaitError as e:
            wait = e.seconds + 2
            print(f"  [{idx:>3}/{total}] FloodWait {e.seconds}s — sleeping…")
            await asyncio.sleep(wait)
        except (ChannelPrivateError, ChatAdminRequiredError):
            # Can't access — but we still have the ID, return a placeholder
            return None
        except Exception:
            return None
    return None


# ── forum topic fetching ──────────────────────────────────────────────────────

async def get_most_active_topic(client: TelegramClient, channel: Channel):
    """
    Return the ID of the most active open topic in a forum channel.
    Returns None on any failure.
    """
    if GetForumTopicsRequest is None or ForumTopic is None:
        return None
    for attempt in range(2):
        try:
            result = await client(GetForumTopicsRequest(
                channel=channel,
                q="",
                offset_date=0,
                offset_id=0,
                offset_topic=0,
                limit=TOPICS_LIMIT,
            ))
            break
        except FloodWaitError as e:
            print(f"      [!] FloodWait {e.seconds}s fetching topics — waiting…")
            await asyncio.sleep(e.seconds + 2)
        except (ChatAdminRequiredError, ChannelPrivateError) as e:
            print(f"      [!] Cannot read topics ({type(e).__name__}).")
            return None
        except Exception as e:
            print(f"      [!] Error fetching topics: {e}")
            return None
    else:
        return None

    live = [t for t in result.topics if isinstance(t, ForumTopic)]
    if not live:
        return None

    live.sort(key=lambda t: t.top_message, reverse=True)
    open_topics = [t for t in live if not t.closed]
    best = open_topics[0] if open_topics else live[0]
    return best.id


# ── main ──────────────────────────────────────────────────────────────────────

async def main():
    if not API_ID or not API_HASH:
        print("[ERROR] Please set API_ID and API_HASH in the CONFIG section.")
        return

    try:
        slug = extract_slug(CHATLIST_LINK)
    except ValueError as e:
        print(f"[ERROR] {e}")
        return

    session = resolve_session(SESSION_PATH)

    print("=" * 60)
    print("  Telegram Chatlist Group ID Extractor")
    print("=" * 60)
    print(f"  Slug         : {slug}")
    print(f"  Session      : {session}.session")
    print(f"  Output file  : {OUTPUT_FILE}")
    print("=" * 60)
    print()

    async with TelegramClient(session, API_ID, API_HASH) as client:
        print("[*] Connected to Telegram.\n")

        # ── 1. Resolve the chatlist invite ────────────────────────────────────
        try:
            result = await client(
                functions.chatlists.CheckChatlistInviteRequest(slug=slug)
            )
        except Exception as e:
            print(f"[ERROR] Failed to resolve chatlist invite: {e}")
            return

        already = list(getattr(result, "already_peers", None) or [])
        missing = list(getattr(result, "missing_peers",  None) or [])
        direct  = list(getattr(result, "peers",          None) or [])
        legacy  = list(getattr(result, "chats",          None) or [])

        if already or missing:
            raw_peers = already + missing
            print(f"[*] Chatlist already joined — {len(raw_peers)} peers total.")
        elif direct:
            raw_peers = direct
            print(f"[*] Invite resolved — {len(raw_peers)} peers found.")
        elif legacy:
            raw_peers = legacy
            print(f"[*] Resolved {len(raw_peers)} chats (legacy API path).")
        else:
            print("[!] No peers returned. Chatlist may be empty or slug invalid.")
            return

        if not raw_peers:
            print("[!] Peer list is empty — nothing to process.")
            return

        total = len(raw_peers)
        print(f"[*] Resolving and processing {total} peers…\n")

        # ── 2. Process each peer — resolve stubs on the fly ──────────────────
        output_lines = []
        forum_count  = 0
        skipped      = 0

        for idx, raw_peer in enumerate(raw_peers, 1):

            # If it's already a full object, use it directly
            if isinstance(raw_peer, (Channel, Chat)):
                peer = raw_peer
            else:
                # It's a PeerChannel / PeerChat stub — resolve it
                peer_id = raw_channel_id(raw_peer)
                if peer_id is None:
                    print(f"  [{idx:>3}/{total}] SKIP — cannot read ID from {type(raw_peer).__name__}")
                    skipped += 1
                    continue

                peer = await safe_get_entity(client, peer_id, idx, total)
                await asyncio.sleep(RESOLVE_DELAY)  # gentle rate limiting

                if peer is None:
                    # Couldn't fully resolve, but we still have the ID — save it
                    marked = to_marked_id(raw_peer)
                    print(f"  [{idx:>3}/{total}] Group   {marked}   <private/inaccessible>")
                    output_lines.append(marked)
                    continue

            # Build marked ID and title
            marked = to_marked_id(peer)
            title  = getattr(peer, "title", "?")

            if peer_is_forum(peer):
                forum_count += 1
                print(f"  [{idx:>3}/{total}] FORUM   {marked}   \"{title}\"")
                topic_id = await get_most_active_topic(client, peer)

                if topic_id is not None:
                    line = f"{marked} | {topic_id}"
                    print(f"               └─ most-active topic ID : {topic_id}")
                else:
                    line = marked
                    print(f"               └─ topic fetch failed — saving group ID only")
            else:
                print(f"  [{idx:>3}/{total}] Group   {marked}   \"{title}\"")
                line = marked

            output_lines.append(line)

        # ── 3. Write output ───────────────────────────────────────────────────
        if not output_lines:
            print("\n[!] Nothing to save.")
            return

        out_dir = os.path.dirname(OUTPUT_FILE)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)

        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            for line in output_lines:
                f.write(line + "\n")

        print()
        print("=" * 60)
        print(f"  [✓] Done!  {len(output_lines)} entries written to:")
        print(f"       {OUTPUT_FILE}")
        print(f"  Forums with topic IDs  : {forum_count}")
        print(f"  Plain groups/channels  : {len(output_lines) - forum_count}")
        if skipped:
            print(f"  Skipped (no ID)        : {skipped}")
        print("=" * 60)

        preview = output_lines[:15]
        print(f"\n--- Preview (first {len(preview)} of {len(output_lines)}) ---")
        for line in preview:
            print(f"  {line}")
        if len(output_lines) > 15:
            print(f"  … and {len(output_lines) - 15} more lines.")


if __name__ == "__main__":
    asyncio.run(main())