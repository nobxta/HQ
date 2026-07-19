"""Bot management endpoints: CRUD, start/stop, stats, logs, session management."""
import asyncio
import logging
import time
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from api.deps import get_current_admin, Pagination
from api.services import wrappers
from api.services.serializers import (
    serialize_bot_summary,
    serialize_bot_detail,
    serialize_stats,
    paginate,
)
from api.services.events import emit_dashboard_event
from api.schemas import BotCreateRequest, BotUpdateRequest, BotControlResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots", tags=["bots"], dependencies=[Depends(get_current_admin)])


def _bot_is_live(cfg: dict) -> bool:
    """True when the bot has running workers that need a restart to pick up a session change."""
    return cfg.get("state") in ("running", "activating")


@router.get("/create-context")
async def create_context():
    """Return data needed for the creation wizard: free sessions, group files, existing tokens."""
    pool = await wrappers.load_pool()
    free_count = len(pool.get("free_sessions", []))

    from code.config import GROUPS_DIR
    group_files = []
    for p in sorted(GROUPS_DIR.iterdir()):
        if p.is_file() and p.suffix == ".txt":
            content = await asyncio.to_thread(p.read_text, "utf-8", "replace")
            lines = len([l for l in content.splitlines() if l.strip()])
            group_files.append({"filename": p.name, "lines": lines})

    data = await wrappers.load_adbot()
    existing_tokens = list(data.get("bots", {}).keys())

    from code.shop import token_pool
    pool_available = await asyncio.to_thread(token_pool.count_available)

    return {
        "free_sessions": free_count,
        "group_files": group_files,
        "existing_tokens": existing_tokens,
        "max_sessions": min(free_count, 50),
        "pool_available": pool_available,
    }


class ValidateTokenRequest(BaseModel):
    bot_token: str


@router.post("/validate-token")
async def validate_token(body: ValidateTokenRequest):
    """Validate a bot token and return the bot username."""
    from code.utils import validate_bot_token
    token = body.bot_token.strip()
    if not token:
        raise HTTPException(400, "Token is required")

    data = await wrappers.load_adbot()
    if token in data.get("bots", {}):
        raise HTTPException(409, "This bot token is already registered")

    ok, result = await validate_bot_token(token)
    if not ok:
        raise HTTPException(400, f"Invalid token: {result}")
    return {"valid": True, "username": result}


@router.get("")
async def list_bots(
    state: str = Query(None, description="Filter by state"),
    mode: str = Query(None, description="Filter by mode"),
    pagination: Pagination = Depends(),
):
    data = await wrappers.load_adbot()
    bots = []
    for token, cfg in data.get("bots", {}).items():
        if state and cfg.get("state") != state:
            continue
        if mode and cfg.get("mode") != mode:
            continue
        bots.append(serialize_bot_summary(token, cfg))
    bots.sort(key=lambda b: b.get("name", ""))
    return paginate(bots, pagination.page, pagination.per_page)


@router.get("/{name}")
async def get_bot(name: str):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")
    return serialize_bot_detail(token, cfg)


@router.post("", response_model=BotControlResponse)
async def create_bot(body: BotCreateRequest):
    from code.admin_ptb import submit_create_job
    from code.config import ADMIN_USER_ID
    from code.shop import token_pool

    bot_token = (body.bot_token or "").strip()
    pool_order_id = ""

    if body.use_pool or not bot_token:
        # Reserve an available token from the pool. The synthetic order id keeps
        # the reservation attributable so it can be released on failure and
        # reconciled on restart; it is namespaced so it never collides with a
        # real shop order id.
        pool_order_id = f"webadmin:{body.name}"
        reserved = await asyncio.to_thread(token_pool.reserve_token, pool_order_id)
        if not reserved:
            raise HTTPException(409, "No bot tokens available in the pool. Add tokens or enter a custom one.")
        bot_token = (reserved.get("token") or "").strip()
        username = (reserved.get("username") or "").strip()
        if not username:
            from code.utils import validate_bot_token
            ok, result = await validate_bot_token(bot_token)
            if not ok:
                await asyncio.to_thread(token_pool.release_order, pool_order_id)
                raise HTTPException(400, f"Pooled token is invalid: {result}")

    data = await wrappers.load_adbot()
    if bot_token in data.get("bots", {}):
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(409, "This bot token is already registered")

    form = {
        "name": body.name,
        "bot_token": bot_token,
        "sessions_count": body.sessions_count,
        "cycle": body.cycle,
        "gap": body.gap,
        "mode": body.mode,
        "group_file": body.group_file,
        "valid_till": body.valid_till,
        "renewal_price": body.renewal_price,
        "renewal_prices": {
            "7d": (body.renewal_prices or {}).get("7d") if body.renewal_prices else None,
            "30d": (body.renewal_prices or {}).get("30d") if body.renewal_prices else None,
        },
        "plan_name": body.plan_name,
        "skip_health_check": body.skip_health_check,
        "skip_chatlist_join": body.skip_chatlist_join,
    }
    # Track the pool reservation so the result consumer can mark it assigned on
    # success or release it on failure. Kept out of "order_id" so admin-web
    # notifications aren't misrouted to the Shop Bot.
    if pool_order_id:
        form["_pool_order_id"] = pool_order_id
    try:
        submit_create_job(chat_id=ADMIN_USER_ID, msg_id=0, form=form, web=True)
    except Exception as e:
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(500, f"Failed to enqueue creation: {e}")

    await wrappers.log_admin_action("web_admin", "create_bot", target=body.name)
    emit_dashboard_event("bot_creating", {"name": body.name})
    return BotControlResponse(status="queued", message=f"Bot '{body.name}' creation queued")


@router.patch("/{name}", response_model=BotControlResponse)
async def update_bot(name: str, body: BotUpdateRequest):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")

    updated = False
    if body.cycle is not None:
        cfg["cycle"] = body.cycle
        if "plan" in cfg:
            cfg["plan"]["cycle"] = body.cycle
        updated = True
    if body.gap is not None:
        cfg["gap"] = body.gap
        if "plan" in cfg:
            cfg["plan"]["gap"] = body.gap
        updated = True
    if body.group_file is not None:
        cfg["group_file"] = body.group_file
        updated = True
    if body.valid_till is not None:
        cfg["valid_till"] = body.valid_till
        updated = True
    # Posting content — same shape/limits the user portal enforces so admin edits
    # and worker live-reload stay consistent (workers.py picks these up per cycle).
    if body.message_mode is not None:
        if body.message_mode not in ("text", "link"):
            raise HTTPException(400, "message_mode must be 'text' or 'link'")
        cfg["message_mode"] = body.message_mode
        updated = True
    if body.message_text is not None:
        cfg["message_text"] = body.message_text[:500]
        updated = True
    if body.post_links is not None:
        cfg["post_links"] = [str(x).strip() for x in body.post_links if x and str(x).strip()][:10]
        updated = True
    if body.renewal_prices is not None:
        def _clean(v):
            if v in (None, ""):
                return None
            try:
                n = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, "Renewal override must be a positive number or null")
            if n <= 0:
                return None
            return round(n, 2)
        cfg["renewal_prices"] = {
            "7d": _clean(body.renewal_prices.get("7d")),
            "30d": _clean(body.renewal_prices.get("30d")),
        }
        updated = True

    if updated:
        await wrappers.save_user_data(name, cfg)
        await wrappers.log_admin_action("web_admin", "update_bot", target=name)

    return BotControlResponse(status="updated", message=f"Bot '{name}' config updated")


