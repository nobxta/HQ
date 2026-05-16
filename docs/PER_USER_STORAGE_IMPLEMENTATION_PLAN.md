# Per-User JSON Storage — Implementation Plan

This document provides a precise, step-by-step implementation plan for migrating from a single `adbot.json` to per-user files under `/data/user/<name>.json` and `/data/logs/<name>.log`. Behavior remains identical; only the storage layout changes.

---

## 1. Repository Locations for New Components

### 1.1 Path constants — `code/config.py`

**Location:** After line 50 (after `ADBOT_JSON = BASE_DIR / "adbot.json"`), add:

```python
# Per-user storage (new architecture)
DATA_DIR = BASE_DIR / "data"
DATA_USER_DIR = DATA_DIR / "user"
DATA_LOGS_DIR = DATA_DIR / "logs"
DATA_INDEX_FILE = DATA_DIR / "index.json"
DATA_POOL_FILE = DATA_DIR / "pool.json"
```

**Directory creation:** Add after line 55 (with other `mkdir` calls):

```python
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_USER_DIR.mkdir(parents=True, exist_ok=True)
DATA_LOGS_DIR.mkdir(parents=True, exist_ok=True)
```

---

### 1.2 Storage primitives — `code/utils.py`

All new storage functions belong in `code/utils.py`, alongside the existing `load_adbot` / `save_adbot`. Place them **after** the `_loads` / `_dumps` definitions (around line 31) and **before** the first `async def` (around line 57).

| Function | Location | Purpose |
|----------|----------|---------|
| `name_to_filename(name: str) -> str` | `code/utils.py` (new, ~line 35) | Sanitize admin-provided name to a safe filename (lowercase, alphanumeric + underscore, max 64 chars). |
| `load_index() -> dict` | `code/utils.py` (new) | Read `DATA_INDEX_FILE`; return `{"by_token": {}, "by_name": {}}` if missing. |
| `save_index(index: dict) -> None` | `code/utils.py` (new) | Write `DATA_INDEX_FILE`.

| Function | Location | Purpose |
|----------|----------|---------|
| `get_name_by_token(bot_token: str) -> str \| None` | `code/utils.py` (new) | Return `load_index()["by_token"].get(bot_token)`. |
| `load_user_data(name: str) -> dict \| None` | `code/utils.py` (new) | Read `DATA_USER_DIR / f"{name_to_filename(name)}.json"`; return bot dict or None. |
| `save_user_data(name: str, bot_dict: dict) -> None` | `code/utils.py` (new) | Write bot dict to `DATA_USER_DIR / f"{name_to_filename(name)}.json"`. |

| Function | Location | Purpose |
|----------|----------|---------|
| `_default_pool() -> dict` | `code/utils.py` (new) | Return `{"free_sessions": [], "dead_sessions": [], "admin_alerts": []}`. |
| `load_pool() -> dict` | `code/utils.py` (new) | Read `DATA_POOL_FILE`; if missing, return `_default_pool()` and optionally save it. |
| `save_pool(data: dict) -> None` | `code/utils.py` (new) | Write `DATA_POOL_FILE`. |

---

## 2. First Three Functions to Modify (for reading from per-user storage)

The system must read bot configs from per-user files before writing to them. To start reading from the new storage while keeping the rest functional:

### Priority 1: `_get_cfg(bot_token)` — `code/users.py` (lines 444–447)

**Current:** `load_adbot()` → `data["bots"].get(bot_token)`.

**New logic (after load_adbot is compatibility layer):**

1. Call `get_name_by_token(bot_token)` to resolve `name`.
2. If `name` is None, call `load_adbot()` → `data["bots"].get(bot_token)` (fallback for old index).
3. Otherwise call `load_user_data(name)` and return that.

**Migration order:** Implement `load_adbot()` compatibility layer first (see below), then modify `_get_cfg` to prefer `get_name_by_token` + `load_user_data`, with fallback to `load_adbot()` when index has no entry.

---

### Priority 2: `load_adbot()` — `code/utils.py` (lines 349–370)

**Change:** Rebuild the full in-memory structure from the new storage (pool + index + user files):

1. `pool = load_pool()`
2. `index = load_index()`
3. `bots = {}`
4. For each `(token, name)` in `index["by_token"]`:
   - `cfg = load_user_data(name)`
   - If `cfg`: `bots[token] = cfg`
