"""User portal endpoints: login by token, view own bot, update settings."""
import asyncio
import logging
import random
import string
from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)

from fastapi import Depends
from api.auth import (
    create_portal_access_token, create_portal_refresh_token,
    PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
)
from api.deps import enforce_portal_auth
from api.services import wrappers
from api.services.serializers import serialize_bot_detail, serialize_stats, serialize_order


def _generate_web_token(length: int = 8) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choices(chars, k=length))

# Deny-by-default auth gate: public routes (login/purchase/ipn) are exempted inside
# enforce_portal_auth; all bot/user routes require a matching portal token; /admin/*
# routes require an admin token.
router = APIRouter(prefix="/api/portal", tags=["portal"], dependencies=[Depends(enforce_portal_auth)])


class PortalSupportTicketRequest(BaseModel):
    session_file: str
    session_name: str
    issue_type: str  # "healthy_but_failing", "other"
    message: str
    diag_status: Optional[str] = None
    fail_rate: Optional[float] = None


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
    provisioning: bool = False     # web order paid, bot still being created
    queued: bool = False           # paid but waiting for stock (no token / sessions)
    creation_step: str = ""        # live build step to show on the "work in progress" screen
    # Order / plan context for the provisioning page (only set while provisioning)
    order_id: str = ""
    plan_id: str = ""
    plan_name: str = ""
    plan_mode: str = ""
    accounts: int = 0              # number of accounts (sessions) included in the plan
    free_replacements: int = 0    # free account replacements (-1 = unlimited)
    billing: str = ""             # "week" / "month"
    amount_usd: float = 0.0
    duration_days: int = 0
    created_at: str = ""
    paid_at: str = ""
    pay_source: str = ""
    pay_currency: str = ""
    ref_name: str = ""
    ref_email: str = ""
    ref_username: str = ""
    notify_telegram_id: int = 0


class PortalUpdateMessage(BaseModel):
    message_text: Optional[str] = None
    message_mode: Optional[str] = None


class PortalUpdateLinks(BaseModel):
    post_links: list[str]


class PortalUpdateSettings(BaseModel):
    cycle: Optional[int] = None
    gap: Optional[int] = None


class PortalUpdateAutoreply(BaseModel):
    enabled: Optional[bool] = None
    message: Optional[str] = None


class PortalUpdateAuth(BaseModel):
    authorized: list[int]


class PortalUpdateChatlist(BaseModel):
    links: list[str]


class PortalRenewRequest(BaseModel):
    duration_days: int  # 7 or 30
    currency: str  # e.g. "BTC", "USDT_TRC20"


def _parse_order_dt(value: object):
    from datetime import datetime
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def _safe_renewal_order(order: dict) -> dict:
    return {
        "status": order.get("status", "payment_waiting"),
        "order_id": order.get("order_id", ""),
        "amount_usd": order.get("amount_usd", 0),
        "fiat_currency": order.get("fiat_currency", "USD"),
        "pricing_source": order.get("pricing_source", ""),
        "pay_amount": order.get("pay_amount", ""),
        "pay_currency": order.get("pay_currency", ""),
        "pay_address": order.get("pay_address", ""),
        "invoice_expires_at": order.get("invoice_expires_at", "") or order.get("expiry_time", ""),
        "duration_days": order.get("duration_days", 0),
        "old_valid_till": order.get("old_valid_till", ""),
        "new_valid_till": order.get("new_valid_till", "") or order.get("new_valid_till_preview", ""),
        "new_valid_till_preview": order.get("new_valid_till_preview", ""),
        "payment_id": order.get("payment_id", ""),
        "reused": True,
    }


