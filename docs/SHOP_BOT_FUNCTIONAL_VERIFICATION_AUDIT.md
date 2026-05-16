# Shop Bot — Full Functional Verification Audit

**Date:** Verification run against current codebase.  
**Scope:** Plan selection → order creation → payment → creation pipeline → progress/result → renewal → expiry and failure paths.

---

## 1. Plan Selection Flow

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Plans loaded from `plans.json` | **PASS** | `code/shop/storage.py`: `load_plans()` reads `config.DATA_PLANS_FILE`; creates default if missing. |
| Plan selection buttons reflect file | **PASS** | `code/shop/handlers.py` ~109–123: `shop_mode:` loads `load_plans()`, iterates `plans.get(mode, [])`, builds one button per plan with `p.get('id')`, `p.get('sessions', 0)`. |
| sessions, cycle, gap, mode, pricing from plan | **PASS** | Plan object stored in `_shop_state` at `shop_plan:` (~136–142). Duration uses `plan.get("price_week")`, `plan.get("price_month")` (~158–160). Form built from `plan_obj` (~347–356). |
| Plan values in creation form | **PASS** | Form built in handlers ~365–378: `sessions_count`, `cycle`, `gap` from `plan_obj`; `mode` from `order.get("plan_mode")`; `plan_name`, `renewal_price` from order. |

### Mismatch

- **group_file:** Not in `plans.json`. Handlers use fixed `"Starter.txt"` or first `.txt` in `GROUPS_DIR` (~360–364). Enterprise plans therefore use the same group file as Starter unless you add `group_file` per plan.

**Verdict: PASS** (with optional improvement: add `group_file` to plans if Enterprise should differ).

---

## 2. Order Creation and Tracking

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Order created in `orders.json` | **PASS** | `create_order()` in `code/shop/storage.py` appends to list and calls `save_orders()`. |
| `order_id` unique | **PASS** | `order_id = str(uuid.uuid4())[:12]` in `create_order()` (~155). |
| `order_id` in payment creation | **PASS** | `create_invoice(..., order_id=order_id)` (~269–274). |
| `order_id` in payment polling | **PASS** | Worker uses `o.get("order_id")` from loaded orders; no regeneration. |
| `order_id` in creation job | **PASS** | Form includes `"order_id": order_id` (~376) and is passed to `submit_create_job`. |
| `order_id` in result consumer | **PASS** | `order_id = form.get("order_id")`; `update_order_status(order_id, ...)` (~141–148, 155–156). |
| Idempotency (no duplicate creation) | **PARTIAL** | Status set to `"creating"` before enqueue (~396). Result consumer sets `completed` or `failed`. Polling only acts on `payment_waiting`. No webhook handler yet; if added, must check status before moving to `paid` to avoid double-trigger. |

**Verdict: PASS.** Order id flows end-to-end; duplicate creation avoided by status transitions. Harden when adding payment webhooks.

---

## 3. Payment Integration (NOWPayments)

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Invoice generation | **STUB** | `code/shop/payment.py` `create_invoice()`: returns mock data when `NOWPAYMENTS_API_KEY` empty or `"your_api_key"`. No real POST to provider. |
| payment_id stored in order | **PASS** | Handlers call `update_order(order_id, {"payment_id": invoice.get("payment_id", ""), ...})` (~275–278, 241–242). |
| Polling worker calls status check | **PASS** | `payment_polling_worker` calls `check_payment_status(payment_id)` (~33). |
| GET /v1/payment/{payment_id} | **NOT IMPLEMENTED** | `check_payment_status()` has `# TODO: GET /payment/{payment_id}`; always returns `"waiting"` (or stub `"confirmed"` when key unset and id starts with `confirmed_`). |
| Status transitions (waiting → confirming → confirmed) | **STUB** | Stub returns only `waiting` or `confirmed`; no real API mapping. |
| Payment confirmed → order `paid` | **PASS** | When `status == "confirmed"`, worker calls `update_order_status(order_id, "paid", paid_at=now)` and sets `awaiting_field="name"` (~50–52). |
| Duplicate confirmations | **PASS** | Worker only processes `o.get("status") == "payment_waiting"`. Once set to `paid`, order skipped on next poll. |

### Gaps

- **API key:** `NOWPAYMENTS_API_KEY` is a module-level empty string in `payment.py` (~8). Not read from `.env`; production must load from env and use in real HTTP calls.
- **Real integration:** Implement POST for invoice creation and GET for payment status per NOWPayments API.

