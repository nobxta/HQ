"""In-process pub/sub for WebSocket event fan-out. No Redis required."""
import asyncio
import time
from collections import defaultdict
from typing import Any

_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
_lock = asyncio.Lock()


async def subscribe(channel: str, maxsize: int = 256) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
    async with _lock:
        _subscribers[channel].add(q)
    return q


async def unsubscribe(channel: str, q: asyncio.Queue) -> None:
    async with _lock:
        _subscribers[channel].discard(q)
        if not _subscribers[channel]:
            del _subscribers[channel]


async def publish(channel: str, message: dict[str, Any]) -> int:
    """Publish message to all subscribers on channel. Returns delivery count."""
    message.setdefault("ts", time.time())
    async with _lock:
        queues = list(_subscribers.get(channel, set()))
    delivered = 0
    for q in queues:
        try:
            q.put_nowait(message)
            delivered += 1
        except asyncio.QueueFull:
            try:
                q.get_nowait()
                q.put_nowait(message)
                delivered += 1
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass
    return delivered


def publish_sync(channel: str, message: dict[str, Any]) -> None:
    """Fire-and-forget publish from sync context (worker callbacks)."""
    message.setdefault("ts", time.time())
    queues = list(_subscribers.get(channel, set()))
    for q in queues:
        try:
            q.put_nowait(message)
        except (asyncio.QueueFull, Exception):
            pass


def active_channels() -> list[str]:
    return list(_subscribers.keys())


def subscriber_count(channel: str) -> int:
    return len(_subscribers.get(channel, set()))