class PortalUpdateAccountProfile(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


async def _get_user_bot(telegram_id: int, bot_name: str):
    """Find a bot the user is authorized on."""
    data = await wrappers.load_adbot()
    for token, cfg in data.get("bots", {}).items():
        if (cfg.get("name") or "").lower() != bot_name.lower():
            continue
        authorized = cfg.get("authorized", [])
        owner_id = cfg.get("owner_id")
        if telegram_id in authorized or telegram_id == owner_id:
            return token, cfg
        if telegram_id == 0 and owner_id in (None, 0):
            return token, cfg
        raise HTTPException(403, "You are not authorized on this bot")
    raise HTTPException(404, f"Bot '{bot_name}' not found")


def _ensure_not_expired(cfg: dict) -> None:
    """Reject operational actions when the plan has expired. The web blur-lock is only cosmetic and
    can be removed from the DOM — THIS is the real gate: even then, an expired bot can't be started
    or reconfigured server-side. Renewal, stop, and read-only endpoints stay allowed so the user can
    still recover during the grace window."""
    from api.services.serializers import _expiry_fields
    if _expiry_fields(cfg).get("expired"):
        raise HTTPException(403, "Your plan has expired. Renew to continue.")


# Stable marker the portal frontend matches to show the "frozen — read-only" popup
# instead of a generic error toast. Keep this prefix in sync with the client check.
FROZEN_ERROR = "BOT_FROZEN: This bot has been frozen by an administrator. It is read-only — you can view everything, but actions are disabled. Please contact support."

# Login is refused outright for a suspended bot (unlike frozen, which allows read-only access).
SUSPENDED_ERROR = "BOT_SUSPENDED: This account has been suspended and cannot be accessed. Please contact support."


def _ensure_not_frozen(cfg: dict) -> None:
    """Hard server-side gate for a frozen bot. A frozen bot is fully viewable (logs, stats,
    orders, sessions) but NO action may change its state — start/stop, posting content,
    groups/chatlist, health checks, replacements, profile edits or renewals are all rejected.
    Only an admin can unfreeze. This is the real enforcement; the portal also greys out the
    controls, but even a hand-crafted request fails closed here."""
    if cfg and cfg.get("frozen"):
        raise HTTPException(403, FROZEN_ERROR)


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
    # DISABLED (security): this minted a portal token from only a telegram_id + bot
    # name — both non-secret — so anyone could obtain another user's token and bypass
    # every access check. Login now requires the web access code via /unified-login
    # (or /login-token), which is a real per-bot secret. This endpoint is unused by
    # the frontend; kept as a hard 410 so any stale client fails closed.
    raise HTTPException(
        410,
        "This login method has been retired. Use your web access code to sign in.",
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
            if cfg.get("suspended"):
                raise HTTPException(403, SUSPENDED_ERROR)
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
            if cfg.get("suspended"):
                raise HTTPException(403, SUSPENDED_ERROR)
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

    # 3. Web order paid but the bot is still being built → let them in to a "work in progress" view.
    try:
        from code.shop.storage import load_orders
        for o in load_orders():
            if (o.get("source") == "web" and (o.get("web_token") or "") == code
                    and o.get("status") in ("paid", "pending_creation", "creating")):
                bot_name = o.get("bot_name") or "AdBot"
                subject = f"user:0:{bot_name}"
                is_queued = bool(o.get("queued")) or o.get("status") == "paid"
                try:
                    _amount = float(o.get("amount_usd") or 0)
                except (TypeError, ValueError):
                    _amount = 0.0
                try:
                    _dur = int(o.get("duration_days") or 0)
                except (TypeError, ValueError):
                    _dur = 0
                # Account count + replacements come from the plan definition, not the order.
                _accounts = 0
                _free_repl = 0
                try:
                    _plan, _ = _find_plan(o.get("plan_mode", ""), o.get("plan_id", ""))
                    if _plan:
                        _accounts = int(_plan.get("sessions") or 0)
                        _free_repl = int(_plan.get("free_replacements") or 0)
                except Exception:
                    _accounts = 0
                _billing = "month" if _dur >= 30 else ("week" if _dur > 0 else "")
                return UnifiedLoginResponse(
                    role="user",
                    access_token=create_portal_access_token(subject),
                    refresh_token=create_portal_refresh_token(subject),
                    expires_in=PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
                    bot_name=bot_name,
                    telegram_id=0,
                    provisioning=True,
                    queued=is_queued,
                    creation_step=o.get("creation_step", "") or "",
                    order_id=o.get("order_id", "") or "",
                    plan_id=o.get("plan_id", "") or "",
                    plan_name=o.get("plan_name", "") or "",
                    plan_mode=o.get("plan_mode", "") or "",
                    accounts=_accounts,
                    free_replacements=_free_repl,
                    billing=_billing,
                    amount_usd=_amount,
                    duration_days=_dur,
                    created_at=o.get("created_at", "") or "",
                    paid_at=o.get("paid_at", "") or "",
                    pay_source=o.get("source", "") or "",
                    pay_currency=(o.get("pay_currency", "") or "").upper(),
                    ref_name=o.get("ref_name", "") or "",
                    ref_email=o.get("ref_email", "") or "",
                    ref_username=o.get("ref_username", "") or "",
                    notify_telegram_id=int(o.get("notify_telegram_id") or 0),
                )
    except Exception:
        pass

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
    # Attach per-session health + verified identity from the unified session_meta cache — a pure
    # read, NO live Telethon. This is the single source of truth the admin Sessions page uses, so
    # a health check done anywhere persists and shows here on refresh.
    from code.utils import load_pool as _load_pool, portal_health
    _meta_all = (await asyncio.to_thread(_load_pool)).get("session_meta") or {}
    for _s in detail.get("sessions", []):
        _m = _meta_all.get((_s.get("file") or "").strip()) or {}
        _s["health"] = portal_health(_m)
        _s["spam_status"] = _m.get("spam_status") or None
        _s["spam_details"] = _m.get("spam_details") or None
        _s["validation_status"] = _m.get("validation_status") or None
        _s["last_checked"] = _m.get("last_checked") or None
        _s["full_name"] = _m.get("full_name") or (_s.get("real_name") or None)
        _s["username"] = _m.get("username") or None
        _s["phone"] = _m.get("phone") or None
    detail["message_text"] = cfg.get("message_text", "")
    detail["message_mode"] = cfg.get("message_mode", "link")
    detail["post_links"] = cfg.get("post_links", [])
    detail["web_token"] = cfg.get("web_token", "")
    detail["renewal_price"] = cfg.get("renewal_price", "0")
    detail["renewal_prices"] = cfg.get("renewal_prices") or {"7d": None, "30d": None}
    # DM auto-reply config + a server-composed preview so the UI/bot render identical text.
    # The footer is admin-managed (users can't edit it); read the live value, not the default.
    from code.users import compose_autoreply, DM_AUTOREPLY_DEFAULT
    from code import dm_inbox as _dm
    ar = cfg.get("dm_autoreply") or {}
    ar_enabled = bool(ar.get("enabled", True))
    ar_message = str(ar.get("message", "") or "")
    detail["dm_autoreply"] = {"enabled": ar_enabled, "message": ar_message, "updated_at": ar.get("updated_at", "")}
    detail["dm_autoreply_default"] = DM_AUTOREPLY_DEFAULT
    detail["dm_autoreply_footer"] = _dm.get_autoreply_footer()
    detail["dm_autoreply_preview"] = compose_autoreply(ar_message)
    return detail


@router.get("/bot/{bot_name}/stats")
async def portal_get_stats(bot_name: str, telegram_id: int = Query(...)):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    stats = await wrappers.get_stats_for_display(token)
    return serialize_stats(stats)


@router.get("/bot/{bot_name}/analytics")
async def portal_get_analytics(
    bot_name: str,
    telegram_id: int = Query(...),
    range: str = Query("7d"),
):
    """Time-bucketed posting analytics parsed from the durable log file (source of truth)."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    from api.services.log_stats import compute_analytics
    return await asyncio.to_thread(compute_analytics, name, range)


@router.get("/bot/{bot_name}/logs")
async def portal_get_logs(bot_name: str, telegram_id: int = Query(...), lines: int = Query(100, ge=0, le=1000000)):
    # lines=0 (or a count >= the file size) returns the WHOLE log — used by the portal's
    # "Load all" so the user can see every Successful/Failed entry, not just a recent tail.
    # The portal defaults to a small tail to stay light; the full read is opt-in.
    token, _cfg = await _get_user_bot(telegram_id, bot_name)
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
        tail = all_lines if (lines <= 0 or lines >= len(all_lines)) else all_lines[-lines:]
        return {"lines": tail, "total_lines": len(all_lines)}
    except Exception as e:
        raise HTTPException(500, f"Failed to read logs: {e}")


@router.get("/bot/{bot_name}/orders")
async def portal_get_orders(bot_name: str, telegram_id: int = Query(...)):
    token, _cfg = await _get_user_bot(telegram_id, bot_name)
    orders = await wrappers.search_orders(user_id=telegram_id)
    return {"orders": [serialize_order(o) for o in orders]}


@router.post("/bot/{bot_name}/start")
async def portal_start_bot(bot_name: str, telegram_id: int = Query(...)):
    from api.services.events import emit_bot_control
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
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
    _ensure_not_frozen(cfg)
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
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
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
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    full_cfg["post_links"] = body.post_links[:10]
    await wrappers.save_user_data(name, full_cfg)
    return {"status": "updated", "message": f"{len(body.post_links)} links saved"}


@router.patch("/bot/{bot_name}/settings")
async def portal_update_settings(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateSettings = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
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


@router.put("/bot/{bot_name}/autoreply")
async def portal_update_autoreply(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateAutoreply = ...):
    """Save DM auto-reply config. The user only controls enabled + the body message; the
    admin-managed footer is never stored (stripped here) and always appended at send time."""
    import time as _time
    from code.users import compose_autoreply
    from code import dm_inbox as _dm
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
    name = cfg.get("name", bot_name)
    full_cfg = await wrappers.load_user_data(name)
    ar = dict(full_cfg.get("dm_autoreply") or {})
    if body.enabled is not None:
        ar["enabled"] = bool(body.enabled)
    if body.message is not None:
        # Never persist the footer, so it can't duplicate or be edited by the user.
        msg = body.message.replace(_dm.get_autoreply_footer(), "").strip()[:500]
        ar["message"] = msg
    ar.setdefault("enabled", True)
    ar.setdefault("message", "")
    ar["updated_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    full_cfg["dm_autoreply"] = ar
    await wrappers.save_user_data(name, full_cfg)
    return {
        "status": "updated",
        "dm_autoreply": ar,
        "final_preview": compose_autoreply(ar.get("message", "")),
    }


@router.get("/bot/{bot_name}/dm-inbox")
async def portal_get_dm_inbox(bot_name: str, telegram_id: int = Query(...), account: str = Query("")):
    """DMs received by this AdBot's posting accounts, newest first, optional account filter."""
    from code import dm_inbox as _dm
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    items = await asyncio.to_thread(_dm.load_inbox, name)
    accounts = sorted({i.get("session_file", "") for i in items if i.get("session_file")})
    if account:
        items = [i for i in items if i.get("session_file") == account]
    unread = sum(1 for i in items if not i.get("read"))
    return {
        "messages": list(reversed(items))[:200],
        "accounts": accounts,
        "unread_count": unread,
    }


@router.post("/bot/{bot_name}/dm-inbox/read")
async def portal_mark_dm_inbox_read(bot_name: str, telegram_id: int = Query(...)):
    from code import dm_inbox as _dm
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    await asyncio.to_thread(_dm.mark_inbox_read, name)
    return {"status": "ok"}


@router.post("/bot/{bot_name}/dm-inbox/{msg_id}/read")
async def portal_mark_dm_read(bot_name: str, msg_id: str, telegram_id: int = Query(...)):
    from code import dm_inbox as _dm
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    name = cfg.get("name", bot_name)
    await asyncio.to_thread(_dm.mark_dm_read, name, msg_id)
    return {"status": "ok"}


@router.put("/bot/{bot_name}/authorized")
async def portal_update_auth(bot_name: str, telegram_id: int = Query(...), body: PortalUpdateAuth = ...):
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
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
    _ensure_not_expired(cfg or {})
    _ensure_not_frozen(cfg or {})
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
    _ensure_not_expired(cfg)
    _ensure_not_frozen(cfg)
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
            {"label": "Arbitrum", "code": "USDC_ARB"},
        ],
    }
    more = ["TRX", "BNB", "DOGE", "XRP", "SOL", "MATIC", "ADA", "TON"]
    return {"main": main, "stablecoins": stablecoins, "more": more}


