# UI utilities: premium emoji (Shop Bot & Admin Bot only). Controller bots use Unicode only.
from .emoji_entities import PLACEHOLDER, build_emoji_message
from .emojis import CUSTOM_EMOJIS

__all__ = [
    "CUSTOM_EMOJIS",
    "PLACEHOLDER",
    "build_emoji_message",
]
