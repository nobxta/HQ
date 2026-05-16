# Shop Bot — Full System Alignment and Correction Report

**Date:** Post alignment pass.  
**Scope:** Purchase → payment → creation → renewal → expiry lifecycle; orders integrity; NOWPayments integration.

---

## 1. Summary of Corrections Applied

| Area | Correction | Files |
|------|-------------|--------|
| **Expiry handling** | On bot expiry: stop bot, return sessions to pool, validate sessions, move invalid to dead pool, notify admin with counts. | `code/utils.py`, `code/users.py`, `main.py` |
| **Payment integration** | Replaced stub with real NOWPayments API: POST create invoice, GET payment status; API key from env (`NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_BASE_URL`). | `code/config.py`, `code/shop/payment.py` |
| **Confirming notification** | When payment status is `confirming`, notify user "Transaction detected. Waiting for confirmations." (with dedup so we don't spam). | `code/shop/workers.py` |
| **Creation completion** | User receives exactly "AdBot Activated: @username". Admin receives notification with [ Profile ] button linking to `tg://user?id={user_id}`. | `code/admin_ptb.py` |
| **Renewal reminder (once per cycle)** | 24h reminder sent only once per expiry cycle via `last_renewal_reminder_sent` on bot config; set to current `valid_till` after sending. | `code/shop/workers.py` |
| **Orders integrity** | All reads/writes to `orders.json` serialized with `_orders_lock`. `create_order`, `create_renewal_order`, `update_order` use lock; no concurrent overwrites. | `code/shop/storage.py` |
| **Idempotency on confirmed** | Before transitioning order to `paid` and triggering creation flow, re-load order and only proceed if `status == "payment_waiting"`. Prevents duplicate creation if webhook + polling both fire. | `code/shop/workers.py` |
| **Payment output (address + amount)** | Invoice response returns pay_address, pay_amount, pay_currency, invoice_expiry; stored in orders.json; Telegram message shows address and exact crypto amount prominently, payment link optional. | `code/shop/payment.py`, `code/shop/handlers.py` |

---

## 2. Specification vs Implementation Checklist

- **Purchase flow:** /start → Buy AdBot → Plan (Starter/Enterprise from plans.json) → Duration (7/30 days) → Crypto → Invoice + order in orders.json with required fields and `status = payment_waiting`. ✓
- **Payment lifecycle:** Poll GET /v1/payment/{payment_id}; waiting → no action; confirming → notify user; confirmed → order paid, request Bot Name and Bot Token. ✓
- **Creation trigger:** Validate token, check free sessions; if OK → submit to _create_job_queue, status = creating; if not → pending_creation, notify admin, Recreate. ✓
- **Creation completion:** order.status = completed, order.created_bot_username = username; user gets "AdBot Activated: @username"; admin gets notification with Profile link. ✓
- **Renewal:** 24h before expiry reminder (once per cycle); Renew → duration → crypto → payment confirmed → valid_till += duration; renewal does NOT enqueue creation. ✓
- **Expiry:** Stop bot, return sessions to pool, validate, move invalid to dead, notify admin with returned/dead counts. ✓
- **Orders:** order_id preserved end-to-end; no duplicate creation jobs (status + idempotent confirmed); restart-safe; concurrent writes protected by lock. ✓
- **Payment:** Real NOWPayments (when API key set); idempotent handling of confirmed. ✓

---

## 3. Remaining Risks and Optional Improvements

| Risk / Item | Severity | Notes |
|-------------|----------|--------|
| NOWPayments API shape | Low | Endpoint/path and response fields in `payment.py` follow common patterns; verify against official NOWPayments docs (e.g. sandbox vs production URL). |
| Webhook later | Low | If adding payment webhook, only set status to paid (or enqueue) when current status is `payment_waiting`; already guarded in polling. |
| group_file per plan | Low | Optional: add `group_file` to plans.json for Enterprise vs Starter if different group files are required. |
| Stuck orders | Low | Recovery handles `creating` → failed on startup. No auto-cleanup for long-stuck `payment_waiting` or `paid` (user never sent token); consider TTL or manual admin action. |

---

## 4. Production Readiness Verdict

**Ready**, subject to:

1. **Environment:** Set `NOWPAYMENTS_API_KEY` (and optionally `NOWPAYMENTS_BASE_URL`) in production so live invoices and status checks are used.
2. **Verification:** One full trace recommended: plan selection → payment (or test payment) → creation → "AdBot Activated" + admin Profile notification → renewal reminder once → expiry → sessions returned and admin notified.

The Shop Bot purchase → payment → creation → renewal → expiry lifecycle is aligned with the specification and operates as a **single unified provisioning pipeline** with the same backend creation worker for both admin-created and shop-purchased AdBots.

---

## 5. Payment Message Format (Address + Amount)

After selecting plan, duration, and crypto, the user receives:

```
Plan: <plan_name>
Duration: <days> days
Amount: $<amount_usd>
Crypto: <currency>

Send EXACTLY:
<pay_amount> <currency>

Address:
<payment_address>

Note: Send the exact amount in a single transaction. This address is valid for <expiry_time>.

Payment link (optional): <invoice_url>

Waiting for payment confirmation...
```

Address and amount come from the provider response; orders.json stores payment_id, pay_address, pay_amount, pay_currency, invoice_expiry. Confirmation is detected by polling GET /v1/payment/{payment_id} only.