@router.get("/bot/{bot_name}/renewal-options")
async def portal_renewal_options(bot_name: str, telegram_id: int = Query(...)):
    """Return server-calculated renewal options for the authenticated user's bot."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    from code.shop.renewals import effective_renewal_options, parse_valid_till
    from code.shop.storage import find_active_renewal_order
    import datetime as _dt
    opts = effective_renewal_options(cfg)
    current = parse_valid_till(cfg.get("valid_till"))
    hours_left = None
    if current:
        hours_left = int((current - _dt.datetime.utcnow()).total_seconds() // 3600)
    active_order = find_active_renewal_order(token, telegram_id)
    active_invoice = _safe_renewal_order(active_order) if active_order else None
    return {
        "bot": {
            "name": cfg.get("name", bot_name),
            "plan_name": cfg.get("plan_name") or (cfg.get("plan") or {}).get("name") or "Custom",
            "mode": cfg.get("mode") or cfg.get("plan_mode") or "",
            "sessions_count": len(cfg.get("sessions") or []),
            "state": cfg.get("state", "stopped"),
            "valid_till": cfg.get("valid_till") or "",
            "hours_left": hours_left,
        },
        "active_invoice": active_invoice,
        **opts,
    }


@router.post("/bot/{bot_name}/renew")
async def portal_create_renewal(bot_name: str, telegram_id: int = Query(...), body: PortalRenewRequest = ...):
    """Create a renewal order with NowPayments invoice. Returns payment details."""
    token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_frozen(cfg)
    name = cfg.get("name", bot_name)

    if body.duration_days not in (7, 30):
        raise HTTPException(400, "Duration must be 7 or 30 days")

    if not body.currency:
        raise HTTPException(400, "Currency is required")

    from code.shop.renewals import resolve_renewal_price
    try:
        price = resolve_renewal_price(cfg, body.duration_days)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    amount = price["amount"]

    # Reuse an existing live invoice (from web OR the controller bot) instead of minting a duplicate.
    from code.shop.storage import load_orders, create_renewal_order, update_order, find_active_renewal_order
    existing = find_active_renewal_order(token, telegram_id)
    if existing:
        return _safe_renewal_order(existing)

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
        amount_usd=float(amount),
        payment_id="",
        currency=body.currency,
        invoice_url=None,
        bot_token=token,
        bot_name=name,
        plan_id=(cfg.get("plan_name") or (cfg.get("plan") or {}).get("name") or ""),
        plan_name=(cfg.get("plan_name") or (cfg.get("plan") or {}).get("name") or ""),
        plan_mode=(cfg.get("mode") or cfg.get("plan_mode") or ""),
        fiat_currency=price["currency"],
        pricing_source=price["pricing_source"],
        old_valid_till=cfg.get("valid_till") or "",
        new_valid_till_preview=price["new_valid_till_preview"],
    )

    # Dev mode: auto-complete
    from code import config as app_config
    if getattr(app_config, "PAYMENT_DEV_MODE", False):
        from code.shop.workers import extend_valid_till_for_bot
        from code.shop.storage import update_order_status
        from datetime import datetime
        now = datetime.utcnow().isoformat() + "Z"
        if token and extend_valid_till_for_bot(token, body.duration_days, rev_order.get("order_id", ""), order=rev_order, details={"pay_currency": body.currency}):
            # Respect the order state machine: payment_waiting → paid → completed.
            update_order_status(rev_order["order_id"], "paid", paid_at=now)
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
        amount_usd=float(amount),
        currency=body.currency,
        order_id=rev_order["order_id"],
        description=f"AdBot renewal {body.duration_days} days",
    )

    if invoice.get("_invoice_failed"):
        update_order(rev_order["order_id"], {"status": "invoice_failed"})
        reason = invoice.get("_reason", "")
        msg = "Selected payment method is temporarily unavailable." if reason == "unavailable" else "Invoice creation failed. Try another currency."
        raise HTTPException(400, msg)

    # Update order with payment details. Store bot_token directly on the renewal
    # order so the IPN webhook can extend validity without depending on a completed
    # parent order (admin-created bots have none).
    update_order(rev_order["order_id"], {
        "bot_token": token,
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
        "amount_usd": float(amount),
        "fiat_currency": price["currency"],
        "pricing_source": price["pricing_source"],
        "new_valid_till_preview": price["new_valid_till_preview"],
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": (invoice.get("pay_currency") or body.currency).upper(),
        "pay_address": invoice.get("pay_address") or "",
        "invoice_expires_at": invoice.get("invoice_expires_at") or "",
        "duration_days": body.duration_days,
    }


@router.get("/bot/{bot_name}/renewal-status/{order_id}")
async def portal_renewal_status(bot_name: str, order_id: str, telegram_id: int = Query(...)):
    """Poll renewal order payment status."""
    token, _cfg = await _get_user_bot(telegram_id, bot_name)
    from code.shop.storage import get_order
    order = get_order(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order.get("user_id") != telegram_id and telegram_id != 0:
        raise HTTPException(403, "Not your order")
    if order.get("order_type") == "renewal" and (order.get("bot_token") or "") and order.get("bot_token") != token:
        raise HTTPException(403, "Not your renewal order")

    status = order.get("status", "unknown")
    return {
        "order_id": order_id,
        "status": status,
        "paid_at": order.get("paid_at", ""),
        "amount_usd": order.get("amount_usd", 0),
        "fiat_currency": order.get("fiat_currency", "USD"),
        "pay_amount": order.get("pay_amount", ""),
        "pay_currency": order.get("pay_currency", ""),
        "pay_address": order.get("pay_address", ""),
        "amount_received": order.get("amount_received", 0),
        "invoice_expires_at": order.get("invoice_expires_at", ""),
        "duration_days": order.get("duration_days", 0),
        "old_valid_till": order.get("old_valid_till", ""),
        "new_valid_till": order.get("new_valid_till", "") or order.get("new_valid_till_preview", ""),
        "payment_id": order.get("payment_id", ""),
    }


@router.post("/bot/{bot_name}/renewal/{order_id}/cancel")
async def portal_cancel_renewal(bot_name: str, order_id: str, telegram_id: int = Query(...)):
    """Cancel an unpaid renewal invoice so the user can generate a fresh one."""
    token, _cfg = await _get_user_bot(telegram_id, bot_name)
    from code.shop.storage import get_order, update_order_status
    order = get_order(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order.get("order_type") != "renewal":
        raise HTTPException(400, "Not a renewal order")
    if order.get("user_id") != telegram_id and telegram_id != 0:
        raise HTTPException(403, "Not your order")
    if (order.get("bot_token") or "") and order.get("bot_token") != token:
        raise HTTPException(403, "Not your renewal order")
    if order.get("status") != "payment_waiting":
        raise HTTPException(400, "Only unpaid active invoices can be cancelled")
    ok = update_order_status(order_id, "cancelled", cancelled_by="user", cancelled_at=__import__("datetime").datetime.utcnow().isoformat() + "Z")
    if not ok:
        raise HTTPException(400, "Could not cancel invoice")
    return {"ok": True, "order_id": order_id, "status": "cancelled"}


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
    _ensure_not_frozen(cfg)
    from code.repair import check_sessions_health_detailed_parallel, SPAM_ACTIVE, SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED, SPAM_FROZEN
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
            from code.session_guard import SessionBusyError, guarded_client
            client = guarded_client(path, "session validation", wait_timeout=5, expected_sec=30)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    return fn, False, "UNAUTHORIZED"
                # Session is alive and authorized
                return fn, True, ""
            except SessionBusyError as e:
                # In use by another task → working, just can't be checked right now
                return fn, True, str(e)[:200]
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
            detailed_checks = await asyncio.wait_for(
                check_sessions_health_detailed_parallel(alive_files),
                timeout=25.0
            )
            statuses = {fn: str(check["status"]) for fn, check in detailed_checks.items()}
            _log.info("  SpamBot results: %s", statuses)
        except asyncio.TimeoutError:
            _log.warning("  SpamBot check TIMED OUT after 25s")
            statuses = {fn: "UNKNOWN" for fn in alive_files}
            detailed_checks = {}
        except Exception as e:
            _log.error("  SpamBot check FAILED: %s", e, exc_info=True)
            statuses = {fn: "UNKNOWN" for fn in alive_files}
            detailed_checks = {}
    else:
        detailed_checks = {}
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
                # Distinguish the failure states (unauthorized/logged-out is NOT the same as
                # a revoked/banned dead connection).
                if val_reason == "FROZEN":
                    ss["_last_spam_status"] = SPAM_FROZEN
                elif val_reason == "UNAUTHORIZED":
                    ss["_last_spam_status"] = "UNAUTHORIZED"
                else:  # revoked / banned / other
                    ss["_last_spam_status"] = "DEAD"
            elif status_val:
                ss["_last_spam_status"] = status_val
            session_stats[fn] = ss
        st["session_stats"] = session_stats
        save_stats(name, st)

    # ── Mirror the health outcome into the shared per-session cache so a portal-driven
    # SpamBot/validation result shows up on the admin Sessions page too (unified health).
    # Runs off the event loop (to_thread) and never clobbers a busy session's good record.
    from code.utils import record_session_meta
    for fn in valid_files:
        val_ok, val_reason = validation_results.get(fn, (True, ""))
        low = (val_reason or "").lower()
        if "busy" in low or "in use" in low or "locked" in low:
            continue  # in use by a worker — leave the cached record untouched
        status_val = statuses.get(fn, "")
        status_details = (detailed_checks.get(fn) or {}).get("details")
        if not val_ok:
            spam = ("FROZEN" if val_reason == "FROZEN"
                    else "UNAUTHORIZED" if val_reason == "UNAUTHORIZED" else "DEAD")
            await asyncio.to_thread(record_session_meta, fn, None,
                                    validation_status="invalid", spam_status=spam,
                                    validation_reason=(val_reason or None))
        elif status_val and status_val != "UNKNOWN":
            await asyncio.to_thread(record_session_meta, fn, None,
                                    validation_status="valid", spam_status=status_val,
                                    spam_details=status_details, last_spambot_check_at=time.time())
        else:
            await asyncio.to_thread(record_session_meta, fn, None, validation_status="valid")

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
        "UNAUTHORIZED": {"spam_status": "UNAUTHORIZED", "reason": "Session is no longer authorized (logged out). Replace or log in again.", "action": "replace", "severity": "critical"},
        "file missing": {"spam_status": "DEAD", "reason": "Session file not found on server. It may have been removed. Contact admin.", "action": "replace", "severity": "critical"},
        "in use by posting": {"spam_status": "BUSY", "reason": "Session is currently being used for posting. Try checking again in a few minutes.", "action": "none", "severity": "ok"},
    }

    results = []
    for fn in valid_files:
        val_ok, val_reason = validation_results.get(fn, (True, ""))
        spam_status = statuses.get(fn, "UNKNOWN")
        spam_details = (detailed_checks.get(fn) or {}).get("details")

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
            reason = info["reason"]
            if spam_status == SPAM_TEMP_LIMITED and spam_details:
                reason = f"Temporarily limited by Telegram until {spam_details}."
            results.append({
                "session_file": fn,
                "real_name": (real_name or fn).replace(".session", ""),
                "spam_status": spam_status,
                "reason": reason,
                "details": spam_details,
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
    _ensure_not_frozen(cfg)
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
    unchecked_sessions = []  # sessions with no diagnosis — we'll live-check them
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
            # No stats or diagnosis — collect for live check
            unchecked_sessions.append(sf)
            _log.info("  Session %s: no stats/diagnosis, will live-check.", sf)

    # ── Quick live validation for unchecked sessions ──
    if unchecked_sessions:
        _log.info("  Live-checking %d unchecked sessions...", len(unchecked_sessions))
        for sf in unchecked_sessions:
            path = app_config.SESSIONS_ACTIVE / sf
            is_dead = False
            dead_reason = ""
            if not path.is_file():
                is_dead = True
                dead_reason = "file_missing"
            else:
                try:
                    from code.session_guard import guarded_client
                    client = guarded_client(path, "session validation", wait_timeout=3, expected_sec=30)
                    try:
                        await asyncio.wait_for(client.connect(), timeout=8.0)
                        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=5.0)
                        if not authorized:
                            is_dead = True
                            dead_reason = "UNAUTHORIZED"
                    except Exception as e:
                        err = str(e).lower()
                        if any(w in err for w in ("deactivated", "banned", "frozen", "revoked", "unregistered")):
                            is_dead = True
                            dead_reason = "FROZEN"
                        elif "authkey" in type(e).__name__.lower():
                            is_dead = True
                            dead_reason = "REVOKED"
                        # else: connection error, don't assume dead
                    finally:
                        try:
                            await client.disconnect()
                        except Exception:
                            pass
                except asyncio.TimeoutError:
                    pass  # timeout — don't assume dead
                except Exception:
                    pass

            if is_dead:
                real_name = sf
                for s in sessions_cfg:
                    if isinstance(s, dict) and s.get("file") == sf:
                        real_name = s.get("real_name", sf)
                        break
                valid_sessions.append({
                    "session_file": sf,
                    "real_name": real_name,
                    "failure_rate": 1.0,
                    "spam_status": dead_reason or "DEAD",
                })
                _log.info("  Session %s: LIVE CHECK = DEAD (%s) — allowing replace", sf, dead_reason)
                # Canonical failure status — unauthorized stays distinct from dead/revoked.
                _spam = ("FROZEN" if dead_reason == "FROZEN"
                         else "UNAUTHORIZED" if dead_reason == "UNAUTHORIZED" else "DEAD")
                # Save diagnosis
                if _name:
                    import time as _t
                    _ss.setdefault(sf, {})["_last_spam_status"] = _spam
                    _ss[sf]["_last_health_check_ts"] = _t.time()
                    _st["session_stats"] = _ss
                    from code.utils import save_stats as _save_stats
                    _save_stats(_name, _st)
                # Mirror into the shared per-session cache (admin Sessions health stays in sync).
                from code.utils import record_session_meta as _record_meta
                await asyncio.to_thread(_record_meta, sf, None,
                                        validation_status="invalid", spam_status=_spam)
            else:
                _log.info("  Session %s: LIVE CHECK = ALIVE. Skipping.", sf)

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
                e["status"] = "ready"  # reflect in response
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

    from code.session_guard import SessionBusyError, guarded_client
    client = guarded_client(path, "account profile update", wait_timeout=15, expected_sec=60)
    results: dict = {}
    try:
        try:
            await client.connect()
        except SessionBusyError as e:
            raise HTTPException(423, str(e))
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
    _ensure_not_frozen(cfg)
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

    from code.session_guard import SessionBusyError, guarded_client
    client = guarded_client(path, "reading account info", wait_timeout=8, expected_sec=20)
    try:
        try:
            await client.connect()
        except SessionBusyError as e:
            raise HTTPException(423, str(e))
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


# ── Portal Notifications ──────────────────────────────────────────────────────

import time as _time
import json as _json

def _notif_path(bot_name: str):
    from code import config
    return config.DATA_DIR / "notifications" / f"{bot_name.lower()}.json"


def _load_notifs(bot_name: str) -> list[dict]:
    p = _notif_path(bot_name)
    if not p.exists():
        return []
    try:
        data = _json.loads(p.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_notifs(bot_name: str, notifs: list[dict]):
    p = _notif_path(bot_name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_json.dumps(notifs[-50:], indent=2), "utf-8")  # keep last 50


def add_portal_notification(
    bot_name: str,
    title: str,
    message: str,
    type: str = "info",  # info, success, warning, error
    icon: str = "",
):
    """Add a notification for a user's bot portal.
    Called from replacement system, admin actions, etc."""
    notifs = _load_notifs(bot_name)
    notifs.append({
        "id": f"{int(_time.time()*1000)}_{len(notifs)}",
        "title": title,
        "message": message,
        "type": type,
        "icon": icon,
        "ts": _time.time(),
        "read": False,
    })
    _save_notifs(bot_name, notifs)


@router.get("/bot/{bot_name}/notifications")
async def portal_get_notifications(bot_name: str, telegram_id: int = Query(...)):
    """Get notifications for user's bot portal."""
    await _get_user_bot(telegram_id, bot_name)  # auth check
    notifs = _load_notifs(bot_name)
    unread = sum(1 for n in notifs if not n.get("read"))
    return {
        "notifications": list(reversed(notifs[-30:])),  # newest first
        "unread_count": unread,
    }