5. Return `{ "bots": bots, "free_sessions": pool["free_sessions"], "dead_sessions": pool["dead_sessions"], "admin_alerts": pool["admin_alerts"] }`

**Backward compatibility:** If `DATA_INDEX_FILE` does not exist (or is empty), call the **old** load logic (read `adbot.json` directly). This preserves behavior during migration and when the old file is still the source of truth.

---

### Priority 3: `_save_bot_config(bot_token, updater)` — `code/users.py` (lines 450–459)

**Current:** `load_adbot()` → `updater(cfg)` → `save_adbot(data)`.

**New logic:**

1. `name = get_name_by_token(bot_token)`
2. If `name` is None: fallback to existing behavior (load full adbot, update one bot, save full adbot).
3. Otherwise:
   - `cfg = load_user_data(name)`
   - If `cfg` is None: return False
   - `updater(cfg)`
   - `save_user_data(name, cfg)`
   - Return True

**Effect:** Once the index is populated and user files exist, per-bot updates write only the per-user file. No full-file save.

---

## 3. Staged Migration Approach

### Phase 1: Storage primitives (no behavior change)

**Files to update:**

| File | Changes |
|------|---------|
| `code/config.py` | Add `DATA_DIR`, `DATA_USER_DIR`, `DATA_LOGS_DIR`, `DATA_INDEX_FILE`, `DATA_POOL_FILE`; create dirs. |
| `code/utils.py` | Add `name_to_filename`, `load_index`, `save_index`, `get_name_by_token`, `load_user_data`, `save_user_data`, `_default_pool`, `load_pool`, `save_pool`. |

**No callers** use these yet. Tests: create `data/` manually, call each new function, verify no errors.

---

### Phase 2: Compatibility layer and first read path

**Files to update:**

| File | Changes |
|------|---------|
| `code/utils.py` | Modify `load_adbot()` to support both: (A) if `DATA_INDEX_FILE` exists and has entries: use `load_pool()` + index + `load_user_data()` to build merged structure; (B) else: use existing `adbot.json` read. |
| `code/utils.py` | Modify `save_adbot(data)` to support both: (A) if using new storage: write pool via `save_pool()`, write each bot via `save_user_data()` (index must already exist); (B) else: use existing `adbot.json` write. |
| `code/users.py` | Modify `_get_cfg(bot_token)` to prefer `get_name_by_token` + `load_user_data`, with fallback to `load_adbot()["bots"].get(bot_token)` when index is empty. |
| `code/users.py` | Modify `_save_bot_config(bot_token, updater)` to prefer `get_name_by_token` + `load_user_data` + `save_user_data`, with fallback to `load_adbot` / `save_adbot` when index is empty. |

**Behavior:** If index is empty, everything behaves exactly as today. Once index is populated, `_get_cfg` and `_save_bot_config` use per-user files.

---

### Phase 3: `load_adbot()` compatibility layer (detailed)

**Pseudocode for `load_adbot()`:**

```python
def load_adbot() -> dict[str, Any]:
    # New storage: if index exists and has at least one entry
    if config.DATA_INDEX_FILE.exists():
        try:
            index = load_index()
            if index.get("by_token"):
                pool = load_pool()
                bots = {}
                for token, name in index.get("by_token", {}).items():
                    cfg = load_user_data(name)
                    if cfg:
                        bots[token] = cfg
                return {
                    "bots": bots,
                    "free_sessions": pool.get("free_sessions", []),
                    "dead_sessions": pool.get("dead_sessions", []),
                    "admin_alerts": pool.get("admin_alerts", []),
                }
        except Exception as e:
            logger.warning("Could not load from new storage, falling back to adbot.json: %s", e)
    # Fallback: existing adbot.json logic
    path = config.ADBOT_JSON
    # ... existing _default_schema, read, setdefault logic ...
```

**Pseudocode for `save_adbot(data)` (when using new storage):**

```python
def save_adbot(data: dict[str, Any]) -> None:
    # If we have index and user dir, write to new storage
    if config.DATA_INDEX_FILE.exists():
        try:
            index = load_index()
            if index.get("by_token"):
                save_pool({
                    "free_sessions": data.get("free_sessions", []),
                    "dead_sessions": data.get("dead_sessions", []),
                    "admin_alerts": data.get("admin_alerts", []),
                })
                for token, cfg in data.get("bots", {}).items():
                    name = index.get("by_token", {}).get(token)
                    if name:
                        save_user_data(name, cfg)
                return
        except Exception as e:
            logger.warning("Could not save to new storage, falling back to adbot.json: %s", e)
    # Fallback: existing adbot.json write
    # ... existing logic ...
```

