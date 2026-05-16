# AdBot Creation Pipeline — Final Hardening Pass

**Date:** 2026-02-13  
**Scope:** Session assignment safety, persistence consistency, professional progress formatting, and guaranteed temp-session cleanup. No change to overall architecture (queue → worker → create → save) or wizard UI.

---

## 1. Modified Files and Functions

| File | Change |
|------|--------|
| **code/admin.py** | **Globals:** Added `creation_pool_lock = threading.Lock()`. **`_create_worker_loop`:** Wrapped `load_adbot()` and `_sync_execute_create_adbot(...)` in `with creation_pool_lock:` so only one job at a time loads pool, assigns sessions, and persists pool. **`_core_create_adbot_async`:** Persistence order changed to save_pool → save_user_data → save_index; on save_index failure, roll back (remove user JSON, restore sessions to pool, save_pool, then re-raise). Progress messages standardized to clean text (no emoji); added "Finalizing setup…"; final message "AdBot successfully created: @BotUsername". All `log_async` strings in creation path use consistent professional wording. |

No changes to **admin_ptb.py**, **shop/handlers.py**, **shop/workers.py**, or any wizard UI.

---

## 2. Confirmations

### 2.1 No duplicate session assignment

- **Mechanism:** A single global lock (`creation_pool_lock`) is held for the entire critical section: `load_adbot()` → `_sync_execute_create_adbot(...)` (which runs `_core_create_adbot_async` and thus assigns from `adbot_data["free_sessions"]` and updates that dict) → then the same worker, still inside the lock, persists via save_pool (inside `_core_create_adbot_async`, which is called from `_sync_execute_create_adbot`). So the sequence load → assign → save_pool is serialized across all worker threads.
- **Result:** Only one creation at a time can read the free-session snapshot, assign sessions, and write the updated pool. The same session cannot be assigned to two bots.

### 2.2 No partial bot creation state

- **Order:** Persistence is now: (1) `save_pool(pool)` — reserve sessions (remove them from free_sessions on disk); (2) `save_user_data(safe_name, entry)`; (3) `save_index(index)`.
- **Rollback on save_index failure:** If `save_index(index)` raises, we: remove the created user file (`config.DATA_USER_DIR / f"{safe_name}.json"`), restore the assigned session filenames to `pool["free_sessions"]`, call `save_pool(rollback_pool)`, then re-raise. So no orphan user file and no “sessions reserved but no bot” state.
- **Result:** Either the full set (pool updated, user file, index) is committed, or we roll back and leave the system as before (sessions back in pool, no user file).

### 2.3 Temp sessions always cleaned

- **Mechanism:** `creation_tmp_path = config.DATA_DIR / "_creation_tmp_bot"` is set once at the start of `_core_create_adbot_async`, before the `try`. The entire create logic (profile setup, session assignment, log group, persistence) runs inside `try`/`except`/`finally`. The `finally` block unconditionally calls `_cleanup_creation_temp_sessions(creation_tmp_path)`.
- **Result:** On success, early return (e.g. duplicate token, insufficient sessions), or any exception, the finally runs and temp session files for this creation are removed. No temp session file remains after any outcome.

### 2.4 Identical behavior on all creation paths

- **Admin-created:** PTB wizard → `submit_create_job(...)` → `_create_job_queue.put(...)` → `_create_worker_loop` → `_sync_execute_create_adbot` → `_core_create_adbot_async`. ✓
- **Shop purchase:** Shop handler → `submit_create_job(...)` → same queue and worker → same `_core_create_adbot_async`. ✓
- **Recreate / repair:** Same `submit_create_job` or `_create_job_queue.put(...)` → same worker and core create. ✓
- **Pending_creation retries:** Reconciliation in `shop/workers.py` uses `_create_job_queue.put((0, 0, form, _q.Queue()))` → same worker and `_core_create_adbot_async`. ✓  

All paths use the same creation function; profile setup and cleanup always run. No wizard UI logic was changed.

---

## 3. Before / After Flow Summary

### Before (safety issues)

- **Sessions:** Multiple workers could run concurrently; each did `load_adbot()` independently, then assigned from the same logical “free” set. Two jobs could assign the same session before either saved the pool.
- **Persistence:** Order was save_user_data → save_index → save_pool. If save_index failed, the user file could exist without index entry; if save_pool failed later, sessions could remain “free” while assigned to a bot.
- **Progress:** Mixed styles (emoji and non-emoji); no single “Finalizing setup…” step.
- **Temp cleanup:** Already in finally; no change needed.

### After (hardening)

- **Sessions:** One global lock ensures load_adbot → assign → save_pool (inside create) runs exclusively. No duplicate session assignment under concurrent creation jobs.
- **Persistence:** save_pool first (reserve sessions), then save_user_data, then save_index; on save_index failure, roll back (delete user file, restore sessions to pool, save_pool, raise).
- **Progress:** Clean, professional messages; “Finalizing setup…” before persistence; final line “AdBot successfully created: @BotUsername”.
- **Temp cleanup:** Unchanged; guaranteed by try/finally.

---

## 4. Concurrency Verification

### 4.1 Design guarantee

With `creation_pool_lock` held for the full sequence:

1. Worker A acquires the lock, loads adbot (free_sessions = [s1, s2, s3]), assigns s1 to bot1, updates adbot_data, and inside _core_create_adbot_async calls save_pool (free_sessions = [s2, s3]), then save_user_data, save_index, and releases the lock when _sync_execute_create_adbot returns.
2. Worker B then acquires the lock, loads adbot (free_sessions = [s2, s3]), assigns s2 to bot2, and so on.

So each session is assigned at most once per creation; the on-disk pool is updated before the next job can read it.

### 4.2 How to run a concurrency simulation

1. **Environment:** Ensure you have at least two free sessions and two different bot tokens (e.g. two test bots).
2. **Trigger two creations at once:** From the admin wizard, submit two create jobs in quick succession (two different names and tokens), or use the shop flow to simulate two paid orders that both trigger creation.
3. **Check results:**
   - Each created bot’s `sessions` list should contain distinct session filenames.
   - The union of all sessions assigned to the two bots should have no duplicate filenames.
   - In `data/adbot_pool.json` (or equivalent pool file), `free_sessions` should not contain any session that appears in either bot’s user JSON.
4. **With the lock:** Running the same test, each session should appear in exactly one bot; no session in both bots and no session both in a bot and in free_sessions.

This can be automated by a small script that: (1) enqueues two create jobs with different forms, (2) waits for both to complete, (3) loads index and user files for the two bots, (4) collects all assigned session filenames and asserts no duplicate and that none of them appear in the current pool’s free_sessions.

---

## 5. Professional Progress Message Set (Default)

- Starting AdBot setup…
- Configuring bot profile…
- Assigning sessions…
- Creating log group…
- Joining all assigned sessions to log group… (if applicable)
- Finalizing setup…
- AdBot successfully created: @BotUsername

Error and warning lines use the same clean style (e.g. “Session X missing; trying next.”, “Not enough valid sessions: …”, “Error: …”). Optional premium emoji can be layered via a helper (e.g. `build_emoji_message()`) without changing this default set.
