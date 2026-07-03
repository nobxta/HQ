"""
Premium custom-emoji builder for Telethon (customer AdBot panel, code/users.py).

Mirrors code/ui/emoji_entities.py (the PTB/Shop Bot builder) but targets Telethon's
`formatting_entities=` kwarg and MTProto's MessageEntityCustomEmoji, whose id field is
`document_id` (int) — NOT PTB's `custom_emoji_id` (str). Reuses the same CUSTOM_EMOJIS /
EMOJI_FALLBACKS registry so there is one source of truth across both libraries.

Each custom emoji is overlaid on the panel's real Unicode glyph, so non-Premium users
see exactly what they see today.
"""
from telethon import Button
from telethon.extensions import markdown as tl_markdown
from telethon.tl.types import MessageEntityCustomEmoji, TypeMessageEntity

from .emoji_entities import fallback_glyph, u16len
from .emojis import CUSTOM_EMOJIS


def build_panel_message(emoji_key: str, markdown_body: str) -> tuple[str, list[TypeMessageEntity]]:
    """
    (text, formatting_entities) for Telethon event.edit/respond/reply.

    markdown_body may use Telethon markdown ('**bold**', '`code`', '[text](url)') —
    it's parsed into entities via telethon.extensions.markdown, then a leading custom
    emoji entity (overlaid on the panel's existing Unicode glyph) is spliced in front.

    Call with parse_mode=None and formatting_entities=entities. Do not also pass
    parse_mode="md"/"html" — combining parsed markdown with explicit entities double-parses
    the text.
    """
    glyph = fallback_glyph(emoji_key)
    plain, parsed_entities = tl_markdown.parse(f"{glyph} {markdown_body}")
    entities: list[TypeMessageEntity] = list(parsed_entities)
    if emoji_key in CUSTOM_EMOJIS:
        entities.insert(0, MessageEntityCustomEmoji(
            offset=0,
            length=u16len(glyph),
            document_id=int(CUSTOM_EMOJIS[emoji_key]),
        ))
    return plain, entities


def panel_button(label: str, callback_data, emoji_key: str) -> Button:
    """Telethon inline callback button with a premium custom-emoji icon.

    Uses MTProto KeyboardButtonStyle.icon (Button.inline(icon=...)) — the native
    equivalent of the Bot API's icon_custom_emoji_id used by the Shop Bot. When the
    key has a custom emoji id, the label is kept clean (the icon renders the glyph);
    otherwise the Unicode fallback glyph is prepended so the button never loses its icon.
    """
    eid = CUSTOM_EMOJIS.get(emoji_key)
    if eid:
        return Button.inline(label, callback_data, icon=int(eid))
    return Button.inline(f"{fallback_glyph(emoji_key)} {label}", callback_data)
