"""User portal endpoints: login by token, view own bot, update settings."""
import asyncio
import random
import string
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional

from api.auth import (
    create_portal_access_token, create_portal_refresh_token,
    PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
)
from api.services import wrappers
from api.services.serializers import serialize_bot_detail, serialize_stats, serialize_order


def _generate_web_token(length: int = 8) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choices(chars, k=length))

router = APIRouter(prefix="/api/portal", tags=["portal"])


class PortalLoginRequest(BaseModel):
    telegram_id: int
    bot_name: str


class PortalTokenLoginRequest(BaseModel):
    token: str


class PortalTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = 900
    bot_name: str
    telegram_id: int


class UnifiedLoginRequest(BaseModel):
    code: str


class SetWebTokenRequest(BaseModel):
    web_token: Optional[str] = None  # if None, auto-generate


class UnifiedLoginResponse(BaseModel):
    role: str  # "admin" or "user"
    access_token: str
    refresh_token: str
    expires_in: int
    bot_name: str = ""
    telegram_id: int = 0


class PortalUpdateMessage(BaseModel):
    message_text: Optional[str] = None
    message_mode: Optional[str] = None


class PortalUpdateLinks(BaseModel):
    post_links: list[str]


class PortalUpdateSettings(BaseModel):
    cycle: Optional[int] = None
    gap: Optional[int] = None


class PortalUpdateAuth(BaseModel):
    authorized: list[int]


class PortalUpdateChatlist(BaseModel):
    links: list[str]


class PortalRenewRequest(BaseModel):
    duration_days: int  # 7 or 30
    currency: str  # e.g. "BTC", "USDT_TRC20"


async def _get_user_bot(telegram_id: int, bot_name: str):
    """Find a bot the user is authorized on."""
    data = await wrappers.load_adbot()
    for token, cfg in data.get("bots", {}).items():
        if cfg.get("name") != bot_name:
            continue
        authorized = cfg.get("authorized", [])
        owner_id = cfg.get("owner_id")
        if telegram_id in authorized or telegram_id == owner_id:
            return token, cfg
        if telegram_id == 0 and owner_id in (None, 0):
            return token, cfg
        raise HTTPException(403, "You are not authorized on this bot")
    raise HTTPException(404, f"Bot '{bot_name}' not found")


async def _get_user_bots(telegram_id: int) -> list:
    """Find all bots a user is authorized on."""
    data = await wrappers.load_adbot()
    results = []
    for token, cfg in data.get("bots", {}).items():
        authorized = cfg.get("authorized", [])
        owner_id = cfg.get("owner_id")
        if telegram_id in authorized or telegram_id == owner_id:
            results.append((token, cfg))
    return results


@router.post("/login", response_model=PortalTokenResponse)
async def portal_login(body: PortalLoginRequest):
    bots = await _get_user_bots(body.telegram_id)
    if not bots:
        raise HTTPException(401, "No bots found for this Telegram ID")

    found = False
    for token, cfg in bots:
        if cfg.get("name") == body.bot_name:
            found = True
            break

    if not found:
        raise HTTPException(403, "You are not authorized on this bot")

    subject = f"user:{body.telegram_id}:{body.bot_name}"
    return PortalTokenResponse(
        access_token=create_portal_access_token(subject),
        refresh_token=create_portal_refresh_token(subject),
        expires_in=PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
        bot_name=body.bot_name,
        telegram_id=body.telegram_id,
    )


@router.post("/login-token")
async def portal_login_token(body: PortalTokenLoginRequest, request: Request):
    """Login with a web_token. Each bot has a unique web_token in its config."""
    import time as _time
    token_input = body.token.strip()
    if not token_input:
        raise HTTPException(401, "Token is required")

    client_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not client_ip:
        client_ip = request.client.host if request.client else "unknown"

    data = await wrappers.load_adbot()
    for bot_token, cfg in data.get("bots", {}).items():
        wt = cfg.get("web_token", "")
        if wt and wt == token_input:
            owner_id = cfg.get("owner_id", 0)
            bot_name = cfg.get("name", "")
            subject = f"user:{owner_id}:{bot_name}"

            # Track login
            cfg["last_web_login"] = {"ip": client_ip, "time": _time.time(), "ts": _time.strftime("%Y-%m-%d %H:%M:%S")}
            login_history = cfg.get("web_login_history") or []
            login_history.append({"ip": client_ip, "time": _time.time(), "ts": _time.strftime("%Y-%m-%d %H:%M:%S")})
            cfg["web_login_history"] = login_history[-20:]
            await wrappers.save_adbot(data)

            return PortalTokenResponse(
                access_token=create_portal_access_token(subject),
                refresh_token=create_portal_refresh_token(subject),
                expires_in=PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
                bot_name=bot_name,
                telegram_id=owner_id,
            )

    raise HTTPException(401, "Invalid token")


