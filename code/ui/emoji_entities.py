"""
Safe premium emoji message builder for Shop Bot and Admin Bot only.
Use this helper for all custom-emoji messages to avoid Entity_text_invalid (offset/length).
Controller bots (customer AdBots) must NOT use this; they use Unicode emojis only.
"""
from telegram import MessageEntity

from .emojis import CUSTOM_EMOJIS

# Visible placeholder: always length 2 (UTF-16 code units). Do not change.
PLACEHOLDER = "▫️"


def build_emoji_message(label: str, emoji_key: str) -> tuple[str, list[MessageEntity]]:
    """
    Returns (text, entities) safe for Telegram.
    Ensures placeholder length and offset are always correct.
    Use only in Shop Bot and Admin Bot. Not in controller/customer bots.
    """
    if emoji_key not in CUSTOM_EMOJIS:
        return label, []
    text = f"{PLACEHOLDER} {label}"
    entity = MessageEntity(
        type=MessageEntity.CUSTOM_EMOJI,
        offset=0,
        length=len(PLACEHOLDER),
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
    Payment message with the payment emoji at start and the countdown emoji on the validity line.
    body_markdown must contain PLACEHOLDER exactly once for the 'Address valid for 12 hours' line.
    Returns (text, entities) for edit_message_text(..., parse_mode="MarkdownV2", entities=entities).
    """
    ph = PLACEHOLDER
    if ph not in body_markdown or body_markdown.count(ph) != 1:
        return body_markdown, []
    full_text = f"{ph} {body_markdown}"
    time_offset = len(ph) + 1 + body_markdown.find(ph)
    entities = [
        MessageEntity(
            type=MessageEntity.CUSTOM_EMOJI,
            offset=0,
            length=len(ph),
            custom_emoji_id=CUSTOM_EMOJIS["payment"],
        ),
        MessageEntity(
            type=MessageEntity.CUSTOM_EMOJI,
            offset=time_offset,
            length=len(ph),
            custom_emoji_id=CUSTOM_EMOJIS["countdown"],
        ),
    ]
    return full_text, entities
