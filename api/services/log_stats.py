"""Time-bucketed posting analytics parsed directly from the user's log file.

The rolling in-memory stats buckets (code/users.py) can drift, reset, or lag, but the
log file is the durable source of truth: every delivery is recorded as a
``[POST_SUCCESS]`` / ``[POST_FAILURE]`` line with a UTC timestamp. The Performance chart
and the "last 24h" counters are therefore derived from the log here, so they always match
what actually happened.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from code.config import DATA_LOGS_DIR
from code.utils import name_to_filename

# range key -> (bucket_seconds, bucket_count)
RANGE_CONFIG: dict[str, tuple[int, int]] = {
    "1h": (600, 6),      # 6 × 10 min
    "6h": (3600, 6),     # 6 × 1 hour
    "24h": (3600, 24),   # 24 × 1 hour
    "7d": (86400, 7),    # 7 × 1 day
    "30d": (86400, 30),  # 30 × 1 day (heatmap)
}
DEFAULT_RANGE = "7d"

# Rolling windows always reported alongside the requested range (for the stat cards).
_SUMMARY_WINDOWS = {"h1": 3600, "h6": 6 * 3600, "h24": 86400, "d7": 7 * 86400}

_LINE_RE = re.compile(
    r"^\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+.*?\[(POST_SUCCESS|POST_FAILURE)\]"
)

# Small TTL cache so rapid polls (multiple clients / SWR intervals) don't re-parse an
# unchanged file. Keyed by bot_name -> (log_mtime, log_size, parsed_events).
_events_cache: dict[str, tuple[float, int, list[tuple[float, bool]]]] = {}
_cache_lock = threading.Lock()


def _resolve_log_path(bot_name: str) -> Path | None:
    for candidate in (DATA_LOGS_DIR / f"{bot_name}.log", DATA_LOGS_DIR / f"{name_to_filename(bot_name)}.log"):
        if candidate.is_file():
            return candidate
    return None


def _parse_events(path: Path) -> list[tuple[float, bool]]:
    """Return [(unix_ts, is_success)] for every POST_SUCCESS/FAILURE line in the file.

    Cached by (mtime, size) so an unchanged log is parsed at most once until it grows.
    """
    try:
        stat = path.stat()
        mtime, size = stat.st_mtime, stat.st_size
    except OSError:
        return []
    with _cache_lock:
        cached = _events_cache.get(str(path))
        if cached and cached[0] == mtime and cached[1] == size:
            return cached[2]

    events: list[tuple[float, bool]] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "[POST_" not in line:
                    continue
                m = _LINE_RE.match(line)
                if not m:
                    continue
                try:
                    dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                events.append((dt.timestamp(), m.group(3) == "POST_SUCCESS"))
    except OSError:
        return events

    with _cache_lock:
        _events_cache[str(path)] = (mtime, size, events)
    return events


def compute_analytics(bot_name: str, range_key: str) -> dict:
    """Build a bucketed series for ``range_key`` plus rolling-window summary counters.

    ``range_key`` may also be ``lifetime``: the bucket size is then picked from the
    span between the first logged event and now (via ``_pick_bucket``).
    """
    now = time.time()
    if range_key == "lifetime":
        path = _resolve_log_path(bot_name)
        events = _parse_events(path) if path is not None else []
        first_ts = min((ts for ts, _ in events), default=now)
        bucket_seconds = _pick_bucket(max(now - first_ts, 3600))
        count = int(now // bucket_seconds) - int(first_ts // bucket_seconds) + 1
    else:
        bucket_seconds, count = RANGE_CONFIG.get(range_key, RANGE_CONFIG[DEFAULT_RANGE])
    start_index = int(now // bucket_seconds) - (count - 1)
    range_start_ts = start_index * bucket_seconds

    points = [{"ts": range_start_ts + i * bucket_seconds, "sent": 0, "failed": 0} for i in range(count)]
    summary = {k: {"sent": 0, "failed": 0} for k in _SUMMARY_WINDOWS}
    range_sent = range_failed = 0

    path = _resolve_log_path(bot_name)
    if path is not None:
        for ts, ok in _parse_events(path):
            idx = int(ts // bucket_seconds) - start_index
            if 0 <= idx < count:
                if ok:
                    points[idx]["sent"] += 1
                    range_sent += 1
                else:
                    points[idx]["failed"] += 1
                    range_failed += 1
            for k, win in _SUMMARY_WINDOWS.items():
                if ts >= now - win:
                    summary[k]["sent" if ok else "failed"] += 1

    return {
        "range": range_key if (range_key in RANGE_CONFIG or range_key == "lifetime") else DEFAULT_RANGE,
        "bucket_seconds": bucket_seconds,
        "points": points,
        "range_sent": range_sent,
        "range_failed": range_failed,
        "summary": summary,
        "generated_at": now,
    }


# ── Custom-range, all-bots aggregation ──────────────────────────────────────
# Nice, ascending bucket sizes (seconds). We pick the smallest one that keeps the
# point count under _MAX_POINTS so an arbitrary range still returns a readable chart.
_BUCKET_LADDER = [300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800]
_MAX_POINTS = 240


def _pick_bucket(span_seconds: float) -> int:
    for bs in _BUCKET_LADDER:
        if span_seconds / bs <= _MAX_POINTS:
            return bs
    return _BUCKET_LADDER[-1]


def compute_range_analytics(bot_names: list[str], start_ts: float, end_ts: float) -> dict:
    """Bucketed posting series over an arbitrary [start_ts, end_ts] window, summed
    across every bot in ``bot_names``. Parsed from the durable per-bot log files
    (the same source of truth as :func:`compute_analytics`).
    """
    start_ts = float(start_ts)
    end_ts = float(end_ts)
    if end_ts <= start_ts:
        end_ts = start_ts + 60.0

    bucket_seconds = _pick_bucket(end_ts - start_ts)
    first_bucket = int(start_ts // bucket_seconds) * bucket_seconds
    count = int((end_ts - first_bucket) // bucket_seconds) + 1
    count = max(1, min(count, _MAX_POINTS + 2))

    points = [{"ts": first_bucket + i * bucket_seconds, "sent": 0, "failed": 0} for i in range(count)]
    total_sent = total_failed = 0
    bots_with_data = 0
    per_bot: list[dict] = []

    for name in bot_names:
        path = _resolve_log_path(name)
        if path is None:
            continue
        b_sent = b_failed = 0
        for ts, ok in _parse_events(path):
            if ts < start_ts or ts > end_ts:
                continue
            idx = int((ts - first_bucket) // bucket_seconds)
            if 0 <= idx < count:
                points[idx]["sent" if ok else "failed"] += 1
            if ok:
                b_sent += 1
            else:
                b_failed += 1
        if b_sent or b_failed:
            bots_with_data += 1
            total_sent += b_sent
            total_failed += b_failed
            per_bot.append({"name": name, "sent": b_sent, "failed": b_failed})

    per_bot.sort(key=lambda x: (x["failed"], x["sent"]), reverse=True)

    return {
        "start": start_ts,
        "end": end_ts,
        "bucket_seconds": bucket_seconds,
        "points": points,
        "total_sent": total_sent,
        "total_failed": total_failed,
        "bots_with_data": bots_with_data,
        "per_bot": per_bot,
        "generated_at": time.time(),
    }


# ── Failure-reason breakdown ────────────────────────────────────────────────
_FAIL_LINE_RE = re.compile(
    r"^\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+.*?\[(POST_FAILURE|FLOOD_WAIT)\]\s*(.*)$"
)
_ACCOUNT_RE = re.compile(r"account=([^\s]+)")

# category key -> human label, in the order we want them surfaced.
FAILURE_LABELS: dict[str, str] = {
    "flood_wait": "Flood wait",
    "peer_flood": "Peer flood",
    "banned": "Banned",
    "private": "Channel private",
    "no_permission": "No permission",
    "topic_closed": "Topic closed",
    "payment_required": "Payment required",
    "auth": "Auth expired",
    "frozen": "Frozen",
    "unknown": "Unknown",
}


def _categorize_failure(text: str) -> str:
    m = (text or "").lower()
    if "flood" in m and "wait" in m:
        return "flood_wait"
    if "peer_flood" in m or "peer flood" in m:
        return "peer_flood"
    if "channel_private" in m or "channel private" in m or "channelprivate" in m:
        return "private"
    if "banned" in m or "userbanned" in m or "user_banned" in m:
        return "banned"
    if (
        "write forbidden" in m or "chat_write_forbidden" in m or "chatwriteforbidden" in m
        or "can't write" in m or "cant write" in m or "send message forbidden" in m
    ):
        return "no_permission"
    if "topic_closed" in m or "topic closed" in m or "topic_deleted" in m:
        return "topic_closed"
    if "payment_required" in m or "allow_payment_required" in m or "paid" in m and "post" in m:
        return "payment_required"
    if "auth" in m or "unauthorized" in m or "revoked" in m or "unregistered" in m:
        return "auth"
    if "frozen" in m:
        return "frozen"
    return "unknown"


def compute_failure_reasons(bot_names: list[str], since_ts: float) -> dict:
    """Tally `[POST_FAILURE]`/`[FLOOD_WAIT]` log lines since ``since_ts`` across all bots,
    grouped by categorized reason with the affected accounts for each."""
    counts: dict[str, int] = {}
    sessions: dict[str, set[str]] = {}
    total = 0

    for name in bot_names:
        path = _resolve_log_path(name)
        if path is None:
            continue
        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if "[POST_FAILURE]" not in line and "[FLOOD_WAIT]" not in line:
                    continue
                m = _FAIL_LINE_RE.match(line)
                if not m:
                    continue
                try:
                    dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                if dt.timestamp() < since_ts:
                    continue
                tag, rest = m.group(3), m.group(4)
                cat = "flood_wait" if tag == "FLOOD_WAIT" else _categorize_failure(rest)
                counts[cat] = counts.get(cat, 0) + 1
                total += 1
                acc = _ACCOUNT_RE.search(rest)
                if acc:
                    sessions.setdefault(cat, set()).add(acc.group(1))

    reasons = [
        {
            "key": key,
            "label": FAILURE_LABELS.get(key, key.title()),
            "count": counts[key],
            "sessions": sorted(sessions.get(key, set()))[:12],
        }
        for key in counts
    ]
    reasons.sort(key=lambda r: r["count"], reverse=True)
    return {"total": total, "reasons": reasons, "generated_at": time.time()}


# ── Per-session activity (Admin → AdBot → Sessions) ─────────────────────────
# Every posting attempt is logged as `[TAG] account=<file-without-.session> ...`
# (see code/users.py). We parse those lines to derive real per-account counters
# (sent / failed / flood) within a time window, plus the lifetime last-active and
# last-error, keyed by session file — the stable identifier for a session.
_SESSION_LINE_RE = re.compile(
    r"^\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+.*?"
    r"\[(POST_SUCCESS|POST_FAILURE|FLOOD_WAIT|POST_SKIPPED)\]\s+account=(\S+)(.*)$"
)
_ERROR_RE = re.compile(r"error=(.+)$")


def _new_session_activity() -> dict:
    return {
        "sent": 0,
        "failed": 0,
        "flood": 0,
        "skipped": 0,
        "last_active_ts": 0.0,
        "last_error": "",
        "last_error_ts": 0.0,
    }


def compute_session_activity(bot_name: str, since_ts: float) -> dict[str, dict]:
    """Parse a bot's log once and return per-account activity.

    Windowed counters (``sent`` / ``failed`` / ``flood`` / ``skipped``) only tally
    lines at or after ``since_ts`` (pass 0 for "all time"). ``last_active_ts`` and
    ``last_error`` are always the most-recent seen across the whole file, so the
    card can show the true last error/activity regardless of the selected range.

    Keys are the session **file name** including the ``.session`` suffix, matching
    ``cfg["sessions"][i]["file"]``.
    """
    out: dict[str, dict] = {}
    path = _resolve_log_path(bot_name)
    if path is None:
        return out
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return out

    with fh:
        for line in fh:
            if "] account=" not in line:
                continue
            m = _SESSION_LINE_RE.match(line)
            if not m:
                continue
            try:
                dt = datetime.strptime(
                    f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S"
                ).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            ts = dt.timestamp()
            tag, account, rest = m.group(3), m.group(4), m.group(5)
            # Normalize account -> session file name (log strips the .session suffix).
            fn = account if account.endswith(".session") else f"{account}.session"
            entry = out.get(fn)
            if entry is None:
                entry = out[fn] = _new_session_activity()

            in_window = ts >= since_ts
            if tag == "POST_SUCCESS":
                if in_window:
                    entry["sent"] += 1
                if ts > entry["last_active_ts"]:
                    entry["last_active_ts"] = ts
            elif tag == "POST_FAILURE":
                if in_window:
                    entry["failed"] += 1
                if ts > entry["last_active_ts"]:
                    entry["last_active_ts"] = ts
                if ts >= entry["last_error_ts"]:
                    em = _ERROR_RE.search(rest)
                    reason = (em.group(1).strip() if em else rest.strip())[:200]
                    # Strip the surrounding repr() quotes the logger adds.
                    if len(reason) >= 2 and reason[0] in "'\"" and reason[-1] == reason[0]:
                        reason = reason[1:-1]
                    entry["last_error"] = reason
                    entry["last_error_ts"] = ts
            elif tag == "FLOOD_WAIT":
                if in_window:
                    entry["flood"] += 1
            elif tag == "POST_SKIPPED":
                if in_window:
                    entry["skipped"] += 1

    return out
