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
    """Build a bucketed series for ``range_key`` plus rolling-window summary counters."""
    bucket_seconds, count = RANGE_CONFIG.get(range_key, RANGE_CONFIG[DEFAULT_RANGE])
    now = time.time()
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
        "range": range_key if range_key in RANGE_CONFIG else DEFAULT_RANGE,
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
