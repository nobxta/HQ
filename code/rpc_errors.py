"""
Centralized Telethon RPC error handling for AdBot.

Error categories (from Telethon errors.csv):
- FLOOD: FloodWait, SlowmodeWait, PeerFlood, TakeoutInitDelay, etc. → retry after sleep
- SESSION_DEAD: AuthKeyInvalid, SessionRevoked, UserDeactivated, PhoneNumberBanned → mark session dead
- SKIP_GROUP: ChannelPrivate, ChatWriteForbidden, UserBannedInChannel, ChatForbidden → skip this group
- MESSAGE: MessageEmpty, MessageTooLong, MediaInvalid, FileReferenceExpired → skip/retry message
- NETWORK: Timeout, RpcCallFail, Migrate (303) → retry with backoff
- PERMISSION: ChatAdminRequired, RightForbidden → skip group or log
- UNKNOWN: catch-all, log and skip (never crash)
"""

import asyncio
import logging
from enum import Enum
from typing import Any, Callable, Coroutine, Type

from telethon import errors as tl_errors

logger = logging.getLogger(__name__)


# --- Action outcomes for the caller ---
class AdBotAction(Enum):
    RETRY = "retry"           # Sleep (if seconds) + retry same action
    SKIP_GROUP = "skip_group" # Skip this group/target, continue cycle
    SLEEP_ACCOUNT = "sleep_account"  # Pause this account/session for a while
    MARK_SESSION_BANNED = "mark_session_banned"  # Move session to dead, replace
    STOP_BOT = "stop_bot"     # Stop bot entirely (rare)
    IGNORE = "ignore"         # Log and continue (e.g. message not modified)


# --- Resolve optional Telethon error classes by name (CSV name -> Python class) ---
def _error_class(name: str) -> Type[Exception] | None:
    """Map CSV error name (e.g. FLOOD_WAIT_X) to Telethon class (e.g. FloodWaitError)."""
    # Telethon: FLOOD_WAIT_X -> FloodWaitError (strip _X, title case, add Error)
    base = name.split("_")[0] if "_" in name else name
    for suffix in ("", "Error"):
        for part in (name, base):
            # Try exact: FloodWaitError, FloodWait
            c = part.replace("_", "").replace("X", "").replace(" ", "")
            if not c:
                continue
            cls_name = c[0].upper() + c[1:].lower() + suffix
            if not cls_name.endswith("Error"):
                cls_name = cls_name + "Error"
            ex = getattr(tl_errors, cls_name, None)
            if ex is not None and isinstance(ex, type):
                return ex
    # Try common patterns
    mapping = {
        "FLOOD_WAIT": "FloodWaitError",
        "SLOWMODE_WAIT": "SlowModeWaitError",
        "PEER_FLOOD": "PeerFloodError",
        "USER_BANNED_IN_CHANNEL": "UserBannedInChannelError",
        "CHANNEL_PRIVATE": "ChannelPrivateError",
        "CHAT_WRITE_FORBIDDEN": "ChatWriteForbiddenError",
        "CHAT_FORBIDDEN": "ChatForbiddenError",
        "INVITE_HASH_EXPIRED": "InviteHashExpiredError",
        "INVITE_HASH_INVALID": "InviteHashInvalidError",
        "USER_NOT_PARTICIPANT": "UserNotParticipantError",
        "CHANNEL_INVALID": "ChannelInvalidError",
        "CHAT_ID_INVALID": "ChatIdInvalidError",
        "FILE_REFERENCE_EXPIRED": "FileReferenceExpiredError",
        "FILE_REFERENCE_INVALID": "FileReferenceInvalidError",
        "MESSAGE_ID_INVALID": "MessageIdInvalidError",
        "MESSAGE_EDIT_TIME_EXPIRED": "MessageEditTimeExpiredError",
        "CHAT_FORWARDS_RESTRICTED": "ChatForwardsRestrictedError",
        "AUTH_KEY_INVALID": "AuthKeyInvalidError",
        "AUTH_KEY_UNREGISTERED": "AuthKeyUnregisteredError",
        "SESSION_REVOKED": "SessionRevokedError",
        "USER_DEACTIVATED": "UserDeactivatedError",
        "USER_DEACTIVATED_BAN": "UserDeactivatedBanError",
        "PHONE_NUMBER_BANNED": "PhoneNumberBannedError",
        "AUTH_KEY_DUPLICATED": "AuthKeyDuplicatedError",
        "RPC_CALL_FAIL": "RPCError",  # generic 500
        "Timedout": "TimedOutError",
        "Timeout": "TimedOutError",
    }
    for key, cls_name in mapping.items():
        if key in name.upper():
            ex = getattr(tl_errors, cls_name, None)
            if ex is not None and isinstance(ex, type):
                return ex
    return None


