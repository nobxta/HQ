# Shop Bot Payment — Test Steps and Verification

Use this to confirm real wallet addresses and crypto amounts from NOWPayments.

---

## 1. Environment

- In project root `.env` set:
  - `NOWPAYMENTS_API_KEY=<your_live_or_sandbox_key>`
  - `NOWPAYMENTS_BASE_URL=https://api.nowpayments.io/v1` (or sandbox URL)
- Do **not** set `PAYMENT_DEV_MODE` (or leave empty) so the app uses the real API.
- Start the app: `python main.py`. If the key is missing or `"your_api_key"`, startup **fails** with a clear error.

---

## 2. Invoice creation

- In Telegram, open the Shop Bot → Buy AdBot → choose plan → duration → crypto.
- Check logs for:
  ```
  [PAYMENT] Created invoice: order_id=... payment_id=... address=... amount=... ...
  ```
- If the provider response has no `pay_address`, logs show:
  ```
  [PAYMENT] Provider response missing pay_address for order_id=... payment_id=...
  ```
  and the order is set to `invoice_failed`; the user sees "Invoice creation failed. Please try again or contact support."

---

## 3. Address and amount in Telegram

- The payment message must show:
  - **Order:** &lt;order_id&gt;
  - **Plan / Duration / Amount / Crypto**
  - **Send EXACTLY:** &lt;pay_amount&gt; &lt;pay_currency&gt;
  - **Address:** &lt;real wallet address from provider&gt;
  - **Note:** ... valid for &lt;expiry&gt;
  - Optional: payment link
- With a valid API key, the address must **not** be "STUB" or "STUB_ADDRESS". If you see that, you are in `PAYMENT_DEV_MODE=1` with no key.

---

## 4. Address stored in orders

- After creating an invoice, open `data/orders.json`.
- Find the order by `order_id`.
- It must contain:
  - `payment_id`
  - `pay_address` (real address)
  - `pay_amount` (crypto amount)
  - `pay_currency`
  - `invoice_expiry`

---

## 5. Payment detection

- The payment polling worker uses **only** `payment_id`: it calls `GET {BASE_URL}/payment/{payment_id}`.
- No parsing of invoice URL or link; confirmation is by `payment_id` status.

---

## 6. Optional test script

From project root:

```bash
python -c "
from code import config
from code.shop.payment import validate_payment_config, create_invoice

# Fails if SHOP_BOT_TOKEN set and NOWPAYMENTS_API_KEY missing (and not PAYMENT_DEV_MODE)
validate_payment_config()

# Optional: create one invoice (uses real API if key set)
r = create_invoice(amount_usd=10, currency='usdt', order_id='test-order-1', description='Test')
if r.get('_invoice_failed'):
    print('FAIL: invoice_failed')
else:
    print('OK: payment_id=', r.get('payment_id'), 'address=', (r.get('pay_address') or '')[:20]+'...', 'amount=', r.get('pay_amount'), r.get('pay_currency'))
"
```

- With valid API key: expect `OK: payment_id=... address=... amount=...`
- With no key and no `PAYMENT_DEV_MODE`: `validate_payment_config()` raises.

---

## 7. Stub mode (development only)

- To run Shop Bot without a real key, set in `.env`: `PAYMENT_DEV_MODE=1`
- Then stub invoices are used (address "STUB_ADDRESS"); **do not use in production.**
