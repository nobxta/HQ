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
from ..ui.emoji_entities import build_emoji_message, build_payment_message_with_emojis, PLACEHOLDER
from ..utils import load_adbot, validate_bot_token
from telegram.helpers import escape_markdown
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

logger = logging.getLogger(__name__)

# Terms line: under order summary and payment message only. Hidden link, no preview.
TERMS_URL = "https://t.me/HQAdzTOS/3"
TERMS_LINE_MARKDOWN = f"By proceeding with this purchase, you agree to our [Terms and Conditions]({TERMS_URL})."

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
    ("DOGE", "DOGE"),
    ("XRP", "XRP"),
    ("SOL", "SOL"),
    ("MATIC", "MATIC"),
    ("ADA", "ADA"),
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


def _esc(s: str) -> str:
    """Escape for Telegram MarkdownV2."""
    return escape_markdown(str(s or ""), version=2)


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


def _payment_message_markdown(
    plan_name: str,
    duration_days: int,
    amount_usd: float,
    invoice: dict,
    currency: str,
    order_id: str | None = None,
) -> str:
    """Build payment message in MarkdownV2. Format: Complete Your Payment, Plan, Validity, Amount, send exactly, address, 12h, auto-continue. All dynamic parts escaped."""
    pay_amount = invoice.get("pay_amount")
    # Prefer passed currency (PAYMENT_CURRENCY_MAP key) for display so e.g. usdt_trc20 → "USDT (TRC-20)"
    pay_currency_raw = (currency or invoice.get("pay_currency") or "").strip()
    pay_currency_display = _crypto_display_name(pay_currency_raw)
    pay_address = (invoice.get("pay_address") or "").strip() or "(check payment link)"
    amount_display = f"{pay_amount} {pay_currency_display}" if pay_amount is not None else f"${amount_usd:.2f} {pay_currency_display}"
    parts = [
        "*Complete Your Payment*",
        "",
        f"*Plan:* {_esc(plan_name)}",
        f"*Validity:* {_esc(str(duration_days))} days",
        f"*Amount:* ${_esc(f'{amount_usd:.2f}')}",
        "",
        "*Action:* Send exactly",
        f"`{_esc(amount_display)}`",
        "",
        "to this address:",
        "",
        f"`{_esc(pay_address)}`",
        "",
        f"{PLACEHOLDER} Valid for *12 hours*\\. After that, create a new order if needed\\.",
        "",
        _esc("When the transaction is confirmed, you will receive the next step here."),
    ]
    return "\n".join(parts)


def _clear_shop_state(user_id: int) -> None:
    _shop_state.pop(user_id, None)


def _payment_summary_text(st: dict) -> str:
    """Build payment summary: Plan, Amount, Duration; includes Terms line (Markdown link, no preview)."""
    amount = st.get("amount_usd", 0)
    plan_id = (st.get("plan_id") or "").title()
    mode = (st.get("mode") or "starter").title()
    duration_days = st.get("duration_days", 7)
    plan_display = f"{plan_id} ({mode})" if plan_id else mode
    return (
        f"*Plan:* {plan_display}\n"
        f"*Amount:* ${amount:.2f}\n\n"
        f"{TERMS_LINE_MARKDOWN}\n\n"
        "Select cryptocurrency:"
    )