# Build sets of exception types by category (lazy so we only depend on what exists)
def _session_dead_errors() -> tuple[Type[Exception], ...]:
    errs = [
        tl_errors.AuthKeyInvalidError,
        tl_errors.AuthKeyUnregisteredError,
        tl_errors.SessionRevokedError,
        getattr(tl_errors, "SessionExpiredError", None),
        getattr(tl_errors, "UserDeactivatedError", None),
        getattr(tl_errors, "UserDeactivatedBanError", None),
        getattr(tl_errors, "PhoneNumberBannedError", None),
        getattr(tl_errors, "AuthKeyDuplicatedError", None),
        _error_class("FROZEN_METHOD_INVALID"),
        _error_class("FROZEN_PARTICIPANT_MISSING"),
    ]
    return tuple(e for e in errs if e is not None)


def _flood_wait_errors() -> tuple[Type[Exception], ...]:
    errs = [
        tl_errors.FloodWaitError,
        getattr(tl_errors, "SlowModeWaitError", None),
        getattr(tl_errors, "TakeoutInitDelayError", None),
        getattr(tl_errors, "FloodTestPhoneWaitError", None),
        getattr(tl_errors, "FloodPremiumWaitError", None),
    ]
    return tuple(e for e in errs if e is not None)


def _skip_group_errors() -> tuple[Type[Exception], ...]:
    errs = [
        getattr(tl_errors, "ChannelPrivateError", None),
        getattr(tl_errors, "ChatWriteForbiddenError", None),
        getattr(tl_errors, "ChatForbiddenError", None),
        getattr(tl_errors, "UserBannedInChannelError", None),
        getattr(tl_errors, "InviteHashExpiredError", None),
        getattr(tl_errors, "InviteHashInvalidError", None),
        getattr(tl_errors, "UserNotParticipantError", None),
        getattr(tl_errors, "ChatAdminRequiredError", None),
        getattr(tl_errors, "ChannelInvalidError", None),
        getattr(tl_errors, "ChatIdInvalidError", None),
        getattr(tl_errors, "ChannelForumMissingError", None),
        getattr(tl_errors, "TopicDeletedError", None),
        getattr(tl_errors, "MessageThreadInvalidError", None),
    ]
    return tuple(e for e in errs if e is not None)


def _retryable_errors() -> tuple[Type[Exception], ...]:
    """Network / transient: retry with backoff."""
    errs = [
        getattr(tl_errors, "TimedOutError", None),
        getattr(tl_errors, "RPCError", None),  # 500
        getattr(tl_errors, "InvalidDCError", None),  # 303 migrate
    ]
    return tuple(e for e in errs if e is not None)


def _message_skip_errors() -> tuple[Type[Exception], ...]:
    """Message/media issues: skip this send, continue."""
    errs = [
        getattr(tl_errors, "MessageEmptyError", None),
        getattr(tl_errors, "MessageTooLongError", None),
        getattr(tl_errors, "FileReferenceExpiredError", None),
        getattr(tl_errors, "FileReferenceInvalidError", None),
        getattr(tl_errors, "MessageEditTimeExpiredError", None),
        getattr(tl_errors, "ChatForwardsRestrictedError", None),
        getattr(tl_errors, "MessageIdInvalidError", None),
        getattr(tl_errors, "MediaInvalidError", None),
        getattr(tl_errors, "MessageNotModifiedError", None),
    ]
    return tuple(e for e in errs if e is not None)


