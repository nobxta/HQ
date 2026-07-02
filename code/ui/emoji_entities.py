"""
Safe premium emoji message builder for Shop Bot and Admin Bot only.
Use this helper for all custom-emoji messages to avoid Entity_text_invalid (offset/length).
Controller bots (customer AdBots) must NOT use this; they use Unicode emojis only.

Each custom emoji is overlaid on a real Unicode fallback glyph, so if the client
cannot resolve the custom_emoji_id (e.g. the bot isn't permitted to use that set),
the user still sees a fitting emoji instead of a blank placeholder.
"""
from telegram import MessageEntity

from .emojis import CUSTOM_EMOJIS

# Neutral placeholder (2 UTF-16 code units) used when a key has no specific fallback.
PLACEHOLDER = "▫️"

# Per-key Unicode fallback glyph shown under each custom emoji. Any length is fine —
# the entity length is computed in UTF-16 code units at build time.
EMOJI_FALLBACKS: dict[str, str] = {
    "wave": "👋",
    "shop": "🛒",
    "plans": "📦",
    "plan_info": "🧾",
    "billing": "📅",
    "payment": "💳",
    "countdown": "⏳",
    "queue": "⏳",
    "waiting_alt": "🔄",
    "processing": "⚙️",
    "ready": "✅",
    "failed": "❌",
    "declined": "🚫",
    "delete": "🗑",
    "link": "🔗",
    "pointer": "👉",
    "payment_confirmed": "✅",
    "cart": "🛒",
    "time": "⏳",
    "error": "❌",
    "cancelled": "🚫",
    "trust": "🔒",
    "rocket": "🚀",
    "crypto": "🪙",
    # Plans-list title / tiers / trailing pointer
    "title_starter": "👑",
    "title_enterprise": "🔥",
    "tier_bronze": "🥉",
    "tier_silver": "🥈",
    "tier_gold": "🥇",
    "tier_diamond": "💎",
    "tier_basic": "⭐",
    "tier_pro": "⭐",
    "tier_elite": "👑",
    "choose_pointer": "↘️",
    "invoice_wallet": "👛",
    "invoice_clock": "🕖",
}


def u16len(s: str) -> int:
    """Length of s in UTF-16 code units (what Telegram entity offsets/lengths use)."""
    return len(s.encode("utf-16-le")) // 2


def fallback_glyph(emoji_key: str) -> str:
    """Unicode fallback glyph for a custom-emoji key (PLACEHOLDER if none defined)."""
    return EMOJI_FALLBACKS.get(emoji_key, PLACEHOLDER)


def build_emoji_message(label: str, emoji_key: str) -> tuple[str, list[MessageEntity]]:
    """
    Returns (text, entities) safe for Telegram: a leading custom emoji overlaid on a
    real Unicode fallback glyph, then the label.
    Use only in Shop Bot and Admin Bot. Not in controller/customer bots.
    """
    if emoji_key not in CUSTOM_EMOJIS:
        return label, []
    glyph = fallback_glyph(emoji_key)
    text = f"{glyph} {label}"
    entity = MessageEntity(
        type=MessageEntity.CUSTOM_EMOJI,
        offset=0,
        length=u16len(glyph),
        custom_emoji_id=CUSTOM_EMOJIS[emoji_key],
    )
    return text, [entity]


def build_custom_emoji_text(
    text_with_placeholders: str,
    emoji_positions: list[tuple[int, str]],
) -> tuple[str, list[MessageEntity]]:
    """
    Build (text, entities) for Telegram messages with custom emojis.
    text_with_placeholders: full message text containing PLACEHOLDER at each position where an emoji should appear.
    emoji_positions: list of (offset, emoji_key). Each offset must be the start of a PLACEHOLDER in text.
    Returns (text, entities) to pass to send_message(..., entities=entities) or edit_message_text(..., entities=entities).
    """
    entities: list[MessageEntity] = []
    for offset, emoji_key in emoji_positions:
        if emoji_key not in CUSTOM_EMOJIS:
            continue
        entities.append(
            MessageEntity(
                type=MessageEntity.CUSTOM_EMOJI,
                offset=offset,
                length=len(PLACEHOLDER),
                custom_emoji_id=CUSTOM_EMOJIS[emoji_key],
            )
        )
    return text_with_placeholders, entities


def build_payment_message_with_emojis(body_markdown: str) -> tuple[str, list[MessageEntity]]:
    """
    Payment message with the payment emoji at start and the countdown emoji on the validity line,
    each overlaid on a real Unicode fallback glyph.
    body_markdown must contain PLACEHOLDER exactly once (the 'valid for 12 hours' line).
    Returns (text, entities) for edit_message_text(..., parse_mode="MarkdownV2", entities=entities).
    """
    ph = PLACEHOLDER
    if ph not in body_markdown or body_markdown.count(ph) != 1:
        return body_markdown, []
    start_glyph = fallback_glyph("invoice_wallet")  # 👛
    time_glyph = fallback_glyph("invoice_clock")    # 🕖
    body = body_markdown.replace(ph, time_glyph)
    full_text = f"{start_glyph} {body}"
    time_offset = u16len(f"{start_glyph} ") + u16len(body[: body.find(time_glyph)])
    entities = [
        MessageEntity(
            type=MessageEntity.CUSTOM_EMOJI,
            offset=0,
            length=u16len(start_glyph),
            custom_emoji_id=CUSTOM_EMOJIS["invoice_wallet"],
        ),
        MessageEntity(
            type=MessageEntity.CUSTOM_EMOJI,
            offset=time_offset,
            length=u16len(time_glyph),
            custom_emoji_id=CUSTOM_EMOJIS["invoice_clock"],
        ),
    ]
    return full_text, entities
