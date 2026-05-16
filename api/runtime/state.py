"""Shared runtime state between the API layer and the existing bot system."""
import asyncio
from typing import Any, Optional

_main_loop: Optional[asyncio.AbstractEventLoop] = None
_api_started: bool = False


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def get_main_loop() -> Optional[asyncio.AbstractEventLoop]:
    return _main_loop


def mark_api_started() -> None:
    global _api_started
    _api_started = True


def is_api_running() -> bool:
    return _api_started