**Caveat:** `save_adbot(merged_data)` is only used when the caller passes a **merged** structure (e.g. from `load_adbot()`). For create/delete, we will update those flows to write directly to index, pool, and user files instead of calling `save_adbot`.

---

### Phase 4: Rewrite `_get_cfg()` and `_save_bot_config()` (detailed)

**`_get_cfg(bot_token)`** — `code/users.py`:

```python
def _get_cfg(bot_token: str) -> dict | None:
    """Load bot config from per-user file or adbot.json fallback."""
    name = get_name_by_token(bot_token)
    if name:
        cfg = load_user_data(name)
        if cfg is not None:
            return cfg
    # Fallback: old storage
    data = load_adbot()
    return data.get("bots", {}).get(bot_token)
```

**`_save_bot_config(bot_token, updater)`** — `code/users.py`:

```python
def _save_bot_config(bot_token: str, updater: Callable[[dict], None]) -> bool:
    """Update one bot config. Uses per-user file when index has entry."""
    name = get_name_by_token(bot_token)
    if name:
        cfg = load_user_data(name)
        if cfg is not None:
            updater(cfg)
            save_user_data(name, cfg)
            return True
    # Fallback: old storage
    data = load_adbot()
    cfg = data.get("bots", {}).get(bot_token)
    if not cfg:
        return False
    updater(cfg)
    data["bots"][bot_token] = cfg
    save_adbot(data)
    return True
```

---

## 4. Create Bot Flow (new storage)

**Current flow:** `admin._core_create_adbot_async()` builds `entry`, does `adbot_data["bots"][bot_token] = entry`, `save_adbot(adbot_data)`.

**New flow (same function, different write path):**

1. After building `entry` (lines 740–756):
   - `name = form.get("name", "").strip()` (already available)
   - `safe_name = name_to_filename(name)` (handle collisions: if `DATA_USER_DIR / f"{safe_name}.json"` exists, append `_2`, `_3`, etc.)
   - `save_user_data(safe_name, entry)` — write `/data/user/<safe_name>.json`
   - Update index: `index = load_index()`, `index["by_token"][bot_token] = safe_name`, `index["by_name"][safe_name] = bot_token`, `save_index(index)`
   - Update pool: `pool = load_pool()`, remove assigned session filenames from `pool["free_sessions"]`, add invalid ones to `pool["dead_sessions"]`, `save_pool(pool)`
   - Set `entry["log_file"]` to `data/logs/<safe_name>.log` (relative to BASE_DIR)
   - Do **not** call `save_adbot(adbot_data)` for the full struct

2. **Race condition:** The create worker is a **single** background thread (`_create_worker_loop`). It processes one job at a time: `get()` → load → create → put result. So two concurrent create requests are serialized by the queue. No additional lock needed for create itself.

3. **Name uniqueness:** Before `save_user_data`, check that `safe_name` is not already in `load_index()["by_name"]`. If it is, append `_2`, `_3`, etc. until unique.

4. **Files to update:**
   - `code/admin.py` → `_core_create_adbot_async()`: replace the `adbot_data["bots"][bot_token] = entry` + `save_adbot(adbot_data)` block with the new write sequence (user file, index, pool, log path).

---

## 5. Migration Checklist (exact order)

Execute in this order. Each step should leave the system functional.