def _topic_skip_errors() -> tuple[Type[Exception], ...]:
    """Topic/forum errors: skip group and treat as permanent (blacklist topic)."""
    errs = [
        getattr(tl_errors, "ChannelForumMissingError", None),
        getattr(tl_errors, "TopicDeletedError", None),
        getattr(tl_errors, "MessageThreadInvalidError", None),
    ]
    return tuple(e for e in errs if e is not None)


_TOPIC_PATTERNS = ("thread", "topic", "forum", "message_thread", "messagethread")

# Patterns that indicate permanent (unwritable) group errors for Enterprise pruning
_PERMANENT_ERROR_PATTERNS = (
    "chat_send_plain_forbidden",
    "topic_closed",
    "chat_write_forbidden",
    "chat write forbidden",
    "user_banned_in_channel",
    "channel_private",
    "channel is private",
    "allow_payment_required_3",
    "you can't write in this chat",
    "you cannot write in this chat",
    "the chat is restricted",
    "restricted and cannot be used",
)
# RPC codes: 400/403 that are not FloodWait are treated as permanent for group pruning
_PERMANENT_RPC_CODES = (400, 403)


# Cache (export SESSION_DEAD for utils.validate_session / users posting)
SESSION_DEAD_ERRORS = _session_dead_errors()
_SESSION_DEAD = SESSION_DEAD_ERRORS
_FLOOD = _flood_wait_errors()
_SKIP_GROUP = _skip_group_errors()
_TOPIC_SKIP = _topic_skip_errors()
_RETRYABLE = _retryable_errors()
_MESSAGE_SKIP = _message_skip_errors()


def is_permanent_error(exc: Exception) -> bool:
    """Return True if the error is a permanent group/channel failure (do not retry every cycle).
    Used in Enterprise to prune dead groups. FloodWait and other retryable errors return False."""
    if exc is None:
        return False
    t = type(exc)
    err_str = str(exc).lower()
    # Never treat FloodWait / SlowMode as permanent
    if t in _FLOOD:
        return False
    if "flood" in err_str and "wait" in err_str:
        return False
    # Explicit permanent types (Telethon names)
    if t in _SKIP_GROUP:
        return True
    for p in _PERMANENT_ERROR_PATTERNS:
        if p in err_str:
            return True
    # 400/403 that are not FloodWait → permanent (e.g. TOPIC_CLOSED, CHAT_SEND_PLAIN_FORBIDDEN)
    code = getattr(exc, "code", None)
    if code in _PERMANENT_RPC_CODES:
        return True
    return False


