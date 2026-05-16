# AdBot User JSON Configuration — Schema & Migration

## Objective

- **Standardize** the user JSON structure with clear `plan`, `history`, `stats`, and `transactions` sections.
- **Remove redundancy** by making `plan.mode` canonical (legacy `mode` / `plan_mode` kept for compatibility).
- **Track** purchase history, renewal history, session replacement history, posting stats, and transaction hashes.
- **Full backward compatibility**: existing bots and all current readers (posting engine, admin, creation flow) continue to work without changes.

---

## Final JSON Schema

```json
{
  "name": "string",
  "bot_token": "string",
  "bot_username": "string",
  "valid_till": "DD/MM/YYYY",
  "cycle": 3600,
  "gap": 5,
  "mode": "Starter",
  "group_file": "Starter.txt",
  "log_group": "https://t.me/...",
  "log_file": "data/logs/<name>.log",
  "authorized": [],
  "sessions": [{"file": "...", "real_name": "...", "user_id": 0, "index": 1}],
  "state": "stopped",
  "last_cycle_time": {},
  "plan_name": "string",
  "plan_mode": "Starter",
  "session_count": 1,
  "renewal_price": "string",
  "last_renewal_at": "ISO8601",
  "last_renewal_days": 0,
  "renewal_history": [],
  "excluded_sessions": [],

  "plan": {
    "name": "string",
    "mode": "Starter | Enterprise",
    "cycle": 3600,
    "gap": 5,
    "session_count": 1
  },
  "history": {
    "purchases": [{"order_id": "...", "date": "...", "plan": "...", "duration_days": 0}],
    "renewals": [{"at": "ISO8601", "days": 0, "order_id": "...", "source": "renewal|creation"}],
    "session_replacements": [{"at": "ISO8601", "old_session": "...", "new_session": "...", "reason": "...", "source": "..."}]
  },
  "stats": {
    "total_posts_success": 0,
    "total_posts_failed": 0,
    "total_data_used_mb": 0,
    "sessions": {
      "<session_file>": {"posts_success": 0, "posts_failed": 0, "data_used_mb": 0}
    },
    "last_stats_update": "2026-02-09T12:00:00Z"
  },
  "transactions": [
    {"order_id": "...", "tx_hash": "...", "amount": "...", "currency": "...", "date": "..."}
  ]
}
```

- **Canonical** plan fields: `plan.name`, `plan.mode`, `plan.cycle`, `plan.gap`, `plan.session_count`.
- **Legacy** top-level `mode`, `plan_mode`, `cycle`, `gap`, `session_count`, `plan_name` are kept and synced from `plan` on save so existing code keeps working.

---

## Logical Grouping

Top-level fields are kept for compatibility; internally treat as:

| Group | Keys |
|-------|------|
| **Runtime config** | `name`, `bot_token`, `bot_username`, `cycle`, `gap`, `group_file`, `log_group`, `sessions`, `state` |
| **Plan config** | `plan.*` (canonical); legacy `plan_name`, `plan_mode`, `session_count`, `mode` synced on save |
| **Historical data** | `history.*`, `transactions` |
| **Analytics** | `stats.*` |

---

## Write Protection & Merge-Write

When `save_user_data(name, bot_dict)` is called for runtime/plan updates (e.g. `cycle`, `sessions`, `group_file`):

- **Do NOT overwrite** `history`, `stats`, or `transactions` unless they are explicitly present in `bot_dict` (e.g. full config from load → modify → save).
- **Merge-write strategy:**
  1. `existing_file_data` ← load current file (raw, no migration).
  2. `result` ← `merge_for_save(existing_file_data, bot_dict)`: all keys from `bot_dict` overwrite `existing` except for `history`, `stats`, `transactions` — those are only set when `bot_dict` contains them and value is not `None`.
  3. `result` ← `migrate_user_config(result)` (ensure structure; only inits missing).
  4. `ensure_legacy_compatibility(result)`.
  5. Write `result` to file.

So partial updates (e.g. `save_user_data(name, {"cycle": 100})`) never wipe history, stats, or transactions.

---

## Transaction Logging

When a payment is confirmed:

- **Append** a new object into `cfg["transactions"]` using `append_transaction()`.
- **Never** rebuild or reset the `transactions` list during migration or save.

**Usage example:**