| # | Task | File(s) | Verifies |
|---|------|---------|----------|
| 1 | Add `DATA_DIR`, `DATA_USER_DIR`, `DATA_LOGS_DIR`, `DATA_INDEX_FILE`, `DATA_POOL_FILE`; create dirs | `code/config.py` | Paths exist |
| 2 | Add `name_to_filename(name)` | `code/utils.py` | Sanitization works |
| 3 | Add `load_index()`, `save_index()`, `_default_pool()`, `load_pool()`, `save_pool()` | `code/utils.py` | Read/write empty structures |
| 4 | Add `get_name_by_token()`, `load_user_data()`, `save_user_data()` | `code/utils.py` | Per-user read/write |
| 5 | Create one-time migration script that: reads `adbot.json`, creates `data/pool.json`, `data/index.json`, and `data/user/<name>.json` per bot | `scripts/migrate_to_per_user.py` (new) | Existing data in new layout |
| 6 | Run migration script (with `adbot.json` backup) | — | `data/` populated |
| 7 | Modify `load_adbot()` to use new storage when index exists | `code/utils.py` | Full load from new storage |
| 8 | Modify `save_adbot()` to write to new storage when index exists | `code/utils.py` | Full save to new storage |
| 9 | Modify `_get_cfg()` to prefer new storage | `code/users.py` | Bot config from user file |
| 10 | Modify `_save_bot_config()` to prefer new storage | `code/users.py` | Bot updates to user file |
| 11 | Modify `get_bot_log_path()` to use `DATA_LOGS_DIR / f"{name}.log"` when index has entry | `code/utils.py` | Log path per user |
| 12 | Modify `log_bot_event()` to use new log path (no change to `save_adbot` for log_file; store in user file) | `code/utils.py` | Logs to `data/logs/` |
| 13 | Modify `add_admin_alert()` to use `load_pool()` / `save_pool()` when index exists | `code/utils.py` | Alerts in pool |
| 14 | Modify `_core_create_adbot_async()` to write user file, index, pool, set log path | `code/admin.py` | New bots go to new storage |
| 15 | Modify `discover_local_sessions()` to use `load_pool()` and `load_index()` + all user files for `known`; `save_pool()` when adding | `code/utils.py` | Session discovery works |
| 16 | Modify `_mark_session_dead_and_replace()` to use pool + user file | `code/users.py` | Session death updates |
| 17 | Modify `_mark_bot_expired()`, `_mark_bot_dead()` to use `_save_bot_config` or direct `save_user_data` | `code/users.py` | Bot state updates |
| 18 | Modify `_persist_last_cycle()` to use `_save_bot_config` or `save_user_data` | `code/users.py` | Cycle time in user file |
| 19 | Modify `_admin_validate_sessions`, `_admin_replace_dead`, `_admin_replace_error_sessions` to use pool + user files | `code/admin.py` | Admin validation/replace |
| 20 | Modify `recreate_log_group_for_bot()` to use `load_user_data` / `save_user_data` | `code/utils.py` | Log group recreation |
| 21 | Modify delete_bot flow in `main.py` and admin delete handlers to: update pool, remove from index, optionally delete user file and log file | `main.py`, `code/admin.py`, `code/admin_ptb.py` | Delete flow |
| 22 | Modify `check_all_active_sessions`, `run_startup_validation` to use pool + user files | `code/utils.py` | Startup validation |
| 23 | Remove `adbot.json` fallback from `load_adbot()` / `save_adbot()` (or keep read-only for emergency recovery) | `code/utils.py` | New storage only |

---

## 6. Summary: File-to-Change Map

| File | Functions / logic to change |
|------|-----------------------------|
| `code/config.py` | Add `DATA_*` paths; create dirs |
| `code/utils.py` | Add storage primitives; modify `load_adbot`, `save_adbot`, `get_bot_log_path`, `log_bot_event`, `add_admin_alert`, `discover_local_sessions`, `check_all_active_sessions`, `run_startup_validation`, `recreate_log_group_for_bot` |
| `code/users.py` | Modify `_get_cfg`, `_save_bot_config`, `_mark_session_dead_and_replace`, `_mark_bot_expired`, `_mark_bot_dead`, `_persist_last_cycle`; direct `load_adbot` callers that expect full merged structure |
| `code/admin.py` | Modify `_core_create_adbot_async`, `_admin_validate_sessions`, `_admin_replace_dead`, `_admin_replace_error_sessions`, delete flow |
| `code/admin_ptb.py` | Delete flow (if any); ensure it uses `load_adbot` / `save_adbot` from admin (which comes from utils — no change needed if compatibility layer is correct) |
| `main.py` | Delete flow in `_main_loop_job_consumer` |
| `code/crash.py` | No change; uses `data` passed from `main.py` (from `load_adbot()`) |
| `code/diagnostic.py` | Update to use `load_adbot()` (compatibility layer) or direct `load_pool` + index + user files |

Following this plan ensures no session assignments or statistics are lost during the transition, and behavior stays the same as with `adbot.json`, with each user now stored in separate files.
