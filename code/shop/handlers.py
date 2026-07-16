"""
Shop Bot PTB handlers: /start, Buy AdBot flow, payment, renewal, FAQ, Support.
Run as separate Application with SHOP_BOT_TOKEN.
"""
import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import Any

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

from .. import config
from ..admin_ptb import submit_create_job
from ..maintenance import (
    MAINTENANCE_MESSAGE,
    add_to_maintenance_queue,
    is_maintenance_enabled,
)
from ..ui.emoji_entities import build_emoji_message, build_emoji_bold_message
from ..utils import load_adbot, validate_bot_token
from .workers import (
    STEP5_MESSAGE,
    STEP6_MESSAGE,
    CREATION_PROGRESS_MESSAGE,
    QUEUE_EDIT_MESSAGE,
    build_payment_confirmation_screen,
)
from .storage import (
    load_plans,
    get_order,
    update_order_status,
    update_order,
    create_order,
    create_renewal_order,
    orders_pending_creation,
    orders_by_user,
    get_order_by_user_and_awaiting,
    get_active_pending_order_for_user,
    get_active_pending_source,
    temppay_add,
    temppay_remove_by_user_id,
)
from .payment import create_invoice, check_payment_status
from .renewals import resolve_renewal_price

logger = logging.getLogger(__name__)

# Terms link shown under the order summary (as a TEXT_LINK entity, not markdown).
TERMS_URL = "https://t.me/HQAdzTOS/3"

# User state: {user_id: {"step": str, "order_id": str, "data": dict}}
_shop_state: dict[int, dict[str, Any]] = {}

# Main crypto grid: row1 BTC/ETH/XMR, row2 USDT/USDC/LTC, row3 More
# Internal codes (SUPPORTED_PAY_CURRENCIES keys) for main grid single-coin buttons
CRYPTO_MAIN_SINGLE = ["BTC", "ETH", "XMR", "LTC"]
# Stablecoins: show network selection; networks per coin (label, suffix for internal code)
USDT_NETWORKS = [("TRC-20", "TRC20"), ("BEP-20", "BEP20"), ("ERC-20", "ERC20"), ("SOL", "SOL"), ("ARB", "ARB")]
USDC_NETWORKS = [("BEP-20", "BEP20"), ("ERC-20", "ERC20"), ("SOL", "SOL"), ("MATIC", "MATIC"), ("ARB", "ARB")]
# More currencies: (button label, internal code)
MORE_CURRENCIES = [
    ("TRX", "TRX"),
    ("BNB", "BNB"),
    ("XRP", "XRP"),
    ("SOL", "SOL"),
    ("MATIC", "MATIC"),
    ("TON", "TON"),
]

# User-friendly names for payment messages (internal code or provider code → display name)
CRYPTO_DISPLAY_NAMES = {
    "btc": "Bitcoin", "BTC": "Bitcoin",
    "eth": "Ethereum", "ETH": "Ethereum",
    "ltc": "Litecoin", "LTC": "Litecoin",
    "xmr": "Monero", "XMR": "Monero",
    "trx": "TRON", "TRX": "TRON",
    "bnb": "BNB Chain", "BNB": "BNB Chain",
    "doge": "Dogecoin", "DOGE": "Dogecoin",
    "xrp": "Ripple", "XRP": "Ripple",
    "sol": "Solana", "SOL": "Solana",
    "matic": "Polygon", "MATIC": "Polygon",
    "ada": "Cardano", "ADA": "Cardano",
    "ton": "TON ", "TON": "TON",
    "usdttrc20": "USDT TRC20", "usdt_trc20": "USDT TRC20",
    "usdtbsc": "USDT BEP20", "usdt_bep20": "USDT BEP20",
    "usdterc20": "USDT ERC20", "usdt_erc20": "USDT ERC20",
    "usdtsol": "USDT SOL", "usdt_sol": "USDT SOL",
    "usdtarb": "USDT ARB", "usdt_arb": "USDT ARB",
    "usdcbsc": "USDC BEP20", "usdc_bep20": "USDC BEP20",
    "usdcerc20": "USDC ERC20", "usdc_erc20": "USDC ERC20",
    "usdcsol": "USDC SOL", "usdc_sol": "USDC SOL",
    "usdcmatic": "USDC MATIC", "usdc_matic": "USDC MATIC",
    "usdcarb": "USDC ARB", "usdc_arb": "USDC ARB",
}


def _crypto_display_name(currency_code: str) -> str:
    """Return user-friendly name for a currency code (e.g. btc → Bitcoin, usdttrc20 → USDT (TRC-20))."""
    if not currency_code:
        return currency_code or ""
    key = str(currency_code).strip().lower()
    return CRYPTO_DISPLAY_NAMES.get(key, key.upper())


def _invoice_expiry_hours(invoice: dict) -> tuple[int, str]:
    """
    Compute expiry in hours from invoice_expires_at - now.
    Returns (expiry_hours, display_str) e.g. (12, "12 hours"). Never "a limited time".
    Orders are always 12h; fallback to "12 hours" if missing/failed parse.
    """
    raw_at = (invoice.get("invoice_expires_at") or "").strip()
    if not raw_at:
        return 12, "12 hours"
    try:
        s = raw_at.replace("Z", "").strip()
        if "." in s:
            s = s.split(".")[0]
        expires = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
        now = datetime.utcnow()
        delta_sec = (expires - now).total_seconds()
        expiry_hours = max(0, round(delta_sec / 3600))
        if expiry_hours == 0:
            return 12, "12 hours"
        if expiry_hours == 1:
            return 1, "1 hour"
        return expiry_hours, f"{expiry_hours} hours"
    except ValueError:
        return 12, "12 hours"


def build_invoice_message(plan_name, duration_days, amount_usd, invoice, currency):
    """Invoice as plain text + an explicit entity list (bold/code/custom emoji), NO parse_mode.
    Telegram drops entities when parse_mode is also set, so custom emoji only survive this way.
    Custom emoji: 👛 header + 🕖 validity. Returns (text, entities)."""
    from telegram import MessageEntity
    from ..ui.emojis import CUSTOM_EMOJIS
    from ..ui.emoji_entities import fallback_glyph, u16len
    pay_amount = invoice.get("pay_amount")
    pay_currency_raw = (currency or invoice.get("pay_currency") or "").strip()
    pay_currency_display = _crypto_display_name(pay_currency_raw)
    pay_address = (invoice.get("pay_address") or "").strip() or "(check payment link)"
    amount_num = f"{pay_amount}" if pay_amount is not None else f"{amount_usd:.2f}"

    parts: list[str] = []
    entities: list = []
    u16 = 0

    def emit(s):
        nonlocal u16
        parts.append(s)
        u16 += u16len(s)

    def emit_entity(s, etype):
        nonlocal u16
        start = u16
        emit(s)
        entities.append(MessageEntity(type=etype, offset=start, length=u16 - start))

    def emit_emoji(key):
        nonlocal u16
        glyph = fallback_glyph(key)
        if key in CUSTOM_EMOJIS:
            entities.append(MessageEntity(
                type=MessageEntity.CUSTOM_EMOJI, offset=u16, length=u16len(glyph),
                custom_emoji_id=CUSTOM_EMOJIS[key]))
        emit(glyph)

    emit_emoji("invoice_wallet")
    emit(" ")
    emit_entity("Complete Your Payment", MessageEntity.BOLD)
    emit("\n\n")
    emit_entity("Plan:", MessageEntity.BOLD)
    emit(f" {plan_name}\n")
    emit_entity("Validity:", MessageEntity.BOLD)
    emit(f" {duration_days} days\n")
    emit_entity("Amount:", MessageEntity.BOLD)
    emit(f" ${amount_usd:.2f}\n\n")
    emit("Send exactly ")
    emit_entity(amount_num, MessageEntity.CODE)
    emit(f" {pay_currency_display}\n\n")
    emit("to this address:\n\n")
    emit_entity(pay_address, MessageEntity.CODE)
    emit("\n\n")
    emit_emoji("invoice_clock")
    emit(" Valid for ")
    emit_entity("12 hours", MessageEntity.BOLD)
    emit(". After that, create a new order if needed.\n\n")
    emit("When the transaction is confirmed, you will receive the next step here.")
    return "".join(parts), entities