class AdBotErrorHandler:
    """
    Centralized handler for Telethon RPC errors in AdBot.
    Use handle() to classify an exception and get action + optional seconds to sleep.
    """

    def __init__(
        self,
        *,
        session_id: str = "",
        group_id: Any = None,
        action_name: str = "",
    ):
        self.session_id = session_id
        self.group_id = group_id
        self.action_name = action_name
        self.last_skip_was_topic: bool = False
        self.last_error: Exception | None = None  # Set in handle(); caller can use for failure log when with_retry returns None

    def _log(self, level: int, msg: str, exc: Exception) -> None:
        ctx = []
        if self.session_id:
            ctx.append(f"session={self.session_id}")
        if self.group_id is not None:
            ctx.append(f"group={self.group_id}")
        if self.action_name:
            ctx.append(f"action={self.action_name}")
        prefix = " ".join(ctx)
        logger.log(level, "RPC %s: %s — %s", prefix, type(exc).__name__, exc)

    def _is_topic_skip(self, t: Type[Exception], err_str: str) -> bool:
        if t in _TOPIC_SKIP:
            return True
        return any(p in err_str for p in _TOPIC_PATTERNS)

    def handle(self, exc: Exception) -> tuple[AdBotAction, int]:
        """
        Classify exception and return (action, seconds_to_sleep).
        seconds_to_sleep: 0 unless action is RETRY and we have FloodWait/SlowMode seconds.
        Sets last_skip_was_topic when SKIP_GROUP is due to topic/forum errors (for blacklisting).
        """
        self.last_skip_was_topic = False
        self.last_error = exc
        t = type(exc)
        err_str = str(exc).lower()

        # 1) Session dead → mark session banned, stop using this session
        if t in _SESSION_DEAD:
            self._log(logging.WARNING, "session dead", exc)
            return AdBotAction.MARK_SESSION_BANNED, 0

        # 2) FloodWait / SlowModeWait → retry after N seconds
        if t in _FLOOD:
            seconds = getattr(exc, "seconds", None) or 0
            if isinstance(seconds, (int, float)) and seconds > 0:
                self._log(logging.INFO, f"flood/slowmode wait {seconds}s", exc)
                return AdBotAction.RETRY, int(seconds)
            return AdBotAction.RETRY, 60  # default 1 min

        # PeerFlood (400): too many requests globally → sleep account
        if "peer" in err_str and "flood" in err_str:
            self._log(logging.WARNING, "peer flood", exc)
            return AdBotAction.SLEEP_ACCOUNT, 3600  # 1 hour

        # 3) Skip this group/target (permission, private, banned in channel)
        if t in _SKIP_GROUP:
            self._log(logging.INFO, "skip group", exc)
            self.last_skip_was_topic = self._is_topic_skip(t, err_str)
            return AdBotAction.SKIP_GROUP, 0

        if any(x in err_str for x in (
            "channel is private", "chat write forbidden", "forbidden", "you're banned",
            "banned from sending", "not a participant", "invite hash expired", "invite hash invalid",
            "entity", "corresponding", "cannot find", "no entity", "thread", "topic", "forum",
        )):
            self._log(logging.INFO, "skip group (message)", exc)
            self.last_skip_was_topic = self._is_topic_skip(t, err_str)
            return AdBotAction.SKIP_GROUP, 0

        # 4) Message/media issues → skip this message, continue
        if t in _MESSAGE_SKIP:
            self._log(logging.INFO, "message/media skip", exc)
            return AdBotAction.IGNORE, 0

        if any(x in err_str for x in (
            "message not modified", "file reference", "media invalid", "message empty",
            "message too long", "forwards restricted",
        )):
            return AdBotAction.IGNORE, 0

        # 5) Network / timeout / 500 / migrate → retry with backoff
        if t in _RETRYABLE:
            self._log(logging.WARNING, "retryable error", exc)
            return AdBotAction.RETRY, 30

        if "303" in err_str or "migrate" in err_str or "timeout" in err_str or "timed out" in err_str:
            return AdBotAction.RETRY, 15

        # 6) Unknown: do not crash — log and skip
        self._log(logging.WARNING, "unknown RPC, skipping", exc)
        return AdBotAction.IGNORE, 0


# --- FloodWait classification thresholds ---
# Short (≤60s): almost always group-level → skip group, continue session normally
# Mid (61–300s): uncertain → skip group, slow down session gap ×2 as precaution
# Long (>3600s): almost always account-level → pause entire session
GROUP_FLOOD_THRESHOLD_SEC = 60
FLOODWAIT_THRESHOLD_SEC = 3600


class FloodWaitPause(Exception):
    """Raised when FloodWait seconds exceed FLOODWAIT_THRESHOLD_SEC. Caller must mark session PAUSED and not sleep in loop."""
    def __init__(self, seconds: int):
        self.seconds = seconds
        super().__init__(f"FloodWait {seconds}s exceeds threshold; session should be marked PAUSED")


class FloodWaitGroupSkip(Exception):
    """Raised for short/mid FloodWait (≤ FLOODWAIT_THRESHOLD_SEC). Caller should skip this group and continue posting to others.
    slow_down=True when in mid-range (60–300s) so caller can multiply gap as precaution."""
    def __init__(self, seconds: int, chat_id: int = 0, slow_down: bool = False):
        self.seconds = seconds
        self.chat_id = chat_id
        self.slow_down = slow_down
        super().__init__(f"FloodWait {seconds}s on group {chat_id}; skip group, slow_down={slow_down}")


# --- Retry with backoff (for FloodWait and other retryable) ---
DEFAULT_MAX_TRIES = 4
DEFAULT_BACKOFF = 1.5


