# Broadcast System — End-to-End Verification Audit

**Date:** 2026-02-13  
**Scope:** Admin Bot broadcast feature (segment selection, delivery, formatting, media, safety).

---

## 1. User collection & segment data

### Where user IDs come from

- **No global “broadcast user list” file.** Segments are computed at send time from:
  - **AdBot config** (`data/user/*.json` via `load_adbot()`): each bot has `authorized: [user_id, ...]`.
  - **Orders** (`shop` storage): `completed` orders have `user_id`; used for paying/non_purchasing/active_plan/expiry_soon.
- **Persistence:** `authorized` is stored in per-bot JSON under `config.DATA_USER_DIR`; orders in shop storage. Both survive restarts.
- **Shop Bot /start:** Does **not** write to any shared broadcast list. User IDs from Shop appear only in **orders** when they create an order. So:
  - **all_users** = union of `authorized` across all AdBots + `ADMIN_USER_ID`. Users who only use Shop and never /start an AdBot are **not** in `all_users`.
  - **paying_users** = users in `all_users` who have at least one `completed` order.
  - **non_purchasing_users** = users in `all_users` with no completed order.
- **Controller/User bot:** When a user is added to a bot (creation flow or `/add`), their ID is in that bot’s `authorized`; creation and `/add` both call `save_adbot` / `_save_bot_config`, so IDs persist.

### Duplicates and correctness

- **No duplicate IDs in segments:** `all_uids` is built with a `set()`. Other segments are derived from that set or from a single pass with `break`, so each user appears at most once.
- **Segment definitions:**
  - **all_users:** All `authorized` across bots + admin. ✅
  - **paying_users:** `u in all_uids and u in completed_user_ids`. ✅
  - **non_purchasing_users:** `u in all_uids and u not in completed_user_ids`. ✅
  - **active_plan_users:** In `authorized` for some bot with `valid_till >= today`. ✅
  - **expiry_soon_users:** In `authorized` with `valid_till` in [today, today+7]. ✅

### Gaps

1. **Shop-only users:** Anyone who only ever talks to the Shop Bot (no AdBot /start) is not in any segment. There is no “shop visitors” or “order creators (any status)” segment.
2. **Optional enhancement:** A dedicated persistent list (e.g. “users who ever /start on Shop”) could be added if you want to broadcast to Shop-only users.

**Verdict:** User IDs used for broadcast are persisted correctly (AdBot + orders). Segments are consistent and deduplicated. No separate global broadcast list; design is “authorized + orders only.”

---

## 2. Message format preservation

### Current behavior (before fixes)

- Broadcast send path used only `context.bot.send_message(chat_id=user_id, text=text)`.
- **No `parse_mode`** was passed, so Markdown/HTML from the admin were sent as plain text.
- **No `entities`** were passed, so bold/italic/underline/code/links from the admin message were lost.

### Implemented fix

- Broadcast now uses **copy_message** when available (`context.bot.copy_message(chat_id, from_chat_id, message_id)`) so the admin’s message is copied as-is to each recipient, preserving all formatting and media.
- Fallback when `copy_message` is not available: **send_photo** / **send_video** / **send_document** with `caption` and `caption_entities`, or **send_message** with `text` and `entities`, so bold/italic/links/captions are preserved.

**Verdict:** Formatting is preserved (via copy_message or entity-aware send).

---

## 3. Media broadcast support

### Current behavior (before fixes)

- Only the **text** of the admin message was used (`update.message.text`).
- **Photo, video, document** were ignored. Media-only or caption-only messages were not fully supported (e.g. photo + caption would send only the caption as plain text).

### Implemented fix

- **copy_message** is used when available so photo, video, document, and caption (with formatting) are all preserved.
- Fallback: branch on content type — `send_photo` / `send_video` / `send_document` with `caption` and `caption_entities`, and `send_message` for text-only with `entities`. **MessageHandler** for `filters.PHOTO | filters.VIDEO` was added so photo/video messages are handled by the broadcast flow.

**Verdict:** Media and captions are supported.

---

## 4. Delivery safety

### Rate limiting

