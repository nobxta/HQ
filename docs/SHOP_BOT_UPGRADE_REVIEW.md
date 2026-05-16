# Shop Bot Upgrade — Technical Compatibility Review

This document evaluates whether the planned **Shop Bot** (user self-service purchase of AdBots) can reuse the existing creation pipeline and identifies required refactors, data gaps, and failure safeguards before deployment.

**Goal:** A single unified AdBot creation pipeline where admin-created and user-purchased bots use the same backend worker; the Shop Bot acts only as payment + order intake.

---

## 1. Compatibility Check

### 1.1 Does the creation pipeline support injecting jobs from the Shop Bot?

**Yes, with one constraint.**

- **Job shape:** The create worker consumes `(chat_id, msg_id, form, progress_queue)` from `_create_job_queue` (see `admin.py` lines 888–894). It does **not** check who enqueued the job; it only needs a valid `form` and a place to send progress/result (`chat_id`, `msg_id`).
- **Shop Bot usage:** The Shop Bot can call the same entry point used by the admin wizard: `submit_create_job(chat_id, msg_id, form)` from `admin_ptb.py` (lines 162–166). Pass the **buyer’s** `chat_id` and the progress message’s `message_id` so progress and result are shown in the buyer’s chat.
- **Constraint — same bot for progress/result:** Progress and result are delivered via `notify.notify_edit_admin_message(chat_id, msg_id, text)`, which uses `bot_ptb.edit_admin_message()` and thus the **admin bot token** (`ADMIN_BOT_TOKEN`). So the message being edited must have been sent by that same bot. **Therefore the Shop flow must use the same bot as the Admin Bot** (one PTB Application, one token): the “Shop” is just another set of handlers (e.g. /start → [Buy AdBot], [FAQ], [Support]) on the same bot. If the Shop were a separate bot token, the result consumer could not edit the buyer’s message; you would need a separate notification path (e.g. Shop Bot–specific queue and consumer).

**Conclusion:** The pipeline supports Shop-originated jobs as long as the Shop runs on the **same bot** as the Admin Bot and passes the buyer’s `(chat_id, msg_id)`.

### 1.2 Is `_create_job_queue` structured for different job types (admin_create vs user_purchase)?

**Partially.**

- There is **no job_type field**. Every item is assumed to be a create job: `(chat_id, msg_id, form, progress_queue)`.
- The worker and result consumer do not branch on “admin” vs “shop”; they only use `form` and the provided `chat_id`/`msg_id`. So **no schema change is strictly required** to support Shop-originated jobs.
- **Optional improvement:** Add a `job_type` or `source` (e.g. `"admin"` | `"shop"`) in the payload or inside `form` for:
  - Logging and metrics
  - Different failure messaging (e.g. “Contact support” for shop vs “Retry in admin” for admin)
  - Future routing (e.g. renewal-only jobs that don’t create a new bot)

**Conclusion:** Current structure is sufficient for a single “create” job type. Adding a `source` in `form` is recommended for observability and messaging, not for pipeline logic.

### 1.3 Are there assumptions that only admin triggers creation?

**No.** The worker and result consumer do not check `ADMIN_USER_ID` or any “admin only” flag. They only:

- Run `_sync_execute_create_adbot(..., form, adbot_data, progress_queue)`.
- Push result to `(chat_id, msg_id, username, form)` and edit that message.

So creation is **caller-agnostic**; the only requirement is that `chat_id`/`msg_id` refer to a message the admin bot can edit (same bot, same chat).

---

## 2. Data Structure Gaps

### 2.1 Form schema (existing vs Shop)

`_core_create_adbot_async` (admin.py) expects in `form`:

| Field            | Source (admin wizard)     | Shop Bot usage                                  |
|------------------|---------------------------|--------------------------------------------------|
| `name`           | User input                | User input (Bot Name) after payment              |
| `bot_token`      | User input                | User input (Bot Token) after payment             |
| `bot_username`   | From `validate_bot_token` | From `validate_bot_token` after user sends token |
| `sessions_count`| User choice               | From plan (e.g. Bronze/Silver/Gold/Diamond)     |
| `cycle`          | User input                | From plan                                       |
| `gap`            | User input                | From plan                                       |
| `valid_till`     | User input (dd/mm/yyyy)   | Compute from purchase (e.g. now + 7 or 30 days) |
| `mode`           | User choice               | From plan (Starter / Enterprise)                 |
| `group_file`     | User choice               | From plan (e.g. fixed or plan-specific file)    |

So the **form schema is compatible**; the Shop only needs to build this dict from plan + user inputs and optional `source: "shop"`.

### 2.2 Persistent storage beyond `adbot.json`

**Current state:** Only `adbot.json` holds bots, free_sessions, dead_sessions, admin_alerts. There is **no** orders table, plans table, or pending-creations store.

