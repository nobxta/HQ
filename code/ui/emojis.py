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
}


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