def _build_plans_screen(mode: str, plan_list: list) -> tuple[str, list]:
    """Premium plans list: title emoji + one per-tier emoji per plan + trailing pointer.
    Builds MessageEntity offsets in UTF-16 code units (no parse_mode)."""
    from telegram import MessageEntity
    from ..ui.emojis import CUSTOM_EMOJIS
    from ..ui.emoji_entities import fallback_glyph, u16len
    is_ent = mode == "enterprise"
    title_key = "title_enterprise" if is_ent else "title_starter"
    mode_label = "Enterprise" if is_ent else "Starter"
    parts: list[str] = []
    entities: list = []
    u16 = 0

    def emit(s: str) -> None:
        nonlocal u16
        parts.append(s)
        u16 += u16len(s)

    def emit_emoji(key: str) -> None:
        nonlocal u16
        glyph = fallback_glyph(key)
        if key in CUSTOM_EMOJIS:
            entities.append(MessageEntity(
                type=MessageEntity.CUSTOM_EMOJI, offset=u16, length=u16len(glyph),
                custom_emoji_id=CUSTOM_EMOJIS[key],
            ))
        emit(glyph)

    emit_emoji(title_key)
    emit(f" Choose Your {mode_label} Plan\n")
    emit("______________________________\n\n")
    for p in plan_list:
        sid = (p.get("id") or "").strip()
        name = sid.title()
        sessions = int(p.get("sessions", 0))
        pw = float(p.get("price_week", 0))
        pmo = float(p.get("price_month", 0))
        tier_key = f"tier_{sid.lower()}"
        if tier_key in CUSTOM_EMOJIS:
            emit_emoji(tier_key)
            emit(" ")
        emit(f"{name} • {sessions} Sessions\n")
        emit(f"${pw:.0f}/wk • ${pmo:.0f}/mo\n\n")
    emit("Choose a plan ")
    emit_emoji("choose_pointer")
    return "".join(parts), entities


def _clear_shop_state(user_id: int) -> None:
    _shop_state.pop(user_id, None)


def _payment_summary_message(st: dict) -> tuple[str, list]:
    """Payment summary as plain text + explicit entities (bold labels, Terms as a TEXT_LINK,
    leading plan_info emoji) — NO parse_mode, so custom emoji + link survive together."""
    from telegram import MessageEntity
    from ..ui.emojis import CUSTOM_EMOJIS
    from ..ui.emoji_entities import fallback_glyph, u16len
    amount = st.get("amount_usd", 0)
    plan_id = (st.get("plan_id") or "").title()
    mode = (st.get("mode") or "starter").title()
    plan_display = f"{plan_id} ({mode})" if plan_id else mode

    parts: list[str] = []
    entities: list = []
    u16 = 0

    def emit(s):
        nonlocal u16
        parts.append(s)
        u16 += u16len(s)

    def emit_entity(s, etype, **kw):
        nonlocal u16
        start = u16
        emit(s)
        entities.append(MessageEntity(type=etype, offset=start, length=u16 - start, **kw))

    def emit_emoji(key):
        nonlocal u16
        glyph = fallback_glyph(key)
        if key in CUSTOM_EMOJIS:
            entities.append(MessageEntity(
                type=MessageEntity.CUSTOM_EMOJI, offset=u16, length=u16len(glyph),
                custom_emoji_id=CUSTOM_EMOJIS[key]))
        emit(glyph)

    emit_emoji("plan_info")
    emit(" ")
    emit_entity("Plan:", MessageEntity.BOLD)
    emit(f" {plan_display}\n")
    emit_entity("Amount:", MessageEntity.BOLD)
    emit(f" ${amount:.2f}\n\n")
    emit("By proceeding with this purchase, you agree to our ")
    emit_entity("Terms and Conditions", MessageEntity.TEXT_LINK, url=TERMS_URL)
    emit(".\n\n")
    emit("Choose a coin to pay with:")
    return "".join(parts), entities


def _coin_button(code: str, callback_data: str, label: str | None = None) -> InlineKeyboardButton:
    """Coin/network button. Verified live against the Bot API: InlineKeyboardButton supports
    icon_custom_emoji_id (accepted + echoed by Telegram; unknown fields are stripped). PTB 21.7
    has no native param, so we inject it via api_kwargs (serialized into the request). Coins with a
    custom emoji show the premium icon (clean text); coins without one fall back to a Unicode symbol."""
    from ..ui.emojis import coin_emoji_id, coin_symbol
    txt = label if label is not None else code.upper()
    eid = coin_emoji_id(code)
    if eid:
        return InlineKeyboardButton(txt, callback_data=callback_data, api_kwargs={"icon_custom_emoji_id": eid})
    sym = coin_symbol(code)
    return InlineKeyboardButton(f"{sym} {txt}" if sym else txt, callback_data=callback_data)


def _payment_crypto_keyboard(st: dict) -> InlineKeyboardMarkup:
    """Main crypto grid: [BTC][ETH][XMR], [USDT][USDC][LTC], [More], [Back]. Uses internal codes."""
    plan_id = st.get("plan_id", "")
    mode = st.get("mode", "starter")
    back_data = f"shop_plan_detail:{mode}:{plan_id}"
    rows = [
        [
            _coin_button("BTC", "shop_crypto:BTC"),
            _coin_button("ETH", "shop_crypto:ETH"),
            _coin_button("XMR", "shop_crypto:XMR"),
        ],
        [
            _coin_button("USDT", "shop_crypto_network:usdt"),
            _coin_button("USDC", "shop_crypto_network:usdc"),
            _coin_button("LTC", "shop_crypto:LTC"),
        ],
        [InlineKeyboardButton("More", callback_data="shop_more_crypto")],
        [InlineKeyboardButton("Back", callback_data=back_data)],
    ]
    return InlineKeyboardMarkup(rows)


def clear_pending_payment_state(user_id: int) -> None:
    """Clear in-memory shop state for user (e.g. after order expired). Call from workers."""
    _clear_shop_state(user_id)


def _support_button() -> InlineKeyboardButton:
    """Support: tg://user?id=SUPPORT_CHAT_ID when set (no intermediate message); else callback shop_support."""
    support_id = getattr(config, "SUPPORT_CHAT_ID", 0) or getattr(config, "SUPPORT_USER_ID", 0) or 0
    if support_id:
        return InlineKeyboardButton("Support", url=f"tg://user?id={support_id}")
    return InlineKeyboardButton("Support", callback_data="shop_support")


def _start_menu_keyboard() -> InlineKeyboardMarkup:
    """Main /start menu: Row1 Buy AdBot, Row2 FAQ, Row3 My Bots | Support. Reusable keyboard builder."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("Buy AdBot", callback_data="shop_buy")],
        [InlineKeyboardButton("FAQ", callback_data="shop_faq")],
        [InlineKeyboardButton("My Bots", callback_data="shop_my_bots"), _support_button()],
    ])


def _main_menu_keyboard() -> InlineKeyboardMarkup:
    """Same as start menu; used after back/cancel so all menus stay consistent."""
    return _start_menu_keyboard()


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Show main menu unless user has active unpaid invoice; then show /cancel message only (no menu)."""
    if not update.effective_user:
        return
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id if update.effective_chat else user_id
    try:
        from ..broadcast_users import add_all_user
        add_all_user(user_id)
    except Exception:
        pass
    if is_maintenance_enabled():
        add_to_maintenance_queue(user_id, chat_id)
        await update.message.reply_text(MAINTENANCE_MESSAGE)
        return
    pending = get_active_pending_order_for_user(user_id)
    if pending:
        await update.message.reply_text(
            "You already have an open invoice. Finish that payment, or use /cancel to start fresh.",
        )
        return

    # Resume a PAID order whose setup wasn't finished, so a buyer who paid then closed
    # the app can always pick up where they left off (these orders have no bot_token yet,
    # so the reconciliation sweep can't recover them — only the buyer can).
    resume = (
        get_order_by_user_and_awaiting(user_id, "paid", "proceed")
        or get_order_by_user_and_awaiting(user_id, "paid", "name")
        or get_order_by_user_and_awaiting(user_id, "paid", "token")
    )
    if resume:
        order_id = resume.get("order_id", "")
        awaiting = resume.get("awaiting_field")
        if awaiting == "proceed":
            conf_text, conf_ent, conf_rm = build_payment_confirmation_screen(resume, None)
            await update.message.reply_text(
                conf_text, reply_markup=conf_rm, entities=conf_ent, disable_web_page_preview=True
            )
            _clear_shop_state(user_id)
            return
        if awaiting == "name":
            _clear_shop_state(user_id)
            _shop_state[user_id] = {"step": "enter_name", "order_id": order_id, "data": {}}
            r_text, r_ent = build_emoji_message(STEP5_MESSAGE, "pointer")
            await update.message.reply_text(r_text, entities=r_ent)
            return
        if awaiting == "token":
            _clear_shop_state(user_id)
            _shop_state[user_id] = {
                "step": "enter_token", "order_id": order_id,
                "bot_name": resume.get("bot_name", "AdBot"), "data": {},
            }
            await update.message.reply_text("Send your bot token to finish setup.")
            return

    _clear_shop_state(user_id)
    text, entities = build_emoji_message("Welcome to HQAdz.\nWhat would you like to do?", "wave")
    await update.message.reply_text(
        text,
        reply_markup=_start_menu_keyboard(),
        entities=entities,
    )