@router.post("/bot/{bot_name}/notifications/read")
async def portal_mark_notifications_read(bot_name: str, telegram_id: int = Query(...)):
    """Mark all notifications as read."""
    await _get_user_bot(telegram_id, bot_name)
    notifs = _load_notifs(bot_name)
    for n in notifs:
        n["read"] = True
    _save_notifs(bot_name, notifs)
    return {"marked": len(notifs)}


@router.post("/bot/{bot_name}/notifications/{notif_id}/dismiss")
async def portal_dismiss_notification(bot_name: str, notif_id: str, telegram_id: int = Query(...)):
    """Dismiss (delete) a single notification."""
    await _get_user_bot(telegram_id, bot_name)
    notifs = _load_notifs(bot_name)
    notifs = [n for n in notifs if n.get("id") != notif_id]
    _save_notifs(bot_name, notifs)
    return {"dismissed": True}


# ── Replacement Crypto Payment ───────────────────────────────────────────────

class ReplacementPayRequest(BaseModel):
    entry_id: str
    currency: str  # internal code e.g. "BTC", "USDT_TRC20"


@router.post("/bot/{bot_name}/replacement/pay")
async def portal_replacement_create_invoice(
    bot_name: str, body: ReplacementPayRequest, telegram_id: int = Query(...)
):
    """Create a NOWPayments invoice for a pending_payment replacement entry."""
    _token, cfg = await _get_user_bot(telegram_id, bot_name)
    _ensure_not_frozen(cfg)

    from code.replacement import load_replacement_queue, save_replacement_queue, _queue_lock
    from code.shop.payment import create_invoice
    from code.shop.payment_constants import SUPPORTED_PAY_CURRENCIES

    with _queue_lock:
        queue = load_replacement_queue()
        entry = None
        for e in queue:
            if e.get("id") == body.entry_id:
                entry = e
                break
        if not entry:
            raise HTTPException(404, "Replacement entry not found")
        if entry.get("status") not in ("pending_payment",):
            if entry.get("status") == "ready":
                raise HTTPException(400, "This replacement is already paid and queued for processing. No payment needed.")
            elif entry.get("status") == "completed":
                raise HTTPException(400, "This replacement has already been completed.")
            raise HTTPException(400, f"Entry status is '{entry.get('status')}', expected 'pending_payment'")
        if entry.get("bot_name", "").lower() != bot_name.lower():
            raise HTTPException(403, "Entry does not belong to this bot")

        amount_usd = float(entry.get("price_usd", 2.0))
        order_id = entry["id"]

        # Validate currency
        if body.currency.upper() not in SUPPORTED_PAY_CURRENCIES:
            raise HTTPException(
                400,
                f"Unsupported currency: {body.currency}. Supported: {', '.join(sorted(SUPPORTED_PAY_CURRENCIES.keys()))}"
            )

    # Create invoice (outside lock - network call)
    invoice = create_invoice(
        amount_usd=amount_usd,
        currency=body.currency.upper(),
        order_id=order_id,
        description=f"Session replacement: {entry.get('real_name', entry.get('session_file', ''))}",
    )

    if invoice.get("_invoice_failed"):
        reason = invoice.get("_reason", "unknown")
        raise HTTPException(502, f"Failed to create payment invoice: {reason}")

    # Save invoice data onto the entry
    with _queue_lock:
        queue = load_replacement_queue()
        for e in queue:
            if e.get("id") == body.entry_id:
                e["payment_id"] = invoice.get("payment_id", "")
                e["invoice_data"] = {
                    "pay_address": invoice.get("pay_address", ""),
                    "pay_amount": invoice.get("pay_amount", 0),
                    "pay_currency": invoice.get("pay_currency", ""),
                    "invoice_expiry": invoice.get("invoice_expiry", ""),
                    "invoice_expires_at": invoice.get("invoice_expires_at", ""),
                }
                e["status"] = "pending_payment"  # stays pending until confirmed
                break
        save_replacement_queue(queue)

    return {
        "payment_id": invoice.get("payment_id", ""),
        "pay_address": invoice.get("pay_address", ""),
        "pay_amount": invoice.get("pay_amount", 0),
        "pay_currency": invoice.get("pay_currency", ""),
        "amount_usd": amount_usd,
        "invoice_expiry": invoice.get("invoice_expiry", ""),
        "invoice_expires_at": invoice.get("invoice_expires_at", ""),
        "entry_id": body.entry_id,
    }


