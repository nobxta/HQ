"""Customer/user management endpoints: search, extend, freeze, transfer."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_admin
from api.services import wrappers
from api.services.serializers import serialize_bot_summary
from api.schemas import OrderActionResponse

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(get_current_admin)])


@router.get("/search")
async def search_users(
    telegram_id: int = Query(None),
    bot_username: str = Query(None),
    plan: str = Query(None),
):
    from code.admin_control import (
        user_search_by_telegram_id,
        user_search_by_bot_username,
        user_search_by_plan_type,
    )

    results = []

    if telegram_id:
        bots = await asyncio.to_thread(user_search_by_telegram_id, telegram_id)
        results = bots

    elif bot_username:
        bot = await asyncio.to_thread(user_search_by_bot_username, bot_username)
        if bot:
            results = [bot]

    elif plan:
        bots = await asyncio.to_thread(user_search_by_plan_type, plan)
        results = bots

    else:
        raise HTTPException(400, "Provide telegram_id, bot_username, or plan filter")

    return {"results": results, "total": len(results)}


@router.get("/{telegram_id}")
async def get_user(telegram_id: int):
    from code.admin_control import user_search_by_telegram_id
    bots = await asyncio.to_thread(user_search_by_telegram_id, telegram_id)

    orders = await wrappers.search_orders(user_id=telegram_id)
    from api.services.serializers import serialize_order
    serialized_orders = [serialize_order(o) for o in orders]

    return {
        "telegram_id": telegram_id,
        "bots": bots,
        "orders": serialized_orders,
        "bot_count": len(bots),
        "order_count": len(serialized_orders),
    }


@router.post("/{telegram_id}/extend", response_model=OrderActionResponse)
async def extend_user_plan(telegram_id: int, bot_name: str = Query(...), days: int = Query(..., ge=1)):
    token = await wrappers.get_token_by_name(bot_name)
    if not token:
        raise HTTPException(404, f"Bot '{bot_name}' not found")

    success, msg = await wrappers.user_extend_plan(token, days)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "extend_plan", target=f"{bot_name} +{days}d")
    return OrderActionResponse(success=True, message=msg)


@router.post("/{telegram_id}/freeze", response_model=OrderActionResponse)
async def freeze_user(telegram_id: int, bot_name: str = Query(...), freeze: bool = Query(True)):
    token = await wrappers.get_token_by_name(bot_name)
    if not token:
        raise HTTPException(404, f"Bot '{bot_name}' not found")

    success, msg = await wrappers.user_freeze(token, freeze)
    if not success:
        raise HTTPException(400, msg)

    action = "freeze_bot" if freeze else "unfreeze_bot"
    await wrappers.log_admin_action("web_admin", action, target=bot_name)
    return OrderActionResponse(success=True, message=msg)


@router.post("/{telegram_id}/transfer", response_model=OrderActionResponse)
async def transfer_ownership(telegram_id: int, bot_name: str = Query(...), new_owner_id: int = Query(...)):
    token = await wrappers.get_token_by_name(bot_name)
    if not token:
        raise HTTPException(404, f"Bot '{bot_name}' not found")

    success, msg = await wrappers.user_transfer_ownership(token, new_owner_id)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "transfer_bot", target=f"{bot_name} → {new_owner_id}")
    return OrderActionResponse(success=True, message=msg)
