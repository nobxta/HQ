# Per-User Storage Migration — Complete

## Summary

The project has been fully migrated from a single `adbot.json` to per-user JSON storage. There is **no runtime dependency** on `adbot.json`.

---

## Modified Files

| File | Changes |
|------|---------|
| **code/config.py** | Added `DATA_DIR`, `DATA_USER_DIR`, `DATA_LOGS_DIR`, `DATA_INDEX_FILE`, `DATA_POOL_FILE`; removed `ADBOT_JSON`; create data dirs on startup |
| **code/utils.py** | Added `name_to_filename`, `load_index`, `save_index`, `get_name_by_token`, `load_user_data`, `save_user_data`, `load_pool`, `save_pool`, `delete_bot_from_storage`; rewrote `load_adbot`/`save_adbot` to use new storage; updated `discover_local_sessions`, `check_all_active_sessions`, `run_startup_validation`, `get_bot_log_path`, `log_bot_event`, `add_admin_alert`, `recreate_log_group_for_bot` |
| **code/users.py** | Updated `_get_cfg`, `_save_bot_config`, `_mark_session_dead_and_replace`, `_mark_bot_expired`, `_mark_bot_dead`, `_persist_last_cycle`; added imports for new storage functions |
| **code/admin.py** | Updated `_core_create_adbot_async` to write user file, index, pool; updated delete handlers to use `delete_bot_from_storage`; added storage imports |
| **code/admin_ptb.py** | No logic changes; uses `load_adbot` from admin (which uses new storage) |
| **main.py** | Updated `_main_loop_job_consumer` delete flow to use `delete_bot_from_storage`; updated comments |
| **code/crash.py** | Updated docstrings |
| **code/diagnostic.py** | Updated to use new storage paths; fixed `PROJECT_ROOT` for file inspection; replaced `adbot.json` with `data/pool.json`, `data/index.json` |
| **code/notify.py** | Updated docstring |
| **code/workers.py** | Updated docstring |
| **.gitignore** | Added `data/` |

---

## Remaining References to `adbot.json`

All runtime code uses the new storage. The following references remain only in **documentation** (docs/*.md):

- `docs/DATA_STORAGE_AND_MIGRATION.md` — historical/analysis doc
- `docs/PER_USER_STORAGE_IMPLEMENTATION_PLAN.md` — implementation plan
- `docs/FILE_MAP.md`, `docs/TECHNICAL_DOCUMENTATION.md`, `docs/SHOP_BOT_UPGRADE_REVIEW.md`, etc. — legacy references

These docs can be updated separately if desired.

---

## New Storage Structure

```
data/
├── index.json       # {"by_token": {"<bot_token>": "<name>"}, "by_name": {"<name>": "<bot_token>"}}
├── pool.json        # {"free_sessions": [], "dead_sessions": [], "admin_alerts": []}
├── user/
│   └── <name>.json  # Full bot config per user (e.g. nobi.json, rahul.json)
└── logs/
    └── <name>.log   # Per-user logs (e.g. nobi.log, rahul.log)
```

---

## Create AdBot Flow (Verification)

When a new AdBot is created via the admin wizard:

1. **`/data/user/<name>.json`** — Created with full bot config (name, bot_token, sessions, log_file, etc.)
2. **`/data/logs/<name>.log`** — Created when first log event is written (e.g. when user sends /start)
3. **`/data/index.json`** — Updated with `by_token[bot_token] = name` and `by_name[name] = bot_token`
4. **`/data/pool.json`** — Updated: assigned sessions removed from `free_sessions`

The admin-provided name is sanitized via `name_to_filename()` (lowercase, alphanumeric + underscore). Uniqueness is enforced by appending `_2`, `_3`, etc. if the name already exists.

---

## Behaviors Preserved

- Session assignment logic
- Stats tracking (`stats.by_session`, `total_sent`, `total_failed`, `last_cycle_time`, `ban_error_count_by_session`)
- Worker update handlers (`_apply_worker_result` → `_save_bot_config`)
- Cycle tracking
- Admin alerts (stored in `pool.json`)