**Risks of using only `adbot.json` for Shop:**

- **No order history:** You cannot reliably track “paid but not yet created,” “pending (insufficient sessions),” or “renewal.”
- **No audit trail:** Refunds, disputes, or support need “what did the user buy and when?”
- **No idempotency:** Duplicate webhook or double-click could enqueue the same order twice; without an order id you can’t deduplicate.
- **Restart/crash:** In-memory “pending” orders or in-queue jobs are lost on process restart; you need persistent “pending_creations” or “orders” to retry or notify.

**Recommended persistent structures:**

| Store            | Purpose                                                                 |
|------------------|-------------------------------------------------------------------------|
| **Orders**       | order_id, user_id/chat_id, plan_id, duration, amount, currency, status (pending_payment \| paid \| pending_creation \| creating \| completed \| failed \| refunded), payment_id, created_at, paid_at, bot_token (after user provides), valid_till. |
| **Plans**        | plan_id, name (e.g. Bronze), session_count, cycle, gap, mode, group_file, weekly_price, monthly_price. Can be JSON/config if small. |
| **Pending creations** | order_id, required_sessions, created_at. When payment confirms but free_sessions < required_sessions, create entry and notify admin; when admin adds sessions, “Recreate” can resubmit from this. |

**Minimal viable:** At least an **orders** store (SQLite table or a dedicated `orders.json` with careful append/update) keyed by order_id, with status and timestamps. This enables:

- Idempotency (ignore duplicate payment for same order_id).
- “Payment confirmed but worker crash” recovery (find orders in `paid` or `creating`, resubmit or refund).
- Pending creations (orders in `pending_creation` until sessions available).

---

## 3. Concurrency & Worker Risks

### 3.1 Single create worker

The create worker is a **single** background thread (`_create_worker_loop` in admin.py). It processes one job at a time: `get()` → `load_adbot()` → `_sync_execute_create_adbot(...)` → `_result_queue.put(...)`. So **no concurrent execution** of two create jobs; the next job sees the updated `adbot.json` (fewer free_sessions) after the previous job’s `save_adbot(adbot_data)`.

**Conclusion:** With the current single worker, **session assignment is effectively serialized**; there is no race between two workers over the same session pool.

### 3.2 Session pool locking

- **Current:** No explicit lock. The only writer to `free_sessions` during create is this single worker; main loop and other code paths either read or do other operations (e.g. delete_bot, add sessions) that also do load → modify → save.
- **Risk:** If you later **parallelize** creation (e.g. multiple worker threads or processes), two workers could both `load_adbot()`, both take overlapping sessions from their local copy of `free_sessions`, and both `save_adbot()` — last write wins, leading to duplicate assignment or lost sessions.
- **Recommendation:** Before adding a second creation worker (or any parallel creation path), introduce a **process-local lock** around the “load adbot → assign sessions → save adbot” section (e.g. in the create worker, or in a small helper used only by creation). For the current single worker, no change is strictly required.

### 3.3 Payment polling worker vs create worker

- If a **payment polling worker** (e.g. background task that checks NOWPayments and enqueues create jobs) runs in the same process, it only calls `submit_create_job(...)` and `_create_job_queue.put(...)`. That is thread-safe (queue.put is safe).
- Multiple “payment confirmed” events can enqueue multiple jobs; they will be processed one by one by the single create worker. No change needed for that.

---

## 4. Failure Scenarios and Defensive Mechanisms

