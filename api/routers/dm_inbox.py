"""Admin oversight of DM auto-reply: every DM received across every AdBot, in one place."""
import asyncio
from fastapi import APIRouter, Depends, Query

from api.deps import get_current_admin

router = APIRouter(prefix="/api/system/dm-inbox", tags=["dm-inbox"], dependencies=[Depends(get_current_admin)])


def _aggregate(bot_filter: str = "", account_filter: str = "") -> dict:
    from code import dm_inbox as store
    from code.utils import load_user_data

    rows: list[dict] = []
    bots: list[str] = []
    for name in store.list_inbox_bots():
        bots.append(name)
        if bot_filter and name != bot_filter:
            continue
        try:
            cfg = load_user_data(name) or {}
        except Exception:
            cfg = {}
        bot_username = cfg.get("bot_username", "")
        owner_id = cfg.get("owner_id", 0)
        owner_name = cfg.get("ref_name") or cfg.get("owner_name") or ""
        owner_email = cfg.get("ref_email") or cfg.get("owner_email") or ""
        for it in store.load_inbox(name):
            if account_filter and it.get("session_file") != account_filter:
                continue
            rows.append({
                **it,
                "bot_name": name,
                "bot_username": bot_username,
                "owner_id": owner_id,
                "owner_name": owner_name,
                "owner_email": owner_email,
            })
    rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
    accounts = sorted({r.get("session_file", "") for r in rows if r.get("session_file")})
    return {"messages": rows[:500], "bots": sorted(bots), "accounts": accounts}


@router.get("")
async def admin_list_dm_inbox(bot: str = Query(""), account: str = Query("")):
    return await asyncio.to_thread(_aggregate, bot, account)
