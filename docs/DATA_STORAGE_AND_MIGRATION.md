# Data Storage Analysis & Per-User Migration Guide

This document explains how the current JSON storage works and how to migrate to per-user files under `/data/user/<name>.json` and `/data/logs/<name>.log` without breaking existing logic.

---

## Part 1: How the Current System Works

### 1.1 User creation data storage

**Where it’s stored:** In the single file `adbot.json` at project root (see `code/config.py`: `ADBOT_JSON = BASE_DIR / "adbot.json"`).

**When it’s written:**

- **Create AdBot flow** (`code/admin.py`):
  - Wizard step `"name"`: admin sends a text message → stored in `_create_state[user_id]["data"]["name"]` (in-memory only).
  - On final step, `_core_create_adbot_async()` builds a **bot entry** and writes it into `adbot_data["bots"][bot_token]`, then calls `save_adbot(adbot_data)`.
  - The **name** (e.g. `"Nobi"`, `"Kartik"`) is the admin-provided identifier and is stored inside each bot entry as `cfg["name"]`.

**What’s stored per bot (inside `data["bots"][bot_token]`):**

- `name` — admin-provided label (e.g. "Nobi", "Kartik")
- `bot_token`, `bot_username`
- `valid_till`, `cycle`, `gap`, `mode`, `group_file`
- `log_group`, `log_file`
- `authorized` — list of Telegram user IDs
- `sessions` — list of `{ "file", "real_name", "user_id", "index" }`
- `state` — `"running"` | `"stopped"` | `"dead"` | `"expired"`
- `last_cycle_time`, `ban_error_count_by_session`, `post_link`, `message_text`, `excluded_sessions`, `stats`, etc.

So **user creation data** = the whole bot object under `adbot.json` → `bots` → `bot_token`.

---

### 1.2 User rejection / authorization status

**Where:** In `adbot.json` → `bots[bot_token]["authorized"]`.

- **Type:** List of Telegram `user_id` (integers).
- **Meaning:** Users in this list are “authorized” to use the bot; others may be rejected or see a different flow depending on your handlers.
- **Read/write:** Any code that loads the bot config (e.g. `_get_cfg(bot_token)` in `users.py`) can read `cfg["authorized"]`. Updates are done via `_save_bot_config(bot_token, updater)` which does load → updater(cfg) → save.

There is no separate “rejection” list; authorization is binary (in list = authorized).

---

### 1.3 How sessions are tracked and saved

**Session pool (global, not per-bot):**

- **free_sessions:** `adbot.json` → `free_sessions` (list of session **filenames**, e.g. `"4hlpp4ku7kcabc0c.session"`).
- **dead_sessions:** `adbot.json` → `dead_sessions` (list of filenames moved to `sessions/dead/` or considered invalid).

**Per-bot assignment:**

- Each bot has `bots[bot_token]["sessions"]`: list of dicts `{"file": "<name>.session", "real_name", "user_id", "index"}`.
- Session **files** live under `sessions/active/` (see `config.SESSIONS_ACTIVE`). The JSON only stores the filename, not the full path.

**Flow:**

1. **Startup:** `main.py` calls `discover_local_sessions(data)` which scans `sessions/active/*.session`, adds any filename not in `free_sessions` or any bot’s `sessions` to `free_sessions`, then `save_adbot(data)`.
2. **Create AdBot:** `_core_create_adbot_async()` takes `sessions_count` from the form, pops that many from `adbot_data["free_sessions"]`, validates each, assigns to the new bot’s `sessions`, and saves.
3. **Delete AdBot:** Main loop job or admin flow loads adbot, `pop`s the bot from `bots`, appends the bot’s session filenames either to `free_sessions` or `dead_sessions` (and optionally moves files to `sessions/dead/`), then saves.
4. **Replace dead/error sessions:** Admin flows in `admin.py` (`_admin_replace_dead`, `_admin_replace_error_sessions`) modify `free_sessions`, `dead_sessions`, and `cfg["sessions"]`, then `save_adbot(data)`.

