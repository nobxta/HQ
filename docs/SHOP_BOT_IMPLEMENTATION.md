# Shop Bot Implementation Guide

This document describes the production-grade Shop Bot layer for self-service AdBot purchases and renewals, integration with the existing creation pipeline, storage schemas, and deployment checklist.

---

## 1. System Structure (Three Bots)

| Bot | Role |
|-----|------|
| **Admin Bot** | Manual AdBot creation (plan_name=Custom, renewal_price=admin-entered), session management, maintenance, Pending Shop Orders / Recreate. |
| **User Controller Bot** | Per-customer AdBot: run/stop posting, logs, config, validity, renewal reminders. Stores `plan_name`, `renewal_price`, `plan_mode`, `session_count`. |
| **Shop Bot** | Self-service: Buy AdBot, plan selection, crypto payment, renewal purchase. Enqueues creation jobs into the same queue as admin. |

---

## 2. Folder Structure (Shop Bot Modules)

```
code/
  shop/
    __init__.py       # Exports storage + payment
    storage.py        # plans.json + orders.json load/save, create_order, create_renewal_order
    payment.py        # create_invoice, check_payment_status (NOWPayments stub)
    handlers.py       # Shop Bot PTB handlers: /start, Buy flow, renewal, recreate_pending_order
    workers.py        # payment_polling_worker, renewal_scheduler_worker, order_recovery_on_startup, extend_valid_till_for_bot
  admin_ptb.py        # + Pending Orders menu, shop_recreate callback, result consumer order update + shop bot edit
  admin.py            # + plan_name, renewal_price, plan_mode, session_count in creation entry
  bot_ptb.py          # + edit_message_with_bot, send_message_with_bot_return_id
  notify.py           # + notify_edit_message, notify_send_to_chat (optional bot_token)
data/
  plans.json          # Predefined purchasable plans (starter / enterprise)
  orders.json         # Orders list (purchase + renewal)
```

---

## 3. Storage Schemas

### plans.json

```json
{
  "starter": [
    { "id": "bronze", "sessions": 1, "cycle": 3600, "gap": 5, "price_week": 30, "price_month": 70 },
    { "id": "silver", "sessions": 2, "cycle": 3600, "gap": 5, "price_week": 55, "price_month": 115 }
  ],
  "enterprise": [
    { "id": "basic", "sessions": 3, "cycle": 900, "gap": 5, "price_week": 50, "price_month": 199 }
  ]
}
```

### orders.json

Top-level key `orders`; each order:

| Field | Description |
|-------|-------------|
| order_id | Unique id (short uuid) |
| user_id | Telegram user (chat) id |
| plan_id | Plan id from plans.json |
| plan_name | Display name (e.g. "Starter Bronze") |
| plan_mode | "starter" \| "enterprise" |
| duration_days | 7 or 30 |
| amount_usd | Price |
| payment_id | Provider payment/invoice id |
| currency | BTC, ETH, USDT, etc. |
| status | payment_waiting \| paid \| creating \| completed \| failed \| pending_creation |
| bot_token | Set after user provides; stored on completion |
| created_at, paid_at | ISO timestamps |
| created_bot_username | Set when creation completes |
| invoice_url | Payment link |
| awaiting_field | "name" \| "token" when paid, waiting for user input |
| bot_name | From user after payment |
| order_type | "renewal" for renewal orders |
| parent_order_id | For renewal orders, reference to original order |

---

## 4. Handler Flow Diagrams

### Buy flow

```
/start → [Buy AdBot] [FAQ] [Support]
  → [Starter] [Enterprise]
  → Plan list from plans.json
  → [7 Days] [30 Days]
  → Crypto (BTC, ETH, …)
  → Create invoice, create_order(status=payment_waiting), show link
  → Payment polling: status confirmed
  → Update order paid, awaiting_field=name, send "Enter Bot Name"
  → User: name → awaiting_field=token, "Send Bot Token"
  → User: token → validate; if free_sessions < need → pending_creation + alert admin; else submit_create_job(…)
  → Result consumer: order completed/failed, edit message (Shop Bot), update order
```

### Renewal flow