| Scenario | Risk | Defensive mechanism |
|----------|------|---------------------|
| **Insufficient sessions** | User paid but creation fails with “No valid sessions could be assigned”; money taken, no bot. | (1) Before enqueueing after payment, check `len(adbot_data["free_sessions"]) >= form["sessions_count"]`. (2) If insufficient: do **not** enqueue; store order as `pending_creation`, notify admin, and notify user (“We’re preparing your bot; you’ll be notified when ready”). (3) When admin adds sessions, allow “Recreate” for pending orders (from persistent pending_creations or orders table). (4) Optionally have the create worker detect “zero assigned” and push a structured failure (e.g. `username is None` + `form.get("order_id")`) so the result consumer can set order status to `pending_creation` and notify. |
| **Invalid bot token** | User provides wrong/revoked token after payment. | (1) Validate token (e.g. `validate_bot_token`) **before** enqueueing creation (when user sends Bot Token in Shop flow). (2) If invalid, ask again or allow “Skip for now” and store order as “awaiting_token”; do not enqueue until valid. (3) In the worker, token failure is already reported via progress and result (“Create failed”); ensure Shop result consumer notifies the buyer and does not mark order as completed. |
| **Payment confirmed but worker crash** | Process dies after payment webhook enqueued the job but before or during create; on restart the job is gone. | (1) Persist “paid, creation pending” **before** or atomically with enqueueing: e.g. set order status to `creating` and store order_id in a persistent orders store. (2) On startup, scan for orders in `creating` (or `paid` with no creation attempt) and either re-enqueue one create job per order or run a single “recovery” job that processes them. (3) Optionally use a **persistent job queue** (e.g. Redis or DB-backed queue) so jobs survive restarts; then no need to re-enqueue from orders. |
| **Queue worker restart losing pending orders** | Same as above: in-memory queue is empty after restart. | Same as above: persistent orders table + startup recovery (re-enqueue from orders in `creating`/`paid`), or persistent job queue. |
| **NOWPayments delayed confirmations** | Invoice marked “confirmed” late; user waits long. | (1) Set user expectation (“Confirmations can take up to N minutes”). (2) In the Shop UI, show “Waiting for payment confirmation…” and poll or webhook. (3) Optional: timeout after e.g. 1 hour and mark order as “expired” / “payment_timeout” so support can handle. |
| **Expired payment invoices still polled** | Wasted polling or accidental “confirmed” on stale invoice. | (1) Store invoice_id and creation time; ignore or stop polling after invoice expiry (NOWPayments typically has an expiry). (2) Idempotency: only transition order from `pending_payment` to `paid` once per order_id; ignore duplicate webhooks. |
| **Duplicate enqueue (double webhook / double-click)** | Same order created twice or double charge. | (1) Idempotency by order_id: before enqueueing, check order status; if already `creating` or `completed`, skip. (2) When creation completes, set order to `completed` and store bot_token; reject “create” for already-completed order_id. |

---

## 5. Required Refactors (Before Adding Shop Bot)

### 5.1 Job schema (optional but recommended)

- Add to `form`: `source` ("admin" | "shop") and optionally `order_id` (for Shop).
- Result consumer can use `source` for different wording (e.g. “Your AdBot is ready” vs “Bot created”) and use `order_id` to update order status in persistent store.

### 5.2 Session pool locking (if you parallelize later)

- Add a lock (e.g. `threading.Lock`) used only around the block that does `load_adbot()` → assign sessions in `_core_create_adbot_async` (or in the worker before calling it) → `save_adbot()`. Not strictly required for current single-worker design.

### 5.3 Persistent job / order tracking

- **Minimum:** Persistent **orders** store (SQLite or `orders.json`) with order_id, status, payment_id, timestamps, and (after creation) bot_token.
- **Recommended:** On “payment confirmed,” write order as `creating` (or `pending_creation` if you defer enqueue when sessions are low) **before** enqueueing; when result consumer gets success/failure, update order status and optionally notify buyer (e.g. “Your AdBot is ready” / “Creation failed: …”).
- **Optional:** Persistent job queue so create jobs survive restarts; then startup recovery can be “replay queue” instead of “scan orders and re-enqueue.”

### 5.4 Pre-enqueue checks (Shop flow)

- **Sessions:** If `len(free_sessions) < form["sessions_count"]`, do not enqueue; store as `pending_creation`, notify admin and user.
- **Token:** Validate bot token when user sends it; enqueue only when valid (or explicitly allow “create later” and store order as awaiting_token).
- **Duplicate bot_token:** Same as admin: if `form["bot_token"]` already in `adbot_data["bots"]`, reject and ask user to use another token.

### 5.5 Result consumer and notifications

- **Same bot:** Keep using `notify_edit_admin_message(chat_id, msg_id, ...)` so progress/result are edited in the buyer’s chat; ensure the message was sent by the same bot (Admin/Shop bot).
- **Fallback:** Currently on edit failure the progress consumer falls back to `notify_admin_send`, which only sends to ADMIN_USER_ID. For Shop jobs, consider a fallback that sends to `chat_id` (buyer) if `form.get("source") == "shop"` (would require a “send to arbitrary chat” helper using the same bot).
- **Order status:** In the result consumer, if `form.get("order_id")` is set, update the order in the orders store to `completed` or `failed` and optionally notify the buyer in a separate message if edit failed.

### 5.6 Renewal flow (24h before expiry; extend valid_till only)

- Renewal does **not** create a new bot; it only updates `valid_till` for an existing bot in `adbot.json`.
- Do **not** push renewal into `_create_job_queue`; that queue is for “create new AdBot” only.
- Implement a separate path: e.g. “renewal job” that loads adbot.json, finds the bot by order_id or bot_token, updates `valid_till`, saves. Can be a small function called from a Shop “renewal payment confirmed” handler or a separate queue (e.g. `_main_loop_job_queue` with job_type `renew_bot` and payload `(bot_token, new_valid_till)`).

### 5.7 Expiry handling (already present; align with Shop)