So **sessions are tracked** in the same `adbot.json`: global lists + per-bot `sessions`.

---

### 1.4 Bot statistics and logs

**Statistics:**

- Stored **per bot** in `adbot.json` → `bots[bot_token]`:
  - `stats.by_session[session_file]`: `{ "cycles", "posts", "errors" }`
  - `stats.total_sent`, `stats.total_failed`
  - `last_cycle_time[session_file]` (last cycle timestamp per session)
  - `ban_error_count_by_session[session_file][chat_id#topic_id]`
- **Updated by:** Controller in `users.py` → `_apply_worker_result()` (e.g. `cycle_done`, `cycle_failed`, `session_died`, `ban_error`) and helpers like `_inc_stat()`, `_inc_stat_total()`, `_persist_last_cycle()`, `_increment_ban_error_count()`. All go through `_save_bot_config(bot_token, upd)` which does load full adbot → update that bot’s config → save full adbot.

**Logs:**

- **Per-bot log file:** Path comes from `cfg["log_file"]` or default `logs/bots/<bot_username>.log` (see `utils.get_bot_log_path()`).
- **Write:** `utils.log_bot_event(bot_token, message)` appends a timestamped line to that file and, if `log_file` was missing in config, sets `cfg["log_file"]` and calls `save_adbot(data)`.
- **App log:** General app log is `logs/adbot.log` (from `config.setup_logging()`), separate from per-bot logs.

So **stats** live in the same single `adbot.json`; **logs** are already separate files under `logs/bots/` (by bot username today).

---

### 1.5 Modules / functions that do JSON read/write

**Central place: `code/utils.py`**

| Function           | Role |
|--------------------|------|
| `load_adbot()`     | Read `adbot.json`; if missing, create default schema and save; on parse error, re-raise (no overwrite with empty). |
| `save_adbot(data)` | Ensure top-level keys exist, optional backup if bot count shrinks, then write `adbot.json`. |
| `_default_schema()` | Returns `{"bots": {}, "free_sessions": [], "dead_sessions": [], "admin_alerts": []}`. |

**Callers of `load_adbot` / `save_adbot`:**

- **utils.py:** `discover_local_sessions`, `check_all_active_sessions`, `run_startup_validation`, `get_bot_log_path`, `log_bot_event`, `add_admin_alert`, `recreate_log_group_for_bot`.
- **users.py:** `_get_cfg`, `_save_bot_config`, and many places that load adbot to read/update one bot or the pool (e.g. `_mark_session_dead_and_replace`, `_mark_bot_expired`, `_persist_last_cycle`, delete/replace flows, worker result handler, create_user_bot config load).
- **admin.py:** Create flow (`_core_create_adbot_async`), validate/replace/recreate/delete flows, Add Sessions upload, Manage AdBots list, callback handlers (all use `load_adbot()` then `save_adbot(data)`).
- **main.py:** Startup load, discover_local_sessions, main loop job consumer (delete_bot), shutdown loop.
- **diagnostic.py:** Loads adbot for diagnostics.

**Per-bot update pattern:**

- **users.py:** `_save_bot_config(bot_token, updater)` — load adbot, get `cfg = data["bots"][bot_token]`, run `updater(cfg)`, set `data["bots"][bot_token] = cfg`, `save_adbot(data)`.
- **Lookup:** `_get_cfg(bot_token)` — load adbot, return `data["bots"].get(bot_token)`.

So **all JSON read/write** goes through `load_adbot` / `save_adbot` and (for single-bot updates) `_save_bot_config` / `_get_cfg`.

---

### 1.6 How `adbot.json` is structured and updated

**Top-level structure:**

