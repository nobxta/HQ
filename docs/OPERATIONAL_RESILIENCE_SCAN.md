# AdBot Operational Resilience Scan

**Objective:** Identify runtime conditions, edge cases, race conditions, failure scenarios, and recovery gaps across Shop Bot, Controller/User AdBot, Admin Bot, workers, and JSON storage. Provide fixes and observability recommendations.

---

## 1. USER FLOW CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| User creates multiple invoices simultaneously | **Low** | `temppay_add()` enforces one active per user; returns False if user already has entry. Handlers check `get_active_pending_order_for_user()` before creating. | Minimal: second attempt gets "You already have a pending payment". | **None.** Already enforced. Optionally log when temppay_add returns False for metrics. |
| User sends /start while payment pending | **Low** | `cmd_start` and `_main_menu_or_pending_message()` block menu; show "You already have a pending payment. Use /cancel…". | None. | **None.** |
| User cancels during confirming state | **Medium** | /cancel removes from temppay OR marks order `cancelled` in orders. If order already in orders with status confirming, cancel sets status=cancelled; polling worker will still poll until expiry. Payment could still confirm later. | Order stays in orders as "cancelled"; if payment confirms later, worker may transition to paid and ask for name (depends on worker checking status). | **Fix:** In payment worker, before transitioning to paid/confirming, re-check `get_active_pending_order_for_user(user_id)` and that order status is still payment_waiting/confirming; if order is cancelled, skip transition and optionally mark order expired. In handlers, ensure cancel clears any in-memory state. |
| User payment confirmed after invoice expiry | **Low** | Temppay entries expired by worker (remove + edit msg); orders.json payment_waiting/confirming use expiry_time; after expiry worker marks expired and stops polling. Provider may still deliver "confirmed" on GET. | If worker marks expired then later GET returns confirmed: worker already skipped that order (next_poll_at not updated after expiry). So no double-fulfilment. | **Harden:** When processing order in polling, if `now_utc > expiry_dt` do not process payment status at all (already done). Document: "Payment after expiry is not accepted." |
| User closes bot during onboarding | **Medium** | State in `_shop_state`; order in orders with awaiting_field (name/token). No timeout. | User returns later: state may be lost (restart clears _shop_state). Order still has awaiting_field; no automatic re-prompt. | **Fix:** On /start, if user has order with status=paid and awaiting_field set but no _shop_state, restore prompt from order ("Enter your bot name" or "Send your Bot Token") and set _shop_state from order. Add admin view for "stuck onboarding" orders. |
| User submits invalid bot token | **Low** | `validate_bot_token()` used in creation flow; creation fails and returns None; result consumer marks order failed / shows failure message. | Creation fails; user sees failure; order can be retried (recreate). | **Optional:** Validate token format earlier in onboarding (e.g. regex) before submitting create job to reduce wasted work. |
| User submits duplicate bot token | **High** | Creation does **not** check if bot_token already in index. `index.setdefault("by_token", {})[bot_token] = safe_name` overwrites. Different names → two user JSON files; index points to last. First bot becomes orphan. | Orphan user file; two AdBots in UI with same token (one broken); index only points to one name. | **Fix:** At start of `_core_create_adbot_async`, if `get_name_by_token(bot_token)` exists, return None with reason "Bot token already registered" and set form["_result_reason"] so result consumer can show "This bot is already linked to an AdBot." |
| User deletes bot after purchase | **Low** | Admin/main loop job: _stop_posting, disconnect_and_remove_controller_bot, delete_bot_from_storage. Order remains completed. | No operational impact. | **None.** Optional: soft-delete or archive orders for analytics. |
| User presses buttons multiple times rapidly (callback spam) | **Medium** | Single `await q.answer()` at start of callback; no debounce. Rapid "Buy" or "shop_plan" can enqueue multiple create jobs or multiple temppay attempts (temppay_add rejects second). | Multiple create jobs for same order if user double-clicks "Buy" then name/token; duplicate invoices prevented by temppay_add. | **Fix:** (1) Debounce: ignore same callback_data for same user within 2–3 s (in-memory key = (user_id, data)). (2) Idempotency: creation worker checks order_id status before starting; if already completed/creating, skip and push result with existing bot. |