class ChatlistSetupRequest(BaseModel):
    links: list[str]


@router.put("/{name}/chatlist")
async def admin_setup_chatlist(name: str, body: ChatlistSetupRequest):
    """Admin: set up chatlist for a bot (join + scrape groups)."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")

    links = [l.strip() for l in body.links if l.strip()][:2]
    if not links:
        cfg.pop("custom_chatlist", None)
        await wrappers.save_user_data(name, cfg)
        return {"status": "updated", "message": "Chatlist cleared", "groups": 0}

    from code.chatlist import process_chatlist_setup
    from api.services.events import emit_chatlist_progress

    async def progress_cb(msg: str):
        emit_chatlist_progress(name, msg, status="progress")

    emit_chatlist_progress(name, "Starting chatlist setup...", status="progress")
    success, message, count = await process_chatlist_setup(
        bot_token=token,
        user_name=name,
        links=links,
        cfg=cfg,
        progress_cb=progress_cb,
    )
    await wrappers.save_user_data(name, cfg)
    if not success:
        emit_chatlist_progress(name, message, status="failed")
        raise HTTPException(400, message)
    emit_chatlist_progress(name, message, status="done")
    await wrappers.log_admin_action("web_admin", "setup_chatlist", target=name)
    return {"status": "updated", "message": message, "groups": count}


@router.delete("/{name}/chatlist")
async def admin_clear_chatlist(name: str):
    """Admin: clear chatlist and revert to default group file."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")

    from code.chatlist import clear_chatlist_config, default_group_file_for_mode
    mode = (cfg.get("mode") or "Starter").strip()
    default_gf = default_group_file_for_mode(mode)
    clear_chatlist_config(cfg)
    cfg["group_file"] = default_gf
    await wrappers.save_user_data(name, cfg)
    await wrappers.log_admin_action("web_admin", "clear_chatlist", target=name)
    return {"status": "updated", "message": f"Reverted to {default_gf}", "group_file": default_gf}


@router.get("/{name}/groups")
async def admin_get_groups(name: str):
    """Admin: read the group file for a bot with correct path resolution."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")
    group_file = cfg.get("group_file", "")
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


class AdminUpdateGroups(BaseModel):
    lines: list[str]


@router.put("/{name}/groups")
async def admin_update_groups(name: str, body: AdminUpdateGroups):
    """Admin: update the group file contents directly."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")
    group_file = cfg.get("group_file", "")
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
    await wrappers.log_admin_action("web_admin", "update_groups", target=name)
    return {"status": "updated", "lines": len(clean_lines)}


@router.delete("/{name}", response_model=BotControlResponse)
async def delete_bot(name: str, move_to: str = Query("free", pattern="^(free|dead)$")):
    from code.admin_ptb import submit_main_loop_job
    from code.config import ADMIN_USER_ID

    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    submit_main_loop_job("delete_bot", (token, ADMIN_USER_ID, 0, move_to, name))
    await wrappers.log_admin_action("web_admin", "delete_bot", target=name)
    emit_dashboard_event("bot_deleted", {"name": name})
    return BotControlResponse(status="queued", message=f"Bot '{name}' deletion queued")


@router.post("/{name}/start", response_model=BotControlResponse)
async def start_bot(name: str):
    from api.services.events import emit_bot_control
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    emit_bot_control(name, "Initializing start...", status="progress", action="start")

    async def update_status(msg: str):
        emit_bot_control(name, msg, status="progress", action="start")

    try:
        result = await wrappers.start_posting(token, update_status=update_status)
        if not result:
            from code.users import _last_start_failure_reason
            reason = _last_start_failure_reason.get(token, "unknown")
            reason_map = {
                "already_running": "Bot is already running",
                "no_cfg": "Bot configuration not found",
                "suspended": "Bot is suspended",
                "no_sessions": "No sessions configured",
                "no_valid_sessions": "No valid session files found",
                "no_groups": "No groups assigned to any session",
            }
            msg = reason_map.get(reason, f"Start returned False ({reason})")
            emit_bot_control(name, msg, status="failed", action="start")
            return BotControlResponse(status="warning", message=msg)
    except Exception as e:
        emit_bot_control(name, f"Failed to start: {e}", status="failed", action="start")
        raise HTTPException(500, f"Failed to start: {e}")

    emit_bot_control(name, f"Bot '{name}' is now running", status="done", action="start")
    await wrappers.log_admin_action("web_admin", "start_posting", target=name)
    emit_dashboard_event("bot_started", {"name": name})
    return BotControlResponse(status="started", message=f"Bot '{name}' posting started")


@router.post("/{name}/stop", response_model=BotControlResponse)
async def stop_bot(name: str):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    try:
        await wrappers.stop_posting(token)
    except Exception as e:
        raise HTTPException(500, f"Failed to stop: {e}")

    await wrappers.log_admin_action("web_admin", "stop_posting", target=name)
    emit_dashboard_event("bot_stopped", {"name": name})
    return BotControlResponse(status="stopped", message=f"Bot '{name}' posting stopped")


@router.post("/{name}/restart", response_model=BotControlResponse)
async def restart_bot(name: str):
    from code.admin_ptb import submit_main_loop_job

    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    submit_main_loop_job("restart_bot", (token,))
    await wrappers.log_admin_action("web_admin", "restart_bot", target=name)
    return BotControlResponse(status="queued", message=f"Bot '{name}' restart queued")


# ─────────────────────── Repair (/fix parity) ───────────────────────

@router.post("/{name}/repair/config")
async def repair_config(name: str):
    """Validate and auto-repair the bot's config file (same as /fix → Fix Config)."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    from code.repair import repair_fix_config
    try:
        msg = await repair_fix_config(token)
    except Exception as e:
        raise HTTPException(500, f"Config repair failed: {e}")
    await wrappers.log_admin_action("web_admin", "repair_config", target=name)
    return {"status": "done", "message": msg}


@router.post("/{name}/repair/log-group")
async def repair_log_group(name: str):
    """Validate the log group and recreate it if broken (same as /fix → Fix Log Group)."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    from code.repair import repair_fix_log_group
    try:
        msg = await repair_fix_log_group(token)
    except Exception as e:
        raise HTTPException(500, f"Log group repair failed: {e}")
    await wrappers.log_admin_action("web_admin", "repair_log_group", target=name)
    return {"status": "done", "message": msg}


class SetLogGroupRequest(BaseModel):
    log_group: str


