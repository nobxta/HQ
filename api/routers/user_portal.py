"""User portal endpoints: login by token, view own bot, update settings."""
import asyncio
import logging
import random
import string
from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

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


class PortalUpdateAccountProfile(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


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


@router.get("/bot/{bot_name}/replacements")
async def portal_bot_replacements(bot_name: str, telegram_id: int = Query(...)):
    """Get failing sessions and pending replacement requests for user's bot.

    Returns both:
    - failing_sessions: sessions detected failing ≥90% based on stats alone
      (shown as popup on login — no SpamBot check required).
    - pending: replacement entries already queued (being processed / awaiting payment).
    """
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    from code.replacement import (
        detect_failing_sessions,
        get_pending_replacements_for_bot,
        get_free_replacements_remaining,
        get_session_replacement_price,
    )
    # Pure stats-based detection (no cooldown gate — always fresh for portal)
    failing = detect_failing_sessions(bot_token, for_display=True)
    # Already-queued entries
    pending = get_pending_replacements_for_bot(bot_token)
    # Exclude sessions that already have a pending/completed queue entry
    queued_files = {e.get("session_file") for e in pending}
    # Failing but not yet queued → user should see them
    new_failing = [f for f in failing if f["session_file"] not in queued_files]
    free_remaining = get_free_replacements_remaining(cfg)
    price_per = get_session_replacement_price()
    return {
        "failing_sessions": new_failing,
        "pending": pending,
        "free_remaining": free_remaining,
        "price_per_session": price_per,
        "total_failing": len(new_failing),
        "total_pending": len(pending),
    }


class PortalDiagnoseRequest(BaseModel):
    session_files: list[str]


@router.post("/bot/{bot_name}/diagnose")
async def portal_diagnose_sessions(bot_name: str, body: PortalDiagnoseRequest, telegram_id: int = Query(...)):
    """Multi-step health check for sessions:

    Step 1: Validate session (is it alive / authorized / dead?)
    Step 2: SpamBot check (frozen / limited / active?)
    Step 3: Stats-based fallback if SpamBot fails

    Returns per-session: spam_status, reason, action, severity, and step details.
    """
    import logging as _logging
    import asyncio
    import time
    _log = _logging.getLogger("api.portal.diagnose")
    _log.info("DIAGNOSE called: bot=%s telegram_id=%s files=%s", bot_name, telegram_id, body.session_files)

    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    from code.repair import check_sessions_health_parallel, SPAM_ACTIVE, SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED, SPAM_FROZEN
    from code.utils import load_stats, save_stats, get_name_by_token
    from code import config as app_config

    if len(body.session_files) > 20:
        raise HTTPException(400, "Max 20 sessions per diagnose request")

    # Verify sessions belong to this bot
    sessions_cfg = cfg.get("sessions", [])
    valid_files = []
    for sf in body.session_files:
        for s in sessions_cfg:
            if (s.get("file") or s) == sf:
                valid_files.append(sf)
                break
    if not valid_files:
        _log.warning("No valid sessions found. Requested: %s, Bot sessions: %s",
                      body.session_files, [s.get("file") for s in sessions_cfg if isinstance(s, dict)])
        raise HTTPException(400, "None of the specified sessions belong to this bot")
    _log.info("  Valid files: %s", valid_files)

    # ── STEP 1: Validate sessions (are they alive?) — NON-DESTRUCTIVE ──
    # We do NOT use validate_session_with_reason because it moves dead sessions to dead/ folder.
    # For diagnosis, we just want to check status without modifying anything.
    _log.info("  Step 1: Validating %d session(s)...", len(valid_files))
    validation_results: dict[str, tuple[bool, str]] = {}
    alive_files: list[str] = []

    async def _safe_validate(fn: str) -> tuple[str, bool, str]:
        """Non-destructive session validation — checks if alive without moving files."""
        path = app_config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            return fn, False, "file missing"
        try:
            from telethon import TelegramClient
            client = TelegramClient(
                str(path.with_suffix("")), app_config.API_ID, app_config.API_HASH, proxy=app_config.PROXY
            )
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    return fn, False, "UNAUTHORIZED"
                # Session is alive and authorized
                return fn, True, ""
            except Exception as e:
                err_str = str(e).lower()
                if "deactivated" in err_str or "banned" in err_str or "frozen" in err_str:
                    return fn, False, "FROZEN"
                if "revoked" in err_str or "unregistered" in err_str or "authkey" in type(e).__name__.lower():
                    return fn, False, "revoked"
                return fn, False, str(e)[:80]
            finally:
                await client.disconnect()
        except Exception as e:
            return fn, False, str(e)[:80]

    for fn in valid_files:
        path = app_config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            validation_results[fn] = (False, "file missing")
            _log.warning("  Session %s: file not found on disk", fn)
            continue
        try:
            _, ok, reason = await asyncio.wait_for(_safe_validate(fn), timeout=10.0)
            validation_results[fn] = (ok, reason)
            if ok:
                alive_files.append(fn)
                _log.info("  Session %s: ALIVE", fn)
            else:
                _log.warning("  Session %s: DEAD (%s)", fn, reason)
        except asyncio.TimeoutError:
            validation_results[fn] = (True, "")  # assume alive if timeout
            alive_files.append(fn)
            _log.warning("  Session %s: validation timed out, assuming alive", fn)
        except Exception as e:
            validation_results[fn] = (False, str(e)[:80])
            _log.warning("  Session %s: validation error: %s", fn, e)

    # ── STEP 2: SpamBot check on alive sessions ──
    statuses: dict[str, str] = {}
    if alive_files:
        _log.info("  Step 2: SpamBot check on %d alive session(s) (25s timeout)...", len(alive_files))
        try:
            statuses = await asyncio.wait_for(
                check_sessions_health_parallel(alive_files),
                timeout=25.0
            )
            _log.info("  SpamBot results: %s", statuses)
        except asyncio.TimeoutError:
            _log.warning("  SpamBot check TIMED OUT after 25s")
            statuses = {fn: "UNKNOWN" for fn in alive_files}
        except Exception as e:
            _log.error("  SpamBot check FAILED: %s", e, exc_info=True)
            statuses = {fn: "UNKNOWN" for fn in alive_files}
    else:
        _log.info("  Step 2: skipped (no alive sessions)")

    # ── STEP 3: Stats fallback for UNKNOWN results ──
    name = get_name_by_token(bot_token)
    bot_stats = {}
    if name:
        st = load_stats(name) or {}
        bot_stats = st.get("session_stats", {})
        # Save health check results
        session_stats = st.get("session_stats", {})
        for fn in valid_files:
            ss = session_stats.get(fn, {})
            ss["_last_health_check_ts"] = time.time()
            status_val = statuses.get(fn, "")
            val_ok, val_reason = validation_results.get(fn, (True, ""))
            if not val_ok:
                # Dead session — override status
                if val_reason in ("FROZEN",):
                    ss["_last_spam_status"] = SPAM_FROZEN
                elif val_reason in ("revoked", "UNAUTHORIZED"):
                    ss["_last_spam_status"] = "DEAD"
                else:
                    ss["_last_spam_status"] = "DEAD"
            elif status_val:
                ss["_last_spam_status"] = status_val
            session_stats[fn] = ss
        st["session_stats"] = session_stats
        save_stats(name, st)

    # ── Build response ──
    _REASON_MAP = {
        SPAM_ACTIVE: {"reason": "Account is active and healthy. No issues detected.", "action": "none", "severity": "ok"},
        SPAM_TEMP_LIMITED: {"reason": "Temporarily limited by Telegram. May recover in 24-48 hours, or replace now.", "action": "wait_or_replace", "severity": "warning"},
        SPAM_HARD_LIMITED: {"reason": "Permanently limited by Telegram. This won't recover — replace immediately.", "action": "replace", "severity": "critical"},
        SPAM_FROZEN: {"reason": "Account is frozen / dead by Telegram. Replace immediately.", "action": "replace", "severity": "critical"},
    }
    _DEAD_REASONS = {
        "FROZEN": {"spam_status": "FROZEN", "reason": "Session is frozen/banned by Telegram. Replace immediately.", "action": "replace", "severity": "critical"},
        "revoked": {"spam_status": "DEAD", "reason": "Session key was revoked. The account logged out or was banned. Replace immediately.", "action": "replace", "severity": "critical"},
        "UNAUTHORIZED": {"spam_status": "DEAD", "reason": "Session is no longer authorized. It may have been logged out. Replace immediately.", "action": "replace", "severity": "critical"},
        "file missing": {"spam_status": "DEAD", "reason": "Session file not found on server. It may have been removed. Contact admin.", "action": "replace", "severity": "critical"},
        "in use by posting": {"spam_status": "BUSY", "reason": "Session is currently being used for posting. Try checking again in a few minutes.", "action": "none", "severity": "ok"},
    }

    results = []
    for fn in valid_files:
        val_ok, val_reason = validation_results.get(fn, (True, ""))
        spam_status = statuses.get(fn, "UNKNOWN")

        # Find real_name
        real_name = fn
        for s in sessions_cfg:
            if isinstance(s, dict) and s.get("file") == fn:
                real_name = s.get("real_name", fn)
                break

        # Dead session — skip SpamBot, use validation result
        if not val_ok:
            dead_info = _DEAD_REASONS.get(val_reason, {
                "spam_status": "DEAD",
                "reason": f"Session failed validation: {val_reason}. Replace recommended.",
                "action": "replace",
                "severity": "critical",
            })
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": dead_info["spam_status"],
                "reason": dead_info["reason"],
                "action": dead_info["action"],
                "severity": dead_info["severity"],
                "validation": "failed",
                "validation_reason": val_reason,
            })
            continue

        # Alive session — use SpamBot result
        info = _REASON_MAP.get(spam_status, None)
        if info:
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": spam_status,
                "reason": info["reason"],
                "action": info["action"],
                "severity": info["severity"],
                "validation": "ok",
            })
            continue

        # UNKNOWN — fall back to stats
        ss = bot_stats.get(fn, {})
        lt_sent = int(ss.get("lifetime_sent", 0))
        lt_failed = int(ss.get("lifetime_failed", 0))
        lt_total = lt_sent + lt_failed
        lc_attempted = int(ss.get("last_cycle_attempted", 0))
        lc_failed = int(ss.get("last_cycle_failed", 0))

        if lt_total > 0 and (lt_failed / lt_total) >= 0.9:
            fail_pct = round((lt_failed / lt_total) * 100)
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": "STATS_FAILING",
                "reason": f"Session is alive but has {fail_pct}% lifetime failure rate. SpamBot check was inconclusive. Consider replacing.",
                "action": "replace",
                "severity": "warning",
                "validation": "ok",
                "stats_fail_rate": fail_pct,
            })
        elif lc_attempted > 0 and (lc_failed / lc_attempted) >= 0.9:
            fail_pct = round((lc_failed / lc_attempted) * 100)
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": "STATS_FAILING",
                "reason": f"Session is alive but last cycle had {fail_pct}% failure. SpamBot was inconclusive. May be a temporary issue.",
                "action": "wait_or_replace",
                "severity": "warning",
                "validation": "ok",
                "stats_fail_rate": fail_pct,
            })
        else:
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": "UNKNOWN",
                "reason": "Session is alive but SpamBot check was inconclusive. Stats look okay. Try again later.",
                "action": "none",
                "severity": "unknown",
                "validation": "ok",
            })

    _log.info("DIAGNOSE complete: %d results", len(results))
    return {
        "results": results,
        "checked": len(results),
    }


