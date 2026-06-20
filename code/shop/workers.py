"""
Shop Bot background workers: payment polling, renewal scheduler, order recovery.
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path

from .. import config
from .. import notify
from ..utils import add_admin_alert

# Heartbeat path for watchdog: if payment_ts older than 15 min → restart worker
PAYMENT_HEARTBEAT_PATH = config.DATA_DIR / "payment_worker_heartbeat.json"
WATCHDOG_STALE_SEC = 900  # 15 minutes


def _write_payment_heartbeat() -> None:
    try:
        PAYMENT_HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        PAYMENT_HEARTBEAT_PATH.write_text(json.dumps({"ts": time.time()}), encoding="utf-8")
    except Exception as e:
        logger.debug("Payment heartbeat write failed: %s", e)


from .storage import (
    load_orders,
    load_plans,
    update_order_status,
    update_order,
    get_order,
    get_order_by_payment_id,
    cleanup_old_expired_cancelled_orders,
    temppay_load_all,
    temppay_remove_by_invoice_id,
    temppay_get_by_invoice_id,
    append_order_from_temppay,
)
from .payment import get_payment_details, fetch_supported_currencies
from .explorer import (
    build_explorer_link,
    normalize_network_for_explorer,
    get_currency_display_name,
)
from ..ui.emoji_entities import build_emoji_message, PLACEHOLDER
from ..ui.emojis import CUSTOM_EMOJIS
from telegram import MessageEntity, InlineKeyboardButton, InlineKeyboardMarkup

logger = logging.getLogger(__name__)


def build_payment_confirmation_screen(order: dict, payment_details: dict | None = None):
    """
    Build Message 1 — Payment Confirmation Screen: HTML body, premium emoji, [Proceed].
    Uses real blockchain tx_hash and network-aware explorer link. Returns (text, entities, reply_markup).
    payment_details: from get_payment_details() when payment confirmed; supplies tx_hash, network, pay_currency.
    """
    import html
    pay_currency = (payment_details or {}).get("pay_currency") or order.get("pay_currency") or order.get("currency") or ""
    network_api = (payment_details or {}).get("network") or order.get("network") or ""
    tx_hash = (payment_details or {}).get("tx_hash") or order.get("tx_hash") or ""
    network_key = normalize_network_for_explorer(pay_currency, network_api)
    explorer_link = build_explorer_link(network_key, tx_hash) if tx_hash else None
    network_display = get_currency_display_name(pay_currency or network_key)

    plan_name = (order.get("plan_name") or "AdBot").strip()
    duration_days = order.get("duration_days") or 0
    order_id = (order.get("order_id") or "").strip()
    today = datetime.utcnow().strftime("%Y-%m-%d")

    plan_esc = html.escape(plan_name)
    tx_esc = html.escape(tx_hash) if tx_hash else "—"
    body_html = (
        f"<b>Transaction Confirmed</b>\n\n"
        f"<b>Plan:</b> {plan_esc}\n"
        f"<b>Duration:</b> {duration_days} days\n"
        f"<b>Date:</b> {today}\n\n"
        f"<b>Payment Network:</b> {html.escape(network_display)}\n\n"
        f"<b>Transaction Hash:</b>\n"
        f"<code>{tx_esc}</code>\n\n"
    )
    if explorer_link:
        body_html += f'<b>View on Blockchain:</b>\n<a href="{html.escape(explorer_link)}">Open Explorer</a>\n\n'
    body_html += "Press <b>Proceed</b> to continue setup."

    full_text = f"{PLACEHOLDER} {body_html}"
    entities = []
    if "payment_confirmed" in CUSTOM_EMOJIS:
        entities.append(MessageEntity(
            type=MessageEntity.CUSTOM_EMOJI,
            offset=0,
            length=len(PLACEHOLDER),
            custom_emoji_id=CUSTOM_EMOJIS["payment_confirmed"],
        ))
    reply_markup = InlineKeyboardMarkup([
        [InlineKeyboardButton("Proceed", callback_data=f"shop_proceed_setup:{order_id}")]
    ])
    return full_text, entities, reply_markup

# Payment polling: per-order next_poll_at. Fault-tolerant: API failure = retry next cycle, no state change.
# Stage 1: first 30 min → poll every 2 min
# Stage 2: after 30 min → poll every 10 min
# Stage 3: after 12 hours → mark expired, edit message, stop polling
POLL_LOOP_SLEEP_SEC = 60
POLL_INTERVAL_FIRST_30_MIN = 120   # 2 min
POLL_INTERVAL_AFTER_30_MIN = 600   # 10 min
PAYMENT_WINDOW_HOURS = 12
RENEWAL_CHECK_INTERVAL_SEC = 3600
RENEWAL_HOURS_BEFORE = 24

# User-facing messages: professional, clear, one emoji at start when appropriate. Telegram Markdown.

EXPIRED_MESSAGE = (
    "Payment expired.\n\n"
    "This invoice is no longer valid. Create a new order to continue."
)

CONFIRMING_MESSAGE = (
    "Transaction detected.\n\n"
    "Waiting for blockchain confirmations. You will be notified when the payment is confirmed. No action needed."
)

CONFIRMED_PREP_MESSAGE = (
    "Payment confirmed.\n\n"
    "Your order is complete. You will receive a separate message with the next step: enter your bot name, then your bot token."
)

# Single leading emoji for payment status (used when editing payment message)
CONFIRMING_MESSAGE_DISPLAY = "✅ " + CONFIRMING_MESSAGE
CONFIRMED_PREP_MESSAGE_DISPLAY = "✅ " + CONFIRMED_PREP_MESSAGE

# Wizard step messages: plain text (no **) so formatting is never shown literally when parse_mode varies.
STEP5_MESSAGE = (
    "Enter your AdBot name.\n\n"
    "Reply with the name you want for your AdBot (e.g. MyAdBot).\n\n"
    "That's all we need — we'll set up your AdBot and send you the link when it's ready."
)

STEP6_MESSAGE = (
    "Send your Bot Token from @BotFather.\n\n"
    "Paste the token from @BotFather. We will create your AdBot and send you the link when ready."
)

RENEWAL_CONFIRMED_MESSAGE = (
    "Payment confirmed.\n\n"
    "Your AdBot validity has been extended."
)

CREATION_PROGRESS_MESSAGE = (
    "Creating your AdBot.\n\n"
    "Assigning sessions and setting up. This message will update with progress."
)

# Single queue notification: edit progress message only (no separate DM).
QUEUE_EDIT_MESSAGE = (
    "Your AdBot is queued\n\n"
    "We do not have enough sessions available to activate your plan at the moment.\n\n"
    "Support has been notified. You will receive a message here when your AdBot is ready."
)

FAILURE_CREATION_MESSAGE = (
    "Creation failed.\n\n"
    "Please contact support. You can retry from the main menu."
)

SUCCESS_ACTIVATED_MESSAGE = (
    "AdBot successfully created: {username}\n"
    "Your controller bot is ready."
)


def _parse_iso(s: str) -> datetime | None:
    if not (s or "").strip():
        return None
    try:
        return datetime.strptime(s.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def _poll_interval_sec(elapsed_sec: float) -> int:
    """Stage 1: ≤30 min → 2 min; Stage 2: >30 min → 10 min. After 12h order is expired."""
    if elapsed_sec <= 30 * 60:
        return POLL_INTERVAL_FIRST_30_MIN
    return POLL_INTERVAL_AFTER_30_MIN


async def _process_temppay_entry(entry: dict, now_utc: datetime) -> None:
    """
    Process one temppay entry: expiry (remove + edit msg), or poll and on confirming/confirmed
    move to orders.json and remove from temppay.
    """
    invoice_id = (entry.get("invoice_id") or entry.get("payment_id") or "").strip()
    if not invoice_id:
        return
    expiry_at = (entry.get("expiry_at") or "").strip()
    expiry_dt = _parse_iso(expiry_at) if expiry_at else None
    if expiry_dt and now_utc > expiry_dt:
        temppay_remove_by_invoice_id(invoice_id)
        try:
            from code.shop.handlers import clear_pending_payment_state
            clear_pending_payment_state(entry.get("user_id"))
        except Exception:
            pass
        chat_id = entry.get("payment_chat_id") or 0
        msg_id = entry.get("payment_message_id") or 0
        if chat_id and msg_id:
            await notify.notify_edit_message(
                chat_id, msg_id, EXPIRED_MESSAGE, bot_token=config.SHOP_BOT_TOKEN
            )
        return
    details = await asyncio.to_thread(get_payment_details, invoice_id)
    if details is None:
        logger.warning("Payment API failed for temppay invoice_id=%s; retry next cycle", invoice_id)
        return
    provider_status = (details.get("payment_status") or "waiting").lower()
    amount_received = float(details.get("amount_received") or 0)
    pay_amount = float(entry.get("amount") or entry.get("pay_amount") or 0)
    user_id = entry.get("user_id")
    chat_id = entry.get("payment_chat_id") or 0
    msg_id = entry.get("payment_message_id") or 0

    if provider_status == "confirming":
        existing = get_order_by_payment_id(invoice_id)
        if existing and existing.get("status") in ("confirming", "paid", "completed"):
            temppay_remove_by_invoice_id(invoice_id)
            if chat_id and msg_id:
                await notify.notify_edit_message(
                    chat_id, msg_id, CONFIRMING_MESSAGE_DISPLAY, bot_token=config.SHOP_BOT_TOKEN
                )
            return
        append_order_from_temppay(entry, status="confirming")
        temppay_remove_by_invoice_id(invoice_id)
        if chat_id and msg_id:
            await notify.notify_edit_message(
                chat_id, msg_id, CONFIRMING_MESSAGE_DISPLAY, bot_token=config.SHOP_BOT_TOKEN
            )
        elif user_id:
            await notify.notify_send_to_chat(user_id, CONFIRMING_MESSAGE_DISPLAY, bot_token=config.SHOP_BOT_TOKEN)
        return
    if provider_status == "confirmed" and amount_received >= pay_amount:
        existing = get_order_by_payment_id(invoice_id)
        if existing and existing.get("status") in ("paid", "completed"):
            temppay_remove_by_invoice_id(invoice_id)
            if chat_id and msg_id:
                conf_text, conf_ent, conf_rm = build_payment_confirmation_screen(existing, details)
                await notify.notify_edit_message(
                    chat_id, msg_id, conf_text, parse_mode="HTML", reply_markup=conf_rm, entities=conf_ent,
                    disable_web_page_preview=True, bot_token=config.SHOP_BOT_TOKEN
                )
            return
        order = append_order_from_temppay(entry, status="confirming")
        temppay_remove_by_invoice_id(invoice_id)
        order_id = order.get("order_id", "")
        plan_name = order.get("plan_name") or "AdBot"
        duration_days = order.get("duration_days") or 0
        network_key = normalize_network_for_explorer(details.get("pay_currency") or "", details.get("network") or "")
        update_order_status(order_id, "paid", paid_at=datetime.utcnow().isoformat() + "Z")
        update_order(order_id, {
            "awaiting_field": "proceed",
            "tx_hash": (details.get("tx_hash") or "").strip(),
            "network": network_key,
            "pay_currency": (details.get("pay_currency") or "").strip(),
        })
        conf_text, conf_ent, conf_rm = build_payment_confirmation_screen(order, details)
        if chat_id and msg_id:
            await notify.notify_edit_message(
                chat_id, msg_id, conf_text, parse_mode="HTML", reply_markup=conf_rm, entities=conf_ent,
                disable_web_page_preview=True, bot_token=config.SHOP_BOT_TOKEN
            )
        logger.info(
            "Payment confirmed — blockchain tx stored order_id=%s tx_hash=%s explorer_key=%s",
            order_id, "yes" if (details.get("tx_hash") or "").strip() else "no", network_key
        )
        if build_explorer_link(network_key, details.get("tx_hash") or ""):
            logger.info("Explorer link generated for %s", network_key)
        logger.info("Confirmation message formatted successfully")
        add_admin_alert(
            "order_confirmed",
            f"New order confirmed\nPlan: {plan_name}\nDuration: {duration_days} days\nUser: tg://user?id={user_id}",
        )
        logger.info("[CREATE_PIPELINE] temppay→order OK order_id=%s; confirmation screen shown (Proceed required)", order_id)


async def apply_confirmed_payment(o: dict, details: dict) -> bool:
    """Run the post-payment action for a confirmed order. Idempotent and shared by
    the polling worker AND the IPN webhook.

    Handles three order kinds:
      - website purchase (source == "web"): mark paid, assign a pooled bot token,
        queue for creation (or flag if the pool is empty).
      - renewal: extend the parent bot's validity, complete the order.
      - new bot purchase (shop bot): mark paid + awaiting "proceed", show the
        Telegram confirmation screen so the user can continue.

    Returns False if the order is no longer awaiting payment (already handled).
    """
    order_id = o.get("order_id", "")
    current = get_order(order_id)
    if not current or current.get("status") not in ("payment_waiting", "confirming"):
        return False
    now = datetime.utcnow().isoformat() + "Z"

    # ── Website purchase ──
    if (o.get("source") or "") == "web":
        from . import token_pool
        update_order_status(order_id, "paid", paid_at=now)
        tok = (o.get("bot_token") or "").strip()
        if tok:
            token_pool.mark_assigned(order_id)
            try:
                update_order_status(order_id, "pending_creation")
            except Exception:
                pass
            add_admin_alert("web_purchase", f"Web order {order_id} paid — create AdBot ({o.get('plan_name')}) for {o.get('bot_name')}.")
        else:
            add_admin_alert("web_purchase_queued", f"Web order {order_id} paid but NO bot token in pool — add one, then recreate.")
        logger.info("[IPN] web order %s confirmed → %s", order_id, "pending_creation" if tok else "queued")
        return True

    # ── Bot purchase / renewal ──
    chat_id = o.get("payment_chat_id") or 0
    msg_id = o.get("payment_message_id") or 0
    user_id = o.get("user_id") or 0
    plan_name = o.get("plan_name") or "AdBot"
    duration_days = o.get("duration_days") or 0
    network_key = normalize_network_for_explorer(details.get("pay_currency") or "", details.get("network") or "")

    if o.get("order_type") == "renewal":
        confirm_edit = "✅ " + RENEWAL_CONFIRMED_MESSAGE
        if chat_id and msg_id:
            await notify.notify_edit_message(
                chat_id, msg_id, confirm_edit, bot_token=config.SHOP_BOT_TOKEN
            )
    else:
        conf_text, conf_ent, conf_rm = build_payment_confirmation_screen(o, details)
        if chat_id and msg_id:
            await notify.notify_edit_message(
                chat_id, msg_id, conf_text, parse_mode="HTML", reply_markup=conf_rm, entities=conf_ent,
                disable_web_page_preview=True, bot_token=config.SHOP_BOT_TOKEN
            )
        logger.info(
            "Payment confirmed — blockchain tx stored order_id=%s tx_hash=%s explorer_key=%s",
            order_id, "yes" if (details.get("tx_hash") or "").strip() else "no", network_key
        )
        if build_explorer_link(network_key, details.get("tx_hash") or ""):
            logger.info("Explorer link generated for %s", network_key)
        logger.info("Confirmation message formatted successfully")

    if o.get("order_type") == "renewal":
        parent_id = o.get("parent_order_id")
        parent = get_order(parent_id) if parent_id else None
        if parent and extend_valid_till_for_bot(parent.get("bot_token", ""), o.get("duration_days", 0), o.get("order_id", "")):
            update_order_status(order_id, "completed", paid_at=now)
            if user_id:
                try:
                    from ..broadcast_users import add_plan_user
                    add_plan_user(user_id)
                except Exception:
                    pass
            if user_id and not (chat_id and msg_id):
                await notify.notify_send_to_chat(
                    user_id,
                    "✅ " + RENEWAL_CONFIRMED_MESSAGE,
                    bot_token=config.SHOP_BOT_TOKEN,
                )
            add_admin_alert(
                "renewal_confirmed",
                f"Renewal confirmed\nOrder: {order_id}\nDuration: {duration_days} days\nUser: tg://user?id={user_id}",
            )
            logger.info("Renewal order %s completed for bot", order_id)
        else:
            update_order_status(order_id, "failed")
    else:
        update_order_status(order_id, "paid", paid_at=now)
        update_order(order_id, {
            "awaiting_field": "proceed",
            "tx_hash": (details.get("tx_hash") or "").strip(),
            "network": network_key,
            "pay_currency": (details.get("pay_currency") or "").strip(),
        })
        if user_id:
            try:
                from ..broadcast_users import add_plan_user
                add_plan_user(user_id)
            except Exception:
                pass
        add_admin_alert(
            "order_confirmed",
            f"New order confirmed\nPlan: {plan_name}\nDuration: {duration_days} days\nUser: tg://user?id={user_id}",
        )
        logger.info("[CREATE_PIPELINE] order→paid order_id=%s; confirmation screen shown (Proceed required)", order_id)
    return True


async def confirm_payment_for_invoice(payment_id: str, details: dict) -> bool:
    """Confirm a payment by its NOWPayments invoice/payment id — used by the IPN webhook.

    Handles both storage locations:
      - orders.json (website, renewal, or already-promoted bot purchases), and
      - temppay.json (shop-bot purchases not yet promoted to an order) — promoted first.

    Returns True if a matching order was confirmed, False if nothing matched.
    """
    pid = (payment_id or "").strip()
    if not pid:
        return False
    # Already an order (website / renewal / promoted bot purchase)
    order = get_order_by_payment_id(pid)
    if order:
        return await apply_confirmed_payment(order, details)
    # Shop-bot new purchase still sitting in temppay → promote, then confirm
    entry = temppay_get_by_invoice_id(pid)
    if entry and (entry.get("status") or "pending") == "pending":
        order = append_order_from_temppay(entry, status="confirming")
        temppay_remove_by_invoice_id(pid)
        return await apply_confirmed_payment(order, details)
    return False


async def payment_polling_worker() -> None:
    """
    Two sources: (1) temppay.json = active unpaid (pending). (2) orders.json = confirming / payment_waiting (renewals).
    Temppay: on expiry remove + edit msg; on confirming move to orders and remove from temppay; on confirmed same + trigger creation.
    Restart-safe: elapsed and next_poll_at from stored timestamps; startup recovery
    clears next_poll_at so payments made while offline are detected on first loop.
    Previously created unpaid orders are detected automatically when payment is received
    (GET /payment/{id} only; no new invoice is created).

    Payment state transitions:
      waiting     -> keep polling (no user notification unless partial payment)
      confirming  -> update order status, notify user once, keep polling until confirmed
      confirmed   -> mark order paid, notify user, trigger AdBot creation (request name/token)
    """
    if not config.SHOP_BOT_TOKEN:
        return
    # Confirm API key is not empty at worker startup (used for GET /payment/{id} and invoice creation)
    _key_len = len(config.NOWPAYMENTS_API_KEY or "")
    logger.info("Payment polling worker started: NOWPAYMENTS_API_KEY len=%s", _key_len)
    if _key_len == 0 and not getattr(config, "PAYMENT_DEV_MODE", False):
        logger.warning("Payment polling running with empty NOWPAYMENTS_API_KEY; GET /payment/{id} may fail until key is set")
    while True:
        try:
            from ..maintenance import is_maintenance_enabled
            if is_maintenance_enabled():
                _write_payment_heartbeat()
                await asyncio.sleep(60)
                continue
            _write_payment_heartbeat()
            now_utc = datetime.utcnow()
            for entry in temppay_load_all():
                if (entry.get("status") or "pending") != "pending":
                    continue
                try:
                    await _process_temppay_entry(entry, now_utc)
                except Exception as e:
                    logger.warning("Temppay entry processing error: %s", e)
            orders = load_orders()
            for o in orders:
                status = o.get("status") or ""
                if status not in ("payment_waiting", "confirming"):
                    continue
                order_id = o.get("order_id", "")
                payment_id = (o.get("payment_id") or "").strip()
                if not payment_id:
                    continue
                created_dt = _parse_iso((o.get("created_at") or "").strip())
                if not created_dt:
                    continue
                # Expiry: use expiry_time (created_at + 12h); fallback to created_at + 12h
                expiry_iso = (o.get("expiry_time") or "").strip()
                expiry_dt = _parse_iso(expiry_iso) if expiry_iso else None
                if not expiry_dt:
                    expiry_dt = created_dt + timedelta(hours=PAYMENT_WINDOW_HOURS)
                    update_order(order_id, {"expiry_time": expiry_dt.strftime("%Y-%m-%dT%H:%M:%S") + "Z"})
                elapsed_sec = (now_utc - created_dt).total_seconds()

                # After expiry_time → mark expired, edit message, stop polling (only for unconfirmed orders)
                if now_utc > expiry_dt:
                    update_order(order_id, {"status": "expired"})
                    user_id = o.get("user_id")
                    if user_id:
                        try:
                            from code.shop.handlers import clear_pending_payment_state
                            clear_pending_payment_state(user_id)
                        except Exception:
                            pass
                    chat_id = o.get("payment_chat_id") or 0
                    msg_id = o.get("payment_message_id") or 0
                    if chat_id and msg_id:
                        await notify.notify_edit_message(
                            chat_id, msg_id, EXPIRED_MESSAGE, bot_token=config.SHOP_BOT_TOKEN
                        )
                    continue

                # Only poll when due (next_poll_at missing or now >= next_poll_at)
                next_poll_at = _parse_iso((o.get("next_poll_at") or "").strip())
                if next_poll_at is not None and now_utc < next_poll_at:
                    continue

                # Poll provider: GET /v1/payment/{payment_id}
                details = await asyncio.to_thread(get_payment_details, payment_id)
                if details is None:
                    logger.warning("Payment API failed for order %s (payment_id=%s); retry next cycle", order_id, payment_id)
                    continue

                # Advance next poll time only on successful API call
                interval_sec = _poll_interval_sec(elapsed_sec)
                next_at = now_utc + timedelta(seconds=interval_sec)
                update_order(order_id, {
                    "last_payment_check_at": now_utc.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
                    "next_poll_at": next_at.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
                })

                provider_status = (details.get("payment_status") or "waiting").lower()
                amount_received = float(details.get("amount_received") or 0)
                pay_amount = float(o.get("pay_amount") or 0)  # expected crypto amount

                if provider_status == "waiting":
                    # Partial: amount_received < pay_amount → notify once, continue polling
                    if pay_amount > 0 and 0 < amount_received < pay_amount:
                        if not o.get("_notified_partial"):
                            remaining = pay_amount - amount_received
                            msg = (
                                "Payment detected but incomplete.\n\n"
                                f"Received: {amount_received}\n"
                                f"Required: {pay_amount}\n"
                                f"Remaining: {remaining}\n\n"
                                "Send the remaining amount to continue the process."
                            )
                            chat_id = o.get("payment_chat_id") or 0
                            msg_id = o.get("payment_message_id") or 0
                            user_id = o.get("user_id")
                            if chat_id and msg_id:
                                await notify.notify_edit_message(
                                    chat_id, msg_id, msg, bot_token=config.SHOP_BOT_TOKEN
                                )
                            elif user_id:
                                await notify.notify_send_to_chat(user_id, msg, bot_token=config.SHOP_BOT_TOKEN)
                            update_order(order_id, {"_notified_partial": True})
                    continue

                if provider_status == "confirming":
                    update_order(order_id, {"status": "confirming"})
                    if not o.get("_notified_confirming"):
                        chat_id = o.get("payment_chat_id") or 0
                        msg_id = o.get("payment_message_id") or 0
                        if chat_id and msg_id:
                            await notify.notify_edit_message(
                                chat_id, msg_id,
                                CONFIRMING_MESSAGE_DISPLAY,
                                bot_token=config.SHOP_BOT_TOKEN,
                            )
                        else:
                            user_id = o.get("user_id")
                            if user_id:
                                await notify.notify_send_to_chat(
                                    user_id, CONFIRMING_MESSAGE_DISPLAY, bot_token=config.SHOP_BOT_TOKEN
                                )
                        update_order(order_id, {"_notified_confirming": True})
                    continue

                # Paid or overpaid: amount_received >= pay_amount AND payment_status == confirmed → proceed normally (no special overpayment handling)
                if provider_status == "confirmed" and amount_received >= pay_amount:
                    await apply_confirmed_payment(o, details)
        except Exception as e:
            logger.warning("Payment polling error: %s", e)
        _write_payment_heartbeat()
        await asyncio.sleep(POLL_LOOP_SLEEP_SEC)


async def renewal_scheduler_worker() -> None:
    """Every hour check for bots expiring in 24h; send renewal reminder to buyer via Shop Bot."""
    if not config.SHOP_BOT_TOKEN:
        return
    from ..utils import load_adbot
    while True:
        try:
            data = load_adbot()
            bots = data.get("bots", {})
            now = datetime.utcnow()
            threshold = now + timedelta(hours=RENEWAL_HOURS_BEFORE)
            for bot_token, cfg in bots.items():
                vt = cfg.get("valid_till") or ""
                if not vt:
                    continue
                try:
                    end = datetime.strptime(vt.strip(), "%d/%m/%Y")
                except ValueError:
                    continue
                if end > threshold:
                    continue
                if end <= now:
                    continue
                # Expires within 24h; find order for this bot to get user_id
                orders = load_orders()
                bot_username_norm = (cfg.get("bot_username") or "").strip().lstrip("@").lower()
                order = next(
                    (x for x in orders if x.get("bot_token") == bot_token or (x.get("created_bot_username") or "").strip().lstrip("@").lower() == bot_username_norm),
                    None,
                )
                if not order:
                    continue
                user_id = order.get("user_id")
                if not user_id:
                    continue
                vt = vt.strip()
                if cfg.get("last_renewal_reminder_sent") == vt:
                    continue
                try:
                    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
                    from .. import bot_ptb
                    from ..utils import get_name_by_token, save_user_data
                    bot = bot_ptb._get_ptb_bot(config.SHOP_BOT_TOKEN)
                    kb = InlineKeyboardMarkup([[InlineKeyboardButton("Renew Now", callback_data=f"shop_renew:{order.get('order_id', '')}")]])
                    await bot.send_message(user_id, "Your AdBot will expire in 24 hours.\n[ Renew Now ]", reply_markup=kb)
                    name = get_name_by_token(bot_token)
                    if name:
                        cfg["last_renewal_reminder_sent"] = vt
                        save_user_data(name, cfg)
                except Exception as e:
                    logger.warning("Renewal reminder send failed: %s", e)
                logger.info("Sent renewal reminder to user %s for bot %s", user_id, cfg.get("name"))
        except Exception as e:
            logger.warning("Renewal scheduler error: %s", e)
        await asyncio.sleep(RENEWAL_CHECK_INTERVAL_SEC)


def extend_valid_till_for_bot(bot_token: str, duration_days: int, order_id: str = "") -> bool:
    """Extend valid_till by duration_days for the bot. Sets last_renewal_at, last_renewal_days, and appends to history.renewals + renewal_history. Returns True on success."""
    from ..utils import get_name_by_token, save_user_data, load_user_data
    from ..user_config import append_renewal_to_history
    name = get_name_by_token(bot_token)
    if not name:
        return False
    cfg = load_user_data(name)
    if not cfg:
        return False
    vt = (cfg.get("valid_till") or "").strip()
    if not vt:
        return False
    try:
        from datetime import datetime as dt
        # Support both DD/MM/YYYY and YYYY-MM-DD formats
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                end = dt.strptime(vt, fmt)
                break
            except ValueError:
                continue
        else:
            return False
        end = end + timedelta(days=duration_days)
        cfg["valid_till"] = end.strftime("%d/%m/%Y")
        now_iso = dt.utcnow().isoformat() + "Z"
        cfg["last_renewal_at"] = now_iso
        cfg["last_renewal_days"] = duration_days
        append_renewal_to_history(cfg, at=now_iso, days=duration_days, order_id=order_id, source="renewal")
        # Reset free replacement quota on renewal
        try:
            from ..replacement import _reset_free_replacements_on_renewal
            from ..shop.storage import load_plans
            plan_name = cfg.get("plan_name") or cfg.get("plan", {}).get("id", "")
            mode = (cfg.get("mode") or "starter").lower()
            plans = load_plans()
            plan_list = plans.get(mode, [])
            matched_plan = next((p for p in plan_list if p.get("id") == plan_name), None)
            if matched_plan:
                _reset_free_replacements_on_renewal(cfg, matched_plan)
        except Exception:
            pass
        save_user_data(name, cfg)
        return True
    except Exception:
        return False


def resume_payment_polling_on_startup() -> None:
    """
    On process restart: make all payment_waiting and confirming orders due for polling immediately
    so payments made while the server was offline are detected on first poll loop.
    Clears next_poll_at so the polling worker will pick them up within POLL_LOOP_SLEEP_SEC.
    When GET /payment/{id} returns status "confirmed" and amount_received >= pay_amount,
    the worker transitions the order to "paid" and triggers AdBot creation (request name/token).
    """
    try:
        orders = load_orders()
        count = 0
        for o in orders:
            status = o.get("status") or ""
            if status not in ("payment_waiting", "confirming"):
                continue
            order_id = o.get("order_id", "")
            payment_id = (o.get("payment_id") or "").strip()
            if not payment_id:
                continue
            update_order(order_id, {"next_poll_at": ""})
            count += 1
        if count:
            logger.info("Payment polling resume: %s order(s) with status payment_waiting/confirming set for immediate poll", count)
    except Exception as e:
        logger.warning("Payment polling resume error: %s", e)


async def order_recovery_on_startup() -> None:
    """On startup: mark stuck 'creating' orders failed; resume polling for payment_waiting/confirming so payments are detected after restart."""
    try:
        orders = load_orders()
        for o in orders:
            if o.get("status") == "creating":
                update_order_status(o.get("order_id", ""), "failed")
                logger.info("Order %s was in creating; marked failed after restart", o.get("order_id"))
        resume_payment_polling_on_startup()
    except Exception as e:
        logger.warning("Order recovery error: %s", e)


DAILY_CLEANUP_INTERVAL_SEC = 86400  # 24 hours
DAILY_CURRENCIES_SYNC_INTERVAL_SEC = 86400  # 24 hours
# Paid but no bot created after this many minutes → alert + auto-retry creation
PAYMENT_RECONCILIATION_STALE_MIN = 30


async def run_payment_reconciliation() -> int:
    """
    Find orders: status=paid, created_bot_username empty, bot_token set, paid_at older than X min.
    Alert admin and re-submit create job for each. Returns count of jobs re-submitted.
    """
    from datetime import datetime as _dt
    from ..utils import add_admin_alert, validate_bot_token
    from .. import config as _config
    cutoff = _dt.utcnow() - timedelta(minutes=PAYMENT_RECONCILIATION_STALE_MIN)
    orders = load_orders()
    count = 0
    for o in orders:
        if (o.get("status") or "") != "paid":
            continue
        if (o.get("created_bot_username") or "").strip():
            continue
        bot_token = (o.get("bot_token") or "").strip()
        if not bot_token:
            continue
        paid_at = (o.get("paid_at") or "").strip()
        if not paid_at:
            continue
        try:
            paid_dt = _dt.strptime(paid_at.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
        if paid_dt > cutoff:
            continue
        order_id = o.get("order_id", "")
        bot_name = (o.get("bot_name") or "AdBot").strip()
        plan_id = o.get("plan_id", "")
        plans = load_plans()
        plan_obj = None
        for mode_plans in plans.values():
            for p in mode_plans:
                if p.get("id") == plan_id:
                    plan_obj = p
                    break
            if plan_obj:
                break
        if not plan_obj:
            plan_obj = {"sessions": 1, "cycle": 3600, "gap": 5}
        valid_end = _dt.utcnow() + timedelta(days=int(o.get("duration_days", 7)))
        valid_till = valid_end.strftime("%d/%m/%Y")
        group_file = "Starter.txt"
        if not (_config.GROUPS_DIR / group_file).exists():
            for f in _config.GROUPS_DIR.glob("*.txt"):
                group_file = f.name
                break
        try:
            ok, username = await validate_bot_token(bot_token)
        except Exception:
            ok, username = False, "validation failed"
        if not ok:
            add_admin_alert("reconciliation_skip", f"Order {order_id}: paid but bot not created; token invalid ({username}).")
            continue
        form = {
            "name": bot_name,
            "bot_token": bot_token,
            "bot_username": username,
            "sessions_count": int(plan_obj.get("sessions", 1)),
            "cycle": int(plan_obj.get("cycle", 3600)),
            "gap": int(plan_obj.get("gap", 5)),
            "valid_till": valid_till,
            "duration_days": int(o.get("duration_days", 7)),
            "mode": (o.get("plan_mode") or "starter").strip().capitalize(),
            "group_file": group_file,
            "plan_name": (o.get("plan_name") or ""),
            "renewal_price": str(o.get("amount_usd", 0)),
            "order_id": order_id,
            "source": "shop",
            "user_id": o.get("user_id"),
        }
        try:
            from ..admin import _create_job_queue, _start_create_worker_if_needed
            from ..admin_ptb import submit_create_job
            import queue as _q
            _start_create_worker_if_needed()
            user_id = o.get("user_id")
            if user_id and getattr(config, "SHOP_BOT_TOKEN", None):
                try:
                    from .. import bot_ptb
                    ok, msg_id = await bot_ptb.send_message_with_bot_return_id(
                        user_id, CREATION_PROGRESS_MESSAGE, bot_token=config.SHOP_BOT_TOKEN
                    )
                    if ok and msg_id is not None:
                        submit_create_job(
                            user_id, msg_id, form,
                            notification_bot_token=config.SHOP_BOT_TOKEN,
                        )
                        count += 1
                        add_admin_alert("reconciliation", f"Order {order_id}: creation re-queued; progress sent to buyer.")
                    else:
                        _create_job_queue.put((0, 0, form, _q.Queue()))
                        count += 1
                        add_admin_alert("reconciliation", f"Order {order_id}: paid but bot not created after {PAYMENT_RECONCILIATION_STALE_MIN} min; creation re-queued (no progress UI).")
                except Exception as send_err:
                    logger.warning("Reconciliation send progress failed order %s: %s", order_id, send_err)
                    _create_job_queue.put((0, 0, form, _q.Queue()))
                    count += 1
                    add_admin_alert("reconciliation", f"Order {order_id}: paid but bot not created after {PAYMENT_RECONCILIATION_STALE_MIN} min; creation re-queued.")
            else:
                _create_job_queue.put((0, 0, form, _q.Queue()))
                count += 1
                add_admin_alert("reconciliation", f"Order {order_id}: paid but bot not created after {PAYMENT_RECONCILIATION_STALE_MIN} min; creation re-queued.")
        except Exception as e:
            logger.warning("Payment reconciliation enqueue failed for order %s: %s", order_id, e)
            add_admin_alert("reconciliation_failed", f"Order {order_id}: re-queue failed: {e}")
    return count


async def daily_orders_cleanup_worker() -> None:
    """Once per day, remove old expired/cancelled orders (48h+ old, no bot) to keep orders.json bounded."""
    if not config.SHOP_BOT_TOKEN:
        return
    while True:
        await asyncio.sleep(DAILY_CLEANUP_INTERVAL_SEC)
        try:
            removed = await asyncio.to_thread(cleanup_old_expired_cancelled_orders, 48)
            if removed:
                logger.info("Daily orders cleanup: removed %s old expired/cancelled orders", removed)
        except Exception as e:
            logger.warning("Daily orders cleanup error: %s", e)


async def daily_supported_currencies_sync_worker() -> None:
    """Once per day, GET /v1/currencies and save to data/now_supported.json for invoice validation."""
    if not config.SHOP_BOT_TOKEN:
        return
    while True:
        await asyncio.sleep(DAILY_CURRENCIES_SYNC_INTERVAL_SEC)
        try:
            ok = await asyncio.to_thread(fetch_supported_currencies)
            if ok:
                logger.info("Daily supported currencies sync completed")
        except Exception as e:
            logger.warning("Daily supported currencies sync error: %s", e)