```python
from code.user_config import append_transaction

# When payment is confirmed (e.g. in shop worker or after payment callback)
cfg = load_user_data(name)
append_transaction(
    cfg,
    order_id=order_id,
    tx_hash=payment_tx_hash or "",
    amount=str(amount),
    currency=currency,
    date=datetime.utcnow().isoformat() + "Z",
)
save_user_data(name, cfg)
```

---

## Session Replacement Tracking

Whenever a session is replaced:

- Call `append_session_replacement_to_history()` so both legacy `session_replacements` and `history.session_replacements` are updated.
- Compatibility sync on save keeps both in sync.

**Usage example:**

```python
from code.user_config import append_session_replacement_to_history
from datetime import datetime

# After replacing a session (admin replace, repair, or auto dead-session)
append_session_replacement_to_history(
    cfg,
    at=datetime.utcnow().isoformat() + "Z",
    old_session=old_session_file,
    new_session=new_session_file,  # or "" for dead-only (no replacement yet)
    reason="dead",
    source="admin_replace_error",
)
save_user_data(name, cfg)
```

---

## Stats Update Rules

The posting engine should:

- Increment `cfg["stats"]["total_posts_success"]` or `cfg["stats"]["total_posts_failed"]` per attempt.
- Update per-session stats in `cfg["stats"]["sessions"][session_file]` (`posts_success`, `posts_failed`, `data_used_mb`).
- Add to `total_data_used_mb` using message payload size estimates (bytes → MB).

**Usage:** Call `record_post_stats(cfg, session_file=..., success=..., data_used_bytes=...)` after each post attempt; then save when appropriate (e.g. periodically or on state change).

```python
from code.user_config import record_post_stats

record_post_stats(cfg, session_file=session_file, success=True, data_used_bytes=len(message_text or "") * 2)
```

---

## Migration Safety

`migrate_user_config()` must:

- **Never overwrite** existing non-empty `history`, `stats`, or `transactions`.
- **Only initialize** missing structures (setdefault / fill from legacy only when target is empty).

So existing history/stats/transactions in file are preserved on every load.

---

## Redundant Fields Resolution

| Legacy / Duplicate | Canonical | Rule |
|--------------------|-----------|------|
| `mode`, `plan_mode` | `plan.mode` | Use `get_plan_mode(cfg)`. On save, sync to both `mode` and `plan_mode`. |
| `cycle`, `gap`, `session_count`, `plan_name` | `plan.*` | On save, copy from `plan` to top-level. |
| `renewal_history` | `history.renewals` | Migration copies legacy → history; save syncs history → legacy. |
| `session_replacements` | `history.session_replacements` | Same: migration and save keep both in sync. |

---

## Migration (on load)

**When:** Every `load_user_data(name)` call.

**Logic (idempotent):**

1. **plan**
   - If `plan` is missing or not a dict, set `plan = {}`.
   - Set `plan.name` from `plan_name` if missing.
   - Set `plan.mode` from `mode` or `plan_mode` (default `"Starter"`).
   - Set `plan.cycle` from `cycle` (default 3600).
   - Set `plan.gap` from `gap` (default 5).
   - Set `plan.session_count` from `session_count` (default 1).

2. **history**
   - If `history` is missing or not a dict, set `history = { purchases: [], renewals: [], session_replacements: [] }`.
   - If `history.renewals` is empty and `renewal_history` exists, set `history.renewals = renewal_history`.
   - If `history.session_replacements` is empty and `session_replacements` exists, set `history.session_replacements = session_replacements`.

3. **stats**
   - If `stats` is missing or not a dict, set `stats = { total_posts_success: 0, total_posts_failed: 0, total_data_used_mb: 0, sessions: {} }`.
   - Optionally seed from any existing top-level `total_posts_*` / `stats_sessions` if present.

4. **transactions**
   - If `transactions` is missing or not a list, set `transactions = []`.

5. **Preserve** all original keys; only add or fill defaults. No key removal.

---

## Compatibility Sync (on save)

**When:** Every `save_user_data(name, bot_dict)` call.

**Logic:**

1. From **plan** to top-level: set `mode`, `plan_mode`, `cycle`, `gap`, `session_count`, `plan_name` from `plan` when `plan` is present.
2. **renewal_history**: If legacy `renewal_history` has more entries than `history.renewals`, merge missing entries into `history.renewals`, then set `renewal_history = history.renewals`.
3. **session_replacements**: If legacy `session_replacements` has more entries than `history.session_replacements`, merge missing into `history.session_replacements`, then set `session_replacements = history.session_replacements`.

