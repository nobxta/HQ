"""
Centralized Custom Premium Emoji registry (IDs only).
Use build_emoji_message() in code/ui/emoji_entities.py for sending — do not build entities manually.
Scope: Shop Bot and Admin Bot only. Controller/customer AdBots must use Unicode emojis only.
"""
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from telegram import MessageEntity

# Placeholder in message text replaced by the custom emoji (2 UTF-16 code units for entity length=2)
EMOJI_PLACEHOLDER = "\u200B\u200B"

# Custom emoji IDs (from Telegram premium / sticker set). Use with build_emoji_message or build_custom_emoji_text.
CUSTOM_EMOJIS: dict[str, str] = {
    "wave": "5247133031235329609",
    "select": "5370621059051560318",
    "crypto": "6325541882663276963",
    "loading": "5258113901106580375",
    "refresh": "5454074580010295588",
    "keyboard": "5408995930416362034",
    "trust": "6037169300144393580",
    "settings": "5215327492738392838",
    "cart": "6017275445421018704",
    "time": "5408910404732595664",
    "rocket": "5258332798409783582",
    "error": "5276307163529092252",
    "cancelled": "5408832111773757273",
    "payment_confirmed": "5021905410089550576",  # green tick
    "plans": "5408892365869952851",
    "telegram_gear": "5408940598352687316",
    "white_dot": "5409037625958872144",
    "clock": "5247209275494769660",
    "red_alert": "5420323339723881652",
    "red_exclamation": "4927486932113425461",
    "red_cross": "5019523782004441717",
    "green_tick": "5021905410089550576",
    "sand_timer": "5258113901106580375",
    "dollar": "5283232570660634549",
    "arrow": "6301098545176905333",
    "black_dot": "5850182336930385402",
    "gears": "5292186684119591112",
    "golden_dot": "5249224203567112577",
    "scanning": "5289761754174205430",
    # ── Premium UI set (Shop Bot screens) — one leading emoji per screen, keep consistent ──
    "shop": "5258024802010026053",         # shopping cart — main shop menu / purchase entry
    "billing": "5244704935899056803",      # calendar — billing duration selection
    "plan_info": "5408896647952348680",    # plan summary / order information
    "payment": "6325790127478018778",      # complete payment / coin & network selection / invoice
    "countdown": "5972210698636234017",    # valid-until timer / invoice expiry
    "queue": "5408910404732595664",        # queue / pending / waiting (same glyph as "time")
    "waiting_alt": "5021712394259268143",  # alternative waiting indicator (confirming on-chain)
    "processing": "5292186684119591112",   # creating / configuring (same glyph as "gears")
    "ready": "5845901478601953249",        # success / completed / ready
    "failed": "5019523782004441717",       # error / failed / rejected (same glyph as "red_cross")
    "declined": "5846210329700217522",     # cancelled / declined
    "delete": "5408832111773757273",       # delete / remove (same glyph as "cancelled")
    "link": "5454419255430767770",         # dashboard link / URL
    "pointer": "5215480011322042129",      # details / information pointer
    # ── Plans list: title + per-tier + trailing pointer ──
    "title_starter": "5215713717672484003",    # crown — Starter plans title
    "title_enterprise": "5424972470023104089",  # fire — Enterprise plans title
    "tier_bronze": "5453902265922376865",
    "tier_silver": "5447203607294265305",
    "tier_gold": "5440539497383087970",
    "tier_diamond": "6325347320644768017",
    "tier_basic": "5212928663309261889",
    "tier_pro": "5469641199348363998",
    "tier_elite": "5219827798125846744",
    "choose_pointer": "5201892882281162850",     # ↘️ — "Choose a plan"
    # ── Invoice / payment screen ──
    "invoice_wallet": "5424976816530014958",  # 👛 purse — invoice header
    "invoice_clock": "5852614259082530343",   # 🕖 clock — invoice validity line
}

# ── Coin / network custom emoji (message text only; buttons can't render custom emoji) ──
COIN_EMOJIS: dict[str, str] = {
    "BTC": "5116425957963465820",
    "ETH": "5118618512998269587",
    "USDT": "5116212755786892135",
    "USDC": "5116421096060486302",
    "XMR": "5118831934218175182",
    "LTC": "5116097208281727613",
    "TON": "5118848783374877420",
    "SOL": "4972383689842362284",
    "TRX": "5276101653638958765",
    "BNB": "5242272884897888500",
    "MATIC": "5287612677093339691",
    "POL": "5287612677093339691",
    "ARB": "5440552944925690381",
    "XRP": "5440752630840182514",
}

# Unicode symbol shown BEFORE the label on inline buttons (buttons can't use custom emoji).
COIN_SYMBOLS: dict[str, str] = {
    "BTC": "₿", "ETH": "Ξ", "USDT": "₮", "USDC": "Ⓤ", "XMR": "ɱ", "LTC": "Ł",
    "BNB": "◈", "SOL": "◎", "MATIC": "⛓", "POL": "⛓", "ARB": "⬢", "XRP": "✕",
    "TON": "◉", "TRX": "⨯", "DOGE": "Ð", "ADA": "₳",
}

# Network code → underlying-chain coin key (for its custom emoji / symbol).
NETWORK_TO_COIN: dict[str, str] = {
    "ERC20": "ETH", "ERC-20": "ETH",
    "TRC20": "TRX", "TRC-20": "TRX",
    "BEP20": "BNB", "BEP-20": "BNB",
    "SOL": "SOL",
    "MATIC": "MATIC", "POL": "POL",
    "ARB": "ARB",
    "TON": "TON",
}


def coin_symbol(code: str) -> str:
    """Unicode button symbol for a coin/network code (empty string if none)."""
    if not code:
        return ""
    c = code.strip().upper()
    if c in COIN_SYMBOLS:
        return COIN_SYMBOLS[c]
    chain = NETWORK_TO_COIN.get(c) or NETWORK_TO_COIN.get(c.replace("_", "-"))
    return COIN_SYMBOLS.get(chain, "") if chain else ""


def coin_emoji_id(code: str) -> str:
    """Custom emoji id for a coin/network code (empty string if none)."""
    if not code:
        return ""
    c = code.strip().upper()
    if c in COIN_EMOJIS:
        return COIN_EMOJIS[c]
    chain = NETWORK_TO_COIN.get(c) or NETWORK_TO_COIN.get(c.replace("_", "-"))
    return COIN_EMOJIS.get(chain, "") if chain else ""


def build_custom_emoji_entity(text_prefix: str, emoji_key: str) -> "MessageEntity":
    """Build a MessageEntity for a custom emoji at the given prefix length. Use with text = prefix + EMOJI_PLACEHOLDER + rest."""
    from telegram import MessageEntity

    return MessageEntity(
        type=MessageEntity.CUSTOM_EMOJI,
        offset=len(text_prefix),
        length=len(EMOJI_PLACEHOLDER),
        custom_emoji_id=CUSTOM_EMOJIS[emoji_key],
    )


def with_emoji_header(emoji_key: str, message: str, prefix: str = " ") -> tuple[str, list["MessageEntity"]]:
    """Return (text, entities) for a message with a premium emoji header. Use for send_message / edit_message_text."""
    if emoji_key not in CUSTOM_EMOJIS:
        return message, []
    text = prefix + EMOJI_PLACEHOLDER + " " + message
    entities = [build_custom_emoji_entity(prefix, emoji_key)]
    return text, entities
