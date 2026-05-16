"""WebSocket handlers for real-time dashboard, logs, and posting events."""
import asyncio
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from api.deps import validate_ws_token
from api.runtime.pubsub import subscribe, unsubscribe
from api.services.events import (
    CHANNEL_DASHBOARD, CHANNEL_BOT_LOGS, CHANNEL_BOT_POSTING,
    CHANNEL_CREATE_PROGRESS, CHANNEL_CHATLIST_PROGRESS, CHANNEL_BOT_CONTROL,
)

logger = logging.getLogger("api.websocket")
router = APIRouter(tags=["websocket"])


async def _ws_auth(websocket: WebSocket, token: str = None) -> bool:
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return False
    if not validate_ws_token(token):
        await websocket.close(code=4003, reason="Invalid or expired token")
        return False
    return True


async def _stream_channel(websocket: WebSocket, channel: str):
    """Generic: subscribe to channel, stream messages until disconnect."""
    queue = await subscribe(channel)
    try:
        while True:
            message = await queue.get()
            try:
                await websocket.send_json(message)
            except Exception:
                break
    except asyncio.CancelledError:
        pass
    finally:
        await unsubscribe(channel, queue)


@router.websocket("/ws/dashboard")
async def ws_dashboard(websocket: WebSocket, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: dashboard")

    try:
        await _stream_channel(websocket, CHANNEL_DASHBOARD)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: dashboard")


@router.websocket("/ws/bots/{name}/logs")
async def ws_bot_logs(websocket: WebSocket, name: str, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: bot logs [%s]", name)

    channel = CHANNEL_BOT_LOGS.format(name=name)
    try:
        await _stream_channel(websocket, channel)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: bot logs [%s]", name)


@router.websocket("/ws/bots/{name}/posting")
async def ws_bot_posting(websocket: WebSocket, name: str, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: bot posting [%s]", name)

    channel = CHANNEL_BOT_POSTING.format(name=name)
    try:
        await _stream_channel(websocket, channel)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: bot posting [%s]", name)


@router.websocket("/ws/create/{name}")
async def ws_create_progress(websocket: WebSocket, name: str, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: create progress [%s]", name)

    channel = CHANNEL_CREATE_PROGRESS.format(name=name)
    try:
        await _stream_channel(websocket, channel)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: create progress [%s]", name)


@router.websocket("/ws/chatlist/{name}")
async def ws_chatlist_progress(websocket: WebSocket, name: str, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: chatlist progress [%s]", name)

    channel = CHANNEL_CHATLIST_PROGRESS.format(name=name)
    try:
        await _stream_channel(websocket, channel)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: chatlist progress [%s]", name)


@router.websocket("/ws/control/{name}")
async def ws_bot_control(websocket: WebSocket, name: str, token: str = Query(None)):
    if not await _ws_auth(websocket, token):
        return
    await websocket.accept()
    logger.info("WebSocket connected: bot control [%s]", name)

    channel = CHANNEL_BOT_CONTROL.format(name=name)
    try:
        await _stream_channel(websocket, channel)
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("WebSocket disconnected: bot control [%s]", name)
