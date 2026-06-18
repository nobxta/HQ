"""Notify website buyers when their AdBot is ready.

Channels (each fires only if it has what it needs; all are best-effort):
  - Email  : if the buyer left an email AND SMTP is configured in .env.
  - Telegram: if a Telegram id was provided AND the shop bot token is set.
  - On-site: handled by the frontend (it keeps the order in localStorage and
    shows the login when the buyer returns) — nothing to do here.
"""
import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage

from .. import config

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, body: str) -> bool:
    """Send a plain-text email. No-op (returns False) if SMTP isn't configured."""
    to = (to or "").strip()
    if not (config.SMTP_HOST and to):
        return False
    try:
        msg = EmailMessage()
        msg["From"] = config.SMTP_FROM or config.SMTP_USER or "no-reply@hqadz.io"
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        ctx = ssl.create_default_context()
        if config.SMTP_PORT == 465:
            with smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=ctx, timeout=20) as s:
                if config.SMTP_USER:
                    s.login(config.SMTP_USER, config.SMTP_PASS)
                s.send_message(msg)
        else:
            with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=20) as s:
                s.starttls(context=ctx)
                if config.SMTP_USER:
                    s.login(config.SMTP_USER, config.SMTP_PASS)
                s.send_message(msg)
        logger.info("[NOTIFY] email sent to %s", to)
        return True
    except Exception as exc:
        logger.warning("[NOTIFY] email failed to %s: %s", to, exc)
        return False


async def notify_order_ready(order: dict) -> None:
    """Fire every available channel for a completed website order."""
    website = (getattr(config, "WEBSITE_URL", "") or "").rstrip("/")
    login_url = f"{website}/user/login" if website else "/user/login"
    token = (order.get("web_token") or "").strip()
    plan = order.get("plan_name") or "AdBot"
    name = order.get("bot_name") or "there"
    token_line = f"Your access token: {token}\n" if token else ""
    body = (
        f"Hi {name},\n\n"
        f"Your {plan} AdBot is ready to use.\n{token_line}"
        f"Log in here: {login_url}\n\n"
        f"Thanks for your purchase."
    )

    email = (order.get("ref_email") or "").strip()
    if email:
        await asyncio.to_thread(send_email, email, "Your AdBot is ready", body)

    tid = order.get("notify_telegram_id") or order.get("user_id") or 0
    if tid and getattr(config, "SHOP_BOT_TOKEN", ""):
        try:
            from . import notify as _notify
            await _notify.notify_send_to_chat(int(tid), body, bot_token=config.SHOP_BOT_TOKEN)
            logger.info("[NOTIFY] telegram sent to %s", tid)
        except Exception as exc:
            logger.warning("[NOTIFY] telegram failed for %s: %s", tid, exc)