@router.post("/{name}/repair/log-group/set")
async def set_log_group(name: str, body: SetLogGroupRequest):
    """Point the bot's log group at a specific existing channel/group (t.me link, @username or
    -100 id). Logs are posted by the controller bot, so it must already be a member with permission
    to post — we verify by sending a confirmation message and revert the change if that fails."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' config not found")

    raw = (body.log_group or "").strip()
    if not raw:
        raise HTTPException(400, "Provide a channel/group link, @username, or -100 id")

    from code.users import _log_group_entity, _log_group_link
    from code.notify import notify_log_group

    entity = _log_group_entity(raw)
    if entity is None:
        raise HTTPException(400, "Could not parse that log group. Use a t.me link, @username, or -100 id.")

    prev = cfg.get("log_group") or ""
    link = _log_group_link(raw)
    cfg["log_group"] = link
    await wrappers.save_user_data(name, cfg)

    # Verify the controller bot can actually post there; revert if it can't.
    ok = False
    try:
        ok = await notify_log_group(token, entity, f"✅ This channel is now the log group for {cfg.get('name', name)}.")
    except Exception:
        ok = False
    if not ok:
        cfg["log_group"] = prev
        await wrappers.save_user_data(name, cfg)
        bot_un = (cfg.get("bot_username") or "").lstrip("@")
        hint = f" Add @{bot_un} to the channel as an admin with permission to post, then try again." if bot_un else ""
        raise HTTPException(400, f"Couldn't post to that log group — nothing was changed.{hint}")

    await wrappers.log_admin_action("web_admin", "set_log_group", target=f"{name} → {link}")
    return {"status": "done", "message": f"Log group set to {link}", "log_group": link}


class RepairBotTokenRequest(BaseModel):
    bot_token: Optional[str] = None   # a custom @BotFather token
    use_pool: bool = False            # or take the next available token from the pool


@router.post("/{name}/repair/bot-token")
async def repair_bot_token(name: str, body: RepairBotTokenRequest):
    """Swap the controller bot token (same as /fix → Fix Bot Token). Deactivates the
    old controller bot and activates the new one, migrating profile + log group."""
    import uuid
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    from code.shop import token_pool
    new_token = (body.bot_token or "").strip()
    pool_order_id = ""

    if body.use_pool or not new_token:
        # Unique order id per attempt so reserve_token doesn't idempotently hand
        # back a token already tied to this bot's name from a previous op.
        pool_order_id = f"webfix:{name}:{uuid.uuid4().hex[:8]}"
        reserved = await asyncio.to_thread(token_pool.reserve_token, pool_order_id)
        if not reserved:
            raise HTTPException(409, "No bot tokens available in the pool. Add tokens or enter a custom one.")
        new_token = (reserved.get("token") or "").strip()

    if new_token == token:
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(400, "That's already this bot's token.")

    data = await wrappers.load_adbot()
    if new_token in data.get("bots", {}):
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(409, "That token is already used by another bot.")

    from code.repair import repair_fix_bot_token
    try:
        msg = await repair_fix_bot_token(token, new_token)
    except Exception as e:
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(500, f"Bot token change failed: {e}")

    if msg.lower().startswith("invalid") or "not found" in msg.lower() or "config not found" in msg.lower():
        # repair signalled a validation failure rather than raising.
        if pool_order_id:
            await asyncio.to_thread(token_pool.release_order, pool_order_id)
        raise HTTPException(400, msg)

    # Keep the pool honest: the old token is now backing nothing (free it), and the
    # new token is now a live bot (claim it so it can't be handed out again).
    try:
        await asyncio.to_thread(token_pool.release_by_token, token)
        await asyncio.to_thread(token_pool.assign_by_token, new_token)
    except Exception:
        pass

    await wrappers.log_admin_action("web_admin", "repair_bot_token", target=name)
    emit_dashboard_event("bot_token_changed", {"name": name})
    return {"status": "done", "message": msg}


@router.post("/{name}/suspend", response_model=BotControlResponse)
async def suspend_bot(name: str):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    success, msg = await wrappers.user_set_suspended(token, True)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "suspend_bot", target=name)
    return BotControlResponse(status="suspended", message=msg)


@router.post("/{name}/resume", response_model=BotControlResponse)
async def resume_bot(name: str):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    success, msg = await wrappers.user_set_suspended(token, False)
    if not success:
        raise HTTPException(400, msg)

    await wrappers.log_admin_action("web_admin", "resume_bot", target=name)
    return BotControlResponse(status="resumed", message=msg)


def _build_renewal_reminder(cfg: dict) -> str:
    """Owner-facing renewal reminder built from the bot's validity date."""
    from code.shop.renewals import parse_valid_till
    import datetime as _dt
    bot_name = cfg.get("name", "your AdBot")
    vt = parse_valid_till(cfg.get("valid_till"))
    if vt:
        days = (vt - _dt.datetime.utcnow()).days
        when = vt.strftime("%d %b %Y")
        if days < 0:
            status = f"expired on {when}"
        elif days == 0:
            status = f"expires today ({when})"
        else:
            status = f"expires in {days} day{'s' if days != 1 else ''} ({when})"
    else:
        status = "is due for renewal"
    return (
        f"⏰ Renewal reminder for {bot_name}\n\n"
        f"Your AdBot {status}. Renew now to keep it posting without interruption.\n"
        f"Open the shop bot and choose Renew, or reply here if you need help."
    )


class NotifyOwnerRequest(BaseModel):
    kind: str = "custom"            # "renewal" (prebuilt reminder) or "custom" (free text)
    message: Optional[str] = None   # required for kind="custom"


