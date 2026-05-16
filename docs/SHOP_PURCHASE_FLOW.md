# Shop Bot — How Purchase Works (User Flow)

This doc describes what the buyer sees and does when purchasing an AdBot via the Shop Bot.

## Steps (what the user clicks and sees)

1. **Start** — User sends `/start`. Sees: Welcome + [Buy AdBot] [FAQ] [How it works] [Support].

2. **Step 1 — Plan category** — Clicks "Buy AdBot". Sees: "Choose Plan Category" with [Starter Plans] [Enterprise Plans].

3. **Step 2 — Compact plan list** — Chooses a category. Sees e.g. "Starter Plans" with a list (Bronze — 1 Session — $30/week, Silver — 2 Sessions — $55/week, …) and "Select a plan:" with [Bronze] [Silver] [Gold] [Diamond] [Back].

4. **Step 3 — Full plan detail** — Taps a plan. Sees full details (Sessions, Cycle, Gap, Weekly/Monthly prices) with [Buy Weekly] [Buy Monthly] [Back].

5. **Step 4 — Payment** — Taps Buy Weekly or Buy Monthly. Sees "Step 4 — Payment", amount, and crypto selection. Chooses cryptocurrency (BTC, ETH, etc.).

6. **Payment message** — After choosing crypto, the user gets a message with:
   - Order ID, plan, duration, amount, crypto
   - **Send EXACTLY:** amount + currency
   - **Address:** payment address
   - Invoice expiry
   - "Waiting for payment confirmation..."
   - "After payment: you'll enter your Bot Name and Bot Token (from @BotFather), then we create your AdBot and send you the link."

7. **Payment confirmed** — When payment is detected and confirmed:
   - The payment message is updated to: "✅ Payment confirmed. Step 5 — Enter your Bot Name below. Step 6 — Then send your Bot Token from @BotFather. We'll create your AdBot and send you the link."
   - User also gets a DM: "Step 5 — Payment confirmed! Enter your Bot Name (e.g. MyAdBot). Next you'll send your Bot Token from @BotFather."

8. **Step 5 — Bot name** — User sends a message with the bot name (e.g. MyAdBot). Bot replies: "Step 6 — Send your Bot Token from @BotFather. We'll create your AdBot and send you the link when ready."

9. **Step 6 — Bot token** — User sends the bot token from @BotFather. Bot validates it, then: "Creating your AdBot…" and the create job runs. On success, the user gets the AdBot link and can use it.

## Validity

- **7-day plan:** Validity is set to (today + 7 days) as a date; "Validity" in the AdBot shows "X days left" using **date-only** comparison so the purchase day counts as day 1 and the user sees the correct number of days (e.g. 7 days on purchase day).
- **Last renewal:** The user JSON file stores `last_renewal_at` (ISO timestamp), `last_renewal_days`, and `renewal_history` (array of {at, days, order_id, source}) so you can see when they last renewed.

## In-bot "How it works"

From the main menu, the user can tap **How it works** to see a short list of the same steps (category → plan list → plan detail → Buy Weekly/Monthly → pay → enter name → send token → AdBot created). **FAQ** mentions AdBot and links to "How it works".
