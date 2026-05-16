"""Broadcast endpoints: segments, send, history."""
import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_current_admin
from api.services import wrappers
from api.schemas import BroadcastRequest, BroadcastResponse

router = APIRouter(prefix="/api/broadcast", tags=["broadcast"], dependencies=[Depends(get_current_admin)])


@router.get("/segments")
async def list_segments():
    users = await wrappers.load_broadcast_users()
    return {
        "segments": {
            "all_users": {
                "count": len(users.get("all_users", [])),
                "description": "All shop bot visitors",
            },
            "plan_users": {
                "count": len(users.get("plan_users", [])),
                "description": "Users who purchased a plan",
            },
        }
    }


@router.get("/segments/{segment}")
async def get_segment_users(segment: str):
    ids = await wrappers.broadcast_segment_user_ids(segment)
    return {"segment": segment, "user_ids": ids, "count": len(ids)}


@router.post("/send", response_model=BroadcastResponse)
async def send_broadcast(body: BroadcastRequest):
    from code.config import SHOP_BOT_TOKEN, ADMIN_BOT_TOKEN
    from code.admin_control import broadcast_log_append

    ids = await wrappers.broadcast_segment_user_ids(body.segment)
    if not ids:
        raise HTTPException(400, f"Segment '{body.segment}' is empty")

    bot_token = SHOP_BOT_TOKEN or ADMIN_BOT_TOKEN
    if not bot_token:
        raise HTTPException(500, "No bot token available for broadcasting")

    from api.services.wrappers import run_sync
    from code.bot_ptb import send_message_with_bot

    sent = 0
    failed = 0
    for uid in ids:
        try:
            success = await send_message_with_bot(uid, body.text, bot_token=bot_token)
            if success:
                sent += 1
            else:
                failed += 1
        except Exception:
            failed += 1
        if sent % 30 == 0 and sent > 0:
            await asyncio.sleep(1)

    await asyncio.to_thread(broadcast_log_append, body.segment, len(ids), sent, failed)
    await wrappers.log_admin_action("web_admin", "broadcast", target=f"{body.segment}: {sent}/{len(ids)}")

    return BroadcastResponse(sent=sent, failed=failed, total=len(ids))


@router.get("/history")
async def broadcast_history():
    from code.config import DATA_BROADCAST_LOG_FILE
    if not DATA_BROADCAST_LOG_FILE.is_file():
        return {"history": [], "total": 0}

    try:
        data = json.loads(await asyncio.to_thread(DATA_BROADCAST_LOG_FILE.read_text, "utf-8"))
        entries = data if isinstance(data, list) else data.get("entries", [])
        entries.sort(key=lambda e: e.get("ts", 0), reverse=True)
        return {"history": entries[:50], "total": len(entries)}
    except Exception:
        return {"history": [], "total": 0}
