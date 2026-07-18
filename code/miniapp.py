"""Telegram Mini App (chat menu button) management for AdBot controller bots.

Whenever a bot is assigned/activated for a user we point its chat menu button
at that user's web dashboard as a Telegram Web App (mini app), so tapping the
menu next to the message box opens the panel — where they can manage the bot
and change their password. When a bot is deleted, expired, or its token is
replaced, the mini app button is removed from the old bot and the retired bot
is renamed to "NOT IN USE".

See https://core.telegram.org/bots/webapps and the Bot API method
setChatMenuButton. All calls are plain Bot API HTTPS requests (no Telethon),
so they are safe to run without touching the running controller client.
"""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
import urllib.request

from . import config

logger = logging.getLogger(__name__)

# Text shown on the bot's menu button (Telegram limit: 64 chars).
MENU_BUTTON_TEXT = "Dashboard"
# Name given to a bot whose token was replaced (old bot is abandoned).
NOT_IN_USE_NAME = "NOT IN USE"


def build_dashboard_url(web_token: str) -> str | None:
    """Auto-login dashboard URL for a bot's web_token, or None if unusable.

    The URL hits the portal's ``/login?token=`` route, which exchanges the
    web access code for a portal session and lands the user on their dashboard.
    Telegram Web Apps require an HTTPS URL, so we only return a link when
    WEBSITE_URL is configured and https."""
    website = (getattr(config, "WEBSITE_URL", "") or "").strip().rstrip("/")
    token = (web_token or "").strip()
    if not website or not token:
        return None
    if not website.lower().startswith("https://"):
        logger.debug("Mini app skipped: WEBSITE_URL is not https (%s)", website)
        return None
    return f"{website}/login?token={urllib.parse.quote(token)}"


def dashboard_configured() -> bool:
    """True when a public HTTPS site URL is available to build mini app links.

    When this is False (e.g. local dev with an http/localhost URL, or no URL at
    all) the mini app cannot be set, so callers should skip the work entirely."""
    website = (getattr(config, "WEBSITE_URL", "") or "").strip()
    return website.lower().startswith("https://")


def _bot_api_post(bot_token: str, method: str, payload: dict) -> bool:
    """POST JSON to the Telegram Bot API. Sync; safe to call from a worker thread."""
    token = (bot_token or "").strip()
    if not token:
        return False
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = resp.status == 200
            if not ok:
                logger.debug("Bot API %s returned %s", method, resp.status)
            return ok
    except Exception as e:
        logger.debug("Bot API %s failed: %s", method, e)
        return False


# ---------------------------------------------------------------------------
# Sync primitives (safe to call directly from worker-thread event loops such as
# the create pipeline).
# ---------------------------------------------------------------------------
def set_menu_button_webapp_sync(
    bot_token: str, web_token: str, text: str = MENU_BUTTON_TEXT, chat_id: int | None = None
) -> bool:
    """Point a chat menu button at the user's dashboard Web App.

    When ``chat_id`` is given the Web App button is set only for that private
    chat (per-user); when omitted it changes the bot's default button, which is
    shown to every user. The dashboard carries the owner's web_token, so the
    default button must NOT be a Web App — always target authorized users by
    chat_id and leave the default as the plain commands button."""
    url = build_dashboard_url(web_token)
    if not url:
        website = (getattr(config, "WEBSITE_URL", "") or "").strip()
        if not website:
            reason = "WEBSITE_URL is not set in the backend environment"
        elif not website.lower().startswith("https://"):
            reason = f"WEBSITE_URL is not https ({website!r})"
        elif not (web_token or "").strip():
            reason = "bot has no web_token"
        else:
            reason = "unknown"
        logger.info("Mini app not linked for token %s…: %s", (bot_token or "")[:10], reason)
        return False
    payload: dict = {
        "menu_button": {"type": "web_app", "text": (text or "Dashboard")[:64], "web_app": {"url": url}}
    }
    if chat_id is not None:
        payload["chat_id"] = int(chat_id)
    ok = _bot_api_post(bot_token, "setChatMenuButton", payload)
    if ok:
        logger.info(
            "Mini app menu button linked for token %s… (chat %s)",
            (bot_token or "")[:10], chat_id if chat_id is not None else "default",
        )
    return ok


def reset_menu_button_sync(bot_token: str, chat_id: int | None = None) -> bool:
    """Remove a Web App menu button, restoring Telegram's default (commands) button.

    With ``chat_id`` this only clears the per-user override for that chat; without
    it, the bot's default button is reset."""
    payload: dict = {"menu_button": {"type": "default"}}
    if chat_id is not None:
        payload["chat_id"] = int(chat_id)
    return _bot_api_post(bot_token, "setChatMenuButton", payload)


def set_bot_name_not_in_use_sync(bot_token: str, label: str = NOT_IN_USE_NAME) -> bool:
    """Rename an abandoned bot (after token replacement) so it reads as retired."""
    return _bot_api_post(bot_token, "setMyName", {"name": (label or NOT_IN_USE_NAME)[:64]})


# ---------------------------------------------------------------------------
# Async wrappers (safe to await on the main event loop — HTTP runs off-thread).
# ---------------------------------------------------------------------------
async def set_menu_button_webapp(
    bot_token: str, web_token: str, text: str = MENU_BUTTON_TEXT, chat_id: int | None = None
) -> bool:
    return await asyncio.to_thread(set_menu_button_webapp_sync, bot_token, web_token, text, chat_id)


async def reset_menu_button(bot_token: str, chat_id: int | None = None) -> bool:
    return await asyncio.to_thread(reset_menu_button_sync, bot_token, chat_id)


async def set_bot_name_not_in_use(bot_token: str, label: str = NOT_IN_USE_NAME) -> bool:
    return await asyncio.to_thread(set_bot_name_not_in_use_sync, bot_token, label)