def _payment_crypto_keyboard(st: dict) -> InlineKeyboardMarkup:
    """Main crypto grid: [BTC][ETH][XMR], [USDT][USDC][LTC], [More], [Back]. Uses internal codes."""
    plan_id = st.get("plan_id", "")
    mode = st.get("mode", "starter")
    back_data = f"shop_plan_detail:{mode}:{plan_id}"
    rows = [
        [
            InlineKeyboardButton("BTC", callback_data="shop_crypto:BTC"),
            InlineKeyboardButton("ETH", callback_data="shop_crypto:ETH"),
            InlineKeyboardButton("XMR", callback_data="shop_crypto:XMR"),
        ],
        [
            InlineKeyboardButton("USDT", callback_data="shop_crypto_network:usdt"),
            InlineKeyboardButton("USDC", callback_data="shop_crypto_network:usdc"),
            InlineKeyboardButton("LTC", callback_data="shop_crypto:LTC"),
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
            "You already have a pending payment. Use /cancel to cancel the current order before creating a new one.",
        )
        return
    _clear_shop_state(user_id)
    text, entities = build_emoji_message("Choose an option:", "wave")
    await update.message.reply_text(
        text,
        reply_markup=_start_menu_keyboard(),
        entities=entities,
    )


# Cancelled payment message: edit the payment address message to this (dustbin custom emoji).
CANCELLED_PAYMENT_MESSAGE = (
    "Payment Invoice Cancelled\n\n"
    "This order has been cancelled. You may create a new order anytime using /start."
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
            "No pending payment to cancel.",
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
        cancel_text, entities = build_emoji_message(CANCELLED_PAYMENT_MESSAGE, "cancelled")
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
    text, entities = build_emoji_message("Choose an option:", "wave")
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
            await q.answer("Order not found or already completed.", show_alert=True)
            return
        if order.get("awaiting_field") not in ("proceed", "name"):
            await q.answer("Setup already in progress.", show_alert=False)
            return
        update_order(order_id, {"awaiting_field": "name"})
        try:
            await q.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass
        text, entities = build_emoji_message(STEP5_MESSAGE, "trust")
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
        text, entities = build_emoji_message("Choose Plan Category", "plans")
        await q.edit_message_text(text, reply_markup=keyboard, entities=entities)
        return

    if raw == "shop_faq":
        await q.edit_message_text(
            "FAQ",
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
            "How purchase works:\n\n"
            "1. Buy AdBot → Choose plan category (Starter / Enterprise)\n"
            "2. Select a plan from the list (e.g. Bronze, Gold)\n"
            "3. View plan details → Buy Weekly or Buy Monthly\n"
            "4. Choose crypto → you get a payment address and amount\n"
            "5. Pay the exact amount to that address\n"
            "6. When payment is confirmed, enter your Bot Name\n"
            "7. Send your Bot Token (from @BotFather)\n"
            "8. We create your AdBot and send you the link\n\n"
            "You can check validity anytime in your AdBot with the Validity button."
        )
        await q.edit_message_text(
            how,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_faq")]]),
        )
        return

    if raw == "shop_faq_how_it_works":
        msg = (
            "We post your advertisement in targeted high-reach Telegram marketplace and niche groups "
            "to maximize visibility and engagement."
        )
        await q.edit_message_text(
            msg,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_faq")]]),
        )
        return

    if raw == "shop_faq_replacement":
        msg = (
            "We provide a one-time free replacement for banned sessions.\n"
            "Example: If two accounts in your plan are banned, both will be replaced together.\n\n"
            "Free replacement is available:\n"
            "- Starter plans: monthly plans only\n"
            "- Enterprise plans: included for all plans"
        )
        await q.edit_message_text(
            msg,
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
            lines.append(f"Bot: {username}\nValidity: {valid_till}")
        if not lines:
            body = "You do not have any active bots."
        else:
            body = "\n\n".join(lines)
        await q.edit_message_text(
            body,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("Back", callback_data="shop_back")]]),
        )
        return

    if raw == "shop_support":
        # Fallback when SUPPORT_CHAT_ID/SUPPORT_USER_ID not set: show contact info and direct link if we have one
        support_id = getattr(config, "SUPPORT_CHAT_ID", 0) or getattr(config, "SUPPORT_USER_ID", 0) or 0
        contact = getattr(config, "ADMIN_CONTACT", "admin")
        if support_id:
            await q.edit_message_text(
                "Tap the button below to open a chat with support.",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("Contact Support", url=f"tg://user?id={support_id}")],
                    [InlineKeyboardButton("Back", callback_data="shop_back")],
                ]),
            )
        else:
            await q.edit_message_text(
                f"Support: Contact @{contact} for help.",
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
        text, entities = build_emoji_message("Choose an option:", "wave")
        await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
        return

    # Step 1 → Step 2: category selected → compact plan list (marketing-style, 2-col buttons)
    if raw.startswith("shop_category:"):
        mode = raw.split(":", 1)[1].lower()
        plans = load_plans()
        plan_list = plans.get(mode, [])
        if not plan_list:
            await q.edit_message_text("No plans available for this category.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_list", "mode": mode, "data": {}}
        title = "*Starter Plans*" if mode == "starter" else "*Enterprise Plans*"
        max_name_len = max(len(p.get("id", "")) for p in plan_list)
        lines = []
        for p in plan_list:
            sid = p.get("id", "").title()
            accounts = int(p.get("sessions", 0))
            acc_str = "1 Account" if accounts == 1 else f"{accounts} Accounts"
            pw = float(p.get("price_week", 0))
            name_pad = sid.ljust(max_name_len)
            lines.append(f"{name_pad} | {acc_str} | ${pw:.0f} / week")
        msg = f"{title}\n\n" + "\n".join(lines) + "\n\nSelect a plan:"
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
        text, entities = build_emoji_message(msg, "plans")
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), parse_mode="Markdown", entities=entities)
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
            await q.edit_message_text("Plan not found.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_detail", "mode": mode, "plan": plan, "plan_id": plan_id, "data": {}}
        pw = float(plan.get("price_week", 0))
        pm = float(plan.get("price_month", 0))
        msg = f"*{plan_id.title()} Plan*\n\nChoose billing duration:"
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(f"Weekly | ${pw:.0f}", callback_data=f"shop_buy:{plan_id}:7"),
                InlineKeyboardButton(f"Monthly | ${pm:.0f}", callback_data=f"shop_buy:{plan_id}:30"),
            ],
            [InlineKeyboardButton("Back", callback_data=f"shop_category:{mode}")],
        ])
        text, entities = build_emoji_message(msg, "plans")
        await q.edit_message_text(text, reply_markup=keyboard, parse_mode="Markdown", entities=entities)
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
            await q.edit_message_text("Plan not found.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "plan_detail", "mode": mode, "plan": plan, "plan_id": plan_id, "data": {}}
        pw = float(plan.get("price_week", 0))
        pm = float(plan.get("price_month", 0))
        msg = f"*{plan_id.title()} Plan*\n\nChoose billing duration:"
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(f"Weekly | ${pw:.0f}", callback_data=f"shop_buy:{plan_id}:7"),
                InlineKeyboardButton(f"Monthly | ${pm:.0f}", callback_data=f"shop_buy:{plan_id}:30"),
            ],
            [InlineKeyboardButton("Back", callback_data=f"shop_category:{mode}")],
        ])
        text, entities = build_emoji_message(msg, "plans")
        await q.edit_message_text(text, reply_markup=keyboard, parse_mode="Markdown", entities=entities)
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
            await q.edit_message_text("Start from /start again.", reply_markup=_main_menu_keyboard())
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
        summary = _payment_summary_text(st)
        text, entities = build_emoji_message(summary, "cart")
        await q.edit_message_text(
            text,
            reply_markup=_payment_crypto_keyboard(st),
            entities=entities,
            parse_mode="Markdown",
            disable_web_page_preview=True,
        )
        return

    if raw.startswith("shop_renew:"):
        parent_order_id = raw.split(":", 1)[1]
        order = get_order(parent_order_id)
        if not order or order.get("status") != "completed":
            await q.edit_message_text("Order not found or not completed.", reply_markup=_main_menu_keyboard())
            return
        _shop_state[user_id] = {"step": "renewal_duration", "parent_order_id": parent_order_id, "data": {}}
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("7 Days", callback_data=f"shop_renew_dur:{parent_order_id}:7")],
            [InlineKeyboardButton("30 Days", callback_data=f"shop_renew_dur:{parent_order_id}:30")],
            [InlineKeyboardButton("Back", callback_data="shop_back")],
        ])
        text, entities = build_emoji_message("Select renewal duration:", "cart")
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
            await q.edit_message_text("Order not found.", reply_markup=_main_menu_keyboard())
            return
        from ..utils import get_name_by_token, load_user_data
        bot_token = order.get("bot_token")
        name = get_name_by_token(bot_token) if bot_token else None
        cfg = load_user_data(name) if name else None
        renewal_price = float(cfg.get("renewal_price") or order.get("amount_usd") or 0)
        amount = renewal_price * (duration_days / 30.0) if duration_days < 30 else renewal_price
        _shop_state[user_id] = {"step": "renewal_crypto", "parent_order_id": parent_order_id, "duration_days": duration_days, "amount_usd": amount, "data": {}}
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("BTC", callback_data=f"shop_renew_crypto:{parent_order_id}:{duration_days}:BTC"), InlineKeyboardButton("ETH", callback_data=f"shop_renew_crypto:{parent_order_id}:{duration_days}:ETH")],
            [InlineKeyboardButton("USDT", callback_data=f"shop_renew_network:{parent_order_id}:{duration_days}:usdt"), InlineKeyboardButton("USDC", callback_data=f"shop_renew_network:{parent_order_id}:{duration_days}:usdc")],
            [InlineKeyboardButton("Back", callback_data=f"shop_renew:{parent_order_id}")],
        ])
        msg = f"Renewal: ${amount:.2f} USD\nSelect cryptocurrency:"
        text, entities = build_emoji_message(msg, "crypto")
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
            await q.edit_message_text("Order not found.", reply_markup=_main_menu_keyboard())
            return
        if len(parts) == 4:
            # Show network selection for USDT/USDC
            networks = USDT_NETWORKS if coin == "usdt" else USDC_NETWORKS
            rows = []
            for i in range(0, len(networks), 2):
                pair = [InlineKeyboardButton(networks[i][0], callback_data=f"shop_renew_network:{parent_order_id}:{duration_days}:{coin}:{networks[i][1].lower()}")]
                if i + 1 < len(networks):
                    pair.append(InlineKeyboardButton(networks[i + 1][0], callback_data=f"shop_renew_network:{parent_order_id}:{duration_days}:{coin}:{networks[i + 1][1].lower()}"))
                rows.append(pair)
            rows.append([InlineKeyboardButton("Back", callback_data=f"shop_renew:{parent_order_id}")])
            label = "USDT" if coin == "usdt" else "USDC"
            text, entities = build_emoji_message(f"Renewal — {label}\n\nSelect network:", "crypto")
            await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
            return
        network = (parts[4] or "").strip().upper()
        internal_code = f"{coin.upper()}_{network}"
        from ..utils import get_name_by_token, load_user_data
        name = get_name_by_token(parent.get("bot_token") or "")
        cfg = load_user_data(name) if name else {}
        renewal_price = float(cfg.get("renewal_price") or parent.get("amount_usd") or 0)
        amount = renewal_price * (duration_days / 30.0) if duration_days < 30 else renewal_price
        rev_order = create_renewal_order(
            parent_order_id=parent_order_id,
            user_id=user_id,
            duration_days=duration_days,
            amount_usd=amount,
            payment_id="",
            currency=internal_code,
            invoice_url=None,
        )
        if getattr(config, "PAYMENT_DEV_MODE", False):
            from .workers import extend_valid_till_for_bot
            now = datetime.utcnow().isoformat() + "Z"
            parent_token = (parent.get("bot_token") or "").strip()
            if parent_token and extend_valid_till_for_bot(parent_token, duration_days, rev_order.get("order_id", "")):
                update_order_status(rev_order["order_id"], "completed", paid_at=now)
                try:
                    from ..broadcast_users import add_plan_user
                    add_plan_user(user_id)
                except Exception:
                    pass
                text, entities = build_emoji_message("Renewal confirmed. Your AdBot validity has been extended.", "trust")
                await q.edit_message_text(text, entities=entities)
            else:
                update_order_status(rev_order["order_id"], "failed")
                text, entities = build_emoji_message("Renewal failed (could not extend validity).", "error")
                await q.edit_message_text(text, entities=entities)
            return
        invoice = create_invoice(amount_usd=amount, currency=internal_code, order_id=rev_order["order_id"], description=f"AdBot renewal {duration_days} days")
        if invoice.get("_invoice_failed"):
            update_order(rev_order["order_id"], {"status": "invoice_failed"})
            msg = "Selected payment method is temporarily unavailable. Please choose another." if invoice.get("_reason") == "unavailable" else "Invoice creation failed. Please try again or contact support."
            text, entities = build_emoji_message(msg, "error")
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
        msg = _payment_message_markdown(
            plan_name="Renewal",
            duration_days=duration_days,
            amount_usd=amount,
            invoice=invoice,
            currency=internal_code,
            order_id=rev_order["order_id"],
        )
        text, entities = build_payment_message_with_emojis(msg)
        await q.edit_message_text(
            text,
            parse_mode="MarkdownV2",
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
            await q.edit_message_text("Order not found.", reply_markup=_main_menu_keyboard())
            return
        from ..utils import get_name_by_token, load_user_data
        name = get_name_by_token(parent.get("bot_token") or "")
        cfg = load_user_data(name) if name else {}
        renewal_price = float(cfg.get("renewal_price") or parent.get("amount_usd") or 0)
        amount = renewal_price * (duration_days / 30.0) if duration_days < 30 else renewal_price
        rev_order = create_renewal_order(
            parent_order_id=parent_order_id,
            user_id=user_id,
            duration_days=duration_days,
            amount_usd=amount,
            payment_id="",
            currency=internal_code,
            invoice_url=None,
        )
        if getattr(config, "PAYMENT_DEV_MODE", False):
            from .workers import extend_valid_till_for_bot
            now = datetime.utcnow().isoformat() + "Z"
            parent_token = (parent.get("bot_token") or "").strip()
            if parent_token and extend_valid_till_for_bot(parent_token, duration_days, rev_order.get("order_id", "")):
                update_order_status(rev_order["order_id"], "completed", paid_at=now)
                try:
                    from ..broadcast_users import add_plan_user
                    add_plan_user(user_id)
                except Exception:
                    pass
                text, entities = build_emoji_message("Renewal confirmed. Your AdBot validity has been extended.", "trust")
                await q.edit_message_text(text, entities=entities)
            else:
                update_order_status(rev_order["order_id"], "failed")
                text, entities = build_emoji_message("Renewal failed (could not extend validity).", "error")
                await q.edit_message_text(text, entities=entities)
            return
        invoice = create_invoice(amount_usd=amount, currency=internal_code, order_id=rev_order["order_id"], description=f"AdBot renewal {duration_days} days")
        if invoice.get("_invoice_failed"):
            update_order(rev_order["order_id"], {"status": "invoice_failed"})
            msg = "Selected payment method is temporarily unavailable. Please choose another." if invoice.get("_reason") == "unavailable" else "Invoice creation failed. Please try again or contact support."
            text, entities = build_emoji_message(msg, "error")
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
        msg = _payment_message_markdown(
            plan_name="Renewal",
            duration_days=duration_days,
            amount_usd=amount,
            invoice=invoice,
            currency=internal_code,
            order_id=rev_order["order_id"],
        )
        text, entities = build_payment_message_with_emojis(msg)
        await q.edit_message_text(
            text,
            parse_mode="MarkdownV2",
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    # Back to main crypto selection from More or from network selection
    if raw == "shop_crypto_back":
        st = _shop_state.get(user_id)
        if not st or st.get("step") not in ("crypto", "crypto_network"):
            await q.edit_message_text("Choose an option:", reply_markup=_main_menu_keyboard())
            return
        st["step"] = "crypto"
        _shop_state[user_id] = st
        summary = _payment_summary_text(st)
        text, entities = build_emoji_message(summary, "cart")
        await q.edit_message_text(
            text,
            reply_markup=_payment_crypto_keyboard(st),
            entities=entities,
            parse_mode="Markdown",
            disable_web_page_preview=True,
        )
        return

    # More currencies screen (TRX, BNB, DOGE, XRP, DAI, MATIC, FDUSD, PYUSD)
    if raw == "shop_more_crypto":
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Start from /start again.", reply_markup=_main_menu_keyboard())
            return
        rows = []
        for i in range(0, len(MORE_CURRENCIES), 2):
            pair = [InlineKeyboardButton(MORE_CURRENCIES[i][0], callback_data=f"shop_crypto:{MORE_CURRENCIES[i][1]}")]
            if i + 1 < len(MORE_CURRENCIES):
                pair.append(InlineKeyboardButton(MORE_CURRENCIES[i + 1][0], callback_data=f"shop_crypto:{MORE_CURRENCIES[i + 1][1]}"))
            rows.append(pair)
        rows.append([InlineKeyboardButton("Back", callback_data="shop_crypto_back")])
        text, entities = build_emoji_message("More currencies", "crypto")
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), entities=entities)
        return

    # USDT / USDC → network selection (TRC-20, ERC-20, BEP-20, SOL)
    if raw.startswith("shop_crypto_network:"):
        coin = raw.split(":", 1)[1].lower()  # usdt or usdc
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Start from /start again.", reply_markup=_main_menu_keyboard())
            return
        st["step"] = "crypto_network"
        st["network_coin"] = coin
        _shop_state[user_id] = st
        label = "USDT" if coin == "usdt" else "USDC"
        networks = USDT_NETWORKS if coin == "usdt" else USDC_NETWORKS
        rows = []
        for i in range(0, len(networks), 2):
            pair = [
                InlineKeyboardButton(networks[i][0], callback_data=f"shop_network:{coin}:{networks[i][1].lower()}")
            ]
            if i + 1 < len(networks):
                pair.append(InlineKeyboardButton(
                    networks[i + 1][0], callback_data=f"shop_network:{coin}:{networks[i + 1][1].lower()}"
                ))
            rows.append(pair)
        rows.append([InlineKeyboardButton("Back", callback_data="shop_crypto_back")])
        msg = f"*{label}*\n\nSelect network:"
        text, entities = build_emoji_message(msg, "crypto")
        await q.edit_message_text(text, reply_markup=InlineKeyboardMarkup(rows), parse_mode="Markdown", entities=entities)
        return

    # Chosen stablecoin + network → internal code e.g. USDT_TRC20, USDC_BEP20 (SUPPORTED_PAY_CURRENCIES keys)
    if raw.startswith("shop_network:"):
        parts = raw.split(":", 2)
        if len(parts) < 3:
            return
        coin, network = parts[1].lower(), parts[2].strip().upper()
        st = _shop_state.get(user_id)
        if not st or st.get("step") not in ("crypto", "crypto_network"):
            await q.edit_message_text("Start from /start again.", reply_markup=_main_menu_keyboard())
            return
        if get_active_pending_order_for_user(user_id):
            text, entities = build_emoji_message(
                "You already have a pending payment. Use /cancel to cancel the current order before creating a new one.",
                "error",
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
                plan_mode=st.get("mode", "starter"),
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
            await q.edit_message_text(STEP5_MESSAGE, parse_mode="Markdown")
            return
        invoice = create_invoice(
            amount_usd=st["amount_usd"],
            currency=internal_code,
            order_id=order_id,
            description=f"AdBot {plan_name} {st['duration_days']} days",
        )
        if invoice.get("_invoice_failed"):
            msg = "Selected payment method is temporarily unavailable. Please choose another." if invoice.get("_reason") == "unavailable" else "Invoice creation failed. Please try again or contact support."
            text, entities = build_emoji_message(msg, "error")
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
            "plan_mode": st.get("mode", "starter"),
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
                "You already have a pending payment. Use /cancel to cancel the current order before creating a new one.",
                "error",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        st["step"] = "payment_waiting"
        st["order_id"] = order_id
        _shop_state[user_id] = st
        msg = _payment_message_markdown(
            plan_name=plan_name,
            duration_days=st["duration_days"],
            amount_usd=st["amount_usd"],
            invoice=invoice,
            currency=internal_code,
            order_id=order_id,
        )
        text, entities = build_payment_message_with_emojis(msg)
        await q.edit_message_text(
            text,
            parse_mode="MarkdownV2",
            entities=entities,
            disable_web_page_preview=True,
        )
        return

    if raw.startswith("shop_crypto:"):
        internal_code = raw.split(":", 1)[1].strip().upper()
        st = _shop_state.get(user_id)
        if not st or st.get("step") != "crypto":
            await q.edit_message_text("Start from /start again.", reply_markup=_main_menu_keyboard())
            return
        if get_active_pending_order_for_user(user_id):
            text, entities = build_emoji_message(
                "You already have a pending payment. Use /cancel to cancel the current order before creating a new one.",
                "error",
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
                plan_mode=st.get("mode", "starter"),
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
                parse_mode="HTML", disable_web_page_preview=True
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
            msg = "Selected payment method is temporarily unavailable. Please choose another." if invoice.get("_reason") == "unavailable" else "Invoice creation failed. Please try again or contact support."
            text, entities = build_emoji_message(msg, "error")
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
            "plan_mode": st.get("mode", "starter"),
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
                "You already have a pending payment. Use /cancel to cancel the current order before creating a new one.",
                "error",
            )
            await q.edit_message_text(text, reply_markup=_main_menu_keyboard(), entities=entities)
            return
        st["step"] = "payment_waiting"
        st["order_id"] = order_id
        _shop_state[user_id] = st
        msg = _payment_message_markdown(
            plan_name=plan_name,
            duration_days=st["duration_days"],
            amount_usd=st["amount_usd"],
            invoice=invoice,
            currency=internal_code,
            order_id=order_id,
        )
        text, entities = build_payment_message_with_emojis(msg)
        await q.edit_message_text(
            text,
            parse_mode="MarkdownV2",
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
            await update.message.reply_text("Enter a non-empty bot name.")
            return
        st["bot_name"] = text
        order_id = st.get("order_id")
        if order_id:
            update_order(order_id, {"bot_name": text, "awaiting_field": "token"})
        st["step"] = "enter_token"
        step6_text, step6_entities = build_emoji_message(STEP6_MESSAGE, "keyboard")
        await update.message.reply_text(step6_text, entities=step6_entities)
        return

    if step == "enter_token":
        if not text:
            await update.message.reply_text("Send a valid bot token.")
            return
        order_id = st.get("order_id")
        order = get_order(order_id) if order_id else None
        if not order or order.get("status") != "paid":
            await update.message.reply_text("Order not found or not paid. Start from /start.")
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
        renewal_price = str(order.get("amount_usd", 0))
        from ..chatlist import default_group_file_for_mode
        _plan_mode = order.get("plan_mode", "starter").title()
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
        text, entities = build_emoji_message(CREATION_PROGRESS_MESSAGE, "rocket")
        progress_msg = await update.message.reply_text(text, entities=entities)
        # Do not set status to "creating" here — worker sets it when it actually starts (avoids "already_creating" skip).
        submit_create_job(
            chat_id,
            progress_msg.message_id,
            form,
            notification_bot_token=config.SHOP_BOT_TOKEN or None,
        )
        _clear_shop_state(user_id)
        return


async def recreate_pending_order(order_id: str) -> tuple[bool, str]:
    """
    Recreate an AdBot for a pending_creation order. Sends progress message to buyer via Shop Bot, then submits create job.
    Returns (success, message).
    """
    from ..utils import load_adbot
    from ..admin_ptb import submit_create_job
    order = get_order(order_id)
    if not order:
        return False, "Order not found"
    if order.get("status") != "pending_creation":
        return False, f"Order status is {order.get('status')}, not pending_creation"
    user_id = order.get("user_id")
    if not user_id:
        return False, "Order has no user_id"
    bot_token = (order.get("bot_token") or "").strip()
    bot_name = (order.get("bot_name") or "AdBot").strip()
    bot_username = (order.get("bot_username") or "").strip()
    if not bot_token or not bot_username:
        return False, "Order missing bot_token or bot_username"
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
    _plan_mode = order.get("plan_mode", "starter").title()
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
        "source": "shop",
        "user_id": user_id,
    }
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