@router.post("/unified-login", response_model=UnifiedLoginResponse)
async def unified_login(body: UnifiedLoginRequest, request: Request):
    """Single login endpoint: tries admin password first, then user web_token."""
    import time as _time
    code = body.code.strip()
    if not code:
        raise HTTPException(401, "Code is required")

    # Get client IP (support X-Forwarded-For for proxied setups)
    client_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not client_ip:
        client_ip = request.client.host if request.client else "unknown"

    # 1. Try admin password
    from api.auth import authenticate_admin, create_access_token, create_refresh_token, ACCESS_TOKEN_EXPIRE_SEC
    from api.auth import WEB_ADMIN_USER
    if authenticate_admin(WEB_ADMIN_USER, code):
        return UnifiedLoginResponse(
            role="admin",
            access_token=create_access_token(WEB_ADMIN_USER),
            refresh_token=create_refresh_token(WEB_ADMIN_USER),
            expires_in=ACCESS_TOKEN_EXPIRE_SEC,
        )

    # 2. Try user web_token
    data = await wrappers.load_adbot()
    for bot_token, cfg in data.get("bots", {}).items():
        wt = cfg.get("web_token", "")
        if wt and wt == code:
            owner_id = cfg.get("owner_id", 0)
            bot_name = cfg.get("name", "")
            subject = f"user:{owner_id}:{bot_name}"

            # Track login info
            cfg["last_web_login"] = {
                "ip": client_ip,
                "time": _time.time(),
                "ts": _time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            # Append to login history (keep last 20)
            login_history = cfg.get("web_login_history") or []
            login_history.append({
                "ip": client_ip,
                "time": _time.time(),
                "ts": _time.strftime("%Y-%m-%d %H:%M:%S"),
            })
            cfg["web_login_history"] = login_history[-20:]
            await wrappers.save_adbot(data)

            return UnifiedLoginResponse(
                role="user",
                access_token=create_portal_access_token(subject),
                refresh_token=create_portal_refresh_token(subject),
                expires_in=PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
                bot_name=bot_name,
                telegram_id=owner_id,
            )

    raise HTTPException(401, "Invalid code")


@router.post("/generate-web-token/{bot_name}")
async def generate_web_token(bot_name: str, telegram_id: int = Query(...)):
    """Generate or regenerate a web_token for a bot."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    new_web_token = _generate_web_token()
    data = await wrappers.load_adbot()
    data["bots"][token]["web_token"] = new_web_token
    await wrappers.save_adbot(data)
    return {"web_token": new_web_token}


@router.get("/web-token/{bot_name}")
async def get_web_token(bot_name: str, telegram_id: int = Query(...)):
    """Get or create the web_token for a bot."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    wt = cfg.get("web_token", "")
    if not wt:
        wt = _generate_web_token()
        data = await wrappers.load_adbot()
        data["bots"][token]["web_token"] = wt
        await wrappers.save_adbot(data)
    return {"web_token": wt}


@router.get("/bots")
async def portal_list_bots(telegram_id: int = Query(...)):
    bots = await _get_user_bots(telegram_id)
    if not bots:
        return {"bots": []}

    result = []
    for token, cfg in bots:
        result.append({
            "name": cfg.get("name", ""),
            "bot_username": cfg.get("bot_username", ""),
            "state": cfg.get("state", "stopped"),
            "mode": cfg.get("mode", "starter"),
            "valid_till": cfg.get("valid_till", ""),
        })
    return {"bots": result}


@router.get("/bot/{bot_name}")
async def portal_get_bot(bot_name: str, telegram_id: int = Query(...)):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    detail = serialize_bot_detail(token, cfg)
    detail["message_text"] = cfg.get("message_text", "")
    detail["message_mode"] = cfg.get("message_mode", "link")
    detail["post_links"] = cfg.get("post_links", [])
    detail["web_token"] = cfg.get("web_token", "")
    detail["renewal_price"] = cfg.get("renewal_price", "0")
    return detail


@router.get("/bot/{bot_name}/stats")
async def portal_get_stats(bot_name: str, telegram_id: int = Query(...)):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    stats = await wrappers.get_stats_for_display(token)
    return serialize_stats(stats)


@router.get("/bot/{bot_name}/logs")
async def portal_get_logs(bot_name: str, telegram_id: int = Query(...), lines: int = Query(100, ge=1, le=500)):
    await _get_user_bot(telegram_id, bot_name)
    from code.config import DATA_LOGS_DIR
    from code.utils import name_to_filename
    log_path = DATA_LOGS_DIR / f"{bot_name}.log"
    if not log_path.is_file():
        log_path = DATA_LOGS_DIR / f"{name_to_filename(bot_name)}.log"
    if not log_path.is_file():
        return {"lines": [], "total_lines": 0}
    try:
        content = await asyncio.to_thread(log_path.read_text, "utf-8", "replace")
        all_lines = content.splitlines()
        tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {"lines": tail, "total_lines": len(all_lines)}
    except Exception as e:
        raise HTTPException(500, f"Failed to read logs: {e}")


@router.get("/bot/{bot_name}/orders")
async def portal_get_orders(bot_name: str, telegram_id: int = Query(...)):
    await _get_user_bot(telegram_id, bot_name)
    orders = await wrappers.search_orders(user_id=telegram_id)
    return {"orders": [serialize_order(o) for o in orders]}


@router.post("/bot/{bot_name}/start")
async def portal_start_bot(bot_name: str, telegram_id: int = Query(...)):
    from api.services.events import emit_bot_control
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)

    emit_bot_control(name, "Initializing start...", status="progress", action="start")

    async def update_status(msg: str):
        emit_bot_control(name, msg, status="progress", action="start")

    try:
        result = await wrappers.start_posting(token, update_status=update_status)
        if not result:
            # Check what went wrong
            from code.users import _last_start_failure_reason
            reason = _last_start_failure_reason.get(token, "unknown")
            reason_map = {
                "already_running": "Bot is already running",
                "no_cfg": "Bot configuration not found",
                "suspended": "Bot is suspended — resume it first",
                "no_sessions": "No sessions configured",
                "no_valid_sessions": "No valid session files found",
                "no_groups": "No groups assigned to any session",
            }
            msg = reason_map.get(reason, f"Start returned False ({reason})")
            emit_bot_control(name, msg, status="failed", action="start")
            return {"status": "warning", "message": msg}
    except Exception as e:
        emit_bot_control(name, f"Failed to start: {e}", status="failed", action="start")
        raise HTTPException(500, f"Failed to start: {e}")

    emit_bot_control(name, f"Bot '{bot_name}' is now running", status="done", action="start")
    return {"status": "started", "message": f"Bot '{bot_name}' posting started"}