@router.get("/bot/{bot_name}/replacement/{entry_id}/status")
async def portal_replacement_payment_status(
    bot_name: str, entry_id: str, telegram_id: int = Query(...)
):
    """Poll payment status for a replacement entry."""
    await _get_user_bot(telegram_id, bot_name)

    from code.replacement import load_replacement_queue, mark_replacement_paid, _queue_lock
    from code.shop.payment import get_payment_details, is_payment_success
    from code.shop.explorer import build_explorer_link, normalize_network_for_explorer

    queue = load_replacement_queue()
    entry = None
    for e in queue:
        if e.get("id") == entry_id:
            entry = e
            break
    if not entry:
        raise HTTPException(404, "Replacement entry not found")
    if entry.get("bot_name", "").lower() != bot_name.lower():
        raise HTTPException(403, "Entry does not belong to this bot")

    # If already paid/ready/completed, return immediately
    if entry.get("status") in ("ready", "completed", "awaiting_session"):
        return {
            "status": entry["status"],
            "payment_confirmed": True,
            "entry_id": entry_id,
        }

    payment_id = entry.get("payment_id", "")
    if not payment_id:
        return {
            "status": "pending_payment",
            "payment_confirmed": False,
            "message": "No invoice created yet",
            "entry_id": entry_id,
        }

    # Poll NOWPayments
    details = get_payment_details(payment_id)
    if details is None:
        return {
            "status": "pending_payment",
            "payment_confirmed": False,
            "message": "Waiting for payment...",
            "entry_id": entry_id,
        }

    pay_status = (details.get("payment_status") or "waiting").lower()
    amount_received = float(details.get("amount_received") or 0)
    pay_amount = float(details.get("pay_amount") or 0)
    tx_hash = details.get("tx_hash", "")
    network = details.get("network", "")
    pay_currency = details.get("pay_currency", "")

    explorer_link = None
    if tx_hash:
        net_key = normalize_network_for_explorer(pay_currency, network)
        explorer_link = build_explorer_link(net_key, tx_hash)

    if is_payment_success(pay_status):
        # Mark as paid and transition to ready
        mark_replacement_paid(entry_id, payment_id=payment_id)
        add_portal_notification(
            bot_name,
            title="Payment Confirmed ✓",
            message=f"Payment received for {entry.get('real_name', entry.get('session_file', ''))}. Replacement will be processed shortly.",
            type="success",
            icon="swap",
        )
        # Auto-process immediately
        try:
            from code.replacement import process_ready_replacements
            import asyncio
            await asyncio.to_thread(lambda: asyncio.run(process_ready_replacements()))
        except Exception as exc:
            logger.warning("Auto-process after payment failed: %s", exc)

        return {
            "status": "ready",
            "payment_confirmed": True,
            "amount_received": amount_received,
            "tx_hash": tx_hash,
            "explorer_link": explorer_link,
            "entry_id": entry_id,
        }

    return {
        "status": "pending_payment",
        "payment_confirmed": False,
        "payment_status": pay_status,
        "amount_received": amount_received,
        "pay_amount": pay_amount,
        "tx_hash": tx_hash,
        "explorer_link": explorer_link,
        "message": "Waiting for payment confirmation..." if pay_status == "waiting" else f"Status: {pay_status}",
        "entry_id": entry_id,
    }


@router.get("/crypto/currencies")
async def portal_get_crypto_currencies():
    """Return supported crypto currencies with CoinGecko logos and live prices.
    No auth required — public endpoint for the payment UI."""
    import requests as _requests

    from code.shop.payment_constants import SUPPORTED_PAY_CURRENCIES

    # CoinGecko ID mapping for each internal code
    COINGECKO_IDS = {
        "BTC": "bitcoin",
        "ETH": "ethereum",
        "LTC": "litecoin",
        "XMR": "monero",
        "TRX": "tron",
        "DOGE": "dogecoin",
        "XRP": "ripple",
        "SOL": "solana",
        "BNB": "binancecoin",
        "MATIC": "matic-network",
        "ADA": "cardano",
        "TON": "the-open-network",
        "USDT_TRC20": "tether",
        "USDT_BEP20": "tether",
        "USDT_ERC20": "tether",
        "USDT_SOL": "tether",
        "USDT_ARB": "tether",
        "USDC_BEP20": "usd-coin",
        "USDC_ERC20": "usd-coin",
        "USDC_SOL": "usd-coin",
        "USDC_MATIC": "usd-coin",
        "USDC_ARB": "usd-coin",
    }

    NETWORK_LABELS = {
        "USDT_TRC20": "TRC-20", "USDT_BEP20": "BEP-20", "USDT_ERC20": "ERC-20",
        "USDT_SOL": "Solana", "USDT_ARB": "Arbitrum",
        "USDC_BEP20": "BEP-20", "USDC_ERC20": "ERC-20", "USDC_SOL": "Solana",
        "USDC_MATIC": "Polygon", "USDC_ARB": "Arbitrum",
    }

    DISPLAY_NAMES = {
        "BTC": "Bitcoin", "ETH": "Ethereum", "LTC": "Litecoin",
        "XMR": "Monero", "TRX": "TRON", "DOGE": "Dogecoin",
        "XRP": "Ripple", "SOL": "Solana", "BNB": "BNB",
        "MATIC": "Polygon", "ADA": "Cardano", "TON": "TON",
        "USDT_TRC20": "Tether", "USDT_BEP20": "Tether", "USDT_ERC20": "Tether",
        "USDT_SOL": "Tether", "USDT_ARB": "Tether",
        "USDC_BEP20": "USD Coin", "USDC_ERC20": "USD Coin", "USDC_SOL": "USD Coin",
        "USDC_MATIC": "USD Coin", "USDC_ARB": "USD Coin",
    }

    SYMBOLS = {
        "BTC": "BTC", "ETH": "ETH", "LTC": "LTC", "XMR": "XMR",
        "TRX": "TRX", "DOGE": "DOGE", "XRP": "XRP", "SOL": "SOL",
        "BNB": "BNB", "MATIC": "MATIC", "ADA": "ADA", "TON": "TON",
        "USDT_TRC20": "USDT", "USDT_BEP20": "USDT", "USDT_ERC20": "USDT",
        "USDT_SOL": "USDT", "USDT_ARB": "USDT",
        "USDC_BEP20": "USDC", "USDC_ERC20": "USDC", "USDC_SOL": "USDC",
        "USDC_MATIC": "USDC", "USDC_ARB": "USDC",
    }

    # Fetch from CoinGecko (free API, no key needed)
    unique_ids = list(set(COINGECKO_IDS.values()))
    prices: dict = {}
    logos: dict = {}
    try:
        url = "https://api.coingecko.com/api/v3/coins/markets"
        resp = _requests.get(url, params={
            "vs_currency": "usd",
            "ids": ",".join(unique_ids),
            "order": "market_cap_desc",
            "per_page": 50,
            "page": 1,
            "sparkline": "false",
        }, timeout=10)
        if resp.status_code == 200:
            for coin in resp.json():
                cid = coin.get("id", "")
                prices[cid] = coin.get("current_price", 0)
                logos[cid] = coin.get("image", "")
    except Exception as exc:
        logger.warning("CoinGecko fetch failed: %s", exc)

    # Build response
    currencies = []
    for internal_code in SUPPORTED_PAY_CURRENCIES:
        cg_id = COINGECKO_IDS.get(internal_code, "")
        network = NETWORK_LABELS.get(internal_code, "")
        is_stablecoin = internal_code.startswith("USDT") or internal_code.startswith("USDC")
        currencies.append({
            "code": internal_code,
            "symbol": SYMBOLS.get(internal_code, internal_code),
            "name": DISPLAY_NAMES.get(internal_code, internal_code),
            "network": network,
            "logo": (logos.get(cg_id, "") or "").replace("https://coin-images.coingecko.com/", "/coin-img/"),
            "price_usd": prices.get(cg_id, 1.0 if is_stablecoin else 0),
            "is_stablecoin": is_stablecoin,
        })

    return {"currencies": currencies}


# ─────────────── Pre-start session health check ───────────────
@router.get("/bot/{bot_name}/session-locks")
async def portal_session_locks(bot_name: str, telegram_id: int = Query(...)):
    """Which of this bot's sessions are currently held by a task, by whom, and the
    estimated wait. Lets the UI explain 'why is this locked' instead of raw errors."""
    from pathlib import Path as _Path
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)
    from code.session_guard import describe_locks
    names = set()
    for s in cfg.get("sessions") or []:
        fn = s.get("file") if isinstance(s, dict) else s
        if fn:
            names.add(_Path(fn).name)
    locks = [l for l in describe_locks() if l["session_file"] in names]
    return {"locks": locks, "total": len(locks)}