class PortalReplaceRequest(BaseModel):
    session_files: list[str]


@router.post("/bot/{bot_name}/replace")
async def portal_request_replacement(bot_name: str, body: PortalReplaceRequest, telegram_id: int = Query(...)):
    """Request replacement for failing sessions from the portal.

    - Free replacements are auto-queued and processed immediately.
    - Paid replacements: in PAYMENT_DEV_MODE they auto-confirm,
      otherwise status=pending_payment and user pays via Telegram bot.
    """
    import logging as _logging
    _log = _logging.getLogger("api.portal.replace")
    _log.info("▶ REPLACE called: bot=%s telegram_id=%s files=%s", bot_name, telegram_id, body.session_files)

    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    from code.replacement import (
        detect_failing_sessions,
        create_replacement_request,
        get_free_replacements_remaining,
        get_session_replacement_price,
        mark_replacement_paid,
    )
    from code import config as app_config

    # Verify sessions are actually failing (stats-based OR diagnosis-based)
    import asyncio
    from code.utils import load_stats, get_name_by_token
    try:
        _log.info("  Detecting failing sessions (stats-based)...")
        failing = await asyncio.to_thread(detect_failing_sessions, bot_token, for_display=True)
        _log.info("  Found %d stats-failing sessions: %s", len(failing), [f["session_file"] for f in failing])
    except Exception as e:
        _log.error("  detect_failing_sessions FAILED: %s", e, exc_info=True)
        failing = []
    failing_map = {f["session_file"]: f for f in failing}

    # Also check diagnosis results (saved by /diagnose endpoint)
    # Sessions diagnosed as FROZEN/DEAD/HARD_LIMITED/TEMP_LIMITED should be replaceable
    # even if stats haven't caught up yet
    _name = get_name_by_token(bot_token)
    diag_statuses: dict[str, str] = {}
    if _name:
        _st = load_stats(_name) or {}
        _ss = _st.get("session_stats", {})
        for sf in body.session_files:
            saved_status = _ss.get(sf, {}).get("_last_spam_status", "")
            if saved_status:
                diag_statuses[sf] = saved_status

    _BAD_STATUSES = {"FROZEN", "HARD_LIMITED", "TEMP_LIMITED", "DEAD"}
    sessions_cfg = cfg.get("sessions", [])
    valid_sessions = []
    for sf in body.session_files:
        if sf in failing_map:
            # Stats say it's failing
            valid_sessions.append(failing_map[sf])
        elif diag_statuses.get(sf, "") in _BAD_STATUSES:
            # Diagnosis says it's bad (even if stats haven't caught up)
            _log.info("  Session %s: not stats-failing but diagnosed as %s — allowing replace", sf, diag_statuses[sf])
            real_name = sf
            for s in sessions_cfg:
                if isinstance(s, dict) and s.get("file") == sf:
                    real_name = s.get("real_name", sf)
                    break
            valid_sessions.append({
                "session_file": sf,
                "real_name": real_name,
                "failure_rate": 1.0,
                "spam_status": diag_statuses[sf],
            })
        else:
            _log.info("  Session %s: not failing (stats or diagnosis). Skipping.", sf)

    if not valid_sessions:
        _log.warning("  No valid failing sessions. Requested: %s, Failing: %s, Diagnosed: %s",
                      body.session_files, list(failing_map.keys()), diag_statuses)
        raise HTTPException(400, "None of the specified sessions are currently failing or diagnosed as problematic. Run 'Check Why' first to diagnose, or they may have recovered.")

    free_remaining = get_free_replacements_remaining(cfg)
    price_per = get_session_replacement_price()
    owner_id = cfg.get("owner_id", telegram_id)
    _log.info("  Free remaining: %d, Price: $%.2f, Valid sessions: %d", free_remaining, price_per, len(valid_sessions))

    entries = create_replacement_request(
        bot_token=bot_token,
        bot_name=bot_name,
        owner_id=owner_id,
        sessions=valid_sessions,
        free_count=min(free_remaining, len(valid_sessions)),
    )
    _log.info("  ✓ Created %d replacement entries: %s", len(entries),
              [(e["id"], e["session_file"], e["status"]) for e in entries])

    # Check if all were already queued (duplicate request)
    if not entries:
        from code.replacement import get_pending_replacements_for_bot
        pending = get_pending_replacements_for_bot(bot_token)
        pending_files = [e["session_file"] for e in pending if e["session_file"] in body.session_files]
        if pending_files:
            _log.info("  ℹ All sessions already queued: %s", pending_files)
            return {
                "queued": 0,
                "already_queued": len(pending_files),
                "message": f"{len(pending_files)} session(s) already queued for replacement",
                "entries": [],
                "free_remaining": free_remaining,
                "price_per_session": price_per,
            }

    # In dev mode, auto-confirm paid entries too
    if getattr(app_config, "PAYMENT_DEV_MODE", False):
        for e in entries:
            if e.get("status") == "pending_payment":
                mark_replacement_paid(e["id"], payment_id=f"dev_portal_{e['id']}")
                _log.info("  [DEV] Auto-confirmed paid entry %s", e["id"])

    # ── AUTO-PROCESS free replacements immediately ──
    # Don't make the user wait for admin or Telegram bot to process the queue.
    from code.replacement import process_ready_replacements
    processed = []
    free_entries = [e for e in entries if e.get("status") == "ready"]
    if free_entries:
        _log.info("  Processing %d free replacement(s) immediately...", len(free_entries))
        try:
            processed = await process_ready_replacements()
            _log.info("  Processing results: %s",
                      [(r.get("session_file"), r.get("result")) for r in processed])
        except Exception as proc_err:
            _log.error("  ✗ Auto-process failed: %s", proc_err, exc_info=True)
            # Not fatal — entries stay in queue, admin/bot can process later

    completed = [r for r in processed if r.get("result") == "replaced"]
    queued_no_pool = [r for r in processed if r.get("result") == "queued_no_sessions"]

    return {
        "queued": len(entries),
        "processed": len(completed),
        "awaiting_pool": len(queued_no_pool),
        "entries": [
            {
                "id": e["id"],
                "session_file": e["session_file"],
                "real_name": e.get("real_name", ""),
                "free_replacement": e.get("free_replacement", False),
                "price_usd": e.get("price_usd", 0),
                "status": e.get("status", ""),
            }
            for e in entries
        ],
        "completed": [
            {
                "old_session": r.get("session_file", ""),
                "new_session": r.get("new_session_file", ""),
                "real_name": r.get("real_name", ""),
            }
            for r in completed
        ],
        "free_remaining": max(0, free_remaining - sum(1 for e in entries if e.get("free_replacement"))),
        "price_per_session": price_per,
    }