- Current behaviour: when `valid_till` is past, worker/controller marks bot as expired, stops posting, and notifies admin. No automatic “return sessions to pool” in the current codebase for expiry; delete_bot does that when admin deletes.
- **Planned:** “When expired: stop bot, remove assignment, return sessions to pool, validate sessions, notify admin.” So you need to either (1) reuse the existing delete_bot logic (move sessions to free or dead) when marking expired, or (2) add an explicit “expire_bot” path that: stop posting, set state=expired, move sessions to free (or dead after validation), save, notify admin. Then call this from the same place that currently sets `state = "expired"` (e.g. from `_mark_bot_expired` or from the worker result handler for `expired`).

---

## 6. Deployment Readiness — Verdict

### 6.1 Is the current architecture suitable for adding the Shop Bot directly?

**Mostly yes**, provided:

1. **Shop runs on the same bot as Admin** (one PTB app, one token), so progress/result can edit the buyer’s message.
2. **No second creation worker** is added without introducing session-pool locking.
3. **Persistent orders (and optionally pending_creations)** are added before going live, so payment-confirmed-but-not-created and restart scenarios are handled.

### 6.2 What must be implemented first to avoid production instability?

| Priority | Item | Reason |
|----------|------|--------|
| **P0** | **Orders persistence** (orders table or orders.json with order_id, status, payment_id, timestamps) | Enables idempotency, recovery after crash, and support/refunds. |
| **P0** | **Pre-enqueue checks in Shop flow** (enough free_sessions, valid bot token, token not already registered) | Prevents “paid but no bot” and duplicate bot. |
| **P0** | **Handle insufficient sessions** (store as pending_creation, notify admin + user; “Recreate” when sessions added) | Avoids paid users stuck with no bot. |
| **P1** | **Startup recovery** (on boot, re-enqueue or mark failed any orders in `creating` / `paid` with no bot) | Covers “payment confirmed but worker crash before/during create.” |
| **P1** | **Form fields** for Shop: `source`, `order_id`; result consumer updates order status when present | Clean audit trail and correct buyer notification. |
| **P2** | **Renewal path** separate from create queue (update valid_till only; no new creation) | Prevents misuse of create pipeline and keeps logic clear. |
| **P2** | **Expiry handling** (return sessions to pool when bot expires) if not already implemented | Matches your planned behaviour and frees sessions. |

### 6.3 Implementation readiness checklist

- [ ] **Plans** defined (Starter: Bronze/Silver/Gold/Diamond; Enterprise: Basic/Pro/Elite) with session_count, cycle, gap, mode, group_file, weekly_price, monthly_price.
- [ ] **Shop Bot** implemented as part of the same PTB Application as Admin (same token); menus: /start → [Buy AdBot], [FAQ], [Support].
- [ ] **Purchase flow:** Plan → Duration (7/30 days) → Crypto → NOWPayments invoice → payment polling or webhook.
- [ ] **Orders store** created and used for every purchase (create on “invoice created,” update on “payment confirmed” / “creation completed” / “creation failed”).
- [ ] **After payment confirmed:** Check free_sessions >= plan.session_count; if not, save order as pending_creation, notify admin and user; if yes, ask for Bot Name + Bot Token, validate token, then call `submit_create_job(buyer_chat_id, progress_msg_id, form)` with form including `order_id` and `source: "shop"`.
- [ ] **Result consumer** (existing) already edits buyer’s message (same bot); extend to update order status when `form.get("order_id")` is set.
- [ ] **Pending creation:** Admin UI to list pending_creations and “Recreate” (re-check sessions, then submit_create_job for that order).
- [ ] **Renewal:** 24h before expiry send renewal notification; renewal payment handler only updates `valid_till` for the existing bot (no create job).
- [ ] **Expiry:** When a bot expires, stop it, return sessions to pool (and validate), notify admin; implement if not already done.
- [ ] **Idempotency:** Payment webhook / handler checks order status before moving to `paid` and before enqueueing create; ignore duplicate confirmations for same order_id.

---

## Summary

- The **existing creation pipeline** can serve both admin and Shop: same `_create_job_queue`, same worker, same result consumer. The Shop must use the **same bot token** as the Admin Bot and pass the buyer’s `(chat_id, msg_id)` so progress/result are shown in the buyer’s chat.
- **Data gaps:** Add persistent **orders** (and optionally plans, pending_creations); do not rely on `adbot.json` alone for order lifecycle.
- **Concurrency:** Single create worker is safe; add session-pool locking if you ever add a second creation worker.
- **Failure handling:** Pre-enqueue checks (sessions, token), persistent orders, startup recovery, and idempotency are required for a stable Shop Bot; renewal and expiry flows should be implemented as separate paths from the create pipeline.

Once the P0/P1 items above are in place, the architecture is **suitable for a single unified AdBot creation pipeline** with the Shop Bot as the payment and order intake layer.
