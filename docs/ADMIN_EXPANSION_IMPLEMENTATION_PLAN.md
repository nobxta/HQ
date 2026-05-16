# Admin Control System Expansion — Implementation Plan

This document describes the migration-safe implementation of the Admin Control System expansion.

## New Storage Files (created at runtime)

| File | Purpose |
|------|--------|
| `data/maintenance.json` | `{"enabled": bool, "updated_at": "ISO8601"}` |
| `data/maintenance_notify_queue.json` | `{"items": [{"user_id", "chat_id"}], "updated_at": "..."}` — deduplicated queue of users to notify when maintenance ends |
| `data/broadcast_log.json` | `{"logs": [{"at", "segment", "recipient_count", "sent", "failed"}]}` — last 500 entries |
| `data/emergency_stopped.json` | `{"tokens": [bot_token, ...], "at": "ISO8601"}` — filled when Emergency Stop All is used; cleared when Resume All runs |

## Config / Pool Changes (backward compatible)

- **config.py**: `DATA_MAINTENANCE_FILE`, `DATA_MAINTENANCE_QUEUE_FILE`, `DATA_BROADCAST_LOG_FILE`, `BROADCAST_RATE_LIMIT_PER_MIN` (env, default 30).
- **pool.json**: New key `frozen_sessions: []`. Existing files without it get it via `setdefault` in `load_pool()` and `save_pool()`.
- **load_adbot() / save_adbot()**: Include `frozen_sessions` in merged read/write.

## User/Index Schema Additions (optional, merge-safe)

- **data/user/*.json**: New optional keys: `suspended` (bool), `frozen` (bool). Controllers check `cfg.get("suspended")` and `cfg.get("frozen")`; absence is treated as false.
- No migration script required; keys are written when admin uses Suspend/Resume or Freeze.

## Order State Machine

- **shop/storage.py**: `ORDER_STATUS_TRANSITIONS` updated so `paid` and `pending_creation` can transition to `cancelled` (admin cancel/refund).

## Main Loop Jobs (main.py)

New job types consumed by `_main_loop_job_consumer()`:

- `stop_posting` — (bot_token,): stop posting for one bot.
- `emergency_stop_all` — (running_tokens,): stop all listed bots, write tokens to `emergency_stopped.json`, notify admin.
- `emergency_resume_all` — (tokens,): start posting for all listed bots, clear `emergency_stopped.json`, notify admin.
- `restart_bot` — (bot_token,): stop then start posting for one bot.

## Admin PTB Menu Structure

- **Main menu**: Control Center | Create AdBots / Manage AdBots | Manage Sessions / Pending Orders.
- **Control Center**: System | Orders | Users | Sessions | Bots (= Manage AdBots) | Broadcast | Dashboard | Back.
- **System**: Maintenance ON/OFF, Emergency Stop All, Emergency Resume All.
- **Orders**: /order_id, /order_payment, /order_user + Pending creations; order detail view with Mark paid, Cancel, Re-run.
- **Users**: /user_id, /user_bot, /user_plan.
- **Sessions**: Summary + Full list (paginated), Session → Bot map, Manage Sessions.
- **Broadcast**: Segment buttons → set segment → next message is broadcast (rate-limited); log to broadcast_log.json.
- **Dashboard**: Counts (bots, sessions, orders by status, create/payment worker heartbeat).
- **Manage AdBots (per-bot)**: Validate, Replace dead/error, Recreate log, Suspend, Resume, Force restart, Transfer ownership, Delete.

## Commands Added

- `/order_id <id>`, `/order_payment <payment_id>`, `/order_user <user_id>` — search orders, show first with actions.
- `/user_id <telegram_id>`, `/user_bot @username`, `/user_plan <plan_name>` — search users/bots.

## Backward Compatibility

- Existing flows (Create AdBot, Manage Sessions, Manage AdBots, Pending Orders) unchanged.
- Shop Bot and Controller Bot: only addition is maintenance check at handler entry; if maintenance off, behavior unchanged.
- No changes to existing order or user JSON keys required; new keys are additive.

## Safe Rollout

1. Deploy code; ensure `data/` exists.
2. On first maintenance ON, `maintenance.json` is created.
3. On first broadcast, `broadcast_log.json` is created.
4. Old pool.json without `frozen_sessions` works; next save adds the key.

---

## Tightening (post-expansion)

### Emergency stop persistence
- **crash.py**: On startup, `resume_adbots()` loads `emergency_stopped.json`. Any bot whose token is in that list is **not** started for posting (controller is still started). So after a server restart, emergency-stopped bots remain stopped until admin uses "Resume all posting".

### Maintenance gates creation and payment
- **admin.py** `_create_worker_loop`: After dequeueing a job, if `is_maintenance_enabled()` then the job is put back on the queue and the worker sleeps 30s. No bot creation or session assignment during maintenance.
- **shop/workers.py** `payment_polling_worker`: At the start of each loop iteration, if `is_maintenance_enabled()` then heartbeat is written and the loop sleeps 60s without processing temppay or orders. No payment confirmation or creation trigger during maintenance.

### Broadcast preview confirmation
- **admin_ptb**: Segment choice (`bc_seg:X`) now shows "Segment: X, Recipients: N. Send? [Confirm] [Cancel]". Only after [Confirm] (`bc_confirm:X`) is the segment stored and the user prompted to send the message. Reduces accidental global sends.

### Dashboard refresh
- **admin_ptb**: Dashboard view (Control Center → Dashboard and `/dashboard`, `/dashboard_refresh`) includes a [Refresh] inline button. Callback `cc_dashboard_refresh` re-runs `dashboard_counts()` and edits the message with fresh numbers.

### Audit logging
- **code/audit.py**: `log_admin_action(admin_id, action, target=None, **extra)` appends to `data/admin_audit.json` (entries list, max 2000). Fields: `ts`, `admin_id`, `action`, `target`, plus any extra.
- Logged actions: `maintenance_on`, `maintenance_off`, `mark_paid`, `cancel_order`, `rerun_creation`, `extend_plan`, `user_freeze`, `transfer_ownership`, `emergency_stop`, `emergency_resume`.
- Emergency stop/resume: `admin_id` is passed in the main-loop job payload so the job consumer can log with the actual admin id (or "main_loop" if missing).