# Cancelled payment message: edit the payment address message to this (declined custom emoji).
CANCELLED_PAYMENT_MESSAGE = (
    "Order cancelled.\n\n"
    "Nothing was charged. Start a new order anytime with /start."
)


async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Cancel pending payment: stop polling (remove from temppay or mark order cancelled), edit payment message, clear state, show main menu."""
    if not update.effective_user:
        return
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id if update.effective_chat else user_id
    if is_maintenance_enabled():
        add_to_maintenance_queue(user_id, chat_id)
        await update.message.reply_text(MAINTENANCE_MESSAGE)
        return
    pending = get_active_pending_order_for_user(user_id)
    if not pending:
        await update.message.reply_text(
            "No open invoice to cancel.",
            reply_markup=_main_menu_keyboard(),
        )
        return
    source = get_active_pending_source(user_id)
    if source == "temppay":
        temppay_remove_by_user_id(user_id)
    else:
        order_id = pending.get("order_id", "")
        update_order(order_id, {"status": "cancelled"})
    _clear_shop_state(user_id)
    chat_id = pending.get("payment_chat_id") or 0
    msg_id = pending.get("payment_message_id") or 0
    if chat_id and msg_id and update.message and context.bot:
        cancel_text, entities = build_emoji_message(CANCELLED_PAYMENT_MESSAGE, "declined")
        try:
            await context.bot.edit_message_text(
                chat_id=chat_id,
                message_id=msg_id,
                text=cancel_text,
                entities=entities,
                reply_markup=InlineKeyboardMarkup([]),
            )
        except Exception as e:
            logger.debug("Could not edit payment message on cancel: %s", e)
    text, entities = build_emoji_message("Welcome to HQAdz.\nWhat would you like to do?", "wave")
    await update.message.reply_text(
        text,
        reply_markup=_main_menu_keyboard(),
        entities=entities,
    )


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data:
        return
    await q.answer()
    user_id = update.effective_user.id if update.effective_user else 0
    chat_id = update.effective_chat.id if update.effective_chat else user_id
    if is_maintenance_enabled():
        add_to_maintenance_queue(user_id, chat_id)
        try:
            await q.edit_message_text(MAINTENANCE_MESSAGE)
        except Exception:
            await context.bot.send_message(chat_id=chat_id, text=MAINTENANCE_MESSAGE)
        return
    raw = q.data

    if raw and raw.startswith("shop_proceed_setup:"):
        order_id = (raw.split(":", 1)[1] or "").strip()
        order = get_order(order_id) if order_id else None
        if not order or order.get("user_id") != user_id or order.get("status") != "paid":
            await q.answer("That order's already been handled.", show_alert=True)
            return
        if order.get("awaiting_field") not in ("proceed", "name"):
            await q.answer("Already setting up — one moment.", show_alert=False)
            return
        update_order(order_id, {"awaiting_field": "name"})
        try:
            await q.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass
        text, entities = build_emoji_message(STEP5_MESSAGE, "pointer")
        await context.bot.send_message(chat_id=chat_id, text=text, entities=entities)
        _clear_shop_state(user_id)
        st = {"step": "enter_name", "order_id": order_id, "data": {}}
        _shop_state[user_id] = st
        logger.info("[CREATE_PIPELINE] Proceed pressed order_id=%s; wizard started (name→token)", order_id)
        return

    if raw == "shop_buy":
        _clear_shop_state(user_id)
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Starter Plans", callback_data="shop_category:starter")],
            [InlineKeyboardButton("Enterprise Plans", callback_data="shop_category:enterprise")],
        ])
        text, entities = build_emoji_message("Choose your track.\nStarter for individuals — Enterprise for scale.", "plans")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    if raw == "shop_faq":
        faq_text, faq_entities = build_emoji_message("Quick answers before you buy.", "pointer")
        await q.edit_message_text(
            faq_text,
            entities=faq_entities,
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("How to Buy", callback_data="shop_how")],
                [InlineKeyboardButton("How it Works", callback_data="shop_faq_how_it_works")],
                [InlineKeyboardButton("Free Replacement", callback_data="shop_faq_replacement")],
                [InlineKeyboardButton("Back", callback_data="shop_back")],
            ]),
        )
        return

    if raw == "shop_how":
        how = (
            "How buying works:\n\n"
            "1. Buy AdBot — pick a category and plan\n"
            "2. Choose weekly or monthly billing\n"
            "3. Pay in crypto to the address we generate\n"
            "4. Name your bot once payment confirms\n"
            "5. We build it and send your access link here\n\n"
            "Check validity anytime via My Bots."
        )
        how_text, how_entities = build_emoji_message(how, "pointer")
        await q.edit_message_text(
            how_text,
            entities=how_entities,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_faq")]]),
        )
        return

    if raw == "shop_faq_how_it_works":
        msg = (
            "We place your ad in high-reach, niche-targeted Telegram marketplace groups "
            "to maximize visibility and engagement."
        )
        hiw_text, hiw_entities = build_emoji_message(msg, "pointer")
        await q.edit_message_text(
            hiw_text,
            entities=hiw_entities,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_faq")]]),
        )
        return

    if raw == "shop_faq_replacement":
        msg = (
            "One free swap for banned accounts in your plan.\n"
            "If multiple accounts go down together, they're replaced together.\n\n"
            "Included with:\n"
            "• Starter — monthly plans only\n"
            "• Enterprise — all plans"
        )
        fr_text, fr_entities = build_emoji_message(msg, "pointer")
        await q.edit_message_text(
            fr_text,
            entities=fr_entities,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_faq")]]),
        )
        return

    if raw == "shop_my_bots":
        from ..utils import get_name_by_token, load_user_data
        orders = orders_by_user(user_id)
        completed = [o for o in orders if o.get("status") == "completed" and (o.get("bot_token") or "").strip()]
        lines = []
        for o in completed:
            bot_token = (o.get("bot_token") or "").strip()
            username = (o.get("created_bot_username") or "").strip() or ""
            if not username and bot_token:
                name = get_name_by_token(bot_token)
                cfg = load_user_data(name) if name else {}
                username = (cfg.get("bot_username") or "").strip()
            if not username:
                username = "@?"
            if not username.startswith("@"):
                username = "@" + username
            valid_till = ""
            if bot_token:
                name = get_name_by_token(bot_token)
                cfg = load_user_data(name) if name else {}
                valid_till = (cfg.get("valid_till") or "").strip() or "—"
            else:
                valid_till = "—"
            lines.append(f"{username}\nValid until: {valid_till}")
        if not lines:
            body = "No active bots yet — tap Buy AdBot to get started."
        else:
            body = "\n\n".join(lines)
        mb_text, mb_entities = build_emoji_message(body, "plan_info")
        await q.edit_message_text(
            mb_text,
            entities=mb_entities,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_back")]]),
        )
        return

    if raw == "shop_support":
        # Fallback when SUPPORT_CHAT_ID/SUPPORT_USER_ID not set: show contact info and direct link if we have one
        support_id = getattr(config, "SUPPORT_CHAT_ID", 0) or getattr(config, "SUPPORT_USER_ID", 0) or 0
        contact = getattr(config, "ADMIN_CONTACT", "admin")
        if support_id:
            sup_text, sup_entities = build_emoji_message("Need a hand? Tap below to message support directly.", "pointer")
            await q.edit_message_text(
                sup_text,
                entities=sup_entities,
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Contact Support", url=f"tg://user?id={support_id}")],
                    [InlineKeyboardButton("Back", callback_data="shop_back")],
                ]),
            )
        else:
            sup_text, sup_entities = build_emoji_message(f"Need a hand? Reach us at @{contact}.", "pointer")
            await q.edit_message_text(
                sup_text,
                entities=sup_entities,
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_back")]]),
            )
        return

    if raw == "shop_website":
        website_url = getattr(config, "WEBSITE_URL", "") or ""
        if website_url:
            return
        await q.edit_message_text(
            "Website link is not configured.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_back")]]),
        )
        return

    if raw == "shop_back":
        text, entities = build_emoji_message("Welcome to HQAdz.\nWhat would you like to do?", "wave")
        await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
        return

    # Step 1 → Step 2: category selected → compact plan list (marketing-style, 2-col buttons)
    if raw.startswith("shop_category:"):
        mode = raw.split(":", 1)[1].lower()
        plans = load_plans()
        plan_list = plans.get(mode, [])
        if not plan_list:
            await q.edit_message_text("Nothing available in this category right now.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_list", "mode": mode, "data": {}}
        text, entities = _build_plans_screen(mode, plan_list)
        # 2-column button grid: pairs of plans, then Back
        rows = []
        for i in range(0, len(plan_list), 2):
            pair = [
                InlineKeyboardButton(plan_list[i].get("id", "").title(), callback_data=f"shop_plan:{plan_list[i].get('id', '')}")
            ]
            if i + 1 < len(plan_list):
                pair.append(InlineKeyboardButton(plan_list[i + 1].get("id", "").title(), callback_data=f"shop_plan:{plan_list[i + 1].get('id', '')}"))
            rows.append(pair)
        rows.append([InlineKeyboardButton("Back", callback_data="shop_buy")])
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
        return

    # Step 2 → Step 3: plan selected → minimal plan detail (no cycle/gap), buttons with price
    if raw.startswith("shop_plan:"):
        plan_id = raw.split(":", 1)[1].lower()
        st = _shop_state.get(user_id)
        mode = st.get("mode", "starter") if st else "starter"
        plans = load_plans()
        plan_list = plans.get(mode, [])
        plan = next((p for p in plan_list if p.get("id") == plan_id), None)
        if not plan:
            await q.edit_message_text("That plan's no longer available.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_detail", "mode": mode, "plan": plan, "plan_id": plan_id, "data": {}}
        pw = float(plan.get("price_week", 0))
        pm = float(plan.get("price_month", 0))
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(f"Weekly | ${pw:.0f}", callback_data=f"shop_buy:{plan_id}:7"),
                InlineKeyboardButton(f"Monthly | ${pm:.0f}", callback_data=f"shop_buy:{plan_id}:30"),
            ],
            [InlineKeyboardButton("Back", callback_data=f"shop_category:{mode}")],
        ])
        text, entities = build_emoji_bold_message("billing", f"{plan_id.title()} Plan", "\n\nSelect a plan duration:", sep="")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    # Back from crypto to plan detail (Step 3) — same minimal layout
    if raw.startswith("shop_plan_detail:"):
        parts = raw.split(":", 2)
        if len(parts) < 3:
            return
        mode, plan_id = parts[1].lower(), parts[2].lower()
        plans = load_plans()
        plan_list = plans.get(mode, [])
        plan = next((p for p in plan_list if p.get("id") == plan_id), None)
        if not plan:
            await q.edit_message_text("That plan's no longer available.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_detail", "mode": mode, "plan": plan, "plan_id": plan_id, "data": {}}
        pw = float(plan.get("price_week", 0))
        pm = float(plan.get("price_month", 0))
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(f"Weekly | ${pw:.0f}", callback_data=f"shop_buy:{plan_id}:7"),
                InlineKeyboardButton(f"Monthly | ${pm:.0f}", callback_data=f"shop_buy:{plan_id}:30"),
            ],
            [InlineKeyboardButton("Back", callback_data=f"shop_category:{mode}")],
        ])
        text, entities = build_emoji_bold_message("billing", f"{plan_id.title()} Plan", "\n\nSelect a plan duration:", sep="")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    # Step 3 → crypto: Buy Weekly / Buy Monthly
    if raw.startswith("shop_buy:"):
        parts = raw.split(":")
        if len(parts) < 3:
            return
        plan_id = parts[1].lower()
        dur_s = parts[2]
        duration_days = int(dur_s) if dur_s.isdigit() else (30 if dur_s == "30" else 7)
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "plan_detail":
            await q.edit_message_text("Session expired — send /start to begin again.", reply_markup=_main_menu_keyboard())
            return
        plan = st.get("plan", {})
        if plan.get("id") != plan_id:
            plan_list = load_plans().get(st.get("mode", "starter"), [])
            plan = next((p for p in plan_list if p.get("id") == plan_id), plan)
        price_week = float(plan.get("price_week", 0))
        price_month = float(plan.get("price_month", 0))
        amount = price_month if duration_days >= 30 else price_week
        st["step"] = "crypto"
        st["plan"] = plan
        st["plan_id"] = plan_id
        st["duration_days"] = duration_days
        st["amount_usd"] = amount
        _shop_state[user_id] = st
        text, entities = _payment_summary_message(st)
        await q.edit_message_text(
            text,
            reply_markup=_payment_crypto_keyboard(st),
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    if raw.startswith("shop_renew:"):
        parent_order_id = raw.split(":", 1)[1]
        order = get_order(parent_order_id)
        if not order or order.get("status") != "completed":
            await q.edit_message_text("Can't find that order — check My Bots.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "renewal_duration", "parent_order_id": parent_order_id, "data": {}}
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("7 Days", callback_data=f"shop_renew_dur:{parent_order_id}:7")],
            [InlineKeyboardButton("30 Days", callback_data=f"shop_renew_dur:{parent_order_id}:30")],
            [InlineKeyboardButton("Back", callback_data="shop_back")],
        ])
        text, entities = build_emoji_message("Renewing your AdBot.\nPick a duration:", "billing")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    if raw.startswith("shop_renew_dur:"):
        parts = raw.split(":", 3)
        if len(parts) < 3:
            return
        parent_order_id = parts[1]
        duration_days = int(parts[2]) if parts[2].isdigit() else 7
        order = get_order(parent_order_id)
        if not order:
            await q.edit_message_text("Can't find that order — check My Bots.", reply_markup=_main_menu_keyboard())
            return
        from ..utils import get_name_by_token, load_user_data
        bot_token = order.get("bot_token")
        name = get_name_by_token(bot_token) if bot_token else None
        cfg = load_user_data(name) if name else None
        try:
            price = resolve_renewal_price(cfg or {}, duration_days)
            amount = float(price["amount"])
        except Exception:
            amount = 0.0
        _shop_state[user_id] = {"step": "renewal_crypto", "parent_order_id": parent_order_id, "duration_days": duration_days, "amount_usd": amount, "data": {}}
        keyboard = InlineKeyboardMarkup([
            [_coin_button("BTC", f"shop_renew_crypto:{parent_order_id}:{duration_days}:BTC"), _coin_button("ETH", f"shop_renew_crypto:{parent_order_id}:{duration_days}:ETH")],
            [_coin_button("USDT", f"shop_renew_network:{parent_order_id}:{duration_days}:usdt"), _coin_button("USDC", f"shop_renew_network:{parent_order_id}:{duration_days}:usdc")],
            [InlineKeyboardButton("Back", callback_data=f"shop_renew:{parent_order_id}")],
        ])
        msg = f"Renewal total: ${amount:.2f}\nChoose a coin to pay with:"
        text, entities = build_emoji_message(msg, "payment")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    # Renewal: USDT/USDC → show network selection (shop_renew_network:parent:days:usdt then :usdt:trc20)
    if raw.startswith("shop_renew_network:"):
        parts = raw.split(":", 5)
        if len(parts) < 4:
            return
        parent_order_id, duration_days_s, coin = parts[1], parts[2], (parts[3] or "usdt").lower()
        duration_days = int(duration_days_s) if duration_days_s.isdigit() else 7
        parent = get_order(parent_order_id)
        if not parent:
            await q.edit_message_text("Can't find that order — check My Bots.", reply_markup=_main_menu_keyboard())
            return
        if len(parts) == 4:
            # Show network selection for USDT/USDC
            networks = USDT_NETWORKS if coin == "usdt" else USDC_NETWORKS
            rows = []
            for i in range(0, len(networks), 2):
                pair = [_coin_button(networks[i][1], f"shop_renew_network:{parent_order_id}:{duration_days}:{coin}:{networks[i][1].lower()}", networks[i][0])]
                if i + 1 < len(networks):
                    pair.append(_coin_button(networks[i + 1][1], f"shop_renew_network:{parent_order_id}:{duration_days}:{coin}:{networks[i + 1][1].lower()}", networks[i + 1][0]))
                rows.append(pair)
            rows.append([InlineKeyboardButton("Back", callback_data=f"shop_renew:{parent_order_id}")])
            label = "USDT" if coin == "usdt" else "USDC"
            text, entities = build_emoji_message(f"Renewal — {label}\nPick a network:", "payment")
            await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
            return
        network = (parts[4] or "").strip().upper()
        internal_code = f"{coin.upper()}_{network}"
        from ..utils import get_name_by_token, load_user_data
        name = get_name_by_token(parent.get("bot_token") or "")
        cfg = load_user_data(name) if name else {}
        try:
            price = resolve_renewal_price(cfg or {}, duration_days)
            amount = float(price["amount"])
        except Exception:
            text, entities = build_emoji_message("This renewal duration is unavailable for your plan. Please contact support.", "failed")
            await q.edit_message_text(text, entities=entities)
            return
        rev_order = create_renewal_order(
            parent_order_id=parent_order_id,
            user_id=user_id,
            duration_days=duration_days,
            amount_usd=amount,
            payment_id="",
            currency=internal_code,
            invoice_url=None,
            bot_token=(parent.get("bot_token") or "").strip(),
            bot_name=(cfg or {}).get("name", ""),
            plan_id=(cfg or {}).get("plan_name") or ((cfg or {}).get("plan") or {}).get("name") or "",
            plan_name=(cfg or {}).get("plan_name") or ((cfg or {}).get("plan") or {}).get("name") or "",
            plan_mode=(cfg or {}).get("mode") or (cfg or {}).get("plan_mode") or "",
            fiat_currency=price["currency"],
            pricing_source=price["pricing_source"],
            old_valid_till=(cfg or {}).get("valid_till") or "",
            new_valid_till_preview=price["new_valid_till_preview"],
        )
        if getattr(config, "PAYMENT_DEV_MODE", False):
            from .workers import extend_valid_till_for_bot
            now = datetime.utcnow().isoformat() + "Z"
            parent_token = (parent.get("bot_token") or "").strip()
            if parent_token and extend_valid_till_for_bot(parent_token, duration_days, rev_order.get("order_id", ""), order=rev_order, details={"pay_currency": internal_code}):
                # State machine requires payment_waiting → paid → completed (no direct jump).
                update_order_status(rev_order["order_id"], "paid", paid_at=now)
                update_order_status(rev_order["order_id"], "completed", paid_at=now)
                try:
                    from ..broadcast_users import add_plan_user
                    add_plan_user(user_id)
                except Exception:
                    pass
                text, entities = build_emoji_message("Renewal confirmed.\n\nYour AdBot's validity has been extended — no further action needed.", "payment_confirmed")
                await q.edit_message_text(text, entities=entities)
            else:
                update_order_status(rev_order["order_id"], "failed")
                text, entities = build_emoji_message("Renewal could not complete — validity was not extended. Please contact support.", "failed")
                await q.edit_message_text(text, entities=entities)
            return
        invoice = create_invoice(amount_usd=amount, currency=internal_code, order_id=rev_order["order_id"], description=f"AdBot renewal {duration_days} days")
        if invoice.get("_invoice_failed"):
            update_order(rev_order["order_id"], {"status": "invoice_failed"})
            msg = "That coin is temporarily unavailable — please pick another." if invoice.get("_reason") == "unavailable" else "Couldn't generate the invoice. Try again, or contact support."
            text, entities = build_emoji_message(msg, "failed")
            await q.edit_message_text(
                text,
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to menu", callback_data="shop_back")]]),
                entities=entities,
            )
            return
        chat_id = q.message.chat_id if q.message else 0
        msg_id = q.message.message_id if q.message else 0
        update_order(rev_order["order_id"], {
            "payment_id": invoice.get("payment_id", ""),
            "invoice_url": invoice.get("invoice_url") or "",
            "pay_address": invoice.get("pay_address") or "",
            "pay_amount": invoice.get("pay_amount"),
            "pay_currency": (invoice.get("pay_currency") or internal_code).upper(),
            "invoice_expiry": invoice.get("invoice_expiry") or "",
            "invoice_expires_at": invoice.get("invoice_expires_at") or "",
            "payment_chat_id": chat_id,
            "payment_message_id": msg_id,
        })
        text, entities = build_invoice_message("Renewal", duration_days, amount, invoice, internal_code)
        await q.edit_message_text(
            text,
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    if raw.startswith("shop_renew_crypto:"):
        parts = raw.split(":", 4)
        if len(parts) < 4:
            return
        parent_order_id, duration_days_s, internal_code = parts[1], parts[2], (parts[3] or "BTC").strip().upper()
        duration_days = int(duration_days_s) if duration_days_s.isdigit() else 7
        parent = get_order(parent_order_id)
        if not parent:
            await q.edit_message_text("Can't find that order — check My Bots.", reply_markup=_main_menu_keyboard())
            return
        from ..utils import get_name_by_token, load_user_data
        name = get_name_by_token(parent.get("bot_token") or "")
        cfg = load_user_data(name) if name else {}
        try:
            price = resolve_renewal_price(cfg or {}, duration_days)
            amount = float(price["amount"])
        except Exception:
            text, entities = build_emoji_message("This renewal duration is unavailable for your plan. Please contact support.", "failed")
            await q.edit_message_text(text, entities=entities)
            return
        rev_order = create_renewal_order(
            parent_order_id=parent_order_id,
            user_id=user_id,
            duration_days=duration_days,
            amount_usd=amount,
            payment_id="",
            currency=internal_code,
            invoice_url=None,
            bot_token=(parent.get("bot_token") or "").strip(),
            bot_name=(cfg or {}).get("name", ""),
            plan_id=(cfg or {}).get("plan_name") or ((cfg or {}).get("plan") or {}).get("name") or "",
            plan_name=(cfg or {}).get("plan_name") or ((cfg or {}).get("plan") or {}).get("name") or "",
            plan_mode=(cfg or {}).get("mode") or (cfg or {}).get("plan_mode") or "",
            fiat_currency=price["currency"],
            pricing_source=price["pricing_source"],
            old_valid_till=(cfg or {}).get("valid_till") or "",
            new_valid_till_preview=price["new_valid_till_preview"],
        )
        if getattr(config, "PAYMENT_DEV_MODE", False):
            from .workers import extend_valid_till_for_bot
            now = datetime.utcnow().isoformat() + "Z"
            parent_token = (parent.get("bot_token") or "").strip()
            if parent_token and extend_valid_till_for_bot(parent_token, duration_days, rev_order.get("order_id", ""), order=rev_order, details={"pay_currency": internal_code}):
                # State machine requires payment_waiting → paid → completed (no direct jump).
                update_order_status(rev_order["order_id"], "paid", paid_at=now)
                update_order_status(rev_order["order_id"], "completed", paid_at=now)
                try:
                    from ..broadcast_users import add_plan_user
                    add_plan_user(user_id)
                except Exception:
                    pass
                text, entities = build_emoji_message("Renewal confirmed.\n\nYour AdBot's validity has been extended — no further action needed.", "payment_confirmed")
                await q.edit_message_text(text, entities=entities)
            else:
                update_order_status(rev_order["order_id"], "failed")
                text, entities = build_emoji_message("Renewal could not complete — validity was not extended. Please contact support.", "failed")
                await q.edit_message_text(text, entities=entities)
            return
        invoice = create_invoice(amount_usd=amount, currency=internal_code, order_id=rev_order["order_id"], description=f"AdBot renewal {duration_days} days")
        if invoice.get("_invoice_failed"):
            update_order(rev_order["order_id"], {"status": "invoice_failed"})
            msg = "That coin is temporarily unavailable — please pick another." if invoice.get("_reason") == "unavailable" else "Couldn't generate the invoice. Try again, or contact support."
            text, entities = build_emoji_message(msg, "failed")
            await q.edit_message_text(
                text,
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to menu", callback_data="shop_back")]]),
                entities=entities,
            )
            return
        chat_id = q.message.chat_id if q.message else 0
        msg_id = q.message.message_id if q.message else 0
        update_order(rev_order["order_id"], {
            "payment_id": invoice.get("payment_id", ""),
            "invoice_url": invoice.get("invoice_url") or "",
            "pay_address": invoice.get("pay_address") or "",
            "pay_amount": invoice.get("pay_amount"),
            "pay_currency": (invoice.get("pay_currency") or internal_code).upper(),
            "invoice_expiry": invoice.get("invoice_expiry") or "",
            "invoice_expires_at": invoice.get("invoice_expires_at") or "",
            "payment_chat_id": chat_id,
            "payment_message_id": msg_id,
        })
        text, entities = build_invoice_message("Renewal", duration_days, amount, invoice, internal_code)
        await q.edit_message_text(
            text,
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    # Back to main crypto selection from More or from network selection
    if raw == "shop_crypto_back":
        st = _shop_state.get(user_id)
        if not st or st.get("step") not in ("crypto", "crypto_network"):
            _t, _e = build_emoji_message("Welcome to HQAdz.\nWhat would you like to do?", "wave")
            await q.edit_message_text(_t, reply_markup=_main_menu_keyboard(), entities=_e)
            return
        st["step"] = "crypto"
        _shop_state[user_id] = st
        text, entities = _payment_summary_message(st)
        await q.edit_message_text(
            text,
            reply_markup=_payment_crypto_keyboard(st),
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    # More currencies screen (TRX, BNB, DOGE, XRP, DAI, MATIC, FDUSD, PYUSD)
    if raw == "shop_more_crypto":
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Session expired — send /start to begin again.", reply_markup=_main_menu_keyboard())
            return
        rows = []
        for i in range(0, len(MORE_CURRENCIES), 2):
            pair = [_coin_button(MORE_CURRENCIES[i][1], f"shop_crypto:{MORE_CURRENCIES[i][1]}", MORE_CURRENCIES[i][0])]
            if i + 1 < len(MORE_CURRENCIES):
                pair.append(_coin_button(MORE_CURRENCIES[i + 1][1], f"shop_crypto:{MORE_CURRENCIES[i + 1][1]}", MORE_CURRENCIES[i + 1][0]))
            rows.append(pair)
        rows.append([InlineKeyboardButton("Back", callback_data="shop_crypto_back")])
        text, entities = build_emoji_message("More coins accepted:", "payment")
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
        return

    # USDT / USDC → network selection (TRC-20, ERC-20, BEP-20, SOL)
    if raw.startswith("shop_crypto_network:"):
        coin = raw.split(":", 1)[1].lower()  # usdt or usdc
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Session expired — send /start to begin again.", reply_markup=_main_menu_keyboard())
            return
        st["step"] = "crypto_network"
        st["network_coin"] = coin
        _shop_state[user_id] = st
        label = "USDT" if coin == "usdt" else "USDC"
        networks = USDT_NETWORKS if coin == "usdt" else USDC_NETWORKS
        rows = []
        for i in range(0, len(networks), 2):
            pair = [
                _coin_button(networks[i][1], f"shop_network:{coin}:{networks[i][1].lower()}", networks[i][0])
            ]
            if i + 1 < len(networks):
                pair.append(_coin_button(
                    networks[i + 1][1], f"shop_network:{coin}:{networks[i + 1][1].lower()}", networks[i + 1][0]
                ))
            rows.append(pair)
        rows.append([InlineKeyboardButton("Back", callback_data="shop_crypto_back")])
        text, entities = build_emoji_bold_message("payment", label, "\n\nPick a network — this sets your deposit address:")
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
        return

    # Chosen stablecoin + network → internal code e.g. USDT_TRC20, USDC_BEP20 (SUPPORTED_PAY_CURRENCIES keys)
    if raw.startswith("shop_network:"):
        parts = raw.split(":", 2)
        if len(parts) < 3:
            return
        coin, network = parts[1].lower(), parts[2].strip().upper()
        st = _shop_state.get(user_id)
        if not st or st.get("step") not in ("crypto", "crypto_network"):
            await q.edit_message_text("Session expired — send /start to begin again.", reply_markup=_main_menu_keyboard())
            return
        if get_active_pending_order_for_user(user_id):
            text, entities = build_emoji_message(
                "You already have an open invoice. Finish that payment, or use /cancel to start fresh.",
                "failed",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        internal_code = f"{coin.upper()}_{network}"
        plan = st.get("plan", {})
        plan_name = f"{plan.get('id', '').title()} ({st.get('mode', '').title()})"
        order_id = str(uuid.uuid4())[:12]
        if getattr(config, "PAYMENT_DEV_MODE", False):
            now = datetime.utcnow().isoformat() + "Z"
            order = create_order(
                user_id=user_id,
                plan_id=st.get("plan_id", ""),
                plan_name=plan_name,
                plan_mode=(st.get("mode") or "starter").strip().capitalize(),
                duration_days=st["duration_days"],
                amount_usd=st["amount_usd"],
                payment_id=f"DEV_{order_id}",
                currency=internal_code,
                invoice_url=None,
            )
            order_id = order["order_id"]
            update_order(order_id, {
                "status": "paid",
                "pay_address": "DEV-MOCK-ADDRESS",
                "pay_amount": 0,
                "pay_currency": internal_code,
                "paid_at": now,
                "awaiting_field": "name",
            })
            st["step"] = "enter_name"
            st["order_id"] = order_id
            _shop_state[user_id] = st
            s5_text, s5_entities = build_emoji_message(STEP5_MESSAGE, "pointer")
            await q.edit_message_text(s5_text, entities=s5_entities)
            return
        invoice = create_invoice(
            amount_usd=st["amount_usd"],
            currency=internal_code,
            order_id=order_id,
            description=f"AdBot {plan_name} {st['duration_days']} days",
        )
        if invoice.get("_invoice_failed"):
            msg = "That coin is temporarily unavailable — please pick another." if invoice.get("_reason") == "unavailable" else "Couldn't generate the invoice. Try again, or contact support."
            text, entities = build_emoji_message(msg, "failed")
            await q.edit_message_text(
                text,
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to menu", callback_data="shop_back")]]),
                entities=entities,
            )
            return
        chat_id = q.message.chat_id if q.message else 0
        msg_id = q.message.message_id if q.message else 0
        now_iso = datetime.utcnow().isoformat() + "Z"
        expiry_at = (invoice.get("invoice_expires_at") or "").strip()
        if not expiry_at:
            try:
                created_dt = datetime.strptime(now_iso.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
                expiry_dt = created_dt + timedelta(hours=12)
                expiry_at = expiry_dt.strftime("%Y-%m-%dT%H:%M:%S") + "Z"
            except Exception:
                expiry_at = now_iso
        temppay_entry = {
            "invoice_id": (invoice.get("payment_id") or "").strip(),
            "user_id": user_id,
            "plan_id": st.get("plan_id", ""),
            "plan_name": plan_name,
            "plan_mode": (st.get("mode") or "starter").strip().capitalize(),
            "duration_days": st["duration_days"],
            "amount": invoice.get("pay_amount"),
            "amount_usd": st["amount_usd"],
            "currency": (invoice.get("pay_currency") or internal_code).strip().upper(),
            "address": (invoice.get("pay_address") or "").strip(),
            "created_at": now_iso,
            "expiry_at": expiry_at,
            "status": "pending",
            "order_id": order_id,
            "payment_chat_id": chat_id,
            "payment_message_id": msg_id,
            "invoice_url": invoice.get("invoice_url") or "",
        }
        if not temppay_add(temppay_entry):
            text, entities = build_emoji_message(
                "You already have an open invoice. Finish that payment, or use /cancel to start fresh.",
                "failed",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        st["step"] = "payment_waiting"
        st["order_id"] = order_id
        _shop_state[user_id] = st
        text, entities = build_invoice_message(plan_name, st["duration_days"], st["amount_usd"], invoice, internal_code)
        await q.edit_message_text(
            text,
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    if raw.startswith("shop_crypto:"):
        internal_code = raw.split(":", 1)[1].strip().upper()
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Session expired — send /start to begin again.", reply_markup=_main_menu_keyboard())
            return
        if get_active_pending_order_for_user(user_id):
            text, entities = build_emoji_message(
                "You already have an open invoice. Finish that payment, or use /cancel to start fresh.",
                "failed",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        plan = st.get("plan", {})
        plan_name = f"{plan.get('id', '').title()} ({st.get('mode', '').title()})"
        order_id = str(uuid.uuid4())[:12]
        if getattr(config, "PAYMENT_DEV_MODE", False):
            now = datetime.utcnow().isoformat() + "Z"
            order = create_order(
                user_id=user_id,
                plan_id=st.get("plan_id", ""),
                plan_name=plan_name,
                plan_mode=(st.get("mode") or "starter").strip().capitalize(),
                duration_days=st["duration_days"],
                amount_usd=st["amount_usd"],
                payment_id=f"DEV_{order_id}",
                currency=internal_code,
                invoice_url=None,
            )
            order_id = order["order_id"]
            update_order(order_id, {
                "status": "paid",
                "pay_address": "DEV-MOCK-ADDRESS",
                "pay_amount": 0,
                "pay_currency": internal_code,
                "paid_at": now,
                "awaiting_field": "proceed",
            })
            o = get_order(order_id)
            conf_text, conf_ent, conf_rm = build_payment_confirmation_screen(o or order, None)
            await q.edit_message_text(
                conf_text, reply_markup=conf_rm, entities=conf_ent,
                disable_web_page_preview=True
            )
            _clear_shop_state(user_id)
            return
        invoice = create_invoice(
            amount_usd=st["amount_usd"],
            currency=internal_code,
            order_id=order_id,
            description=f"AdBot {plan_name} {st['duration_days']} days",
        )
        if invoice.get("_invoice_failed"):
            msg = "That coin is temporarily unavailable — please pick another." if invoice.get("_reason") == "unavailable" else "Couldn't generate the invoice. Try again, or contact support."
            text, entities = build_emoji_message(msg, "failed")
            await q.edit_message_text(
                text,
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back to menu", callback_data="shop_back")]]),
                entities=entities,
            )
            return
        chat_id = q.message.chat_id if q.message else 0
        msg_id = q.message.message_id if q.message else 0
        now_iso = datetime.utcnow().isoformat() + "Z"
        expiry_at = (invoice.get("invoice_expires_at") or "").strip()
        if not expiry_at:
            try:
                created_dt = datetime.strptime(now_iso.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
                expiry_dt = created_dt + timedelta(hours=12)
                expiry_at = expiry_dt.strftime("%Y-%m-%dT%H:%M:%S") + "Z"
            except Exception:
                expiry_at = now_iso
        temppay_entry = {
            "invoice_id": (invoice.get("payment_id") or "").strip(),
            "user_id": user_id,
            "plan_id": st.get("plan_id", ""),
            "plan_name": plan_name,
            "plan_mode": (st.get("mode") or "starter").strip().capitalize(),
            "duration_days": st["duration_days"],
            "amount": invoice.get("pay_amount"),
            "amount_usd": st["amount_usd"],
            "currency": (invoice.get("pay_currency") or internal_code).strip().upper(),
            "address": (invoice.get("pay_address") or "").strip(),
            "created_at": now_iso,
            "expiry_at": expiry_at,
            "status": "pending",
            "order_id": order_id,
            "payment_chat_id": chat_id,
            "payment_message_id": msg_id,
            "invoice_url": invoice.get("invoice_url") or "",
        }
        if not temppay_add(temppay_entry):
            text, entities = build_emoji_message(
                "You already have an open invoice. Finish that payment, or use /cancel to start fresh.",
                "failed",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        st["step"] = "payment_waiting"
        st["order_id"] = order_id
        _shop_state[user_id] = st
        text, entities = build_invoice_message(plan_name, st["duration_days"], st["amount_usd"], invoice, internal_code)
        await q.edit_message_text(
            text,
            entities=entities,
            disable_web_page_preview=True,
        )
        return


async def on_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle text: bot name and bot token after payment confirmed (from _shop_state or order.awaiting_field)."""
    if not update.message or not update.message.text:
        return
    user_id = update.effective_user.id if update.effective_user else 0
    chat_id = update.effective_chat.id if update.effective_chat else user_id
    if is_maintenance_enabled():
        add_to_maintenance_queue(user_id, chat_id)
        await update.message.reply_text(MAINTENANCE_MESSAGE)
        return
    text = (update.message.text or "").strip()
    st = _shop_state.get(user_id)

    # Order-based flow: paid order awaiting name or token (e.g. after payment polling confirmed)
    if not st:
        order_name = get_order_by_user_and_awaiting(user_id, "paid", "name")
        order_token = get_order_by_user_and_awaiting(user_id, "paid", "token")
        if order_name:
            st = {"step": "enter_name", "order_id": order_name["order_id"], "data": {}}
            _shop_state[user_id] = st
        elif order_token:
            st = {"step": "enter_token", "order_id": order_token["order_id"], "bot_name": order_token.get("bot_name", "AdBot"), "data": {}}
            _shop_state[user_id] = st

    if not st:
        return

    step = st.get("step")
    if step == "enter_name":
        if not text:
            await update.message.reply_text("Name can't be empty — try again.")
            return
        order_id = st.get("order_id")
        order = get_order(order_id) if order_id else None
        if not order or order.get("status") != "paid":
            await update.message.reply_text("Couldn't find a paid order — send /start to begin.")
            _clear_shop_state(user_id)
            return
        st["bot_name"] = text
        update_order(order_id, {"bot_name": text})
        from ..utils import add_admin_alert

        # Pull a bot token from our free pool — the user no longer provides their own.
        from .token_pool import reserve_token, mark_assigned, release_order
        pooled = reserve_token(order_id)
        if not pooled:
            update_order_status(order_id, "pending_creation")
            update_order(order_id, {"bot_name": text})
            add_admin_alert("pending_creation", f"Order {order_id} — no bot token in pool. Add one, then recreate.")
            await update.message.reply_text(QUEUE_EDIT_MESSAGE)
            _clear_shop_state(user_id)
            return
        bot_token = (pooled.get("token") or "").strip()
        username = (pooled.get("username") or "").strip()
        if not username:
            ok, username = await validate_bot_token(bot_token)
            if not ok:
                release_order(order_id)
                await update.message.reply_text("Couldn't reserve a bot slot — support has been notified. Please reach out to support to finish setup.")
                _clear_shop_state(user_id)
                return

        # Build the creation form with the pooled token and submit to the queue.
        plan = order.get("plan_id")
        plans = load_plans()
        plan_obj = None
        for mode_plans in plans.values():
            for p in mode_plans:
                if p.get("id") == plan:
                    plan_obj = p
                    break
            if plan_obj:
                break
        if not plan_obj:
            plan_obj = {"sessions": 1, "cycle": 3600, "gap": 5}
        valid_end = datetime.utcnow() + timedelta(days=order.get("duration_days", 7))
        valid_till = valid_end.strftime("%d/%m/%Y")
        # Renewal baseline = MONTHLY price, not the amount paid (which may be a weekly
        # purchase) — the renewal endpoint scales from a monthly figure.
        renewal_price = str(plan_obj.get("price_month") or order.get("amount_usd", 0))
        from ..chatlist import default_group_file_for_mode
        _plan_mode = (order.get("plan_mode") or "starter").strip().capitalize()
        group_file = default_group_file_for_mode(_plan_mode)
        if not (config.GROUPS_DIR / group_file).exists():
            group_file = "Starter.txt"
            if not (config.GROUPS_DIR / group_file).exists():
                for f in config.GROUPS_DIR.glob("*.txt"):
                    group_file = f.name
                    break
        duration_days = order.get("duration_days", 7)
        form = {
            "name": text,
            "bot_token": bot_token,
            "bot_username": username,
            "sessions_count": int(plan_obj.get("sessions", 1)),
            "cycle": int(plan_obj.get("cycle", 3600)),
            "gap": int(plan_obj.get("gap", 5)),
            "valid_till": valid_till,
            "duration_days": duration_days,
            "mode": _plan_mode,
            "group_file": group_file,
            "plan_name": order.get("plan_name", ""),
            "renewal_price": renewal_price,
            "order_id": order_id,
            "source": "shop",
            "user_id": order.get("user_id") or user_id,
        }
        adbot_data = load_adbot()
        free_count = len(adbot_data.get("free_sessions", []))
        if free_count < form["sessions_count"]:
            update_order_status(order_id, "pending_creation")
            update_order(order_id, {
                "bot_name": form.get("name"),
                "bot_token": form.get("bot_token"),
                "bot_username": form.get("bot_username"),
            })
            mark_assigned(order_id)
            add_admin_alert("pending_creation", f"Order {order_id} — insufficient sessions (need {form['sessions_count']}, free {free_count}). Recreate after adding sessions.")
            await update.message.reply_text(QUEUE_EDIT_MESSAGE)
            _clear_shop_state(user_id)
            return
        progress_text, progress_entities = build_emoji_message(CREATION_PROGRESS_MESSAGE, "processing")
        progress_msg = await update.message.reply_text(progress_text, entities=progress_entities)
        update_order(order_id, {
            "bot_name": text,
            "bot_token": bot_token,
            "bot_username": username,
            # Clear the awaiting flag so a rapid second message can't re-derive this
            # paid order and submit a duplicate create job (worker allows 2 concurrent).
            "awaiting_field": "submitted",
        })
        mark_assigned(order_id)
        submit_create_job(
            chat_id,
            progress_msg.message_id,
            form,
            notification_bot_token=config.SHOP_BOT_TOKEN or None,
        )
        _clear_shop_state(user_id)
        return

    if step == "enter_token":
        if not text:
            await update.message.reply_text("Send a valid bot token.")
            return
        order_id = st.get("order_id")
        order = get_order(order_id) if order_id else None
        if not order or order.get("status") != "paid":
            await update.message.reply_text("Couldn't find a paid order — send /start to begin.")
            _clear_shop_state(user_id)
            return
        ok, username = await validate_bot_token(text)
        if not ok:
            await update.message.reply_text(f"Invalid token: {username}")
            return
        adbot_data = load_adbot()
        if text.strip() in adbot_data.get("bots", {}):
            await update.message.reply_text("This bot token is already registered.")
            return
        # Build form and submit to creation queue
        plan = order.get("plan_id")
        plans = load_plans()
        plan_obj = None
        for mode_plans in plans.values():
            for p in mode_plans:
                if p.get("id") == plan:
                    plan_obj = p
                    break
            if plan_obj:
                break
        if not plan_obj:
            plan_obj = {"sessions": 1, "cycle": 3600, "gap": 5}
        valid_end = datetime.utcnow() + timedelta(days=order.get("duration_days", 7))
        valid_till = valid_end.strftime("%d/%m/%Y")
        # Renewal baseline = MONTHLY price, not the amount paid (which may be a weekly
        # purchase) — the renewal endpoint scales from a monthly figure.
        renewal_price = str(plan_obj.get("price_month") or order.get("amount_usd", 0))
        from ..chatlist import default_group_file_for_mode
        _plan_mode = (order.get("plan_mode") or "starter").strip().capitalize()
        group_file = default_group_file_for_mode(_plan_mode)
        if not (config.GROUPS_DIR / group_file).exists():
            group_file = "Starter.txt"
            if not (config.GROUPS_DIR / group_file).exists():
                for f in config.GROUPS_DIR.glob("*.txt"):
                    group_file = f.name
                    break
        duration_days = order.get("duration_days", 7)
        form = {
            "name": st.get("bot_name", "AdBot"),
            "bot_token": text.strip(),
            "bot_username": username,
            "sessions_count": int(plan_obj.get("sessions", 1)),
            "cycle": int(plan_obj.get("cycle", 3600)),
            "gap": int(plan_obj.get("gap", 5)),
            "valid_till": valid_till,
            "duration_days": duration_days,
            "mode": _plan_mode,
            "group_file": group_file,
            "plan_name": order.get("plan_name", ""),
            "renewal_price": renewal_price,
            "order_id": order_id,
            "source": "shop",
            "user_id": order.get("user_id") or user_id,
        }
        free_count = len(adbot_data.get("free_sessions", []))
        if free_count < form["sessions_count"]:
            update_order_status(order_id, "pending_creation")
            update_order(order_id, {
                "bot_name": form.get("name"),
                "bot_token": form.get("bot_token"),
                "bot_username": form.get("bot_username"),
            })
            from ..utils import add_admin_alert
            add_admin_alert("pending_creation", f"Order {order_id} — insufficient sessions (need {form['sessions_count']}, free {free_count}). Use Recreate in admin after adding sessions.")
            await update.message.reply_text(QUEUE_EDIT_MESSAGE)
            _clear_shop_state(user_id)
            return
        text, entities = build_emoji_message(CREATION_PROGRESS_MESSAGE, "processing")
        progress_msg = await update.message.reply_text(text, entities=entities)
        # Do not set status to "creating" here — worker sets it when it actually starts (avoids "already_creating" skip).
        # Persist the token and clear the awaiting flag so a rapid second message can't
        # re-derive this paid order and submit a duplicate create job.
        update_order(order_id, {
            "bot_name": form.get("name"),
            "bot_token": form.get("bot_token"),
            "bot_username": username,
            "awaiting_field": "submitted",
        })
        submit_create_job(
            chat_id,
            progress_msg.message_id,
            form,
            notification_bot_token=config.SHOP_BOT_TOKEN or None,
        )
        _clear_shop_state(user_id)
        return