Result: Posting engine, creation engine, and admin flow can keep using `cfg.get("mode")`, `cfg.get("cycle")`, `cfg.get("renewal_history")`, etc.; they always see up-to-date values.

---

## Validation Rules

`validate_user_config(cfg, for_new_bot=False)` always checks:

- **plan:** If present, must be a dict; and `plan.mode` (or legacy `mode` / `plan_mode`) must exist.
- **stats:** If present, must be a dict.
- **history:** If present, must be a dict.
- **transactions:** If present, must be a list.
- **sessions:** If present, must be a list.

With `for_new_bot=True` additionally:

- **Required:** `bot_token`, `name`, `valid_till` non-empty.
- **Required:** Either `plan` (with `mode` or `session_count`) or legacy `mode` / `cycle` / `session_count`.

Use before save when creating new bots; fix any returned errors before calling `save_user_data`.

---

## System Requirement

- **Posting engine, creation engine, admin creation flow** continue to use existing keys (`mode`, `cycle`, `gap`, `sessions`, `valid_till`, `renewal_history`, etc.).
- **No existing bot** should stop working: migration only adds/fills structure; compatibility sync on save keeps legacy keys aligned with `plan` / `history`.
- **New bots** (admin-created or purchase-created) are written with the improved structure (`plan`, `history`, `stats`, `transactions`) and legacy keys populated from `plan` / `history`.

---

## Implementation

- **Module:** `code/user_config.py`
- **Load:** `utils.load_user_data()` → after load, runs `migrate_user_config(data)` and returns the result.
- **Save (merge-write):** `utils.save_user_data(name, bot_dict)` → `existing = _load_user_data_raw(safe)`; `result = merge_for_save(existing, bot_dict)`; `result = migrate_user_config(result)`; `ensure_legacy_compatibility(result)`; write.
- **Protected keys:** `PROTECTED_KEYS = ("history", "stats", "transactions")` — only overwritten when explicitly passed in `bot_dict` (non-None).
- **Canonical mode:** `user_config.get_plan_mode(cfg)`.
- **Renewals:** `append_renewal_to_history(cfg, at=..., days=..., order_id=..., source=...)` (used in `extend_valid_till_for_bot`).
- **Session replacements:** Use `append_session_replacement_to_history(cfg, at=..., old_session=..., new_session=..., reason=..., source=...)`; both legacy and `history.session_replacements` are updated; compatibility sync on save keeps them in sync.
- **Transactions:** Use `append_transaction(cfg, order_id=..., tx_hash=..., amount=..., currency=..., date=...)` when payment is confirmed; never rebuild/reset the list. **Idempotent:** if `order_id` already exists, the function returns `False` and does not insert (prevents duplicates when payment providers retry callbacks).
- **Stats:** Use `record_post_stats(cfg, session_file=..., success=..., data_used_bytes=...)` in the posting engine. **Stats flush:** posting engine updates stats in memory and flushes to disk on every cycle completion, every 5–10 minutes (periodic task), and on shutdown. **`last_stats_update`:** ISO8601 string inside `stats`; set on each flush so you can see when stats were last written (e.g. “why are stats not updating?” → worker stopped if timestamp is stale).
- **New bot creation:** Admin `_core_create_adbot_async` and shop-triggered creation both build `plan`, `history`, `stats`, `transactions` and legacy keys so admin-created and purchase-created bots behave identically.

---

## Confirmation: No Code Changes Required in Existing Flows

- **Posting engine:** Continues to use `cfg.get("cycle")`, `cfg.get("gap")`, `cfg.get("sessions")`, `cfg.get("mode")`, etc. No changes required. Optional: integrate `record_post_stats()` for analytics.
- **Admin creation flow:** Unchanged; already writes the improved structure and legacy keys for new bots.
- **Shop purchase flow:** Unchanged; form is passed to the same `_core_create_adbot_async`; new bots get the same structure. Optional: call `append_transaction()` when payment is confirmed (e.g. in payment worker or shop handler).
- **Session replacement (admin/repair/users):** Can keep appending to `cfg["session_replacements"]`; merge/sync on save preserves entries. For consistency, call `append_session_replacement_to_history(cfg, ...)` so both legacy and `history` are updated in one place.