@router.post("/{name}/notify-owner")
async def notify_owner(name: str, body: NotifyOwnerRequest):
    """Send the bot's owner a Telegram DM via the shop bot — a prebuilt renewal reminder or a
    custom alert. The owner must have started the shop bot (they did to purchase)."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")
    owner_id = cfg.get("owner_id")
    if not owner_id:
        raise HTTPException(400, "This bot has no owner on file to notify.")

    kind = (body.kind or "custom").strip().lower()
    if kind == "renewal":
        text = _build_renewal_reminder(cfg)
    else:
        text = (body.message or "").strip()
        if not text:
            raise HTTPException(400, "Message is required")
        text = text[:1000]

    from code import notify, config as app_config
    if not (getattr(app_config, "SHOP_BOT_TOKEN", "") or "").strip():
        raise HTTPException(400, "Shop bot is not configured, so owner messages can't be sent.")
    try:
        ok = await notify.notify_send_to_chat(int(owner_id), text, bot_token=app_config.SHOP_BOT_TOKEN)
    except Exception as e:
        raise HTTPException(500, f"Send failed: {e}")
    if not ok:
        raise HTTPException(400, "Could not deliver the message — the owner may not have started the shop bot.")

    await wrappers.log_admin_action("web_admin", "notify_owner", target=f"{name} ({kind})")
    return {"status": "sent", "message": "Notification sent to the owner"}


class SetModeRequest(BaseModel):
    mode: str  # "starter" | "enterprise"


@router.post("/{name}/mode")
async def set_bot_mode(name: str, body: SetModeRequest):
    """Switch a bot between Starter and Enterprise. Group assignment and timing are recomputed
    from cfg["mode"] every cycle (Starter: all accounts post the same ≤80 groups, time-shifted;
    Enterprise: all groups sharded across accounts), so this only rewrites the mode fields and,
    when the bot is on a default group file, swaps it to the new mode's default — a custom
    chatlist/group file is preserved. A live bot gets a cycle-preserving restart to re-read it."""
    new_mode = (body.mode or "").strip().lower()
    if new_mode not in ("starter", "enterprise"):
        raise HTTPException(400, "mode must be 'starter' or 'enterprise'")

    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    from code.user_config import get_plan_mode
    if get_plan_mode(cfg).lower() == new_mode:
        return {"status": "unchanged", "mode": new_mode.capitalize(), "message": f"Already on {new_mode.capitalize()} mode"}

    title = new_mode.capitalize()  # canonical "Starter" / "Enterprise"

    # get_plan_mode reads plan.mode > mode > plan_mode, so update every source.
    cfg["mode"] = title
    cfg["plan_mode"] = title
    if isinstance(cfg.get("plan"), dict):
        cfg["plan"]["mode"] = title

    # Swap the group file ONLY when it's currently a mode default, so a custom chatlist survives.
    from code.chatlist import default_group_file_for_mode
    from code import config as app_config
    current_gf = (cfg.get("group_file") or "").strip()
    defaults = {app_config.DEFAULT_GROUP_FILE_STARTER, app_config.DEFAULT_GROUP_FILE_ENTERPRISE}
    on_default = (current_gf in defaults) or not current_gf
    group_file_changed = False
    if on_default:
        cfg["group_file"] = default_group_file_for_mode(title)
        group_file_changed = cfg["group_file"] != current_gf

    await wrappers.save_user_data(name, cfg)

    # A running bot must re-read mode/groups — queue a cycle-preserving restart (same as disable/enable).
    applied = "on_next_start"
    if _bot_is_live(cfg):
        token = await wrappers.get_token_by_name(name)
        if token:
            from code.admin_ptb import submit_main_loop_job
            submit_main_loop_job("restart_bot_preserve", (token,))
            applied = "live"

    await wrappers.log_admin_action("web_admin", "set_mode", target=f"{name} → {title}")
    if group_file_changed:
        note = f" Group file switched to {cfg['group_file']}."
    elif not on_default:
        note = " Your custom group list was kept."
    else:
        note = ""
    return {
        "status": "updated",
        "mode": title,
        "group_file": cfg.get("group_file", ""),
        "applied": applied,
        "message": f"Switched to {title} mode.{note}",
    }


@router.get("/{name}/stats")
async def get_bot_stats(name: str):
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")

    stats = await wrappers.get_stats_for_display(token)
    return serialize_stats(stats)


# Ranges accepted by the analytics endpoints; "lifetime" auto-picks a bucket size.
_ANALYTICS_RANGES = {"1h", "6h", "24h", "7d", "30d", "lifetime"}
_RANGE_WINDOW_SEC = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


@router.get("/{name}/analytics")
async def get_bot_analytics(name: str, range: str = Query("7d")):
    """Time-bucketed sent/failed series parsed from the durable log file."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    if range not in _ANALYTICS_RANGES:
        range = "7d"
    from api.services.log_stats import compute_analytics
    return await asyncio.to_thread(compute_analytics, name, range)


@router.get("/{name}/failure-reasons")
async def get_bot_failure_reasons(name: str, range: str = Query("7d")):
    """Categorized POST_FAILURE / FLOOD_WAIT tallies for this bot within the range."""
    token = await wrappers.get_token_by_name(name)
    if not token:
        raise HTTPException(404, f"Bot '{name}' not found")
    since = time.time() - _RANGE_WINDOW_SEC[range] if range in _RANGE_WINDOW_SEC else 0.0
    from api.services.log_stats import compute_failure_reasons
    result = await asyncio.to_thread(compute_failure_reasons, [name], since)
    result["range"] = range if range in _ANALYTICS_RANGES else "lifetime"
    return result


@router.get("/{name}/logs")
async def get_bot_logs(name: str, lines: int = Query(100, ge=1, le=5000)):
    from code.config import DATA_LOGS_DIR
    log_path = DATA_LOGS_DIR / f"{name}.log"
    if not log_path.is_file():
        from code.utils import name_to_filename
        log_path = DATA_LOGS_DIR / f"{name_to_filename(name)}.log"
    if not log_path.is_file():
        return {"lines": [], "total_lines": 0}

    try:
        content = await asyncio.to_thread(log_path.read_text, "utf-8", "replace")
        all_lines = content.splitlines()
        tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {"lines": tail, "total_lines": len(all_lines)}
    except Exception as e:
        raise HTTPException(500, f"Failed to read logs: {e}")


# ─────────────────────── Session Management ───────────────────────

async def _connect_session(session_file: str):
    """Connect a Telethon client for a session file. Returns (client, error_str)."""
    from code.config import resolve_session_path
    from code.session_guard import SessionBusyError, guarded_client

    path = resolve_session_path(session_file)
    if not path.is_file():
        return None, "Session file not found"
    try:
        client = guarded_client(path, "session details check", wait_timeout=5, expected_sec=30)
        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            return None, "Session not authorized (logged out / banned)"
        return client, ""
    except SessionBusyError as e:
        return None, str(e)[:200]
    except Exception as e:
        return None, f"Connection failed: {str(e)[:150]}"


@router.get("/{name}/sessions/detail")
async def get_sessions_detail(name: str):
    """Get detailed info for all sessions assigned to a bot, with live Telethon validation."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    sessions = cfg.get("sessions") or []
    results = []

    for s in sessions:
        fn = s.get("file", "")
        info = {
            "file": fn,
            "index": s.get("index", 0),
            "real_name": s.get("real_name", ""),
            "user_id": s.get("user_id", 0),
            "status": "unknown",
            "username": "",
            "bio": "",
            "phone": "",
            "premium": False,
            "restricted": False,
            "error": "",
        }

        client, err = await _connect_session(fn)
        if not client:
            info["status"] = "dead"
            info["error"] = err
            results.append(info)
            continue

        try:
            me = await client.get_me()
            if me:
                info["status"] = "active"
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["username"] = me.username or ""
                info["phone"] = me.phone or ""
                info["user_id"] = me.id
                info["premium"] = bool(getattr(me, "premium", False))
                info["restricted"] = bool(getattr(me, "restricted", False))

                # Get bio
                try:
                    from telethon.tl.functions.users import GetFullUserRequest
                    full = await client(GetFullUserRequest(me.id))
                    info["bio"] = getattr(full.full_user, "about", "") or ""
                except Exception:
                    pass
            else:
                info["status"] = "dead"
                info["error"] = "Could not get user info"
        except Exception as e:
            info["status"] = "error"
            info["error"] = str(e)[:150]
        finally:
            await client.disconnect()

        # Update stored session info with fresh data
        s["real_name"] = info["real_name"]
        s["user_id"] = info["user_id"]
        results.append(info)

    # Save updated session info
    await wrappers.save_user_data(name, cfg)

    return {"sessions": results}


# Time-range keys accepted by the sessions overview → window length in seconds.
# "all" → None (lifetime).
_RANGE_SECONDS: dict[str, Optional[int]] = {
    "1h": 3600,
    "6h": 6 * 3600,
    "24h": 24 * 3600,
    "7d": 7 * 86400,
    "all": None,
}


def _derive_session_status(
    file: str,
    *,
    disabled: bool,
    validation_status: str,
    bot_running: bool,
    pause_until: dict,
    cooldown_until: dict,
    now: float,
) -> str:
    """Single source of truth for a session's operational status, from real cfg state."""
    if disabled:
        return "disabled"
    if validation_status == "invalid":
        return "dead"
    if float(pause_until.get(file, 0) or 0) > now:
        return "floodwait"
    if float(cooldown_until.get(file, 0) or 0) > now:
        return "paused"
    if bot_running:
        return "running"
    return "stopped"