async def recreate_pending_order(
    order_id: str, skip_health_check: bool = False, skip_chatlist_join: bool = False
) -> tuple[bool, str]:
    """
    Recreate an AdBot for a pending_creation order. Sends progress message to buyer via Shop Bot, then submits create job.
    skip_health_check/skip_chatlist_join let an admin force-continue with unhealthy sessions (e.g. dead pool)
    when the pool is short on healthy ones.
    Returns (success, message).
    """
    from ..utils import load_adbot, validate_bot_token
    from ..admin_ptb import submit_create_job
    from . import token_pool
    order = get_order(order_id)
    if not order:
        return False, "Order not found"
    status = order.get("status")
    is_web = (order.get("source") or "") == "web"
    # Recreatable: pending_creation (low sessions / invalid token), or — for web orders —
    # a paid+queued order that had no token in the pool when it was confirmed.
    if status != "pending_creation" and not (is_web and status == "paid"):
        return False, f"Order status is {status}, not recreatable"
    user_id = order.get("user_id")
    if not is_web and not user_id:
        return False, "Order has no user_id"
    bot_token = (order.get("bot_token") or "").strip()
    bot_name = (order.get("bot_name") or "AdBot").strip()
    bot_username = (order.get("bot_username") or "").strip()
    # No token bound yet (the no-token queued case) → reserve one from the pool now.
    if not bot_token:
        reserved = token_pool.reserve_token(order_id)
        bot_token = ((reserved or {}).get("token") or "").strip()
        bot_username = ((reserved or {}).get("username") or "").strip()
        if not bot_token:
            return False, "No bot token available in pool — add one first"
    if not bot_username:
        ok, bot_username = await validate_bot_token(bot_token)
        if not ok or not bot_username:
            return False, "Pooled token invalid — replace it, then recreate"
    # Persist what we resolved so the binding survives.
    update_order(order_id, {"bot_token": bot_token, "bot_username": bot_username})
    plans = load_plans()
    plan_obj = None
    for mode_plans in plans.values():
        for p in mode_plans:
            if p.get("id") == order.get("plan_id"):
                plan_obj = p
                break
        if plan_obj:
            break
    if not plan_obj:
        plan_obj = {"sessions": 1, "cycle": 3600, "gap": 5}
    adbot_data = load_adbot()
    free_count = len(adbot_data.get("free_sessions", []))
    need = int(plan_obj.get("sessions", 1))
    if free_count < need:
        return False, f"Insufficient sessions (need {need}, free {free_count})"
    valid_end = datetime.utcnow() + timedelta(days=order.get("duration_days", 7))
    valid_till = valid_end.strftime("%d/%m/%Y")
    renewal_price = str(order.get("amount_usd", 0))
    from ..chatlist import default_group_file_for_mode
    _plan_mode = (order.get("plan_mode") or "starter").strip().capitalize()
    group_file = default_group_file_for_mode(_plan_mode)
    if not (config.GROUPS_DIR / group_file).exists():
        group_file = "Starter.txt"
        if not (config.GROUPS_DIR / group_file).exists():
            for f in config.GROUPS_DIR.glob("*.txt"):
                group_file = f.name
                break
    form = {
        "name": bot_name,
        "bot_token": bot_token,
        "bot_username": bot_username,
        # Preserve the buyer's original access code so the rebuilt bot keeps the same
        # ADB-XXXX-XXXX they were already shown — without this, a fresh random code is
        # generated and the buyer is locked out.
        "_web_token": (order.get("web_token") or "").strip(),
        "sessions_count": need,
        "cycle": int(plan_obj.get("cycle", 3600)),
        "gap": int(plan_obj.get("gap", 5)),
        "valid_till": valid_till,
        "duration_days": order.get("duration_days", 7),
        "mode": _plan_mode,
        "group_file": group_file,
        "plan_name": order.get("plan_name", ""),
        "renewal_price": renewal_price,
        "order_id": order_id,
        "source": "web" if is_web else "shop",
        "user_id": user_id or 0,
        "skip_health_check": skip_health_check,
        "skip_chatlist_join": skip_chatlist_join,
    }
    # Web orders build headlessly (no Shop Bot user to message); shop orders send a
    # progress message to the buyer first.
    if is_web:
        submit_create_job(0, 0, form, web=True)
        return True, "Create job submitted"
    from .. import bot_ptb
    ok, msg_id = await bot_ptb.send_message_with_bot_return_id(
        user_id, CREATION_PROGRESS_MESSAGE, bot_token=config.SHOP_BOT_TOKEN
    )
    if not ok or msg_id is None:
        return False, "Could not send progress message to buyer"
    # Do not set status to "creating" here — worker sets it when it actually starts (avoids "already_creating" skip).
    submit_create_job(user_id, msg_id, form, notification_bot_token=config.SHOP_BOT_TOKEN or None)
    return True, "Create job submitted"