# ── Account Profile Management ──────────────────────────────────────────────

async def _update_session_profile(
    session_file: str, *, first_name: str | None = None, last_name: str | None = None,
    bio: str | None = None, username: str | None = None, photo_bytes: bytes | None = None,
) -> dict:
    """Connect to a session and update Telegram profile fields."""
    from code import config
    path = config.SESSIONS_ACTIVE / session_file
    if not path.is_file():
        raise HTTPException(404, f"Session file not found: {session_file}")

    from telethon import TelegramClient
    client = TelegramClient(
        str(path.with_suffix("")), config.API_ID, config.API_HASH, proxy=config.PROXY
    )
    results: dict = {}
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise HTTPException(400, "Session is not authorized")

        # Update name / bio
        if first_name is not None or last_name is not None or bio is not None:
            from telethon.tl.functions.account import UpdateProfileRequest
            kwargs: dict = {}
            if first_name is not None:
                kwargs["first_name"] = first_name
            if last_name is not None:
                kwargs["last_name"] = last_name
            if bio is not None:
                kwargs["about"] = bio
            await client(UpdateProfileRequest(**kwargs))
            results["profile_updated"] = True

        # Update username
        if username is not None:
            from telethon.tl.functions.account import UpdateUsernameRequest
            try:
                await client(UpdateUsernameRequest(username=username))
                results["username_updated"] = True
            except Exception as e:
                results["username_error"] = str(e)

        # Update photo
        if photo_bytes:
            import tempfile, os
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
            try:
                tmp.write(photo_bytes)
                tmp.close()
                from telethon.tl.functions.photos import UploadProfilePhotoRequest
                uploaded = await client.upload_file(tmp.name)
                await client(UploadProfilePhotoRequest(file=uploaded))
                results["photo_updated"] = True
            except Exception as e:
                results["photo_error"] = str(e)
            finally:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass
    finally:
        await client.disconnect()
    return results


