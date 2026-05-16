"""
Persistent broadcast user database.
Segments: all_users (every ShopBot /start), plan_users (ever purchased an AdBot).
Broadcast always reads from this file; no recomputation at send time.
"""
import json
import logging
from pathlib import Path
from typing import Any

from . import config

logger = logging.getLogger(__name__)

BROADCAST_USERS_FILE = config.DATA_BROADCAST_USERS_FILE


def load_broadcast_users() -> dict[str, list[int]]:
    """Load broadcast user lists. Returns {"all_users": [...], "plan_users": [...]}."""
    if not BROADCAST_USERS_FILE.exists():
        return {"all_users": [], "plan_users": []}
    try:
        data = json.loads(BROADCAST_USERS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"all_users": [], "plan_users": []}
        all_u = data.get("all_users")
        plan_u = data.get("plan_users")
        return {
            "all_users": list(all_u) if isinstance(all_u, list) else [],
            "plan_users": list(plan_u) if isinstance(plan_u, list) else [],
        }
    except Exception as e:
        logger.warning("Could not load broadcast_users.json: %s", e)
        return {"all_users": [], "plan_users": []}


def save_broadcast_users(data: dict[str, list[int]]) -> None:
    """Save atomically: write to temp file then rename."""
    path = BROADCAST_USERS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(
            json.dumps({"all_users": data.get("all_users", []), "plan_users": data.get("plan_users", [])}, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)
    except Exception as e:
        logger.warning("Could not save broadcast_users.json: %s", e)
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass


def add_all_user(user_id: int) -> None:
    """Add user_id to all_users (ShopBot visitors). Deduplicated, atomic."""
    if user_id is None:
        return
    uid = int(user_id)
    data = load_broadcast_users()
    lst = data["all_users"]
    if uid in lst:
        return
    data["all_users"] = lst + [uid]
    save_broadcast_users(data)


def add_plan_user(user_id: int) -> None:
    """Add user_id to plan_users (ever purchased). Deduplicated, atomic. Never remove on expiry."""
    if user_id is None:
        return
    uid = int(user_id)
    data = load_broadcast_users()
    lst = data["plan_users"]
    if uid in lst:
        return
    data["plan_users"] = lst + [uid]
    save_broadcast_users(data)