```json
{
  "bots": {
    "<bot_token>": {
      "name": "Nobi",
      "bot_token": "...",
      "bot_username": "...",
      "valid_till": "14/04/2028",
      "cycle": 300,
      "gap": 6,
      "mode": "Enterprise",
      "group_file": "Starter.txt",
      "log_group": "https://t.me/...",
      "log_file": "logs/bots/Minecraft_AfkBot.log",
      "authorized": [],
      "sessions": [ { "file": "...", "real_name": "...", "user_id": ..., "index": ... } ],
      "state": "stopped",
      "last_cycle_time": { "<session_file>": <ts>, ... },
      "ban_error_count_by_session": { ... },
      "post_link": "...",
      "message_text": "...",
      ...
    }
  },
  "free_sessions": [ "4hlpp4ku7kcabc0c.session" ],
  "dead_sessions": [ "Account 2 (2).session" ],
  "admin_alerts": [ { "ts": <float>, "type": "<alert_type>", "msg": "..." } ],
  "last_report_snapshot": { ... }
}
```

**Update patterns:**

1. **Full reload then save:** Almost every path does `data = load_adbot()`, mutate `data` (and/or `data["bots"][bot_token]`), then `save_adbot(data)`.
2. **Single-bot updates:** Via `_save_bot_config(bot_token, lambda c: c.update(...))` which loads, updates that bot’s dict, then saves the whole file.
3. **Create:** Add one key to `data["bots"]`, optionally remove session names from `free_sessions`, then save.
4. **Delete:** Remove one key from `data["bots"]`, merge its sessions into `free_sessions` or `dead_sessions`, save.

There is **no** file-level locking; the design assumes a single process plus one create-worker thread that does discrete create → save steps.

---

## Part 2: Current save/load flow (summary)

1. **Single file:** All persistent state (bots, free_sessions, dead_sessions, admin_alerts) lives in one `adbot.json`.
2. **Load:** `load_adbot()` reads the file (or creates default and saves), returns the full dict.
3. **Bot lookup:** By `bot_token`: `data["bots"][bot_token]` or `_get_cfg(bot_token)`.
4. **Bot update:** Load → change one bot’s object → save full file (`_save_bot_config` or direct `load_adbot` / mutate / `save_adbot`).
5. **Pool update:** Load → change `free_sessions` / `dead_sessions` / `admin_alerts` → save.
6. **List all bots:** Iterate `data["bots"].items()`; UI uses `(cfg.get("name") or token[:15], token)` for display.

So the **primary key** for bots is `bot_token`; `name` is a display/ownership label stored inside each bot.

---

## Part 3: What to change for per-user JSON + per-user logs

**Goal:**

- One file per “user” (admin-provided name): `/data/user/<name>.json` containing **that user’s bot** (or bots, if you later allow multiple).
- Logs per user: `/data/logs/<name>.log`.
- Filename = admin-provided identifier (e.g. `nobi.json`, `rahul.json`), **not** Telegram username.

Important: Almost all code today keys by **bot_token**, not by name. So you need a way to go from `bot_token` → `name` (or → user file path) without scanning all files every time.

---

### 3.1 Recommended layout

- **`/data/user/<name>.json`**  
  - Content: **one** bot object (the same dict that is currently `data["bots"][bot_token]`), plus optionally a `bot_token` field (already there) and a `name` field (already there).  
  - So each file looks like:  
    `{ "name": "nobi", "bot_token": "...", "bot_username": "...", "sessions": [...], ... }`  
  - If you later support multiple bots per “user”, you could make it `{ "bots": { "<token>": { ... } } }` per file; for a 1:1 name↔bot mapping, a single object is enough.

- **`/data/logs/<name>.log`**  
  - Same `<name>` as the user file (e.g. `nobi.log`). All log lines for that bot go here.

- **Index (required):** `bot_token` → `name` (or → path).  
  - Store this in a small **index file**, e.g. **`/data/index.json`**:  
    `{ "by_token": { "<bot_token>": "<name>" }, "by_name": { "<name>": "<bot_token>" } }`  
  - On create: write user file, write log path, update index.  
  - On delete: remove from index, optionally delete user file and log file.

