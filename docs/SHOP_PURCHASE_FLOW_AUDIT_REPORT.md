# Shop Purchase → AdBot Creation Flow — Audit Report

**Date:** 2025-02-14

## Summary

| Check | Status |
|-------|--------|
| **AdBot purchase pipeline integrity** | OK |
| **Premium emoji rendering** | OK |
| **Message formatting** | OK |

---

## 1. Payment confirmation UX

- **Message 1 — Transaction Confirmation Screen** is shown when payment becomes `paid`:
  - Premium emoji at start (`payment_confirmed` / EMOJI_PAYMENT_CONFIRMED)
  - Plan, Duration, Date
  - Transaction ID (payment_id or payout_hash from API)
  - View on Explorer (link to nowpayments.io/payment/{id})
  - "Press Proceed to continue setup." + inline button **[ Proceed ]**
- Wizard does **not** start automatically; it starts only after the user presses **Proceed**.

## 2. Wizard after Proceed

- **Proceed** callback: `shop_proceed_setup:{order_id}` → sets `awaiting_field=name`, sends Step 5 with premium emoji.
- **Step 5:** "Enter your AdBot name" — sent with `build_emoji_message(STEP5_MESSAGE, "trust")` and `entities` (no literal `**`).
- **Step 6:** "Send your Bot Token from @BotFather" — sent with `build_emoji_message(STEP6_MESSAGE, "keyboard")` and `entities`.
- All wizard messages use plain text or entities only; no `parse_mode` that would show `**` literally.

## 3. Premium emoji usage

- **payment_confirmed** added in `code/ui/emojis.py` for the transaction confirmation screen.
- **Confirmation screen** built with `build_emoji_message(..., "payment_confirmed")` in workers.
- **STEP5 / STEP6** use `build_emoji_message(..., "trust")` and `..., "keyboard")` in handlers.
- **notify** and **bot_ptb** support an `entities` parameter for `edit_message` and `send_message` so premium emojis are sent correctly.

## 4. Creation pipeline

- **temppay.json** → order appended to **orders.json** (`status: paid`, `awaiting_field: proceed`); log: `[CREATE_PIPELINE] temppay→order OK`.
- **orders.json** → **submit_create_job** → `_create_job_queue.put(...)`; log: `[CREATE_PIPELINE] order→job queued`.
- **Create worker** picks job; log: `[CREATE_PIPELINE] job→worker started`.
- **user JSON** created in `data/user/<name>.json` via `save_user_data`; log: `[CREATE_PIPELINE] user JSON created`.
- **order_id** is kept in the form and through the pipeline; creation result is returned to the Shop user via the progress/result consumer.

## 5. Message formatting

- STEP5_MESSAGE and STEP6_MESSAGE no longer use `**`; they are plain text.
- All sends that use these messages use `entities` from `build_emoji_message` and do not rely on Markdown, so `**` is never shown literally.

## 6. Files changed

- `code/ui/emojis.py` — added `payment_confirmed`.
- `code/shop/payment.py` — `get_payment_details` returns `payout_hash`; used for tx display and explorer.
- `code/bot_ptb.py` — `entities` support in `edit_message_with_bot`, `send_message_with_bot`, `send_message_with_bot_return_id`.
- `code/notify.py` — `entities` support in `notify_edit_message`, `notify_send_to_chat`.
- `code/shop/workers.py` — `build_payment_confirmation_screen`, confirmation screen on paid (no auto STEP5); STEP5/STEP6 text without `**`; pipeline log.
- `code/shop/handlers.py` — Proceed callback `shop_proceed_setup:{order_id}`; STEP5/STEP6 sent with entities; DEV flow uses confirmation screen + Proceed.
- `code/admin_ptb.py` — pipeline log in `submit_create_job`.
- `code/admin.py` — pipeline logs in create worker and after `save_user_data`.