---

## 2. PAYMENT CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| Payment webhook delayed | **N/A** | No webhook used; polling only (GET /payment/{id}). Delayed payment still detected on next poll. | None. | **None.** |
| Payment webhook delivered multiple times | **N/A** | No webhook. | N/A. | **None.** |
| Payment detected but worker crashes before saving order | **Medium** | Worker writes order (append_order_from_temppay, update_order_status) then notifies. If crash after API "confirmed" but before save: temppay still has entry; on restart order_recovery_on_startup clears next_poll_at so polling re-runs; GET will again return confirmed; worker will append and save. | Possible double notification (confirming/confirmed message twice). Duplicate order only if append_order_from_temppay runs twice for same invoice_id – but temppay_remove_by_invoice_id runs after append, so second run has no temppay entry. So at most double user message. | **Harden:** Make _process_temppay_entry idempotent: if GET returns confirmed, check orders for existing order with this payment_id; if found and status paid/completed, skip append and only remove from temppay + ensure message updated. |
| Invoice expires but payment arrives later | **Low** | Worker expires temppay/order and stops polling. Later payment is not accepted (no poll). | User paid but order expired; support/refund. | **Doc:** "Payments must complete before invoice expiry." Optional: admin tool to manually mark order paid and trigger creation if payment_id verified externally. |
| Network mismatch payments | **Low** | Provider returns pay_currency and amount; we compare amount_received >= pay_amount. Network mismatch is provider-side. | Underpayment if wrong network. | **None** (provider responsibility). Log pay_currency and amount_received for support. |
| Partial payments | **Low** | Worker notifies once (_notified_partial); continues polling. confirmed only when amount_received >= pay_amount. | None. | **None.** |
| Underpayment / overpayment | **Low** | confirmed only if amount_received >= pay_amount. Overpayment accepted (no extra logic). | None. | **None.** |
| NOWPayments API downtime | **Medium** | get_payment_details returns None on failure; worker logs and continues next cycle; no state change. | Polling delayed until API up; payments still detected when API returns. | **Observability:** Log API failure count; alert if repeated failures (e.g. 5 in a row). Optional: exponential backoff for this invoice in same loop. |
| Polling worker restart mid-confirmation | **Low** | order_recovery_on_startup clears next_poll_at for payment_waiting/confirming; first loop re-polls; GET confirmed → transition to paid. | None. | **None.** |

---

## 3. BOT CREATION CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| No sessions available during creation | **Low** | _core_create_adbot_async assigns from adbot_data["free_sessions"]; if len(assigned) < sessions_count, returns None with _result_reason insufficient_valid_sessions; result consumer sets order pending_creation and notifies admin/user. | Order stuck pending_creation until admin adds sessions and uses Recreate. | **None.** Optional: periodic check to auto-retry pending_creation when free_sessions increases. |
| Sessions become banned during creation | **Low** | validate_session and get_session_user; invalid sessions moved to dead_sessions and skipped; next session tried. Log group creation tries each assigned session. | If all fail, creation returns None; order marked failed. | **None.** |
| Group creation fails | **Low** | Retry with next session; if all fail, return None and alert. | Creation fails. | **None.** |
| BotFather rate limits | **Low** | Not in our control; user obtains token. | N/A. | **None.** |
| Telegram API temporary failure | **Medium** | with_retry / with_floodwait_retry in posting; creation has no global retry. Single attempt per step. | Creation can fail mid-way (e.g. after log group created, join fails). Partial state: pool/adbot_data updated only at end. | **Fix:** Creation already uses try/except per step. Add retry (e.g. 2 retries with 5s delay) for transient errors (FloodWait, connection errors) in create channel / join. |
| Worker crash mid-creation | **High** | order_recovery_on_startup marks status=creating → failed. No rollback of pool/sessions already removed from free_sessions. | Sessions may be left "in use" (removed from free_sessions) but no bot created; pool inconsistent. | **Fix:** On startup, for orders in "creating", mark failed (already done). Add repair job: "Orphan sessions" – sessions in adbot_data free_sessions that are also in a bot's sessions list, or vice versa. Prefer: creation worker writes "creating" at start and only on full success updates pool/index/user; on crash, recovery restores free_sessions from last known good or scans user files for assigned sessions. |
| Duplicate creation triggered for same order | **Medium** | No idempotency key. Two submit_create_job for same order_id can run two creations. | Two bots for same order (if token same, second overwrites index; if token different, two bots). | **Fix:** Before starting creation, check order status; if already completed or creating, skip and push result (existing bot_username / or "already_creating"). Use order_id as idempotency key in create worker. |