- **Global pool and alerts:**  
  - Keep **one** shared file for sessions and alerts, e.g. **`/data/pool.json`**:  
    `{ "free_sessions": [], "dead_sessions": [], "admin_alerts": [] }`  
  - Same structure as current top-level; only `bots` move to per-user files.

So:

- **Read bot config:** Look up `name = index["by_token"][bot_token]`, then load `data/user/<name>.json` (or use a cache).
- **Write bot config:** Same lookup, then write only `data/user/<name>.json` (no need to write the whole adbot).
- **List bots:** Iterate `index["by_token"]` or scan `data/user/*.json` and use index for token↔name.
- **Log path:** `/data/logs/<name>.log` with `<name>` from index (or from loaded user JSON).

You must **sanitize** the admin-provided name for filenames (e.g. lowercase, replace spaces/special chars with `_`, limit length), and ensure **uniqueness** (e.g. two admins must not create the same `name` or you overwrite; you can enforce in the create wizard).

---

### 3.2 Functions to introduce or change

**New or moved in `code/config.py`:**

- `DATA_DIR = BASE_DIR / "data"`
- `DATA_USER_DIR = DATA_DIR / "user"`
- `DATA_LOGS_DIR = DATA_DIR / "logs"`
- `DATA_INDEX_FILE = DATA_DIR / "index.json"`
- `DATA_POOL_FILE = DATA_DIR / "pool.json"`
- Create these dirs at startup (like existing `LOGS_DIR.mkdir(...)`).

**New in `code/utils.py` (or a small `code/storage.py`):**

1. **`name_to_filename(name: str) -> str`**  
   - Sanitize admin name to a safe filename (e.g. lowercase, alphanumeric + underscore, max length). Use this for both `<name>.json` and `<name>.log`.

2. **`load_index() -> dict`**  
   - Read `DATA_INDEX_FILE`; if missing, return `{"by_token": {}, "by_name": {}}` and optionally write it.

3. **`save_index(index: dict) -> None`**  
   - Write `DATA_INDEX_FILE`.

4. **`get_name_by_token(bot_token: str) -> str | None`**  
   - Return `load_index()["by_token"].get(bot_token)`.

5. **`load_user_data(name: str) -> dict | None`**  
   - Path = `DATA_USER_DIR / f"{name_to_filename(name)}.json"`. If file exists, load and return the bot dict; else None.

6. **`save_user_data(name: str, bot_dict: dict) -> None`**  
   - Same path; write the bot dict (single bot object) to that file.

7. **`load_pool() -> dict`**  
   - Read `DATA_POOL_FILE`; if missing, return `_default_pool()` (free_sessions, dead_sessions, admin_alerts); ensure dir exists.

8. **`save_pool(data: dict) -> None`**  
   - Write `DATA_POOL_FILE`.

Then refactor:

- **`load_adbot()`**  
  - Becomes: load pool + build a “virtual” union for backward compatibility, **or** you remove it and replace every use with explicit `load_pool()` + `load_user_data(get_name_by_token(token))` / `load_all_bots()` (see below).

- **`save_adbot(data)`**  
  - Either deprecated and replaced by:  
    - `save_pool(data)` when only pool keys change, or  
    - `save_user_data(name, bot_dict)` when one bot changes, or  
    - For “save entire state” callers: iterate bots and save each to its user file, then save pool.

A **backward-compat** option during migration: keep `load_adbot()` that:

- Loads pool from `DATA_POOL_FILE`,
- Loads index from `DATA_INDEX_FILE`,
- For each `(token, name)` in index, loads `data/user/<name>.json` and builds `data["bots"][token] = that dict`,
- Returns `{ "bots": {...}, "free_sessions": ..., "dead_sessions": ..., "admin_alerts": ... }` so existing code that expects “one big dict” still works.  
Then gradually replace call sites with direct `load_pool` / `load_user_data` / `save_user_data` / `save_pool` so you don’t have to rewrite everything at once.

