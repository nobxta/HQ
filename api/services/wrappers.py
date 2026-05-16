"""Async wrappers around existing sync functions. No logic changes."""
import asyncio
from typing import Any, Optional


async def run_sync(func, *args, **kwargs) -> Any:
    """Run a synchronous function in a thread pool executor."""
    if kwargs:
        return await asyncio.to_thread(lambda: func(*args, **kwargs))
    return await asyncio.to_thread(func, *args)


async def load_adbot() -> dict:
    from code.utils import load_adbot as _load_adbot
    return await asyncio.to_thread(_load_adbot)


async def save_adbot(data: dict) -> None:
    from code.utils import save_adbot as _save_adbot
    await asyncio.to_thread(_save_adbot, data)


async def load_pool() -> dict:
    from code.utils import load_pool as _load_pool
    return await asyncio.to_thread(_load_pool)


async def save_pool(data: dict) -> None:
    from code.utils import save_pool as _save_pool
    await asyncio.to_thread(_save_pool, data)


async def load_user_data(name: str) -> dict:
    from code.utils import load_user_data as _load_user_data
    return await asyncio.to_thread(_load_user_data, name)


async def save_user_data(name: str, cfg: dict) -> None:
    from code.utils import save_user_data as _save_user_data
    await asyncio.to_thread(_save_user_data, name, cfg)


async def load_orders() -> list:
    from code.shop.storage import load_orders as _load_orders
    return await asyncio.to_thread(_load_orders)


async def load_plans() -> dict:
    from code.shop.storage import load_plans as _load_plans
    return await asyncio.to_thread(_load_plans)


async def search_orders(
    order_id: Optional[str] = None,
    payment_id: Optional[str] = None,
    user_id: Optional[int] = None,
) -> list:
    from code.shop.storage import search_orders as _search_orders
    return await asyncio.to_thread(_search_orders, order_id, payment_id, user_id)


async def order_mark_paid(order_id: str, trigger_creation: bool = True) -> tuple:
    from code.admin_control import order_mark_paid as _mark_paid
    return await asyncio.to_thread(_mark_paid, order_id, trigger_creation)


async def order_cancel(order_id: str) -> tuple:
    from code.admin_control import order_cancel as _cancel
    return await asyncio.to_thread(_cancel, order_id)


async def user_extend_plan(bot_token: str, days: int) -> tuple:
    from code.admin_control import user_extend_plan as _extend
    return await asyncio.to_thread(_extend, bot_token, days)


async def user_freeze(bot_token: str, freeze: bool) -> tuple:
    from code.admin_control import user_freeze as _freeze
    return await asyncio.to_thread(_freeze, bot_token, freeze)


async def user_set_suspended(bot_token: str, suspended: bool) -> tuple:
    from code.admin_control import user_set_suspended as _suspend
    return await asyncio.to_thread(_suspend, bot_token, suspended)


async def user_transfer_ownership(bot_token: str, new_user_id: int) -> tuple:
    from code.admin_control import user_transfer_ownership as _transfer
    return await asyncio.to_thread(_transfer, bot_token, new_user_id)


async def session_full_list() -> list:
    from code.admin_control import session_full_list as _list
    return await asyncio.to_thread(_list)


async def session_move(file_name: str, from_bucket: str, to_bucket: str) -> tuple:
    from code.admin_control import session_move as _move
    return await asyncio.to_thread(_move, file_name, from_bucket, to_bucket)


async def dashboard_counts() -> dict:
    from code.admin_control import dashboard_counts as _counts
    return await asyncio.to_thread(_counts)


async def emergency_stop(admin_id: Optional[int] = None) -> tuple:
    from code.admin_control import emergency_stop_all_posting as _stop
    return await asyncio.to_thread(_stop, admin_id)


async def emergency_resume(admin_id: Optional[int] = None) -> tuple:
    from code.admin_control import emergency_resume_all_posting as _resume
    return await asyncio.to_thread(_resume, admin_id)


async def broadcast_segment_user_ids(segment: str) -> list:
    from code.admin_control import broadcast_segment_user_ids as _ids
    return await asyncio.to_thread(_ids, segment)


async def is_maintenance_enabled() -> bool:
    from code.maintenance import is_maintenance_enabled as _check
    return await asyncio.to_thread(_check)


async def set_maintenance(enabled: bool) -> None:
    from code.maintenance import save_maintenance as _save
    await asyncio.to_thread(_save, enabled)


async def log_admin_action(admin_id: Any, action: str, target: str = "") -> None:
    from code.audit import log_admin_action as _log
    await asyncio.to_thread(_log, admin_id, action, target=target)


async def validate_session(path) -> tuple:
    from code.utils import validate_session_with_reason as _validate
    return await asyncio.to_thread(_validate, path)


async def get_name_by_token(bot_token: str) -> Optional[str]:
    from code.utils import get_name_by_token as _get
    return await asyncio.to_thread(_get, bot_token)


async def get_token_by_name(name: str) -> Optional[str]:
    """Lookup bot_token from bot name by scanning user data."""
    data = await load_adbot()
    for token, cfg in data.get("bots", {}).items():
        if cfg.get("name") == name:
            return token
    return None


async def start_posting(bot_token: str, update_status=None) -> bool:
    from code.users import _start_posting
    return await _start_posting(bot_token, update_status=update_status)


async def stop_posting(bot_token: str) -> None:
    from code.users import _stop_posting
    await _stop_posting(bot_token)


async def get_stats_for_display(bot_token: str) -> dict:
    from code.users import _get_stats_for_display
    return await asyncio.to_thread(_get_stats_for_display, bot_token)


async def load_broadcast_users() -> dict:
    from code.broadcast_users import load_broadcast_users as _load
    return await asyncio.to_thread(_load)
