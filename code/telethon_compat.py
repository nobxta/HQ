"""
Telethon compatibility layer.

1. Skip unknown TL constructor IDs instead of crashing the recv loop.
2. Provide version-safe imports for APIs that moved/were removed between Telethon versions.

Works with Telethon 1.36+ and 1.43+.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Version-safe imports: try direct import first, then functions.* namespace
# ---------------------------------------------------------------------------

from telethon import functions

# -- ForumTopic type --
try:
    from telethon.tl.types import ForumTopic
except ImportError:
    ForumTopic = None  # type: ignore

# -- GetForumTopicsRequest --
try:
    from telethon.tl.functions.channels import GetForumTopicsRequest
except Exception:
    try:
        GetForumTopicsRequest = functions.channels.GetForumTopicsRequest
    except Exception:
        try:
            # Telethon 1.43+ uses snake_case function names
            GetForumTopicsRequest = functions.channels.get_forum_topics
        except Exception:
            GetForumTopicsRequest = None

# -- InputChatlistDialogFilter --
try:
    from telethon.tl.types import InputChatlistDialogFilter
except ImportError:
    try:
        InputChatlistDialogFilter = functions.chatlists.InputChatlistDialogFilter
    except AttributeError:
        InputChatlistDialogFilter = None  # type: ignore

# -- DialogFilterChatlist --
try:
    from telethon.tl.types import DialogFilterChatlist
except ImportError:
    DialogFilterChatlist = None  # type: ignore

# -- GetDialogFiltersRequest --
try:
    from telethon.tl.functions.messages import GetDialogFiltersRequest
except ImportError:
    try:
        GetDialogFiltersRequest = functions.messages.GetDialogFiltersRequest
    except AttributeError:
        GetDialogFiltersRequest = None

# -- Chatlist functions (always available via functions.chatlists.*) --
try:
    from telethon.tl.functions.chatlists import GetChatlistUpdatesRequest
except ImportError:
    try:
        GetChatlistUpdatesRequest = functions.chatlists.GetChatlistUpdatesRequest
    except AttributeError:
        GetChatlistUpdatesRequest = None

try:
    from telethon.tl.functions.chatlists import CheckChatlistInviteRequest
except ImportError:
    try:
        CheckChatlistInviteRequest = functions.chatlists.CheckChatlistInviteRequest
    except AttributeError:
        CheckChatlistInviteRequest = None

try:
    from telethon.tl.functions.chatlists import JoinChatlistInviteRequest
except ImportError:
    try:
        JoinChatlistInviteRequest = functions.chatlists.JoinChatlistInviteRequest
    except AttributeError:
        JoinChatlistInviteRequest = None

try:
    from telethon.tl.functions.chatlists import GetLeaveChatlistSuggestionsRequest
except ImportError:
    try:
        GetLeaveChatlistSuggestionsRequest = functions.chatlists.GetLeaveChatlistSuggestionsRequest
    except AttributeError:
        GetLeaveChatlistSuggestionsRequest = None

try:
    from telethon.tl.functions.chatlists import LeaveChatlistRequest
except ImportError:
    try:
        LeaveChatlistRequest = functions.chatlists.LeaveChatlistRequest
    except AttributeError:
        LeaveChatlistRequest = None


# Log what we found
_available = []
_missing = []
for _name, _obj in [
    ("ForumTopic", ForumTopic),
    ("GetForumTopicsRequest", GetForumTopicsRequest),
    ("InputChatlistDialogFilter", InputChatlistDialogFilter),
    ("DialogFilterChatlist", DialogFilterChatlist),
    ("GetDialogFiltersRequest", GetDialogFiltersRequest),
    ("GetChatlistUpdatesRequest", GetChatlistUpdatesRequest),
    ("CheckChatlistInviteRequest", CheckChatlistInviteRequest),
    ("JoinChatlistInviteRequest", JoinChatlistInviteRequest),
    ("GetLeaveChatlistSuggestionsRequest", GetLeaveChatlistSuggestionsRequest),
    ("LeaveChatlistRequest", LeaveChatlistRequest),
]:
    (_available if _obj else _missing).append(_name)

if _missing:
    logger.warning("Telethon compat: MISSING (features disabled): %s", ", ".join(_missing))
if _available:
    logger.debug("Telethon compat: available: %s", ", ".join(_available))


# ---------------------------------------------------------------------------
# Monkey-patch: skip unknown TL constructor IDs instead of crashing recv loop
# ---------------------------------------------------------------------------

_PATCH_APPLIED = False
_LOGGED_IDS: set[int] = set()


def apply_telethon_unknown_type_patch() -> None:
    """Patch Telethon to skip updates with unknown TL constructor IDs instead of crashing."""
    global _PATCH_APPLIED
    if _PATCH_APPLIED:
        return
    try:
        from telethon.errors.common import TypeNotFoundError
        from telethon.network import mtprotosender
    except ImportError as e:
        logger.warning("Telethon compat: could not import telethon: %s", e)
        return

    MTProtoSender = mtprotosender.MTProtoSender
    _original_process_message = MTProtoSender._process_message

    async def _patched_process_message(self: Any, message: Any) -> None:
        try:
            await _original_process_message(self, message)
        except TypeNotFoundError as e:
            cid = getattr(e, "invalid_constructor_id", None) or getattr(e, "id", None)
            if cid is not None and cid not in _LOGGED_IDS:
                _LOGGED_IDS.add(cid)
                logger.warning(
                    "Telethon: skipping update with unknown constructor ID %s (0x%08X); "
                    "connection will stay alive. See code/telethon_compat.py.",
                    cid, cid & 0xFFFFFFFF,
                )
            return

    MTProtoSender._process_message = _patched_process_message
    _PATCH_APPLIED = True
    logger.debug("Telethon compat: applied unknown-type skip patch")