**In `code/utils.py`:**

- **`get_bot_log_path(bot_token: str)`**  
  - Resolve name: `name = get_name_by_token(bot_token)`; if None, return None.  
  - Path: `DATA_LOGS_DIR / f"{name_to_filename(name)}.log"` (or keep a `log_file` inside user JSON that stores relative path like `data/logs/nobi.log`).

- **`log_bot_event(bot_token, message)`**  
  - Use the new `get_bot_log_path`; append line to file. If you store `log_file` in user JSON, update it with the new path and call `save_user_data(name, cfg)` instead of `save_adbot`.

- **`add_admin_alert(...)`**  
  - Load pool, append to `admin_alerts`, `save_pool`.

- **`recreate_log_group_for_bot(bot_token)`**  
  - Load user data by token→name, update `log_group` (and optionally `log_file`) in that dict, `save_user_data(name, cfg)`.

- **`discover_local_sessions`**, **`check_all_active_sessions`**, **`run_startup_validation`**  
  - These work on pool + all bots. So: load pool, load index, for each name load user file, build in-memory list of all `sessions` and use current logic; then write back to pool and to each affected user file (e.g. when moving sessions to dead or reassigning).

**In `code/users.py`:**

- **`_get_cfg(bot_token)`**  
  - Replace with: `name = get_name_by_token(bot_token)`; if not name, return None; return `load_user_data(name)`.

- **`_save_bot_config(bot_token, updater)`**  
  - Resolve name; load user dict; run updater; `save_user_data(name, updated_dict)`. No longer load/save entire adbot.

- **`get_bot_config` (if used)**  
  - Same as _get_cfg for the new storage.

Any other place that does `data = load_adbot(); cfg = data["bots"].get(bot_token)` should switch to _get_cfg or to `load_user_data(get_name_by_token(bot_token))`. Any place that does `save_adbot(data)` after changing one bot should switch to `_save_bot_config` or to `save_user_data(name, cfg)`.

**In `code/admin.py`:**

- **Create flow (`_core_create_adbot_async`):**  
  - After building `entry` (the bot dict):  
    - `name` = form["name"] (sanitize with `name_to_filename` for paths).  
    - Ensure `name` is unique (e.g. `not (DATA_USER_DIR / f"{name}.json").exists()` or check index).  
    - Write **user file:** `save_user_data(name, entry)`.  
    - Update **index:** `load_index()` → add `by_token[bot_token]=name`, `by_name[name]=bot_token` → `save_index()`.  
    - Update **pool:** remove assigned session names from `free_sessions` (and optionally add to dead_sessions if you move some), then `save_pool()`.  
  - Do **not** write to a single adbot.json anymore.

- **Delete flow:**  
  - Load index, get name by token; load user file (to get session list); update pool (free_sessions or dead_sessions); remove token from index; optionally delete `data/user/<name>.json` and `data/logs/<name>.log`; save pool and index.

- **Manage AdBots list:**  
  - Build list from index: for each `(name, token)` in index (or by scanning user dir), load user file to get display name if needed; show buttons as today.

- **Validate / Replace / Recreate:**  
  - These already work per `bot_token`; they load full adbot and update one bot. Switch them to: load pool, load user by token→name, update user dict, save user file, and when they modify free_sessions/dead_sessions, save pool.

**In `main.py`:**

- **Startup:**  
  - Replace `data = load_adbot()` with a “load full state” helper that builds the same structure from pool + index + all user files (for `discover_local_sessions` and `resume_adbots`).

- **discover_local_sessions(data):**  
  - “data” can be the virtual merged state; after discovering, you need to update pool (free_sessions) and save pool. If you add new sessions to pool only, just `save_pool()`.

- **delete_bot job:**  
  - Same as admin delete: update pool + index, optionally delete user/log file; no longer `load_adbot` / `save_adbot`.