@router.get("/{name}/sessions/overview")
async def get_sessions_overview(name: str, range: str = Query("24h")):
    """Real, compact per-session operational view for the admin Sessions page.

    Merges the bot's assigned sessions (identity), persisted validation state, the
    admin Enable/Disable flags, and posting activity (sent/failed/flood) parsed from
    the durable log for the requested time window. No mock data, no live Telethon —
    this is a fast read used for the card grid and summary. Live checks stay on the
    explicit Validate / Check Info actions.
    """
    from api.services.log_stats import compute_session_activity

    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    range_key = range if range in _RANGE_SECONDS else "24h"
    window = _RANGE_SECONDS[range_key]
    now = time.time()
    since_ts = 0.0 if window is None else (now - window)

    token = await wrappers.get_token_by_name(name)
    stats = await wrappers.get_stats_for_display(token) if token else {}
    session_stats = (stats or {}).get("session_stats") or {}

    activity = await asyncio.to_thread(compute_session_activity, name, since_ts)

    sessions_cfg = cfg.get("sessions") or []
    disabled_set = {(f or "").strip() for f in (cfg.get("disabled_sessions") or []) if (f or "").strip()}
    pause_until = cfg.get("session_pause_until") or {}
    cooldown_until = cfg.get("session_cooldown_until") or {}
    bot_running = cfg.get("state") in ("running", "activating")

    out_sessions = []
    sum_sent = sum_failed = sum_flood = 0
    n_active = n_disabled = n_dead = 0

    for i, s in enumerate(sessions_cfg):
        fn = (s.get("file") or "").strip()
        act = activity.get(fn) or {}
        sstat = session_stats.get(fn) or {}

        is_disabled = fn in disabled_set
        validation_status = s.get("validation_status", "unknown")

        # Sent/failed within the window come from the log; "all" prefers the durable
        # lifetime counter (logs may have rotated), flood always from the log.
        if window is None:
            sent = int(sstat.get("lifetime_sent", 0)) or int(act.get("sent", 0))
            failed = int(sstat.get("lifetime_failed", 0)) or int(act.get("failed", 0))
        else:
            sent = int(act.get("sent", 0))
            failed = int(act.get("failed", 0))
        flood = int(act.get("flood", 0))
        total = sent + failed
        success_rate = round(sent / total * 100, 1) if total else None

        # Last active: newest of log activity or the recorded last cycle timestamp.
        last_active_ts = max(
            float(act.get("last_active_ts", 0) or 0),
            float(sstat.get("last_cycle_ts", 0) or 0),
        )

        status = _derive_session_status(
            fn,
            disabled=is_disabled,
            validation_status=validation_status,
            bot_running=bot_running,
            pause_until=pause_until,
            cooldown_until=cooldown_until,
            now=now,
        )
        if status == "disabled":
            n_disabled += 1
        elif status == "dead":
            n_dead += 1
        else:
            n_active += 1

        sum_sent += sent
        sum_failed += failed
        sum_flood += flood

        # Phone number is NOT verified from Telegram here — only derivable from the
        # session file name. Labeled as such on the client so it isn't shown as a
        # real phone number.
        digits = "".join(ch for ch in fn.replace(".session", "") if ch.isdigit())

        out_sessions.append({
            "index": s.get("index") if s.get("index") is not None else i + 1,
            "file": fn,
            "display_name": s.get("real_name") or "",
            "telegram_user_id": s.get("user_id") or None,
            "phone_from_file": digits or None,
            "status": status,
            "enabled": not is_disabled,
            "last_active_at": last_active_ts or None,
            "last_validated_at": s.get("last_validated_at") or None,
            "validation_status": validation_status,
            "validation_reason": s.get("validation_reason") or None,
            "last_error": act.get("last_error") or None,
            "last_error_at": (act.get("last_error_ts") or None) if act.get("last_error") else None,
            "stats": {
                "sent": sent,
                "failed": failed,
                "flood": flood,
                "success_rate": success_rate,
            },
        })

    return {
        "bot": {
            "name": cfg.get("name", name),
            "token_masked": (f"{token.split(':')[0]}:****" if token and ":" in token else None),
            "state": cfg.get("state", "stopped"),
            "running": bot_running,
        },
        "range": range_key,
        "summary": {
            "total": len(sessions_cfg),
            "active": n_active,
            "disabled": n_disabled,
            "dead": n_dead,
            "sent": sum_sent,
            "failed": sum_failed,
            "flood": sum_flood,
        },
        "sessions": out_sessions,
    }


class SessionProfileUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    bio: Optional[str] = None
    username: Optional[str] = None