- **Applied:** `BROADCAST_RATE_LIMIT_PER_MIN` (default 30). `interval = 60.0 / max(1, rate_per_min)`; `await asyncio.sleep(interval)` between each send. ✅

### Failure handling

- **Per-recipient try/except:** Each send is in a try/except; on exception we log and increment `failed`, then continue. Broadcast does not stop on first failure. ✅
- **Logging:** `logger.warning("Broadcast to %s failed: %s", user_id, e)`. ✅
- **Counts:** `sent` and `failed` are tracked and reported; `broadcast_log_append(segment, len(uids), sent, failed)` writes to `data/broadcast_log.json`. ✅

### Edge cases

- Blocked bot / user deactivated / chat not found: all result in exception, counted as `failed`, no crash. ✅

**Verdict:** Delivery safety (rate limit, failure handling, logging, counts) is in place.

---

## 5. Admin flow validation

### Segment selection and count

- **cc_broadcast** shows segment buttons. **bc_seg:X** calls `broadcast_segment_user_ids(segment)` and shows “Segment: X, Recipients: N. Send? [Confirm] [Cancel].” ✅
- Count is correct (same function used for preview and for send).

### Confirm and “next message”

- **bc_confirm:X** sets `context.user_data["broadcast_segment"] = segment` and prompts “Send your message now (or /cancel).” ✅
- The **next** message from the admin (handled by `on_message`) is the one that triggers the broadcast when `ud.get("broadcast_segment")` is set. ✅

### State reset

- After sending, `ud.pop("broadcast_segment", None)` is effectively done by the code that reads and then uses `broadcast_segment` (segment is popped when entering the block). So state is cleared after one broadcast. ✅
- **/cancel** explicitly clears `broadcast_segment`. ✅

### Edge case: empty or media-only message

- If the admin sends a message with **no text and no media**, the flow now replies: “Send a message with text, photo, video, or document to broadcast.” and keeps `broadcast_segment` in state so the admin can retry. Media-only (e.g. photo with no caption) is supported via copy_message or send_photo/send_video/send_document.

**Verdict:** Admin flow (segment → count → confirm → next message = content → state reset) is correct. Empty/media-only handling is fixed by preserving or rejecting non-text content.

---

## 6. Summary and suggested fixes

### Confirmed

- User IDs for segments are taken from **persistent** sources (AdBot `authorized`, orders). No duplicate IDs in segment lists.
- Segment logic for **all_users, paying_users, active_plan_users, expiry_soon_users, non_purchasing_users** is correct.
- **Rate limiting**, **per-recipient failure handling**, **logging**, and **sent/failed counts** with **broadcast_log_append** are in place.
- **Admin flow:** segment selection, recipient count, Confirm, next message as content, and state reset work as intended.

### Issues and fixes

| # | Issue | Fix (implemented or suggested) |
|---|--------|----------------------------------|
| 1 | Formatting (bold/italic/links/entities) not preserved | **Done:** copy_message when available; else send_message with entities / send_photo etc. with caption_entities. |
| 2 | Media (photo/video/document) and captions not supported | **Done:** copy_message or send_photo/send_video/send_document + caption/caption_entities; PHOTO/VIDEO handler added. |
| 3 | Empty or media-only admin message sent as empty text | **Done:** Reject empty content with a prompt and keep state; media-only sent via copy_message or media APIs. |
| 4 | Shop-only users never in any segment | Optional: add a “shop_visitors” or “order_creators” list persisted on Shop /start or order creation if you need to broadcast to them. |

### Implementation notes

- **copy_message(chat_id, from_chat_id, message_id)** (Telegram Bot API) copies the full message (text + entities + media + caption) from admin chat to each user. Preferred if available in your PTB version.
- If not using copy_message: for text use `send_message(..., entities=update.message.entities, parse_mode=...)`; for media use `send_photo`/`send_video`/`send_document` with `caption` and `caption_entities` from the admin message.

---

**Conclusion:** The broadcast system is structurally sound (segments, persistence, rate limiting, logging, admin flow). The main gaps were **format preservation** and **media support**; both are addressed by using **copy_message** or by sending with **entities** and media-specific APIs. Optional improvement: a dedicated list for Shop-only users if you want to include them in broadcasts.