**Verdict: FAIL** for live payments (stub only). **PASS** for flow logic (storage, polling, status transitions once real API returns statuses).

---

## 4. Creation Pipeline Integration

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Asks Bot Name and Bot Token after payment | **PASS** | Payment worker sends "Payment confirmed! Enter your Bot Name…" (~55–58). Handlers `enter_name` → `enter_token` (~318–328). |
| Bot token validated before enqueue | **PASS** | `validate_bot_token(text)` before building form (~336–339); duplicate token check against `adbot_data.get("bots", {})` (~340–342). |
| Session availability checked | **PASS** | `free_count = len(adbot_data.get("free_sessions", []))`; `if free_count < form["sessions_count"]` → pending_creation (~379–381). |
| If sessions OK → job to `_create_job_queue` | **PASS** | `submit_create_job(chat_id, progress_msg.message_id, form, notification_bot_token=config.SHOP_BOT_TOKEN)` (~396–401). |
| If insufficient → order `pending_creation` | **PASS** | `update_order_status(order_id, "pending_creation")`, `update_order(..., bot_name, bot_token, bot_username)`, `add_admin_alert(...)` (~381–388). |
| Form contains required fields | **PASS** | Form (~365–378): `order_id`, `plan_name`, `renewal_price`, `sessions_count`, `cycle`, `gap`, `valid_till`, `mode`, `group_file`, plus name, bot_token, bot_username. |

**Verdict: PASS.**

---

## 5. Progress Messaging

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Shop jobs use Shop Bot token for edits | **PASS** | `submit_create_job(..., notification_bot_token=config.SHOP_BOT_TOKEN)`; `_progress_consumer_ptb(..., notification_bot_token)` and `notify_edit_message(..., bot_token=edit_bot_token)` in result consumer (~166–176, 143–144). |
| Progress steps (assigning, log group, joining, done/fail) | **PASS** | `_core_create_adbot_async` calls `log_async(...)` for each step; progress queue carries (chat_id, msg_id, msg); consumer edits with correct bot. |
| Result consumer updates order | **PASS** | On success: `update_order_status(order_id, "completed", created_bot_username=username, bot_token=bot_token)` (~148). On failure: `update_order_status(order_id, "failed")` (~155). |

**Verdict: PASS.**

---

## 6. Renewal Flow

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Renewal reminder ~24h before expiry | **PASS** | `renewal_scheduler_worker`: `threshold = now + timedelta(hours=24)`; only bots with `end > now` and `end <= threshold` (~74–88). |
| Reminder can spam | **FAIL** | No `last_renewal_reminder_sent`; every poll (hourly) re-sends to same user for same bot (~102–112). |
| Renewal purchase → renewal order linked to parent | **PASS** | `create_renewal_order(parent_order_id=..., ...)` with `order_type: "renewal"`, `parent_order_id` (~225–241). |
| Payment confirmed → extend `valid_till` | **PASS** | Worker: `if o.get("order_type") == "renewal"` then `extend_valid_till_for_bot(parent.get("bot_token"), o.get("duration_days"))` (~35–48). `extend_valid_till_for_bot` in workers.py parses `valid_till`, adds days, saves (~118–141). |
| Renewal does NOT enqueue creation | **PASS** | Renewal path only updates order and calls `extend_valid_till_for_bot`; no `submit_create_job`. |

**Verdict: PASS** with one fix: add tracking (e.g. on bot or order) so the same user is not sent the 24h reminder more than once per expiry window.

---

## 7. Expiry Handling

### Verification

| Check | Status | Location / Notes |
|-------|--------|------------------|
| Bot stops when expired | **PASS** | `_mark_bot_expired` calls `_stop_posting(bot_token)` when `not from_worker` (~851–853). Posting workers report expired and call `_mark_bot_expired(..., from_worker=True)` (~1006–1009). |
| Sessions returned to free pool | **FAIL** | `_mark_bot_expired` only sets `state: "expired"` and notifies admin (~850–859). It does **not** move sessions to `free_sessions` or call `delete_bot_from_storage`. Sessions remain assigned to the expired bot. |
| Sessions validated and classified | **FAIL** | No validation or move to dead/free on expiry. |
| Admin notified | **PASS** | `add_admin_alert("bot_expired", ...)` (~858). |

**Verdict: FAIL.** Expiry stops the bot and alerts admin but does not return or validate sessions. Required: on expiry, either call equivalent of delete (move sessions to free or dead and update pool) or add a dedicated expiry path that does so.