@router.patch("/{name}/sessions/{session_file}/profile")
async def update_session_profile(name: str, session_file: str, body: SessionProfileUpdate):
    """Update a session's Telegram profile (name, bio, username) via Telethon."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    # Verify session belongs to this bot
    sessions = cfg.get("sessions") or []
    session_entry = next((s for s in sessions if s.get("file") == session_file), None)
    if not session_entry:
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    client, err = await _connect_session(session_file)
    if not client:
        raise HTTPException(400, f"Cannot connect: {err}")

    changes = []
    try:
        # Update name / bio
        if body.first_name is not None or body.last_name is not None or body.bio is not None:
            from telethon.tl.functions.account import UpdateProfileRequest
            kwargs = {}
            if body.first_name is not None:
                kwargs["first_name"] = body.first_name
            if body.last_name is not None:
                kwargs["last_name"] = body.last_name
            if body.bio is not None:
                kwargs["about"] = body.bio
            if kwargs:
                await client(UpdateProfileRequest(**kwargs))
                changes.append("profile")

        # Update username
        if body.username is not None:
            from telethon.tl.functions.account import UpdateUsernameRequest
            await client(UpdateUsernameRequest(body.username))
            changes.append("username")

        # Refresh info
        me = await client.get_me()
        new_name = f"{me.first_name or ''} {me.last_name or ''}".strip()

        # Update stored session info
        session_entry["real_name"] = new_name
        session_entry["user_id"] = me.id
        await wrappers.save_user_data(name, cfg)

        return {
            "status": "updated",
            "changes": changes,
            "real_name": new_name,
            "username": me.username or "",
        }

    except Exception as e:
        error_msg = str(e)[:200]
        # Friendly error messages
        if "USERNAME_INVALID" in error_msg.upper():
            error_msg = "Username is invalid (must be 5-32 chars, a-z, 0-9, underscores)"
        elif "USERNAME_OCCUPIED" in error_msg.upper():
            error_msg = "Username is already taken"
        elif "USERNAME_NOT_MODIFIED" in error_msg.upper():
            error_msg = "Username is already set to this value"
        elif "FLOOD" in error_msg.upper():
            error_msg = "Rate limited — try again later"
        elif "FIRSTNAME_INVALID" in error_msg.upper():
            error_msg = "First name is invalid"
        raise HTTPException(400, error_msg)
    finally:
        await client.disconnect()


@router.post("/{name}/sessions/{session_file}/validate")
async def validate_bot_session(name: str, session_file: str):
    """Validate a single session: connect, check auth, try sending to SavedMessages."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    sessions = cfg.get("sessions") or []
    entry = next((s for s in sessions if s.get("file") == session_file), None)
    if not entry:
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    from code.config import resolve_session_path
    from code.utils import validate_session_with_reason
    path = resolve_session_path(session_file)

    valid, reason = await validate_session_with_reason(path)

    # A session held by a live task (posting worker, chatlist, portal) is SKIPPED,
    # not failed: validate_session_with_reason returns (False, "...is busy:...") /
    # "in use by posting" without moving or touching the file. Treat that as an
    # informational skip — do NOT persist validation_status/reason/last_validated_at
    # and do not change the session's health. (Same rule the startup validator uses.)
    low = (reason or "").lower()
    if not valid and ("is busy:" in low or "in use by posting" in low):
        return {"file": session_file, "status": "skipped", "reason": reason}

    status = "valid" if valid else "invalid"

    # Persist the outcome onto the session entry so the Sessions page can show the
    # last validation status/reason/time without a fresh live check. The session
    # stays assigned even when invalid — Remove/Replace are the explicit operator
    # actions for returning it to the pool; the worker skips dead sessions at spawn.
    entry["validation_status"] = status
    entry["validation_reason"] = "" if valid else (reason or "")
    entry["last_validated_at"] = time.time()
    await wrappers.save_user_data(name, cfg)

    return {"file": session_file, "status": status, "reason": reason}


@router.post("/{name}/sessions/validate-all")
async def validate_all_sessions(name: str):
    """Validate ALL sessions: connect, check auth, try send to SavedMessages. Dead ones removed from bot.
    Returns full info for each session (name, user_id, username, phone, status, reason)."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    from code.config import resolve_session_path, API_ID, API_HASH, PROXY
    from telethon import TelegramClient
    from telethon.tl.functions.users import GetFullUserRequest

    sessions = list(cfg.get("sessions") or [])
    results = []
    dead_files = []

    for s in sessions:
        fn = s.get("file", "")
        info = {
            "file": fn,
            "index": s.get("index", 0),
            "real_name": s.get("real_name", ""),
            "user_id": s.get("user_id"),
            "username": "",
            "phone": "",
            "bio": "",
            "premium": False,
            "restricted": False,
            "status": "unknown",
            "reason": "",
        }
        path = resolve_session_path(fn)
        if not path.is_file():
            info["status"] = "dead"
            info["reason"] = "Session file missing"
            dead_files.append(fn)
            results.append(info)
            continue

        client = None
        try:
            from code.session_guard import SessionBusyError, guarded_client
            client = guarded_client(path, "session validation", wait_timeout=5, expected_sec=30)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                info["status"] = "dead"
                info["reason"] = "Not authorized (logged out / banned)"
                dead_files.append(fn)
                results.append(info)
                continue
            # Try send to saved messages (full validation)
            try:
                await client.send_message("me", ".")
            except Exception as send_err:
                err_str = str(send_err)
                # Check if it's a fatal error
                from code.rpc_errors import SESSION_DEAD_ERRORS
                if type(send_err) in SESSION_DEAD_ERRORS:
                    await client.disconnect()
                    info["status"] = "dead"
                    info["reason"] = err_str[:150]
                    dead_files.append(fn)
                    results.append(info)
                    continue
                # Non-fatal (e.g. flood) - session still alive
                info["reason"] = f"Send test failed: {err_str[:100]}"

            # Get full info
            me = await client.get_me()
            if me:
                info["status"] = "active"
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["username"] = me.username or ""
                info["phone"] = me.phone or ""
                info["user_id"] = me.id
                info["premium"] = bool(getattr(me, "premium", False))
                info["restricted"] = bool(getattr(me, "restricted", False))
                try:
                    full = await client(GetFullUserRequest(me.id))
                    info["bio"] = getattr(full.full_user, "about", "") or ""
                except Exception:
                    pass
                # Update stored session entry
                s["real_name"] = info["real_name"]
                s["user_id"] = info["user_id"]
            await client.disconnect()
        except Exception as e:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            from code.session_guard import SessionBusyError
            if isinstance(e, SessionBusyError) or "database is locked" in str(e).lower():
                # In use by another task — not dead, report who holds it
                info["status"] = "busy"
                info["reason"] = str(e)[:200]
            else:
                info["status"] = "dead"
                info["reason"] = str(e)[:150]
                dead_files.append(fn)

        # Persist validation outcome onto surviving entries (dead ones are removed
        # below, so only record for those that stay assigned).
        if info["status"] != "dead":
            s["validation_status"] = "valid" if info["status"] == "active" else "unknown"
            s["validation_reason"] = info["reason"] or ""
            s["last_validated_at"] = time.time()

        results.append(info)

    # Remove dead sessions from bot config
    if dead_files:
        cfg["sessions"] = [s for s in cfg.get("sessions", []) if s.get("file") not in dead_files]
    await wrappers.save_user_data(name, cfg)

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["status"] == "active"),
        "dead": len(dead_files),
        "dead_removed": dead_files,
    }


@router.post("/{name}/sessions/spambot-check")
async def spambot_check_sessions(name: str):
    """Run SpamBot health check on all sessions assigned to this bot.

    Assigned sessions are never moved between pool buckets or on disk — the bot's
    config still points at them and yanking the file out from under a running worker
    would silently break it. Instead LIMITED/FROZEN results are persisted as a
    ``spam_status`` flag on the session's own entry so the Sessions console can show
    "needs attention" (health, not location). A later clean check overwrites/clears
    the flag automatically, so it self-heals once Telegram lifts the restriction.
    Replacing the session (Replace action) is the explicit operator move that actually
    swaps the file out."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    from code.repair import (
        check_sessions_health_parallel, SPAM_ACTIVE,
        SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED, SPAM_FROZEN,
    )

    session_files = [s.get("file") for s in cfg.get("sessions", []) if s.get("file")]

    if not session_files:
        return {"sessions": [], "total": 0}

    statuses = await check_sessions_health_parallel(session_files)

    flagged_limited = []
    flagged_frozen = []
    changed = False

    results = []
    for s in cfg.get("sessions", []):
        fn = s.get("file", "")
        spam_status = statuses.get(fn, "UNKNOWN")
        results.append({
            "file": fn,
            "real_name": s.get("real_name", ""),
            "user_id": s.get("user_id"),
            "spambot_status": spam_status,
        })

        # Flag health on the entry itself — never touch pool bucket or file location
        # while the session stays assigned.
        if spam_status in (SPAM_TEMP_LIMITED, SPAM_HARD_LIMITED):
            s["spam_status"] = "limited"
            s["last_spambot_check_at"] = time.time()
            flagged_limited.append(fn)
            changed = True
        elif spam_status == SPAM_FROZEN:
            s["spam_status"] = "frozen"
            s["last_spambot_check_at"] = time.time()
            flagged_frozen.append(fn)
            changed = True
        elif spam_status == SPAM_ACTIVE:
            # Self-heal: no longer limited/frozen, clear any stale attention flag.
            if s.get("spam_status"):
                s["spam_status"] = None
                changed = True
            s["last_spambot_check_at"] = time.time()
            changed = True
        # UNKNOWN (check inconclusive, e.g. busy) — leave the existing flag as-is.

    if changed:
        await wrappers.save_user_data(name, cfg)

    return {
        "sessions": results,
        "total": len(results),
        "active": sum(1 for r in results if r["spambot_status"] == SPAM_ACTIVE),
        "limited": sum(1 for r in results if "LIMITED" in r["spambot_status"]),
        "frozen": sum(1 for r in results if r["spambot_status"] == SPAM_FROZEN),
        "flagged_limited": flagged_limited,
        "flagged_frozen": flagged_frozen,
    }