async def with_retry(
    coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    handler: AdBotErrorHandler | None = None,
    max_tries: int = DEFAULT_MAX_TRIES,
    backoff: float = DEFAULT_BACKOFF,
) -> Any:
    """
    Execute coro_factory() with retry on FloodWait and retryable errors.
    coro_factory must return a new coroutine each time (e.g. lambda: client.send_message(...)).
    On SESSION_DEAD / MARK_SESSION_BANNED re-raises so caller can mark session dead.
    On SKIP_GROUP / IGNORE returns None (caller should skip).
    """
    handler = handler or AdBotErrorHandler()
    last_exc: Exception | None = None
    for attempt in range(max_tries):
        try:
            return await coro_factory()
        except Exception as e:
            last_exc = e
            action, seconds = handler.handle(e)
            if action == AdBotAction.MARK_SESSION_BANNED:
                raise
            if action == AdBotAction.SKIP_GROUP or action == AdBotAction.IGNORE:
                return None
            if action == AdBotAction.RETRY and seconds > 0:
                # Long FloodWait (>3600s): account-level → pause entire session.
                if seconds > FLOODWAIT_THRESHOLD_SEC:
                    logger.info(
                        "FloodWait: session will be marked PAUSED for %.0fs (attempt %s/%s); not sleeping in loop",
                        seconds, attempt + 1, max_tries,
                    )
                    raise FloodWaitPause(seconds)
                # Short/mid FloodWait (≤3600s): likely group-level → skip this group, let caller continue to next group.
                # Extract chat_id from handler context if available.
                _fwg_chat_id = getattr(handler, "group_id", 0) or 0
                _fwg_slow_down = seconds > GROUP_FLOOD_THRESHOLD_SEC  # mid-range: 61–300s → slow down
                logger.info(
                    "FloodWait: group-level skip for %ss on chat_id=%s (attempt %s/%s, slow_down=%s)",
                    seconds, _fwg_chat_id, attempt + 1, max_tries, _fwg_slow_down,
                )
                raise FloodWaitGroupSkip(seconds, chat_id=int(_fwg_chat_id) if _fwg_chat_id else 0, slow_down=_fwg_slow_down)
            if action == AdBotAction.SLEEP_ACCOUNT and seconds > 0:
                logger.warning("Sleeping account for %s s (then skipping this action)", min(seconds, 3600))
                await asyncio.sleep(min(seconds, 3600))
                return None  # Skip this action; caller can continue to next group
            # Fallback: retry after 30s
            if attempt < max_tries - 1:
                await asyncio.sleep(30 * (backoff ** attempt))
    if last_exc:
        raise last_exc
    return None


# --- Safe wrappers for common AdBot actions ---
async def safe_send_message(
    client: Any,
    entity: Any,
    text: str,
    handler: AdBotErrorHandler | None = None,
    **kwargs: Any,
) -> Any | None:
    """Send message; returns message or None on skip/error. Never crashes on known RPC."""
    h = handler or AdBotErrorHandler(action_name="send_message")
    try:
        return await with_retry(
            lambda: client.send_message(entity, text, **kwargs),
            handler=h,
        )
    except Exception as e:
        action, _ = h.handle(e)
        if action == AdBotAction.MARK_SESSION_BANNED:
            raise
        return None


async def safe_forward_messages(
    client: Any,
    entity: Any,
    message_ids: int | list[int],
    from_peer: Any,
    handler: AdBotErrorHandler | None = None,
    **kwargs: Any,
) -> Any | None:
    """Forward messages; returns result or None. Never crashes on known RPC."""
    h = handler or AdBotErrorHandler(action_name="forward_messages")
    try:
        return await with_retry(
            lambda: client.forward_messages(entity, message_ids, from_peer, **kwargs),
            handler=h,
        )
    except Exception as e:
        action, _ = h.handle(e)
        if action == AdBotAction.MARK_SESSION_BANNED:
            raise
        return None


async def safe_join_chat(
    join_coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    handler: AdBotErrorHandler | None = None,
) -> bool:
    """Run join (e.g. join_chat_by_link) with retry; returns True if ok, False on skip. Never crashes.
    Example: safe_join_chat(lambda: join_chat_by_link(client, link), AdBotErrorHandler(session_id=fn, action_name='join_chat'))
    """
    h = handler or AdBotErrorHandler(action_name="join_chat")
    try:
        await with_retry(join_coro_factory, handler=h)
        return True
    except Exception as e:
        action, _ = h.handle(e)
        if action == AdBotAction.MARK_SESSION_BANNED:
            raise
        return False