**In `code/crash.py`:**

- **resume_adbots(data):**  
  - Today it does `for bot_token, cfg in data["bots"].items()`. So you can still pass a “virtual” merged dict (from the new “load full state” that reads index + all user files), or change it to: load index, for each (token, name) load user file and run the same resume logic. Easiest is to keep the same interface and have “load full state” return the same shape.

**Diagnostic / other:**  
- Any script that reads `adbot.json` should be updated to use the new paths (pool + index + user dir) or the compatibility `load_adbot()` that assembles them.

---

### 3.3 Session assignment and stats (no semantic change)

- **Session assignment:** Still driven by pool’s `free_sessions` and each bot’s `sessions` list. The only change is where those are stored: pool in `data/pool.json`, bot’s `sessions` in `data/user/<name>.json`. Create flow: read pool, pop from free_sessions, assign to new bot, write user file, update pool, update index.
- **Stats and last_cycle_time:** Stay in the same bot object; that object now lives in `data/user/<name>.json`. So `_save_bot_config` (which updates one bot) becomes “load user file by token→name, updater(dict), save user file”. No change to session assignment or stats semantics.

---

### 3.4 Migration from current single file

1. **One-time migration script (optional):**  
   - Read current `adbot.json`.  
   - Create `data/`, `data/user/`, `data/logs/`.  
   - Write `data/pool.json` with `free_sessions`, `dead_sessions`, `admin_alerts` (and any other global keys).  
   - Build index: for each `bot_token, cfg in data["bots"].items()`: `name = cfg.get("name") or token[:15]`, sanitize to `safe_name = name_to_filename(name)` (handle collisions by appending a number), write `data/user/<safe_name>.json` with the bot dict, add to index.  
   - Copy or create log files: e.g. for each bot, copy `logs/bots/<bot_username>.log` to `data/logs/<safe_name>.log` if you want to keep old logs.  
   - Write `data/index.json`.  
   - Then switch code to new load/save and optionally rename/backup old `adbot.json`.

2. **Backward compatibility during rollout:**  
   - Implement the “virtual” `load_adbot()` and a `save_adbot()` that, when called, writes back from the in-memory structure to pool + per-user files + index. Then you can migrate call site by call site to the new API without breaking.

3. **Uniqueness of `name`:**  
   - In the create wizard, after the user sends the name, check that `name_to_filename(name)` does not already exist in index (or as a file in `data/user/`). If it exists, ask for another name or append a suffix.

---

## Part 4: Summary

| Topic | Current | After migration |
|-------|--------|------------------|
| User creation data | `adbot.json` → `bots[bot_token]` | `data/user/<name>.json` (one bot object per file) |
| Authorization | `bots[bot_token]["authorized"]` | Same key in `data/user/<name>.json` |
| Sessions (pool) | `adbot.json` → free_sessions, dead_sessions | `data/pool.json` |
| Sessions (per bot) | `bots[bot_token]["sessions"]` | `data/user/<name>.json` → `sessions` |
| Stats / last_cycle / ban_error | Inside bot object | Same, inside `data/user/<name>.json` |
| Logs | `logs/bots/<bot_username>.log` | `data/logs/<name>.log` |
| Bot lookup | `data["bots"][bot_token]` | Index `by_token` → name → `load_user_data(name)` |
| All JSON read/write | `utils.load_adbot` / `save_adbot` | New: load/save pool, index, per-user file; optionally keep compat `load_adbot` that merges them. |

Implementing the index, pool, and per-user load/save in one place (e.g. `utils.py` or `storage.py`) and then switching `_get_cfg` / `_save_bot_config` and the create/delete/admin flows to use them will move you to the new structure without breaking session assignment, stats tracking, or bot creation flow, as long as you keep the same in-memory shape where the rest of the code still expects “one big dict” (until you refactor those call sites to use the new API directly).