@router.get("/{name}/sessions/info")
async def get_sessions_info(name: str):
    """Quick info check — just connects and gets user info (no send validation).
    Faster than full validate, shows name/username/phone/premium/bio."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    from code.config import resolve_session_path, API_ID, API_HASH, PROXY
    from telethon import TelegramClient
    from telethon.tl.functions.users import GetFullUserRequest

    sessions = cfg.get("sessions") or []
    results = []

    for s in sessions:
        fn = s.get("file", "")
        info = {
            "file": fn,
            "index": s.get("index", 0),
            "real_name": s.get("real_name", ""),
            "user_id": s.get("user_id"),
            "username": "",
            "phone": "",
            "bio": "",
            "premium": False,
            "restricted": False,
            "status": "unknown",
            "error": "",
        }

        path = resolve_session_path(fn)
        if not path.is_file():
            info["status"] = "dead"
            info["error"] = "Session file missing"
            results.append(info)
            continue

        client = None
        try:
            from code.session_guard import SessionBusyError, guarded_client
            client = guarded_client(path, "session details check", wait_timeout=5, expected_sec=30)
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                info["status"] = "dead"
                info["error"] = "Not authorized"
                results.append(info)
                continue

            me = await client.get_me()
            if me:
                info["status"] = "active"
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["username"] = me.username or ""
                info["phone"] = me.phone or ""
                info["user_id"] = me.id
                info["premium"] = bool(getattr(me, "premium", False))
                info["restricted"] = bool(getattr(me, "restricted", False))
                try:
                    full = await client(GetFullUserRequest(me.id))
                    info["bio"] = getattr(full.full_user, "about", "") or ""
                except Exception:
                    pass
                s["real_name"] = info["real_name"]
                s["user_id"] = info["user_id"]
            else:
                info["status"] = "dead"
                info["error"] = "Could not get user info"
            await client.disconnect()
        except Exception as e:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            from code.session_guard import SessionBusyError
            if isinstance(e, SessionBusyError) or "database is locked" in str(e).lower():
                info["status"] = "busy"
                info["error"] = str(e)[:200]
            else:
                info["status"] = "error"
                info["error"] = str(e)[:150]

        results.append(info)

    await wrappers.save_user_data(name, cfg)
    return {"sessions": results}


@router.post("/{name}/sessions/{session_file}/remove")
async def remove_session_from_bot(name: str, session_file: str):
    """Remove a session from the bot and return it to the free pool."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    sessions = cfg.get("sessions") or []
    session_entry = next((s for s in sessions if s.get("file") == session_file), None)
    if not session_entry:
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    # Remove from bot
    cfg["sessions"] = [s for s in sessions if s.get("file") != session_file]
    # Drop any stale disabled flag so a re-added account doesn't inherit "parked" state.
    if session_file in (cfg.get("disabled_sessions") or []):
        cfg["disabled_sessions"] = [f for f in cfg["disabled_sessions"] if f != session_file]
    await wrappers.save_user_data(name, cfg)

    # Add back to free pool
    from code.utils import load_pool, save_pool
    pool = await asyncio.to_thread(load_pool)
    if session_file not in pool.get("free_sessions", []):
        pool.setdefault("free_sessions", []).append(session_file)
        await asyncio.to_thread(save_pool, pool)

    await wrappers.log_admin_action("web_admin", "remove_session", target=f"{session_file} from {name}")
    return {"status": "removed", "file": session_file}


@router.post("/{name}/sessions/{session_file}/disable")
async def disable_session(name: str, session_file: str):
    """Park a session so it is NOT used in ads until re-enabled.

    The account stays bound to the bot (unlike Remove, it is not returned to the free pool).
    The disabled state persists across restarts/resumes until explicitly re-enabled. If the
    bot is live, a cycle-preserving restart is queued so the account stops within moments and
    its groups reassign across the remaining enabled accounts, without disturbing their timing.
    """
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    sessions = cfg.get("sessions") or []
    if not any(s.get("file") == session_file for s in sessions):
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    disabled = [f for f in (cfg.get("disabled_sessions") or []) if f]
    if session_file in disabled:
        return {"status": "already_disabled", "file": session_file}

    # Guard: never disable the last enabled account — the bot would have nothing to post with.
    enabled_after = [
        s for s in sessions
        if (s.get("file") or "") and s.get("file") not in disabled and s.get("file") != session_file
    ]
    if not enabled_after:
        raise HTTPException(
            400,
            "Cannot disable the last enabled session; the bot would have no accounts left to post with.",
        )

    disabled.append(session_file)
    cfg["disabled_sessions"] = disabled
    await wrappers.save_user_data(name, cfg)

    applied = "on_next_start"
    if _bot_is_live(cfg):
        token = await wrappers.get_token_by_name(name)
        if token:
            from code.admin_ptb import submit_main_loop_job
            submit_main_loop_job("restart_bot_preserve", (token,))
            applied = "live"

    await wrappers.log_admin_action("web_admin", "disable_session", target=f"{session_file} on {name}")
    return {"status": "disabled", "file": session_file, "applied": applied}