---

## 4. POSTING ENGINE CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| Session banned mid-cycle | **Low** | session_died / cycle_failed reported; controller marks session dead or excludes; replace flow. | Session excluded; replacement flow. | **None.** |
| FloodWait exceptions | **Low** | with_retry; below threshold sleep in worker; above FLOODWAIT_THRESHOLD_SEC raise FloodWaitPause → session marked PAUSED, deferred groups; no sleep in worker. | Cycle delayed; no data loss. | **None.** |
| Group removed / inaccessible | **Low** | Errors reported; skip group; ban_error_count; session can be excluded if cycle_failed. | Group skipped. | **None.** |
| Message send failure | **Low** | Retry/skip; stats updated (total_failed). | Counted in stats. | **None.** |
| Network timeout | **Low** | Telethon/retry; eventually session_died or cycle completes. | Cycle may complete late or fail. | **None.** |
| Restart during cycle | **Low** | Workers don't persist; on resume_adbots posting restarts; last_cycle_time from config; next cycle runs on schedule. | One cycle may be missed or delayed. | **None.** |
| Memory restart / server reboot | **Low** | Same as restart; resume_adbots; stats flushed on shutdown (last_stats_update). | **None.** | **None.** |
| Posting delay drift over time | **Low** | Absolute-time scheduling; sleep_until; late cycles attempt all groups (no drop). | Slight drift; no drop. | Optional: log cycle jitter for monitoring. |

---

## 5. ADMIN CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| Admin replaces sessions during active posting | **Medium** | Session list in config; workers hold config_snapshot. Replace updates user JSON and pool; running workers keep old snapshot until next start. | Old workers may use removed session; new session may be assigned to another bot. | **Fix:** Document: "Stop the bot before replacing sessions, then start again." Optional: version or timestamp in config; workers re-read on next cycle (or controller pushes config update). |
| Admin stops all bots while workers still running | **Low** | _stop_posting sends STOP to workers; await_all_pending_stop_cleanup on shutdown. Main loop job consumer runs _stop_posting per bot. | Workers exit; cleanup runs. | **None.** |
| Admin modifies plan during cycle | **Low** | Plan in config; workers use snapshot. Next run or restart uses new config. | Same as session replace. | **None.** |
| Admin deletes user while bot active | **Low** | delete_bot job: _stop_posting, disconnect, delete_bot_from_storage. | Clean. | **None.** |
| Session stock mismatch (unused vs assigned) | **Medium** | Pool free_sessions vs bots' sessions; no single source of truth check. | Orphan sessions or double-assignment if bugs. | **Fix:** Repair script or /health: "Free sessions: N; Assigned (sum): M; Total files: K" and flag if N+M != K or duplicates. |

---