@router.post("/bot/{bot_name}/stop")
async def portal_stop_bot(bot_name: str, telegram_id: int = Query(...)):
    from api.services.events import emit_bot_control
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)

    emit_bot_control(name, "Stopping bot...", status="progress", action="stop")

    try:
        await wrappers.stop_posting(token)
    except Exception as e:
        emit_bot_control(name, f"Failed to stop: {e}", status="failed", action="stop")
        raise HTTPException(500, f"Failed to stop: {e}")

    emit_bot_control(name, f"Bot '{bot_name}' has been stopped", status="done", action="stop")
    return {"status": "stopped", "message": f"Bot '{bot_name}' posting stopped"}


@router.patch("/bot/{bot_name}/message")
async def portal_update_message(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateMessage = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    if body.message_text is not None:
        full_cfg["message_text"] = body.message_text[:500]
    if body.message_mode is not None:
        if body.message_mode not in ("text", "link"):
            raise HTTPException(400, "message_mode must be 'text' or 'link'")
        full_cfg["message_mode"] = body.message_mode
    await wrappers.save_user_data(name, full_cfg)
    return {"status": "updated", "message": "Message updated"}


@router.put("/bot/{bot_name}/links")
async def portal_update_links(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateLinks = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    full_cfg["post_links"] = body.post_links[:10]
    await wrappers.save_user_data(name, full_cfg)
    return {"status": "updated", "message": f"{len(body.post_links)} links saved"}


@router.patch("/bot/{bot_name}/settings")
async def portal_update_settings(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateSettings = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    if body.cycle is not None:
        if body.cycle < 60:
            raise HTTPException(400, "Minimum cycle is 60 seconds")
        full_cfg["cycle"] = body.cycle
        if "plan" in full_cfg:
            full_cfg["plan"]["cycle"] = body.cycle
    if body.gap is not None:
        if body.gap < 0 or body.gap > 60:
            raise HTTPException(400, "Gap must be 0-60 seconds")
        full_cfg["gap"] = body.gap
        if "plan" in full_cfg:
            full_cfg["plan"]["gap"] = body.gap
    await wrappers.save_user_data(name, full_cfg)
    return {"status": "updated", "message": "Settings updated"}


@router.put("/bot/{bot_name}/authorized")
async def portal_update_auth(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateAuth = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    if telegram_id not in body.authorized:
        body.authorized.append(telegram_id)
    full_cfg["authorized"] = body.authorized[:10]
    await wrappers.save_user_data(name, full_cfg)
    return {"status": "updated", "message": f"{len(body.authorized)} authorized users saved"}


@router.get("/bot/{bot_name}/groups")
async def portal_get_groups(bot_name: str, telegram_id: int = Query(...)):
    """Read the group file for a bot. Returns structured group data with names."""
    await _get_user_bot(telegram_id, bot_name)
    cfg = await wrappers.load_user_data(bot_name)
    group_file = (cfg or {}).get("group_file", "")
    if not group_file:
        return {"filename": "", "content": "", "lines": 0, "groups": []}
    from code.config import GROUPS_DIR
    from code.chatlist import parse_group_line
    filepath = GROUPS_DIR / group_file
    if not filepath.is_file():
        filepath = GROUPS_DIR / "user groups" / group_file
    if not filepath.is_file():
        return {"filename": group_file, "content": "", "lines": 0, "groups": []}
    content = await asyncio.to_thread(filepath.read_text, "utf-8", "replace")
    valid_lines = [l for l in content.splitlines() if l.strip()]
    groups = [parse_group_line(l) for l in valid_lines]
    return {"filename": group_file, "content": content, "lines": len(valid_lines), "groups": groups}


class PortalUpdateGroups(BaseModel):
    lines: list[str]


@router.put("/bot/{bot_name}/groups")
async def portal_update_groups(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateGroups = ...):
    """Update the group file contents directly (add, remove, reorder groups)."""
    await _get_user_bot(telegram_id, bot_name)
    cfg = await wrappers.load_user_data(bot_name)
    name = cfg.get("name", bot_name)
    group_file = (cfg or {}).get("group_file", "")
    if not group_file:
        raise HTTPException(400, "No group file configured. Set up a chatlist first.")
    from code.config import GROUPS_DIR
    filepath = GROUPS_DIR / group_file
    if not filepath.is_file():
        filepath = GROUPS_DIR / "user groups" / group_file
    if not filepath.parent.is_dir():
        filepath.parent.mkdir(parents=True, exist_ok=True)
    clean_lines = [l.strip() for l in body.lines if l.strip()]
    await asyncio.to_thread(filepath.write_text, "\n".join(clean_lines) + "\n", "utf-8")
    return {"status": "updated", "lines": len(clean_lines)}


@router.put("/bot/{bot_name}/chatlist")
async def portal_update_chatlist(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateChatlist = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)

    links = [l.strip() for l in body.links if l.strip()][:2]
    if not links:
        full_cfg.pop("custom_chatlist", None)
        await wrappers.save_user_data(name, full_cfg)
        from api.services.events import emit_chatlist_progress
        emit_chatlist_progress(name, "Chatlist cleared", status="done")
        return {"status": "updated", "message": "Chatlist cleared"}

    # Run chatlist setup with progress callback that emits to WebSocket
    from api.services.events import emit_chatlist_progress
    from code.chatlist import process_chatlist_setup

    async def progress_cb(msg: str):
        emit_chatlist_progress(name, msg, status="progress")

    emit_chatlist_progress(name, "Starting chatlist setup...", status="progress")

    success, message, count = await process_chatlist_setup(
        bot_token=token,
        user_name=name,
        links=links,
        cfg=full_cfg,
        progress_cb=progress_cb,
    )
    await wrappers.save_user_data(name, full_cfg)
    if not success:
        emit_chatlist_progress(name, message, status="failed")
        raise HTTPException(400, message)
    emit_chatlist_progress(name, message, status="done")
    return {"status": "updated", "message": message, "groups": count}


@router.get("/plans")
async def portal_get_plans():
    """Return available plans for renewal pricing display."""
    from code.shop.storage import load_plans
    return load_plans()


@router.get("/currencies")
async def portal_get_currencies():
    """Return supported crypto currencies for payment."""
    from code.shop.payment_constants import SUPPORTED_PAY_CURRENCIES
    # Group currencies for UI
    main = ["BTC", "ETH", "LTC", "XMR"]
    stablecoins = {
        "USDT": [
            {"label": "TRC-20", "code": "USDT_TRC20"},
            {"label": "BEP-20", "code": "USDT_BEP20"},
            {"label": "ERC-20", "code": "USDT_ERC20"},
            {"label": "SOL", "code": "USDT_SOL"},
        ],
        "USDC": [
            {"label": "BEP-20", "code": "USDC_BEP20"},
            {"label": "ERC-20", "code": "USDC_ERC20"},
            {"label": "SOL", "code": "USDC_SOL"},
        ],
    }
    more = ["TRX", "BNB", "DOGE", "XRP", "SOL", "MATIC", "ADA", "TON"]
    return {"main": main, "stablecoins": stablecoins, "more": more}


@router.post("/bot/{bot_name}/renew")
async def portal_create_renewal(bot_name: str, telegram_id: int = Query(...), body: PortalRenewRequest = ...):
    """Create a renewal order with NowPayments invoice. Returns payment details."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)

    if body.duration_days not in (7, 30):
        raise HTTPException(400, "Duration must be 7 or 30 days")

    if not body.currency:
        raise HTTPException(400, "Currency is required")

    # Get renewal price from bot config
    renewal_price = float(cfg.get("renewal_price", 0))
    if renewal_price <= 0:
        raise HTTPException(400, "No renewal price configured for this bot")

    amount = renewal_price * (body.duration_days / 30.0) if body.duration_days < 30 else renewal_price

    # Find parent completed order for this bot
    from code.shop.storage import load_orders, create_renewal_order, update_order
    parent_order_id = ""
    for o in load_orders():
        if o.get("bot_token") == token and o.get("status") == "completed":
            parent_order_id = o.get("order_id", "")
            break

    # Create renewal order
    rev_order = create_renewal_order(
        parent_order_id=parent_order_id,
        user_id=telegram_id,
        duration_days=body.duration_days,
        amount_usd=amount,
        payment_id="",
        currency=body.currency,
        invoice_url=None,
    )

    # Dev mode: auto-complete
    from code import config as app_config
    if getattr(app_config, "PAYMENT_DEV_MODE", False):
        from code.shop.workers import extend_valid_till_for_bot
        from code.shop.storage import update_order_status
        from datetime import datetime
        now = datetime.utcnow().isoformat() + "Z"
        if token and extend_valid_till_for_bot(token, body.duration_days, rev_order.get("order_id", "")):
            update_order_status(rev_order["order_id"], "completed", paid_at=now)
            return {
                "status": "completed",
                "order_id": rev_order["order_id"],
                "message": "Renewal confirmed (dev mode). Validity extended.",
            }
        else:
            update_order_status(rev_order["order_id"], "failed")
            raise HTTPException(500, "Renewal failed (could not extend validity)")

    # Create NowPayments invoice
    from code.shop.payment import create_invoice
    invoice = create_invoice(
        amount_usd=amount,
        currency=body.currency,
        order_id=rev_order["order_id"],
        description=f"AdBot renewal {body.duration_days} days",
    )

    if invoice.get("_invoice_failed"):
        update_order(rev_order["order_id"], {"status": "invoice_failed"})
        reason = invoice.get("_reason", "")
        msg = "Selected payment method is temporarily unavailable." if reason == "unavailable" else "Invoice creation failed. Try another currency."
        raise HTTPException(400, msg)

    # Update order with payment details
    update_order(rev_order["order_id"], {
        "payment_id": invoice.get("payment_id", ""),
        "invoice_url": invoice.get("invoice_url") or "",
        "pay_address": invoice.get("pay_address") or "",
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": (invoice.get("pay_currency") or body.currency).upper(),
        "invoice_expiry": invoice.get("invoice_expiry") or "",
        "invoice_expires_at": invoice.get("invoice_expires_at") or "",
    })

    return {
        "status": "awaiting_payment",
        "order_id": rev_order["order_id"],
        "amount_usd": amount,
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": (invoice.get("pay_currency") or body.currency).upper(),
        "pay_address": invoice.get("pay_address") or "",
        "invoice_expires_at": invoice.get("invoice_expires_at") or "",
        "duration_days": body.duration_days,
    }


@router.get("/bot/{bot_name}/renewal-status/{order_id}")
async def portal_renewal_status(bot_name: str, order_id: str, telegram_id: int = Query(...)):
    """Poll renewal order payment status."""
    await _get_user_bot(telegram_id, bot_name)
    from code.shop.storage import get_order
    order = get_order(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order.get("user_id") != telegram_id and telegram_id != 0:
        raise HTTPException(403, "Not your order")

    status = order.get("status", "unknown")
    return {
        "order_id": order_id,
        "status": status,
        "paid_at": order.get("paid_at", ""),
        "amount_usd": order.get("amount_usd", 0),
        "duration_days": order.get("duration_days", 0),
    }