@router.post("/{name}/sessions/{session_file}/enable")
async def enable_session(name: str, session_file: str):
    """Re-enable a previously disabled session so it is used in ads again."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    disabled = [f for f in (cfg.get("disabled_sessions") or []) if f]
    if session_file not in disabled:
        return {"status": "already_enabled", "file": session_file}

    cfg["disabled_sessions"] = [f for f in disabled if f != session_file]
    await wrappers.save_user_data(name, cfg)

    applied = "on_next_start"
    if _bot_is_live(cfg):
        token = await wrappers.get_token_by_name(name)
        if token:
            from code.admin_ptb import submit_main_loop_job
            submit_main_loop_job("restart_bot_preserve", (token,))
            applied = "live"

    await wrappers.log_admin_action("web_admin", "enable_session", target=f"{session_file} on {name}")
    return {"status": "enabled", "file": session_file, "applied": applied}


class AddSessionRequest(BaseModel):
    session_file: str


@router.post("/{name}/sessions/add")
async def add_session_to_bot(name: str, body: AddSessionRequest):
    """Add a session from the free pool to the bot."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    fn = body.session_file
    sessions = cfg.get("sessions") or []

    # Check not already assigned
    if any(s.get("file") == fn for s in sessions):
        raise HTTPException(400, f"Session '{fn}' already assigned to this bot")

    # Check it's in the free pool
    from code.utils import load_pool, save_pool
    pool = await asyncio.to_thread(load_pool)
    if fn not in pool.get("free_sessions", []):
        raise HTTPException(400, f"Session '{fn}' is not in the free pool")

    # Remove from free pool
    pool["free_sessions"] = [x for x in pool["free_sessions"] if x != fn]
    await asyncio.to_thread(save_pool, pool)

    # Get session info via Telethon
    info = {"file": fn, "real_name": "", "user_id": 0, "index": len(sessions) + 1}
    client, err = await _connect_session(fn)
    if client:
        try:
            me = await client.get_me()
            if me:
                info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                info["user_id"] = me.id
        except Exception:
            pass
        finally:
            await client.disconnect()

    # Add to bot
    sessions.append(info)
    cfg["sessions"] = sessions
    await wrappers.save_user_data(name, cfg)

    await wrappers.log_admin_action("web_admin", "add_session", target=f"{fn} to {name}")
    return {"status": "added", "session": info}


class ReplaceSessionRequest(BaseModel):
    new_session_file: str


@router.post("/{name}/sessions/{session_file}/replace")
async def replace_session(name: str, session_file: str, body: ReplaceSessionRequest):
    """Replace a session with a new one from the free pool. Old one goes to free pool."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    sessions = cfg.get("sessions") or []
    old_entry = next((s for s in sessions if s.get("file") == session_file), None)
    if not old_entry:
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    new_fn = body.new_session_file
    if any(s.get("file") == new_fn for s in sessions):
        raise HTTPException(400, f"Session '{new_fn}' already assigned to this bot")

    from code.utils import load_pool, save_pool
    pool = await asyncio.to_thread(load_pool)
    if new_fn not in pool.get("free_sessions", []):
        raise HTTPException(400, f"Session '{new_fn}' is not in the free pool")

    # Remove new from free pool
    pool["free_sessions"] = [x for x in pool["free_sessions"] if x != new_fn]
    # Return old to free pool
    pool.setdefault("free_sessions", []).append(session_file)
    await asyncio.to_thread(save_pool, pool)

    # Get new session info
    new_info = {"file": new_fn, "real_name": "", "user_id": 0, "index": old_entry.get("index", 1)}
    client, err = await _connect_session(new_fn)
    if client:
        try:
            me = await client.get_me()
            if me:
                new_info["real_name"] = f"{me.first_name or ''} {me.last_name or ''}".strip()
                new_info["user_id"] = me.id
        except Exception:
            pass
        finally:
            await client.disconnect()

    # Replace in list
    cfg["sessions"] = [new_info if s.get("file") == session_file else s for s in sessions]
    await wrappers.save_user_data(name, cfg)

    await wrappers.log_admin_action("web_admin", "replace_session", target=f"{session_file} → {new_fn} on {name}")
    return {"status": "replaced", "old": session_file, "new_session": new_info}


_ASSIGNED_STATUS_OPTIONS = {"healthy", "limited", "frozen", "dead"}


class SetSessionStatusRequest(BaseModel):
    status: str  # "healthy" | "limited" | "frozen" | "dead"


@router.post("/{name}/sessions/{session_file}/set-status")
async def set_assigned_session_status(name: str, session_file: str, body: SetSessionStatusRequest):
    """Manually override an assigned session's health flag.

    Assigned sessions never move between pool buckets or on disk — Replace is the
    explicit action for swapping one out. This just lets an admin correct the health
    signal by hand (e.g. the automated SpamBot/validation check missed something, or
    a flag needs to be dismissed early) without touching the file or its assignment.
    """
    status = (body.status or "").strip().lower()
    if status not in _ASSIGNED_STATUS_OPTIONS:
        raise HTTPException(400, f"status must be one of {sorted(_ASSIGNED_STATUS_OPTIONS)}")

    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    entry = next((s for s in cfg.get("sessions", []) if s.get("file") == session_file), None)
    if not entry:
        raise HTTPException(404, f"Session '{session_file}' not assigned to '{name}'")

    if status == "dead":
        entry["validation_status"] = "invalid"
        entry["validation_reason"] = "Manually marked dead by admin"
        entry["last_validated_at"] = time.time()
    else:
        # Any non-dead override clears a stale "invalid" validation so health reflects it.
        if entry.get("validation_status") == "invalid":
            entry["validation_status"] = "unknown"
            entry["validation_reason"] = ""
        entry["spam_status"] = None if status == "healthy" else status
        entry["last_spambot_check_at"] = time.time()

    await wrappers.save_user_data(name, cfg)
    await wrappers.log_admin_action("web_admin", "set_session_status", target=f"{session_file} → {status} on {name}")
    return {"file": session_file, "status": status}


@router.get("/{name}/sessions/available")
async def get_available_sessions(name: str):
    """Get list of sessions available in the free pool for adding/replacing."""
    pool = await wrappers.load_pool()
    free = pool.get("free_sessions", [])
    return {"sessions": free, "count": len(free)}


# ─────────────────────── Web Token & Login Info ───────────────────────

@router.get("/{name}/web-access")
async def get_web_access_info(name: str):
    """Get web access code, last login info, and login history for a bot."""
    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    return {
        "web_token": cfg.get("web_token", ""),
        "last_web_login": cfg.get("last_web_login"),
        "web_login_history": cfg.get("web_login_history", []),
    }


class SetWebTokenBody(BaseModel):
    web_token: Optional[str] = None  # None = auto-generate


@router.post("/{name}/web-access/set-token")
async def admin_set_web_token(name: str, body: SetWebTokenBody):
    """Admin sets or resets the web access code for a bot."""
    import random, string

    cfg = await wrappers.load_user_data(name)
    if not cfg:
        raise HTTPException(404, f"Bot '{name}' not found")

    if body.web_token and body.web_token.strip():
        new_token = body.web_token.strip()
        if len(new_token) < 4:
            raise HTTPException(400, "Token must be at least 4 characters")
        if len(new_token) > 32:
            raise HTTPException(400, "Token must be at most 32 characters")
    else:
        chars = string.ascii_letters + string.digits
        new_token = "".join(random.choices(chars, k=8))

    # Check uniqueness across all bots
    data = await wrappers.load_adbot()
    for bt, bc in data.get("bots", {}).items():
        if bc.get("name") != name and bc.get("web_token") == new_token:
            raise HTTPException(400, "This code is already used by another bot")

    # Find and update
    for bt, bc in data.get("bots", {}).items():
        if bc.get("name") == name:
            bc["web_token"] = new_token
            break
    await wrappers.save_adbot(data)

    await wrappers.log_admin_action("web_admin", "set_web_token", target=name)
    return {"status": "updated", "web_token": new_token}