## 6. DATA CONSISTENCY CONDITIONS

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| Concurrent writes to user JSON | **High** | No file lock. save_user_data does load–merge–write. Multiple writers (posting stats, admin, shop renewal) can overwrite. | Lost updates; corrupted or stale data. | **Fix:** Per-user file lock (threading.Lock or filelock) in save_user_data / load_user_data; or single writer (queue all saves to one thread). |
| Partial file write due to crash | **High** | save_user_data uses path.write_bytes(_dumps(result)); no atomic write. Crash during write → truncated/corrupt JSON. | Load fails; bot unusable until repair. | **Fix:** Atomic write: write to temp file (e.g. .json.tmp), then os.replace(temp, path). Same for save_index, save_pool, save_adbot if not already. |
| Temppay.json and orders.json mismatch | **Low** | Worker moves from temppay to orders on confirming/confirmed; removes from temppay. Single worker; locks. | Minimal; only if crash between append and remove (then temppay entry remains, order exists – worker next run may process same entry again: append_order_from_temppay again → duplicate order entry). | **Fix:** In _process_temppay_entry, when status confirming/confirmed, first remove from temppay, then append to orders (or use order_id from entry and check orders for existing order with same payment_id before appending). Already order_id in entry; dedupe by payment_id in orders when appending. |
| Transaction logged but bot not created | **Medium** | append_transaction is called when? If called on payment confirm and creation fails later, transaction is still logged. | User has transaction record but no bot. | **Fix:** Call append_transaction only after bot is successfully created (in result consumer when status=completed), not on payment confirm. Or keep both: log "payment" vs "bot_created" and allow support to see gap. |
| Stats updated but file not saved | **Low** | Stats flush on cycle, periodic, shutdown; last_stats_update. | Reduced by periodic flush. | **None.** |
| Migration running on partially corrupted file | **Medium** | load_user_data: _loads(raw); migrate_user_config. If JSON partially corrupt, _loads can raise; we return None. | Bot config lost until restore from backup. | **Fix:** On load exception, try to read raw and salvage (e.g. strip trailing garbage, try json.loads); log and alert; optionally move file to .corrupt and return None. |

---

## 7. RECOVERY REQUIREMENTS (Summary)

- **Cancel during confirming:** Worker should re-check order status and skip paid transition if cancelled.
- **Onboarding resume:** On /start, restore _shop_state from order when status=paid and awaiting_field set.
- **Duplicate bot token:** Reject creation when bot_token already in index; return clear result.
- **Callback spam:** Debounce callbacks by (user_id, data); creation idempotent by order_id.
- **Payment worker crash:** Idempotent _process_temppay_entry: skip append if order with same payment_id already in orders.
- **Creation worker crash:** Mark creating→failed (done). Consider restoring free_sessions for that order (complex).
- **Duplicate creation:** Creation worker checks order status; skip if completed/creating; push existing result.
- **Concurrent user JSON writes:** Per-user lock or single-writer queue.
- **Partial file write:** Atomic save (temp file + rename) for user JSON, index, pool, adbot.
- **Temppay/orders dedupe:** When appending from temppay, check orders for existing payment_id; append only if missing.
- **Transaction timing:** Document or move append_transaction to post-creation only.
- **Corrupt file:** Salvage or move to .corrupt and alert.

---

## 8. CRITICAL RISKS (must fix before scale)

1. **Duplicate bot token in creation** – Orphan user files and broken index; reject creation when token already registered.
2. **Concurrent writes to user JSON** – No lock; lost updates or corruption; add per-user lock or atomic write.
3. **Partial file write on crash** – User/config files not written atomically; use temp file + rename.
4. **Duplicate creation for same order** – Idempotency by order_id in create worker; skip if already completed/creating.

---

## 9. MEDIUM RISKS

1. User cancels during confirming – Worker should respect cancelled status before transitioning to paid.
2. User closes bot during onboarding – Restore state from order on /start when paid + awaiting_field.
3. Callback spam – Debounce and creation idempotency.
4. NOWPayments API downtime – Alert on repeated failures.
5. Creation Telegram API transient failure – Retry with backoff for create channel / join.
6. Admin replaces sessions during posting – Document "stop then replace"; optional config version.
7. Session stock mismatch – Health/repair check for free vs assigned counts.
8. Temppay/orders duplicate order on crash – Dedupe by payment_id when appending to orders.
9. Migration on corrupted file – Salvage or .corrupt + alert.

---

## 10. OBSERVABILITY IMPROVEMENTS

| Area | Current | Recommended |
|------|---------|-------------|
| **Logs** | Various logger.info/warning | Structured fields: order_id, user_id, bot_token (masked), payment_id, status. Correlation ID for create job. |
| **Alerts** | add_admin_alert for create_failed, pending_creation, order_confirmed, renewal, etc. | Add: payment API consecutive failures (e.g. 5); corrupt user file detected; duplicate token attempt; creation worker exception. |
| **Watchdogs** | order_recovery_on_startup; resume_adbots; stats flush loop | Heartbeat for payment polling worker (e.g. last_poll_ts in pool or file); alert if no poll for 15 min. Health endpoint: orders by status counts, temppay count, last_stats_update per bot. |
| **Metrics** | last_stats_update in stats | Optional: orders_pending_creation count, payment_waiting count, creating count; poll success/failure rate. |
| **Admin** | /health shows bots and workers | Add: "Orders: paid N, creating M, pending_creation P, failed F"; "Temppay: N invoices"; "Last payment poll: ISO time". |

