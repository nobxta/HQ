# /fix Command Implementation Summary

**Date:** 2026-02-12

## New Handlers Added

### Admin Bot (admin_ptb.py, PTB)

| Handler | Type | Description |
|---------|------|--------------|
| `cmd_fix` | CommandHandler("fix") | `/fix [bot_name]` — Opens repair menu; if no arg, shows AdBot picker |
| `fix_cancel` | CallbackQuery | Cancel repair flow |
| `fix_sel:N` | CallbackQuery | Select AdBot from list (index N) |
| `fix_log` | CallbackQuery | Fix Log Group |
| `fix_sess` | CallbackQuery | Fix Sessions — show session list |
| `fix_sess:N` | CallbackQuery | Select session at index N for replacement |
| `fix_sess_rep` | CallbackQuery | Execute session replacement |
| `fix_sess_back` | CallbackQuery | Back to repair menu |
| `fix_cfg` | CallbackQuery | Fix Config |
| `fix_tok` | CallbackQuery | Fix Bot Token — enter wait-for-token state |
| `fix_back` | CallbackQuery | Back to repair menu |
| `on_message` (fix_wait_token) | MessageHandler | Receives new bot token when in fix_tok state |

### User Bot (users.py, Telethon)

| Handler | Type | Description |
|---------|------|--------------|
| `cmd_fix` | NewMessage(pattern="/fix") | `/fix` — Opens repair menu for current AdBot |
| `CB_FIX_MENU` | CallbackQuery | Fix button from main menu — opens repair menu |
| `CB_FIX_LOG` | CallbackQuery | Fix Log Group |
| `CB_FIX_SESS` | CallbackQuery | Fix Sessions |
| `PREFIX_FIX_SESS:N` | CallbackQuery | Select session at index N |
| `PREFIX_FIX_SESS_REP:N` | CallbackQuery | Replace session at index N |
| `CB_FIX_CFG` | CallbackQuery | Fix Config |
| `CB_FIX_TOK` | CallbackQuery | Fix Bot Token |
| `CB_FIX_CANCEL` | CallbackQuery | Cancel |
| `CB_FIX_BACK` | CallbackQuery | Back to repair menu |
| `on_set_message_input` (fix_wait_token) | NewMessage | Receives new bot token when in fix_tok state |

---

## New Repair Modules / Functions

### code/repair.py

| Function | Description |
|----------|-------------|
| `classify_spambot_response(text)` | Maps SpamBot reply to ACTIVE, TEMP_LIMITED, HARD_LIMITED, FROZEN, UNKNOWN |
| `check_sessions_health_parallel(session_files)` | Runs SpamBot health check for all sessions in parallel |
| `repair_fix_log_group(bot_token, log_async)` | Validates log group; if invalid, recreates with retry across sessions |
| `repair_fix_sessions(bot_token, log_async)` | Runs SpamBot check; returns session statuses for interactive replacement |
| `repair_replace_session(bot_token, old_file, status, log_async)` | Replaces session with one from pool; moves old to frozen/limited/unauth |
| `repair_fix_config(bot_token, log_async)` | Validates and auto-repairs user JSON config |
| `repair_fix_bot_token(bot_token, new_token, log_async)` | Updates token, restarts worker, adds new bot to log group |

### config.py

- Added `SESSIONS_FROZEN`, `SESSIONS_LIMITED`, `SESSIONS_UNAUTH` paths

---

## /fix Command Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ADMIN: /fix [bot_name]          USER: /fix or [Fix] button              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    REPAIR MENU (5 options)                               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│  │ Fix Log Group│ │ Fix Sessions │ │ Fix Config   │ │ Fix Bot Token│   │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘   │
│         │                │                │                │           │
│         │                │                │                │  ┌────────┐│
│         │                │                │                │  │ Cancel ││
│         │                │                │                │  └────────┘│
└─────────┼────────────────┼────────────────┼────────────────┼───────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ 1. FIX LOG GROUP│ │ 2. FIX SESSIONS │ │ 3. FIX CONFIG   │ │ 4. FIX BOT TOKEN│
├─────────────────┤ ├─────────────────┤ ├─────────────────┤ ├─────────────────┤
│ • Validate:     │ │ • SpamBot check │ │ • Validate:     │ │ • Ask for token │
│   exists,       │ │ • Show list:    │ │   log path,     │ │ • Warning msg   │
│   accessible,   │ │   fn — STATUS   │ │   sessions,     │ │ • Receive token │
│   bot present   │ │ • Select →      │ │   group files   │ │ • Validate API  │
│ • If invalid:   │ │   Replace/Cancel│ │ • Auto-repair:  │ │ • Update index  │
│   recreate with │ │ • Replace:      │ │   paths, index  │ │ • Restart bot   │
│   retry across  │ │   pool assign   │ │ • Save + notify │ │ • Add to log grp│
│   sessions      │ │   move old to   │ │                 │ │ • Confirm       │
│ • Join sessions │ │   frozen/limit  │ │                 │ │                 │
│ • Update config │ │   unauth        │ │                 │ │                 │
│ • Log success   │ │ • Join new to   │ │                 │ │                 │
│                 │ │   log group     │ │                 │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Storage Updates

All repair operations update:

- `/data/user/<name>.json`
- `/data/index.json` (Fix Bot Token only)
- `/data/pool.json` (Fix Sessions replacement only)
- `/data/logs/<name>.log` (all repair actions logged via `log_bot_event`)

---

## Session Destinations

| Status | Old session moved to |
|--------|----------------------|
| FROZEN | `sessions/frozen/` |
| TEMP_LIMITED, HARD_LIMITED | `sessions/limited/` |
| UNKNOWN, other | `sessions/unauth/` |