---

## 8. Failure and Edge Cases

| Scenario | Handled? | Location / Notes |
|----------|----------|------------------|
| Insufficient sessions after payment | **YES** | Order set to `pending_creation`; admin alert; user message (~381–393). Recreate via admin "Pending Shop Orders" + `recreate_pending_order`. |
| Invalid bot token after payment | **YES** | Validation and "This bot token is already registered" check before enqueue (~336–342); user asked to re-send. |
| Worker restart while order in `creating` | **YES** | `order_recovery_on_startup()` marks `creating` orders as `failed` (~142–152). |
| Duplicate payment webhooks | **N/A** | No webhook handler. When added: must only transition to `paid` if current status is `payment_waiting`. |
| Orders stuck in intermediate states | **PARTIAL** | Recovery only handles `creating`. No automatic cleanup for long-stuck `payment_waiting` or `paid` (e.g. never sent token). |
| JSON write concurrency | **RISK** | `load_orders()` / `save_orders()` read full file, modify, write. Two writers (e.g. result consumer + payment worker) can overwrite. Single process and queue ordering reduce risk but do not eliminate it. |

**Recommended fixes (severity):**

- **High:** Expiry: return sessions to pool (and optionally validate) when marking bot expired.
- **High:** Payment: implement real NOWPayments API and load API key from env.
- **Medium:** Renewal: prevent duplicate 24h reminders (e.g. `last_renewal_reminder_sent` on bot or order).
- **Medium:** Concurrency: serialize writes to `orders.json` (e.g. file lock or single writer task) if multiple tasks can update orders.
- **Low:** Optional: add `group_file` to `plans.json` for Enterprise vs Starter.
- **Low:** Webhook idempotency when/if payment webhooks are added.

---

## 9. Pass / Fail by Subsystem

| Subsystem | Verdict | Notes |
|-----------|---------|--------|
| Plan selection | **PASS** | Dynamic load, buttons, form; optional group_file per plan. |
| Orders lifecycle | **PASS** | order_id end-to-end; idempotency OK for current polling. |
| Payment integration | **FAIL** | Stub only; no live API, no env API key. |
| Creation pipeline | **PASS** | Validation, session check, form, queue, pending_creation, Recreate. |
| Progress messaging | **PASS** | Shop token used; order updated on success/failure. |
| Renewal | **PASS** (with fix) | 24h reminder and extend work; add reminder dedup. |
| Expiry | **FAIL** | Bot stops and admin notified; sessions not returned or validated. |

---

## 10. Exact Code Locations for Mismatches / Fixes

1. **Expiry — sessions not returned**  
   - **Where:** `code/users.py` `_mark_bot_expired` (~850–859).  
   - **Fix:** After setting state to expired, either (a) call the same logic as delete (return sessions to pool via `delete_bot_from_storage(bot_token, "free")` or equivalent), or (b) add a dedicated expiry path that moves the bot’s sessions to free (or dead after validation) and updates pool/index as needed.

2. **Payment — stub only**  
   - **Where:** `code/shop/payment.py`: `create_invoice`, `check_payment_status` (~12–69).  
   - **Fix:** Implement POST for invoice and GET for payment status; read `NOWPAYMENTS_API_KEY` from `os.getenv` or config loaded from `.env`.

3. **Renewal reminder spam**  
   - **Where:** `code/shop/workers.py` `renewal_scheduler_worker` (~66–115).  
   - **Fix:** Before sending, set or check a `last_renewal_reminder_sent` (e.g. on bot config or order) and skip if already sent in the last 24h (or similar).

4. **Orders.json concurrency**  
   - **Where:** `code/shop/storage.py` `load_orders`, `save_orders`, `update_order`, `update_order_status`.  
   - **Fix:** Use a single asyncio lock (or file lock) around load-modify-save for orders, or a single writer task that processes order-update requests from a queue.

---

## 11. Production Readiness Verdict

**Not ready.**

- **Blockers:**  
  - Payment is stub-only (no real NOWPayments).  
  - Expiry does not return sessions to the pool or validate them.  
- **Strongly recommended before production:**  
  - Implement real payment API and env-based API key.  
  - Add expiry path that returns (and optionally validates) sessions.  
  - Deduplicate renewal reminders and, if needed, harden orders.json writes.

**Ready with fixes:** Once the above are done and renewal spam is addressed, the Shop purchase → payment → creation → renewal lifecycle can be considered production-ready from a functional and data-integrity perspective.