@router.get("/bot/{bot_name}/pre-start-check")
async def portal_pre_start_check(bot_name: str, telegram_id: int = Query(...)):
    """Live pre-start health check: connects to Telegram to validate each session.
    Returns per-session alive/dead status so the user knows before starting."""
    import time as _time
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)

    from code.utils import load_stats, get_name_by_token, save_stats
    from code import config as app_config
    name = get_name_by_token(bot_token)

    sessions_cfg = cfg.get("sessions", [])
    if not sessions_cfg:
        return {"ok": False, "reason": "no_sessions", "sessions": [], "healthy": 0, "dead": 0, "total": 0}

    # Load existing stats for enrichment
    bot_stats = {}
    st = None
    if name:
        st = load_stats(name) or {}
        bot_stats = st.get("session_stats", {})

    # ── Live validation: connect to Telegram for each session ──
    async def _validate_session(fn: str):
        """Non-destructive: connect + is_user_authorized, no file moves."""
        path = app_config.SESSIONS_ACTIVE / fn
        if not path.is_file():
            return fn, False, "file_missing"
        try:
            from code.session_guard import SessionBusyError, guarded_client
            client = guarded_client(path, "pre-start health check", wait_timeout=4, expected_sec=30)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    return fn, False, "UNAUTHORIZED"
                return fn, True, ""
            except SessionBusyError as e:
                # Held by another task (chatlist sync, portal, …) — not dead, just busy.
                return fn, None, str(e)[:200]
            except Exception as e:
                err = str(e).lower()
                if "database is locked" in err:
                    return fn, None, "Session file is briefly locked (another task just used it) — try again in ~30s"
                if "deactivated" in err or "banned" in err or "frozen" in err:
                    return fn, False, "FROZEN"
                if "revoked" in err or "unregistered" in err or "authkey" in type(e).__name__.lower():
                    return fn, False, "REVOKED"
                return fn, False, str(e)[:60]
            finally:
                await client.disconnect()
        except Exception as e:
            return fn, False, str(e)[:60]

    # Run all validations in parallel with timeout
    import asyncio
    tasks = []
    for s in sessions_cfg:
        sf = s.get("file") if isinstance(s, dict) else s
        tasks.append(asyncio.wait_for(_validate_session(sf), timeout=12.0))

    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    results = []
    healthy_count = 0
    dead_count = 0

    for i, s in enumerate(sessions_cfg):
        sf = s.get("file") if isinstance(s, dict) else s
        real_name = (s.get("real_name", sf) if isinstance(s, dict) else sf).replace(".session", "")
        ss = bot_stats.get(sf, {})
        lt_sent = int(ss.get("lifetime_sent", 0))
        lt_failed = int(ss.get("lifetime_failed", 0))

        # Parse validation result
        r = raw_results[i]
        if isinstance(r, Exception):
            # Timeout or unexpected error — assume alive
            alive, reason_str = True, ""
            status, severity, reason = "healthy", "ok", "Session check timed out (assumed OK)"
            healthy_count += 1
        elif isinstance(r, tuple):
            _, alive, reason_str = r
            if alive is None:
                # Busy: another task holds the session right now. It works — show
                # who has it and when to retry instead of marking it dead.
                alive = True
                status, severity, reason = "busy", "warning", reason_str
                healthy_count += 1
            elif alive:
                status, severity, reason = "healthy", "ok", "Session is alive and authorized"
                healthy_count += 1
            else:
                dead_count += 1
                if reason_str in ("FROZEN",):
                    status, severity, reason = "dead", "critical", "Account is frozen/banned by Telegram"
                elif reason_str in ("REVOKED", "UNAUTHORIZED"):
                    status, severity, reason = "dead", "critical", "Session logged out or revoked"
                elif reason_str == "file_missing":
                    status, severity, reason = "dead", "critical", "Session file not found on server"
                else:
                    status, severity, reason = "dead", "critical", f"Session failed: {reason_str}"
        else:
            alive = True
            status, severity, reason = "healthy", "ok", "Session appears healthy"
            healthy_count += 1

        # Canonical failure status — unauthorized/logged-out stays distinct from dead.
        _rs = (reason_str or "").upper()
        _fail_spam = ("FROZEN" if _rs == "FROZEN"
                      else "UNAUTHORIZED" if _rs == "UNAUTHORIZED" else "DEAD")

        # Save diagnosis result into stats
        if st is not None and name:
            session_stats = st.setdefault("session_stats", {})
            ss2 = session_stats.get(sf, {})
            ss2["_last_health_check_ts"] = _time.time()
            if not alive:
                ss2["_last_spam_status"] = _fail_spam
            session_stats[sf] = ss2

        # Mirror into the shared per-session cache so admin Sessions health stays unified.
        # (busy sessions are left as-is; their cached record is still valid.)
        if status == "dead":
            from code.utils import record_session_meta as _record_meta
            await asyncio.to_thread(_record_meta, sf, None,
                                    validation_status="invalid", spam_status=_fail_spam)
        elif status == "healthy":
            from code.utils import record_session_meta as _record_meta
            await asyncio.to_thread(_record_meta, sf, None, validation_status="valid")

        results.append({
            "session_file": sf,
            "real_name": real_name,
            "status": status,
            "severity": severity,
            "reason": reason,
            "lifetime_sent": lt_sent,
            "lifetime_failed": lt_failed,
        })

    # Persist diagnosis results
    if st is not None and name:
        save_stats(name, st)

    total = len(sessions_cfg)
    return {
        "ok": dead_count == 0,
        "healthy": healthy_count,
        "dead": dead_count,
        "total": total,
        "sessions": results,
    }


# ══════════════════════════════════════════════════════════
#  SUPPORT TICKETS
# ══════════════════════════════════════════════════════════

SUPPORT_TICKETS_FILE = __import__("pathlib").Path("data/support_tickets.json")


def _load_tickets() -> list[dict]:
    import json
    if SUPPORT_TICKETS_FILE.is_file():
        try:
            return json.loads(SUPPORT_TICKETS_FILE.read_text("utf-8"))
        except Exception:
            return []
    return []


def _save_tickets(tickets: list[dict]):
    import json
    SUPPORT_TICKETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SUPPORT_TICKETS_FILE.write_text(json.dumps(tickets, indent=2, default=str), "utf-8")


@router.post("/bot/{bot_name}/support-ticket")
async def portal_create_support_ticket(
    bot_name: str,
    body: PortalSupportTicketRequest,
    telegram_id: int = Query(...),
):
    """Create a support ticket for a session issue."""
    import time, uuid
    bot_token, cfg = await _get_user_bot(telegram_id, bot_name)

    # Verify session belongs to this bot
    sessions_cfg = cfg.get("sessions", [])
    valid = False
    for s in sessions_cfg:
        sf = s.get("file") if isinstance(s, dict) else s
        if sf == body.session_file:
            valid = True
            break
    if not valid:
        raise HTTPException(400, "Session does not belong to this bot")

    ticket = {
        "id": str(uuid.uuid4())[:8],
        "bot_name": bot_name,
        "telegram_id": telegram_id,
        "session_file": body.session_file,
        "session_name": body.session_name,
        "issue_type": body.issue_type,
        "diag_status": body.diag_status,
        "fail_rate": body.fail_rate,
        "message": body.message[:1000],  # limit message length
        "status": "open",
        "created_at": time.time(),
        "admin_reply": None,
    }

    tickets = _load_tickets()
    tickets.insert(0, ticket)
    _save_tickets(tickets)

    logger.info("Support ticket created: %s by telegram_id=%s bot=%s session=%s",
                ticket["id"], telegram_id, bot_name, body.session_file)

    return {"ok": True, "ticket_id": ticket["id"], "message": "Support ticket submitted. Admin will review it."}


@router.get("/bot/{bot_name}/support-tickets")
async def portal_get_support_tickets(bot_name: str, telegram_id: int = Query(...)):
    """Get support tickets for a user's bot."""
    await _get_user_bot(telegram_id, bot_name)
    tickets = _load_tickets()
    user_tickets = [t for t in tickets if t.get("bot_name") == bot_name and t.get("telegram_id") == telegram_id]
    return {"tickets": user_tickets}


# ── Admin endpoints for support tickets ──

@router.get("/admin/support-tickets")
async def admin_list_support_tickets():
    """List all support tickets (admin only — auth handled by admin session)."""
    tickets = _load_tickets()
    return {"tickets": tickets, "total": len(tickets), "open": sum(1 for t in tickets if t.get("status") == "open")}


@router.patch("/admin/support-tickets/{ticket_id}")
async def admin_update_support_ticket(ticket_id: str, status: str = Query(None), reply: str = Query(None)):
    """Update a support ticket — close it or add admin reply."""
    import time
    tickets = _load_tickets()
    for t in tickets:
        if t.get("id") == ticket_id:
            if status:
                t["status"] = status
            if reply:
                t["admin_reply"] = reply
                t["replied_at"] = time.time()
            _save_tickets(tickets)
            return {"ok": True, "ticket": t}
    raise HTTPException(404, "Ticket not found")


# ════════════════════════════════════════════════════════════════════
#  WEB PURCHASE FLOW  (buy a new AdBot from the website)
#  Frontend drives the UI; backend creates the NOWPayments invoice,
#  reserves a pooled @BotFather token, stores the order, and on payment
#  hands off to the existing creation pipeline (orders.json + worker).
# ════════════════════════════════════════════════════════════════════