def run_shop_bot_app() -> Application:
    """Build and return the Shop Bot Application. Call application.run_polling() from main."""
    if not config.SHOP_BOT_TOKEN:
        raise ValueError("SHOP_BOT_TOKEN is not set")
    _b = Application.builder().token(config.SHOP_BOT_TOKEN)
    _ptb_req = config.build_ptb_httpx_request()
    if _ptb_req is not None:
        _b = _b.request(_ptb_req)
        logger.info("Shop bot PTB using SOCKS proxy for Bot API (socks5h / remote DNS)")
    app = _b.build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    return app


async def run_shop_bot() -> None:
    """Run Shop Bot polling. Called from main."""
    if not config.SHOP_BOT_TOKEN:
        logger.warning("SHOP_BOT_TOKEN not set; Shop Bot not started")
        return
    app = run_shop_bot_app()
    await app.initialize()
    await app.start()
    logger.info("Shop Bot started")
    # run_polling blocks; run in a way that doesn't block main loop
    await app.updater.start_polling(drop_pending_updates=True)


# PTB lifecycle: never call application.shutdown/stop from workers or background tasks. Guard with _shop_ptb_running().
_shop_app_running = False


def _shop_ptb_running() -> bool:
    """True if Shop Bot PTB polling is active. Use to skip sends in background tasks when app is down."""
    return _shop_app_running


def start_shop_bot_thread() -> None:
    """Start Shop Bot polling in a background thread (same pattern as admin bot). Call from main."""
    import threading
    global _shop_app_running
    if not config.SHOP_BOT_TOKEN:
        return
    app = run_shop_bot_app()
    def run_polling():
        global _shop_app_running
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _shop_app_running = True
        logger.info("[AppLifecycle] application_started=True executor_alive=True")
        try:
            app.run_polling(allowed_updates=Update.ALL_TYPES, stop_signals=())
        finally:
            _shop_app_running = False
            loop.close()
    thread = threading.Thread(target=run_polling, daemon=True)
    thread.start()
    logger.info("Shop Bot polling started in background thread")