```
24h before expiry: renewal_scheduler sends message with [Renew Now] (callback_data=shop_renew:order_id)
  → shop_renew:order_id → [7 Days] [30 Days]
  → shop_renew_dur:order_id:7|30 → Crypto
  → shop_renew_crypto:… → create_renewal_order, create_invoice, show link
  → Payment polling: renewal order confirmed → extend_valid_till_for_bot(bot_token, duration_days), notify user
```

### Pending creation (insufficient sessions)

```
Creation not enqueued; order status = pending_creation; bot_name, bot_token, bot_username stored on order.
Admin: Pending Shop Orders → list → [Recreate] per order.
  → recreate_pending_order(order_id): send "Creating your AdBot…" to buyer via Shop Bot, submit_create_job(buyer_chat_id, msg_id, form, SHOP_BOT_TOKEN)
```

---

## 5. Integration with Creation Queue

- **Same queue:** `_create_job_queue` in `admin.py`; both Admin wizard and Shop Bot call `submit_create_job(chat_id, msg_id, form, notification_bot_token=…)`.
- **Admin:** `notification_bot_token=None` → progress/result edited with Admin Bot.
- **Shop:** `notification_bot_token=SHOP_BOT_TOKEN` → progress/result edited with Shop Bot in buyer chat.
- **Form from Shop:** Includes `order_id`, `source="shop"`, `plan_name`, `renewal_price`; worker and result consumer unchanged; result consumer updates order and uses Shop Bot to edit when `source=="shop"` or `order_id` present.
- **No duplicate creation:** Order status set to `creating` when job is submitted; on completion/failure status updated; recovery on startup marks stuck `creating` as `failed`.

---

## 6. Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| Insufficient sessions at payment | Order → pending_creation; alert admin; Recreate in admin when sessions added. |
| Invalid bot token (after payment) | Ask again in handlers; no order status change until valid. |
| Payment confirmed but worker crash | Order recovery on startup marks `creating` as failed; support can use Recreate if needed. |
| Duplicate payment callback | Idempotent: only transition to paid/creating once; check status before update. |
| Renewal: parent order without bot_token | Only completed orders have bot_token; renewal only for completed orders. |

---

## 7. Config and Environment

- **SHOP_BOT_TOKEN** — Telegram bot token for the Shop Bot (required for Shop and renewal).
- **DATA_PLANS_FILE** — `data/plans.json` (set in config).
- **DATA_ORDERS_FILE** — `data/orders.json` (set in config).

Admin creation: `plan_name="Custom"`, `renewal_price` from new admin wizard step (after valid_till).

---

## 8. Implementation Checklist

- [x] plans.json and loader
- [x] orders.json and order CRUD + create_renewal_order
- [x] Shop Bot handlers: /start, Buy (plan type → plan → duration → crypto → invoice), payment_waiting → paid → name/token → create
- [x] Payment polling worker (payment_waiting → confirmed; renewal orders → extend_valid_till)
- [x] Order recovery on startup (creating → failed)
- [x] Renewal scheduler (24h reminder + Renew Now button)
- [x] Renewal flow: shop_renew → duration → crypto → renewal order → on paid extend valid_till
- [x] Creation queue integration: submit_create_job with notification_bot_token, result consumer updates order and edits with Shop Bot
- [x] Admin: plan_name/renewal_price in wizard and in creation entry
- [x] Admin: Pending Shop Orders + Recreate (recreate_pending_order)
- [x] bot_ptb + notify: edit/send with optional bot_token; send_message_with_bot_return_id for Recreate
- [ ] NOWPayments real API in payment.py (replace stub)
- [ ] Optional: persist job queue for full restart recovery

---

## 9. Running the System

1. Set **SHOP_BOT_TOKEN** in `.env` (and ADMIN_BOT_TOKEN, etc.).
2. Run `python main.py`: starts Admin Bot, Shop Bot (thread), result consumer, payment polling, renewal scheduler, order recovery once.
3. Shop Bot: users open the bot, tap Buy AdBot, complete plan/duration/crypto, pay; after confirmation they send Bot Name and Bot Token; creation runs via the same worker as admin.
4. Admin: Create AdBots (with renewal price step), Manage Sessions, Manage AdBots, **Pending Shop Orders** (Recreate for pending_creation).

Same creation pipeline is used for both admin-created and shop-purchased AdBots; Shop Bot is the payment and order intake layer only.