---

## 11. OUTPUT TABLE (Consolidated)

| Condition | Risk Level | Current Handling | Failure Impact | Recommended Fix |
|-----------|------------|------------------|----------------|-----------------|
| Multiple invoices per user | Low | temppay_add one per user | None | None |
| /start while pending | Low | Menu blocked | None | None |
| Cancel during confirming | Medium | Cancel sets cancelled | Worker might still move to paid | Re-check status in worker before paid |
| Payment after expiry | Low | Polling stopped | User paid, order expired | Doc + optional manual tool |
| Close bot during onboarding | Medium | State in memory only | State lost on restart | Restore from order on /start |
| Invalid bot token | Low | Validation at creation | Creation fails | Optional early format check |
| **Duplicate bot token** | **High** | Not checked | Orphan files, broken index | **Reject if token in index** |
| Delete bot after purchase | Low | Clean delete | None | None |
| **Callback spam** | **Medium** | No debounce | Duplicate create jobs | **Debounce + order_id idempotency** |
| Webhook delayed / multiple | N/A | Polling only | N/A | None |
| Worker crashes before save | Medium | Restart re-polls | Double notify possible | Idempotent by payment_id |
| NOWPayments downtime | Medium | Retry next cycle | Delayed detection | Alert on repeated failures |
| **No sessions at creation** | Low | pending_creation | Stuck until Recreate | None |
| **Worker crash mid-creation** | **High** | creating→failed | Pool/sessions inconsistent | **Mark failed; optional repair** |
| **Duplicate creation same order** | **Medium** | None | Two bots / overwrite | **order_id idempotency in worker** |
| Session banned mid-cycle | Low | session_died / exclude | Replace flow | None |
| FloodWait | Low | PAUSED, retry | Delay | None |
| **Concurrent user JSON writes** | **High** | No lock | Lost updates | **Per-user lock or atomic write** |
| **Partial file write** | **High** | Direct write | Corrupt file | **Atomic save (temp+rename)** |
| Temppay/orders mismatch | Low | Move then remove | Duplicate order on crash | Dedupe by payment_id on append |

---

## 12. Last-mile production hardening (implemented)

| Item | Implementation |
|------|----------------|
| **Cross-process file locks** | `filelock` used in `save_user_data`, `save_index`, `save_pool`. Lock file per path (e.g. `data/user/foo.json.lock`). Atomic write (temp + rename) retained. |
| **Order state machine** | `ORDER_STATUS_TRANSITIONS` in `shop/storage.py`; `update_order_status` rejects illegal transitions (e.g. cancelled → paid) and logs. |
| **Worker watchdog** | Payment worker writes `data/payment_worker_heartbeat.json` each loop. Create worker writes `data/create_worker_heartbeat.json` on job start/end and when waking from `get(timeout=60)`. `_worker_watchdog_loop` in main checks every 5 min; if heartbeat > 15 min: restart payment task (cancel + create new); for create worker call `request_create_worker_restart()` then `_start_create_worker_if_needed()`. Admin alert on restart. |
| **Session ownership integrity** | `run_session_ownership_integrity_scan()` in utils: no session in two bots (remove from duplicates); orphans (on disk but not in free or any bot) returned to free pool. Run daily via `_daily_session_integrity_and_reconciliation()`. |
| **Payment reconciliation** | `run_payment_reconciliation()` in shop/workers: orders with status=paid, no created_bot_username, bot_token set, paid_at > 30 min → re-submit create job and alert. Run daily. |
| **Queue saturation** | `MAX_CONCURRENT_CREATE_JOBS = 2`; `_start_create_worker_if_needed()` starts 2 create worker threads. Create worker uses `get(timeout=60)` and `_create_worker_restart_requested` for watchdog-driven restart. |