@router.post("/bot/{bot_name}/account/{session_file}/profile")
async def portal_update_account_profile(
    bot_name: str, session_file: str, telegram_id: int = Query(...),
    first_name: Optional[str] = Form(None), last_name: Optional[str] = Form(None),
    bio: Optional[str] = Form(None), username: Optional[str] = Form(None),
    photo: Optional[UploadFile] = File(None),
):
    """Update Telegram profile (name, bio, username, photo) for a session account."""
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    # Verify session belongs to this bot
    session_files = [s.get("file", "") for s in cfg.get("sessions", [])]
    if session_file not in session_files:
        raise HTTPException(404, "Session not found on this bot")

    photo_bytes = None
    if photo:
        photo_bytes = await photo.read()
        if len(photo_bytes) > 5 * 1024 * 1024:
            raise HTTPException(400, "Photo too large (max 5MB)")

    try:
        result = await _update_session_profile(
            session_file,
            first_name=first_name,
            last_name=last_name,
            bio=bio,
            username=username,
            photo_bytes=photo_bytes,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Profile update failed for %s: %s", session_file, e)
        raise HTTPException(500, f"Profile update failed: {e}")

    # Update real_name in bot config if first_name changed
    if first_name is not None:
        from code.utils import load_user_data, save_user_data, get_name_by_token
        name = get_name_by_token(bot_token)
        if name:
            user_cfg = load_user_data(name)
            if user_cfg:
                for s in user_cfg.get("sessions", []):
                    if s.get("file") == session_file:
                        display = first_name
                        if last_name:
                            display += f" {last_name}"
                        s["real_name"] = display
                        break
                save_user_data(name, user_cfg)

    return {"ok": True, **result}


@router.get("/bot/{bot_name}/account/{session_file}/info")
async def portal_get_account_info(
    bot_name: str, session_file: str, telegram_id: int = Query(...),
):
    """Get Telegram profile info for a session account."""
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    session_files = [s.get("file", "") for s in cfg.get("sessions", [])]
    if session_file not in session_files:
        raise HTTPException(404, "Session not found on this bot")

    from code import config
    path = config.SESSIONS_ACTIVE / session_file
    if not path.is_file():
        raise HTTPException(404, "Session file not on disk")

    from telethon import TelegramClient
    client = TelegramClient(
        str(path.with_suffix("")), config.API_ID, config.API_HASH, proxy=config.PROXY
    )
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise HTTPException(400, "Session not authorized")
        me = await client.get_me()
        return {
            "user_id": me.id,
            "first_name": me.first_name or "",
            "last_name": me.last_name or "",
            "username": me.username or "",
            "phone": me.phone or "",
            "bio": "",  # Need separate call
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Could not fetch account info: {e}")
    finally:
        await client.disconnect()
