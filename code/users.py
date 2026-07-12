"""User AdBot logic (dynamic bots per user)."""
import asyncio
import hashlib
import logging
import multiprocessing
import queue
import random
import re
import shutil
import string
import tempfile
import threading
import time
import zipfile
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from telethon import TelegramClient, events, Button
from telethon import errors as tl_errors
from telethon.tl.functions.messages import ForwardMessagesRequest

try:
    from telethon.errors.rpcerrorlist import MessageNotModifiedError
except ImportError:
    MessageNotModifiedError = type("MessageNotModifiedError", (Exception,), {})

from . import config
from . import bot_ptb
from . import notify
from . import dm_inbox
from .ui.emoji_entities_telethon import build_panel_message, panel_button
from .user_config import get_plan_mode
from .maintenance import (
    MAINTENANCE_MESSAGE,
    add_to_maintenance_queue,
    is_maintenance_enabled,
)
from .rpc_errors import AdBotErrorHandler, AdBotAction, with_retry, SESSION_DEAD_ERRORS, FloodWaitPause, FloodWaitGroupSkip, FLOODWAIT_THRESHOLD_SEC, GROUP_FLOOD_THRESHOLD_SEC, is_permanent_error
from . import session_guard
from .session_guard import SessionBusyError
from .utils import save_pool, load_pool, load_adbot, save_adbot, get_name_by_token, load_user_data, save_user_data, load_stats, save_stats, with_floodwait_retry, add_admin_alert, format_session_death_admin_message, get_bot_log_path, get_session_user, join_chat_by_link, recreate_log_group_for_bot, log_bot_event, append_to_user_log, register_for_shutdown, register_session_active_check, unregister_for_shutdown, validate_session, SESSION_POOL_LOCK
from .repair import (
    repair_fix_log_group,
    repair_fix_config,
    repair_fix_bot_token,
    repair_fix_sessions,
    repair_replace_session,
)
from .replacement import (
    check_and_flag_failing_sessions,
    create_replacement_request,
    get_free_replacements_remaining,
    get_pending_replacements_for_bot,
    get_session_replacement_price,
    process_ready_replacements,
)

# Log-group messages are sent via python-telegram-bot (PTB) using the AdBot's bot token, not Telethon.
# Bounded so enqueue never blocks the posting path; drop new items if full (posting must not wait on log)
_LOG_QUEUE_MAXSIZE = 500


@dataclass
class _LogItem:
    bot_token: str
    msg: str
    parse_mode: str | None = None
    buttons: list[tuple[str, str]] | None = None
    entities: list["MessageEntity"] | None = None
    batchable: bool = True


_log_queue: "queue.Queue[_LogItem]" = queue.Queue(maxsize=_LOG_QUEUE_MAXSIZE)
BOT_CLIENTS: dict[str, Any] = {}
# When user clicks Run we show activation message; store (chat_id, message_id) to edit when started/stopped.
_activation_message: dict[str, tuple[int, int]] = {}
# Start protection: bot_token -> {"running": bool, "started_ts": float}. Prevents duplicate start; health monitor checks before restart.
bot_runtime_state: dict[str, dict] = {}
# When _start_posting returns False, reason for Run UI: "no_sessions" | "no_valid_sessions" | "no_groups" | "suspended" | "no_cfg" | None
_last_start_failure_reason: dict[str, str] = {}
# Pending health check tokens: set of bot_tokens that need async SpamBot check
_pending_health_checks: set[str] = set()
_health_check_lock = threading.Lock()
_health_check_bg_task: asyncio.Task | None = None


def enqueue_log(
    bot_token: str,
    msg: str,
    parse_mode: str | None = None,
    buttons: list[tuple[str, str]] | None = None,
    entities: list["MessageEntity"] | None = None,
    batchable: bool = True,
) -> None:
    """Enqueue a log-group message to be sent by the controller bot. parse_mode 'md' for [text](url).
    buttons: optional list of (text, url) for inline buttons. entities: premium custom-emoji/bold
    entities (do not pass parse_mode at the same time — Telegram drops entities otherwise); when
    multiple entity-bearing items land in the same batch window, their entities are combined with
    recomputed offsets. batchable=False forces the message to send on its own (e.g. standalone
    alerts that shouldn't be visually merged with unrelated lines).
    Non-blocking: never blocks posting loop."""
    try:
        _log_queue.put_nowait(_LogItem(bot_token, msg, parse_mode, buttons, entities, batchable))
    except queue.Full:
        pass


# Max post-result lines to batch into one log-group message (reduces flood when posting fast)
_LOG_BATCH_SIZE = 5
# Drain up to this many items so we have enough post results to fill 5-line batches (cycle-start lines are sent separately)
_LOG_DRAIN_MAX = 30


def _is_cycle_start_log(msg: str) -> bool:
    """True if message is 'session.session N groups' (cycle start); send these separately, do not batch with post results."""
    s = (msg or "").strip()
    return ".session" in s and " groups" in s


# Delay between log-group sends to avoid rate limit / timeout (PTB)
_LOG_SEND_DELAY_SEC = 0.18

# After first item, wait this long to collect more so we batch 5 post-results per message
_LOG_COLLECT_WAIT_SEC = 0.35

# Cache for load_adbot() inside log consumer — avoids full disk read on every batch
_LOG_ADBOT_CACHE: dict = {}
_LOG_ADBOT_CACHE_TS: float = 0.0
_LOG_ADBOT_CACHE_TTL: float = 30.0  # reload from disk at most every 30s


def _get_adbot_cached() -> dict:
    """Return adbot data with time-based caching for the log consumer hot path."""
    global _LOG_ADBOT_CACHE, _LOG_ADBOT_CACHE_TS
    now = time.time()
    if now - _LOG_ADBOT_CACHE_TS > _LOG_ADBOT_CACHE_TTL or not _LOG_ADBOT_CACHE:
        _LOG_ADBOT_CACHE = load_adbot()
        _LOG_ADBOT_CACHE_TS = now
    return _LOG_ADBOT_CACHE


def _join_items_with_entities(chunk: list["_LogItem"]) -> tuple[str, list["MessageEntity"]]:
    """Join a batch's message texts with '\\n', recomputing each item's entity offsets
    (UTF-16 code units) by the cumulative length of everything already emitted. PTB entities
    are immutable, so each is rebuilt at its shifted offset rather than mutated in place."""
    from telegram import MessageEntity
    from .ui.emoji_entities import u16len

    parts: list[str] = []
    combined: list[MessageEntity] = []
    u16 = 0
    for i, item in enumerate(chunk):
        if i > 0:
            parts.append("\n")
            u16 += 1
        for ent in (item.entities or []):
            kwargs: dict[str, Any] = {"type": ent.type, "offset": u16 + ent.offset, "length": ent.length}
            if ent.type == MessageEntity.CUSTOM_EMOJI:
                kwargs["custom_emoji_id"] = ent.custom_emoji_id
            elif ent.type == MessageEntity.TEXT_LINK:
                kwargs["url"] = ent.url
            combined.append(MessageEntity(**kwargs))
        parts.append(item.msg)
        u16 += u16len(item.msg)
    return "".join(parts), combined


async def _log_queue_consumer() -> None:
    """Run on main asyncio loop: drain _log_queue and send via PTB to log group.
    Cycle-start lines are batched per bot. Post results (and other batchable items, including
    ones carrying premium-emoji entities) are batched 5 per message, with entity offsets
    recombined via _join_items_with_entities(). Items with buttons, or explicitly marked
    non-batchable, are sent individually. Link preview off."""
    while True:
        await asyncio.sleep(0.15)
        drained: list[_LogItem] = []
        try:
            drained.append(_log_queue.get_nowait())
        except queue.Empty:
            continue
        # Wait a bit to collect more items so we send stacks of 5 instead of one-by-one
        await asyncio.sleep(_LOG_COLLECT_WAIT_SEC)
        while len(drained) < _LOG_DRAIN_MAX:
            try:
                drained.append(_log_queue.get_nowait())
            except queue.Empty:
                break
        # Load config once per drain batch (cached 30s)
        data = _get_adbot_cached()
        # Split: cycle-start (batch by bot), individual (buttons / non-batchable), everything else (batch 5)
        cycle_start_items: list[_LogItem] = []
        individual: list[_LogItem] = []
        batchable: list[_LogItem] = []
        for item in drained:
            if item.buttons or not item.batchable:
                individual.append(item)
            elif _is_cycle_start_log(item.msg) and not item.entities:
                cycle_start_items.append(item)
            else:
                batchable.append(item)
        # One message per bot: all cycle-start lines combined (e.g. "session1 14 groups\nsession2 13 groups")
        if cycle_start_items:
            by_bot_cs: dict[str, list[str]] = {}
            for item in cycle_start_items:
                by_bot_cs.setdefault(item.bot_token, []).append(item.msg)
            for bot_token, lines in by_bot_cs.items():
                cfg = data.get("bots", {}).get(bot_token)
                log_ent = _log_group_entity(cfg.get("log_group")) if cfg else None
                if not log_ent:
                    continue
                combined = "\n".join(lines)
                try:
                    await notify.notify_log_group(bot_token, log_ent, combined, parse_mode=None)
                    await asyncio.sleep(_LOG_SEND_DELAY_SEC)
                except Exception:
                    pass
        for item in individual:
            cfg = data.get("bots", {}).get(item.bot_token)
            log_ent = _log_group_entity(cfg.get("log_group")) if cfg else None
            if not log_ent:
                continue
            # entities and parse_mode are mutually exclusive (Telegram drops entities otherwise)
            ptb_mode = None if item.entities else (
                "Markdown" if item.parse_mode == "md" else ("HTML" if item.parse_mode == "html" else None)
            )
            reply_markup = None
            if item.buttons:
                try:
                    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
                    reply_markup = InlineKeyboardMarkup([[InlineKeyboardButton(t, url=u) for t, u in item.buttons]])
                except Exception:
                    pass
            try:
                await notify.notify_log_group(
                    item.bot_token, log_ent, item.msg,
                    parse_mode=ptb_mode, reply_markup=reply_markup, entities=item.entities,
                )
                await asyncio.sleep(_LOG_SEND_DELAY_SEC)
            except Exception:
                pass
        # Batch remaining items: 5 per message
        if not batchable:
            continue
        by_bot: dict[str, list[_LogItem]] = {}
        for item in batchable:
            by_bot.setdefault(item.bot_token, []).append(item)
        for bot_token, items in by_bot.items():
            cfg = data.get("bots", {}).get(bot_token)
            log_ent = _log_group_entity(cfg.get("log_group")) if cfg else None
            if not log_ent:
                continue
            for i in range(0, len(items), _LOG_BATCH_SIZE):
                chunk = items[i : i + _LOG_BATCH_SIZE]
                has_entities = any(it.entities for it in chunk)
                try:
                    if has_entities:
                        combined_text, combined_entities = _join_items_with_entities(chunk)
                        await notify.notify_log_group(bot_token, log_ent, combined_text, parse_mode=None, entities=combined_entities)
                    else:
                        use_md = any(it.parse_mode == "md" for it in chunk)
                        use_html = any(it.parse_mode == "html" for it in chunk) or any("<a href=" in (it.msg or "") for it in chunk)
                        ptb_mode = "HTML" if use_html else ("Markdown" if use_md else None)
                        combined_text = "\n".join(it.msg for it in chunk)
                        await notify.notify_log_group(bot_token, log_ent, combined_text, parse_mode=ptb_mode)
                    await asyncio.sleep(_LOG_SEND_DELAY_SEC)
                except Exception:
                    pass

# --- Anti-ban safety (enforced even if user sets gap=1) ---
MIN_GAP_SEC = 4  # Min 4–6 s between posts per session (BASE for decay)
MAX_GAP_SEC = 6
MAX_POSTS_PER_CYCLE = 25  # Safety cap: max posts per session per cycle
GAP_JITTER = 0.2  # ±20% randomization on gap to avoid fixed patterns
# FloodWait adaptive pacing: when session hits FloodWait, we bump effective gap; each cycle we decay toward MIN_GAP_SEC so system doesn't stay slow.
FLOODWAIT_GAP_BOOST_SEC = 30  # Add this many seconds to effective gap when FloodWait is applied
# Enterprise: account-level FloodWait — if wait_seconds below this, sleep and retry same group; else skip group and continue cycle.
FLOODWAIT_SLEEP_RETRY_THRESHOLD_SEC = 60
_effective_gap_sec: dict[tuple[str, str], float] = {}  # (bot_token, session_file) -> effective gap; decay by 1 each cycle

# Forum topics: we support group_id | topic_id. Post/forward use reply_to or top_msg_id.
# Errors that mean skip this group (forum/topic, banned, etc.)
# Forum/topic errors (TopicDeleted, MessageThreadInvalid, etc.): skip that target, blacklist topic.
_SKIP_GROUP_ERRORS = tuple(
    e for e in (
        getattr(tl_errors, "ChannelForumMissingError", None),
        getattr(tl_errors, "TopicDeletedError", None),
        getattr(tl_errors, "MessageThreadInvalidError", None),
    ) if e is not None
)
_SKIP_GROUP_PATTERNS = ("thread", "topic", "forum", "message_thread", "messagethread")
def _unique_path_in_user_dir(user_dir: Path, base_name: str) -> Path:
    """Return a path in user_dir for base_name, unique so uploads don't overwrite."""
    p = user_dir / base_name
    if not p.exists():
        return p
    stem = Path(base_name).stem
    suf = Path(base_name).suffix or ".session"
    n = 1
    while (user_dir / f"{stem}_{n}{suf}").exists():
        n += 1
    return user_dir / f"{stem}_{n}{suf}"


def _extract_zip_and_copy_to_user_dir(zip_path: Path, tmp_path: Path, user_dir: Path) -> list[Path]:
    """Sync: open zip, extractall, copy each .session to user_dir with unique name. Must run off main loop (Fix #3). Returns list of dest paths."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(tmp_path)
    dests: list[Path] = []
    for ext in Path(tmp_path).rglob("*.session"):
        if not ext.is_file():
            continue
        dest = _unique_path_in_user_dir(user_dir, ext.name)
        shutil.copy2(ext, dest)
        dests.append(dest)
    return dests


# Group/target errors: NOT session death — skip group only, do not notify admin.
_ENTITY_NOT_FOUND_PATTERNS = ("entity", "corresponding", "cannot find", "no entity")
_USER_BANNED_IN_CHANNEL = getattr(tl_errors, "UserBannedInChannelError", None)
_BANNED_FROM_SENDING_PATTERNS = ("banned from sending messages in supergroups", "banned from sending")
# Auth/session errors: use centralized list from rpc_errors
_DEAD_SESSION_ERRORS = SESSION_DEAD_ERRORS

# Log-group invalid (deleted/banned) → trigger auto-recreate
_LOG_GROUP_INVALID_ERRORS = tuple(
    e for e in (
        getattr(tl_errors, "ChannelInvalidError", None),
        getattr(tl_errors, "ChatIdInvalidError", None),
        getattr(tl_errors, "ChannelPrivateError", None),
        getattr(tl_errors, "ChatWriteForbiddenError", None),
    ) if e is not None
)


def _is_log_group_invalid(exc: Exception) -> bool:
    """True if exception indicates log group is deleted/banned/invalid."""
    if type(exc) in _LOG_GROUP_INVALID_ERRORS:
        return True
    err = str(exc).lower()
    return "channel" in err and ("invalid" in err or "not found" in err or "deleted" in err)

logger = logging.getLogger(__name__)

# Callback data for menu
CB_RUN = b"run"
CB_STOP = b"stop"
CB_SET_MSG = b"set_msg"
CB_SET_MSG_TEXT = b"set_msg_t"
CB_SET_MSG_TEXT_DEL = b"set_msg_td"  # delete custom text (controller Set Message)
CB_SET_MSG_LINK = b"set_msg_l"
CB_SET_MSG_LINKS_MANAGE = b"set_msg_links"  # open post-links list with add/remove
CB_MSG_MODE_TEXT = b"msg_mode_t"   # set message_mode to "text"
CB_MSG_MODE_LINK = b"msg_mode_l"   # set message_mode to "link"
PREFIX_PL_DEL = b"pl_del:"  # + index (0-based) to remove that post link
CB_STATUS = b"status"
CB_STATUS_REFRESH = b"status_r"
CB_LOGS = b"logs"
CB_VALIDITY = b"validity"
CB_CHATLIST = b"chatlist"
CB_CHATLIST_ADD = b"cl_add"
CB_CHATLIST_VIEW = b"cl_view"
CB_CHATLIST_REMOVE = b"cl_remove"
CB_CHATLIST_REVERT = b"cl_revert"
CB_CHATLIST_UPLOAD = b"cl_upload"
CB_EXTEND = b"extend"
CB_FIX_MENU = b"fix_menu"
CB_FIX_LOG = b"fix_log"
CB_FIX_SESS = b"fix_sess"
CB_FIX_CFG = b"fix_cfg"
CB_FIX_TOK = b"fix_tok"
CB_FIX_CANCEL = b"fix_cancel"
CB_FIX_BACK = b"fix_back"
CB_FIX_SESS_BACK = b"fix_sess_b"
PREFIX_FIX_SESS = b"fix_sx:"  # fix_sx:0, fix_sx:1 for session index
PREFIX_FIX_SESS_REP = b"fix_sr:"  # fix_sr:0 to replace session at index
# Config selection callbacks (prefix + value, e.g. grp:Starter.txt, mode:starter)
PREFIX_GROUP = b"grp:"
PREFIX_MODE = b"mode:"
PREFIX_CYCLE = b"cyc:"
PREFIX_GAP = b"gap:"
PREFIX_RENEWAL = b"rnw:"
PREFIX_VALID_TILL = b"vt:"
CB_BACK_CONFIG = b"back_cfg"
CB_CFG_RENEWAL = b"cfg_renewal"
CB_CFG_RENEWAL_CUSTOM = b"cfg_rnw_custom"
CB_CFG_VALID_TILL = b"cfg_valid_till"
CB_CFG_VALID_TILL_CUSTOM = b"cfg_vt_custom"
CB_CFG_MESSAGE = b"cfg_message"
CB_CFG_MSG_MODE_TEXT = b"cfg_msg_t"   # set message_mode text (Config)
CB_CFG_MSG_MODE_LINK = b"cfg_msg_l"   # set message_mode link (Config)
CB_CFG_TEXT_DEL = b"cfg_txt_del"  # delete custom text (Config > Message)
CB_CFG_POST_LINKS = b"cfg_post_links"
CB_CYCLE_CUSTOM = b"cyc_custom"
CB_GAP_CUSTOM = b"gap_custom"
CB_STATS_MENU = b"stats_menu"  # open stats dashboard from main menu
CB_STATS_CYCLE_DETAILS = b"stats_cycle"
CB_STATS_SESSION_DETAILS = b"stats_sess"
CB_STATS_REFRESH = b"stats_refresh"
CB_STATS_BACK = b"stats_back"
CB_STATS_PER_SESSION = b"stats_per_sess"
CB_STATS_ANALYZE = b"stats_analyze"
CB_STATS_RESET = b"stats_reset"
CB_STATS_RESET_CONFIRM = b"stats_reset_ok"
PREFIX_STATS_SESSION = b"stats_ps:"
# Session replacement callbacks
CB_REP_FREE = b"rep_free"         # Replace free sessions
CB_REP_PAY = b"rep_pay"           # Pay & replace
CB_REP_SKIP = b"rep_skip"         # Skip / continue without
CB_REP_CONFIRM_FREE = b"rep_cf"   # Confirm free replacement
PREFIX_REP_CRYPTO = b"rep_cry:"   # rep_cry:USDT_TRC20 — crypto selection for replacement payment
CB_REP_STATUS = b"rep_status"     # Check replacement status
# DM auto-reply menu
CB_AR_MENU = b"ar_menu"           # Open Auto Reply submenu
CB_AR_TOGGLE = b"ar_toggle"       # Turn auto-reply ON/OFF
CB_AR_EDIT = b"ar_edit"           # Change the auto-reply message
CB_AR_RECENT = b"ar_recent"       # View recent DMs received
CB_AR_BACK = b"ar_back"           # Back to main menu from Auto Reply

# Posting: asyncio tasks on main loop (legacy); bot_token -> (stop_event, [asyncio.Task, ...], [session_file, ...])
_posting_handles: dict[str, tuple[asyncio.Event, list[asyncio.Task], list[str]]] = {}
# Multiprocessing workers: bot_token -> [(Process, command_queue, worker_id, session_chunk), ...]; 1 worker = 1 session.
# session_chunk stored so we can restart a single worker on heartbeat timeout.
_worker_handles: dict[str, list[tuple[multiprocessing.Process, multiprocessing.Queue, int, list[dict]]]] = {}
# Controller-level: (bot_token, session_file) -> worker_id. Ensures one active worker per session; used to prevent duplicate workers on restart.
_session_worker_registry: dict[tuple[str, str], int] = {}
# Restart guard: (bot_token, session_file) in set => restart already in progress; reject further restart requests for same session.
_restart_in_progress: set[tuple[str, str]] = set()
_worker_result_queue: Optional[multiprocessing.Queue] = None
_worker_result_handler_task: Optional[asyncio.Task] = None
# Temp blacklist: group_key per (bot_token, session_file); cleared on cycle start. Errors >2 for same group → temp exclude.
# Keyed by (bot_token, session_file) so one session's ban NEVER blocks other sessions from posting to the same group.
_temp_excluded_groups: dict[tuple[str, str], set[str]] = {}
_temp_exclusion_error_count: dict[str, dict[str, int]] = {}
# Heartbeat watchdog: (bot_token, worker_id) -> last heartbeat timestamp. Cleared when workers are stopped/restarted.
_worker_last_heartbeat: dict[tuple[str, int], float] = {}
# Rate-limited heartbeat log: last time we wrote HEARTBEAT to adbot.log per (bot_token, worker_id)
_worker_heartbeat_log_ts: dict[tuple[str, int], float] = {}
# Worker startup grace: (bot_token, session_file) -> unix ts when grace ends; do not restart before this
_worker_start_time: dict[tuple[str, str], float] = {}
_worker_startup_grace_until: dict[tuple[str, str], float] = {}
# Per-session stagger (sec) so startup-failure check doesn't restart sessions still in their start delay
_worker_stagger_sec: dict[tuple[str, str], float] = {}
# Track first cycle or post per session for "posting started" and startup-failure detection
_worker_first_cycle_or_post: set[tuple[str, str]] = set()  # (bot_token, session_file)
# Latest scheduler next_run (unix ts) per session, reported by the worker. Used so the
# startup-failure check does not restart a session whose next cycle is legitimately still in
# the future (e.g. after a crash-resume that preserved the cycle anchor).
_worker_next_run: dict[tuple[str, str], float] = {}
# Stats: counts only, stored in data/stats/<name>.json. No event list; 24h rolling via hourly buckets.
RECENT_EVENTS_WINDOW_SEC = 24 * 3600  # 24 hours rolling window
STATS_FLUSH_INTERVAL_SEC = 5
STATS_BATCH_SIZE = 50
# How often a worker checkpoints mid-cycle posting progress (posted group keys) so a crash/restart
# can resume the same cycle. A hard crash loses at most this window → those groups re-post once.
CYCLE_PROGRESS_REPORT_INTERVAL_SEC = 10
_stats_pending: dict[str, dict] = {}  # bot_token -> {pending_events, lifetime_sent_delta, lifetime_failed_delta, session_deltas, last_flush_ts}
_stats_flush_task: Optional[asyncio.Task] = None
HEARTBEAT_LOG_INTERVAL_SEC = 300  # log HEARTBEAT at most every 5 min per worker
HEARTBEAT_INTERVAL_SEC = 60  # Worker sends heartbeat at least this often (and at cycle start)
HEARTBEAT_FROZEN_TIMEOUT_MIN = 120  # Min seconds without heartbeat before treating worker as frozen
# Per-session last activity timestamp (session_file -> unix time); updated by session loop for stall detection
_worker_last_activity: dict[str, dict[str, float]] = {}  # bot_token -> {session_file: ts}
# Pending STOP cleanup tasks: bot_token -> Task. Run must await before spawning new workers to avoid session file conflict.


def get_bot_last_activity_ts(bot_token: str) -> float | None:
    """Return latest activity timestamp for this bot's workers, or None."""
    activity = _worker_last_activity.get(bot_token) or {}
    if not activity:
        return None
    return max(activity.values())
_pending_stop_cleanup: dict[str, asyncio.Task] = {}
# Sessions currently in use by posting (normalized path str); only that task may open the .session file
_active_posting_sessions: set[str] = set()

def _log_posting_scheduler(
    session_file: str,
    cycle_due_in: float,
    gap_due_in: float,
    flood_wait_remaining: float,
    decision: str,
    report_user_log: Optional[Callable[[str], None]] = None,
) -> None:
    """Emit [PostingScheduler] line for observability: timing rules and decision=waiting|posting."""
    msg = (
        f"[PostingScheduler] session={session_file} cycle_due_in={cycle_due_in:.0f} "
        f"gap_due_in={gap_due_in:.0f} flood_wait_remaining={flood_wait_remaining:.0f} decision={decision}"
    )
    if report_user_log:
        report_user_log(msg)
    else:
        logger.info("%s", msg)


# Session availability: ACTIVE or PAUSED until unblock_time (FloodWait). Do not sleep in worker when PAUSED.
# bot_token -> session_file -> {"state": "ACTIVE"|"PAUSED", "unblock_time": float}
_session_availability: dict[str, dict[str, dict]] = {}
# Per-session rolling FloodWait counters (reset at cycle start): (bot_token, session_file) -> count in this cycle
_session_floodwait_counts: dict[tuple[str, str], int] = {}
# Starter only: groups deferred from PAUSED sessions; healthy sessions drain this. bot_token -> list of group dicts
_deferred_groups: dict[str, list] = {}
_deferred_lock: dict[str, asyncio.Lock] = {}  # bot_token -> Lock


def is_session_active(session_path: Path | str) -> bool:
    """True if this session file is currently open by a posting worker. Block validate/get_session_user when True."""
    path = Path(session_path).resolve()
    key = path.as_posix() if path.is_absolute() else str(path)
    return key in _active_posting_sessions


register_session_active_check(is_session_active)


def cleanup_active_sessions_for_bot(bot_token: str) -> None:
    """Best-effort cleanup when workers die: drop any active-posting session paths that belong to this bot.
    This prevents stale entries from blocking validation or reassignment after a crash."""
    if not bot_token:
        return
    # Session paths include only the filename, while _active_posting_sessions stores absolute paths.
    # Match by suffix so any path ending with '/active/<file>' or '/users/.../<file>' is cleared.
    try:
        cfg = _get_cfg(bot_token)
    except Exception:
        cfg = None
    if not cfg:
        return
    session_files = [str((s.get("file") or "")).strip() for s in cfg.get("sessions", []) if s.get("file")]
    if not session_files:
        return
    to_discard: list[str] = []
    for session_file in session_files:
        # Normalize to '.session' suffix for comparison, since _session_file_from_chunk also normalizes.
        normalized = session_file if session_file.endswith(".session") else f"{session_file}.session"
        for key in _active_posting_sessions:
            if key.endswith("/" + normalized) or key.endswith("\\" + normalized):
                to_discard.append(key)
    for key in to_discard:
        _active_posting_sessions.discard(key)


def _session_avail(bot_token: str, session_file: str) -> dict:
    """Get or create availability entry for (bot_token, session_file)."""
    _session_availability.setdefault(bot_token, {})
    if session_file not in _session_availability[bot_token]:
        _session_availability[bot_token][session_file] = {"state": "ACTIVE", "unblock_time": 0.0}
    return _session_availability[bot_token][session_file]


def set_session_paused(bot_token: str, session_file: str, unblock_time: float) -> None:
    """Mark session PAUSED until unblock_time. Other sessions continue; this one yields."""
    entry = _session_avail(bot_token, session_file)
    entry["state"] = "PAUSED"
    entry["unblock_time"] = unblock_time
    key = (bot_token, session_file)
    _effective_gap_sec[key] = _effective_gap_sec.get(key, float(MAX_GAP_SEC)) + FLOODWAIT_GAP_BOOST_SEC
    logger.info("Session %s entered PAUSED until %.0f", session_file, unblock_time)


def get_session_pause_until(bot_token: str, session_file: str, cfg: dict | None = None) -> float:
    """Return unblock_time (absolute timestamp) if session is in FloodWait pause, else 0. Uses in-memory state and optionally cfg['session_pause_until'] (for restart persistence)."""
    entry = _session_avail(bot_token, session_file)
    in_memory = entry["unblock_time"] if entry["state"] == "PAUSED" else 0.0
    from_cfg = 0.0
    if cfg:
        from_cfg = float((cfg.get("session_pause_until") or {}).get(session_file) or 0)
    now = time.time()
    # If either source says we're paused and not yet expired, we're paused
    if in_memory > now or from_cfg > now:
        return max(in_memory, from_cfg)
    return 0.0


def is_session_available(bot_token: str, session_file: str, cfg: dict | None = None) -> bool:
    """True if session is ACTIVE or unblock_time has passed. When cfg is provided, also respects persisted session_pause_until (for restarts)."""
    pause_until = get_session_pause_until(bot_token, session_file, cfg)
    return pause_until == 0.0


def maybe_reactivate_session(bot_token: str, session_file: str, cfg: dict | None = None) -> bool:
    """If unblock_time passed, set ACTIVE and log. If cfg has session_pause_until in future, sync to in-memory (for restarts). Returns True if now ACTIVE."""
    entry = _session_avail(bot_token, session_file)
    now = time.time()
    # Sync from persisted config (worker restart: in-memory empty but config has pause)
    if cfg:
        pause_until = (cfg.get("session_pause_until") or {}).get(session_file) or 0
        if pause_until > now and pause_until > entry.get("unblock_time", 0):
            entry["state"] = "PAUSED"
            entry["unblock_time"] = pause_until
    if entry["state"] == "ACTIVE":
        return True
    if now >= entry["unblock_time"]:
        entry["state"] = "ACTIVE"
        entry["unblock_time"] = 0.0
        logger.info("Session %s became ACTIVE again", session_file)
        return True
    return False


def _defer_groups_starter(bot_token: str, groups: list[dict]) -> None:
    """Append groups to deferred list for Enterprise mode (reassignment when a session hits FloodWait). Healthy sessions drain this queue."""
    if not groups:
        return
    _deferred_groups.setdefault(bot_token, [])
    _deferred_lock.setdefault(bot_token, asyncio.Lock())
    _deferred_groups[bot_token].extend(groups)
    logger.info("Deferred %s groups for reassignment (Starter)", len(groups))


async def _pop_deferred_groups(bot_token: str, max_count: int = 1) -> list[dict]:
    """Pop up to max_count groups from deferred (Starter). Returns list; may be empty."""
    _deferred_lock.setdefault(bot_token, asyncio.Lock())
    async with _deferred_lock[bot_token]:
        deferred = _deferred_groups.get(bot_token) or []
        out: list[dict] = []
        for _ in range(min(max_count, len(deferred))):
            if deferred:
                out.append(deferred.pop(0))
        return out


async def _push_back_deferred(bot_token: str, g: dict) -> None:
    """Append one group back to deferred (e.g. when session hits FloodWait while draining)."""
    _deferred_lock.setdefault(bot_token, asyncio.Lock())
    async with _deferred_lock[bot_token]:
        _deferred_groups.setdefault(bot_token, []).append(g)


# Set Message state: bot_token -> {user_id -> "text"|"link"}
_set_message_state: dict[str, dict[int, str]] = {}
# Config custom input state: bot_token -> {user_id -> "renewal_price"|"valid_till"|"cycle"|"gap"}
_config_custom_state: dict[str, dict[int, str]] = {}
# (bot_token, user_id) -> (chat_id, message_id) for editing same message when custom input is received
_config_custom_message_id: dict[tuple[str, int], tuple[int, int]] = {}
# Upload sessions: bot_token -> set of user_ids waiting for .session or .zip
_upload_sessions_state: dict[str, set[int]] = {}
# Chatlist link input: bot_token -> set of user_ids waiting for chatlist link(s)
_chatlist_input_state: dict[str, set[int]] = {}
# Chatlist group file upload: bot_token -> set of user_ids waiting for edited .txt upload
_chatlist_upload_state: dict[str, set[int]] = {}
_fix_wait_token_state: dict[str, bool] = {}
_fix_sess_data: dict[str, dict] = {}
# Session start gap: Starter spreads sessions EVENLY across the cycle so each group receives one
# post per account spaced by cycle/N (no simultaneous bursts). Offset = ordinal * (cycle_sec / N).
# This offset is applied to the scheduling anchor EVERY cycle (see _starter_phase_offset), so the
# spacing never collapses after the first cycle. STAGGER_WINDOW_SEC/STAGGER_MAX_SEC are legacy
# (kept for import compatibility); Starter no longer uses a fixed window.
STAGGER_WINDOW_SEC = 600  # legacy (unused for Starter phase); kept for import compatibility
STAGGER_MAX_SEC = 300  # legacy (unused for Starter phase); kept for import compatibility
ENTERPRISE_STAGGER_SEC = 300  # 5 minutes — second half of sessions start after this
# Account-level FloodWait detector: if a session hits this many group FloodWaits in ONE cycle,
# treat it as account-level throttling (not isolated group slow-mode) and pause the whole session.
FLOODWAIT_SESSION_PAUSE_COUNT = 5


def _starter_phase_offset(ordinal: int, total_sessions: int, cycle_sec: float) -> float:
    """Starter even-spread phase for session `ordinal` (0-based): ordinal * (cycle_sec / N).
    Applied to the scheduling anchor every cycle so N accounts posting the same groups are
    time-shifted by cycle/N — each group gets a steady drip instead of an N-account burst.
    Returns 0 for a single session. Distinct ordinals always get distinct offsets (no collision)."""
    n = max(1, int(total_sessions or 1))
    idx = max(0, int(ordinal)) % n
    return idx * (max(1.0, float(cycle_sec)) / n)

# Session health monitor: check running bots every N seconds; restart if workers dropped
SESSION_HEALTH_CHECK_INTERVAL = 60  # 1 minute — faster crash detection & restart

# Absolute-time scheduling: when we fall behind (e.g. after FloodWait), do NOT drop groups —
# attempt all assigned groups; late jobs are rescheduled relative to now (sleep_until=0) so FloodWait delays work, does not delete it.
MAX_DRIFT_SEC = 60  # Past this after scheduled_for = "late"; we still attempt, do not skip
MAX_ALLOWED_DELAY_SEC = 300  # Cap single sleep so we don't block too long in one wait
# Stalled worker: no activity for this long → health monitor restarts posting
STALLED_WORKER_SEC = 900  # 15 min
# Scheduler: re-evaluate next_run every N seconds so cycle timing is deterministic and stop_event is checked often
SCHEDULER_POLL_INTERVAL_SEC = 5
# Failure intelligence: rolling window and cooldown (persisted so restart does not reactivate unstable sessions)
# Only hard errors (banned, write-forbidden, peer-flood) count toward session health — FloodWait/Unknown are excluded.
# Threshold: 85% of recent hard-error attempts must fail before session is put on a short 5-min cooldown.
SESSION_ERROR_ROLLING_WINDOW = 100
SESSION_ERROR_RATE_THRESHOLD = 0.85   # was 0.5 — only cool-down when truly unhealthy (85%+ hard failures)
SESSION_COOLDOWN_MINUTES = 5          # was 15 — short cooldown so session recovers within one cycle
SESSION_COOLDOWN_SEC = SESSION_COOLDOWN_MINUTES * 60
# Scheduler health: log only; workers are never restarted based on delay_sec (see scheduler_health handler).
SCHEDULER_DELAY_RESTART_THRESHOLD_SEC = 60  # kept for reference / future use; not used for restart
# Worker startup grace: do not restart worker during this window after spawn (avoids restart during init)
WORKER_STARTUP_GRACE_SEC = 90
# Delayed failure recovery: after grace, if no cycle/post in this window, trigger health diagnosis
HEALTH_CHECK_DELAY_SEC = 120  # 2 min
# If still no cycle/post after this from worker start, restart and notify admin
STARTUP_FAILURE_RESTART_AFTER_SEC = 600  # 10 min
# Drift detection: log warning if expected vs actual cycles differ by more than this (long-term stability)
SCHEDULER_DRIFT_TOLERANCE_CYCLES = 2
DRIFT_CHECK_INTERVAL_SEC = 86400  # 24h

# Posting failure categories for rolling error rate and cooldown
POST_ERROR_FLOOD_WAIT = "FLOOD_WAIT"
POST_ERROR_WRITE_FORBIDDEN = "WRITE_FORBIDDEN"
POST_ERROR_PEER_FLOOD = "PEER_FLOOD"
POST_ERROR_BANNED = "BANNED"
POST_ERROR_UNKNOWN = "UNKNOWN"

# Bug 13: errors that will not resolve by retrying every cycle (paid-post required, closed forum topic,
# no write permission). We do NOT permanently exclude these (per request) but park them on a long group
# cooldown so accounts stop hammering them every cycle while still re-checking periodically.
_PERMANENT_ERROR_PATTERNS = (
    "payment_required", "allow_payment_required", "topic_closed", "topic closed",
    "can't write in this chat", "cant write in this chat", "chat_write_forbidden", "write forbidden",
)
PERMANENT_ERROR_RETRY_SEC = 4 * 3600  # re-attempt permanently-failing groups at most every 4 hours


def _classify_post_error(error_message: str) -> str | None:
    """Classify post failure into a category for session health rate.
    Returns None for errors that should NOT count against session health (FloodWait, skip, unknown).
    Only BANNED / WRITE_FORBIDDEN / PEER_FLOOD are genuine session-health signals."""
    if not error_message:
        return None  # unknown → don't penalise session
    msg = (error_message or "").strip().lower()
    if "flood" in msg and "wait" in msg:
        return None  # FloodWait = per-group throttle, not session health issue
    if "skip" in msg or "ignore" in msg:
        return None  # explicit skip markers
    if (
        "write forbidden" in msg
        or "chat_write_forbidden" in msg
        or "chatwriteforbidden" in msg
        or "send message forbidden" in msg
        or "can't write in this chat" in msg  # Telethon ChatWriteForbiddenError message text
        or "cant write in this chat" in msg
    ):
        return POST_ERROR_WRITE_FORBIDDEN
    if "peer_flood" in msg or "peer flood" in msg:
        return POST_ERROR_PEER_FLOOD
    if "banned" in msg or "userbanned" in msg or "channel private" in msg:
        return POST_ERROR_BANNED
    return None  # everything else (restricted, topic_closed, payment_required, etc.) → don't penalise session

# DM auto-reply: only reply to same user once per 24 hours (anti-spam)
DM_AUTOREPLY_COOLDOWN_SEC = 24 * 3600
# Legacy constant kept for backward-compat imports; live replies now go through
# compose_autoreply() so they carry the per-AdBot message + the locked footer.
DM_AUTOREPLY_MESSAGE = (
    "This is an automated AdBot account. DMs may not be reviewed. "
    "For promotions and advertising, contact @Pacific or check @HQAdz."
)

# Shown when the owner hasn't written a custom auto-reply.
DM_AUTOREPLY_DEFAULT = (
    "Hey, this is an automated advertising account. Please contact the main account for assistance."
)
# Default locked footer appended to EVERY auto-reply. This is only the DEFAULT — the live
# footer is admin-editable via dm_inbox.get_autoreply_footer(); the owner can never change it.
DM_AUTOREPLY_FOOTER = dm_inbox.DEFAULT_AUTOREPLY_FOOTER


def compose_autoreply(custom: str | None, footer: str | None = None) -> str:
    """Build the exact auto-reply text: (custom message or the default) + the locked
    admin-managed footer, separated by a blank line. Idempotent — never appends it twice.
    Single source of truth for the worker (send), the API (preview), and the control bot.
    Pass `footer` to override; otherwise the current admin-configured footer is used."""
    body = (custom or "").strip() or DM_AUTOREPLY_DEFAULT
    ft = footer if footer is not None else dm_inbox.get_autoreply_footer()
    if not ft or ft in body:
        return body
    return f"{body}\n\n{ft}"


# Short-TTL disk cache so a portal/control-bot toggle of dm_autoreply reaches the
# posting worker (separate process) within ~30s without a restart — the worker
# cannot be pushed to directly, so it re-reads the user-data file on a cadence.
_autoreply_cfg_cache: dict[str, tuple[float, dict]] = {}
_AUTOREPLY_CFG_TTL = 30.0


def get_autoreply_config(name: str) -> dict:
    """Return {'enabled': bool, 'message': str} for an AdBot, defaulting to ON with an
    empty (→ default) message when unset. Cached for _AUTOREPLY_CFG_TTL seconds."""
    now = time.time()
    hit = _autoreply_cfg_cache.get(name)
    if hit and (now - hit[0]) < _AUTOREPLY_CFG_TTL:
        return hit[1]
    ar: dict = {}
    try:
        ar = (load_user_data(name) or {}).get("dm_autoreply") or {}
    except Exception:
        ar = {}
    val = {"enabled": bool(ar.get("enabled", True)), "message": str(ar.get("message", "") or "")}
    _autoreply_cfg_cache[name] = (now, val)
    return val


# Owner DM-notification debounce: first message from a sender fires instantly (web bell +
# control-bot DM); further messages from the same sender within the window are counted and
# flushed as a single "+N more" follow-up, so a spammer can't flood the owner. The inbox
# still records every message. Keyed by (bot_token, sender_id); controller-process only.
_dm_owner_notify: dict[tuple, dict] = {}
_DM_NOTIFY_WINDOW_SEC = 45.0


def _dm_bell_summary(from_name: str, sender_username: str, text: str, media_type: str, caption: str) -> str:
    """Short message preview for the notification bell (sender is carried in the title)."""
    if media_type:
        body = f"{media_type} received" + (f": {caption}" if caption else "")
    else:
        body = (text or "").strip() or "No text message"
    body = body.strip()
    if len(body) > 120:
        body = body[:117] + "…"
    return body


async def _dm_owner_flush(key: tuple) -> None:
    """After the coalesce window, send one follow-up if more messages arrived."""
    try:
        await asyncio.sleep(_DM_NOTIFY_WINDOW_SEC)
    except Exception:
        pass
    st = _dm_owner_notify.pop(key, None)
    if not st or st.get("count", 0) <= 0:
        return
    try:
        await bot_ptb.send_owner_dm_followup(
            st["bot_token"], st["owner_id"], st["account_username"],
            st["from_name"], st["sender_username"], st["sender_id"], st["count"],
        )
    except Exception as e:
        logger.warning("dm owner follow-up failed: %s", e)


async def _handle_dm_alert(msg: dict) -> None:
    """Controller-side handling of a worker's incoming-DM report: record it in the owner's
    inbox, raise the web bell, and DM the owner via the AdBot's own control bot (debounced)."""
    bot_token = msg.get("bot_token", "")
    sender_id = int(msg.get("user_id", 0) or 0)
    cfg = _get_cfg(bot_token) or {}
    name = cfg.get("name") or get_name_by_token(bot_token) or ""
    if not (name and sender_id):
        return
    session_file = msg.get("session_file", "")
    from_name = msg.get("from_name", "Unknown User")
    sender_username = msg.get("sender_username", "")
    account_username = msg.get("account_username", "")
    account_name = msg.get("account_name", "")
    account_user_id = int(msg.get("account_user_id", 0) or 0)
    text = msg.get("message_text", "")
    media_type = msg.get("media_type", "")
    caption = msg.get("caption", "")
    reply_status = msg.get("reply_status", "")
    reply_text = msg.get("reply_text", "")

    # 1) Always record in the inbox (every message).
    entry_id = ""
    try:
        _entry = dm_inbox.add_dm(
            name, session_file=session_file, account_username=account_username,
            account_name=account_name, account_user_id=account_user_id,
            sender_id=sender_id, sender_name=from_name, sender_username=sender_username,
            text=text, media_type=media_type, caption=caption,
            reply_status=reply_status, reply_text=reply_text,
        )
        entry_id = _entry.get("id", "")
    except Exception as e:
        logger.warning("dm inbox write failed: %s", e)

    # 2) + 3) Web bell + owner Telegram: instant on the first message of a burst, then coalesce.
    owner_id = int(cfg.get("owner_id") or 0)
    bot_username = cfg.get("bot_username", "")
    key = (bot_token, sender_id)
    st = _dm_owner_notify.get(key)
    if st is None:
        _dm_owner_notify[key] = {
            "count": 0, "bot_token": bot_token, "owner_id": owner_id,
            "account_username": account_username, "from_name": from_name,
            "sender_username": sender_username, "sender_id": sender_id,
        }
        try:
            _sender = from_name or (f"@{sender_username}" if sender_username else "someone")
            _via = f" via @{bot_username}" if bot_username else ""
            dm_inbox.add_portal_notification(
                name,
                f"New DM from {_sender}",
                f"{_dm_bell_summary(from_name, sender_username, text, media_type, caption)}\nReceived by {session_file}{_via}",
                "info", icon="message",
                href=(f"/user/auto-reply?msg={entry_id}" if entry_id else "/user/auto-reply"),
            )
        except Exception as e:
            logger.warning("dm bell write failed: %s", e)
        if owner_id:
            try:
                await bot_ptb.send_owner_dm_received(
                    bot_token, owner_id, account_username, from_name, sender_username,
                    sender_id, text, media_type, caption,
                    session_file=session_file, account_user_id=account_user_id,
                )
            except Exception as e:
                logger.warning("dm owner notify failed: %s", e)
        try:
            asyncio.get_running_loop().create_task(_dm_owner_flush(key))
        except Exception:
            _dm_owner_notify.pop(key, None)
    else:
        st["count"] = st.get("count", 0) + 1


def _universal_admin() -> int | None:
    """Universal admin user_id; always authorized on every user bot."""
    return config.ADMIN_USER_ID if config.ADMIN_USER_ID else None


def _is_authorized(user_id: int | None, cfg: dict) -> bool:
    """True if user is universal admin or in cfg['authorized']."""
    if user_id is None:
        return False
    if _universal_admin() is not None and user_id == _universal_admin():
        return True
    return user_id in cfg.get("authorized", [])


def _is_admin(user_id: int | None) -> bool:
    """True if user is universal admin (for admin-only commands)."""
    return _universal_admin() is not None and user_id == _universal_admin()


def _is_expired(cfg: dict) -> bool:
    """True if valid_till is set and in the past (or state is expired)."""
    if cfg.get("state") == "expired":
        return True
    vt = cfg.get("valid_till", "") or ""
    if not str(vt).strip():
        return False
    try:
        end = datetime.strptime(str(vt).strip(), "%d/%m/%Y")
        return datetime.now() > end
    except ValueError:
        return False


def _menu_buttons() -> list:
    """Return main menu buttons. Fix is only via /fix command, not shown as button.

    The 7 concept buttons carry premium custom-emoji icons via panel_button()
    (MTProto KeyboardButtonStyle.icon); Status has no premium emoji so keeps its
    Unicode glyph. Icons render the emoji, so labels are kept clean (no glyph prefix)."""
    return [
        [
            panel_button("Start", CB_RUN, "panel_start"),
            panel_button("Stop", CB_STOP, "panel_stop"),
        ],
        [
            panel_button("Stats", CB_STATS_MENU, "panel_stats"),
            Button.inline("📋 Status", CB_STATUS),
        ],
        [
            panel_button("Message", CB_SET_MSG, "panel_message"),
            panel_button("Groups", CB_CHATLIST, "panel_groups"),
        ],
        [
            panel_button("Logs", CB_LOGS, "panel_logs"),
            panel_button("Validity", CB_VALIDITY, "panel_validity"),
        ],
        [
            Button.inline("💬 Auto Reply", CB_AR_MENU),
        ],
    ]


def _autoreply_menu_text_and_buttons(cfg: dict) -> tuple[str, list]:
    """Auto Reply submenu: status, current reply preview, and action buttons."""
    ar = cfg.get("dm_autoreply") or {}
    enabled = bool(ar.get("enabled", True))
    message = str(ar.get("message", "") or "")
    preview = compose_autoreply(message)
    status = "🟢 ON" if enabled else "🔴 OFF"
    using = "custom message" if message.strip() else "default message"
    body = (
        f"**Auto Reply** — {status}\n\n"
        f"When someone DMs one of your ad accounts (while the AdBot is running), it replies with "
        f"your {using}:\n\n"
        f"{preview}"
    )
    buttons = [
        [Button.inline("Turn OFF" if enabled else "Turn ON", CB_AR_TOGGLE)],
        [Button.inline("✏️ Change Message", CB_AR_EDIT)],
        [Button.inline("📥 View Recent Messages", CB_AR_RECENT)],
        [Button.inline("‹ Back", CB_AR_BACK)],
    ]
    return body, buttons


def _menu_buttons_expired() -> list:
    """Menu when subscription expired: only Extend Subscription."""
    contact = getattr(config, "ADMIN_CONTACT", "admin")
    return [[Button.inline("Extend Subscription", CB_EXTEND)]]


def _list_group_files() -> list[str]:
    """Return sorted list of .txt filenames in groups/."""
    try:
        return sorted(
            p.name for p in config.GROUPS_DIR.iterdir()
            if p.is_file() and p.suffix.lower() == ".txt"
        )
    except OSError:
        return []


def _get_cfg(bot_token: str) -> dict | None:
    """Load bot config from data/user/<name>.json via index."""
    name = get_name_by_token(bot_token)
    if name:
        return load_user_data(name)
    return None


def _save_bot_config(bot_token: str, updater: Callable[[dict], None]) -> bool:
    """Load, run updater(cfg), save to data/user/<name>.json. Returns True if bot_token exists."""
    name = get_name_by_token(bot_token)
    if name:
        cfg = load_user_data(name)
        if cfg is not None:
            updater(cfg)
            save_user_data(name, cfg)
            return True
    return False


def _normalize_log_group_id(raw: int | str | None) -> int | None:
    """Convert raw channel id to full supergroup peer id (-100xxxxxxxxxx). Legacy only; new entries use https://t.me/... links."""
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n > 0:
        return -1000000000000 - n  # raw channel id -> full supergroup peer id
    return n


def _log_group_entity(raw) -> int | str | None:
    """Return entity to use for send_message: link (https://t.me/...), username, or legacy normalized peer id."""
    if raw is None:
        return None
    s = str(raw).strip()
    if s.startswith("http://") or s.startswith("https://"):
        return s
    if s and not s.lstrip("@-").replace("_", "").replace(".", "").isdigit():
        return s if s.startswith("@") else f"@{s}" if "/" not in s else s
    return _normalize_log_group_id(raw)


def _log_group_link(log_group) -> str:
    """Return t.me link: if already https://t.me/... use as-is; if username use https://t.me/username; else legacy id -> t.me/c/..."""
    if log_group is None:
        return ""
    s = str(log_group).strip()
    if s.startswith("http://") or s.startswith("https://"):
        return s
    if s and not s.lstrip("@-").replace("_", "").replace(".", "").isdigit():
        return f"https://t.me/{s.lstrip('@')}"
    if s.startswith("-100"):
        return f"https://t.me/c/{s[4:]}"
    return f"https://t.me/c/{s}" if s.replace("-", "").isdigit() else ""


def _validity_days_left(valid_till: str) -> str:
    """Return 'X days left' or 'Expired' from valid_till (dd/mm/yyyy). Uses date-only comparison so validity is full days (e.g. 7-day plan shows 7 days on purchase day)."""
    if not (valid_till or str(valid_till).strip()):
        return "—"
    try:
        end = datetime.strptime(str(valid_till).strip(), "%d/%m/%Y")
        # Compare dates only so "valid till 19/02" gives 7 days on 12/02 (not 6)
        today = datetime.now().date()
        delta = (end.date() - today).days
        return "Expired" if delta < 0 else f"{delta} days left"
    except ValueError:
        return str(valid_till)


def _workers_alive(bot_token: str) -> int:
    """Return count of alive workers for this bot. Multiprocessing: process.is_alive(); asyncio: task.done()."""
    workers_list = _worker_handles.get(bot_token)
    if workers_list:
        return sum(1 for proc, *_ in workers_list if proc.is_alive())
    h = _posting_handles.get(bot_token)
    if not h:
        return 0
    _, workers, _ = h
    return sum(1 for w in (workers or []) if not w.done())


def _inc_stat(bot_token: str, session_file: str, key: str, delta: int = 1) -> None:
    """Increment stats.by_session[session_file][key] and persist."""
    def upd(c):
        s = c.setdefault("stats", {})
        s.setdefault("last_stats_update", "")
        s["last_stats_update"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S") + "Z"
        b = s.setdefault("by_session", {})
        entry = b.setdefault(session_file, {"cycles": 0, "posts": 0, "errors": 0})
        entry[key] = entry.get(key, 0) + delta
    _save_bot_config(bot_token, upd)


def _inc_stat_total(bot_token: str, key: str, delta: int = 1) -> None:
    """Increment stats.total_sent or stats.total_failed."""
    def upd(c):
        s = c.setdefault("stats", {})
        s.setdefault("last_stats_update", "")
        s["last_stats_update"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S") + "Z"
        s[key] = s.get(key, 0) + delta
    _save_bot_config(bot_token, upd)


def _stats_bucket_cutoff(now_ts: float) -> int:
    """Hour boundary (unix) before which buckets are dropped (keep last 24h)."""
    return int(now_ts // 3600) - 23


def _add_event_to_buckets(buckets: list[dict], hour_ts: int, success: bool) -> None:
    """Mutate buckets: find or create hour bucket, increment sent or failed."""
    for b in buckets:
        if b.get("hour_ts") == hour_ts:
            if success:
                b["sent"] = b.get("sent", 0) + 1
            else:
                b["failed"] = b.get("failed", 0) + 1
            return
    buckets.append({"hour_ts": hour_ts, "sent": 1 if success else 0, "failed": 0 if success else 1})


def _prune_buckets(buckets: list[dict], now_ts: float) -> None:
    """Keep only buckets within last 24h."""
    cutoff = _stats_bucket_cutoff(now_ts)
    buckets[:] = [b for b in buckets if (b.get("hour_ts") or 0) >= cutoff]


# Long-term daily history (for 7d / 30d / heatmap views). Retained ~13 months.
DAILY_HISTORY_DAYS = 400


def _add_event_to_daily(daily: list[dict], day_ts: int, success: bool) -> None:
    """Mutate daily buckets: find or create day bucket, increment sent or failed."""
    for b in daily:
        if b.get("day_ts") == day_ts:
            if success:
                b["sent"] = b.get("sent", 0) + 1
            else:
                b["failed"] = b.get("failed", 0) + 1
            return
    daily.append({"day_ts": day_ts, "sent": 1 if success else 0, "failed": 0 if success else 1})


def _prune_daily(daily: list[dict], now_ts: float) -> None:
    """Keep only daily buckets within the retention window."""
    cutoff = int(now_ts // 86400) - DAILY_HISTORY_DAYS
    daily[:] = [b for b in daily if (b.get("day_ts") or 0) >= cutoff]


def _sum_buckets(buckets: list[dict]) -> tuple[int, int]:
    """Return (sent, failed) total from bucket list."""
    sent = sum(b.get("sent", 0) for b in (buckets or []))
    failed = sum(b.get("failed", 0) for b in (buckets or []))
    return sent, failed


def _default_stats_data() -> dict:
    """New stats file content: counts only, no event list."""
    return {
        "lifetime_sent": 0,
        "lifetime_failed": 0,
        "created_at": time.time(),
        "session_stats": {},
        "last24h_buckets": [],
        "daily_buckets": [],
    }


def _get_stats_pending(bot_token: str) -> dict:
    """Get or create in-memory stats buffer for batching. Caller may mutate."""
    if bot_token not in _stats_pending:
        _stats_pending[bot_token] = {
            "pending_events": deque(),
            "lifetime_sent_delta": 0,
            "lifetime_failed_delta": 0,
            "session_deltas": {},  # session_file -> {"sent": int, "failed": int}
            "last_flush_ts": 0.0,
        }
    return _stats_pending[bot_token]


def _stats_buffer_event(bot_token: str, session_file: str, success: bool, ts: float) -> None:
    """Buffer one post_attempt for batched flush. Call from controller on post_attempt message."""
    p = _get_stats_pending(bot_token)
    p["pending_events"].append({"ts": ts, "session": session_file, "success": success})
    if success:
        p["lifetime_sent_delta"] += 1
        d = p["session_deltas"].setdefault(session_file, {"sent": 0, "failed": 0})
        d["sent"] = d.get("sent", 0) + 1
    else:
        p["lifetime_failed_delta"] += 1
        d = p["session_deltas"].setdefault(session_file, {"sent": 0, "failed": 0})
        d["failed"] = d.get("failed", 0) + 1


def _increment_cycle_count_in_stats(
    bot_token: str,
    session_file: str,
    *,
    posts_success: int = 0,
    posts_failed: int = 0,
    posts_skipped: int = 0,
    posts_attempted: int = 0,
    cycle_duration_sec: float = 0.0,
    cycle_ts: float = 0.0,
) -> None:
    """Increment cycles count and record per-cycle details in data/stats/<name>.json."""
    name = get_name_by_token(bot_token)
    if not name:
        return
    st = load_stats(name)
    if not st or not isinstance(st, dict):
        st = _default_stats_data()
    now = time.time()
    session_stats = dict(st.get("session_stats") or {})
    entry = dict(session_stats.get(session_file) or {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []})
    entry["cycles"] = int(entry.get("cycles", 0)) + 1
    entry["last_cycle_ts"] = cycle_ts or now
    entry["last_cycle_success"] = posts_success
    entry["last_cycle_failed"] = posts_failed
    entry["last_cycle_skipped"] = posts_skipped
    entry["last_cycle_attempted"] = posts_attempted
    entry["last_cycle_duration_sec"] = round(cycle_duration_sec, 1)
    durations = entry.get("cycle_durations", [])
    if cycle_duration_sec > 0:
        durations.append(round(cycle_duration_sec, 1))
        if len(durations) > 50:
            durations = durations[-50:]
    entry["cycle_durations"] = durations
    entry["avg_cycle_duration_sec"] = round(sum(durations) / len(durations), 1) if durations else 0.0
    best = entry.get("best_cycle_success", 0)
    if posts_success > best:
        entry["best_cycle_success"] = posts_success
        entry["best_cycle_ts"] = cycle_ts or now
    session_stats[session_file] = entry
    st["session_stats"] = session_stats
    st.setdefault("lifetime_sent", 0)
    st.setdefault("lifetime_failed", 0)
    st.setdefault("created_at", now)
    st["last_cycle_ts"] = cycle_ts or now
    st["last_cycle_session"] = session_file
    st["total_cycles"] = int(st.get("total_cycles", 0)) + 1
    save_stats(name, st)


def _flush_bot_stats(bot_token: str) -> None:
    """Flush pending stats to data/stats/<name>.json. Counts + 24h hourly buckets only; no event list."""
    p = _stats_pending.get(bot_token)
    if not p or not p["pending_events"]:
        return
    name = get_name_by_token(bot_token)
    if not name:
        p["pending_events"].clear()
        p["lifetime_sent_delta"] = 0
        p["lifetime_failed_delta"] = 0
        p["session_deltas"].clear()
        return
    now = time.time()
    st = load_stats(name)
    if not st or not isinstance(st, dict):
        cfg = _get_cfg(bot_token)
        legacy = (cfg or {}).get("stats") if cfg else None
        if legacy and isinstance(legacy, dict):
            st = {
                "lifetime_sent": int(legacy.get("lifetime_sent", 0)),
                "lifetime_failed": int(legacy.get("lifetime_failed", 0)),
                "created_at": legacy.get("created_at") or now,
                "session_stats": dict(legacy.get("session_stats") or {}),
                "last24h_buckets": [],
            }
            for sess, entry in list(st["session_stats"].items()):
                if not isinstance(entry, dict):
                    continue
                entry = dict(entry)
                entry.setdefault("last24h_buckets", [])
                st["session_stats"][sess] = entry
            for ev in legacy.get("recent_events") or []:
                ts = ev.get("ts") or 0
                if ts < now - RECENT_EVENTS_WINDOW_SEC:
                    continue
                hour_ts = int(ts // 3600)
                _add_event_to_buckets(st["last24h_buckets"], hour_ts, bool(ev.get("success")))
                sess = (ev.get("session") or "").strip()
                if sess:
                    st["session_stats"].setdefault(sess, {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []})
                    _add_event_to_buckets(st["session_stats"][sess].setdefault("last24h_buckets", []), hour_ts, bool(ev.get("success")))
            _prune_buckets(st["last24h_buckets"], now)
            for entry in (st.get("session_stats") or {}).values():
                if isinstance(entry, dict) and "last24h_buckets" in entry:
                    _prune_buckets(entry["last24h_buckets"], now)
        else:
            st = _default_stats_data()
    # One-time migration: if user JSON still has session_recent_attempts (legacy), move it to stats file.
    if "session_recent_attempts" not in st:
        cfg = _get_cfg(bot_token)
        legacy_attempts = (cfg or {}).get("session_recent_attempts") if cfg else None
        if legacy_attempts and isinstance(legacy_attempts, dict):
            st["session_recent_attempts"] = legacy_attempts
    st.setdefault("last24h_buckets", [])
    st.setdefault("daily_buckets", [])
    lifetime_sent = int(st.get("lifetime_sent", 0)) + p["lifetime_sent_delta"]
    lifetime_failed = int(st.get("lifetime_failed", 0)) + p["lifetime_failed_delta"]
    created_at = st.get("created_at") or now
    if created_at is None or (isinstance(created_at, (int, float)) and created_at <= 0):
        created_at = now
    session_stats = dict(st.get("session_stats") or {})
    for ev in p["pending_events"]:
        ts = ev.get("ts") or 0
        session_file = (ev.get("session") or "").strip()
        success = bool(ev.get("success"))
        hour_ts = int(ts // 3600)
        _add_event_to_buckets(st["last24h_buckets"], hour_ts, success)
        _add_event_to_daily(st["daily_buckets"], int(ts // 86400), success)
        if session_file:
            entry = session_stats.get(session_file)
            if not entry or not isinstance(entry, dict):
                entry = {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []}
            entry = dict(entry)
            entry.setdefault("last24h_buckets", [])
            _add_event_to_buckets(entry["last24h_buckets"], hour_ts, success)
            session_stats[session_file] = entry
    for session_file, deltas in p["session_deltas"].items():
        entry = session_stats.get(session_file) or {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []}
        if not isinstance(entry, dict):
            entry = {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []}
        entry = dict(entry)
        entry["lifetime_sent"] = int(entry.get("lifetime_sent", 0)) + deltas.get("sent", 0)
        entry["lifetime_failed"] = int(entry.get("lifetime_failed", 0)) + deltas.get("failed", 0)
        entry.setdefault("last24h_buckets", [])
        session_stats[session_file] = entry
    _prune_buckets(st["last24h_buckets"], now)
    _prune_daily(st["daily_buckets"], now)
    for entry in session_stats.values():
        if isinstance(entry, dict) and "last24h_buckets" in entry:
            _prune_buckets(entry["last24h_buckets"], now)
    st["lifetime_sent"] = lifetime_sent
    st["lifetime_failed"] = lifetime_failed
    st["created_at"] = created_at
    st["session_stats"] = session_stats
    save_stats(name, st)
    p["pending_events"].clear()
    p["lifetime_sent_delta"] = 0
    p["lifetime_failed_delta"] = 0
    p["session_deltas"].clear()
    p["last_flush_ts"] = time.time()


def _get_stats_for_display(bot_token: str) -> dict:
    """Return stats from data/stats/<name>.json merged with pending buffer. Counts + 24h buckets only."""
    name = get_name_by_token(bot_token)
    if not name:
        return {}
    now = time.time()
    st = load_stats(name)
    if not st or not isinstance(st, dict):
        cfg = _get_cfg(bot_token)
        legacy = (cfg or {}).get("stats") if cfg else None
        if legacy and isinstance(legacy, dict):
            st = {
                "lifetime_sent": int(legacy.get("lifetime_sent", 0)),
                "lifetime_failed": int(legacy.get("lifetime_failed", 0)),
                "created_at": legacy.get("created_at") or now,
                "session_stats": dict(legacy.get("session_stats") or {}),
                "last24h_buckets": [],
            }
            for ev in legacy.get("recent_events") or []:
                ts = ev.get("ts") or 0
                if ts < now - RECENT_EVENTS_WINDOW_SEC:
                    continue
                hour_ts = int(ts // 3600)
                _add_event_to_buckets(st["last24h_buckets"], hour_ts, bool(ev.get("success")))
                sess = (ev.get("session") or "").strip()
                if sess:
                    st["session_stats"].setdefault(sess, {"lifetime_sent": 0, "lifetime_failed": 0, "last24h_buckets": []})
                    _add_event_to_buckets(st["session_stats"][sess].setdefault("last24h_buckets", []), hour_ts, bool(ev.get("success")))
        else:
            st = _default_stats_data()
    p = _stats_pending.get(bot_token)
    lifetime_sent = int(st.get("lifetime_sent", 0)) + (p["lifetime_sent_delta"] if p else 0)
    lifetime_failed = int(st.get("lifetime_failed", 0)) + (p["lifetime_failed_delta"] if p else 0)
    session_stats = {}
    for sess, entry in (st.get("session_stats") or {}).items():
        if not isinstance(entry, dict):
            continue
        entry = dict(entry)
        ls = int(entry.get("lifetime_sent", 0))
        lf = int(entry.get("lifetime_failed", 0))
        buckets = list(entry.get("last24h_buckets") or [])
        if p and p.get("session_deltas") and sess in p["session_deltas"]:
            ls += p["session_deltas"][sess].get("sent", 0)
            lf += p["session_deltas"][sess].get("failed", 0)
        if p and p.get("pending_events"):
            for ev in p["pending_events"]:
                if (ev.get("session") or "").strip() != sess:
                    continue
                ts = ev.get("ts") or 0
                if ts >= now - RECENT_EVENTS_WINDOW_SEC:
                    _add_event_to_buckets(buckets, int(ts // 3600), bool(ev.get("success")))
        sent_24, failed_24 = _sum_buckets(buckets)
        session_stats[sess] = {
            "lifetime_sent": ls,
            "lifetime_failed": lf,
            "last24h_sent": sent_24,
            "last24h_failed": failed_24,
            "cycles": int(entry.get("cycles", 0)),
            "last_cycle_ts": entry.get("last_cycle_ts", 0),
            "last_cycle_success": int(entry.get("last_cycle_success", 0)),
            "last_cycle_failed": int(entry.get("last_cycle_failed", 0)),
            "last_cycle_skipped": int(entry.get("last_cycle_skipped", 0)),
            "last_cycle_attempted": int(entry.get("last_cycle_attempted", 0)),
            "last_cycle_duration_sec": entry.get("last_cycle_duration_sec", 0),
            "avg_cycle_duration_sec": entry.get("avg_cycle_duration_sec", 0),
            "best_cycle_success": int(entry.get("best_cycle_success", 0)),
            "best_cycle_ts": entry.get("best_cycle_ts", 0),
        }
    global_buckets = list(st.get("last24h_buckets") or [])
    daily_buckets = [dict(b) for b in (st.get("daily_buckets") or [])]
    if p and p.get("pending_events"):
        for ev in p["pending_events"]:
            ts = ev.get("ts") or 0
            if ts >= now - RECENT_EVENTS_WINDOW_SEC:
                _add_event_to_buckets(global_buckets, int(ts // 3600), bool(ev.get("success")))
            _add_event_to_daily(daily_buckets, int(ts // 86400), bool(ev.get("success")))
    sent_24, failed_24 = _sum_buckets(global_buckets)
    daily_buckets.sort(key=lambda b: b.get("day_ts") or 0)
    return {
        "lifetime_sent": lifetime_sent,
        "lifetime_failed": lifetime_failed,
        "created_at": st.get("created_at") or now,
        "session_stats": session_stats,
        "last24h_sent": sent_24,
        "last24h_failed": failed_24,
        "last24h_buckets": global_buckets,
        "daily_buckets": daily_buckets,
        "total_cycles": int(st.get("total_cycles", 0)),
        "last_cycle_ts": st.get("last_cycle_ts", 0),
        "last_cycle_session": st.get("last_cycle_session", ""),
    }


async def _forward_messages_to_topic(
    client: TelegramClient,
    entity: Any,
    message_ids: int | list[int],
    from_peer: Any,
    topic_id: int,
) -> list[Any] | None:
    """Forward message(s) into a forum topic. Uses raw ForwardMessagesRequest because the high-level
    client.forward_messages() does not accept top_msg_id. Returns list of Message or None."""
    ids = [message_ids] if isinstance(message_ids, int) else list(message_ids)
    if not ids:
        return None
    to_input = await client.get_input_entity(entity)
    from_input = await client.get_input_entity(from_peer)
    random_ids = [random.randint(-(2**63), 2**63 - 1) for _ in ids]
    req = ForwardMessagesRequest(
        from_peer=from_input,
        id=ids,
        to_peer=to_input,
        random_id=random_ids,
        top_msg_id=topic_id,
    )
    updates = await client(req)
    # Telethon: _get_response_message(self, request, result, input_chat); returns list when request.random_id is list
    resp = client._get_response_message(req, updates, entity)
    if resp is None:
        return None
    if isinstance(resp, list):
        return resp if resp else None
    return [resp]


def _parse_post_link(link: str) -> tuple[Any, int] | None:
    """Parse t.me/c/CHATID/MSGID or t.me/username/MSGID into (from_peer, message_id). Returns None if invalid."""
    if not link or not isinstance(link, str):
        return None
    link = link.strip()
    m = re.match(r"https?://t\.me/c/(\d+)/(\d+)", link, re.I)
    if m:
        chat_part, msg_id = m.group(1), int(m.group(2))
        return (int("-100" + chat_part), msg_id)
    m = re.match(r"https?://t\.me/([a-zA-Z0-9_]+)/(\d+)", link, re.I)
    if m:
        return (m.group(1), int(m.group(2)))
    m = re.match(r"t\.me/c/(\d+)/(\d+)", link, re.I)
    if m:
        chat_part, msg_id = m.group(1), int(m.group(2))
        return (int("-100" + chat_part), msg_id)
    m = re.match(r"t\.me/([a-zA-Z0-9_]+)/(\d+)", link, re.I)
    if m:
        return (m.group(1), int(m.group(2)))
    return None


def _get_post_links_list(cfg: dict) -> list[str]:
    """Return list of post links (forward URLs). Supports legacy single post_link."""
    links = cfg.get("post_links")
    if isinstance(links, list):
        return [str(x).strip() for x in links if x and str(x).strip()]
    single = (cfg.get("post_link") or "").strip()
    return [single] if single else []


def _get_message_mode(cfg: dict) -> str:
    """Return 'text' or 'link'. Which type of message to post. Default 'link' for backward compat."""
    return "text" if (cfg.get("message_mode") or "").strip().lower() == "text" else "link"


def _message_link(entity: Any, msg_id: int, topic_id: int | None = None) -> str:
    """Build clickable t.me link to a message. topic_id -> ?thread=<topic_id> for forum topics."""
    base = ""
    username = getattr(entity, "username", None)
    if username:
        base = f"https://t.me/{username}/{msg_id}"
    else:
        eid = getattr(entity, "id", None)
        if eid is not None:
            s = str(eid)
            base = f"https://t.me/c/{s[4:]}/{msg_id}" if s.startswith("-100") else f"https://t.me/c/{s}/{msg_id}"
    if base and topic_id is not None:
        return f"{base}?thread={topic_id}"
    return base or ""


def _escape_md_link_text(s: str) -> str:
    """Escape ] and \\ for use inside [text](url) so text does not break markdown."""
    return (s or "").replace("\\", "\\\\").replace("]", "\\]").replace("[", "\\[")


# Tolerates an optional leading premium-emoji fallback glyph (log_success/log_failed both use 🔘)
# so the file-log dedup check in the "log" IPC handler still recognizes post-result lines.
_POST_RESULT_RE = re.compile(r"^(?:\U0001F518\s+)?Account\s+\d+\s*-\s*(?:Posted in|Sent to|Success in|Failed in|FloodWait\s)")


def _format_post_success(account_index: int, session_file: str, group_title: str, link: str) -> tuple[str, str, list[tuple]]:
    """(plain, text, entity_spec): plain has no emoji (for the file log); text is the Telegram-
    bound line — premium emoji + group name as a clickable TEXT_LINK entity (no HTML markup, so
    it composes safely with the leading custom-emoji entity — Telegram drops entities if
    parse_mode is also set on the same request)."""
    from .ui.emoji_entities import fallback_glyph, u16len

    plain = f"Account {account_index} - Posted in {group_title} {link}"
    label = f"Account {account_index} - Posted in {group_title}"
    glyph = fallback_glyph("log_success")
    text = f"{glyph} {label}"
    spec = [
        ("emoji", 0, u16len(glyph), "log_success"),
        ("link", u16len(glyph) + 1, u16len(label), link),
    ]
    return plain, text, spec


def _format_post_failure(
    account_index: int,
    session_file: str,
    chat_id: int,
    topic_id: int | None,
    reason: str,
    group_title: str | None = None,
) -> tuple[str, str, list[tuple]]:
    """(plain, text, entity_spec): plain has no emoji (for the file log); text is the Telegram-
    bound line with a leading premium emoji. Includes group (title or chat_id) and real error
    so the log shows where and why."""
    from .ui.emoji_entities import fallback_glyph, u16len

    where = (group_title or f"chat_id={chat_id}" + (f" topic_id={topic_id}" if topic_id else "")) if chat_id else "unknown"
    plain = f"Account {account_index} - Failed in {where}: {reason[:280]}"
    glyph = fallback_glyph("log_failed")
    text = f"{glyph} {plain}"
    spec = [("emoji", 0, u16len(glyph), "log_failed")]
    return plain, text, spec


def _log_post_result(
    bot_token: str, success: bool, account_index: int, session_file: str,
    report_log: Optional[Callable[..., None]] = None,
    report_post_attempt: Optional[Callable[[str, int, int | None, bool, str], None]] = None,
    **kwargs: Any,
) -> None:
    """Centralized posting-result logger: single-line, no emoji. Log group: link hidden in group name for success.
    When report_log is provided (worker), call it instead of enqueue_log/log_bot_event.
    When report_post_attempt is provided (worker), it is called for operator log: account, group_name, group_id, result, wait_seconds if flood."""
    chat_id = kwargs.get("chat_id", 0)
    topic_id = kwargs.get("topic_id")
    reason = kwargs.get("reason", "")
    group_title = kwargs.get("group_title", "") or ""
    wait_seconds = kwargs.get("wait_seconds")
    if report_post_attempt:
        report_post_attempt(
            session_file, chat_id, topic_id, success, reason if not success else "",
            group_name=group_title,
            wait_seconds=wait_seconds,
        )
    if success:
        plain, text, spec = _format_post_success(
            account_index=account_index,
            session_file=session_file,
            group_title=kwargs["group_title"],
            link=kwargs["link"],
        )
        if report_log:
            report_log(bot_token, text, entity_spec=spec)
        else:
            from .ui.emoji_entities import entities_from_spec
            enqueue_log(bot_token, text, entities=entities_from_spec(spec))
            log_bot_event(bot_token, plain)
    else:
        plain, text, spec = _format_post_failure(
            account_index=account_index,
            session_file=session_file,
            chat_id=chat_id,
            topic_id=topic_id,
            reason=reason or "unknown",
            group_title=kwargs.get("group_title"),
        )
        if report_log:
            report_log(bot_token, text, entity_spec=spec)
        else:
            from .ui.emoji_entities import entities_from_spec
            enqueue_log(bot_token, text, entities=entities_from_spec(spec))
            log_bot_event(bot_token, plain)


def _is_numeric_group_id(line: str) -> bool:
    """True if line is a numeric group/channel id (integer or -100xxxxxxxxxx). No names, no links."""
    s = (line or "").strip()
    if not s:
        return False
    if s.startswith("-"):
        return s[1:].isdigit()
    return s.isdigit()


def _normalize_group_id(line: str) -> str:
    """Ensure group id is in -100... form for get_entity. One numeric id per line, no names."""
    s = (line or "").strip()
    if not s:
        return s
    if s.startswith("-"):
        return s
    if s.isdigit() and len(s) >= 5:
        return "-100" + s
    return s


def _parse_groups_file(cfg: dict) -> list[dict]:
    """Parse group_file into normalized targets. One parser for groups.txt.
    Each line: normal group '-1001234567890' or forum topic '-1001234567890 | 34'.
    Returns list of {"chat_id": int, "topic_id": int | None}. Invalid lines skipped with warning.
    If cfg has "groups_dir", use that path (for worker processes with explicit base)."""
    gf = cfg.get("group_file", "Starter.txt")
    base = Path(cfg["groups_dir"]) if cfg.get("groups_dir") else config.GROUPS_DIR
    path = base / gf
    if not path.is_file():
        return []
    valid: list[dict] = []
    for ln in path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = (ln or "").strip()
        if not raw:
            continue
        if "|" in raw:
            parts = [p.strip() for p in raw.split("|")]
            chat_part = parts[0]
            topic_part = parts[1] if len(parts) >= 2 and parts[1] else ""
        else:
            chat_part = raw
            topic_part = ""
        if not chat_part or not _is_numeric_group_id(chat_part):
            logger.warning("Invalid group line skipped (bad chat_id): %s", raw[:80])
            continue
        try:
            chat_id = int(_normalize_group_id(chat_part))
        except ValueError:
            logger.warning("Invalid group line skipped (chat_id not int): %s", raw[:80])
            continue
        topic_id: int | None = None
        if topic_part:
            try:
                topic_id = int(topic_part)
            except ValueError:
                logger.warning("Invalid group line skipped (topic_id not int): %s", raw[:80])
                continue
        valid.append({"chat_id": chat_id, "topic_id": topic_id})
    return valid


def _load_groups(cfg: dict) -> list[dict]:
    """Return list of {"chat_id": int, "topic_id": int | None} from group_file. Use _parse_groups_file."""
    return _parse_groups_file(cfg)


def _rotate_group_list_by_cycle_index(
    groups: list[dict], cycle_sec: int | float, session_ordinal: int = 0
) -> list[dict]:
    """Rotate group list so the logical 'head' changes each cycle AND per session. The cycle term keeps
    fairness (no group is systematically last when FloodWait trims the tail); the per-session term
    (session_ordinal) ensures the N accounts don't all start on the same group in the same cycle, so a
    single group isn't hit by every account back-to-back. cycle_sec from cfg (e.g. 3600)."""
    if not groups:
        return []
    sec = max(1, int(cycle_sec))
    idx = (int(time.time() // sec) + max(0, int(session_ordinal))) % len(groups)
    return list(groups[idx:]) + list(groups[:idx])


def _target_display(t: dict) -> str:
    """Short string for logging: chat_id or chat_id#topic_id."""
    cid = t.get("chat_id", "")
    tid = t.get("topic_id")
    return f"{cid}#{tid}" if tid is not None else str(cid)


def _target_key_for_skip(g: dict) -> str:
    """Stable key for ban-error tracking: chat_id or chat_id#topic_id."""
    cid = g.get("chat_id", "")
    tid = g.get("topic_id")
    return f"{cid}#{tid}" if tid is not None else str(cid)


BAN_ERROR_TTL_SEC = 24 * 3600  # ban_error_count_by_session entries older than this are ignored


def _should_skip_target_for_ban(bot_token: str, session_file: str, g: dict) -> bool:
    """True if this (session, target) is permanently blacklisted due to genuine ban/permission errors.
    Entries are subject to a 24h TTL; legacy integer-only entries are treated as expired."""
    data = load_adbot()
    cfg = data.get("bots", {}).get(bot_token)
    if not cfg:
        return False
    by_sess = cfg.get("ban_error_count_by_session") or {}
    counts = by_sess.get(session_file) or {}
    key = _target_key_for_skip(g)
    entry = counts.get(key)
    now = time.time()
    # New format: {"c": int, "ts": float}
    if isinstance(entry, dict):
        ts = float(entry.get("ts") or 0.0)
        if ts and (now - ts) > BAN_ERROR_TTL_SEC:
            return False
        return (entry.get("c") or 0) >= 1
    # Legacy format: plain int count with no timestamp → treat as expired going forward
    return False


def _increment_ban_error_count(bot_token: str, session_file: str, chat_id: int, topic_id: int | None) -> None:
    """Increment ban-from-channel count for (session, target). Entries carry a timestamp so they naturally expire."""
    def upd(c):
        by_sess = c.setdefault("ban_error_count_by_session", {})
        counts = by_sess.setdefault(session_file, {})
        key = f"{chat_id}#{topic_id}" if topic_id is not None else str(chat_id)
        existing = counts.get(key)
        now = time.time()
        if isinstance(existing, dict):
            existing["c"] = (existing.get("c") or 0) + 1
            existing["ts"] = now
            counts[key] = existing
        elif isinstance(existing, int):
            # Migrate legacy plain count to structured format with TTL.
            counts[key] = {"c": existing + 1, "ts": now}
        else:
            counts[key] = {"c": 1, "ts": now}
    _save_bot_config(bot_token, upd)


def _assigned_groups_for_session(
    bot_token: str, cfg: dict, session_file: str, session_index: int, total_sessions: int | None = None
) -> tuple[list[dict], int]:
    """Assign targets from group_file at runtime. Returns (groups_for_this_session, total_groups_count).
    Cooldown and excluded_sessions are enforced at assignment (controller and worker); restart/reload cannot bypass.
    Starter: every session gets the full list (no partitioning). All sessions post to all groups sequentially.
    Enterprise: groups are evenly sharded across sessions; session i gets slice [i*N/T : (i+1)*N/T]; no overlap.
    On session failure (e.g. FloodWait), deferred groups are redistributed to healthy sessions.
    excluded_groups (optional): list of group keys to never assign (persistent dead-group pruning)."""
    all_groups = _load_groups(cfg)
    # Persistent exclusion: groups that were permanently failed (e.g. auto_prune_dead_groups)
    excluded_group_keys = set(cfg.get("excluded_groups") or [])
    if excluded_group_keys:
        all_groups = [g for g in all_groups if _target_key_for_skip(g) not in excluded_group_keys]
    excluded = set(cfg.get("excluded_sessions") or []) | _disabled_session_files(cfg)
    if session_file in excluded:
        return [], len(all_groups)
    # FloodWait pause: do not assign groups to a session that is paused (resume only after pause expires).
    pause_until = (cfg.get("session_pause_until") or {}).get(session_file) or 0
    if pause_until > time.time():
        logger.info("[FloodWait] session=%s pause_until=%.0f no assignment this cycle", session_file, pause_until)
        return [], len(all_groups)
    # Controller-level cooldown enforcement: cannot be bypassed by worker restart, config reload, or snapshot rebuild.
    now_ts = time.time()
    cooldown_until = (cfg.get("session_cooldown_until") or {}).get(session_file) or 0
    if cooldown_until and now_ts < cooldown_until:
        logger.info("[Cooldown] session=%s cooldown_until=%.0f enforced=True", session_file, cooldown_until)
        return [], len(all_groups)
    if not all_groups:
        return [], 0
    mode = get_plan_mode(cfg)
    if mode != "Enterprise":
        from .chatlist import STARTER_MAX_GROUPS
        capped = all_groups[:STARTER_MAX_GROUPS] if len(all_groups) > STARTER_MAX_GROUPS else all_groups
        cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
        rotated = _rotate_group_list_by_cycle_index(list(capped), cycle_sec, session_index)
        return rotated, len(all_groups)
    # Enterprise: partition by FULL session list so no session ever gets more than 1/T of groups
    # (avoids one remaining session getting 100% when others are paused → FloodWait cascade).
    # Paused/excluded sessions already returned [] above; active_list still gates "allow assignment" only.
    active_list = cfg.get("active_session_files")
    if active_list and session_file not in active_list:
        return [], len(all_groups)
    # Partition denominator = full configured session count (not active count) so shard size is capped.
    sessions_list = [(s.get("file") or "").strip() for s in (cfg.get("sessions") or [])]
    sessions_list = [f for f in sessions_list if f]
    if not sessions_list:
        total_denom = max(1, total_sessions or 1)
        idx_global = max(0, min(session_index, total_denom - 1))
    else:
        total_denom = len(sessions_list)
        if session_file not in sessions_list:
            return [], len(all_groups)
        idx_global = sessions_list.index(session_file)
    n = len(all_groups)
    start = idx_global * n // total_denom
    end = (idx_global + 1) * n // total_denom
    return list(all_groups[start:end]), len(all_groups)


def _shard_size(session_index: int, total_sessions: int, total_groups: int) -> int:
    """Enterprise shard size for session i: exactly (i+1)*N//T - i*N//T. Used for verification and load balance."""
    if total_sessions <= 0 or total_groups <= 0:
        return 0
    idx = max(0, min(session_index, total_sessions - 1))
    n = total_groups
    t = total_sessions
    start = idx * n // t
    end = (idx + 1) * n // t
    return end - start


def _verify_assignment_report(
    mode: str,
    total_sessions: int,
    total_groups: int,
    session_index: int,
    assigned_count: int,
    report_user_log: Optional[Callable[[str], None]] = None,
) -> None:
    """Emit verification report line: Mode, sessions, groups, coverage/assigned, duplicates=False[, unassigned=0]."""
    mode = (mode or "Starter").strip()
    if mode != "Enterprise":
        msg = (
            f"[VerificationReport] Mode=Starter sessions={total_sessions} groups={total_groups} "
            f"coverage={total_groups} duplicates=False"
        )
    else:
        expected = _shard_size(session_index, total_sessions, total_groups)
        msg = (
            f"[VerificationReport] Mode=Enterprise sessions={total_sessions} groups={total_groups} "
            f"assigned_this_session={assigned_count} expected_shard={expected} "
            f"assigned_total={total_groups} duplicates=False unassigned=0"
        )
    if report_user_log:
        report_user_log(msg)
    else:
        logger.info("%s", msg)


def _persist_last_cycle(bot_token: str, session_file: str) -> None:
    """Persist last_cycle_time = now (legacy). Prefer _persist_last_cycle_at for drift-free scheduling."""
    def upd(c):
        c.setdefault("last_cycle_time", {})[session_file] = time.time()
    _save_bot_config(bot_token, upd)


def _persist_last_cycle_at(bot_token: str, session_file: str, timestamp: float) -> None:
    """Persist last_cycle_time = timestamp (scheduled run time) for anchor-based scheduling."""
    def upd(c):
        c.setdefault("last_cycle_time", {})[session_file] = timestamp
    _save_bot_config(bot_token, upd)


def _persist_cycle_progress(bot_token: str, session_file: str, cycle_ts: float, posted_keys: list) -> None:
    """Persist a session's mid-cycle posting checkpoint (posted group keys for the cycle at cycle_ts)
    to the stats file. Kept out of the user JSON to avoid bloat; it is transient and cleared on
    cycle completion. On restart it is injected into the worker snapshot so the cycle resumes."""
    name = get_name_by_token(bot_token)
    if not name:
        return
    try:
        st = load_stats(name)
        if not isinstance(st, dict):
            st = _default_stats_data()
        cp = st.setdefault("cycle_progress", {})
        if not isinstance(cp, dict):
            cp = {}
            st["cycle_progress"] = cp
        cp[session_file] = {"cycle_ts": float(cycle_ts), "posted": list(dict.fromkeys(str(k) for k in posted_keys if k))}
        save_stats(name, st)
    except Exception as e:
        logger.debug("persist cycle_progress failed bot=%s session=%s: %s", bot_token[:12], session_file, e)


def _clear_cycle_progress(bot_token: str, session_file: str) -> None:
    """Drop a session's resume checkpoint once its cycle finished (or when no longer needed)."""
    name = get_name_by_token(bot_token)
    if not name:
        return
    try:
        st = load_stats(name)
        if isinstance(st, dict) and isinstance(st.get("cycle_progress"), dict):
            if st["cycle_progress"].pop(session_file, None) is not None:
                save_stats(name, st)
    except Exception as e:
        logger.debug("clear cycle_progress failed bot=%s session=%s: %s", bot_token[:12], session_file, e)


def _load_cycle_progress_for_snapshot(bot_token: str | None, cfg: dict) -> dict:
    """Read persisted cycle_progress (from the stats file) for injection into a worker snapshot,
    so workers can resume an interrupted cycle after a restart. Returns {} on any problem."""
    try:
        name = (cfg.get("name") or "").strip() or (get_name_by_token(bot_token) if bot_token else None)
        if not name:
            return {}
        st = load_stats(name)
        cp = st.get("cycle_progress") if isinstance(st, dict) else None
        return dict(cp) if isinstance(cp, dict) else {}
    except Exception:
        return {}


# Reconnection: max attempts and delay between attempts (per cycle connect)
SESSION_RECONNECT_MAX_ATTEMPTS = 7
SESSION_RECONNECT_DELAY_SEC = 10
# Connect timeout so scheduler cycle is not blocked indefinitely; avoids false "worker frozen" from long connect
SESSION_CONNECT_TIMEOUT_SEC = 25
# Heartbeat interval during connect so health monitor does not restart worker while connecting
SESSION_CONNECT_HEARTBEAT_INTERVAL_SEC = 8


def _mark_bot_expired(bot_token: str, from_worker: bool = False) -> None:
    """Submit expire_bot job to main loop: stop bot, return sessions to pool (validate, move invalid to dead), notify admin.
    from_worker=True when called from posting loop (avoids deadlock)."""
    from .admin_ptb import submit_main_loop_job
    submit_main_loop_job("expire_bot", (bot_token,))
    logger.info("Expire bot job submitted: %s", bot_token[:20])


def _mark_bot_dead(bot_token: str, reason: str) -> None:
    """Mark bot as dead in user file, stop posting, notify admin. Call when token invalid/revoked."""
    asyncio.create_task(_stop_posting(bot_token))
    cfg = _get_cfg(bot_token)
    if not cfg:
        return
    name_display = cfg.get("name") or bot_token[:20]
    _save_bot_config(bot_token, lambda c: c.update({"state": "dead", "dead_reason": reason}))
    add_admin_alert("bot_dead", f"AdBot {name_display} marked dead: {reason[:200]}")
    logger.warning("Bot marked dead: %s — %s", name_display, reason)


def _auto_replace_dead_session(bot_token: str, user_name: str, dead_session_file: str) -> None:
    """DEPRECATED / UNUSED. Silent free auto-replacement was removed on purpose: it handed a
    paid replacement out for free and bypassed the owner's plan quota. Dead sessions now go
    through _notify_dead_session_replacement → the owner replaces them (free within quota,
    else paid). Kept only for reference; do not call from the runtime death path.

    Auto-pull a free session from pool to replace a dead one. Best-effort; if no free sessions, skip."""
    # This runs in a sync context only; on a live event loop we can't safely do the
    # blocking pool work here, so bail early (same as before).
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            logger.info("[AutoReplace] Event loop running; skipping sync replace for %s", dead_session_file)
            return
    except RuntimeError:
        pass
    # Atomically pick + claim a free session whose file exists, under the shared
    # pool lock so creation/replacement can't hand out the same account.
    candidate = None
    with SESSION_POOL_LOCK:
        pool = load_pool()
        free = list(pool.get("free_sessions", []))
        if not free:
            logger.info("[AutoReplace] No free sessions available to replace %s", dead_session_file)
            return
        for c in free:
            if config.resolve_session_path(c).is_file():
                candidate = c
                break
        if not candidate:
            logger.info("[AutoReplace] No valid free sessions found to replace %s", dead_session_file)
            return
        pool["free_sessions"] = [f for f in pool.get("free_sessions", []) if f != candidate]
        save_pool(pool)

    cfg = load_user_data(user_name)
    if not cfg:
        return
    sessions = list(cfg.get("sessions", []))
    sessions.append({"file": candidate, "real_name": candidate, "user_id": 0, "index": len(sessions) + 1})
    cfg["sessions"] = sessions
    cfg.setdefault("session_replacements", [])
    cfg["session_replacements"].append({
        "at": datetime.utcnow().isoformat() + "Z",
        "old_session": dead_session_file,
        "new_session": candidate,
        "reason": "auto_replace",
        "source": "auto_replace_dead",
    })
    cfg["session_replacements"] = cfg["session_replacements"][-100:]
    save_user_data(user_name, cfg)
    add_admin_alert(
        "session_auto_replaced",
        f"Session {dead_session_file} died → auto-replaced with {candidate} from free pool.",
    )
    logger.info("[AutoReplace] Replaced dead %s with free %s", dead_session_file, candidate)


def _mark_session_dead_and_replace(bot_token: str, session_file: str, log_msg: str) -> None:
    """Remove session from bot, add to dead_sessions, move file to dead/, auto-replace from free pool, notify admin."""
    from datetime import datetime
    user_name = get_name_by_token(bot_token)
    if not user_name:
        return
    cfg = load_user_data(user_name)
    if not cfg:
        return
    name_display = cfg.get("name") or bot_token[:20]
    old_sessions = cfg.get("sessions", [])
    dead_real_name = next(
        (s.get("real_name") for s in old_sessions if s.get("file") == session_file),
        session_file,
    )
    sessions = [s for s in old_sessions if s.get("file") != session_file]
    cfg["sessions"] = sessions
    cfg.setdefault("session_replacements", [])
    cfg["session_replacements"].append({
        "at": datetime.utcnow().isoformat() + "Z",
        "old_session": session_file,
        "new_session": None,
        "reason": "dead",
        "source": "auto_session_died",
        "note": log_msg[:200] if log_msg else None,
    })
    cfg["session_replacements"] = cfg["session_replacements"][-100:]
    save_user_data(user_name, cfg)
    path = config.resolve_session_path(session_file)
    dead_name = Path(session_file).name
    if session_file.startswith("users/"):
        # User-uploaded session: do NOT add to admin pool or move to sessions/dead/.
        # Rename in-place to .dead so user's directory keeps record but session won't be re-used.
        if path.is_file():
            dead_in_place = path.with_suffix(".session.dead")
            try:
                shutil.move(str(path), str(dead_in_place))
            except OSError:
                pass
        logger.warning("User session dead (kept in user dir): %s — %s", session_file, log_msg)
    else:
        # Admin-assigned session: move to dead pool and dead/ directory.
        # NOTE: this runs on the posting event loop, so it must NOT take the shared
        # SESSION_POOL_LOCK (a build can hold it for minutes → would freeze posting).
        # This only moves a session INTO dead (never claims a free one), so it can't
        # cause the two-bots-one-session double-spend; a rare lost bucket update here
        # is cosmetic (the file is already moved out of active/).
        pool = load_pool()
        pool.setdefault("dead_sessions", [])
        if dead_name not in pool["dead_sessions"] and session_file not in pool["dead_sessions"]:
            pool["dead_sessions"].append(dead_name)
        # Remove from all other buckets (both original path and flat name)
        for bk in ("free_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
            pool[bk] = [f for f in pool.get(bk, []) if f != session_file and f != dead_name]
        save_pool(pool)
        dead_path = config.SESSIONS_DEAD / dead_name
        if path.is_file():
            try:
                shutil.move(str(path), str(dead_path))
            except OSError:
                pass
    admin_msg = format_session_death_admin_message(session_file, log_msg)
    add_admin_alert("session_died", admin_msg)
    logger.warning("Session dead: %s — %s", session_file, log_msg)
    # Do NOT silently pull a free session from the pool. That would hand out a paid
    # replacement for free and bypass the owner's plan quota. Instead, flag the dead
    # session for replacement and notify the owner (Replace Free / Pay $) + admin, so the
    # user replaces it themselves through the normal flow (free within quota, else paid).
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(
            _notify_dead_session_replacement(bot_token, session_file, dead_real_name, log_msg)
        )
    else:
        logger.info(
            "[DeadSession] %s flagged; no running loop to notify owner (worker context) — "
            "controller safety sweep / portal will surface it",
            session_file,
        )


async def _connect_session_for_cycle(
    client: "TelegramClient",
    session_file: str,
    bot_token: str,
    *,
    report_heartbeat: Optional[Callable[[], None]] = None,
    report_user_log: Optional[Callable[[str], None]] = None,
    report_session_died: Optional[Callable[[str, str], None]] = None,
) -> str:
    """Connect client for this cycle (or ensure already connected).
    Returns "ok" (connected + authorized), "unauth" (connected but session logged out /
    de-authorized — dead), or "failed" (transient connect failure after retries).
    On "unauth" it calls report_session_died so the dead session is flagged for replacement.
    Returns "busy" (distinct from "failed") when every attempt was blocked by another
    task holding the session lock, so the caller can report a self-lock — an internal
    lock contention — instead of a misleading "can't reach Telegram" failure.
    Uses SESSION_CONNECT_TIMEOUT_SEC so scheduler is not blocked; sends heartbeat during connect to avoid false worker frozen."""
    last_busy: Optional["SessionBusyError"] = None
    for attempt in range(SESSION_RECONNECT_MAX_ATTEMPTS):
        connect_start = time.time()
        if report_user_log:
            report_user_log(f"[Connect] session={session_file} connect_start attempt={attempt + 1}")
        logger.info("[Connect] session=%s connect_start attempt=%s", session_file, attempt + 1)
        try:
            try:
                await client.disconnect()
            except Exception:
                pass

            async def _do_connect() -> None:
                await client.connect()

            connect_task = asyncio.create_task(_do_connect())
            heartbeat_task: Optional[asyncio.Task] = None
            if report_heartbeat:

                async def _heartbeat_during_connect() -> None:
                    while True:
                        await asyncio.sleep(SESSION_CONNECT_HEARTBEAT_INTERVAL_SEC)
                        report_heartbeat()

                heartbeat_task = asyncio.create_task(_heartbeat_during_connect())
            try:
                await asyncio.wait_for(connect_task, timeout=SESSION_CONNECT_TIMEOUT_SEC)
            except asyncio.TimeoutError:
                connect_task.cancel()
                try:
                    await connect_task
                except asyncio.CancelledError:
                    pass
                logger.warning(
                    "Session %s connect timeout after %.1fs (attempt %s)",
                    session_file, SESSION_CONNECT_TIMEOUT_SEC, attempt + 1,
                )
                if report_user_log:
                    report_user_log(f"[Connect] session={session_file} timeout after {SESSION_CONNECT_TIMEOUT_SEC}s attempt={attempt + 1}")
                raise  # will be caught below, retry with delay
            finally:
                if heartbeat_task is not None:
                    heartbeat_task.cancel()
                    try:
                        await heartbeat_task
                    except asyncio.CancelledError:
                        pass

            if not await client.is_user_authorized():
                # Connected fine but the session is logged out / de-authorized — this is a
                # dead account, not a transient failure. Flag it for replacement (owner is
                # notified: free within quota, else paid) instead of silently skipping it
                # every cycle forever.
                logger.warning("Session %s not authorized — de-authorized/logged out (attempt %s)", session_file, attempt + 1)
                if report_user_log:
                    report_user_log(f"[Connect] session={session_file} UNAUTHORIZED — session logged out; flagging for replacement")
                if report_session_died:
                    report_session_died(session_file, "UNAUTHORIZED — session logged out or de-authorized")
                return "unauth"
            connect_end = time.time()
            duration = connect_end - connect_start
            logger.info("[Connect] session=%s connect_end duration_sec=%.2f", session_file, duration)
            if report_user_log:
                report_user_log(f"[Connect] session={session_file} connect_end duration_sec={duration:.2f}")
            return "ok"
        except SessionBusyError as e:
            # Session file is held by another task (chatlist sync, health check, portal, …).
            # Report WHO holds it and how long to wait, then retry with backoff.
            last_busy = e
            logger.warning("Session %s connect blocked (attempt %s): %s", session_file, attempt + 1, e)
            if report_user_log:
                report_user_log(f"[Connect] session={session_file} waiting: {e}")
            if attempt < SESSION_RECONNECT_MAX_ATTEMPTS - 1:
                await asyncio.sleep(min(SESSION_RECONNECT_DELAY_SEC * (2 ** attempt), 60))
            continue
        except Exception as e:
            last_busy = None  # a real connect error supersedes any earlier lock contention
            connect_end = time.time()
            duration = connect_end - connect_start
            logger.warning(
                "Session %s connect failed (attempt %s) after %.2fs: %s",
                session_file, attempt + 1, duration, e,
            )
            if report_user_log:
                report_user_log(f"[Connect] session={session_file} connect_failed attempt={attempt + 1} duration_sec={duration:.2f} error={e!r}")
            try:
                await client.disconnect()
            except Exception:
                pass
            if attempt < SESSION_RECONNECT_MAX_ATTEMPTS - 1:
                backoff = min(SESSION_RECONNECT_DELAY_SEC * (2 ** attempt), 60)
                await asyncio.sleep(backoff)
    # All attempts exhausted. If the last obstacle was a lock (not a real connect
    # error), report it as a self-lock so the alert is diagnosable.
    return "busy" if last_busy is not None else "failed"


async def _async_session_loop(
    bot_token: str, session_ordinal: int, total_workers: int, session_file: str, stagger_sec: float,
    stop_event: asyncio.Event | None = None,
    *,
    get_config: Optional[Callable[[], dict]] = None,
    report_cycle_done: Optional[Callable[[str, float], None]] = None,
    report_cycle_progress: Optional[Callable[[str, float, list], None]] = None,
    report_cycle_failed: Optional[Callable[[str], None]] = None,
    report_session_died: Optional[Callable[[str, str], None]] = None,
    report_expired: Optional[Callable[[], None]] = None,
    get_ban_skip: Optional[Callable[[str, dict], bool]] = None,
    report_ban_error: Optional[Callable[[str, int, int | None], None]] = None,
    report_alert: Optional[Callable[[str, str], None]] = None,
    report_log: Optional[Callable[..., None]] = None,
    report_dm_alert: Optional[Callable[..., None]] = None,
    report_audit_log: Optional[Callable[..., None]] = None,
    report_heartbeat: Optional[Callable[[], None]] = None,
    report_user_log: Optional[Callable[[str], None]] = None,
    report_post_attempt: Optional[Callable[[str, int, int | None, bool, str], None]] = None,
    report_scheduler_health: Optional[Callable[[str, float, float], None]] = None,
    report_session_paused: Optional[Callable[[str, float, int], None]] = None,
    report_permanent_exclusion: Optional[Callable[[str, str, str], None]] = None,
) -> None:
    """One session: pre-warm connect at start; stay connected between cycles; only reconnect when dropped or after FloodWait.
    Session remains connected so first and subsequent cycles avoid connect latency. Disconnect only on FloodWait pause or worker exit.
    When get_config and report_* callbacks are provided (worker process), config and persistence go through them instead of storage."""
    is_worker = get_config is not None
    path = config.resolve_session_path(session_file)
    if not path.is_file():
        logger.warning("Session file missing: %s", session_file)
        return
    session_key = path.resolve().as_posix()
    _active_posting_sessions.add(session_key)
    try:
        client = session_guard.guarded_client(
            path,
            task="posting (AdBot is running)",
            wait_timeout=20.0,  # must stay below SESSION_CONNECT_TIMEOUT_SEC; reconnect attempts add more patience
            expected_sec=None,  # posting runs until the bot is stopped
            receive_updates=True,  # required for DM auto-reply handler to receive NewMessage events
            catch_up=False,
            # Hand ALL FloodWait/SlowMode to our own handler instead of letting Telethon
            # silently asyncio.sleep() them inside send_message. The default (60) makes a
            # single group's short slowmode freeze the whole account for up to a minute with
            # no log, and bypasses the per-group group_cooldowns skip logic below. With 0,
            # every flood raises immediately -> we cool down just that group, skip it, and keep
            # posting to the rest (no account-wide pause, no lost posts, floods now logged).
            flood_sleep_threshold=0,
        )
        # Starter: even-spread phase = ordinal * (cycle/N) so accounts post at different times (persisted
        # every cycle by the anchor phase). Enterprise: first half at 0, second half after 5 min.
        if stagger_sec > 0:
            if report_user_log:
                _stagger_cfg = get_config() if get_config else {}
                report_user_log(
                    f"[Stagger] session={session_file} waiting {int(stagger_sec)}s before first cycle "
                    f"(mode={get_plan_mode(_stagger_cfg)}: staggered start after {int(stagger_sec)}s)"
                )
            logger.info("[Stagger] session=%s waiting %.0fs before first cycle", session_file, stagger_sec)
            # Chunked, stop-aware wait: the phase can be a large fraction of the cycle, so a single sleep
            # would make Stop unresponsive and starve heartbeats. Poll stop_event and beat while waiting.
            _stagger_deadline = time.time() + stagger_sec
            while time.time() < _stagger_deadline:
                if stop_event and stop_event.is_set():
                    break
                if report_heartbeat:
                    report_heartbeat()
                await asyncio.sleep(min(SCHEDULER_POLL_INTERVAL_SEC, max(0.5, _stagger_deadline - time.time())))
            if stop_event and stop_event.is_set():
                logger.info("Session %s stopping (stop during stagger)", session_file)
                return
        # Cache resolved entities per session across cycles to reduce resolve_peer calls
        entity_cache: dict[str, Any] = {}
        joined_log_group = False
        # In-memory anti-spam: user_id -> last_reply_timestamp (persists across cycles for this session)
        dm_replied_users: dict[int, float] = {}
        # DMs received before this instant (worker start) are catch-up/stale from a previous
        # run — never auto-reply to or record them, so restarting a stopped AdBot can't flood
        # old senders. Only messages that arrive while the bot is actively running count.
        dm_watch_since = time.time()
        # Resolved once per worker: this posting account's own identity (name/@username/user_id),
        # used for the "Account:" line, the session→profile deep link, and the inbox record.
        dm_account: dict = {"username": "", "name": "", "user_id": 0, "resolved": False}
        # Enterprise/stagger: one-time random startup offset before first posting cycle (avoids all workers posting in sync)
        first_cycle = True
        run_first_cycle_done = False  # One-shot: run first cycle immediately when run_first_cycle_immediately is True
        resume_first_pass = True  # One-shot: on the first scheduler decision after (re)start, apply the resume guard
        pending_groups: list[dict] = []  # Rollover: groups not finished within cycle window (processed next cycle)
        group_cooldowns: dict[int, float] = {}  # Per-session FloodWait group cooldown: chat_id → unblock_timestamp
        permanently_excluded_groups: set[str] = set()  # Enterprise: group keys with permanent errors (do not retry every cycle)
        # Pre-warm: connect session in background so first cycle can proceed as soon as ready (no blocking on connect)
        session_ready = asyncio.Event()

        async def _prewarm_connect() -> None:
            if report_user_log:
                report_user_log(f"[Connect] session={session_file} prewarm_start")
            if await _connect_session_for_cycle(
                client, session_file, bot_token,
                report_heartbeat=report_heartbeat,
                report_user_log=report_user_log,
                report_session_died=report_session_died,
            ) == "ok":
                session_ready.set()
                if report_user_log:
                    report_user_log(f"[Connect] session={session_file} prewarm_ready")
            else:
                if report_user_log:
                    report_user_log(f"[Connect] session={session_file} prewarm_failed (will retry at first cycle)")
                logger.warning("Session %s pre-warm connect failed; will retry at first cycle", session_file)

        if is_worker:
            asyncio.create_task(_prewarm_connect())

        # DM auto-reply: attached ONCE for the life of this worker, not per posting cycle — so an
        # account keeps listening and replying whenever the AdBot itself is running, even while this
        # session is between cycles, FloodWait-paused, or has nothing assigned this cycle. Only a full
        # AdBot stop (or the session going genuinely dead) ends listening, via remove_event_handler in
        # the `finally` block below. Every non-stale DM is reported to the controller (inbox + owner
        # notification); the auto-reply itself only fires when the owner has it enabled and the 24h
        # per-sender cooldown has passed. `cfg` is read fresh via closure below — it's reassigned every
        # loop iteration, so a config toggle (or a new cycle's `cfg`) applies without restart.
        cfg: dict = {}

        async def _on_incoming_dm(event: events.NewMessage.Event) -> None:
            # Only private (1:1) DMs: skip own messages, groups, and channels
            if event.out:
                return
            if not getattr(event, "is_private", False):
                return
            if getattr(event, "is_group", False) or getattr(event, "is_channel", False):
                return
            user_id = event.sender_id
            if not user_id:
                return
            # Catch-up guard: ignore messages that arrived before this worker started
            # listening (stale updates replayed on reconnect). 5s grace for clock skew.
            try:
                ev_ts = event.date.timestamp() if getattr(event, "date", None) else time.time()
            except Exception:
                ev_ts = time.time()
            if ev_ts < dm_watch_since - 5:
                return
            # Resolve sender: display name + bare @username (kept separate for the inbox/notify).
            # Prefer event.get_sender() — it resolves from the update's own context and, unlike
            # client.get_entity(id), doesn't fail with "Could not find the input entity" right
            # after receiving a DM (which is why senders were showing as "Unknown User").
            display_name = ""
            sender_username = ""
            try:
                user = await event.get_sender()
                if user is None:
                    user = await client.get_entity(event.sender_id)
                if user:
                    first = (getattr(user, "first_name", None) or "").strip()
                    last = (getattr(user, "last_name", None) or "").strip()
                    sender_username = (getattr(user, "username", None) or "").strip()
                    display_name = (first + " " + last).strip() or (f"@{sender_username}" if sender_username else "")
            except Exception:
                pass
            if not display_name:
                display_name = f"@{sender_username}" if sender_username else f"User {user_id}"
            # Resolve this account's own name/@username/user_id once (for the "Account:" line,
            # the session→profile deep link, and the inbox record).
            if not dm_account.get("resolved"):
                try:
                    me = await client.get_me()
                    dm_account["username"] = (getattr(me, "username", None) or "").strip()
                    _af = (getattr(me, "first_name", None) or "").strip()
                    _al = (getattr(me, "last_name", None) or "").strip()
                    dm_account["name"] = (_af + " " + _al).strip()
                    dm_account["user_id"] = int(getattr(me, "id", 0) or 0)
                    dm_account["resolved"] = True
                except Exception:
                    pass
            # Message content: text and/or media type (incl. GIF / video note)
            media_type = ""
            if getattr(event, "gif", False):
                media_type = "GIF"
            elif event.photo:
                media_type = "Photo"
            elif getattr(event, "video_note", False):
                media_type = "Video Note"
            elif event.video:
                media_type = "Video"
            elif event.voice:
                media_type = "Voice Message"
            elif event.sticker:
                media_type = "Sticker"
            elif event.document:
                media_type = "Document"
            elif getattr(event, "media", None):
                media_type = "Media"
            raw = (getattr(event, "raw_text", None) or "").strip()
            # For media, raw text is the caption; for plain text it's the message body.
            message_text = "" if media_type else raw[:500]
            caption = raw[:500] if media_type else ""
            now = time.time()
            # Decide the auto-reply outcome first, so the record carries an accurate status.
            #   disabled — owner turned auto-reply off
            #   pending  — a reply was already sent to this sender within the 24h cooldown
            #   sent     — reply delivered now
            #   failed   — reply attempt raised
            ar = get_autoreply_config(cfg.get("name") or bot_name)
            reply_text = ""
            if not ar.get("enabled", True):
                reply_status = "disabled"
            elif (now - dm_replied_users.get(user_id, 0)) < DM_AUTOREPLY_COOLDOWN_SEC:
                reply_status = "pending"
            else:
                reply_text = compose_autoreply(ar.get("message", ""))
                try:
                    await event.respond(reply_text)
                    dm_replied_users[user_id] = now
                    reply_status = "sent"
                    logger.info("Auto-DM reply sent from %s to user %s", session_file, user_id)
                except Exception as e:
                    reply_status = "failed"
                    logger.warning("Auto-DM reply failed %s to user %s: %s", session_file, user_id, e)
            # Report EVERY non-stale DM (controller stores it + debounces owner notify),
            # independent of the auto-reply cooldown, with the reply outcome.
            if report_dm_alert:
                try:
                    report_dm_alert(
                        session_file, display_name, user_id, message_text,
                        account_username=dm_account.get("username", ""),
                        account_name=dm_account.get("name", ""),
                        account_user_id=dm_account.get("user_id", 0),
                        sender_username=sender_username,
                        media_type=media_type,
                        caption=caption,
                        reply_status=reply_status,
                        reply_text=reply_text,
                    )
                except Exception as e:
                    logger.warning("report_dm_alert failed %s: %s", session_file, e)

        client.add_event_handler(_on_incoming_dm, events.NewMessage(incoming=True))
        while True:
            _worker_last_activity.setdefault(bot_token, {})[session_file] = time.time()
            if stop_event and stop_event.is_set():
                logger.info("Session %s stopping (stop_event)", session_file)
                if report_audit_log:
                    report_audit_log(session_file, "SESSION_STOPPED", reason="stop_event")
                break
            if report_heartbeat:
                report_heartbeat()
            if is_worker and get_config:
                cfg = get_config()
            else:
                data = load_adbot()
                cfg = data.get("bots", {}).get(bot_token)
            if not cfg:
                logger.info("Session %s stopping (no config)", session_file)
                if report_audit_log:
                    report_audit_log(session_file, "SESSION_STOPPED", reason="no_config")
                break
            if not is_worker and cfg.get("state") not in ("running", "activating"):
                logger.info("Session %s stopping (state != running/activating)", session_file)
                if report_audit_log:
                    report_audit_log(session_file, "SESSION_STOPPED", reason="state_not_running")
                break
            vt = cfg.get("valid_till", "")
            if vt:
                try:
                    end = datetime.strptime(vt, "%d/%m/%Y")
                    if datetime.now() > end:
                        if report_expired:
                            report_expired()
                        else:
                            _mark_bot_expired(bot_token, from_worker=True)
                        break
                except ValueError:
                    pass
            # Cooldown: if session error rate was high, skip cycles until cooldown_until (persisted; restart does not reactivate).
            cooldown_until = (cfg.get("session_cooldown_until") or {}).get(session_file) or 0
            if cooldown_until and time.time() < cooldown_until:
                wait_sec = cooldown_until - time.time()
                if report_user_log:
                    report_user_log(f"[Scheduler] session={session_file} in cooldown, skipping cycle for {wait_sec:.0f}s")
                else:
                    logger.info("Session %s in cooldown, skipping cycle for %.0fs", session_file, wait_sec)
                while time.time() < cooldown_until:
                    if stop_event and stop_event.is_set():
                        break
                    if report_heartbeat:
                        report_heartbeat()
                    remaining = cooldown_until - time.time()
                    chunk = min(SCHEDULER_POLL_INTERVAL_SEC, max(0.5, remaining))
                    if chunk > 0:
                        await asyncio.sleep(chunk)
                continue
            # Anti-ban: enforce min 4–6 s gap even if user sets gap=1; randomize ±20% to avoid patterns
            user_gap = max(0, int(cfg.get("gap", 5)))
            gap = max(MIN_GAP_SEC, min(MAX_GAP_SEC, user_gap))
            jitter = 1.0 + (random.random() * 2 - 1) * GAP_JITTER
            gap = max(MIN_GAP_SEC, gap * jitter)
            cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
            # Deterministic zero-drift: cycle boundaries from anchor only. Never use cycle finished time.
            # Use CURRENT boundary (cycle_index) not next (cycle_index+1): after sleeping until next_scheduled
            # we wake AT that boundary; if we targeted "next" we would sleep one more cycle and skip it (2x interval).
            now_ts = time.time()
            cycle_anchor = float(cfg.get("cycle_anchor_ts") or now_ts)
            # Starter: apply this session's persistent phase offset (ordinal * cycle/N) to the anchor so
            # accounts stay evenly spaced EVERY cycle, not just the first (fixes stagger-collapse). Enterprise
            # shards groups across sessions instead, so it uses the bare anchor (no phase).
            _sched_mode = get_plan_mode(cfg)
            session_phase = 0.0 if _sched_mode == "Enterprise" else _starter_phase_offset(session_ordinal, total_workers, cycle_sec)
            anchor_phased = cycle_anchor + session_phase
            cycle_index = int((now_ts - anchor_phased) // cycle_sec) if cycle_sec > 0 else 0
            if cycle_index < 0:
                cycle_index = 0
            current_boundary = anchor_phased + cycle_index * cycle_sec
            next_cycle_time = current_boundary  # run at this phased boundary (wait until it, or run now if past)
            delta_sec = next_cycle_time - now_ts
            delay_sec = now_ts - next_cycle_time if now_ts > next_cycle_time else 0.0
            # Resume guard (first scheduler pass after a (re)start): if the cycle at this boundary already
            # COMPLETED before the restart (persisted last_cycle_time == this boundary), do not re-run it —
            # advance to the next boundary. This covers a crash during the idle wait between cycles, so a
            # finished cycle is never re-posted. A mid-cycle crash has last_cycle_time < boundary, so it is
            # not skipped (it resumes via the seeded posted set below). Only affects restart: in steady state
            # the end-of-cycle sleep advances 'now' past the boundary before the loop re-enters here.
            if resume_first_pass:
                resume_first_pass = False
                _last_done = float((cfg.get("last_cycle_time") or {}).get(session_file) or 0)
                # Preserve an INTERRUPTED cycle: if a mid-cycle checkpoint exists for exactly this
                # boundary, run it now (the seeded posted set below skips already-sent groups) so a
                # crash mid-posting finishes where it left off.
                _prog0 = (cfg.get("cycle_progress") or {}).get(session_file) if isinstance(cfg, dict) else None
                _has_midcycle = bool(_prog0) and int(float((_prog0 or {}).get("cycle_ts") or 0)) == int(current_boundary)
                # Otherwise, if this boundary is in the PAST — already completed, or missed while the bot
                # was down — advance to the next phased boundary so each account resumes at its OWN
                # staggered slot instead of catching up on top of another account (same-group, same-time
                # collisions after a restart). Chosen behavior: wait for the proper slot, never fire an
                # overdue cycle immediately.
                if cycle_sec > 0 and not _has_midcycle and current_boundary <= now_ts + 1.0:
                    _skipped_from = current_boundary
                    while current_boundary <= now_ts:
                        current_boundary += cycle_sec
                    next_cycle_time = current_boundary
                    delta_sec = next_cycle_time - now_ts
                    delay_sec = 0.0
                    logger.info(
                        "[Resume] session=%s past boundary %.0f skipped (last_done=%.0f); waiting for next staggered slot %.0f",
                        session_file, _skipped_from, _last_done, current_boundary,
                    )
            # Instant first cycle: run immediately on start instead of waiting for cycle boundary
            if cfg.get("run_first_cycle_immediately") and not run_first_cycle_done:
                next_cycle_time = now_ts
                delta_sec = 0.0
                delay_sec = 0.0
                run_first_cycle_done = True
                logger.info("[CycleAnchor] first cycle immediately session=%s", session_file)
            else:
                logger.info("[CycleAnchor] anchor=%.0f", cycle_anchor)
            if report_scheduler_health:
                report_scheduler_health(session_file, next_cycle_time, delay_sec)
            _sched_msg = f"[Scheduler] session={session_file} next_run={next_cycle_time:.0f} now={now_ts:.0f} delta={delta_sec:.0f}s"
            if report_user_log:
                report_user_log(_sched_msg)
            else:
                logger.info("%s", _sched_msg)
            scheduled_time = next_cycle_time
            if delta_sec > 0:
                # Not due yet: sleep in short chunks so we re-evaluate often and respect stop_event.
                if report_user_log:
                    report_user_log(f"[Scheduler] skipping session={session_file} (not due)")
                else:
                    logger.info("[Scheduler] skipping session=%s (not due)", session_file)
                if report_audit_log:
                    report_audit_log(session_file, "SESSION_DELAYED", seconds=round(min(delta_sec, SCHEDULER_POLL_INTERVAL_SEC)))
                while delta_sec > 0:
                    if stop_event and stop_event.is_set():
                        if report_audit_log:
                            report_audit_log(session_file, "SESSION_STOPPED", reason="stop_event_after_delay")
                        break
                    chunk = min(SCHEDULER_POLL_INTERVAL_SEC, delta_sec)
                    await asyncio.sleep(chunk)
                    now_ts = time.time()
                    delta_sec = scheduled_time - now_ts
                if stop_event and stop_event.is_set():
                    logger.info("Session %s stopping (stop_event after delay)", session_file)
                    break
            # Run exactly one cycle at deterministic boundary (no per-session offset; zero drift).
            scheduled_run_ts = scheduled_time
            started_cycle_index = int(round((scheduled_run_ts - cycle_anchor) / cycle_sec)) if cycle_sec > 0 else 0
            logger.info("[CycleStart] session=%s cycle_index=%s", session_file, started_cycle_index)
            if report_user_log:
                report_user_log(f"[Scheduler] triggering cycle for session={session_file}")
            else:
                logger.info("[Scheduler] triggering cycle for session=%s", session_file)
            if report_audit_log:
                report_audit_log(session_file, "SESSION_CYCLE_START")
            # Clear any temporary group exclusions/error counters at the start of a new cycle so they never
            # leak across cycles. Persistent exclusions are controlled separately via ban/prune logic.
            # Use per-session key so only this session's temp exclusions are cleared (not other sessions').
            _temp_excluded_groups.pop((bot_token, session_file), None)
            _temp_exclusion_error_count.pop(bot_token, None)
            _session_floodwait_counts[(bot_token, session_file)] = 0
            # Ensure connected: use pre-warmed connection, or wait for pre-warm (with timeout), or reconnect if dropped
            _is_conn = getattr(client, "is_connected", None)
            is_connected = (_is_conn() if callable(_is_conn) else _is_conn) if _is_conn is not None else False
            if not is_connected and is_worker:
                try:
                    await asyncio.wait_for(session_ready.wait(), timeout=SESSION_CONNECT_TIMEOUT_SEC + 5)
                except asyncio.TimeoutError:
                    pass
                _is_conn = getattr(client, "is_connected", None)
                is_connected = (_is_conn() if callable(_is_conn) else _is_conn) if _is_conn is not None else False
            if not is_connected:
                _conn_status = await _connect_session_for_cycle(
                    client, session_file, bot_token,
                    report_heartbeat=report_heartbeat,
                    report_user_log=report_user_log,
                    report_session_died=report_session_died,
                )
                if _conn_status == "unauth":
                    # Session is logged out / de-authorized (dead). It has already been
                    # flagged for replacement + removed by the controller; stop this worker
                    # cleanly instead of looping on a dead account forever.
                    logger.info("Session %s stopping (unauthorized/de-authorized)", session_file)
                    if report_audit_log:
                        report_audit_log(session_file, "SESSION_STOPPED", reason="unauthorized")
                    return
                if _conn_status != "ok":
                    bot_name = cfg.get("name") or bot_token[:20]
                    if _conn_status == "busy":
                        # Not a Telegram/network problem — another task (or an orphaned
                        # lock) holds this session file. Name it so it's fixable, not
                        # mistaken for a dead account.
                        msg = (f"AdBot {bot_name} — session {session_file} is locked by another task and "
                               f"could not be used this cycle. If this repeats, the bot may need a restart "
                               f"to clear a stale lock. Will retry next cycle.")
                        alert_kind = "session_busy"
                    else:
                        msg = f"AdBot {bot_name} — session {session_file} failed to connect. Will retry next cycle."
                        alert_kind = "session_disconnected"
                    if report_alert:
                        report_alert(alert_kind, msg)
                    else:
                        add_admin_alert(alert_kind, msg)
                    logger.warning("Session %s %s for bot %s; retrying next cycle.",
                                   session_file, "is locked (busy)" if _conn_status == "busy" else "failed to connect", bot_name)
                    # Do not break — sleep briefly then retry from top of loop on next cycle
                    retry_sleep = 15
                    slept = 0
                    while slept < retry_sleep:
                        if stop_event and stop_event.is_set():
                            break
                        if report_heartbeat:
                            report_heartbeat()
                        chunk = min(5, retry_sleep - slept)
                        await asyncio.sleep(chunk)
                        slept += chunk
                    continue
            assigned, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers)
            mode = get_plan_mode(cfg)

            # --- DETERMINISTIC ENTERPRISE SCHEDULING ---
            # Enterprise: each session processes ONLY its shard. No rollover, no backlog.
            # Per-group posting interval = cycle_sec: every group in the shard is attempted once per cycle
            # at the fixed boundary (next_cycle_time = last_cycle_time + cycle_sec). Groups not posted
            # (e.g. skipped due to FloodWait) are retried next cycle; cycle timing is unchanged.
            if mode == "Enterprise":
                shard_size = len(assigned)
                groups = list(assigned)
                pending_groups.clear()  # Enterprise: no rollover; never carry backlog into next cycle.
                # Filter out permanently excluded groups (in-memory + config) so we stop retrying dead chats.
                excluded_keys = set(permanently_excluded_groups) | set(cfg.get("excluded_groups") or [])
                groups_before_filter = len(groups)
                groups = [g for g in groups if _target_key_for_skip(g) not in excluded_keys]
                skipped_permanently_excluded = groups_before_filter - len(groups)
                if report_user_log:
                    report_user_log(
                        f"[ShardCheck] total_groups={total_groups} session={session_file} shard_size={shard_size} "
                        f"groups_this_cycle={len(groups)} (strict shard only, no pending)"
                        + (f" skipped_permanently_excluded={skipped_permanently_excluded}" if skipped_permanently_excluded else "")
                    )
                logger.info(
                    "[ShardCheck] total_groups=%s session=%s shard_size=%s groups_this_cycle=%s (Enterprise deterministic)%s",
                    total_groups, session_file, shard_size, len(groups),
                    f" skipped_permanently_excluded={skipped_permanently_excluded}" if skipped_permanently_excluded else "",
                )
            else:
                # Starter: allow pending rollover and cap to prevent snowball (legacy behaviour).
                _combined = pending_groups + list(assigned)
                _max_groups = max(len(assigned), total_groups, 1)
                if len(_combined) > _max_groups:
                    logger.warning(
                        "[PendingCap] session=%s truncating %s -> %s groups (assigned=%s pending=%s total_groups=%s)",
                        session_file, len(_combined), _max_groups, len(assigned), len(pending_groups), total_groups,
                    )
                    _combined = _combined[:_max_groups]
                groups = _combined
                pending_groups.clear()
                if report_user_log:
                    report_user_log(f"[ShardCheck] total_groups={total_groups} session={session_file} assigned={len(groups)} duplicates_detected=False")
                else:
                    logger.info("[ShardCheck] total_groups=%s session=%s assigned=%s duplicates_detected=False", total_groups, session_file, len(groups))

            _verify_assignment_report(mode, total_workers, total_groups, session_ordinal, len(groups), report_user_log)
            posts_success_cycle = 0
            posts_attempted_cycle = 0
            posts_skipped_cycle = 0
            posts_skipped_cooldown = 0
            posts_skipped_floodwait = 0
            _floodwait_session_paused = False  # Bug 2: set when account-level flood pauses this session mid-cycle
            cycle_failures_permanent = 0
            cycle_failures_transient = 0
            skipped_permanently_excluded = 0  # set in Enterprise branch above; 0 for Starter
            # Enterprise: partition is already applied in _assigned_groups_for_session (each session gets its slice).
            if len(groups) == 0:
                logger.warning(
                    "Session %s has ZERO groups this cycle (group_file=%s mode=%s); will connect and sleep without posting",
                    session_file, cfg.get("group_file"), mode,
                )
                # File log only; do not send to Telegram log group (no debug noise).
                if report_user_log:
                    report_user_log(f"{session_file} - cycle completed (no groups assigned)")
                logger.info("Session %s cycle completed (no groups assigned)", session_file)
            else:
                if report_user_log:
                    report_user_log(f"{session_file} {len(groups)} groups")
                logger.info("SESSION_READY session=%s groups=%s", session_file, len(groups))
                if report_audit_log:
                    report_audit_log(session_file, "SESSION_READY", groups=len(groups))
                logger.info("SESSION_READY session=%s groups=%s", session_file, len(groups))
            log_group = _log_group_entity(cfg.get("log_group"))
            # Session joins log group if not already in
            if log_group and not joined_log_group:
                try:
                    await join_chat_by_link(client, log_group)
                    joined_log_group = True
                except Exception:
                    pass
            msg_text = cfg.get("message_text", "Hello")
            post_links = cfg.get("post_links") or _get_post_links_list(cfg)
            # Cycle-based eligibility: each group is eligible once per cycle (no per-group wall-clock cooldown).
            current_cycle_id = int(scheduled_run_ts)
            posted_this_cycle: set[str] = set()
            # Resume: seed groups already posted in THIS exact cycle (persisted checkpoint) so a mid-cycle
            # restart continues where it left off — the group loop below skips keys in posted_this_cycle.
            # Fail-open: any mismatch (different cycle boundary, missing data) → empty set → fresh cycle.
            try:
                _prog = (cfg.get("cycle_progress") or {}).get(session_file) if isinstance(cfg, dict) else None
                if _prog and int(float(_prog.get("cycle_ts") or 0)) == int(scheduled_run_ts):
                    for _k in (_prog.get("posted") or []):
                        if _k:
                            posted_this_cycle.add(str(_k))
                    if posted_this_cycle:
                        _resume_msg = (
                            f"[Resume] session={session_file} continuing cycle {current_cycle_id}: "
                            f"skipping {len(posted_this_cycle)} already-posted group(s) from before restart"
                        )
                        logger.info(_resume_msg)
                        if report_user_log:
                            report_user_log(_resume_msg)
            except Exception as _seed_err:
                logger.debug("cycle_progress seed skipped session=%s: %s", session_file, _seed_err)
            _last_progress_report_ts = 0.0  # throttle for mid-cycle progress checkpoints
            logger.info("[CycleScheduler] session=%s cycle_id=%s groups_ready=%s", session_file, current_cycle_id, len(groups))
            if report_user_log:
                report_user_log(f"[CycleScheduler] session={session_file} cycle_id={current_cycle_id} groups_ready={len(groups)}")
            # FloodWait adaptive pacing: decay effective gap each cycle so system doesn't stay slow after FloodWait.
            _gap_key = (bot_token, session_file)
            effective_gap_cycle = max(MIN_GAP_SEC, _effective_gap_sec.get(_gap_key, gap) - 1)
            _effective_gap_sec[_gap_key] = effective_gap_cycle
            # Cycle window: [cycle_start_ts, cycle_end_ts). Next cycle is always at last_cycle_time + cycle_sec (deterministic).
            cycle_start_ts = scheduled_run_ts
            cycle_end_ts = scheduled_run_ts + cycle_sec
            expected_next_run_ts = cycle_end_ts  # next_cycle_time = last_cycle_time + cycle_sec
            logger.info(
                "[CycleWindow] session=%s cycle_start_ts=%.0f cycle_end_ts=%.0f expected_next_run_ts=%.0f",
                session_file, cycle_start_ts, cycle_end_ts, expected_next_run_ts,
            )
            logger.info(
                "[CycleAssignment] session=%s assigned_groups=%s total_groups=%s cycle_sec=%s (must finish within cycle or stop early)",
                session_file, len(groups), total_groups, cycle_sec,
            )
            if report_user_log:
                report_user_log(
                    f"[CycleWindow] session={session_file} cycle_start_ts={cycle_start_ts:.0f} "
                    f"cycle_end_ts={cycle_end_ts:.0f} expected_next_run_ts={expected_next_run_ts:.0f}"
                )
                report_user_log(
                    f"[CycleAssignment] session={session_file} assigned={len(groups)} groups (of {total_groups} total), cycle={cycle_sec}s — post to all within this window or stop early."
                )
            # Inter-post spacing: one sleep per post (final_wait = max(global, session_gap, retry)); no stacked sleeps. (final_wait = max(global, session_gap, retry)); no stacked sleeps.
            cycle_start = time.time()
            for idx, g in enumerate(groups):
                if time.time() >= cycle_end_ts:
                    # Enterprise: no rollover. Stop this cycle; same shard will be attempted next cycle at fixed boundary.
                    # FloodWait/skips do not extend the cycle or create backlog; per-group interval stays cycle_sec.
                    if mode == "Enterprise":
                        # idx = number of groups we posted to this cycle before window ran out
                        logger.info(
                            "[CycleWindow] session=%s window_expired (Enterprise: no rollover), posted=%s assigned=%s cycle_sec=%s",
                            session_file, idx, len(groups), cycle_sec,
                        )
                        if report_user_log:
                            report_user_log(
                                f"[CycleWindow] Posting stopped early: cycle time ran out ({cycle_sec}s). "
                                f"Posted to {idx} of {len(groups)} assigned groups. Next cycle retries full shard."
                            )
                    else:
                        remaining = groups[idx:]
                        pending_groups.extend(remaining)
                        logger.info(
                            "[CycleWindow] session=%s window_expired, remaining_groups=%s",
                            session_file, len(remaining),
                        )
                        logger.info("[CycleWindow] rollover_groups=%s", len(remaining))
                    break
                if stop_event and stop_event.is_set():
                    break
                if not is_worker:
                    data = load_adbot()
                    if data.get("bots", {}).get(bot_token, {}).get("state") != "running":
                        break
                group_key = _target_key_for_skip(g)
                if group_key in posted_this_cycle:
                    logger.info("[CycleScheduler] group_skipped_reason=already_posted_this_cycle session=%s group_key=%s", session_file, group_key)
                    if report_user_log:
                        report_user_log(f"[CycleScheduler] group_skipped_reason=already_posted_this_cycle")
                    continue
                _g_chat_id = g.get("chat_id")
                # Bug 3: this account was previously banned from sending to this group (24h TTL) — skip it
                # instead of re-hitting a group that already rejected us every cycle. Prefer the worker's
                # per-session ban snapshot (get_ban_skip); fall back to global storage in single-process mode.
                _ban_skip = get_ban_skip(session_file, g) if get_ban_skip else _should_skip_target_for_ban(bot_token, session_file, g)
                if _ban_skip:
                    logger.info("[BanSkip] session=%s group_key=%s skipped (prior send ban, within TTL)", session_file, group_key)
                    posts_skipped_cycle += 1
                    continue
                # Bug 7: respect a group's learned rate limit / slow mode. A prior FloodWait recorded the
                # exact interval the group demands; don't post again until it elapses — the group naturally
                # slots into a later cycle (post once, learn the interval, resume after it completes).
                _gc_until = group_cooldowns.get(_g_chat_id, 0) if _g_chat_id is not None else 0
                _now_cd = time.time()
                if _gc_until and _now_cd < _gc_until:
                    logger.info(
                        "[GroupCooldown] session=%s chat_id=%s wait_remaining=%.0fs — group rate-limited, skip this cycle",
                        session_file, _g_chat_id, _gc_until - _now_cd,
                    )
                    posts_skipped_cycle += 1
                    posts_skipped_cooldown += 1
                    continue
                # No group cooldown, no ban skip — attempt every group every cycle
                now = time.time()
                scheduled_for = cycle_start + idx * effective_gap_cycle
                session_gap_wait = max(0.0, scheduled_for - now) if now <= scheduled_for + MAX_DRIFT_SEC else 0.0
                final_wait = min(session_gap_wait, MAX_ALLOWED_DELAY_SEC)
                if final_wait > 0:
                    await asyncio.sleep(final_wait)
                _log_posting_scheduler(session_file, max(0.0, (scheduled_run_ts + cycle_sec) - time.time()), 0.0, 0.0, "posting", report_user_log)
                _worker_last_activity.setdefault(bot_token, {})[session_file] = time.time()
                chat_id = g["chat_id"]
                topic_id = g.get("topic_id")
                cache_key = (chat_id, topic_id or 0)
                handler = AdBotErrorHandler(
                    session_id=session_file,
                    group_id=chat_id,
                    action_name="post",
                )
                while True:
                    try:
                        if cache_key in entity_cache:
                            entity = entity_cache[cache_key]
                        else:
                            entity = await with_retry(
                                lambda cid=chat_id: client.get_entity(cid),
                                handler=AdBotErrorHandler(session_id=session_file, group_id=chat_id, action_name="get_entity"),
                            )
                            if entity is None:
                                logger.warning("[Post] session=%s chat_id=%s entity not found, skipping group", session_file, chat_id)
                                break
                            entity_cache[cache_key] = entity
                        group_title = getattr(entity, "title", None) or getattr(entity, "username", None) or str(chat_id)
                        # Use message_mode: "link" = forward (random link if multiple), "text" = send custom text.
                        use_link_mode = _get_message_mode(cfg) == "link"
                        if use_link_mode and post_links:
                            post_link = random.choice(post_links)
                            parsed = _parse_post_link(post_link) if post_link else None
                        else:
                            post_link = ""
                            parsed = None
                        reply_to = topic_id if topic_id is not None else None
                        posts_attempted_cycle += 1
                        if parsed:
                            from_peer, orig_msg_id = parsed
                            if topic_id is not None:
                                # Forum topic: high-level forward_messages() doesn't accept top_msg_id; use raw request
                                result = await with_retry(
                                    lambda: _forward_messages_to_topic(client, entity, orig_msg_id, from_peer, topic_id),
                                    handler=handler,
                                )
                            else:
                                result = await with_retry(
                                    lambda: client.forward_messages(entity, orig_msg_id, from_peer),
                                    handler=handler,
                                )
                        else:
                            send_kw = {"reply_to": reply_to} if reply_to is not None else {}
                            result = await with_retry(
                                lambda: client.send_message(entity, msg_text, **send_kw),
                                handler=handler,
                            )
                        if result is None:
                            reason = (str(getattr(handler, "last_error", None) or "") or "skip or ignore").strip()
                            _log_post_result(
                                bot_token,
                                False,
                                session_ordinal + 1,
                                session_file,
                                report_log=report_log,
                                report_post_attempt=report_post_attempt,
                                chat_id=chat_id,
                                topic_id=topic_id,
                                reason=reason,
                                group_title=group_title,
                            )
                            break
                        msg = result[0] if isinstance(result, list) else result
                        msg_id = getattr(msg, "id", None) or 0
                        msg_link = _message_link(entity, msg_id, topic_id) if msg_id else ""
                        _log_post_result(
                            bot_token,
                            True,
                            session_ordinal + 1,
                            session_file,
                            report_log=report_log,
                            report_post_attempt=report_post_attempt,
                            group_title=group_title,
                            link=msg_link or "(no link)",
                            chat_id=chat_id,
                            topic_id=topic_id,
                        )
                        if report_audit_log:
                            report_audit_log(session_file, "SESSION_POST_SUCCESS", group_id=chat_id)
                        posted_this_cycle.add(group_key)
                        posts_success_cycle += 1
                        # Checkpoint mid-cycle progress (throttled) so a crash can resume this cycle.
                        if report_cycle_progress:
                            _now_prog = time.time()
                            if _now_prog - _last_progress_report_ts >= CYCLE_PROGRESS_REPORT_INTERVAL_SEC:
                                _last_progress_report_ts = _now_prog
                                try:
                                    report_cycle_progress(session_file, scheduled_run_ts, list(posted_this_cycle))
                                except Exception:
                                    pass
                        break
                    except (FloodWaitGroupSkip, FloodWaitPause) as e:
                        _fw_seconds = int(getattr(e, "seconds", 0) or 0)
                        # Bug 7: remember this group's required interval so future cycles skip it until it elapses.
                        if chat_id is not None and _fw_seconds > 0:
                            group_cooldowns[chat_id] = time.time() + _fw_seconds
                        logger.info("[FloodWait] session=%s chat_id=%s wait=%ss — skipping group, continuing", session_file, chat_id, _fw_seconds)
                        if report_user_log:
                            report_user_log(f"[FloodWait] chat_id={chat_id} wait={_fw_seconds}s — skipping group, session continues")
                        posts_skipped_cycle += 1
                        posts_skipped_floodwait += 1
                        if report_post_attempt:
                            report_post_attempt(session_file, chat_id, topic_id, False, f"floodwait_{_fw_seconds}s", group_name=getattr(entity, "title", str(chat_id)) if "entity" in dir() else str(chat_id))
                        # Only a GENUINE account-level flood (a single very long wait, surfaced as
                        # FloodWaitPause when seconds > FLOODWAIT_THRESHOLD_SEC) pauses the whole session.
                        # Normal per-group rate limits / slow modes are handled by group_cooldowns above:
                        # skip just that group and keep posting to the others. Counting per-group floods and
                        # pausing the account was wrong — when several groups each have their own (e.g. 1h)
                        # limit shorter than the cycle, it benched the whole account and produced empty cycles.
                        _fw_key = (bot_token, session_file)
                        _session_floodwait_counts[_fw_key] = _session_floodwait_counts.get(_fw_key, 0) + 1
                        if isinstance(e, FloodWaitPause):
                            _pause_secs = max(_fw_seconds, SESSION_COOLDOWN_SEC)
                            _unblock = time.time() + _pause_secs
                            logger.warning(
                                "[FloodWait] session=%s account-level throttling (floods_this_cycle=%s, wait=%ss) — pausing session %ss",
                                session_file, _session_floodwait_counts[_fw_key], _fw_seconds, _pause_secs,
                            )
                            if report_user_log:
                                report_user_log(f"[FloodWait] session={session_file} paused {int(_pause_secs)}s (account-level flood, stops hammering)")
                            if report_session_paused:
                                report_session_paused(session_file, _unblock, int(_pause_secs))
                            else:
                                def _upd_pause(c, _sf=session_file, _ub=_unblock):
                                    c.setdefault("session_pause_until", {})[_sf] = _ub
                                _save_bot_config(bot_token, _upd_pause)
                            _floodwait_session_paused = True
                        break
                    except Exception as e:
                        action, _ = handler.handle(e)
                        if action == AdBotAction.MARK_SESSION_BANNED:
                            _log_post_result(
                                bot_token,
                                False,
                                session_ordinal + 1,
                                session_file,
                                report_log=report_log,
                                report_post_attempt=report_post_attempt,
                                chat_id=chat_id,
                                topic_id=topic_id,
                                reason=str(e),
                                group_title=group_title,
                            )
                            if report_session_died:
                                report_session_died(session_file, str(e))
                            else:
                                _mark_session_dead_and_replace(bot_token, session_file, str(e))
                            logger.info("Session %s stopping (session banned)", session_file)
                            if report_audit_log:
                                report_audit_log(session_file, "SESSION_STOPPED", reason="banned")
                            return
                        _log_post_result(
                            bot_token,
                            False,
                            session_ordinal + 1,
                            session_file,
                            report_log=report_log,
                            report_post_attempt=report_post_attempt,
                            chat_id=chat_id,
                            topic_id=topic_id,
                            reason=str(e),
                            group_title=group_title,
                        )
                        err_lower = str(e).lower()
                        if (_USER_BANNED_IN_CHANNEL and type(e) == _USER_BANNED_IN_CHANNEL) or any(
                            p in err_lower for p in _BANNED_FROM_SENDING_PATTERNS
                        ):
                            if report_ban_error:
                                report_ban_error(session_file, chat_id, topic_id)
                            else:
                                _increment_ban_error_count(bot_token, session_file, chat_id, topic_id)
                        # Bug 13: park permanently-failing groups (paid post / topic closed / no write) on a
                        # long cooldown so we stop retrying them every cycle (not permanently excluded).
                        elif chat_id is not None and any(p in err_lower for p in _PERMANENT_ERROR_PATTERNS):
                            group_cooldowns[chat_id] = time.time() + PERMANENT_ERROR_RETRY_SEC
                            logger.info(
                                "[PermanentCooldown] session=%s chat_id=%s parked %.0fh (%s)",
                                session_file, chat_id, PERMANENT_ERROR_RETRY_SEC / 3600.0, err_lower[:60],
                            )
                        # Enterprise permanent error pruning disabled per request
                        if mode == "Enterprise":
                            if is_permanent_error(e) or action == AdBotAction.SKIP_GROUP:
                                # We no longer permanently exclude groups or save them to config, 
                                # so other sessions can always attempt to post.
                                cycle_failures_permanent += 1
                                logger.info("[ExclusionDisabled] User requested NO permanent exclusion for group=%s", group_key)
                            else:
                                cycle_failures_transient += 1
                        break
                # No relative sleep here; next iteration sleeps until its scheduled_for (absolute-time)
                if _floodwait_session_paused:
                    # Account-level flood: stop this cycle immediately; session resumes after pause expires.
                    break
            # Starter only: drain deferred groups (reassignment from PAUSED sessions).
            # Enterprise deterministic: each session only processes its shard; no draining so interval = cycle_sec.
            # Skip draining if this session just paused for account-level flood (don't keep posting).
            if mode != "Enterprise" and not _floodwait_session_paused and is_session_available(bot_token, session_file, cfg):
                drain_flood_paused = False
                while True:
                    if time.time() >= cycle_end_ts:
                        break
                    batch = await _pop_deferred_groups(bot_token, max_count=1)
                    if not batch or drain_flood_paused:
                        break
                    for g in batch:
                        if time.time() >= cycle_end_ts:
                            break
                        if not is_session_available(bot_token, session_file, cfg):
                            await _push_back_deferred(bot_token, g)
                            break
                        if _should_skip_target_for_ban(bot_token, session_file, g):
                            continue
                        chat_id = g["chat_id"]
                        topic_id = g.get("topic_id")
                        cache_key = (chat_id, topic_id or 0)
                        handler_d = AdBotErrorHandler(session_id=session_file, group_id=chat_id, action_name="post")
                        posts_attempted_cycle += 1
                        try:
                            if cache_key in entity_cache:
                                entity = entity_cache[cache_key]
                            else:
                                entity = await with_retry(
                                    lambda cid=chat_id: client.get_entity(cid),
                                    handler=AdBotErrorHandler(session_id=session_file, group_id=chat_id, action_name="get_entity"),
                                )
                                if entity is None:
                                    _increment_ban_error_count(bot_token, session_file, chat_id, topic_id)
                                    continue
                                entity_cache[cache_key] = entity
                            group_title = getattr(entity, "title", None) or getattr(entity, "username", None) or str(chat_id)
                            post_links_d = cfg.get("post_links") or _get_post_links_list(cfg)
                            use_link_mode_d = _get_message_mode(cfg) == "link"
                            if use_link_mode_d and post_links_d:
                                post_link_d = random.choice(post_links_d)
                                parsed = _parse_post_link(post_link_d) if post_link_d else None
                            else:
                                parsed = None
                            reply_to = topic_id if topic_id is not None else None
                            if parsed:
                                from_peer, orig_msg_id = parsed
                                if topic_id is not None:
                                    result = await with_retry(
                                        lambda: _forward_messages_to_topic(client, entity, orig_msg_id, from_peer, topic_id),
                                        handler=handler_d,
                                    )
                                else:
                                    result = await with_retry(
                                        lambda: client.forward_messages(entity, orig_msg_id, from_peer),
                                        handler=handler_d,
                                    )
                            else:
                                send_kw = {"reply_to": reply_to} if reply_to is not None else {}
                                result = await with_retry(
                                    lambda: client.send_message(entity, msg_text, **send_kw),
                                    handler=handler_d,
                                )
                            if result is None:
                                reason = (str(getattr(handler_d, "last_error", None) or "") or "skip or ignore").strip()
                                _log_post_result(bot_token, False, session_ordinal + 1, session_file, report_log=report_log, report_post_attempt=report_post_attempt, chat_id=chat_id, topic_id=topic_id, reason=reason, group_title=group_title)
                                if topic_id is not None and getattr(handler_d, "last_skip_was_topic", False):
                                    if report_ban_error:
                                        report_ban_error(session_file, chat_id, topic_id)
                                    else:
                                        _increment_ban_error_count(bot_token, session_file, chat_id, topic_id)
                                continue
                            msg = result[0] if isinstance(result, list) else result
                            msg_id = getattr(msg, "id", None) or 0
                            msg_link = _message_link(entity, msg_id, topic_id) if msg_id else ""
                            _log_post_result(bot_token, True, session_ordinal + 1, session_file, report_log=report_log, report_post_attempt=report_post_attempt, group_title=group_title, link=msg_link or "(no link)", chat_id=chat_id, topic_id=topic_id)
                            posts_success_cycle += 1
                        except (FloodWaitGroupSkip, FloodWaitPause) as e:
                            # FloodWait on deferred group — record the group's interval (Bug 7), log and skip.
                            _fw_seconds = int(getattr(e, "seconds", 0) or 0)
                            if chat_id is not None and _fw_seconds > 0:
                                group_cooldowns[chat_id] = time.time() + _fw_seconds
                            logger.info("[FloodWait] session=%s chat_id=%s wait=%ss deferred — skipping", session_file, chat_id, _fw_seconds)
                            posts_skipped_cycle += 1
                            posts_skipped_floodwait += 1
                            break
                        except Exception as e:
                            action, _ = handler_d.handle(e)
                            if action == AdBotAction.MARK_SESSION_BANNED:
                                if report_session_died:
                                    report_session_died(session_file, str(e))
                                else:
                                    _mark_session_dead_and_replace(bot_token, session_file, str(e))
                                logger.info("Session %s stopping (session banned)", session_file)
                                if report_audit_log:
                                    report_audit_log(session_file, "SESSION_STOPPED", reason="banned")
                                return
                            _log_post_result(bot_token, False, session_ordinal + 1, session_file, report_log=report_log, report_post_attempt=report_post_attempt, chat_id=chat_id, topic_id=topic_id, reason=str(e), group_title=group_title)
                            err_lower = str(e).lower()
                            if (_USER_BANNED_IN_CHANNEL and type(e) == _USER_BANNED_IN_CHANNEL) or any(p in err_lower for p in _BANNED_FROM_SENDING_PATTERNS):
                                if report_ban_error:
                                    report_ban_error(session_file, chat_id, topic_id)
                                else:
                                    _increment_ban_error_count(bot_token, session_file, chat_id, topic_id)
                        await asyncio.sleep(gap)
            _worker_last_activity.setdefault(bot_token, {})[session_file] = time.time()
            # Cycle stats: failed = attempted − success − skipped (FloodWait/cooldown are NOT failures).
            posts_failed_cycle = max(0, posts_attempted_cycle - posts_success_cycle - posts_skipped_cycle)
            # Only exclude session when it attempted zero posts (e.g. frozen, no groups assigned). Zero success with
            # attempted > 0 is NOT a reason to exclude (group bans, FloodWait, transient errors); session continues next cycle.
            if report_cycle_failed and posts_attempted_cycle == 0:
                report_cycle_failed(session_file)
            cycle_duration_sec = time.time() - cycle_start
            next_scheduled = scheduled_run_ts + cycle_sec
            skip_reason_str = ""
            if posts_skipped_cycle > 0:
                parts = []
                if posts_skipped_cooldown:
                    parts.append(f"cooldown={posts_skipped_cooldown}")
                if posts_skipped_floodwait:
                    parts.append(f"floodwait={posts_skipped_floodwait}")
                if parts:
                    skip_reason_str = " (" + ", ".join(parts) + ")"
            logger.info(
                "Cycle Summary: session=%s attempted=%s success=%s failed=%s skipped=%s%s duration_sec=%s",
                session_file, posts_attempted_cycle, posts_success_cycle, posts_failed_cycle, posts_skipped_cycle,
                skip_reason_str, round(cycle_duration_sec, 1),
            )
            logger.info(
                "[CycleStats] session=%s groups=%s sent=%s failed=%s skipped=%s%s duration_sec=%s",
                session_file, len(groups), posts_success_cycle, posts_failed_cycle, posts_skipped_cycle,
                skip_reason_str, round(cycle_duration_sec, 1),
            )
            # Deterministic scheduling log: per-group interval = cycle_sec because next run is last_cycle_time + cycle_sec.
            logger.info(
                "[CycleEnd] session=%s duration_sec=%s shard_size=%s groups_posted_this_cycle=%s "
                "cycle_start_ts=%.0f cycle_end_ts=%.0f expected_next_run_ts=%.0f",
                session_file, round(cycle_duration_sec, 1), len(groups), posts_success_cycle,
                cycle_start_ts, cycle_end_ts, next_scheduled,
            )
            if mode == "Enterprise" and report_user_log:
                report_user_log(
                    f"[CycleEnd] session={session_file} shard_size={len(groups)} groups_posted_this_cycle={posts_success_cycle} "
                    f"cycle_start_ts={cycle_start_ts:.0f} cycle_end_ts={cycle_end_ts:.0f} expected_next_run_ts={next_scheduled:.0f} "
                    f"permanent_exclusions_count={len(permanently_excluded_groups)} skipped_permanently_excluded={skipped_permanently_excluded} "
                    f"cycle_failures_permanent={cycle_failures_permanent} cycle_failures_transient={cycle_failures_transient}"
                )
            # Enterprise: if shard had attempts but zero success, log warning only; do NOT exclude session.
            if mode == "Enterprise" and posts_attempted_cycle > 0 and posts_success_cycle == 0:
                logger.warning(
                    "[ShardWarning] session=%s attempted=%s success=0 (all groups in shard failed or skipped). "
                    "skip_reasons: cooldown=%s floodwait=%s — Session continues next cycle. Consider cleaning group file if groups are permanently invalid.",
                    session_file, posts_attempted_cycle, posts_skipped_cooldown, posts_skipped_floodwait,
                )
                if report_user_log:
                    report_user_log(
                        f"[ShardWarning] All groups in shard appear invalid for session={session_file}. "
                        "Consider cleaning group file. Session will retry next cycle."
                    )
                # Notify log group so user sees this account ran but had no successful posts (e.g. all FloodWait/banned).
                account_num = session_ordinal + 1
                if report_log:
                    report_log(
                        bot_token,
                        f"Account {account_num}: 0/{posts_attempted_cycle} posted this cycle (all skipped or failed). Will retry next cycle.",
                    )
            # Persist scheduled_run_ts (not cycle_done_ts) so scheduler stays anchored and does not drift.
            if report_cycle_done:
                report_cycle_done(
                    session_file, scheduled_run_ts,
                    posts_success=posts_success_cycle, posts_failed=posts_failed_cycle, posts_skipped=posts_skipped_cycle,
                    posts_attempted=posts_attempted_cycle,
                    posts_skipped_cooldown=posts_skipped_cooldown, posts_skipped_floodwait=posts_skipped_floodwait,
                    cycle_duration_sec=cycle_duration_sec,
                )
            else:
                _persist_last_cycle_at(bot_token, session_file, scheduled_run_ts)
            if report_audit_log:
                report_audit_log(session_file, "SESSION_CYCLE_DONE", timestamp=scheduled_run_ts, success_count=posts_success_cycle)
            # Cycle count is incremented in stats file when controller processes cycle_done (no user JSON write).
            # (DM auto-reply handler stays attached across cycles now — see the comment above `while True:`.)
            # --- DETERMINISTIC TIMING: next run = last_cycle_time + cycle_sec ---
            # We sleep until next_scheduled (scheduled_run_ts + cycle_sec), NOT until loop completion.
            # So per-group interval = cycle_sec: each group is attempted every cycle at the fixed boundary.
            # FloodWait: if we skip a group or pause the session, we do NOT extend the cycle or add backlog.
            # Next cycle we get the same shard again; skipped groups are retried. Interval alignment is preserved.
            # Keep session connected between cycles; only disconnect on FloodWait or worker exit (reduces Run→first-post latency)
            next_scheduled = scheduled_run_ts + cycle_sec
            next_in_sec = max(0, int(next_scheduled - time.time()))
            next_in_min = (next_in_sec + 59) // 60
            logger.info("[NextCycle] session=%s next_cycle_ts=%.0f", session_file, next_scheduled)
            if report_user_log and next_in_min > 0:
                report_user_log(f"[NextCycle] session={session_file} next run in {next_in_min} min (cycle continues)")
            if report_audit_log:
                report_audit_log(session_file, "SESSION_NEXT_RUN", scheduled_in_sec=next_in_sec)
            heartbeat_interval = int(cfg.get("heartbeat_interval_sec", HEARTBEAT_INTERVAL_SEC)) if cfg else HEARTBEAT_INTERVAL_SEC
            while time.time() < next_scheduled:
                if stop_event and stop_event.is_set():
                    break
                if report_heartbeat and heartbeat_interval > 0:
                    report_heartbeat()
                remaining = next_scheduled - time.time()
                chunk = min(SCHEDULER_POLL_INTERVAL_SEC, heartbeat_interval, max(0.5, remaining))
                await asyncio.sleep(chunk)
    finally:
        _active_posting_sessions.discard(session_key)
        try:
            client.remove_event_handler(_on_incoming_dm, events.NewMessage(incoming=True))
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
        # Allow event loop to process Telethon cleanup (reduces "Task was destroyed" / "database is locked" on worker exit)
        await asyncio.sleep(0.5)


def _snapshot_session_pause_until(cfg: dict) -> dict:
    """Session pause timestamps for snapshot (FloodWait persistence across worker restart)."""
    return dict(cfg.get("session_pause_until") or {})


def _get_global_flood_pause_until() -> float:
    """Return 0 (flood-shield removed; kept for snapshot compatibility)."""
    return 0.0


def _merged_excluded_groups(bot_token: str, cfg: dict | None = None) -> list:
    """Persisted excluded_groups for config patches sent to workers.
    Per-session temp exclusions are intentionally NOT included here — they are keyed by
    (bot_token, session_file) and must not be broadcast to other sessions' workers.
    Temp exclusions are enforced locally per-session via ban_error_count_by_session TTL mechanism."""
    base = set((cfg or _get_cfg(bot_token) or {}).get("excluded_groups") or [])
    return list(base)


def _disabled_session_files(cfg: dict) -> set[str]:
    """Session files an admin has manually parked via the dashboard Enable/Disable toggle.

    Unlike ``excluded_sessions`` (auto-managed by the engine and wiped to [] on every
    start/stop — see ``_clear_session_pause_and_fresh_start``), ``disabled_sessions`` is
    operator-controlled and persists across starts, stops, resumes and crash recovery
    until the account is explicitly re-enabled. A disabled account stays bound to the bot;
    it is simply skipped when spawning workers and assigning groups."""
    return {(f or "").strip() for f in (cfg.get("disabled_sessions") or []) if (f or "").strip()}


def _active_session_files(cfg: dict) -> list[str]:
    """Sessions that can receive groups this run: not excluded, not disabled, not paused, not in cooldown. Used for Enterprise redistribution."""
    excluded = set(cfg.get("excluded_sessions") or []) | _disabled_session_files(cfg)
    pause_until = cfg.get("session_pause_until") or {}
    cooldown_until = cfg.get("session_cooldown_until") or {}
    now = time.time()
    out: list[str] = []
    for s in cfg.get("sessions") or []:
        f = (s.get("file") or "").strip()
        if not f or f in excluded:
            continue
        if (pause_until.get(f) or 0) > now:
            continue
        if (cooldown_until.get(f) or 0) > now:
            continue
        out.append(f)
    # Safety assertion: no paused session should ever appear in the active list.
    for _sf in out:
        _pu_val = float(pause_until.get(_sf) or 0)
        if _pu_val > now:
            logger.error(
                "[BUG] Paused session %s leaked into active_session_files! pause_until=%.0f now=%.0f active=%s pauses=%s",
                _sf, _pu_val, now, out, dict(pause_until),
            )
    return out


def _build_worker_config_snapshot(
    cfg: dict, total_sessions: int, run_first_cycle_immediately: bool = False, bot_token: str | None = None
) -> dict:
    """Build config dict for worker process (read-only snapshot). Includes groups_dir and log_file for _parse_groups_file and user logging.
    When bot_token is provided, excluded_groups is merged with temp exclusions (cleared on restart)."""
    log_file = cfg.get("log_file")
    if not log_file and cfg.get("name"):
        from .utils import name_to_filename
        safe = name_to_filename(cfg["name"])
        log_file = f"data/logs/{safe}.log"
    active_list = _active_session_files(cfg)
    excluded = _merged_excluded_groups(bot_token or "", cfg) if bot_token else list(cfg.get("excluded_groups") or [])
    return {
        "cycle": cfg.get("cycle", 3600),
        "gap": cfg.get("gap", 5),
        "group_file": cfg.get("group_file", "Starter.txt"),
        "groups_dir": str(config.GROUPS_DIR),
        "message_text": cfg.get("message_text", "Hello"),
        "post_links": _get_post_links_list(cfg),
        "message_mode": _get_message_mode(cfg),
        "mode": get_plan_mode(cfg),
        "log_group": cfg.get("log_group") or "",
        "log_file": log_file or "",
        "valid_till": cfg.get("valid_till") or "",
        "name": cfg.get("name") or "",
        "cycle_anchor_ts": float(cfg.get("cycle_anchor_ts") or time.time()),
        "last_cycle_time": dict(cfg.get("last_cycle_time") or {}),
        # Resume checkpoint: posted group keys per session for an in-progress cycle (from stats file).
        "cycle_progress": _load_cycle_progress_for_snapshot(bot_token, cfg),
        "ban_error_count_by_session": dict(cfg.get("ban_error_count_by_session") or {}),
        "excluded_sessions": list(cfg.get("excluded_sessions") or []),
        "session_cooldown_until": dict(cfg.get("session_cooldown_until") or {}),
        "session_pause_until": _snapshot_session_pause_until(cfg),
        "global_flood_pause_until": _get_global_flood_pause_until(),
        "total_sessions": total_sessions,
        "state": "running",
        "heartbeat_interval_sec": HEARTBEAT_INTERVAL_SEC,
        "run_first_cycle_immediately": run_first_cycle_immediately,
        "active_session_files": active_list,
        "excluded_groups": excluded,
        "auto_prune_dead_groups": bool(cfg.get("auto_prune_dead_groups", False)),
    }


def _build_health_alert_content(
    entries: list[dict], free_entries: list[dict], paid_entries: list[dict], price_per: float,
) -> tuple[str, list[tuple[str, int, int, str | None]]]:
    """(text, entity_spec) for the Session Health Alert, sent over two different transports
    (PTB to the log group, Telethon to the owner's DM) — built once, adapted per transport by
    _health_alert_ptb_entities / _health_alert_telethon_entities so both stay in sync.
    entity_spec items: (kind, offset, length, emoji_key) where kind is "bold" or "emoji"
    (offsets/lengths in UTF-16 code units). Mirrors the original "\n".join(lines) layout exactly."""
    from .ui.emoji_entities import fallback_glyph, u16len

    header_glyph = fallback_glyph("log_health_alert")
    header_bold = "Session Health Alert"
    lines: list[tuple[str, list[tuple[int, int, str, str | None]]]] = [
        (
            f"{header_glyph} {header_bold}\n",
            [
                (0, u16len(header_glyph), "emoji", "log_health_alert"),
                (u16len(header_glyph) + 1, u16len(header_bold), "bold", None),
            ],
        )
    ]
    for e in entries:
        key = "log_frozen" if e["spam_status"] in ("FROZEN", "HARD_LIMITED") else "log_limited"
        glyph = fallback_glyph(key)
        free_tag = " (FREE replacement)" if e["free_replacement"] else f" (${price_per:.2f})"
        line_text = f"{glyph} {e['real_name']} — {e['spam_status']}{free_tag}"
        lines.append((line_text, [(0, u16len(glyph), "emoji", key)]))
    if free_entries:
        glyph = fallback_glyph("log_free_available")
        line_text = f"\n{glyph} {len(free_entries)} free replacement(s) available"
        lines.append((line_text, [(1, u16len(glyph), "emoji", "log_free_available")]))
    if paid_entries:
        total = sum(float(x.get("price_usd", 0)) for x in paid_entries)
        glyph = fallback_glyph("log_paid")
        line_text = f"\n{glyph} {len(paid_entries)} paid replacement(s): ${total:.2f}"
        lines.append((line_text, [(1, u16len(glyph), "emoji", "log_paid")]))
    lines.append(("\nChoose an action below:", []))

    text_parts: list[str] = []
    spec: list[tuple[str, int, int, str | None]] = []
    u16 = 0
    for i, (line_text, markers) in enumerate(lines):
        if i > 0:
            text_parts.append("\n")
            u16 += 1
        for local_off, length, kind, key in markers:
            spec.append((kind, u16 + local_off, length, key))
        text_parts.append(line_text)
        u16 += u16len(line_text)
    return "".join(text_parts), spec


def _health_alert_ptb_entities(spec: list[tuple[str, int, int, str | None]]) -> list["MessageEntity"]:
    """Adapt _build_health_alert_content's entity_spec to PTB MessageEntity (for the log group)."""
    from telegram import MessageEntity
    from .ui.emojis import CUSTOM_EMOJIS

    out: list[MessageEntity] = []
    for kind, offset, length, key in spec:
        if kind == "bold":
            out.append(MessageEntity(type=MessageEntity.BOLD, offset=offset, length=length))
        elif kind == "emoji" and key in CUSTOM_EMOJIS:
            out.append(MessageEntity(
                type=MessageEntity.CUSTOM_EMOJI, offset=offset, length=length,
                custom_emoji_id=CUSTOM_EMOJIS[key],
            ))
    return out


def _health_alert_telethon_entities(spec: list[tuple[str, int, int, str | None]]) -> list:
    """Adapt _build_health_alert_content's entity_spec to Telethon MTProto entities (for the owner DM)."""
    from telethon.tl.types import MessageEntityBold, MessageEntityCustomEmoji
    from .ui.emojis import CUSTOM_EMOJIS

    out = []
    for kind, offset, length, key in spec:
        if kind == "bold":
            out.append(MessageEntityBold(offset=offset, length=length))
        elif kind == "emoji" and key in CUSTOM_EMOJIS:
            out.append(MessageEntityCustomEmoji(offset=offset, length=length, document_id=int(CUSTOM_EMOJIS[key])))
    return out


def _schedule_session_health_check(bot_token: str) -> None:
    """Schedule an async SpamBot health check for a bot's failing sessions.
    Non-blocking: just adds to set, processed by background loop."""
    with _health_check_lock:
        _pending_health_checks.add(bot_token)


async def _run_session_health_check(bot_token: str) -> None:
    """Run SpamBot health check for failing sessions of a bot, create replacement requests,
    and notify the user via their controller bot with inline buttons."""
    try:
        flagged = await check_and_flag_failing_sessions(bot_token)
        if not flagged:
            return
        cfg = _get_cfg(bot_token)
        if not cfg:
            return
        name = cfg.get("name", "")
        owner_id = cfg.get("owner_id") or 0
        existing_pending = get_pending_replacements_for_bot(bot_token)
        existing_files = {e["session_file"] for e in existing_pending}
        new_flagged = [f for f in flagged if f["session_file"] not in existing_files]
        if not new_flagged:
            return
        free_remaining = get_free_replacements_remaining(cfg)
        entries = create_replacement_request(
            bot_token=bot_token,
            bot_name=name,
            owner_id=owner_id,
            sessions=new_flagged,
            free_count=free_remaining,
        )
        if not entries:
            return
        await _send_replacement_alert(bot_token, cfg, entries)
    except Exception as e:
        logger.exception("[Replacement] Health check failed for %s: %s", bot_token[:20], e)


async def _send_replacement_alert(bot_token: str, cfg: dict, entries: list[dict]) -> None:
    """Send the Session Health / Replacement alert: a read-only record to the log group and
    an actionable DM (Replace Free / Pay $ / Skip) to the owner. Shared by the SpamBot health
    check and the runtime dead-session flow so both notify the user identically."""
    free_entries = [e for e in entries if e.get("free_replacement")]
    paid_entries = [e for e in entries if not e.get("free_replacement")]
    price_per = get_session_replacement_price()
    text, spec = _build_health_alert_content(entries, free_entries, paid_entries, price_per)
    buttons = []
    if free_entries:
        buttons.append([panel_button(f"Replace Free ({len(free_entries)})", CB_REP_FREE, "log_free_available")])
    if paid_entries:
        total = sum(float(e.get("price_usd", 0)) for e in paid_entries)
        buttons.append([panel_button(f"Pay ${total:.2f} & Replace", CB_REP_PAY, "log_paid")])
    buttons.append([Button.inline("Skip / Continue Without", CB_REP_SKIP)])
    # Send to log group (PTB, no buttons — read-only record; only the owner DM below is actionable)
    enqueue_log(bot_token, text, entities=_health_alert_ptb_entities(spec), batchable=False)
    # Send directly to owner via controller bot (Telethon)
    owner_id = cfg.get("owner_id") or 0
    bot_client = BOT_CLIENTS.get(bot_token)
    if bot_client and owner_id:
        try:
            await bot_client.send_message(
                owner_id, text,
                formatting_entities=_health_alert_telethon_entities(spec),
                buttons=buttons,
            )
        except Exception as e:
            logger.warning("[Replacement] Failed to send notification to owner %s: %s", owner_id, e)


async def _notify_dead_session_replacement(
    bot_token: str, session_file: str, real_name: str, reason: str
) -> None:
    """A session died at runtime (banned / de-authorized / frozen). Flag it for replacement
    and notify the owner + admin so they replace it themselves — free within their plan
    quota, otherwise paid. We never auto-pull a free session for a dead one."""
    try:
        cfg = _get_cfg(bot_token)
        if not cfg:
            return
        # Don't duplicate an existing open request for the same session.
        existing = {e["session_file"] for e in get_pending_replacements_for_bot(bot_token)}
        if session_file in existing:
            return
        free_remaining = get_free_replacements_remaining(cfg)
        entries = create_replacement_request(
            bot_token=bot_token,
            bot_name=cfg.get("name", ""),
            owner_id=cfg.get("owner_id") or 0,
            sessions=[{
                "session_file": session_file,
                "real_name": real_name or session_file,
                "spam_status": "DEAD",
                "failure_rate": 1.0,
            }],
            # Offer the free button only if the plan still has free replacements left;
            # otherwise it comes through as a paid ($) replacement.
            free_count=1 if free_remaining > 0 else 0,
        )
        if not entries:
            return
        await _send_replacement_alert(bot_token, cfg, entries)
    except Exception as e:
        logger.warning("[DeadSession] notify/replacement-request failed for %s: %s", session_file, e)


async def _health_check_background_loop() -> None:
    """Background loop that processes pending health checks every 60s."""
    while True:
        await asyncio.sleep(60)
        tokens_to_check: list[str] = []
        with _health_check_lock:
            tokens_to_check = list(_pending_health_checks)
            _pending_health_checks.clear()
        for token in tokens_to_check:
            try:
                await _run_session_health_check(token)
            except Exception as e:
                logger.warning("[HealthCheck] Error for %s: %s", token[:20], e)
            await asyncio.sleep(5)


def _apply_worker_result(msg: dict) -> None:
    """Apply one worker result message to storage / alerts / log queue. Called from controller."""
    msg_type = msg.get("type")
    bot_token = msg.get("bot_token", "")
    if not bot_token:
        return
    if msg_type == "cycle_done":
        session_file = msg.get("session_file")
        timestamp = msg.get("timestamp")
        # Cycle Summary logging (attempted/success/failed/skipped) for diagnostics
        _attempted = msg.get("posts_attempted")
        _success = msg.get("posts_success")
        _failed = msg.get("posts_failed")
        _skipped = msg.get("posts_skipped")
        if _attempted is not None and _success is not None:
            _fail = _failed if _failed is not None else max(0, (_attempted or 0) - (_success or 0) - (_skipped or 0))
            _skip = _skipped if _skipped is not None else 0
            _skip_cooldown = msg.get("posts_skipped_cooldown", 0)
            _skip_fw = msg.get("posts_skipped_floodwait", 0)
            skip_detail = f" (cooldown={_skip_cooldown}, floodwait={_skip_fw})" if _skip and (_skip_cooldown or _skip_fw) else ""
            logger.info(
                "Cycle Summary: session=%s attempted=%s success=%s failed=%s skipped=%s%s",
                session_file or "(unknown)", _attempted, _success, _fail, _skip, skip_detail,
            )
            # Notify admin when failure rate > 60% (real failures, not skips)
            if _attempted > 0 and _fail / _attempted > 0.6:
                cfg = _get_cfg(bot_token)
                name = (cfg.get("name") or bot_token[:20]) if cfg else bot_token[:20]
                failure_pct = 100.0 * _fail / _attempted
                from .ui.emoji_entities import build_emoji_message
                warn_text, warn_entities = build_emoji_message(
                    f"Session {session_file} ({name}): failure rate {failure_pct:.0f}% this cycle. Session continues next cycle; consider removing banned/invalid groups from list.",
                    "log_warning",
                )
                enqueue_log(bot_token, warn_text, entities=warn_entities)
        if session_file is not None and timestamp is not None:
            _worker_first_cycle_or_post.add((bot_token, session_file))
            _cd_success = int(msg.get("posts_success") or 0)
            _cd_failed = int(msg.get("posts_failed") or 0)
            _cd_skipped = int(msg.get("posts_skipped") or 0)
            _cd_attempted = int(msg.get("posts_attempted") or 0)
            if not _cd_failed and _cd_attempted > _cd_success + _cd_skipped:
                _cd_failed = _cd_attempted - _cd_success - _cd_skipped
            _increment_cycle_count_in_stats(
                bot_token, session_file,
                posts_success=_cd_success,
                posts_failed=_cd_failed,
                posts_skipped=_cd_skipped,
                posts_attempted=_cd_attempted,
                cycle_duration_sec=float(msg.get("cycle_duration_sec") or 0),
                cycle_ts=timestamp,
            )
            cfg = _get_cfg(bot_token)
            if cfg and cfg.get("state") == "activating":
                _save_bot_config(bot_token, lambda c: c.update({"state": "running"}))
            def upd(c):
                c.setdefault("last_cycle_time", {})[session_file] = timestamp
                # Only clear FloodWait pause if it has already expired; a session that just
                # hit FloodWait sends cycle_done immediately after session_paused — clearing
                # a still-active pause here would corrupt active_session_files (BUG-1 fix).
                pu = c.get("session_pause_until") or {}
                if session_file in pu:
                    _pause_ts = float(pu[session_file] or 0)
                    if _pause_ts <= time.time():
                        pu = dict(pu)
                        del pu[session_file]
                        c["session_pause_until"] = pu
                first_map = c.setdefault("session_first_cycle_time", {})
                if session_file not in first_map:
                    first_map[session_file] = timestamp
            _save_bot_config(bot_token, upd)
            # Cycle finished fully → drop its mid-cycle resume checkpoint so a later restart does not
            # wrongly skip groups (a completed cycle is handled by the last_cycle_time boundary guard).
            _clear_cycle_progress(bot_token, session_file)
            # Push updated session_pause_until and active_session_files so FloodWait-cleared sessions get groups without restart
            workers_list = _worker_handles.get(bot_token)
            if workers_list:
                cfg_after = _get_cfg(bot_token)
                pause_map = (cfg_after or {}).get("session_pause_until") or {}
                active_list = _active_session_files(cfg_after or {})
                patch = {"session_pause_until": dict(pause_map), "active_session_files": active_list}
                for _proc, cmd_q, *_ in workers_list:
                    try:
                        cmd_q.put({"cmd": "config_patch", "patch": patch})
                    except Exception:
                        pass
            # Auto-detect failing sessions: if 90%+ failure, schedule SpamBot check
            if _cd_attempted > 0 and _cd_failed / _cd_attempted >= 0.90 and _cd_success <= 1:
                _schedule_session_health_check(bot_token)
        # Stats: no longer updated from cycle_done; all increments happen on post_attempt (batched).
    elif msg_type == "cycle_progress":
        # Mid-cycle checkpoint from a worker: which group keys this session already posted in the
        # current cycle. Persisted to the stats file (not user JSON, to avoid bloat) so a crash/restart
        # can resume the same cycle from where it left off.
        session_file = msg.get("session_file")
        cycle_ts = msg.get("cycle_ts")
        posted = msg.get("posted") or []
        if session_file and cycle_ts is not None:
            _persist_cycle_progress(bot_token, session_file, float(cycle_ts), list(posted))
    elif msg_type == "cycle_failed":
        # Do not permanently exclude on a single zero-post cycle; retry on next cycle.
        session_file = msg.get("session_file")
        if session_file:
            logger.info("Session %s had 0 posts this cycle — will retry next cycle (no exclusion)", session_file)
    elif msg_type == "permanent_exclusion":
        # Enterprise: persist permanently failed group so it is not retried every cycle (optional auto_prune_dead_groups).
        group_key = msg.get("group_key")
        reason = msg.get("reason", "")
        if group_key:
            def upd(c):
                excl = list(c.get("excluded_groups") or [])
                if group_key not in excl:
                    excl.append(group_key)
                c["excluded_groups"] = excl[-2000:]  # cap to avoid unbounded growth
            _save_bot_config(bot_token, upd)
            logger.info("[PermanentExclusion] persisted group_key=%s reason=%s", group_key, reason[:60] if reason else "")
            # Push updated excluded_groups (merged with temp) so workers see it without restart
            workers_list = _worker_handles.get(bot_token)
            if workers_list:
                cfg_after = _get_cfg(bot_token)
                patch = {"excluded_groups": _merged_excluded_groups(bot_token, cfg_after)}
                for _proc, cmd_q, *_ in workers_list:
                    try:
                        cmd_q.put({"cmd": "config_patch", "patch": patch})
                    except Exception:
                        pass
    elif msg_type == "session_died":
        session_file = msg.get("session_file")
        reason = msg.get("reason", "")
        if session_file:
            _mark_session_dead_and_replace(bot_token, session_file, reason)
    elif msg_type == "session_paused":
        session_file = msg.get("session_file")
        unblock_time = msg.get("unblock_time")
        wait_seconds = msg.get("wait_seconds", 0)
        if session_file is not None and unblock_time is not None:
            def upd(c):
                c.setdefault("session_pause_until", {})[session_file] = float(unblock_time)
            _save_bot_config(bot_token, upd)
            logger.info("[FloodWait] session=%s pause_until=%.0f wait_seconds=%s persisted", session_file, unblock_time, wait_seconds)
            # BUG-2 fix: immediately push config_patch so workers exclude the
            # paused session from active_session_files on their next cycle.
            workers_list = _worker_handles.get(bot_token)
            if workers_list:
                cfg_after_pause = _get_cfg(bot_token) or {}
                pause_map_p = dict(cfg_after_pause.get("session_pause_until") or {})
                active_list_p = _active_session_files(cfg_after_pause)
                patch_p = {"session_pause_until": pause_map_p, "active_session_files": active_list_p}
                for _proc, cmd_q, *_ in workers_list:
                    try:
                        cmd_q.put({"cmd": "config_patch", "patch": patch_p})
                    except Exception:
                        pass
                logger.info("[FloodWait] config_patch pushed: active=%s pauses=%s", active_list_p, list(pause_map_p.keys()))
    elif msg_type == "expired":
        _mark_bot_expired(bot_token, from_worker=False)
    elif msg_type == "admin_alert":
        add_admin_alert(msg.get("kind", "worker_alert"), msg.get("message", ""))
    elif msg_type == "dm_alert":
        # Incoming DM: record in the owner's inbox, raise the web bell, and DM the owner via
        # the AdBot's control bot (debounced). Admin also still gets the legacy alert.
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_handle_dm_alert(msg))
            session_file = msg.get("session_file", "")
            user_id = msg.get("user_id", 0)
            if session_file and user_id:
                loop.create_task(notify.notify_dm_received(
                    session_file, msg.get("from_name", "Unknown User"), user_id, msg.get("message_text", ""),
                    account_username=msg.get("account_username", ""),
                    account_user_id=int(msg.get("account_user_id", 0) or 0),
                    sender_username=msg.get("sender_username", ""),
                    media_type=msg.get("media_type", ""),
                    caption=msg.get("caption", ""),
                ))
        except Exception as e:
            logger.warning("dm_alert handling failed: %s", e)
    elif msg_type == "log":
        message = msg.get("message", "")
        entity_spec = msg.get("entity_spec")
        entities = None
        if entity_spec:
            from .ui.emoji_entities import entities_from_spec
            entities = entities_from_spec(entity_spec)
        enqueue_log(
            bot_token,
            message,
            msg.get("parse_mode"),
            buttons=msg.get("buttons"),
            entities=entities,
        )
        # Post results are already written by the "post_attempt" handler in structured format.
        # Skip post-result lines (HTML success / plain failure) to avoid duplicates.
        if message:
            stripped = message.strip()
            is_post_line = "<a " in stripped or _POST_RESULT_RE.match(stripped) is not None
            if not is_post_line:
                append_to_user_log(bot_token, stripped)
    elif msg_type == "user_log":
        # Scheduler/diagnostic line: only to user log file, not to Telegram log group.
        line = msg.get("message", "")
        if line:
            append_to_user_log(bot_token, line)
    elif msg_type == "post_attempt":
        # Operator-readable posting attempt for user log: account, group_name, group_id, result, flood wait
        session_file = msg.get("session_file", "")
        if session_file:
            _worker_first_cycle_or_post.add((bot_token, session_file))
            cfg = _get_cfg(bot_token)
            if cfg and cfg.get("state") == "activating":
                _save_bot_config(bot_token, lambda c: c.update({"state": "running"}))
        group_id = msg.get("group_id", 0)
        topic_id = msg.get("topic_id")
        success = msg.get("success", False)
        error_message = msg.get("error_message", "")
        group_name = (msg.get("group_name") or "").strip() or "Unknown"
        wait_seconds = msg.get("wait_seconds")
        ts = msg.get("timestamp", time.time())
        from datetime import datetime as _dt
        time_str = _dt.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
        # Bug 11: a FloodWait/cooldown deferral is a SKIP, not a failure. The worker reports these as
        # "floodwait_<n>s" / "...cooldown..." (or with wait_seconds set) — match those, not the old
        # "group_floodwait" token that never appeared, so skips aren't mislabeled [POST_FAILURE].
        _em = (error_message or "").lower()
        _is_skip = (wait_seconds is not None) or (
            not success and ("floodwait" in _em or "flood_wait" in _em or "cooldown" in _em or "slowmode" in _em or "slow mode" in _em)
        )
        status = "success" if success else ("skipped" if _is_skip else "failure")
        account = session_file.replace(".session", "") if (session_file and session_file.endswith(".session")) else (session_file or "unknown")
        group_id_display = f"{group_id}#{topic_id}" if topic_id is not None else str(group_id)
        group_name_safe = repr(group_name)
        if wait_seconds is not None:
            line = f"[FLOOD_WAIT] account={account} group_name={group_name_safe} group_id={group_id_display} wait={wait_seconds}s"
        elif success:
            line = f"[POST_SUCCESS] account={account} group_name={group_name_safe} group_id={group_id_display}"
        elif _is_skip:
            # Deferral (FloodWait / rate-limit cooldown) — not a delivery failure.
            _skip_reason = (error_message or "rate_limited")[:120].replace("\n", " ")
            line = f"[POST_SKIPPED] account={account} group_name={group_name_safe} group_id={group_id_display} reason={repr(_skip_reason)}"
        else:
            err_safe = (error_message or "unknown")[:200].replace("\n", " ")
            line = f"[POST_FAILURE] account={account} group_name={group_name_safe} group_id={group_id_display} error={repr(err_safe)}"
        append_to_user_log(bot_token, line, critical=(status == "failure"))
        # User requested NO permanent exclusion or writing to users json file for groups
        if not success and group_id and error_message:
            group_key = f"{group_id}#{topic_id}" if topic_id is not None else str(group_id)
            err_lower = error_message.strip().lower()
            if "topic_closed" in err_lower or "topic closed" in err_lower:
                logger.info("[ExclusionDisabled] topic_closed group_key=%s bot=%s but user requested no permanent exclusion", group_key, bot_token[:20])
            else:
            # Other transient errors: temp blacklist after >2 occurrences (cleared at next cycle start, never persisted)
                if "group_floodwait" not in err_lower and "group_cooldown" not in err_lower:
                    inner = _temp_exclusion_error_count.setdefault(bot_token, {})
                    inner[group_key] = inner.get(group_key, 0) + 1
                    if inner[group_key] > 2:
                        # Per-session temp exclusion: keyed by (bot_token, session_file) so one
                        # session's ban never prevents other sessions from posting to the same group.
                        sess_excl_key = (bot_token, session_file)
                        _temp_excluded_groups.setdefault(sess_excl_key, set()).add(group_key)
                        logger.info(
                        "[TempExclusion] session=%s group_key=%s failure_count=%s (cleared on next cycle)",
                            session_file, group_key, inner[group_key],
                        )
        # Failure intelligence: rolling window of attempts, classify failures, cooldown if error rate > threshold
        # session_recent_attempts lives in data/stats/<name>.json (not user JSON) to avoid bloating user config.
        # session_cooldown_until still lives in user JSON because workers need it via config snapshot/patch.
        if session_file:
            category = _classify_post_error(error_message) if not success else None
            name = get_name_by_token(bot_token)
            if name:
                st = load_stats(name)
                if not st or not isinstance(st, dict):
                    st = _default_stats_data()
                by_sess = st.setdefault("session_recent_attempts", {})
                if not isinstance(by_sess, dict):
                    by_sess = {}
                    st["session_recent_attempts"] = by_sess
                entry = list(by_sess.get(session_file) or [])
                entry.append({"s": success, "ts": ts, "category": category or ""})
                entry = entry[-SESSION_ERROR_ROLLING_WINDOW:]
                by_sess[session_file] = entry
                # Count only genuine session-health failures (BANNED / WRITE_FORBIDDEN / PEER_FLOOD) in the
                # numerator. FloodWait/unknown are per-group throttles, not session health signals.
                hard_errors = [
                    e for e in entry
                    if isinstance(e, dict) and not e.get("s")
                    and e.get("category") and e["category"] not in ("", POST_ERROR_FLOOD_WAIT, POST_ERROR_UNKNOWN)
                ]
                # Bug 8: denominator MUST include successful posts, otherwise it only ever contains hard
                # failures and the rate is always 1.0 → a single per-group ban would benching the whole
                # account. Denominator = successes + hard failures (exclude FloodWait/unknown skips).
                considered = sum(
                    1 for e in entry
                    if isinstance(e, dict) and (
                        e.get("s")
                        or (e.get("category") and e["category"] not in ("", POST_ERROR_FLOOD_WAIT, POST_ERROR_UNKNOWN))
                    )
                )
                rate = (len(hard_errors) / considered) if considered else 0
                save_stats(name, st)
                # Only write user JSON when cooldown threshold is crossed (not on every post attempt)
                if rate >= SESSION_ERROR_RATE_THRESHOLD:
                    cooldown_ts = time.time() + SESSION_COOLDOWN_SEC
                    def upd(c):
                        cooldown_map = c.setdefault("session_cooldown_until", {})
                        cooldown_map[session_file] = cooldown_ts
                        c["session_cooldown_until"] = cooldown_map
                    _save_bot_config(bot_token, upd)
        # New stats: buffer event; flush every N events or every 5s (batched, crash-safe).
        # Bug 10: a FloodWait/cooldown deferral is neither a delivered post nor a delivery failure — it is a
        # skip. Do not buffer skips, so they don't inflate lifetime_failed / last24h_buckets "failed" counts.
        if not _is_skip:
            _stats_buffer_event(bot_token, session_file, success, ts)
            p = _get_stats_pending(bot_token)
            if len(p["pending_events"]) >= STATS_BATCH_SIZE or (time.time() - p["last_flush_ts"]) >= STATS_FLUSH_INTERVAL_SEC:
                _flush_bot_stats(bot_token)
    elif msg_type == "audit_log":
        # Worker session lifecycle → write to adbot.log for forensic audit
        worker_id = msg.get("worker_id", "")
        session_file = msg.get("session_file", "")
        event = msg.get("event", "")
        ts = msg.get("timestamp")
        cfg = _get_cfg(bot_token)
        name = (cfg.get("name", bot_token[:20]) if cfg else bot_token[:20])
        extra = []
        for k in ("seconds", "reason", "groups", "success_count", "group_id", "scheduled_in_sec"):
            if k in msg:
                extra.append(f"{k}={msg[k]}")
        if ts is not None:
            logger.info("[audit] bot=%s worker_id=%s session=%s event=%s ts=%.0f %s", name, worker_id, session_file, event, ts, " ".join(extra))
        else:
            logger.info("[audit] bot=%s worker_id=%s session=%s event=%s %s", name, worker_id, session_file, event, " ".join(extra))
        # Posting engine moves to RUNNING when at least one worker reports SESSION_CYCLE_START (not on scheduler launch).
        if event == "SESSION_CYCLE_START" and session_file:
            _worker_first_cycle_or_post.add((bot_token, session_file))
            if cfg and cfg.get("state") == "activating":
                _save_bot_config(bot_token, lambda c: c.update({"state": "running"}))
    elif msg_type == "ban_error":
        session_file = msg.get("session_file")
        chat_id = msg.get("chat_id")
        topic_id = msg.get("topic_id")
        if session_file is not None and chat_id is not None:
            _increment_ban_error_count(bot_token, session_file, chat_id, topic_id)
    elif msg_type == "scheduler_health":
        # Log only. Never restart workers based on delay_sec (next_run far in future, FloodWait, or cycle delay).
        # Restart only on: process crash, heartbeat timeout, or process not responding (handled in health monitor).
        session_file = msg.get("session_file", "")
        next_run = msg.get("next_run", 0)
        delay_sec = msg.get("delay_sec", 0)
        worker_alive = msg.get("worker_alive", True)
        name = (_get_cfg(bot_token) or {}).get("name", bot_token[:20])
        # Remember the scheduled next_run so the startup-failure check can tell a session that is
        # simply waiting for its (possibly far-future) cycle apart from one that is truly stuck.
        if session_file:
            _worker_next_run[(bot_token, session_file)] = float(next_run or 0)
        logger.info(
            "[SchedulerHealth] session=%s next_run=%.0f delay_sec=%.1f worker_alive=%s bot=%s",
            session_file, next_run, delay_sec, worker_alive, name,
        )
    elif msg_type == "heartbeat":
        # Ignore heartbeats for bots already stopped (in-flight messages from workers that just received STOP)
        if bot_token not in _worker_handles:
            return
        worker_id = msg.get("worker_id")
        ts = msg.get("timestamp", time.time())
        if worker_id is not None:
            _worker_last_heartbeat[(bot_token, worker_id)] = ts
            # Rate-limited: log HEARTBEAT to adbot.log at most every HEARTBEAT_LOG_INTERVAL_SEC
            key = (bot_token, worker_id)
            last_log = _worker_heartbeat_log_ts.get(key, 0)
            if ts - last_log >= HEARTBEAT_LOG_INTERVAL_SEC:
                name = _get_cfg(bot_token).get("name", bot_token[:20]) if _get_cfg(bot_token) else bot_token[:20]
                logger.info("[audit] HEARTBEAT bot=%s worker_id=%s ts=%.0f", name, worker_id, ts)
                _worker_heartbeat_log_ts[key] = ts


# Stats flush: every 5–10 min so disk reflects in-memory stats even if no cycle completed
STATS_FLUSH_INTERVAL_SEC = 420  # 7 minutes


def _check_scheduler_drift_for_bot(bot_token: str) -> None:
    """Check expected vs actual cycles per session; log [SchedulerDriftWarning] if drift exceeds tolerance. Optional: realign last_cycle_time to nearest boundary."""
    cfg = _get_cfg(bot_token)
    if not cfg:
        return
    name = get_name_by_token(bot_token)
    st = load_stats(name) if name else None
    session_stats = (st or {}).get("session_stats") or {}
    cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
    first_map = cfg.get("session_first_cycle_time") or {}
    now_ts = time.time()
    for session_file, first_ts in first_map.items():
        if not first_ts or first_ts <= 0:
            continue
        actual_cycles = 0
        if isinstance(session_stats.get(session_file), dict):
            actual_cycles = int((session_stats[session_file] or {}).get("cycles", 0))
        expected_cycles = (now_ts - first_ts) / cycle_sec if cycle_sec > 0 else 0
        drift = abs(expected_cycles - actual_cycles)
        if drift > SCHEDULER_DRIFT_TOLERANCE_CYCLES:
            logger.warning(
                "[SchedulerDriftWarning] session=%s drift_cycles=%.1f expected_cycles=%.1f actual_cycles=%s",
                session_file, drift, expected_cycles, actual_cycles,
            )
            # NOTE: scheduling is deterministic from cycle_anchor_ts + per-session phase (see
            # _async_session_loop), so it does not accumulate drift and there is nothing to realign.
            # (Historically this wrote last_cycle_time, but the scheduler never reads that value —
            # writing it was a no-op. Kept as a diagnostic warning only.)


async def _drift_check_loop() -> None:
    """Periodically verify scheduler precision for long-running bots (weekly/daily)."""
    while True:
        try:
            await asyncio.sleep(DRIFT_CHECK_INTERVAL_SEC)
        except asyncio.CancelledError:
            break
        for bot_token in list(_worker_handles.keys()):
            try:
                _check_scheduler_drift_for_bot(bot_token)
            except Exception as e:
                logger.warning("Drift check failed for bot %s: %s", bot_token[:20], e)


async def _user_log_flush_loop() -> None:
    """Periodically flush buffered user log queues (every 2s) to avoid I/O bottleneck under heavy posting."""
    from .utils import flush_user_log_queues, USER_LOG_FLUSH_INTERVAL_SEC
    while True:
        try:
            await asyncio.sleep(USER_LOG_FLUSH_INTERVAL_SEC)
            flush_user_log_queues()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("User log flush loop error: %s", e)


async def _stats_flush_loop() -> None:
    """Every STATS_FLUSH_INTERVAL_SEC, flush pending stats to data/stats/<name>.json only (no user JSON)."""
    while True:
        try:
            await asyncio.sleep(STATS_FLUSH_INTERVAL_SEC)
            for bot_token in list(_stats_pending.keys()):
                try:
                    p = _stats_pending.get(bot_token)
                    if p and p.get("pending_events"):
                        _flush_bot_stats(bot_token)
                except Exception as e:
                    logger.warning("Stats flush for bot %s: %s", (bot_token or "")[:20], e)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Stats flush loop: %s", e)


async def _worker_result_handler_async() -> None:
    """Run on main loop: read from _worker_result_queue and apply updates. One task for all bots."""
    global _worker_result_queue
    if _worker_result_queue is None:
        return
    q = _worker_result_queue
    while True:
        try:
            msg = await asyncio.to_thread(q.get)
        except Exception:
            break
        if msg is None:
            break
        try:
            _apply_worker_result(msg)
        except Exception as e:
            ctx = []
            if isinstance(msg, dict):
                if msg.get("bot_token"):
                    ctx.append(f"bot_token={msg['bot_token'][:20]}...")
                if msg.get("session_file"):
                    ctx.append(f"session={msg['session_file']}")
                if msg.get("worker_id") is not None:
                    ctx.append(f"worker_id={msg['worker_id']}")
                if msg.get("event"):
                    ctx.append(f"event={msg['event']}")
            logger.exception("Worker result handler [%s]: %s", " ".join(ctx) or "no_context", e)


async def _session_worker_wrapper(
    bot_token: str,
    session_ordinal: int,
    total_workers: int,
    session_file: str,
    stagger_sec: float,
    stop_event: asyncio.Event,
) -> None:
    """Run session loop; when it exits, alert admin if stop was not requested and bot is still running."""
    try:
        await _async_session_loop(
            bot_token, session_ordinal, total_workers, session_file, stagger_sec, stop_event
        )
    finally:
        if not stop_event.is_set():
            data = load_adbot()
            cfg = data.get("bots", {}).get(bot_token)
            if cfg and cfg.get("state") == "running":
                name = cfg.get("name") or bot_token[:20]
                add_admin_alert(
                    "session_worker_stopped",
                    f"AdBot {name} — session worker {session_file} stopped unexpectedly. Use /health and Run again if needed.",
                )
                logger.warning("Session worker %s stopped unexpectedly for bot %s", session_file, name)


def _join_workers_sync(
    workers_list: list[tuple],
    join_timeout: int = 40,
    terminate_join_timeout: int = 5,
) -> None:
    """Blocking: join each worker process, terminate if still alive. Must run in thread pool, never in asyncio loop.
    workers_list items are (proc, cmd_q, worker_id, session_chunk) or (proc, cmd_q) for backward compat."""
    for item in workers_list:
        proc = item[0]
        try:
            proc.join(timeout=join_timeout)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=terminate_join_timeout)
        except Exception:
            pass


def _terminate_proc_sync(proc: multiprocessing.Process, join_timeout: int = 5) -> None:
    """Blocking: terminate process and join. Must run in thread pool, never in asyncio loop."""
    try:
        proc.terminate()
        proc.join(timeout=join_timeout)
    except Exception:
        pass


def _session_file_from_chunk(session_chunk: list[dict]) -> str:
    """Return session filename for logging (e.g. 'foo.session')."""
    if not session_chunk:
        return "unknown.session"
    fn = session_chunk[0].get("file") or ""
    return fn if fn.endswith(".session") else (fn + ".session")


def _clear_session_registry_for_bot(bot_token: str) -> None:
    """Remove all (bot_token, session_file) entries from _session_worker_registry and startup grace state."""
    to_remove = [k for k in _session_worker_registry if k[0] == bot_token]
    for k in to_remove:
        _session_worker_registry.pop(k, None)
        _worker_start_time.pop(k, None)
        _worker_startup_grace_until.pop(k, None)
        _worker_stagger_sec.pop(k, None)
        _worker_next_run.pop(k, None)


async def _restart_single_worker(bot_token: str, worker_id: int) -> bool:
    """Restart only the worker at worker_id (e.g. after heartbeat timeout). Preserves last_cycle_time.
    Prevents duplicate workers: terminates existing and waits until confirmed dead before spawning.
    Returns True if restart was done, False if bot/worker_id invalid or restart already in progress for this session."""
    global _session_worker_registry, _restart_in_progress
    workers_list = _worker_handles.get(bot_token)
    if not workers_list or worker_id < 0 or worker_id >= len(workers_list):
        return False
    cfg = _get_cfg(bot_token)
    if not cfg:
        return False
    old_proc, old_cmd_q, _wid, session_chunk = workers_list[worker_id]
    session_file = _session_file_from_chunk(session_chunk)
    # Admin-parked account: never revive it. A disabled session has no worker after a normal
    # (re)start, but guard here so the health monitor cannot resurrect one via a stale registry entry.
    if session_file in _disabled_session_files(cfg):
        logger.info("[WorkerRestart] session=%s is disabled by admin; skipping revive", session_file)
        return False
    key = (bot_token, session_file)
    if key in _restart_in_progress:
        logger.warning("[WorkerRestart] session=%s restart already in progress, rejecting", session_file)
        return False
    _restart_in_progress.add(key)
    try:
        old_worker_terminated = False
        try:
            old_cmd_q.put({"cmd": "stop"})
        except Exception:
            pass
        await asyncio.to_thread(_join_workers_sync, [workers_list[worker_id]], join_timeout=25)
        if not old_proc.is_alive():
            old_worker_terminated = True
        else:
            try:
                old_proc.terminate()
                old_proc.join(timeout=5)
            except Exception:
                pass
            old_worker_terminated = not old_proc.is_alive()
        for _ in range(10):
            if not old_proc.is_alive():
                break
            await asyncio.sleep(0.5)
        if old_proc.is_alive():
            logger.warning("[WorkerRestart] session=%s old_worker=%s did not terminate cleanly", session_file, worker_id)
        from .workers import worker_entry
        global _worker_result_queue
        if _worker_result_queue is None:
            _worker_result_queue = multiprocessing.Queue()
        excluded = set(cfg.get("excluded_sessions") or []) | _disabled_session_files(cfg)
        valid_sessions = [
            s for s in cfg.get("sessions", [])
            if (s.get("file") or "") and config.resolve_session_path(s.get("file") or "").is_file()
            and (s.get("file") or "").strip() not in excluded
        ]
        total_sessions = len(valid_sessions)
        config_snapshot = _build_worker_config_snapshot(cfg, total_sessions, bot_token=bot_token)
        cmd_queue: multiprocessing.Queue = multiprocessing.Queue()
        proc = multiprocessing.Process(
            target=worker_entry,
            args=(bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, _worker_result_queue),
        )
        proc.start()
        workers_list[worker_id] = (proc, cmd_queue, worker_id, session_chunk)
        _session_worker_registry[key] = worker_id
        now = time.time()
        _worker_start_time[key] = now
        _worker_startup_grace_until[key] = now + WORKER_STARTUP_GRACE_SEC
        _worker_first_cycle_or_post.discard(key)
        cfg_restart = _get_cfg(bot_token)
        if cfg_restart:
            total_sessions = len(cfg_restart.get("sessions") or [])
            mode = (cfg_restart.get("mode") or "Starter").strip()
            global_ordinal = worker_id
            if mode == "Enterprise":
                half = max(1, total_sessions) // 2
                _worker_stagger_sec[key] = 0.0 if global_ordinal < half else float(ENTERPRISE_STAGGER_SEC)
            else:
                # A single-worker restart is always boundary-driven (resume), so the worker applies no
                # Starter startup delay — mirror that here so the health monitor's timing matches.
                _worker_stagger_sec[key] = 0.0
        else:
            _worker_stagger_sec[key] = 0.0
        try:
            cmd_queue.put({"cmd": "start"})
        except Exception:
            pass
        _worker_last_heartbeat.pop((bot_token, worker_id), None)
        _worker_heartbeat_log_ts.pop((bot_token, worker_id), None)
        cfg = _get_cfg(bot_token)
        name = (cfg.get("name") or bot_token[:20]) if cfg else bot_token[:20]
        username = (cfg.get("bot_username") or "") if cfg else ""
        logger.info(
            "[WorkerRestart] session=%s old_worker=%s terminated=%s new_worker=%s",
            session_file, worker_id, old_worker_terminated, worker_id,
        )
        ts_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        add_admin_alert(
            "worker_restarted",
            f"[WorkerRestart] BotUser=@{username or name} Session={session_file} Reason=health_timeout Time={ts_str}",
        )
        return True
    finally:
        _restart_in_progress.discard(key)


async def _start_posting(
    bot_token: str,
    preserve_cycle_time: bool = False,
    update_status: Optional[Callable[[str], Awaitable[None]]] = None,
) -> bool:
    """Start posting as asyncio tasks. Cancel any previous tasks, start workers.
    When preserve_cycle_time=True (health restart), do NOT reset last_cycle_time so cycle alignment and scheduling are preserved and we avoid restart loops that worsen drift.
    update_status(text) is called once after START is sent to all workers with the final success message."""
    # Await any pending STOP cleanup so we don't spawn new workers while old ones still hold session files
    pending = _pending_stop_cleanup.pop(bot_token, None)
    if pending:
        try:
            await asyncio.wait_for(pending, timeout=50.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
    # Start protection: do not start again if already running (prevents duplicate Run / restart loops)
    if bot_runtime_state.get(bot_token, {}).get("running") is True and not preserve_cycle_time:
        logger.info("[StartGuard] bot already running, ignoring duplicate start bot=%s", bot_token[:20])
        _last_start_failure_reason[bot_token] = "already_running"
        return False
    cfg = _get_cfg(bot_token)
    if not cfg:
        _last_start_failure_reason[bot_token] = "no_cfg"
        return False
    if cfg.get("suspended"):
        _last_start_failure_reason[bot_token] = "suspended"
        return False
    if not preserve_cycle_time:
        logger.info("[AdBotLifecycle] START_REQUESTED bot=%s", cfg.get("name") or bot_token[:20])
    # Stop any existing workers or asyncio tasks for this bot
    workers_list = _worker_handles.pop(bot_token, None)
    if workers_list:
        bot_runtime_state.setdefault(bot_token, {})["running"] = False
        _clear_session_registry_for_bot(bot_token)
        for k in list(_worker_last_heartbeat.keys()):
            if k[0] == bot_token:
                del _worker_last_heartbeat[k]
        for k in list(_worker_heartbeat_log_ts.keys()):
            if k[0] == bot_token:
                del _worker_heartbeat_log_ts[k]
    if workers_list:
        for proc, cmd_q, *_ in workers_list:
            try:
                cmd_q.put({"cmd": "stop"})
            except Exception:
                pass
        await asyncio.to_thread(_join_workers_sync, workers_list)
    existing = _posting_handles.get(bot_token)
    if existing:
        stop_ev, tasks, _ = existing
        stop_ev.set()
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=35, return_when=asyncio.ALL_COMPLETED)
            for t in pending:
                t.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        _posting_handles.pop(bot_token, None)
        _worker_last_activity.pop(bot_token, None)
    # Reset last_cycle_time only on user Run so first cycle runs immediately; on health restart preserve it to avoid drift.
    if not preserve_cycle_time:
        def _clear_last_cycle(c):
            c.pop("last_cycle_time", None)
        _save_bot_config(bot_token, _clear_last_cycle)
    # State is "activating" until first cycle_done or post_attempt (Part 6); then set to "running" in _apply_worker_result.
    _save_bot_config(bot_token, lambda c: c.update({"state": "activating" if not preserve_cycle_time else "running"}))
    # Always clear pauses/cooldowns on any start (including health-monitor restarts)
    # so stale FloodWait entries don't permanently exclude sessions.
    _session_availability.pop(bot_token, None)
    _deferred_groups.pop(bot_token, None)
    def _clear_session_pause_and_fresh_start(c):
        c["session_pause_until"] = {}
        c["session_cooldown_until"] = {}
        c["excluded_sessions"] = []
        c["ban_error_count_by_session"] = {}
    _save_bot_config(bot_token, _clear_session_pause_and_fresh_start)
    cfg = _get_cfg(bot_token) or cfg
    # Release idle web-portal holds (account manager keeps sessions connected up to
    # 5 min after last use) so posting workers don't hit "session busy" at start.
    _own_session_files = [s.get("file") or "" for s in cfg.get("sessions", []) if s.get("file")]
    try:
        await session_guard.release_soft_holders(_own_session_files)
    except Exception as e:
        logger.warning("release_soft_holders before start failed: %s", e)
    # Force-clear any orphaned cross-process locks on this bot's OWN sessions. All
    # of this bot's prior workers were just stopped and joined above, so a surviving
    # "posting" lock is stale — a crashed worker or a reused PID that _pid_alive
    # wrongly reports as alive. Without this, that session stays permanently "busy"
    # and the new worker loops on "failed to connect" forever (never a Telegram
    # limit — the bot locked itself out). Only this bot's session files are touched.
    try:
        _cleared_locks = session_guard.force_clear_locks(_own_session_files)
        if _cleared_locks:
            logger.info(
                "[AdBotLifecycle] Cleared %s orphaned session lock(s) before start bot=%s: %s",
                len(_cleared_locks), cfg.get("name") or bot_token[:20], _cleared_locks,
            )
    except Exception as e:
        logger.warning("force_clear_locks before start failed: %s", e)
    for k in list(_worker_heartbeat_log_ts.keys()):
        if k[0] == bot_token:
            del _worker_heartbeat_log_ts[k]
    sessions = cfg.get("sessions", [])
    if not sessions:
        _last_start_failure_reason[bot_token] = "no_sessions"
        return False
    excluded = set(cfg.get("excluded_sessions") or []) | _disabled_session_files(cfg)
    valid_sessions = [
        s for s in sessions
        if (s.get("file") or "") and config.resolve_session_path(s.get("file") or "").is_file()
        and (s.get("file") or "").strip() not in excluded
    ]
    if not valid_sessions:
        _last_start_failure_reason[bot_token] = "no_valid_sessions"
        return False
    if update_status:
        try:
            await update_status("Checking configuration...")
            await asyncio.sleep(0.2)
        except Exception as e:
            logger.debug("Status update failed: %s", e)
    # Exclude sessions with zero assigned groups (file log only; do not start workers for them)
    valid_sessions_with_groups: list[dict] = []
    for idx, s in enumerate(valid_sessions):
        session_file = (s.get("file") or "").strip()
        if not session_file:
            continue
        groups_for_sess, _ = _assigned_groups_for_session(bot_token, cfg, session_file, idx, len(valid_sessions))
        if len(groups_for_sess) == 0:
            logger.warning(
                "[posting] session assigned ZERO groups: session=%s (group_file=%s mode=%s); excluding from this run",
                session_file, cfg.get("group_file"), get_plan_mode(cfg),
            )
            continue
        valid_sessions_with_groups.append(s)
    valid_sessions = valid_sessions_with_groups
    if not valid_sessions:
        _last_start_failure_reason[bot_token] = "no_groups"
        return False
    # Multiprocessing workers: one session per worker (one process per session)
    from .workers import worker_entry, chunk_sessions, SESSIONS_PER_WORKER
    global _worker_result_queue, _worker_result_handler_task, _stats_flush_task
    if _worker_result_queue is None:
        _worker_result_queue = multiprocessing.Queue()
    if _worker_result_handler_task is None or _worker_result_handler_task.done():
        _worker_result_handler_task = asyncio.create_task(_worker_result_handler_async())
    if _stats_flush_task is None or _stats_flush_task.done():
        _stats_flush_task = asyncio.create_task(_stats_flush_loop())
    global _health_check_bg_task
    if not hasattr(_apply_worker_result, '_hc_started'):
        _health_check_bg_task = asyncio.create_task(_health_check_background_loop())
        _apply_worker_result._hc_started = True
    if update_status:
        try:
            await update_status("Checking sessions...")
            await asyncio.sleep(0.2)
        except Exception as e:
            logger.debug("Status update failed: %s", e)
    chunks = chunk_sessions(valid_sessions, per_worker=SESSIONS_PER_WORKER)
    # Deterministic zero-drift: set cycle anchor when starting fresh so all workers share same boundary.
    if not preserve_cycle_time:
        _save_bot_config(bot_token, lambda c: c.update({"cycle_anchor_ts": time.time()}))
        cfg = _get_cfg(bot_token) or cfg
    config_snapshot = _build_worker_config_snapshot(
        cfg, len(valid_sessions), run_first_cycle_immediately=not preserve_cycle_time, bot_token=bot_token
    )
    # Diagnostic: log sessions per worker and groups per session (before workers start)
    for worker_id, session_chunk in enumerate(chunks):
        session_files = [s.get("file") or "(no file)" for s in session_chunk]
        logger.info(
            "[posting] bot=%s worker_id=%s sessions_assigned=%s",
            cfg.get("name") or bot_token[:20], worker_id, session_files,
        )
    total_sessions = len(valid_sessions)
    total_targets = 0
    for worker_id, session_chunk in enumerate(chunks):
        for local_ord, s in enumerate(session_chunk):
            session_file = s.get("file") or ""
            if not session_file:
                logger.warning("[posting] bot=%s worker_id=%s session skipped (empty file) dict=%s", cfg.get("name") or bot_token[:20], worker_id, list(s.keys()))
                continue
            global_ordinal = worker_id * SESSIONS_PER_WORKER + local_ord
            groups_for_session, total_groups = _assigned_groups_for_session(bot_token, cfg, session_file, global_ordinal, total_sessions)
            total_targets += len(groups_for_session)
            logger.info(
                "[posting] bot=%s worker_id=%s session=%s global_ordinal=%s groups_count=%s total_groups=%s",
                cfg.get("name") or bot_token[:20], worker_id, session_file, global_ordinal, len(groups_for_session), total_groups,
            )
            if len(groups_for_session) == 0:
                logger.warning(
                    "[posting] session assigned ZERO groups: bot=%s worker_id=%s session=%s (group_file=%s mode=%s); session will run but never post",
                    cfg.get("name") or bot_token[:20], worker_id, session_file, cfg.get("group_file"), get_plan_mode(cfg),
                )
    if update_status:
        try:
            await update_status("Assigning groups...")
            await asyncio.sleep(0.2)
        except Exception as e:
            logger.debug("Status update failed: %s", e)
    workers_list: list[tuple[multiprocessing.Process, multiprocessing.Queue, int, list[dict]]] = []
    try:
        for worker_id, session_chunk in enumerate(chunks):
            cmd_queue: multiprocessing.Queue = multiprocessing.Queue()
            proc = multiprocessing.Process(
                target=worker_entry,
                args=(bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, _worker_result_queue),
            )
            proc.start()
            workers_list.append((proc, cmd_queue, worker_id, session_chunk))
            session_file = (session_chunk[0].get("file") or "session") if session_chunk else "session"
            logger.info("Worker started for session %s", session_file if session_file.endswith(".session") else session_file + ".session")
    except Exception as e:
        # B1: Worker process failed to start (e.g. OOM, fork error). Stop any already-started workers.
        logger.exception("Worker failed to start for bot %s: %s; stopping already-started workers", cfg.get("name", bot_token[:20]), e)
        for item in workers_list:
            try:
                item[1].put({"cmd": "stop"})
            except Exception:
                pass
        await asyncio.to_thread(_join_workers_sync, workers_list, join_timeout=15)
        _save_bot_config(bot_token, lambda c: c.update({"state": "stopped"}))
        add_admin_alert(
            "worker_start_failed",
            f"AdBot {cfg.get('name') or bot_token[:20]} — worker failed to start: {str(e)[:150]}. Check logs.",
        )
        return False
    _worker_handles[bot_token] = workers_list
    _worker_last_activity.setdefault(bot_token, {})
    if update_status:
        try:
            await update_status("Starting workers...")
            await asyncio.sleep(0.2)
        except Exception as e:
            logger.debug("Status update failed: %s", e)
    now = time.time()
    total_sessions = len(valid_sessions)
    mode = get_plan_mode(cfg)
    for _proc, _cmd_q, w_id, sess_chunk in workers_list:
        sf = _session_file_from_chunk(sess_chunk)
        _session_worker_registry[(bot_token, sf)] = w_id
        key = (bot_token, sf)
        _worker_start_time[key] = now
        _worker_startup_grace_until[key] = now + WORKER_STARTUP_GRACE_SEC
        _worker_first_cycle_or_post.discard(key)
        # Same stagger as in workers.py so startup-failure check doesn't restart sessions still in delay
        global_ordinal = w_id  # 1 session per worker
        if mode == "Enterprise":
            half = max(1, total_sessions) // 2
            stagger_sec = 0.0 if global_ordinal < half else float(ENTERPRISE_STAGGER_SEC)
        else:
            # Mirror workers.py: Starter applies the phase as a startup delay only on a fresh start
            # (first cycle runs immediately, bypassing the phased boundary). On a resume the boundary
            # spaces accounts, so no startup delay — avoids double-counting the offset.
            if not preserve_cycle_time:
                _start_cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
                stagger_sec = _starter_phase_offset(global_ordinal, total_sessions, _start_cycle_sec)
            else:
                stagger_sec = 0.0
        _worker_stagger_sec[key] = stagger_sec
    # Send START to each worker so they begin posting (avoids connection storms; workers wait for this).
    for _proc, cmd_q, w_id, _chunk in workers_list:
        try:
            cmd_q.put({"cmd": "start"})
            logger.info("[posting] START sent to worker_id=%s bot=%s", w_id, cfg.get("name") or bot_token[:20])
        except Exception as ex:
            logger.warning("[posting] START failed for worker_id=%s bot=%s: %s", w_id, cfg.get("name") or bot_token[:20], ex)
    # Mark running and update UI with final success message (no theatrical steps)
    bot_runtime_state.setdefault(bot_token, {})["running"] = True
    bot_runtime_state[bot_token]["started_ts"] = time.time()
    logger.info("[AdBotLifecycle] STARTED bot=%s workers=%s", cfg.get("name") or bot_token[:20], len(workers_list))
    enqueue_log(bot_token, "AdBot started")
    mode = get_plan_mode(cfg)
    cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
    if mode == "Enterprise" and total_sessions > 1:
        half = max(1, total_sessions) // 2
        first_batch = half
        second_batch = total_sessions - half
        enqueue_log(
            bot_token,
            f"Enterprise: {first_batch} session(s) start now, {second_batch} session(s) start in {ENTERPRISE_STAGGER_SEC // 60} min.",
        )
    if update_status:
        try:
            await update_status(
                f"AdBot started successfully.\n"
                f"Sessions active: {len(valid_sessions)}\n"
                f"Mode: {mode}\n"
                f"Cycle: {cycle_sec}s"
            )
        except Exception as e:
            logger.debug("Activation status update failed: %s", e)
    logger.info(
        "Started posting for bot %s: %s worker(s) %s sessions execution_mode=%s cycle_sec=%s",
        cfg.get("name", bot_token[:20]), len(workers_list), len(valid_sessions), mode, cycle_sec,
    )
    return bool(workers_list)


async def _stop_worker_cleanup_background(bot_token: str, workers_list: list, name: str = "") -> None:
    """Background task: join/terminate worker processes. Never blocks the control plane."""
    ts_start = time.time()
    logger.info("[audit] STOP worker cleanup began bot=%s workers=%d ts=%.0f", name or bot_token[:20], len(workers_list), ts_start)
    try:
        await asyncio.to_thread(_join_workers_sync, workers_list)
    except Exception as e:
        logger.exception("STOP worker cleanup error for bot %s: %s", bot_token[:20], e)
    finally:
        _pending_stop_cleanup.pop(bot_token, None)
    # Workers are now joined/terminated. Any surviving 'posting' lock on this bot's OWN
    # sessions is orphaned (crashed worker, or a reused PID that _pid_alive misreports),
    # so clear only those — never before this point, never another bot's sessions, and
    # never a live portal/chatlist holder (clear_posting_locks skips non-posting tasks).
    try:
        _scfg = _get_cfg(bot_token) or {}
        _sfiles = [s.get("file") or "" for s in _scfg.get("sessions", []) if s.get("file")]
        if _sfiles:
            _cleared = session_guard.clear_posting_locks(_sfiles)
            if _cleared:
                logger.info(
                    "[AdBotLifecycle] Cleared %s orphaned posting lock(s) after stop bot=%s: %s",
                    len(_cleared), name or bot_token[:20], _cleared,
                )
    except Exception as e:
        logger.warning("clear_posting_locks after stop failed for %s: %s", bot_token[:20], e)
    ts_end = time.time()
    enqueue_log(bot_token, "AdBot stopped")
    logger.info("[AdBotLifecycle] STOPPED bot=%s", name or bot_token[:20])
    logger.info("[audit] STOP worker cleanup finished bot=%s ts=%.0f duration_sec=%.1f", name or bot_token[:20], ts_end, ts_end - ts_start)


async def _stop_posting(bot_token: str) -> None:
    """Set state=stopped, send STOP to all workers, return immediately. Worker cleanup runs in background (non-blocking).
    CRITICAL: Must never block the asyncio event loop — proc.join() was causing 40s×N freeze of entire backend."""
    ts_start = time.time()
    name = ""
    data = load_adbot()
    cfg = data.get("bots", {}).get(bot_token)
    if cfg:
        name = cfg.get("name") or bot_token[:20]
    bot_runtime_state.setdefault(bot_token, {})["running"] = False
    logger.info("[AdBotLifecycle] STOP_REQUESTED bot=%s", name or bot_token[:20])
    logger.info("[audit] STOP started bot=%s ts=%.0f", name or bot_token[:20], ts_start)

    if cfg and cfg.get("state") == "dead":
        workers_list = _worker_handles.pop(bot_token, None)
        if workers_list:
            _clear_session_registry_for_bot(bot_token)
            for proc, cmd_q, *_ in workers_list:
                try:
                    cmd_q.put({"cmd": "stop"})
                except Exception:
                    pass
            t = asyncio.create_task(_stop_worker_cleanup_background(bot_token, workers_list, name))
            _pending_stop_cleanup[bot_token] = t
        existing = _posting_handles.pop(bot_token, None)
        _worker_last_activity.pop(bot_token, None)
        if existing:
            stop_ev, tasks, _ = existing
            stop_ev.set()
            if tasks:
                done, pending = await asyncio.wait(tasks, timeout=35, return_when=asyncio.ALL_COMPLETED)
                for t in pending:
                    t.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
        logger.info("[audit] STOP returned bot=%s ts=%.0f (dead branch)", name or bot_token[:20], time.time())
        return

    def _stop_upd(c):
        c["state"] = "stopped"
        c["excluded_sessions"] = []
        s = c.setdefault("stats", {})
        s.setdefault("last_stats_update", "")
        s["last_stats_update"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S") + "Z"
    _save_bot_config(bot_token, _stop_upd)
    workers_list = _worker_handles.pop(bot_token, None)
    if workers_list:
        _clear_session_registry_for_bot(bot_token)
        for k in list(_worker_last_heartbeat.keys()):
            if k[0] == bot_token:
                del _worker_last_heartbeat[k]
        for k in list(_worker_heartbeat_log_ts.keys()):
            if k[0] == bot_token:
                del _worker_heartbeat_log_ts[k]
        for proc, cmd_q, *_ in workers_list:
            try:
                cmd_q.put({"cmd": "stop"})
            except Exception:
                pass
        t = asyncio.create_task(_stop_worker_cleanup_background(bot_token, workers_list, name))
        _pending_stop_cleanup[bot_token] = t
    existing = _posting_handles.pop(bot_token, None)
    _worker_last_activity.pop(bot_token, None)
    _session_availability.pop(bot_token, None)
    _deferred_groups.pop(bot_token, None)
    if existing:
        stop_event, tasks, _ = existing
        stop_event.set()
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=35, return_when=asyncio.ALL_COMPLETED)
            for t in pending:
                t.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    logger.info("Stopped posting for bot %s", bot_token[:20])
    logger.info("[audit] STOP returned bot=%s ts=%.0f duration_sec=%.3f", name or bot_token[:20], time.time(), time.time() - ts_start)


def cleanup_stopped_bot_locks() -> int:
    """Startup recovery: clear orphaned 'posting' locks for bots whose PERSISTED state is
    not running/activating.

    Such bots will not be resumed, so a posting lock on their sessions is a leftover from a
    previous unclean exit (crash/kill) — otherwise it would keep the session permanently
    "busy" until the bot is next started. Running/activating bots are skipped: their resume
    path force-clears locks right before spawning fresh workers, so touching them here would
    race. Safe at startup because no posting worker exists yet in this fresh process. Returns
    the number of locks cleared."""
    from .utils import load_adbot
    cleared_total = 0
    try:
        data = load_adbot()
    except Exception as e:
        logger.warning("cleanup_stopped_bot_locks: could not load bots: %s", e)
        return 0
    for token, cfg in data.get("bots", {}).items():
        if (cfg.get("state") or "stopped") in ("running", "activating"):
            continue
        files = [s.get("file") or "" for s in cfg.get("sessions", []) if s.get("file")]
        if not files:
            continue
        try:
            cleared = session_guard.clear_posting_locks(files)
            cleared_total += len(cleared)
            if cleared:
                logger.info(
                    "[Startup] Cleared %s orphaned posting lock(s) for stopped bot=%s: %s",
                    len(cleared), cfg.get("name") or token[:20], cleared,
                )
        except Exception as e:
            logger.warning("cleanup_stopped_bot_locks failed for %s: %s", token[:20], e)
    return cleared_total


async def await_all_pending_stop_cleanup() -> None:
    """Await all pending STOP worker cleanup tasks. Call on shutdown before disconnecting clients."""
    tasks = list(_pending_stop_cleanup.values())
    if not tasks:
        return
    try:
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=55.0)
    except asyncio.TimeoutError:
        pass


def _ensure_web_token(bot_token: str) -> str:
    """Return the bot's web access code, generating and persisting one if missing.

    The mini app dashboard URL is built from this token, so every activated bot
    needs one for its menu button to work."""
    cfg = _get_cfg(bot_token) or {}
    wt = (cfg.get("web_token") or "").strip()
    if wt:
        return wt
    new_wt = "".join(random.choices(string.ascii_letters + string.digits, k=8))

    def _set(c: dict) -> None:
        if not (c.get("web_token") or "").strip():
            c["web_token"] = new_wt

    _save_bot_config(bot_token, _set)
    # Re-read in case another writer set one concurrently.
    return ((_get_cfg(bot_token) or {}).get("web_token") or new_wt).strip()


def _link_dashboard_miniapp(bot_token: str) -> None:
    """Ensure a web_token exists and point the bot's menu button at the dashboard.

    Fire-and-forget: schedules the Bot API call on the running loop so bot
    startup is never blocked by network latency."""
    try:
        web_token = _ensure_web_token(bot_token)
    except Exception as e:
        logger.debug("Mini app web_token ensure failed for %s…: %s", bot_token[:10], e)
        web_token = ((_get_cfg(bot_token) or {}).get("web_token") or "").strip()
    if not web_token:
        return
    from .miniapp import set_menu_button_webapp
    asyncio.create_task(set_menu_button_webapp(bot_token, web_token))


# Interval for the mini app self-healing sweep (every 24h).
MINIAPP_SWEEP_INTERVAL_SEC = 24 * 3600


async def run_miniapp_menu_button_sweep() -> None:
    """Every 24h, ensure every hosted bot's Telegram Mini App (dashboard menu
    button) is set to the correct URL.

    Startup already links each bot via create_user_bot; this catches bots that
    were created before the mini app existed, had their button cleared, or whose
    web_token was (re)generated. Idempotent and skipped entirely when no public
    HTTPS site is configured."""
    from .miniapp import dashboard_configured, set_menu_button_webapp

    await asyncio.sleep(300)  # let startup settle before the first sweep
    while True:
        try:
            if not dashboard_configured():
                # No public https URL → nothing the mini app can point at.
                await asyncio.sleep(MINIAPP_SWEEP_INTERVAL_SEC)
                continue
            tokens = list((load_adbot().get("bots") or {}).keys())
            linked = 0
            for token in tokens:
                try:
                    web_token = _ensure_web_token(token)
                    if web_token and await set_menu_button_webapp(token, web_token):
                        linked += 1
                except Exception as e:
                    logger.debug("Mini app sweep failed for %s…: %s", token[:10], e)
                await asyncio.sleep(1)  # gentle pacing to avoid Bot API rate limits
            if tokens:
                logger.info("Mini app sweep: %d/%d bot(s) linked to dashboard", linked, len(tokens))
        except Exception as e:
            logger.warning("Mini app sweep loop error: %s", e)
        await asyncio.sleep(MINIAPP_SWEEP_INTERVAL_SEC)


async def disconnect_and_remove_controller_bot(bot_token: str) -> None:
    """Disconnect the controller (user) bot for this token, remove from BOT_CLIENTS and PTB cache, unregister from shutdown,
    and delete its session file(s) so the same token can be reused without 'session already had an authorized user' or DB lock."""
    # Retire the mini app: remove the dashboard Web App button from this (now
    # abandoned) bot. Covers delete, expire, and the old bot on token replace.
    try:
        from .miniapp import reset_menu_button
        await reset_menu_button(bot_token)
    except Exception as e:
        logger.debug("Could not reset menu button for %s…: %s", bot_token[:10], e)
    client = BOT_CLIENTS.pop(bot_token, None)
    bot_ptb.remove_ptb_bot(bot_token)
    if client is not None:
        unregister_for_shutdown(client)
        try:
            await client.disconnect()
        except Exception:
            pass
    token_fingerprint = hashlib.sha256(bot_token.encode()).hexdigest()[:16]
    base = config.SESSIONS_DIR / "userbot" / f"bot_{token_fingerprint}"
    for p in (base.with_suffix(".session"), base.parent / (base.name + ".session-journal")):
        if p.is_file():
            try:
                p.unlink()
                logger.info("Removed controller session file: %s", p.name)
            except OSError as e:
                logger.warning("Could not delete controller session %s: %s", p, e)


def _workers_stalled(bot_token: str, assigned: int, cfg: dict | None = None) -> bool:
    """True if any worker task is not done but has no activity for longer than allowed.
    Uses max(STALLED_WORKER_SEC, cycle_sec) so normal between-cycle sleep is not treated as stalled."""
    h = _posting_handles.get(bot_token)
    if not h:
        return False
    if cfg is None:
        cfg = (load_adbot().get("bots", {}) or {}).get(bot_token) or {}
    cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
    stalled_threshold = max(STALLED_WORKER_SEC, cycle_sec)
    _, workers, session_files = h
    activity = _worker_last_activity.get(bot_token) or {}
    now = time.time()
    for w, sf in zip(workers or [], session_files or []):
        if w.done():
            continue
        if now - activity.get(sf, 0) > stalled_threshold:
            return True
    return False


async def run_session_health_monitor() -> None:
    """Background task: every SESSION_HEALTH_CHECK_INTERVAL, check running bots.

    Restart posting ONLY when a worker/task has actually crashed or died (alive < assigned).
    Inactivity alone must NOT trigger restart.

    A bot/session is NOT stalled (and must not be restarted) when:
      - it is sleeping between cycles (cycle sleep),
      - it is in FloodWait (sleeping or PAUSED),
      - it is marked PAUSED until unblock_time.
    So we never use timer-based 'stalled' detection for restart — only worker count.
    Result: bots stay running instead of being restarted repeatedly; restarts happen only when a worker actually died."""
    await asyncio.sleep(SESSION_HEALTH_CHECK_INTERVAL)  # delay first run
    last_sanity_sweep = time.time()
    while True:
        try:
            await asyncio.sleep(SESSION_HEALTH_CHECK_INTERVAL)
            now_ts = time.time()
            # Periodic sanity sweep: remove stale _active_posting_sessions entries whose session files
            # no longer exist on disk AND are not currently assigned to any live worker.
            if now_ts - last_sanity_sweep >= 300:
                last_sanity_sweep = now_ts
                stale_keys: list[str] = []
                # Build set of all active session files from live workers
                live_session_files: set[str] = set()
                for workers_list in _worker_handles.values():
                    for _proc, _cmd_q, _wid, session_chunk in workers_list:
                        for sf in session_chunk:
                            live_session_files.add(str(sf))
                for session_path in list(_active_posting_sessions):
                    try:
                        p = Path(session_path)
                    except TypeError:
                        continue
                    if p.exists():
                        continue
                    if session_path in live_session_files:
                        continue
                    stale_keys.append(session_path)
                for session_path in stale_keys:
                    _active_posting_sessions.discard(session_path)
                    logger.warning(
                        "[SessionSanity] Removed stale active session entry: %s",
                        session_path,
                    )
            data = load_adbot()
            for bot_token, cfg in data.get("bots", {}).items():
                if cfg.get("state") not in ("running", "activating"):
                    continue
                sessions = cfg.get("sessions", [])
                assigned = len(sessions)
                if assigned == 0:
                    continue
                workers_list = _worker_handles.get(bot_token)
                name = cfg.get("name") or bot_token[:20]
                # Heartbeat watchdog: detect frozen workers (alive PID, no heartbeat); restart only that worker
                restarted_frozen = False
                if workers_list:
                    cycle_sec = max(config.MIN_CYCLE_SEC, int(cfg.get("cycle", 3600)))
                    timeout_sec = max(HEARTBEAT_FROZEN_TIMEOUT_MIN, 2 * cycle_sec)
                    now = time.time()
                    for worker_id, (proc, cmd_q, _wid, session_chunk) in enumerate(workers_list):
                        if proc.is_alive():
                            session_file = _session_file_from_chunk(session_chunk)
                            key = (bot_token, session_file)
                            grace_until = _worker_startup_grace_until.get(key, 0)
                            if now < grace_until:
                                remaining = max(0, int(grace_until - now))
                                logger.info(
                                    "[WorkerStartup] session=%s grace_active=True remaining=%s",
                                    session_file, remaining,
                                )
                                continue
                            last_hb = _worker_last_heartbeat.get((bot_token, worker_id), 0)
                            if last_hb > 0 and (now - last_hb) > timeout_sec:
                                logger.warning(
                                    "[audit] WORKER_FROZEN bot=%s worker_id=%s session=%s timeout_sec=%.0f last_hb_ts=%.0f",
                                    name, worker_id, session_file, timeout_sec, last_hb,
                                )
                                try:
                                    ok = await _restart_single_worker(bot_token, worker_id)
                                    restarted_frozen = ok
                                    if not ok:
                                        username = (cfg.get("bot_username") or "")
                                        ts_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
                                        add_admin_alert(
                                            "worker_restart_failed",
                                            f"[WorkerRestart] BotUser=@{username or name} Session={session_file} Reason=crash Time={ts_str} — restart failed.",
                                        )
                                except Exception as e:
                                    logger.exception("Health monitor: failed to restart worker %s for %s: %s", worker_id, name, e)
                                    username = (cfg.get("bot_username") or "")
                                    ts_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
                                    add_admin_alert(
                                        "worker_restart_failed",
                                        f"[WorkerRestart] BotUser=@{username or name} Session={session_file} Reason=crash Time={ts_str} — {str(e)[:100]}",
                                    )
                                break  # restart one at a time per bot per cycle
                if restarted_frozen:
                    continue
                # Delayed failure recovery (Part 2): after grace + stagger, if no cycle/post for HEALTH_CHECK_DELAY_SEC log; after STARTUP_FAILURE_RESTART_AFTER_SEC restart.
                # Stagger: sessions wait 0..(N-1)*(STAGGER_WINDOW/N) sec before first cycle; don't treat that as startup failure.
                now = time.time()
                for key in list(_worker_start_time.keys()):
                    if key[0] != bot_token:
                        continue
                    session_file = key[1]
                    start_ts = _worker_start_time.get(key, 0)
                    grace_until = _worker_startup_grace_until.get(key, 0)
                    stagger_sec = _worker_stagger_sec.get(key, 0.0)
                    effective_start = start_ts + stagger_sec  # when we expect first cycle to begin
                    if now < grace_until or (bot_token, session_file) in _worker_first_cycle_or_post:
                        continue
                    # The worker scheduled a next_run that is still in the future (e.g. a crash-resume
                    # preserved a cycle anchor, so this session legitimately posts later). It is waiting,
                    # not stuck — don't diagnose or restart it as a startup failure, or it churns every
                    # cycle until that time arrives. A truly stuck worker never reports a next_run (no
                    # entry) and is still caught by the heartbeat/liveness checks above.
                    next_run = _worker_next_run.get((bot_token, session_file), 0.0)
                    if next_run > now:
                        continue
                    if now > effective_start + HEALTH_CHECK_DELAY_SEC:
                        logger.warning(
                            "[WorkerStartup] session=%s no_cycle_or_post after %.0fs (diagnosis)",
                            session_file, now - start_ts,
                        )
                    # Do not restart for "startup failure" when session is in FloodWait pause (would cause churn)
                    pause_until = (cfg.get("session_pause_until") or {}).get(session_file) or 0
                    if pause_until > now:
                        continue
                    if now > effective_start + STARTUP_FAILURE_RESTART_AFTER_SEC:
                        worker_id = _session_worker_registry.get(key)
                        if worker_id is not None and workers_list and 0 <= worker_id < len(workers_list):
                            username = (cfg.get("bot_username") or "")
                            ts_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
                            try:
                                ok = await _restart_single_worker(bot_token, worker_id)
                                if ok:
                                    add_admin_alert(
                                        "worker_restarted",
                                        f"[WorkerRestart] BotUser=@{username or name} Session={session_file} Reason=startup_failure Time={ts_str} — Worker auto-restarted after startup failure.",
                                    )
                            except Exception as e:
                                logger.exception("Startup failure restart error: %s", e)
                        break  # one restart per bot per cycle
                alive = _workers_alive(bot_token)
                # With multiprocessing: expected = number of worker processes; else = number of sessions (asyncio tasks)
                expected = len(workers_list) if workers_list else assigned
                # Do not restart if user stopped the bot (running cleared in _stop_posting)
                if not bot_runtime_state.get(bot_token, {}).get("running"):
                    continue
                # Do not restart when all workers are present (prevents continuous start loops)
                if alive == expected:
                    continue
                if alive < expected:
                    name = cfg.get("name") or bot_token[:20]
                    reason = f"only {alive}/{expected} workers active"
                    # When worker PIDs have dropped, some sessions may still be marked as active; clean them up so
                    # validation and reassignment are not blocked by stale _active_posting_sessions entries.
                    cleanup_active_sessions_for_bot(bot_token)
                    add_admin_alert(
                        "session_health",
                        f"AdBot {name} — {reason}. Restarting posting.",
                    )
                    logger.warning("Health monitor: bot %s %s; restarting posting", name, reason)
                    try:
                        await _start_posting(bot_token, preserve_cycle_time=True)
                    except Exception as e:
                        logger.exception("Health monitor: failed to restart posting for %s: %s", name, e)
                        add_admin_alert(
                            "session_health_restart_failed",
                            f"AdBot {name} — restart failed: {str(e)[:150]}",
                        )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("Session health monitor error: %s", e)


async def create_user_bot(bot_token: str) -> None:
    """Start Telethon client with bot_token; load config from per-user storage by bot_token.
    On /start: if user in authorized or universal admin → show menu [Run][Stop][Set Message][Status][Logs][Validity].
    Admin-only: /add <id>, /remove <id>, /subs <date>, /config, /stat.
    Posting: Run starts asyncio tasks per session; Stop awaits and cancels tasks.
    """
    cfg = _get_cfg(bot_token)
    if not cfg:
        logger.warning("create_user_bot: no config for token %s…", bot_token[:20])
        return
    # Stable unique path per token (sha256) so we never reuse another bot's session (avoids "session already had an authorized user" warning)
    token_fingerprint = hashlib.sha256(bot_token.encode()).hexdigest()[:16]
    session_path = str(config.SESSIONS_DIR / "userbot" / f"bot_{token_fingerprint}")
    (config.SESSIONS_DIR / "userbot").mkdir(parents=True, exist_ok=True)

    client = TelegramClient(
        session_path, config.API_ID, config.API_HASH, proxy=config.PROXY
    )
    register_for_shutdown(client)

    def get_cfg() -> dict:
        c = _get_cfg(bot_token)
        return c or {}

    def _expired_message() -> str:
        contact = getattr(config, "ADMIN_CONTACT", "admin")
        handle = f"@{contact}" if contact and not contact.startswith("@") else (contact or "@admin")
        return f"Subscription expired. Contact {handle}"

    @client.on(events.NewMessage(pattern=r"^/start\s*$"))
    async def on_start(event: events.NewMessage.Event) -> None:
        if is_maintenance_enabled():
            add_to_maintenance_queue(event.sender_id, event.chat_id)
            await event.reply(MAINTENANCE_MESSAGE)
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if _is_expired(cfg):
            _mark_bot_expired(bot_token)
            await event.reply(_expired_message(), buttons=_menu_buttons_expired())
            return
        log_bot_event(bot_token, f"User {event.sender_id} opened menu (/start)")
        _config_custom_state.setdefault(bot_token, {}).pop(event.sender_id, None)
        _config_custom_message_id.pop((bot_token, event.sender_id), None)
        await event.reply("**AdBot** — What would you like to do?", buttons=_menu_buttons(), parse_mode="md")

    def _fix_menu_buttons():
        return [
            [Button.inline("Fix Log Group", CB_FIX_LOG), Button.inline("Fix Sessions", CB_FIX_SESS)],
            [Button.inline("Fix Config", CB_FIX_CFG), Button.inline("Fix Bot Token", CB_FIX_TOK)],
            [Button.inline("Cancel", CB_FIX_CANCEL)],
        ]

    @client.on(events.NewMessage(pattern=r"^/fix\s*$"))
    async def cmd_fix(event: events.NewMessage.Event) -> None:
        if is_maintenance_enabled():
            add_to_maintenance_queue(event.sender_id, event.chat_id)
            await event.reply(MAINTENANCE_MESSAGE)
            return
        if not _is_admin(event.sender_id):
            await event.reply("This maintenance command is restricted to administrators.")
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if _is_expired(cfg):
            await event.reply(_expired_message(), buttons=_menu_buttons_expired())
            return
        log_bot_event(bot_token, f"Admin {event.sender_id} opened repair menu (/fix)")
        await event.reply("Repair menu:", buttons=_fix_menu_buttons())

    @client.on(events.CallbackQuery())
    async def on_callback(event: events.CallbackQuery.Event) -> None:
        if is_maintenance_enabled():
            add_to_maintenance_queue(event.sender_id, event.chat_id)
            await event.answer(MAINTENANCE_MESSAGE, alert=True)
            try:
                await event.edit(MAINTENANCE_MESSAGE)
            except Exception:
                await event.respond(MAINTENANCE_MESSAGE)
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            await event.answer("Not authorized.", alert=True)
            return
        if _is_expired(cfg):
            if event.data == CB_EXTEND:
                await event.answer()
                contact = getattr(config, "ADMIN_CONTACT", "admin")
                handle = f"@{contact}" if contact and not str(contact).startswith("@") else (contact or "@admin")
                try:
                    await event.edit(f"Contact {handle} to extend your subscription.", buttons=_menu_buttons_expired())
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Subscription expired.", alert=True)
                try:
                    await event.edit(_expired_message(), buttons=_menu_buttons_expired())
                except MessageNotModifiedError:
                    pass
            return
        raw = event.data
        if raw in (CB_AR_MENU, CB_AR_TOGGLE, CB_AR_EDIT, CB_AR_RECENT, CB_AR_BACK):
            await event.answer()
            if raw == CB_AR_BACK:
                try:
                    await event.edit("**AdBot** — What would you like to do?", buttons=_menu_buttons(), parse_mode="md")
                except MessageNotModifiedError:
                    pass
                return
            if raw == CB_AR_TOGGLE:
                def _upd(c):
                    ar = dict(c.get("dm_autoreply") or {})
                    ar["enabled"] = not bool(ar.get("enabled", True))
                    ar.setdefault("message", "")
                    c["dm_autoreply"] = ar
                _save_bot_config(bot_token, _upd)
            if raw == CB_AR_EDIT:
                _config_custom_state.setdefault(bot_token, {})[event.sender_id] = "autoreply_msg"
                _config_custom_message_id[(bot_token, event.sender_id)] = (event.chat_id, event.message.id)
                try:
                    await event.edit(
                        "Send the **auto-reply message** you want (max 500 chars). The HQAdz line is "
                        "always added automatically. Send `default` to use the default, or /start to cancel.",
                        parse_mode="md", buttons=[[Button.inline("‹ Back", CB_AR_MENU)]],
                    )
                except MessageNotModifiedError:
                    pass
                return
            if raw == CB_AR_RECENT:
                try:
                    name = get_name_by_token(bot_token) or ""
                    items = list(reversed(dm_inbox.load_inbox(name)))[:10] if name else []
                except Exception:
                    items = []
                if not items:
                    body = "**Recent DMs** — nothing yet."
                else:
                    lines = ["**Recent DMs received:**", ""]
                    for it in items:
                        who = it.get("sender_name") or "Unknown"
                        if it.get("sender_username"):
                            who += f" @{it['sender_username']}"
                        what = f"[{it['media_type']}] {it.get('caption', '')}".strip() if it.get("media_type") else (it.get("text") or "")
                        lines.append(f"• {who}: {what[:120]}")
                    body = "\n".join(lines)
                try:
                    await event.edit(body, parse_mode="md", buttons=[[Button.inline("‹ Back", CB_AR_MENU)]])
                except MessageNotModifiedError:
                    pass
                return
            cfg = get_cfg()
            body, buttons = _autoreply_menu_text_and_buttons(cfg or {})
            try:
                await event.edit(body, parse_mode="md", buttons=buttons)
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_MENU:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Repair menu:", buttons=_fix_menu_buttons())
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_CANCEL:
            await event.answer()
            _fix_wait_token_state.pop(bot_token, None)
            try:
                await event.edit("Cancelled.", buttons=_menu_buttons())
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_LOG:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Fixing log group…")
            except MessageNotModifiedError:
                pass
            async def _log_progress(m: str):
                try:
                    await event.edit(m, buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except Exception:
                    pass
            msg = await repair_fix_log_group(bot_token, log_async=_log_progress)
            try:
                await event.edit(msg, buttons=[[Button.inline("Back", CB_FIX_BACK)]])
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_SESS:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Checking sessions…")
            except MessageNotModifiedError:
                pass
            result = await repair_fix_sessions(bot_token)
            if "error" in result:
                try:
                    await event.edit(result["error"], buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            statuses = result.get("sessions", {})
            sfiles = list(statuses.keys())
            _fix_sess_data[bot_token] = {"statuses": statuses, "files": sfiles}
            rows = [[Button.inline(f"{fn} — {statuses.get(fn, '?')}", PREFIX_FIX_SESS + str(i).encode())] for i, fn in enumerate(sfiles)]
            rows.append([Button.inline("Back", CB_FIX_BACK)])
            try:
                await event.edit("Sessions (select to replace):", buttons=rows)
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_BACK:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Repair menu:", buttons=_fix_menu_buttons())
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_SESS_BACK:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Repair menu:", buttons=_fix_menu_buttons())
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_CFG:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            try:
                await event.edit("Fixing config…")
            except MessageNotModifiedError:
                pass
            msg = await repair_fix_config(bot_token)
            try:
                await event.edit(msg, buttons=[[Button.inline("Back", CB_FIX_BACK)]])
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_FIX_TOK:
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            await event.answer()
            _fix_wait_token_state[bot_token] = True
            try:
                await event.edit(
                    "Send the new bot token. This will deactivate the old controller bot and activate the new one.",
                    buttons=[[Button.inline("Cancel", CB_FIX_CANCEL)]],
                )
            except MessageNotModifiedError:
                pass
            return
        if raw and raw.startswith(PREFIX_FIX_SESS):
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            try:
                idx = int(raw[len(PREFIX_FIX_SESS):].decode())
            except (ValueError, UnicodeDecodeError):
                await event.answer()
                return
            await event.answer()
            data = _fix_sess_data.get(bot_token, {})
            sfiles = data.get("files", [])
            statuses = data.get("statuses", {})
            if idx < 0 or idx >= len(sfiles):
                try:
                    await event.edit("Invalid.", buttons=[[Button.inline("Back", CB_FIX_SESS_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            fn = sfiles[idx]
            status = statuses.get(fn, "UNKNOWN")
            _fix_sess_data[bot_token]["selected"] = (fn, status)
            try:
                await event.edit(
                    f"Session {fn} — {status}. Replace?",
                    buttons=[
                        [Button.inline("Replace", PREFIX_FIX_SESS_REP + str(idx).encode())],
                        [Button.inline("Back", CB_FIX_SESS_BACK)],
                    ],
                )
            except MessageNotModifiedError:
                pass
            return
        if raw and raw.startswith(PREFIX_FIX_SESS_REP):
            if not _is_admin(event.sender_id):
                await event.answer("Restricted to administrators.", alert=True)
                return
            try:
                idx = int(raw[len(PREFIX_FIX_SESS_REP):].decode())
            except (ValueError, UnicodeDecodeError):
                await event.answer()
                return
            await event.answer()
            data = _fix_sess_data.get(bot_token, {})
            sfiles = data.get("files", [])
            statuses = data.get("statuses", {})
            if idx < 0 or idx >= len(sfiles):
                try:
                    await event.edit("Invalid.", buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            fn = sfiles[idx]
            status = statuses.get(fn, "UNKNOWN")
            try:
                await event.edit("Replacing…")
            except MessageNotModifiedError:
                pass
            msg = await repair_replace_session(bot_token, fn, status)
            try:
                await event.edit(msg, buttons=[[Button.inline("Back", CB_FIX_BACK)]])
            except MessageNotModifiedError:
                pass
            return
        # ── Session Replacement Callbacks ──
        if raw == CB_REP_FREE:
            await event.answer()
            pending = get_pending_replacements_for_bot(bot_token)
            free_entries = [e for e in pending if e.get("free_replacement") and e.get("status") == "ready"]
            if not free_entries:
                try:
                    await event.edit("No free replacements available.", buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            try:
                await event.edit(f"Processing {len(free_entries)} free replacement(s)…")
            except MessageNotModifiedError:
                pass
            results = await process_ready_replacements()
            completed = [r for r in results if r.get("result") == "replaced"]
            queued = [r for r in results if r.get("result") == "queued_no_sessions"]
            lines = [f"✅ {len(completed)} session(s) replaced successfully."]
            for r in completed:
                lines.append(f"  • {r.get('real_name', '?')} → {r.get('new_session_file', '?')}")
            if queued:
                lines.append(f"\n⏳ {len(queued)} queued (no free sessions in pool).\nAdmin has been notified.")
            try:
                await event.edit("\n".join(lines), buttons=[[Button.inline("OK", CB_FIX_BACK)]])
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_REP_PAY:
            await event.answer()
            pending = get_pending_replacements_for_bot(bot_token)
            paid_entries = [e for e in pending if not e.get("free_replacement") and e.get("status") == "pending_payment"]
            if not paid_entries:
                try:
                    await event.edit("No paid replacements pending.", buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            from .shop.payment_constants import SUPPORTED_PAY_CURRENCIES
            crypto_buttons = []
            for code, label in [("USDT_TRC20", "USDT (TRC20)"), ("BTC", "Bitcoin"), ("LTC", "Litecoin"), ("ETH", "Ethereum")]:
                if code in SUPPORTED_PAY_CURRENCIES:
                    crypto_buttons.append([Button.inline(f"💰 {label}", PREFIX_REP_CRYPTO + code.encode())])
            crypto_buttons.append([Button.inline("Cancel", CB_REP_SKIP)])
            total = sum(float(e.get("price_usd", 0)) for e in paid_entries)
            try:
                await event.edit(
                    f"💳 <b>Session Replacement Payment</b>\n\n"
                    f"Sessions to replace: {len(paid_entries)}\n"
                    f"Total: <b>${total:.2f}</b>\n\n"
                    f"Select payment method:",
                    parse_mode="html",
                    buttons=crypto_buttons,
                )
            except MessageNotModifiedError:
                pass
            return
        if raw and raw.startswith(PREFIX_REP_CRYPTO):
            await event.answer()
            currency = raw[len(PREFIX_REP_CRYPTO):].decode("utf-8", errors="replace")
            pending = get_pending_replacements_for_bot(bot_token)
            paid_entries = [e for e in pending if not e.get("free_replacement") and e.get("status") == "pending_payment"]
            if not paid_entries:
                try:
                    await event.edit("No paid replacements pending.", buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return
            # ── Dev mode: auto-confirm payment and process immediately ──
            if getattr(config, "PAYMENT_DEV_MODE", False):
                from .replacement import mark_replacement_paid
                for e in paid_entries:
                    mark_replacement_paid(e["id"], payment_id=f"dev_{e['id']}")
                try:
                    await event.edit("🧪 <b>DEV MODE</b> — Payment auto-confirmed!\nProcessing replacements…", parse_mode="html")
                except MessageNotModifiedError:
                    pass
                results = await process_ready_replacements()
                completed = [r for r in results if r.get("result") == "replaced"]
                queued = [r for r in results if r.get("result") == "queued_no_sessions"]
                lines = [f"✅ {len(completed)} replaced."]
                for r in completed:
                    lines.append(f"  • {r.get('real_name', '?')} → {r.get('new_session_file', '?')}")
                if queued:
                    lines.append(f"\n⏳ {len(queued)} queued — admin notified.")
                try:
                    await event.edit("\n".join(lines), buttons=[[Button.inline("OK", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
                return

            from .replacement import generate_replacement_invoice_data
            invoice_data = generate_replacement_invoice_data(paid_entries, currency=currency)
            if not invoice_data:
                try:
                    await event.edit("Failed to generate invoice. Try a different currency.", buttons=[[Button.inline("Back", CB_REP_PAY)]])
                except MessageNotModifiedError:
                    pass
                return
            inv = invoice_data["invoice"]
            pay_address = inv.get("pay_address", "")
            pay_amount = inv.get("pay_amount", 0)
            pay_currency = inv.get("pay_currency", currency).upper()
            total_usd = invoice_data["total_usd"]
            count = invoice_data["count"]
            text = (
                f"💳 <b>Session Replacement Invoice</b>\n\n"
                f"Sessions: {count}\n"
                f"Total: <b>${total_usd:.2f}</b>\n\n"
                f"Send exactly:\n"
                f"<code>{pay_amount} {pay_currency}</code>\n\n"
                f"To address:\n"
                f"<code>{pay_address}</code>\n\n"
                f"⏰ Valid for 12 hours.\n"
                f"Payment will be detected automatically."
            )
            try:
                await event.edit(text, parse_mode="html", buttons=[
                    [Button.inline("🔄 Check Payment", CB_REP_STATUS)],
                    [Button.inline("Cancel", CB_REP_SKIP)],
                ])
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_REP_STATUS:
            await event.answer("Checking payment…")
            pending = get_pending_replacements_for_bot(bot_token)
            paid_pending = [e for e in pending if e.get("status") == "pending_payment" and e.get("payment_id")]
            if not paid_pending:
                ready = [e for e in pending if e.get("status") == "ready"]
                if ready:
                    try:
                        await event.edit("✅ Payment confirmed! Processing replacements…")
                    except MessageNotModifiedError:
                        pass
                    results = await process_ready_replacements()
                    completed = [r for r in results if r.get("result") == "replaced"]
                    queued = [r for r in results if r.get("result") == "queued_no_sessions"]
                    lines = [f"✅ {len(completed)} replaced."]
                    for r in completed:
                        lines.append(f"  • {r.get('real_name', '?')} → {r.get('new_session_file', '?')}")
                    if queued:
                        lines.append(f"\n⏳ {len(queued)} queued — admin notified.")
                    try:
                        await event.edit("\n".join(lines), buttons=[[Button.inline("OK", CB_FIX_BACK)]])
                    except MessageNotModifiedError:
                        pass
                else:
                    try:
                        await event.edit("No pending payments found.", buttons=[[Button.inline("Back", CB_FIX_BACK)]])
                    except MessageNotModifiedError:
                        pass
                return
            entry_ids = [e["id"] for e in paid_pending]
            from .replacement import check_replacement_payment
            paid = check_replacement_payment(entry_ids)
            if paid:
                try:
                    await event.edit("✅ Payment confirmed! Processing replacements…")
                except MessageNotModifiedError:
                    pass
                results = await process_ready_replacements()
                completed = [r for r in results if r.get("result") == "replaced"]
                queued = [r for r in results if r.get("result") == "queued_no_sessions"]
                lines = [f"✅ {len(completed)} replaced."]
                for r in completed:
                    lines.append(f"  • {r.get('real_name', '?')} → {r.get('new_session_file', '?')}")
                if queued:
                    lines.append(f"\n⏳ {len(queued)} queued — admin notified.")
                try:
                    await event.edit("\n".join(lines), buttons=[[Button.inline("OK", CB_FIX_BACK)]])
                except MessageNotModifiedError:
                    pass
            else:
                try:
                    await event.edit(
                        "⏳ Payment not yet detected. Please wait and try again.",
                        buttons=[
                            [Button.inline("🔄 Check Again", CB_REP_STATUS)],
                            [Button.inline("Cancel", CB_REP_SKIP)],
                        ],
                    )
                except MessageNotModifiedError:
                    pass
            return
        if raw == CB_REP_SKIP:
            await event.answer()
            from .replacement import cancel_replacement
            pending = get_pending_replacements_for_bot(bot_token)
            for e in pending:
                if e.get("status") in ("pending_payment",):
                    cancel_replacement(e["id"])
            try:
                await event.edit(
                    "⚠️ Replacement skipped. Some sessions may not work in assigned groups.\n"
                    "You can replace them later via the /fix menu.",
                    buttons=[[Button.inline("OK", CB_FIX_BACK)]],
                )
            except MessageNotModifiedError:
                pass
            return
        if raw == CB_RUN:
            await event.answer()
            uid = event.sender_id
            if cfg.get("suspended"):
                try:
                    await event.edit("Bot is suspended by admin. Contact support.", buttons=_menu_buttons())
                except MessageNotModifiedError:
                    pass
                return
            # Require at least one post link or custom text before Run.
            links = _get_post_links_list(cfg)
            msg_text = (cfg.get("message_text") or "").strip()
            if not links and not msg_text:
                fmt_note = (
                    "If you use **custom text**, it will be posted in groups exactly as you type it (plain text, no markdown)."
                )
                try:
                    text, entities = build_panel_message(
                        "panel_start",
                        "Set a message before running.\n\n"
                        "• Add at least one **post link** (to forward a message), or\n"
                        "• Set **custom text** (to send as a new message in each group).\n\n"
                        f"{fmt_note}\n\n"
                        "Use **Set Message** below to add a post link or custom text.",
                    )
                    await event.edit(
                        text,
                        formatting_entities=entities,
                        buttons=[[panel_button("Set Message", CB_SET_MSG, "panel_message")]] + _menu_buttons(),
                    )
                except MessageNotModifiedError:
                    pass
                return
            try:
                _activation_message[bot_token] = (event.chat_id, event.message_id)
                client = event.client
                chat_id, msg_id = event.chat_id, event.message_id

                async def _edit_status(text: str) -> None:
                    show_buttons = "started successfully" in text.lower()
                    try:
                        await client.edit_message(
                            chat_id, msg_id, text,
                            buttons=_menu_buttons() if show_buttons else None,
                        )
                    except Exception:
                        pass

                started = await _start_posting(bot_token, update_status=_edit_status)
                if not started:
                    _activation_message.pop(bot_token, None)
                    reason = _last_start_failure_reason.pop(bot_token, None)
                    if reason == "already_running":
                        msg = "AdBot is already running."
                        log_bot_event(bot_token, f"User {uid} Run: already running")
                    elif reason == "no_groups":
                        msg = "No groups assigned to your sessions. Add a group list in Config and assign groups."
                        log_bot_event(bot_token, f"User {uid} Run failed: no groups assigned to sessions")
                    elif reason == "no_valid_sessions":
                        msg = "No valid sessions (check session files exist and are not excluded)."
                        log_bot_event(bot_token, f"User {uid} Run failed: no valid sessions")
                    elif reason == "no_sessions":
                        msg = "No sessions to run. Assign a session in Config."
                        log_bot_event(bot_token, f"User {uid} Run failed: no sessions configured")
                    else:
                        msg = "No sessions to run."
                        log_bot_event(bot_token, f"User {uid} Run failed: no sessions to run")
                    try:
                        await event.edit(msg, buttons=_menu_buttons())
                    except MessageNotModifiedError:
                        pass
                    return
                log_bot_event(bot_token, f"User {uid} clicked Run — AdBot started")
            except Exception as e:
                _activation_message.pop(bot_token, None)
                log_bot_event(bot_token, f"User {uid} Run error: {str(e)[:200]}")
                try:
                    await event.edit(f"Run error: {str(e)[:100]}", buttons=_menu_buttons())
                except MessageNotModifiedError:
                    pass
            except Exception as e:
                log_bot_event(bot_token, f"User {uid} Run error: {str(e)[:200]}")
                try:
                    await event.edit(f"Run error: {str(e)[:100]}", buttons=_menu_buttons())
                except MessageNotModifiedError:
                    pass
        elif raw == CB_STOP:
            await event.answer()
            log_bot_event(bot_token, f"User {event.sender_id} stopped posting")
            try:
                text, entities = build_panel_message("panel_stop", "Stopping AdBot…")
                await event.edit(text, formatting_entities=entities, buttons=None)
            except MessageNotModifiedError:
                pass
            await _stop_posting(bot_token)
            try:
                text, entities = build_panel_message("panel_stop", "AdBot stopped.")
                await event.edit(text, formatting_entities=entities, buttons=_menu_buttons())
            except MessageNotModifiedError:
                pass
        elif raw == CB_SET_MSG:
            await event.answer()
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (exactly as you type it, no markdown)."
            set_msg_buttons = [
                [
                    Button.inline("✓ Custom text" if mode == "text" else "Use custom text", CB_MSG_MODE_TEXT),
                    Button.inline("✓ Post link(s)" if mode == "link" else "Use post link(s)", CB_MSG_MODE_LINK),
                ],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                set_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_SET_MSG_TEXT_DEL)])
            set_msg_buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_message", f"Set message:\n\n{current}\n\n{fmt_note}")
                await event.edit(
                    text,
                    buttons=set_msg_buttons,
                    formatting_entities=entities,
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_SET_MSG_TEXT_DEL:
            await event.answer()
            def clear_text(c):
                c["message_text"] = ""
            _save_bot_config(bot_token, clear_text)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (exactly as you type it, no markdown)."
            set_msg_buttons = [
                [
                    Button.inline("✓ Custom text" if mode == "text" else "Use custom text", CB_MSG_MODE_TEXT),
                    Button.inline("✓ Post link(s)" if mode == "link" else "Use post link(s)", CB_MSG_MODE_LINK),
                ],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                set_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_SET_MSG_TEXT_DEL)])
            set_msg_buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_message", f"Set message:\n\nCustom text deleted.\n\n{current}\n\n{fmt_note}")
                await event.edit(text, buttons=set_msg_buttons, formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_MSG_MODE_TEXT:
            await event.answer()
            def set_mode_text(c):
                c["message_mode"] = "text"
            _save_bot_config(bot_token, set_mode_text)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (exactly as you type it, no markdown)."
            set_msg_buttons = [
                [Button.inline("✓ Custom text", CB_MSG_MODE_TEXT), Button.inline("Use post link(s)", CB_MSG_MODE_LINK)],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                set_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_SET_MSG_TEXT_DEL)])
            set_msg_buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_message", f"Set message:\n\nNow using **Custom text**.\n\n{current}\n\n{fmt_note}")
                await event.edit(text, buttons=set_msg_buttons, formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_MSG_MODE_LINK:
            await event.answer()
            def set_mode_link(c):
                c["message_mode"] = "link"
            _save_bot_config(bot_token, set_mode_link)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (exactly as you type it, no markdown)."
            set_msg_buttons = [
                [Button.inline("Use custom text", CB_MSG_MODE_TEXT), Button.inline("✓ Post link(s)", CB_MSG_MODE_LINK)],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                set_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_SET_MSG_TEXT_DEL)])
            set_msg_buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_message", f"Set message:\n\nNow using **Post link(s)**.\n\n{current}\n\n{fmt_note}")
                await event.edit(text, buttons=set_msg_buttons, formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_SET_MSG_TEXT:
            await event.answer("Send your custom message text.")
            _set_message_state.setdefault(bot_token, {})[event.sender_id] = "text"
            try:
                await event.edit("Waiting for your **custom text**…", buttons=_menu_buttons(), parse_mode="md")
            except MessageNotModifiedError:
                pass
        elif raw == CB_SET_MSG_LINKS_MANAGE:
            await event.answer()
            links = _get_post_links_list(cfg)
            lines = ["**Post links** (forward)\n"]
            if not links:
                lines.append("_No links. Add one to forward messages._")
            else:
                for i, u in enumerate(links, 1):
                    show = (u[:55] + "…") if len(u) > 55 else u
                    lines.append(f"{i}. `{show}`")
            buttons = [[Button.inline("➕ Add link", CB_SET_MSG_LINK)]]
            for i in range(len(links)):
                buttons.append([Button.inline(f"Remove #{i + 1}", PREFIX_PL_DEL + str(i).encode())])
            buttons.append([Button.inline("‹ Back to Set message", CB_SET_MSG)])
            try:
                await event.edit("\n".join(lines), parse_mode="md", buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw.startswith(PREFIX_PL_DEL):
            await event.answer()
            try:
                idx = int(raw[len(PREFIX_PL_DEL):].decode("utf-8", errors="replace").strip())
            except (ValueError, TypeError):
                await event.answer("Invalid.", alert=True)
                return
            links = _get_post_links_list(cfg)
            if 0 <= idx < len(links):
                def remove_link(c):
                    pl = list(c.get("post_links") or ([(c.get("post_link") or "")] if c.get("post_link") else []))
                    if idx < len(pl):
                        pl.pop(idx)
                    c["post_links"] = pl
                    if "post_link" in c:
                        c["post_link"] = pl[0] if pl else ""
                _save_bot_config(bot_token, remove_link)
                cfg = get_cfg() or {}
                links = _get_post_links_list(cfg)
                lines = ["**Post links** (forward)\n"]
                if not links:
                    lines.append("_No links. Add one to forward messages._")
                else:
                    for i, u in enumerate(links, 1):
                        show = (u[:55] + "…") if len(u) > 55 else u
                        lines.append(f"{i}. `{show}`")
                buttons = [[Button.inline("➕ Add link", CB_SET_MSG_LINK)]]
                for i in range(len(links)):
                    buttons.append([Button.inline(f"Remove #{i + 1}", PREFIX_PL_DEL + str(i).encode())])
                buttons.append([Button.inline("‹ Back to Set message", CB_SET_MSG)])
                try:
                    await event.edit("\n".join(lines), parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Link not found.", alert=True)
        elif raw == CB_SET_MSG_LINK:
            await event.answer("Send a t.me link to add (e.g. t.me/c/123/456 or t.me/channel/123).")
            _set_message_state.setdefault(bot_token, {})[event.sender_id] = "link"
            try:
                await event.edit("Waiting for **post link** (t.me/…) to add…", buttons=_menu_buttons(), parse_mode="md")
            except MessageNotModifiedError:
                pass
        elif raw == b"back":
            await event.answer()
            try:
                await event.edit("**AdBot** — What would you like to do?", buttons=_menu_buttons(), parse_mode="md")
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATUS or raw == CB_STATUS_REFRESH:
            await event.answer()
            s = cfg.get("state", "stopped")
            alive = _workers_alive(bot_token)
            sessions = cfg.get("sessions", [])
            n = len(sessions)
            mode = cfg.get("mode", "Starter")
            # Cycle info
            last_cycle = cfg.get("last_cycle_time") or {}
            interval = int(cfg.get("cycle_interval", 60))
            # FloodWait paused sessions
            paused_map = cfg.get("session_pause_until") or {}
            now_ts = time.time()
            paused_count = sum(1 for v in paused_map.values() if float(v or 0) > now_ts)
            # Next cycle ETA
            next_eta = ""
            if last_cycle and s == "running":
                last_ts = max(last_cycle.values()) if last_cycle else 0
                if last_ts:
                    next_at = last_ts + interval * 60
                    remaining = int(next_at - now_ts)
                    if remaining > 0:
                        mins, secs = divmod(remaining, 60)
                        next_eta = f"{mins}m {secs}s"
                    else:
                        next_eta = "now"
            lines = [
                f"**Status:** {s}",
                f"**Mode:** {mode}",
                f"**Workers:** {alive} / {n}",
            ]
            if paused_count:
                lines.append(f"**⚠️ FloodWait paused:** {paused_count} session(s)")
            if next_eta:
                lines.append(f"**Next cycle:** ~{next_eta}")
            lines.append(f"**Interval:** {interval} min")
            status_buttons = [
                [Button.inline("🔄 Refresh", CB_STATUS_REFRESH)],
                [Button.inline("‹ Back", b"back")],
            ]
            try:
                await event.edit(
                    "\n".join(lines),
                    buttons=status_buttons,
                    parse_mode="md",
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_LOGS:
            await event.answer()
            log_group = _log_group_entity(cfg.get("log_group"))
            url = _log_group_link(log_group) if log_group else ""
            try:
                if url:
                    text, entities = build_panel_message("panel_logs", f"**Log Group:** [Open]({url})")
                else:
                    text, entities = build_panel_message("panel_logs", "Log group not set.")
                await event.edit(text, buttons=[[Button.inline("‹ Back", b"back")]], formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_VALIDITY:
            await event.answer()
            vt = cfg.get("valid_till", "")
            days = _validity_days_left(vt)
            try:
                text, entities = build_panel_message("panel_validity", f"**Validity:** {days}")
                await event.edit(text, buttons=[[Button.inline("‹ Back", b"back")]], formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_CHATLIST:
            await event.answer()
            from .chatlist import get_chatlist_config, load_custom_groups, MAX_CHATLIST_LINKS, MAX_GROUPS_PER_CHATLIST
            cl = get_chatlist_config(cfg)
            lines = []
            lines.append("**Group Select — Custom Chatlist**\n")
            if cl["active"] and cl["links"]:
                for i, link in enumerate(cl["links"]):
                    lines.append(f"**Folder {i+1}:** `{link}`")
                custom_groups = load_custom_groups(cfg.get("name", ""))
                lines.append(f"**Groups loaded:** {len(custom_groups)}")
                lines.append(f"**Group file:** `{cfg.get('group_file', '')}`")
            else:
                lines.append("No custom chatlist active. Using default group file.")
                lines.append(f"**Current file:** `{cfg.get('group_file', 'Starter.txt')}`")
            lines.append(f"\n**Limits:** Max {MAX_CHATLIST_LINKS} chatlist links, max {MAX_GROUPS_PER_CHATLIST} groups each.")
            mode = cfg.get("mode", "Starter")
            if mode == "Starter":
                lines.append("**Starter mode:** Max 80 groups used for posting.")
            else:
                lines.append("**Enterprise mode:** All groups used, sharded across sessions.")
            buttons = []
            if cl["active"]:
                buttons.append([Button.inline("📋 View Groups", CB_CHATLIST_VIEW)])
                buttons.append([Button.inline("➕ Change Chatlist", CB_CHATLIST_ADD)])
                buttons.append([Button.inline("📤 Upload Edited File", CB_CHATLIST_UPLOAD)])
                buttons.append([Button.inline("🔄 Revert to Default", CB_CHATLIST_REVERT)])
            else:
                buttons.append([Button.inline("➕ Add Chatlist", CB_CHATLIST_ADD)])
                buttons.append([Button.inline("📤 Upload Group File", CB_CHATLIST_UPLOAD)])
            buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_groups", "\n".join(lines))
                await event.edit(text, buttons=buttons, formatting_entities=entities)
            except MessageNotModifiedError:
                pass
        elif raw == CB_CHATLIST_ADD:
            await event.answer()
            _chatlist_input_state.setdefault(bot_token, set()).add(event.sender_id)
            try:
                await event.edit(
                    "**Send chatlist link(s)**\n\n"
                    "Send 1 or 2 Telegram chatlist links (t.me/addlist/...).\n"
                    "Send them in a **single message**, one per line.\n\n"
                    "Example:\n`https://t.me/addlist/JC_cD1R7ibYwZmI0`\n\n"
                    "⚠️ Current chatlist will be replaced.\n"
                    "Max 100 groups per link. Starter: max 80 total.",
                    buttons=[[Button.inline("Cancel", b"back")]],
                    parse_mode="md",
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_CHATLIST_VIEW:
            await event.answer()
            from .chatlist import load_custom_groups
            custom = load_custom_groups(cfg.get("name", ""))
            if not custom:
                try:
                    await event.edit("No custom groups loaded.", buttons=[[Button.inline("‹ Back", CB_CHATLIST)]])
                except MessageNotModifiedError:
                    pass
            else:
                preview = custom[:30]
                text = "**Custom Groups** (first 30):\n\n```\n" + "\n".join(preview) + "\n```"
                if len(custom) > 30:
                    text += f"\n... and {len(custom) - 30} more."
                text += f"\n\n**Total: {len(custom)} groups**"
                try:
                    await event.edit(text, buttons=[[Button.inline("‹ Back", CB_CHATLIST)]], parse_mode="md")
                except MessageNotModifiedError:
                    pass
        elif raw == CB_CHATLIST_REMOVE:
            await event.answer()
            from .chatlist import clear_chatlist_config, default_group_file_for_mode
            mode = cfg.get("mode", "Starter")
            default_gf = default_group_file_for_mode(mode)
            clear_chatlist_config(cfg)
            _save_bot_config(bot_token, lambda c: c.update({"group_file": default_gf, "custom_chatlist": None}))
            try:
                await event.edit(f"Custom chatlist removed. Reverted to **{default_gf}**.", buttons=_menu_buttons(), parse_mode="md")
            except MessageNotModifiedError:
                pass
        elif raw == CB_CHATLIST_REVERT:
            await event.answer()
            from .chatlist import clear_chatlist_config, default_group_file_for_mode, default_chatlist_link_for_mode, join_default_chatlist_on_sessions
            mode = cfg.get("mode", "Starter")
            default_gf = default_group_file_for_mode(mode)
            clear_chatlist_config(cfg)
            _save_bot_config(bot_token, lambda c: c.update({"group_file": default_gf, "custom_chatlist": None}))
            default_link = default_chatlist_link_for_mode(mode)
            if default_link:
                try:
                    await event.edit(f"Reverting to **{default_gf}**...\nRejoining default chatlist on all sessions...", parse_mode="md")
                except MessageNotModifiedError:
                    pass
                fresh_cfg = _get_cfg(bot_token) or cfg
                joined, failed = await join_default_chatlist_on_sessions(fresh_cfg, mode)
                try:
                    await event.edit(
                        f"✅ Reverted to **{default_gf}**.\n"
                        f"Default chatlist rejoined: {joined} sessions OK, {failed} failed.",
                        buttons=_menu_buttons(), parse_mode="md",
                    )
                except MessageNotModifiedError:
                    pass
            else:
                try:
                    await event.edit(f"Reverted to default group file (**{default_gf}**).\nNo default chatlist configured — groups file used as-is.", buttons=_menu_buttons(), parse_mode="md")
                except MessageNotModifiedError:
                    pass
        elif raw == CB_CHATLIST_UPLOAD:
            await event.answer()
            _chatlist_upload_state.setdefault(bot_token, set()).add(event.sender_id)
            try:
                await event.edit(
                    "**Upload edited group file**\n\n"
                    "Send a `.txt` file with group IDs (one per line).\n"
                    "Format: `-1001234567890` or `-1001234567890 | 34` for forum topics.\n\n"
                    "This will replace the current custom group file.",
                    buttons=[[Button.inline("Cancel", b"back")]],
                    parse_mode="md",
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_MENU:
            await event.answer()
            msg, buttons = _stats_dashboard()
            buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_stats", msg)
                await event.edit(text, formatting_entities=entities, buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_REFRESH:
            await event.answer()
            msg, buttons = _stats_dashboard()
            buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_stats", msg)
                await event.edit(text, formatting_entities=entities, buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_BACK:
            await event.answer()
            msg, buttons = _stats_dashboard()
            buttons.append([Button.inline("‹ Back", b"back")])
            try:
                text, entities = build_panel_message("panel_stats", msg)
                await event.edit(text, formatting_entities=entities, buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_PER_SESSION:
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                return
            data = _get_stats_for_display(bot_token)
            sessions = cfg.get("sessions", [])
            session_stats = data.get("session_stats") or {}
            lines = ["**Per Session**\n"]
            buttons = []
            for i, s in enumerate(sessions):
                fn = (s.get("file") or "").strip() or "?"
                entry = session_stats.get(fn) or {}
                sent = int(entry.get("lifetime_sent", 0))
                failed = int(entry.get("lifetime_failed", 0))
                total = sent + failed
                pct = (sent / total * 100) if total else 0
                label = f"Account {i + 1}"
                lines.append(f"{label} → Sent: {sent} | Failed: {failed} | {pct:.0f}%")
                try:
                    buttons.append([Button.inline(label, PREFIX_STATS_SESSION + str(i).encode("utf-8"))])
                except Exception:
                    pass
            lines.append("")
            text = "\n".join(lines) if lines else "No sessions."
            back_btn = [Button.inline("‹ Back", CB_STATS_BACK)]
            try:
                await event.edit(text, parse_mode="md", buttons=buttons + [back_btn])
            except MessageNotModifiedError:
                pass
        elif raw.startswith(PREFIX_STATS_SESSION):
            await event.answer()
            try:
                idx_str = raw[len(PREFIX_STATS_SESSION):].decode("utf-8", errors="replace").strip()
                session_idx = int(idx_str)
            except (ValueError, TypeError):
                session_idx = -1
            cfg = get_cfg()
            if not cfg:
                return
            sessions = cfg.get("sessions", [])
            if not (0 <= session_idx < len(sessions)):
                return
            session_file = (sessions[session_idx].get("file") or "").strip()
            if not session_file:
                return
            data = _get_stats_for_display(bot_token)
            session_stats = data.get("session_stats") or {}
            entry = session_stats.get(session_file) or {}
            ls = int(entry.get("lifetime_sent", 0))
            lf = int(entry.get("lifetime_failed", 0))
            total_life = ls + lf
            rate_life = (ls / total_life * 100) if total_life else 0
            sent_24 = int(entry.get("last24h_sent", 0))
            failed_24 = int(entry.get("last24h_failed", 0))
            total_24 = sent_24 + failed_24
            rate_24 = (sent_24 / total_24 * 100) if total_24 else 0
            posts_per_hour = total_24 / 24.0
            display_name = session_file.split("/")[-1] if "/" in session_file else session_file
            text = (
                f"**Session: {display_name}**\n\n"
                "**LIFETIME**\n"
                f"Sent: {ls}\n"
                f"Failed: {lf}\n"
                f"Success %: {rate_life:.0f}%\n\n"
                "**LAST 24 HOURS**\n"
                f"Sent: {sent_24}\n"
                f"Failed: {failed_24}\n"
                f"Success %: {rate_24:.0f}%\n"
                f"Posts/hour: {posts_per_hour:.1f}\n"
            )
            try:
                await event.edit(text, parse_mode="md", buttons=[[Button.inline("‹ Back", CB_STATS_PER_SESSION)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_ANALYZE:
            await event.answer()
            data = _get_stats_for_display(bot_token)
            buckets = data.get("last24h_buckets") or []
            now = time.time()
            now_hour = int(now // 3600)
            cutoff_1h = now_hour - 1
            cutoff_6h = now_hour - 6
            count_60m = sum(b.get("sent", 0) + b.get("failed", 0) for b in buckets if (b.get("hour_ts") or 0) >= cutoff_1h)
            count_6h = sum(b.get("sent", 0) + b.get("failed", 0) for b in buckets if (b.get("hour_ts") or 0) >= cutoff_6h)
            count_24h = sum(b.get("sent", 0) + b.get("failed", 0) for b in buckets)
            avg_per_hour = count_24h / 24.0 if count_24h else 0.0
            by_hour: dict[int, int] = {}
            for b in buckets:
                h = b.get("hour_ts", 0)
                by_hour[h] = by_hour.get(h, 0) + b.get("sent", 0) + b.get("failed", 0)
            peak_hour = max(by_hour.items(), key=lambda x: x[1]) if by_hour else (0, 0)
            peak_ts = peak_hour[0] * 3600
            try:
                peak_str = datetime.fromtimestamp(peak_ts).strftime("%H:00") if peak_ts else "—"
            except (OSError, ValueError):
                peak_str = "—"
            current_bucket = next((b for b in buckets if b.get("hour_ts") == now_hour), None)
            current_bucket_total = (current_bucket.get("sent", 0) + current_bucket.get("failed", 0)) if current_bucket else 0
            elapsed_in_hour = now - (now_hour * 3600)
            current_rate = (current_bucket_total * 3600.0 / elapsed_in_hour) if elapsed_in_hour > 60 else 0.0
            text = (
                "**Analyze (last 24h)**\n\n"
                f"Posts last 60 min: {count_60m}\n"
                f"Posts last 6 hours: {count_6h}\n"
                f"Posts last 24 hours: {count_24h}\n"
                f"Peak posting hour: {peak_str} ({peak_hour[1]} posts)\n"
                f"Average posts/hour: {avg_per_hour:.1f}\n"
                f"Current rate (this hour → /hr): {current_rate:.0f}\n"
            )
            try:
                await event.edit(text, parse_mode="md", buttons=[[Button.inline("‹ Back", CB_STATS_BACK)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_RESET:
            await event.answer()
            text = "**Reset Stats**\n\nReset lifetime stats, all session stats, and clear last-24h events?\n\nCreated-at timestamp will be kept."
            try:
                await event.edit(
                    text,
                    parse_mode="md",
                    buttons=[
                        [Button.inline("Yes, Reset", CB_STATS_RESET_CONFIRM), Button.inline("Cancel", CB_STATS_BACK)],
                    ],
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_STATS_RESET_CONFIRM:
            await event.answer()
            name = get_name_by_token(bot_token)
            if name:
                st = load_stats(name) or _default_stats_data()
                created = st.get("created_at") or time.time()
                save_stats(name, {
                    "lifetime_sent": 0,
                    "lifetime_failed": 0,
                    "created_at": created,
                    "session_stats": {},
                    "last24h_buckets": [],
                })
            p = _stats_pending.get(bot_token)
            if p:
                p["pending_events"].clear()
                p["lifetime_sent_delta"] = 0
                p["lifetime_failed_delta"] = 0
                p["session_deltas"].clear()
            msg, buttons = _stats_dashboard()
            try:
                text, entities = build_panel_message("panel_stats", msg)
                await event.edit(text, formatting_entities=entities, buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw == CB_BACK_CONFIG:
            await event.answer()
            _config_custom_state.setdefault(bot_token, {}).pop(event.sender_id, None)
            _config_custom_message_id.pop((bot_token, event.sender_id), None)
            cfg = get_cfg()
            if cfg:
                text, buttons = _config_message_and_buttons(cfg, bot_token)
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                try:
                    await event.edit("Menu:", buttons=_menu_buttons())
                except MessageNotModifiedError:
                    pass
        elif raw == b"cfg_mode":
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            current = get_plan_mode(cfg)
            buttons = [
                [Button.inline("Starter" + (" ✓" if current == "Starter" else ""), PREFIX_MODE + b"starter"), Button.inline("Enterprise" + (" ✓" if current == "Enterprise" else ""), PREFIX_MODE + b"enterprise")],
                [Button.inline("‹ Back to Config", CB_BACK_CONFIG)],
            ]
            try:
                await event.edit("**Choose mode:**\n\n• **Starter** — All sessions post to all groups.\n• **Enterprise** — Sessions partition groups; per-session cap.", parse_mode="md", buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw == b"cfg_group":
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            files = _list_group_files()
            if not files:
                try:
                    await event.edit("No `.txt` files in **groups/** folder. Add a file and try again.", parse_mode="md", buttons=[[Button.inline("‹ Back to Config", CB_BACK_CONFIG)]])
                except MessageNotModifiedError:
                    pass
                return
            current = (cfg.get("group_file") or "").strip()
            rows = []
            for i in range(0, len(files), 2):
                row = [Button.inline(fn + (" ✓" if fn == current else ""), PREFIX_GROUP + fn.encode("utf-8")) for fn in files[i : i + 2]]
                rows.append(row)
            rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit("**Choose group file:**\n\nSelect a file from **groups/** folder. Current selection is marked ✓.", parse_mode="md", buttons=rows)
            except MessageNotModifiedError:
                pass
        elif raw == b"cfg_cycle":
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            presets = [(300, "5 min"), (900, "15 min"), (1800, "30 min"), (3600, "1 hr"), (7200, "2 hr")]
            current = int(cfg.get("cycle", 3600))
            rows = [[Button.inline(label + (" ✓" if sec == current else ""), PREFIX_CYCLE + str(sec).encode())] for sec, label in presets]
            rows.append([Button.inline("Custom", CB_CYCLE_CUSTOM)])
            rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit(f"**Choose cycle interval:**\n\nTime between posting rounds per session. Min {config.MIN_CYCLE_SEC} sec.", parse_mode="md", buttons=rows)
            except MessageNotModifiedError:
                pass
        elif raw == b"cfg_gap":
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            presets = [(4, "4 sec"), (5, "5 sec"), (6, "6 sec")]
            current = int(cfg.get("gap", 5))
            rows = [[Button.inline(label + (" ✓" if sec == current else ""), PREFIX_GAP + str(sec).encode())] for sec, label in presets]
            rows.append([Button.inline("Custom", CB_GAP_CUSTOM)])
            rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit("**Choose gap between posts:**\n\nDelay between each post in a cycle (anti-ban: 4–6 sec).", parse_mode="md", buttons=rows)
            except MessageNotModifiedError:
                pass
        elif raw == CB_CYCLE_CUSTOM:
            await event.answer()
            _config_custom_state.setdefault(bot_token, {})[event.sender_id] = "cycle"
            _config_custom_message_id[(bot_token, event.sender_id)] = (event.chat_id, event.message.id)
            try:
                await event.edit(f"Send **cycle in seconds** (min {config.MIN_CYCLE_SEC}). Or /start to cancel.", parse_mode="md", buttons=[[Button.inline("‹ Back to Config", CB_BACK_CONFIG)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_GAP_CUSTOM:
            await event.answer()
            _config_custom_state.setdefault(bot_token, {})[event.sender_id] = "gap"
            _config_custom_message_id[(bot_token, event.sender_id)] = (event.chat_id, event.message.id)
            try:
                await event.edit("Send **gap in seconds** (e.g. 4 or 5). Or /start to cancel.", parse_mode="md", buttons=[[Button.inline("‹ Back to Config", CB_BACK_CONFIG)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_RENEWAL:
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            renewal = cfg.get("renewal_price") or "0"
            try:
                rn = float(str(renewal).replace(",", ".").strip())
                current_display = f"${rn:.2f}"
            except (ValueError, TypeError):
                current_display = str(renewal) if renewal else "$0"
            rows = [
                [Button.inline("$1", PREFIX_RENEWAL + b"1"), Button.inline("$3", PREFIX_RENEWAL + b"3"), Button.inline("$5", PREFIX_RENEWAL + b"5")],
                [Button.inline("Custom", CB_CFG_RENEWAL_CUSTOM)],
                [Button.inline("‹ Back to Config", CB_BACK_CONFIG)],
            ]
            try:
                await event.edit(f"**Renewal price**\n\nCurrent: {current_display}\n\nChoose new price:", parse_mode="md", buttons=rows)
            except MessageNotModifiedError:
                pass
        elif raw.startswith(PREFIX_RENEWAL):
            await event.answer()
            val = raw[len(PREFIX_RENEWAL):].decode("utf-8", errors="replace").strip()
            if val == "custom":
                return
            try:
                price = float(val.replace(",", "."))
                if price < 0:
                    await event.answer("Price must be non-negative.", alert=True)
                    return
            except ValueError:
                await event.answer("Invalid value.", alert=True)
                return
            def upd(c):
                c["renewal_price"] = str(price)
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Renewal price set to **${price:.2f}**.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        elif raw == CB_CFG_RENEWAL_CUSTOM:
            await event.answer()
            _config_custom_state.setdefault(bot_token, {})[event.sender_id] = "renewal_price"
            _config_custom_message_id[(bot_token, event.sender_id)] = (event.chat_id, event.message.id)
            try:
                await event.edit("Send new **price** (number, e.g. 5 or 10.50). Or /start to cancel.", parse_mode="md", buttons=[[Button.inline("‹ Back to Config", CB_BACK_CONFIG)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_VALID_TILL:
            await event.answer()
            cfg = get_cfg()
            if not cfg:
                await event.answer("Config not found.", alert=True)
                return
            current_vt = (cfg.get("valid_till") or "").strip() or "—"
            rows = [
                [Button.inline("+7 days", PREFIX_VALID_TILL + b"7"), Button.inline("+30 days", PREFIX_VALID_TILL + b"30")],
                [Button.inline("Custom (dd/mm/yyyy)", CB_CFG_VALID_TILL_CUSTOM)],
                [Button.inline("‹ Back to Config", CB_BACK_CONFIG)],
            ]
            try:
                await event.edit(f"**Valid till**\n\nCurrent: {current_vt}\n\nExtend or set date:", parse_mode="md", buttons=rows)
            except MessageNotModifiedError:
                pass
        elif raw.startswith(PREFIX_VALID_TILL):
            await event.answer()
            val = raw[len(PREFIX_VALID_TILL):].decode("utf-8", errors="replace").strip()
            try:
                add_days = int(val)
            except ValueError:
                return
            if add_days < 0:
                await event.answer("Invalid.", alert=True)
                return
            from datetime import timedelta
            base = datetime.now()
            vt = (cfg.get("valid_till") or "").strip()
            if vt:
                try:
                    base = datetime.strptime(vt, "%d/%m/%Y")
                except ValueError:
                    pass
            new_dt = base + timedelta(days=add_days)
            date_str = new_dt.strftime("%d/%m/%Y")
            def upd(c):
                c["valid_till"] = date_str
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Valid till set to **{date_str}**.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        elif raw == CB_CFG_VALID_TILL_CUSTOM:
            await event.answer()
            _config_custom_state.setdefault(bot_token, {})[event.sender_id] = "valid_till"
            _config_custom_message_id[(bot_token, event.sender_id)] = (event.chat_id, event.message.id)
            try:
                await event.edit("Send date in **dd/mm/yyyy** (e.g. 02/06/2026). Or /start to cancel.", parse_mode="md", buttons=[[Button.inline("‹ Back to Config", CB_BACK_CONFIG)]])
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_MESSAGE:
            await event.answer()
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (no markdown)."
            cfg_msg_buttons = [
                [
                    Button.inline("✓ Custom text" if mode == "text" else "Use custom text", CB_CFG_MSG_MODE_TEXT),
                    Button.inline("✓ Post link(s)" if mode == "link" else "Use post link(s)", CB_CFG_MSG_MODE_LINK),
                ],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                cfg_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_CFG_TEXT_DEL)])
            cfg_msg_buttons.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit(
                    f"**Set message**\n\n{current}\n\n{fmt_note}",
                    parse_mode="md",
                    buttons=cfg_msg_buttons,
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_MSG_MODE_TEXT:
            await event.answer()
            def set_mode_text_cfg(c):
                c["message_mode"] = "text"
            _save_bot_config(bot_token, set_mode_text_cfg)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (no markdown)."
            cfg_msg_buttons = [
                [Button.inline("✓ Custom text", CB_CFG_MSG_MODE_TEXT), Button.inline("Use post link(s)", CB_CFG_MSG_MODE_LINK)],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                cfg_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_CFG_TEXT_DEL)])
            cfg_msg_buttons.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit(
                    f"**Set message**\n\nNow using **Custom text**.\n\n{current}\n\n{fmt_note}",
                    parse_mode="md",
                    buttons=cfg_msg_buttons,
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_MSG_MODE_LINK:
            await event.answer()
            def set_mode_link_cfg(c):
                c["message_mode"] = "link"
            _save_bot_config(bot_token, set_mode_link_cfg)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (no markdown)."
            cfg_msg_buttons = [
                [Button.inline("Use custom text", CB_CFG_MSG_MODE_TEXT), Button.inline("✓ Post link(s)", CB_CFG_MSG_MODE_LINK)],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                cfg_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_CFG_TEXT_DEL)])
            cfg_msg_buttons.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit(
                    f"**Set message**\n\nNow using **Post link(s)**.\n\n{current}\n\n{fmt_note}",
                    parse_mode="md",
                    buttons=cfg_msg_buttons,
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_TEXT_DEL:
            await event.answer()
            def clear_text_cfg(c):
                c["message_text"] = ""
            _save_bot_config(bot_token, clear_text_cfg)
            cfg = get_cfg() or {}
            txt = (cfg.get("message_text") or "").strip() or "(none)"
            links = _get_post_links_list(cfg)
            mode = _get_message_mode(cfg)
            mode_label = "Custom text" if mode == "text" else "Post link(s)"
            if len(txt) > 200:
                txt = txt[:200] + "…"
            links_preview = ", ".join((u[:40] + "…" if len(u) > 40 else u for u in links[:5])) if links else "(none)"
            if len(links) > 5:
                links_preview += f" … +{len(links) - 5} more"
            current = f"**Currently using:** {mode_label}\n\nCurrent text: {txt}\nCurrent post links: {links_preview}"
            fmt_note = "Custom text is posted in groups as plain text (no markdown)."
            cfg_msg_buttons = [
                [
                    Button.inline("✓ Custom text" if mode == "text" else "Use custom text", CB_CFG_MSG_MODE_TEXT),
                    Button.inline("✓ Post link(s)" if mode == "link" else "Use post link(s)", CB_CFG_MSG_MODE_LINK),
                ],
                [Button.inline("Custom text", CB_SET_MSG_TEXT), Button.inline("Post links (forward)", CB_SET_MSG_LINKS_MANAGE)],
            ]
            if txt != "(none)":
                cfg_msg_buttons.append([Button.inline("🗑 Delete custom text", CB_CFG_TEXT_DEL)])
            cfg_msg_buttons.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit(
                    f"**Set message**\n\nCustom text deleted.\n\n{current}\n\n{fmt_note}",
                    parse_mode="md",
                    buttons=cfg_msg_buttons,
                )
            except MessageNotModifiedError:
                pass
        elif raw == CB_CFG_POST_LINKS:
            await event.answer()
            links = _get_post_links_list(cfg)
            lines = ["**Post links** (forward)\n"]
            if not links:
                lines.append("_No links. Add one to forward messages._")
            else:
                for i, u in enumerate(links, 1):
                    show = (u[:55] + "…") if len(u) > 55 else u
                    lines.append(f"{i}. `{show}`")
            buttons = [[Button.inline("➕ Add link", CB_SET_MSG_LINK)]]
            for i in range(len(links)):
                buttons.append([Button.inline(f"Remove #{i + 1}", PREFIX_PL_DEL + str(i).encode())])
            buttons.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
            try:
                await event.edit("\n".join(lines), parse_mode="md", buttons=buttons)
            except MessageNotModifiedError:
                pass
        elif raw.startswith(PREFIX_MODE):
            await event.answer()
            val = raw[len(PREFIX_MODE):].decode("utf-8", errors="replace").strip().lower()
            m = "Enterprise" if val == "enterprise" else "Starter"
            def upd(c):
                c["mode"] = m
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Mode set to **{m}**.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        elif raw.startswith(PREFIX_GROUP):
            await event.answer()
            fn = raw[len(PREFIX_GROUP):].decode("utf-8", errors="replace").strip()
            if not fn.endswith(".txt"):
                fn = fn + ".txt"
            gf_path = config.GROUPS_DIR / fn
            if not gf_path.is_file():
                await event.answer(f"File {fn} not found.", alert=True)
                return
            def upd(c):
                c["group_file"] = fn
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Group file set to **{fn}**.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        elif raw.startswith(PREFIX_CYCLE):
            await event.answer()
            try:
                sec = int(raw[len(PREFIX_CYCLE):].decode("utf-8", errors="replace").strip())
            except ValueError:
                await event.answer("Invalid value.", alert=True)
                return
            if sec < config.MIN_CYCLE_SEC:
                await event.answer(f"Min {config.MIN_CYCLE_SEC} sec.", alert=True)
                return
            def upd(c):
                c["cycle"] = sec
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Cycle set to **{sec}** sec.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        elif raw.startswith(PREFIX_GAP):
            await event.answer()
            try:
                sec = int(raw[len(PREFIX_GAP):].decode("utf-8", errors="replace").strip())
            except ValueError:
                await event.answer("Invalid value.", alert=True)
                return
            if sec < 0:
                await event.answer("Gap must be non-negative.", alert=True)
                return
            def upd(c):
                c["gap"] = sec
            if _save_bot_config(bot_token, upd):
                cfg = get_cfg()
                text, buttons = _config_message_and_buttons(cfg, bot_token) if cfg else (f"Gap set to **{sec}** sec.", _menu_buttons())
                try:
                    await event.edit(text, parse_mode="md", buttons=buttons)
                except MessageNotModifiedError:
                    pass
            else:
                await event.answer("Failed to save.", alert=True)
        else:
            await event.answer()

    @client.on(events.NewMessage())
    async def on_upload_document(event: events.NewMessage.Event) -> None:
        """When in upload_sessions state and user sends .session or .zip, save to users/<uid>/ and add to bot sessions. Live-update workers."""
        if event.message.out:
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if event.sender_id not in _upload_sessions_state.get(bot_token, set()):
            return
        if is_maintenance_enabled():
            add_to_maintenance_queue(event.sender_id, event.chat_id)
            await event.reply(MAINTENANCE_MESSAGE)
            return
        if (event.text or "").strip().startswith("/"):
            _upload_sessions_state.setdefault(bot_token, set()).discard(event.sender_id)
            return
        if not event.document:
            return
        _upload_sessions_state.setdefault(bot_token, set()).discard(event.sender_id)
        name = (getattr(event.file, "name") or getattr(event.document, "id") or "file") or "file"
        name_lower = name.lower()
        is_zip = name_lower.endswith(".zip") or (getattr(event.document, "mime_type", "") or "").lower().count("zip")
        user_dir = config.SESSIONS_BY_USER / str(event.sender_id)
        user_dir.mkdir(parents=True, exist_ok=True)

        def _unique_in_user_dir(base: str) -> Path:
            p = user_dir / base
            if not p.exists():
                return p
            stem, suf = Path(base).stem, Path(base).suffix or ".session"
            n = 1
            while (user_dir / f"{stem}_{n}{suf}").exists():
                n += 1
            return user_dir / f"{stem}_{n}{suf}"

        added, failed = 0, 0
        try:
            if name_lower.endswith(".session"):
                dest = _unique_in_user_dir(name if name_lower.endswith(".session") else Path(name).stem + ".session")
                path = await event.download_media(file=str(dest))
                if path and Path(path).is_file():
                    p = Path(path)
                    if p.suffix.lower() != ".session":
                        dest = _unique_in_user_dir(p.stem + ".session")
                        if p != dest:
                            shutil.move(str(p), str(dest))
                        p = dest
                    if await validate_session(p):
                        data = load_adbot()
                        c = data.get("bots", {}).get(bot_token)
                        if c:
                            sess = list(c.get("sessions", []))
                            rel = f"users/{event.sender_id}/{p.name}"
                            info = await get_session_user(p)
                            real_name = str(info[1]) if info else p.name
                            uid_sess = int(info[0]) if info else 0
                            sess.append({"file": rel, "real_name": real_name, "user_id": uid_sess, "index": len(sess) + 1})
                            c["sessions"] = sess
                            save_adbot(data)
                            added += 1
                            log_group = _log_group_entity(c.get("log_group"))
                            if log_group:
                                try:
                                    async with session_guard.open_session(p, "joining log group", wait_timeout=15) as tc:
                                        if await tc.is_user_authorized():
                                            await join_chat_by_link(tc, log_group)
                                except Exception:
                                    pass
                    else:
                        failed += 1
            elif is_zip:
                with tempfile.TemporaryDirectory() as tmp:
                    tmp_p = Path(tmp)
                    zpath = tmp_p / "up.zip"
                    await event.download_media(file=str(zpath))
                    # Zip extraction must not block the main loop (Fix #3).
                    dests = await asyncio.to_thread(
                        _extract_zip_and_copy_to_user_dir, zpath, tmp_p, user_dir
                    )
                    for dest in dests:
                        if await validate_session(dest):
                            data = load_adbot()
                            c = data.get("bots", {}).get(bot_token)
                            if c:
                                rel = f"users/{event.sender_id}/{dest.name}"
                                sess = list(c.get("sessions", []))
                                info = await get_session_user(dest)
                                real_name = str(info[1]) if info else dest.name
                                uid_sess = int(info[0]) if info else 0
                                sess.append({"file": rel, "real_name": real_name, "user_id": uid_sess, "index": len(sess) + 1})
                                c["sessions"] = sess
                                save_adbot(data)
                                added += 1
                                log_group = _log_group_entity(c.get("log_group"))
                                if log_group:
                                    try:
                                        async with session_guard.open_session(dest, "joining log group", wait_timeout=15) as tc:
                                            if await tc.is_user_authorized():
                                                await join_chat_by_link(tc, log_group)
                                    except Exception:
                                        pass
                        else:
                            failed += 1
            else:
                await event.reply("Send a .session file or .zip with session files.")
                _upload_sessions_state.setdefault(bot_token, set()).add(event.sender_id)
                return
        except Exception as e:
            logger.exception("Upload sessions: %s", e)
            await event.reply(f"Error: {e}")
            return
        if cfg.get("state") == "running" and added:
            asyncio.create_task(_start_posting(bot_token))
        await event.reply(f"Sessions added: {added}, failed: {failed}. Workers updated live." if added or failed else "Send a .session or .zip file.")

    @client.on(events.NewMessage())
    async def on_chatlist_link_input(event: events.NewMessage.Event) -> None:
        """Handle chatlist link(s) when user is in chatlist input state."""
        if event.message.out:
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if event.sender_id not in _chatlist_input_state.get(bot_token, set()):
            return
        text = (event.text or "").strip()
        if text.startswith("/"):
            _chatlist_input_state.setdefault(bot_token, set()).discard(event.sender_id)
            return
        _chatlist_input_state.setdefault(bot_token, set()).discard(event.sender_id)
        from .chatlist import is_chatlist_link, process_chatlist_setup, MAX_CHATLIST_LINKS
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        links = [l for l in lines if is_chatlist_link(l)]
        if not links:
            await event.reply("No valid chatlist links found. Send links like `https://t.me/addlist/...`", parse_mode="md")
            return
        if len(links) > MAX_CHATLIST_LINKS:
            links = links[:MAX_CHATLIST_LINKS]
            await event.reply(f"Using first {MAX_CHATLIST_LINKS} links only.")
        progress_msg = await event.reply("⏳ Processing chatlist(s)... This may take a minute.")

        async def progress_cb(text: str) -> None:
            try:
                await progress_msg.edit(f"⏳ {text}")
            except Exception:
                pass

        user_name = get_name_by_token(bot_token)
        if not user_name:
            await event.reply("Bot config not found.")
            return
        cfg = _get_cfg(bot_token) or {}
        success, message, count = await process_chatlist_setup(
            bot_token, user_name, links, cfg, progress_cb=progress_cb,
        )
        if success:
            def _update_chatlist(c: dict) -> None:
                c["group_file"] = cfg.get("group_file", c.get("group_file", "Starter.txt"))
                c["custom_chatlist"] = cfg.get("custom_chatlist")
            _save_bot_config(bot_token, _update_chatlist)
            await progress_msg.edit(
                f"✅ **Chatlist setup complete!**\n\n{message}\n\n"
                f"Your bot will now post in these {count} groups.\n"
                f"Use **📂 Group Select** to view, edit, or revert.",
                parse_mode="md",
            )
        else:
            await progress_msg.edit(f"❌ **Chatlist setup failed**\n\n{message}", parse_mode="md")

    @client.on(events.NewMessage())
    async def on_chatlist_file_upload(event: events.NewMessage.Event) -> None:
        """Handle custom group file upload (.txt) when user is in chatlist upload state."""
        if event.message.out:
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if event.sender_id not in _chatlist_upload_state.get(bot_token, set()):
            return
        text = (event.text or "").strip()
        if text.startswith("/"):
            _chatlist_upload_state.setdefault(bot_token, set()).discard(event.sender_id)
            return
        if not event.document:
            return
        _chatlist_upload_state.setdefault(bot_token, set()).discard(event.sender_id)
        name = (getattr(event.file, "name") or "file") or "file"
        if not name.lower().endswith(".txt"):
            await event.reply("Please send a `.txt` file with group IDs.", parse_mode="md")
            return
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp) / name
            await event.download_media(file=str(tmp_path))
            content = tmp_path.read_text(encoding="utf-8", errors="replace")
        lines = [l.strip() for l in content.splitlines() if l.strip()]
        valid_lines = []
        for ln in lines:
            if "|" in ln:
                parts = ln.split("|", 1)
                chat_part = parts[0].strip()
                topic_part = parts[1].strip()
                if _is_numeric_group_id(chat_part) and topic_part.isdigit():
                    valid_lines.append(ln)
                    continue
            if _is_numeric_group_id(ln):
                valid_lines.append(ln)
        if not valid_lines:
            await event.reply("No valid group IDs found in the file. Format: `-1001234567890` or `-1001234567890 | 34`", parse_mode="md")
            return
        from .chatlist import save_custom_groups, custom_group_filename, MAX_GROUPS_PER_CHATLIST, STARTER_MAX_GROUPS
        mode = get_plan_mode(cfg)
        limit = STARTER_MAX_GROUPS if mode == "Starter" else MAX_GROUPS_PER_CHATLIST * 2
        if len(valid_lines) > limit:
            valid_lines = valid_lines[:limit]
        user_name = get_name_by_token(bot_token)
        if not user_name:
            await event.reply("Bot config not found.")
            return
        save_custom_groups(user_name, valid_lines)
        fn = custom_group_filename(user_name)
        _save_bot_config(bot_token, lambda c: c.update({"group_file": fn}))
        await event.reply(
            f"✅ **Group file updated!**\n\n"
            f"**{len(valid_lines)}** groups loaded from uploaded file.\n"
            f"Group file set to `{fn}`.\n"
            f"Changes take effect on the next posting cycle.",
            parse_mode="md",
        )

    @client.on(events.NewMessage())
    async def on_set_message_input(event: events.NewMessage.Event) -> None:
        """Handle text/link when user is in Set Message state or Config custom input state."""
        if event.message.out:
            return
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        if event.sender_id in _upload_sessions_state.get(bot_token, set()):
            return
        if event.sender_id in _chatlist_input_state.get(bot_token, set()):
            return
        if event.sender_id in _chatlist_upload_state.get(bot_token, set()):
            return
        # Config custom input (renewal_price, valid_till, cycle, gap)
        config_state = _config_custom_state.get(bot_token, {}).get(event.sender_id)
        if config_state and not (event.text or "").strip().startswith("/"):
            text = (event.text or "").strip()
            key = (bot_token, event.sender_id)
            chat_id, msg_id = _config_custom_message_id.pop(key, (None, None))
            _config_custom_state.setdefault(bot_token, {}).pop(event.sender_id, None)
            if not text:
                _config_custom_state.setdefault(bot_token, {})[event.sender_id] = config_state
                if key not in _config_custom_message_id and chat_id is not None and msg_id is not None:
                    _config_custom_message_id[key] = (chat_id, msg_id)
                await event.reply("Send a non-empty value, or /start to cancel.")
                return
            ok = False
            if config_state == "renewal_price":
                try:
                    price = float(text.replace(",", "."))
                    if price >= 0:
                        def upd(c):
                            c["renewal_price"] = str(price)
                        ok = _save_bot_config(bot_token, upd)
                except ValueError:
                    pass
                if not ok:
                    _config_custom_state.setdefault(bot_token, {})[event.sender_id] = config_state
                    _config_custom_message_id[key] = (chat_id, msg_id)
                    await event.reply("Send a valid number (e.g. 5 or 10.50).")
                    return
            elif config_state == "valid_till":
                try:
                    dt = datetime.strptime(text, "%d/%m/%Y")
                    date_str = dt.strftime("%d/%m/%Y")
                    def upd(c):
                        c["valid_till"] = date_str
                    ok = _save_bot_config(bot_token, upd)
                except ValueError:
                    ok = False
                if not ok:
                    _config_custom_state.setdefault(bot_token, {})[event.sender_id] = config_state
                    _config_custom_message_id[key] = (chat_id, msg_id)
                    await event.reply("Use format dd/mm/yyyy (e.g. 02/06/2026).")
                    return
            elif config_state == "cycle":
                try:
                    sec = int(text)
                    if sec >= config.MIN_CYCLE_SEC:
                        def upd(c):
                            c["cycle"] = sec
                        ok = _save_bot_config(bot_token, upd)
                    else:
                        ok = False
                except ValueError:
                    ok = False
                if not ok:
                    _config_custom_state.setdefault(bot_token, {})[event.sender_id] = config_state
                    _config_custom_message_id[key] = (chat_id, msg_id)
                    await event.reply(f"Send a number (min {config.MIN_CYCLE_SEC} seconds).")
                    return
            elif config_state == "gap":
                try:
                    sec = int(text)
                    if sec >= 0:
                        def upd(c):
                            c["gap"] = sec
                        ok = _save_bot_config(bot_token, upd)
                    else:
                        ok = False
                except ValueError:
                    ok = False
                if not ok:
                    _config_custom_state.setdefault(bot_token, {})[event.sender_id] = config_state
                    _config_custom_message_id[key] = (chat_id, msg_id)
                    await event.reply("Send a non-negative number (e.g. 4 or 5).")
                    return
            elif config_state == "autoreply_msg":
                # "default" clears the custom message (falls back to the built-in default).
                # The locked footer is stripped so it can't be stored or duplicated.
                _ft = dm_inbox.get_autoreply_footer()
                new_msg = "" if text.strip().lower() == "default" else text.replace(_ft, "").strip()[:500]
                def upd(c):
                    ar = dict(c.get("dm_autoreply") or {})
                    ar["message"] = new_msg
                    ar.setdefault("enabled", True)
                    c["dm_autoreply"] = ar
                _save_bot_config(bot_token, upd)
                cfg2 = get_cfg()
                body2, buttons2 = _autoreply_menu_text_and_buttons(cfg2 or {})
                if chat_id is not None and msg_id is not None:
                    try:
                        await client.edit_message(chat_id, msg_id, body2, parse_mode="md", buttons=buttons2)
                    except MessageNotModifiedError:
                        pass
                    except Exception:
                        await event.reply(body2, parse_mode="md", buttons=buttons2)
                else:
                    await event.reply(body2, parse_mode="md", buttons=buttons2)
                return
            if chat_id is not None and msg_id is not None:
                cfg = get_cfg()
                if cfg:
                    body, buttons = _config_message_and_buttons(cfg, bot_token)
                    try:
                        await client.edit_message(chat_id, msg_id, body, parse_mode="md", buttons=buttons)
                    except MessageNotModifiedError:
                        pass
                    except Exception:
                        await event.reply(body, parse_mode="md", buttons=buttons)
                else:
                    await event.reply("Config saved.")
            else:
                await event.reply("Config saved.")
            return
        in_set_message = event.sender_id in _set_message_state.get(bot_token, {})
        in_fix_wait = bool(_fix_wait_token_state.get(bot_token) and _is_admin(event.sender_id))
        if not in_set_message and not in_fix_wait:
            return
        if is_maintenance_enabled():
            add_to_maintenance_queue(event.sender_id, event.chat_id)
            await event.reply(MAINTENANCE_MESSAGE)
            return
        if _fix_wait_token_state.get(bot_token) and _is_admin(event.sender_id):
            new_token = (event.message.text or "").strip()
            if new_token and not new_token.startswith("/"):
                _fix_wait_token_state.pop(bot_token, None)
                await event.reply("Updating bot token…")
                try:
                    msg = await repair_fix_bot_token(bot_token, new_token)
                    await event.reply(msg)
                except Exception as e:
                    logger.exception("repair_fix_bot_token: %s", e)
                    await event.reply(f"Error: {e}")
                return
        state_map = _set_message_state.get(bot_token, {})
        mode = state_map.pop(event.sender_id, None)
        if mode is None:
            return
        text = (event.message.text or "").strip()
        if not text:
            _set_message_state.setdefault(bot_token, {})[event.sender_id] = mode
            await event.reply("Send non-empty text, or use /start to cancel.")
            return
        if text.startswith("/"):
            return  # state already popped; let /start etc. run, user effectively cancelled
        if mode == "text":
            _save_bot_config(bot_token, lambda c: c.update({"message_text": text}))
            log_bot_event(bot_token, f"User {event.sender_id} set custom text")
            await event.reply("Custom text saved.", buttons=_menu_buttons())
        else:
            if not _parse_post_link(text):
                _set_message_state.setdefault(bot_token, {})[event.sender_id] = mode
                await event.reply("Invalid link. Send t.me/c/123/456 or t.me/channel/123.")
                return
            def add_post_link(c):
                pl = list(c.get("post_links") or ([(c.get("post_link") or "")] if c.get("post_link") else []))
                pl.append(text.strip())
                c["post_links"] = pl
                c["post_link"] = pl[0]
            _save_bot_config(bot_token, add_post_link)
            log_bot_event(bot_token, f"User {event.sender_id} added post link: {text[:80]}{'…' if len(text) > 80 else ''}")
            cfg = get_cfg() or {}
            links = _get_post_links_list(cfg)
            lines = ["**Post link added.**\n\n**Post links** (forward)\n"]
            if not links:
                lines.append("_No links._")
            else:
                for i, u in enumerate(links, 1):
                    show = (u[:55] + "…") if len(u) > 55 else u
                    lines.append(f"{i}. `{show}`")
            buttons = [[Button.inline("➕ Add another", CB_SET_MSG_LINK)]]
            for i in range(len(links)):
                buttons.append([Button.inline(f"Remove #{i + 1}", PREFIX_PL_DEL + str(i).encode())])
            buttons.append([Button.inline("‹ Back to Set message", CB_SET_MSG)])
            await event.reply("\n".join(lines), parse_mode="md", buttons=buttons)

    @client.on(events.NewMessage(pattern=r"^/add\s+(\d+)\s*$"))
    async def cmd_add(event: events.NewMessage.Event) -> None:
        if not _is_admin(event.sender_id):
            return
        match = event.pattern_match
        if not match:
            return
        uid = int(match.group(1))
        def add_id(c):
            c.setdefault("authorized", [])
            if uid not in c["authorized"]:
                c["authorized"].append(uid)
        if _save_bot_config(bot_token, add_id):
            await event.reply(f"Added {uid} to authorized.")
        else:
            await event.reply("Bot config not found.")

    @client.on(events.NewMessage(pattern=r"^/remove\s+(\d+)\s*$"))
    async def cmd_remove(event: events.NewMessage.Event) -> None:
        if not _is_admin(event.sender_id):
            return
        match = event.pattern_match
        if not match:
            return
        uid = int(match.group(1))
        def remove_id(c):
            c.setdefault("authorized", [])
            c["authorized"] = [x for x in c["authorized"] if x != uid]
        if _save_bot_config(bot_token, remove_id):
            await event.reply(f"Removed {uid} from authorized.")
        else:
            await event.reply("Bot config not found.")

    @client.on(events.NewMessage(pattern=r"^/subs\s+(.+)\s*$"))
    async def cmd_subs(event: events.NewMessage.Event) -> None:
        if not _is_admin(event.sender_id):
            return
        match = event.pattern_match
        if not match:
            return
        raw = match.group(1).strip()
        try:
            dt = datetime.strptime(raw, "%d/%m/%Y")
            date_str = dt.strftime("%d/%m/%Y")
        except ValueError:
            await event.reply("Use format dd/mm/yyyy (e.g. 02/06/2026).")
            return
        def set_valid(c):
            c["valid_till"] = date_str
        if _save_bot_config(bot_token, set_valid):
            await event.reply(f"Valid till set to {date_str}.")
        else:
            await event.reply("Bot config not found.")

    @client.on(events.NewMessage(pattern=r"^/sessions\s*$"))
    async def cmd_sessions(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        sessions = cfg.get("sessions", [])
        if not sessions:
            await event.reply("No sessions assigned.")
            return
        lines = ["**Sessions**"]
        for i, s in enumerate(sessions, 1):
            fn = s.get("file") or "?"
            name = s.get("real_name") or fn
            uid = s.get("user_id") or "—"
            idx = s.get("index", i)
            lines.append(f"{idx}. `{fn}` — {name} (id: {uid})")
        await event.reply("\n".join(lines), parse_mode="md")

    def _config_message_and_buttons(cfg: dict, token: str | None = None) -> tuple[str, list]:
        """Build structured config control panel: BOT STATUS, POSTING, MESSAGE, SESSIONS, STATS. Stats from data/stats/ when token given."""
        sessions = cfg.get("sessions", [])
        excluded = set(cfg.get("excluded_sessions") or [])
        active_count = sum(1 for s in sessions if (s.get("file") or "").strip() not in excluded)
        renewal = cfg.get("renewal_price") or "0"
        try:
            rn = float(str(renewal).replace(",", ".").strip())
            renewal_display = f"${rn:.2f}"
        except (ValueError, TypeError):
            renewal_display = str(renewal) if renewal else "—"
        msg_preview = (cfg.get("message_text") or "").strip() or "(none)"
        if len(msg_preview) > 80:
            msg_preview = msg_preview[:80] + "…"
        links_count = len(_get_post_links_list(cfg))
        if token:
            st = _get_stats_for_display(token)
            total_sent = st.get("lifetime_sent", 0)
            total_failed = st.get("lifetime_failed", 0)
        else:
            st = cfg.get("stats", {}) or {}
            total_sent = st.get("total_sent", 0) or st.get("lifetime_sent", 0)
            total_failed = st.get("total_failed", 0) or st.get("lifetime_failed", 0)
        lines = [
            "**BOT STATUS**",
            f"Name: {cfg.get('name') or '—'}",
            f"State: {cfg.get('state') or '—'}",
            f"Valid till: {cfg.get('valid_till') or '—'}",
            f"Renewal price: {renewal_display}",
            "",
            "**POSTING SETTINGS**",
            f"Mode: {cfg.get('mode') or '—'}",
            f"Group file: {cfg.get('group_file') or '—'}",
            f"Cycle: {cfg.get('cycle') or '—'} sec",
            f"Gap: {cfg.get('gap') or '—'} sec",
            "",
            "**MESSAGE SETTINGS**",
            f"Message: {msg_preview}",
            f"Post links: {links_count} link(s)",
            "",
            "**SESSIONS**",
            f"Total: {len(sessions)} | Active: {active_count} | Excluded: {len(excluded)}",
            "",
            "**STATS**",
            f"Sent: {total_sent} | Failed: {total_failed}",
        ]
        buttons = [
            [Button.inline("Mode", b"cfg_mode"), Button.inline("Group File", b"cfg_group")],
            [Button.inline("Cycle", b"cfg_cycle"), Button.inline("Gap", b"cfg_gap")],
            [Button.inline("Renewal Price", CB_CFG_RENEWAL), Button.inline("Valid Till", CB_CFG_VALID_TILL)],
            [Button.inline("Message", CB_CFG_MESSAGE), Button.inline("Post Links", CB_CFG_POST_LINKS)],
            [Button.inline("‹ Back", CB_BACK_CONFIG)],
        ]
        return "\n".join(lines), buttons

    @client.on(events.NewMessage(pattern=r"^/config\s*$"))
    async def cmd_config(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        text, buttons = _config_message_and_buttons(cfg, bot_token)
        await event.reply(text, parse_mode="md", buttons=buttons)

    @client.on(events.NewMessage(pattern=r"^/logs\s*$"))
    async def cmd_logs(event: events.NewMessage.Event) -> None:
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        path = get_bot_log_path(bot_token)
        if not path or not path.is_file():
            await event.reply("No log file available for this bot.")
            return
        try:
            await client.send_file(event.chat_id, path, caption=path.name)
        except Exception as e:
            logger.warning("Failed to send log file for bot %s: %s", (cfg.get("name") or bot_token[:15]), e)
            await event.reply(f"Could not send log file: {e}")

    @client.on(events.NewMessage(pattern=r"^/cmd\s*$"))
    async def cmd_cmd(event: events.NewMessage.Event) -> None:
        cfg = get_cfg()
        if not _is_authorized(event.sender_id, cfg):
            return
        lines = [
            "**Commands**",
            "",
            "**Menu & config**",
            "/start — Main menu (Run, Stop, Set Message, Status, Logs, Validity)",
            "/config — View config and change Mode, Group file, Cycle, Gap via buttons",
            "/cmd — This help",
            "",
            "**Selection (use command alone for inline buttons)**",
            "/mode — Choose Starter or Enterprise (or: /mode starter)",
            "/group — Choose group file from groups/ (or: /group Starter.txt)",
            "/cycle — Choose cycle interval: 5min–2hr (or: /cycle 3600)",
            "/gap — Choose gap between posts: 4–6 sec (or: /gap 5)",
            "",
            "**Info**",
            "/sessions — List session names & ids",
            "/stat or /stats — Lifetime & last 24h stats; Per Session, Analyze, Reset buttons",
            "/logs — Get this bot's log file",
            "",
            "/upload_sessions — Upload .session or .zip; workers update live",
        ]
        if _is_admin(event.sender_id):
            lines.extend([
                "",
                "**Admin only**",
                "/add <user_id> — Add to authorized",
                "/remove <user_id> — Remove from authorized",
                "/subs <dd/mm/yyyy> — Set valid till",
            ])
        await event.reply("\n".join(lines), parse_mode="md")

    def _format_last_activity(ts: float | None) -> str:
        """Format last_cycle_time for display: '30 Jan 15:42' or '—' if never."""
        if ts is None or ts <= 0:
            return "—"
        try:
            return datetime.fromtimestamp(ts).strftime("%d %b %H:%M")
        except (OSError, ValueError):
            return "—"

    def _stats_main_view() -> tuple[str, list]:
        """Main /stats view: GLOBAL (Lifetime) + LAST 24 HOURS + inline buttons."""
        cfg = get_cfg()
        if not cfg:
            return "Bot config not found.", []
        data = _get_stats_for_display(bot_token)
        if not data:
            return "No stats data.", []
        ls = int(data["lifetime_sent"])
        lf = int(data["lifetime_failed"])
        total_attempts = ls + lf
        rate_global = (ls / total_attempts * 100) if total_attempts else 0
        sent_24 = int(data.get("last24h_sent", 0))
        failed_24 = int(data.get("last24h_failed", 0))
        total_24 = sent_24 + failed_24
        rate_24 = (sent_24 / total_24 * 100) if total_24 else 0
        posts_per_hour = total_24 / 24.0
        est_per_day = posts_per_hour * 24
        state = cfg.get("state", "stopped")
        alive = _workers_alive(bot_token)
        n_sessions = len(cfg.get("sessions", []))
        msg = (
            "**AdBot Stats**\n\n"
            f"State: {state} · Workers: {alive}/{n_sessions}\n\n"
            "**GLOBAL (Lifetime)**\n"
            f"Sent: {ls}\n"
            f"Failed: {lf}\n"
            f"Total Attempts: {total_attempts}\n"
            f"Success Rate: {rate_global:.0f}%\n\n"
            "**LAST 24 HOURS**\n"
            f"Sent: {sent_24}\n"
            f"Failed: {failed_24}\n"
            f"Success Rate: {rate_24:.0f}%\n"
            f"Posts per Hour (avg): {posts_per_hour:.1f}\n"
            f"Estimated Posts per Day: {est_per_day:.0f}\n"
        )
        buttons = [
            [Button.inline("Per Session", CB_STATS_PER_SESSION), Button.inline("Analyze", CB_STATS_ANALYZE)],
            [Button.inline("Reset Stats", CB_STATS_RESET)],
        ]
        return msg, buttons

    def _stats_dashboard(include_session_details: bool = False) -> tuple[str, list]:
        """Stats dashboard: main view (Per Session / Analyze / Reset). include_session_details ignored (use Per Session button)."""
        return _stats_main_view()

    @client.on(events.NewMessage(pattern=re.compile(r"^/stat(s)?(\s+full)?\s*$", re.IGNORECASE)))
    async def cmd_stat(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        full = bool((event.pattern_match.group(2) or "").strip().lower() == "full")
        msg, buttons = _stats_dashboard(include_session_details=full)
        await event.reply(msg, parse_mode="md", buttons=buttons)

    @client.on(events.NewMessage(pattern=re.compile(r"^/mode(\s+(starter|enterprise))?\s*$", re.IGNORECASE)))
    async def cmd_mode(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        arg = (event.pattern_match.group(2) or "").strip().lower() if event.pattern_match else ""
        if arg in ("starter", "enterprise"):
            m = "Starter" if arg == "starter" else "Enterprise"
            def upd(c):
                c["mode"] = m
            if _save_bot_config(bot_token, upd):
                await event.reply(f"Mode set to **{m}**.", parse_mode="md")
            else:
                await event.reply("Bot config not found.")
            return
        # No arg: show inline buttons
        current = get_plan_mode(cfg)
        buttons = [
            [
                Button.inline("Starter" + (" ✓" if current == "Starter" else ""), PREFIX_MODE + b"starter"),
                Button.inline("Enterprise" + (" ✓" if current == "Enterprise" else ""), PREFIX_MODE + b"enterprise"),
            ],
            [Button.inline("‹ Back to Config", CB_BACK_CONFIG)],
        ]
        await event.reply("**Choose mode:**\n\n• **Starter** — All sessions post to all groups.\n• **Enterprise** — Sessions partition groups; per-session cap.", parse_mode="md", buttons=buttons)

    @client.on(events.NewMessage(pattern=re.compile(r"^/group(\s+(.+))?\s*$")))
    async def cmd_group(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        arg = (event.pattern_match.group(2) or "").strip() if event.pattern_match else ""
        if arg:
            fn = arg if arg.endswith(".txt") else (arg + ".txt" if arg else "")
            gf_path = config.GROUPS_DIR / fn
            if not gf_path.is_file():
                await event.reply(f"Group file **{fn}** not found in groups/.", parse_mode="md")
                return
            def upd(c):
                c["group_file"] = fn
            if _save_bot_config(bot_token, upd):
                await event.reply(f"Group file set to **{fn}**.", parse_mode="md")
            else:
                await event.reply("Bot config not found.")
            return
        # No arg: show inline buttons of all .txt files in groups/
        files = _list_group_files()
        if not files:
            await event.reply("No `.txt` files in **groups/** folder. Add a file (e.g. Starter.txt) and try again.", parse_mode="md")
            return
        current = (cfg.get("group_file") or "").strip()
        rows = []
        for i in range(0, len(files), 2):
            row = []
            for fn in files[i : i + 2]:
                label = fn + (" ✓" if fn == current else "")
                row.append(Button.inline(label, PREFIX_GROUP + fn.encode("utf-8")))
            rows.append(row)
        rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
        await event.reply("**Choose group file:**\n\nSelect a file from **groups/** folder. Current selection is marked ✓.", parse_mode="md", buttons=rows)

    @client.on(events.NewMessage(pattern=re.compile(r"^/cycle(\s+(\d+))?\s*$")))
    async def cmd_cycle(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        arg = (event.pattern_match.group(2) or "").strip() if event.pattern_match else ""
        if arg:
            try:
                sec = int(arg)
            except ValueError:
                await event.reply(f"Use /cycle <seconds> (min {config.MIN_CYCLE_SEC}) or /cycle to choose from presets.")
                return
            if sec < config.MIN_CYCLE_SEC:
                await event.reply(f"Cycle must be at least {config.MIN_CYCLE_SEC} seconds.")
                return
            def upd(c):
                c["cycle"] = sec
            if _save_bot_config(bot_token, upd):
                await event.reply(f"Cycle set to **{sec}** seconds.", parse_mode="md")
            else:
                await event.reply("Bot config not found.")
            return
        # No arg: show preset buttons (5min, 15min, 30min, 1hr, 2hr)
        presets = [(300, "5 min"), (900, "15 min"), (1800, "30 min"), (3600, "1 hr"), (7200, "2 hr")]
        current = int(cfg.get("cycle", 3600))
        rows = []
        for sec, label in presets:
            rows.append([Button.inline(label + (" ✓" if sec == current else ""), PREFIX_CYCLE + str(sec).encode())])
        rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
        await event.reply(f"**Choose cycle interval:**\n\nTime between posting rounds per session. Min {config.MIN_CYCLE_SEC} sec.", parse_mode="md", buttons=rows)

    @client.on(events.NewMessage(pattern=re.compile(r"^/gap(\s+(\d+))?\s*$")))
    async def cmd_gap(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        cfg = get_cfg()
        if not cfg:
            await event.reply("Bot config not found.")
            return
        arg = (event.pattern_match.group(2) or "").strip() if event.pattern_match else ""
        if arg:
            try:
                sec = int(arg)
            except ValueError:
                await event.reply("Use /gap <seconds> or /gap to choose from presets.")
                return
            if sec < 0:
                await event.reply("Gap must be non-negative.")
                return
            def upd(c):
                c["gap"] = sec
            if _save_bot_config(bot_token, upd):
                await event.reply(f"Gap set to **{sec}** seconds.", parse_mode="md")
            else:
                await event.reply("Bot config not found.")
            return
        # No arg: show preset buttons (4, 5, 6 sec — anti-ban range)
        presets = [(4, "4 sec"), (5, "5 sec"), (6, "6 sec")]
        current = int(cfg.get("gap", 5))
        rows = []
        for sec, label in presets:
            rows.append([Button.inline(label + (" ✓" if sec == current else ""), PREFIX_GAP + str(sec).encode())])
        rows.append([Button.inline("‹ Back to Config", CB_BACK_CONFIG)])
        await event.reply("**Choose gap between posts:**\n\nDelay between each post in a cycle (anti-ban: 4–6 sec).", parse_mode="md", buttons=rows)

    @client.on(events.NewMessage(pattern=r"^/upload_sessions\s*$"))
    async def cmd_upload_sessions(event: events.NewMessage.Event) -> None:
        if not _is_authorized(event.sender_id, get_cfg()):
            return
        _upload_sessions_state.setdefault(bot_token, set()).add(event.sender_id)
        await event.reply("Send a single .session file or a .zip with session files. They will be saved in your folder and join the log group. Workers update live.")

    try:
        await client.start(bot_token=bot_token)
    except Exception as e:
        err = str(e).lower()
        # Token invalid/revoked → mark bot dead, stop posting, notify admin (via admin_alerts + /health)
        if type(e) in _DEAD_SESSION_ERRORS or any(x in err for x in ("auth", "401", "revoked", "invalid", "token", "unauthorized")):
            _mark_bot_dead(bot_token, str(e)[:300])
            return
        raise
    BOT_CLIENTS[bot_token] = client
    logger.info("User bot running: %s", cfg.get("name") or bot_token[:20])
    # Link this bot's chat menu button to the user's web dashboard (Telegram Mini App).
    # Runs for every activation (create / token-replace / crash-recovery / boot), so it
    # is self-healing and keeps the mini app pointed at the current bot. Fire-and-forget.
    try:
        _link_dashboard_miniapp(bot_token)
    except Exception as e:
        logger.debug("Mini app link scheduling failed for %s…: %s", bot_token[:10], e)
    try:
        await client.run_until_disconnected()
    finally:
        BOT_CLIENTS.pop(bot_token, None)