class PurchaseReference(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    telegram_username: Optional[str] = None
    telegram_id: Optional[int] = None


class PurchaseCreateRequest(BaseModel):
    plan_id: str
    plan_mode: str                 # "starter" | "enterprise"
    billing: str                   # "week" | "month"
    currency: str                  # e.g. "BTC", "USDT_TRC20"
    reference: Optional[PurchaseReference] = None
    coupon: Optional[str] = None


class CouponValidateRequest(BaseModel):
    code: str
    plan_id: str
    plan_mode: str
    billing: str            # "week" | "month"


class PurchaseContactRequest(BaseModel):
    email: Optional[str] = None
    telegram_id: Optional[int] = None
    telegram_username: Optional[str] = None


class BotTokenAddRequest(BaseModel):
    tokens: list[str]


def _find_plan(plan_mode: str, plan_id: str):
    """Return (plan_dict, mode) or (None, None)."""
    from code.shop.storage import load_plans
    plans = load_plans()
    mode = (plan_mode or "").strip().lower()
    for p in plans.get(mode, []):
        if p.get("id") == plan_id:
            return p, mode
    for m, lst in plans.items():
        for p in lst:
            if p.get("id") == plan_id:
                return p, m
    return None, None


def _creation_progress(order: dict) -> dict:
    """High-level creation state for the web UI to animate the build log."""
    status = order.get("status", "payment_waiting")
    if status == "completed":
        return {"state": "completed", "percent": 100}
    if status in ("creating",):
        return {"state": "creating", "percent": 70}
    if status == "pending_creation":
        # pending_creation always means "paid, waiting on capacity (sessions or token)".
        # Show 'queued' until an actual bot username exists, so we never animate a build
        # that hasn't started.
        return {"state": "queued" if not order.get("created_bot_username") else "creating", "percent": 40}
    if status == "paid":
        return {"state": "starting", "percent": 15}
    if status in ("failed", "cancelled", "expired", "invoice_failed"):
        return {"state": "failed", "percent": 0}
    return {"state": "awaiting_payment", "percent": 0}


@router.post("/coupon/validate")
async def portal_coupon_validate(body: CouponValidateRequest):
    from code.shop import coupons as coupons_mod

    plan, mode = _find_plan(body.plan_mode, body.plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    if body.billing not in ("week", "month"):
        raise HTTPException(400, "billing must be 'week' or 'month'")
    base = float(plan.get("price_month" if body.billing == "month" else "price_week", 0) or 0)

    r = coupons_mod.validate_coupon(body.code, plan_id=body.plan_id, billing=body.billing, base_amount_usd=base)
    return {
        "valid": r["ok"],
        "reason": r["reason"],
        "code": body.code.strip().upper(),
        "type": (r["coupon"] or {}).get("type", ""),
        "value": (r["coupon"] or {}).get("value", 0),
        "discount_usd": r["discount_usd"],
        "final_amount_usd": r["final_amount_usd"],
    }


@router.post("/purchase/create")
async def portal_purchase_create(body: PurchaseCreateRequest):
    """Create a web purchase: NOWPayments invoice + reserve a pooled bot token + store order."""
    from code.shop.storage import create_order, update_order
    from code.shop.payment import create_invoice, get_min_amount_usd
    from code.shop.payment_constants import internal_to_provider
    from code.shop import token_pool, coupons as coupons_mod

    plan, mode = _find_plan(body.plan_mode, body.plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    if body.billing not in ("week", "month"):
        raise HTTPException(400, "billing must be 'week' or 'month'")
    if not (body.currency or "").strip():
        raise HTTPException(400, "currency is required")

    base = float(plan.get("price_month" if body.billing == "month" else "price_week", 0) or 0)
    if base <= 0:
        raise HTTPException(400, "Plan price is not configured")

    ref = body.reference or PurchaseReference()
    display = (ref.name or ref.telegram_username or ref.email or "").strip()
    user_id = int(ref.telegram_id) if ref.telegram_id else 0
    plan_name = plan.get("name") or body.plan_id.capitalize()

    coupon_code = (body.coupon or "").strip()
    coupon_type = ""
    coupon_value: float = 0
    amount = base
    if coupon_code:
        user_key = str(user_id) if user_id else (ref.email or "").strip().lower()
        r = coupons_mod.validate_coupon(coupon_code, plan_id=body.plan_id, billing=body.billing, base_amount_usd=base, user_key=user_key)
        if not r["ok"]:
            raise HTTPException(400, r["reason"] or "Invalid coupon")
        amount = r["final_amount_usd"]
        coupon_type = r["coupon"]["type"]
        coupon_value = r["coupon"]["value"]

    duration_days = 30 if body.billing == "month" else 7

    # Payment-floor safety net: NOWPayments' real minimum varies by coin (~$2-$12+). Applies to
    # every order, not just coupon ones — a full-price cheap plan paid in a high-minimum coin
    # has the same failure mode. Fails OPEN (skips the check) if the lookup itself fails; the
    # flat MIN_PAYABLE_USD_FLOOR inside validate_coupon already caught the coupon-specific case.
    provider_currency = internal_to_provider(body.currency)
    if provider_currency:
        min_usd = get_min_amount_usd(provider_currency)
        if min_usd is not None and amount < min_usd:
            raise HTTPException(
                400,
                f"This order total (${amount:.2f}) is below the ${min_usd:.2f} minimum for {body.currency}. "
                f"Choose a different currency{' or a smaller discount' if coupon_code else ''}.",
            )

    # Idempotency: if this identifiable buyer already has an OPEN, unexpired invoice for the
    # exact same plan + billing + currency, return THAT one instead of minting a duplicate
    # order + address. Page reloads / double-clicks otherwise spawn several live invoices.
    if user_id:
        try:
            from code.shop.storage import load_orders as _load_orders
            from datetime import datetime as _dt
            now_dt = _dt.utcnow()
            for _o in _load_orders():
                if _o.get("source") != "web" or _o.get("status") not in ("payment_waiting", "confirming"):
                    continue
                if int(_o.get("user_id") or 0) != user_id:
                    continue
                if _o.get("plan_id") != body.plan_id or _o.get("plan_mode") != mode:
                    continue
                if int(_o.get("duration_days") or 0) != duration_days:
                    continue
                if (_o.get("currency") or "").upper() != (body.currency or "").upper():
                    continue
                if not (_o.get("pay_address") or ""):
                    continue
                _exp = (_o.get("invoice_expires_at") or "").strip()
                if _exp:
                    try:
                        if now_dt > _dt.strptime(_exp.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S"):
                            continue
                    except ValueError:
                        pass
                return {
                    "order_id": _o.get("order_id", ""),
                    "plan_id": body.plan_id,
                    "plan_name": plan_name,
                    "plan_mode": mode,
                    "billing": body.billing,
                    "duration_days": duration_days,
                    "display_name": _o.get("bot_name") or display,
                    "base_amount_usd": float(_o.get("base_amount_usd") or base),
                    "coupon": (_o.get("coupon") or "").upper(),
                    "coupon_type": _o.get("coupon_type") or "",
                    "coupon_value": float(_o.get("coupon_value") or 0),
                    "amount_usd": float(_o.get("amount_usd") or amount),
                    "pay_address": _o.get("pay_address") or "",
                    "pay_amount": _o.get("pay_amount"),
                    "pay_currency": (_o.get("pay_currency") or body.currency).upper(),
                    "invoice_expires_at": _o.get("invoice_expires_at") or "",
                    "queued": token_pool.count_available() == 0,
                    "reused": True,
                }
        except Exception:
            pass

    order = create_order(
        user_id=user_id,
        plan_id=body.plan_id,
        plan_name=plan_name,
        plan_mode=mode,
        duration_days=duration_days,
        amount_usd=amount,
        payment_id="",
        currency=body.currency,
    )
    order_id = order["order_id"]
    if not display:
        display = f"USER{order_id[:4].upper()}"

    invoice = create_invoice(
        amount_usd=amount, currency=body.currency, order_id=order_id,
        description=f"AdBot {plan_name} ({duration_days}d)",
    )
    if invoice.get("_invoice_failed"):
        update_order(order_id, {"status": "invoice_failed"})
        reason = invoice.get("_reason", "")
        raise HTTPException(400, "Selected payment method is temporarily unavailable." if reason == "unavailable"
                            else "Invoice creation failed. Try another currency.")

    update_order(order_id, {
        "payment_id": invoice.get("payment_id", ""),
        "pay_address": invoice.get("pay_address") or "",
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": (invoice.get("pay_currency") or body.currency).upper(),
        "invoice_expiry": invoice.get("invoice_expiry") or "",
        "invoice_expires_at": invoice.get("invoice_expires_at") or "",
        "bot_name": display,
        "ref_name": ref.name or "",
        "ref_email": ref.email or "",
        "ref_username": ref.telegram_username or "",
        "coupon": coupon_code.upper(),
        "coupon_type": coupon_type,
        "coupon_value": coupon_value,
        "base_amount_usd": base,
        "source": "web",
        # Token is reserved at PAYMENT time (apply_confirmed_payment), never at creation —
        # so unpaid / abandoned / spam orders can't lock up the pool. This is just a UI hint.
        "queued": token_pool.count_available() == 0,
    })

    return {
        "order_id": order_id,
        "plan_id": body.plan_id,
        "plan_name": plan_name,
        "plan_mode": mode,
        "billing": body.billing,
        "duration_days": duration_days,
        "display_name": display,
        "base_amount_usd": base,
        "coupon": coupon_code.upper(),
        "coupon_type": coupon_type,
        "coupon_value": coupon_value,
        "amount_usd": amount,
        "pay_address": invoice.get("pay_address") or "",
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": (invoice.get("pay_currency") or body.currency).upper(),
        "invoice_expires_at": invoice.get("invoice_expires_at") or "",
        "queued": token_pool.count_available() == 0,
    }


@router.get("/purchase/{order_id}/status")
async def portal_purchase_status(order_id: str):
    """Report a web purchase's current state. Confirmation is driven by the IPN
    webhook (no provider polling here) — this only reads the stored order."""
    from code.shop.storage import get_order

    order = get_order(order_id)
    if not order:
        raise HTTPException(404, "Order not found")

    status = order.get("status", "payment_waiting")
    confirmed = status in ("paid", "creating", "pending_creation", "completed")
    amount_received = float(order.get("amount_received", 0) or 0)
    pay_amount = float(order.get("pay_amount") or 0)
    waiting = status in ("payment_waiting", "confirming")
    underpaid = waiting and amount_received > 0 and amount_received < pay_amount
    expired = status in ("expired", "cancelled", "failed")
    # Payment is done but the build can't start yet — we're out of ad-accounts (or a bot
    # token). Surface this distinctly so the UI stops showing a fake "building…" spinner
    # and instead tells the buyer they're queued (matches the Telegram shop-bot message).
    awaiting_capacity = status == "pending_creation" and not order.get("created_bot_username")
    queue_message = (
        "Payment received. We're briefly at capacity, so your AdBot is queued and will "
        "activate automatically — you'll be notified the moment it's ready."
        if awaiting_capacity else ""
    )

    # Fire notifications once, the first time we observe the bot is ready.
    if status == "completed" and not order.get("notified"):
        try:
            from code.shop.web_notify import notify_order_ready
            from code.shop.storage import update_order
            await notify_order_ready(order)
            update_order(order_id, {"notified": True})
        except Exception as exc:
            logger.warning("[NOTIFY] dispatch failed for %s: %s", order_id, exc)

    return {
        "order_id": order_id,
        "status": status,
        "payment_confirmed": confirmed,
        "amount_received": amount_received,
        "pay_amount": pay_amount,
        "remaining": round(pay_amount - amount_received, 8) if underpaid else 0,
        "underpaid": underpaid,
        "expired": expired,
        "awaiting_capacity": awaiting_capacity,
        "queue_message": queue_message,
        "tx_hash": order.get("tx_hash", "") or "",
        "queued": (bool(order.get("queued")) and not order.get("bot_token")) or awaiting_capacity,
        "creation": _creation_progress(order),
        "creation_step": order.get("creation_step", "") or "",
        "access_token": order.get("web_token", "") or "",
        "bot_username": order.get("bot_username", "") or order.get("created_bot_username", ""),
        "bot_name": order.get("bot_name", ""),
        "plan_name": order.get("plan_name", ""),
        "duration_days": order.get("duration_days", 0),
    }


@router.post("/purchase/{order_id}/contact")
async def portal_purchase_contact(order_id: str, body: PurchaseContactRequest):
    """Attach an email / Telegram id to an order so we can notify the buyer when their
    bot is ready (used by the website's 'notify me' field on the waiting screen)."""
    from code.shop.storage import get_order, update_order
    order = get_order(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    updates: dict = {}
    if body.email and body.email.strip():
        updates["ref_email"] = body.email.strip()
    if body.telegram_id:
        updates["notify_telegram_id"] = int(body.telegram_id)
    if body.telegram_username and body.telegram_username.strip():
        updates["ref_username"] = body.telegram_username.strip().lstrip("@")
    if updates:
        update_order(order_id, updates)
    return {"ok": True, "saved": list(updates.keys())}


def _verify_ipn_sig(raw: bytes, sig: str, secret: str) -> bool:
    """Verify NOWPayments IPN HMAC-SHA512 over the key-sorted JSON body."""
    import hmac, hashlib, json as _json
    if not sig or not secret:
        return False
    try:
        data = _json.loads(raw)
        sorted_body = _json.dumps(data, sort_keys=True, separators=(",", ":"))
    except Exception:
        return False
    digest = hmac.new(secret.encode(), sorted_body.encode(), hashlib.sha512).hexdigest()
    return hmac.compare_digest(digest, sig.strip())


@router.post("/payment/ipn")
async def nowpayments_ipn(request: Request):
    """NOWPayments IPN webhook — instant confirmation for web, bot, and renewal orders.
    Verifies the HMAC-SHA512 signature; performs no provider polling."""
    import json as _json
    from code import config as appcfg

    raw = await request.body()
    secret = getattr(appcfg, "NOWPAYMENTS_IPN_SECRET", "")
    if not secret:
        logger.error("[IPN] NOWPAYMENTS_IPN_SECRET not set — cannot verify webhook")
        raise HTTPException(503, "IPN not configured")
    sig = request.headers.get("x-nowpayments-sig", "")
    if not _verify_ipn_sig(raw, sig, secret):
        logger.warning("[IPN] signature verification failed")
        raise HTTPException(401, "Invalid signature")
    try:
        data = _json.loads(raw)
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    payment_id = str(data.get("payment_id") or "")
    pstatus = (data.get("payment_status") or "").lower()
    logger.info("[IPN] payment_id=%s status=%s", payment_id, pstatus)

    from code.shop.storage import get_order_by_payment_id, update_order, update_order_status
    from code.shop.payment import is_payment_success, is_payment_failed

    # Underpayment: record what was received so the UI can show "paid X, send Y more".
    if pstatus == "partially_paid":
        order = get_order_by_payment_id(payment_id)
        if order:
            update_order(order["order_id"], {
                "amount_received": float(data.get("actually_paid") or data.get("amount_received") or 0),
                "partial": True,
            })
        else:
            # Bot purchase still in temppay → DM the buyer how much is left.
            try:
                from code.shop.workers import webhook_temppay_partial
                await webhook_temppay_partial(payment_id, float(data.get("actually_paid") or data.get("amount_received") or 0))
            except Exception as exc:
                logger.warning("[IPN] temppay partial notify failed: %s", exc)
        return {"ok": True}

    # Invoice expired / failed: stop the order and release the reserved bot token.
    if is_payment_failed(pstatus):
        order = get_order_by_payment_id(payment_id)
        if order and order.get("status") in ("payment_waiting", "confirming"):
            try:
                update_order_status(order["order_id"], "expired" if pstatus == "expired" else "cancelled")
            except Exception:
                pass
            try:
                from code.shop import token_pool
                token_pool.release_order(order["order_id"])
            except Exception:
                pass
        elif not order:
            # Bot purchase still in temppay → remove it and tell the buyer.
            try:
                from code.shop.workers import webhook_temppay_expired
                handled = await webhook_temppay_expired(payment_id)
            except Exception as exc:
                logger.warning("[IPN] temppay expiry notify failed: %s", exc)
                handled = False
            # Not a temppay entry either → could be a session-replacement invoice.
            if not handled:
                try:
                    from code.replacement import expire_replacement_invoice_by_id
                    if expire_replacement_invoice_by_id(payment_id):
                        logger.info("[IPN] replacement invoice %s expired/cleared", payment_id)
                except Exception as exc:
                    logger.warning("[IPN] replacement expiry failed: %s", exc)
        return {"ok": True}

    # Blockchain-confirmed → confirm + provision (confirmed/sending/finished, per product rule).
    if is_payment_success(pstatus):
        details = {
            "payment_status": "confirmed",
            "amount_received": float(data.get("actually_paid") or data.get("amount_received") or 0),
            "pay_amount": float(data.get("pay_amount") or 0),
            "pay_currency": (data.get("pay_currency") or "").lower(),
            "network": (data.get("network") or data.get("pay_currency") or "").lower(),
            "tx_hash": (data.get("payin_hash") or data.get("outcome_transaction_id") or "").strip(),
        }
        from code.shop.workers import confirm_payment_for_invoice
        try:
            ok = await confirm_payment_for_invoice(payment_id, details)
        except Exception as exc:
            logger.exception("[IPN] confirmation failed for %s: %s", payment_id, exc)
            raise HTTPException(500, "Processing error")
        if not ok:
            # Not an order/temppay — could be a session-replacement payment, whose
            # payment_id lives on the replacement queue (not in orders.json).
            try:
                from code.replacement import confirm_replacement_payment_by_id
                ok = await confirm_replacement_payment_by_id(payment_id)
                if ok:
                    logger.info("[IPN] replacement payment confirmed for %s", payment_id)
            except Exception as exc:
                logger.exception("[IPN] replacement confirmation failed for %s: %s", payment_id, exc)
                raise HTTPException(500, "Processing error")
        if not ok:
            logger.warning("[IPN] no matching order/temppay/replacement for payment_id=%s", payment_id)

    return {"ok": True}  # always ack so NOWPayments stops retrying


# ─────────────── Admin: bot-token pool ───────────────

@router.get("/admin/bot-tokens")
async def admin_list_bot_tokens():
    """List the bot-token pool (tokens masked) with counts. Assigned entries are
    annotated with the live bot's name (looked up by token) so the UI can show
    what each token is actually powering."""
    from code.shop import token_pool
    from code.utils import load_adbot
    tokens = await asyncio.to_thread(token_pool.list_tokens, True)
    raw = await asyncio.to_thread(token_pool.list_tokens, False)
    raw_by_id = {r.get("id"): r for r in raw}
    data = await asyncio.to_thread(load_adbot)
    bots = data.get("bots", {}) or {}
    for entry in tokens:
        entry["bot_name"] = ""
        r = raw_by_id.get(entry.get("id"))
        if r and r.get("status") == "assigned":
            cfg = bots.get(r.get("token", ""))
            if cfg:
                entry["bot_name"] = cfg.get("name", "")
    return {"tokens": tokens, "counts": token_pool.counts()}


@router.post("/admin/bot-tokens")
async def admin_add_bot_tokens(body: BotTokenAddRequest):
    """Add one or more @BotFather tokens to the pool. Each is validated for its username."""
    from code.shop import token_pool
    from code.utils import validate_bot_token
    results = []
    for raw in body.tokens:
        token = (raw or "").strip()
        if not token:
            continue
        try:
            ok, username = await validate_bot_token(token)
        except Exception as exc:
            ok, username = False, str(exc)
        if not ok:
            results.append({"token": token[:8] + "…", "added": False, "error": username})
            continue
        added, msg = token_pool.add_token(token, username)
        results.append({"token": token[:8] + "…", "username": username, "added": added, "error": None if added else msg})
    return {"results": results, "counts": token_pool.counts()}


@router.delete("/admin/bot-tokens")
async def admin_remove_bot_token(id: str = Query(None), token: str = Query(None)):
    """Remove a token from the pool — by pool id (from the UI) or by full token value."""
    from code.shop import token_pool
    ok = token_pool.remove_by_id(id) if id else (token_pool.remove_token(token) if token else False)
    if not ok:
        raise HTTPException(404, "Token not found in pool")
    return {"ok": True, "counts": token_pool.counts()}


@router.post("/admin/bot-tokens/reconcile")
async def admin_reconcile_bot_tokens():
    """Re-sync the pool with reality: release tokens whose bot was deleted (stuck
    "assigned") or whose order was cleared (stuck "reserved"), and promote
    reservations whose bot now exists. Same logic that runs on every restart."""
    from code.shop import token_pool
    from code.utils import load_adbot
    data = await asyncio.to_thread(load_adbot)
    live_tokens = set((data.get("bots") or {}).keys())
    active_order_ids = None
    try:
        from code.shop.storage import load_orders
        terminal = {"completed", "failed", "cancelled", "expired"}
        orders = await asyncio.to_thread(load_orders)
        active_order_ids = {o.get("order_id") for o in orders if o.get("status") not in terminal}
    except Exception:
        active_order_ids = None
    # Keep a short grace so a reservation from a creation started moments ago
    # isn't yanked mid-build. Genuinely stale entries were reserved long ago, so
    # the grace never delays cleaning those up.
    report = await asyncio.to_thread(
        token_pool.reconcile, live_tokens, active_order_ids, 120
    )
    return {
        "released": len(report.get("released", [])),
        "promoted": len(report.get("promoted", [])),
        "counts": token_pool.counts(),
    }
