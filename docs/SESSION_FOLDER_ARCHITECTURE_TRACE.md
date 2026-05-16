# Session Folder & Validator System — Deep Trace

Full codebase inspection: how session folders are used, validated, and moved. Lifecycle and consistency check.

---

## 1. Folder purpose discovery

### Folder: **active/** (`config.SESSIONS_ACTIVE`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | `discover_local_sessions` (utils.py), `check_all_active_sessions` (utils.py), `run_startup_validation` (utils.py), `_admin_validate_sessions` (admin.py), `_admin_replace_dead` (admin.py), `_admin_replace_error_sessions` (admin.py), `_admin_recreate_log_group` (admin.py), `_core_create_adbot_async` (admin.py), `_unique_session_path` (admin.py), `_handle_del_session` (admin.py), `_clean_stale_session_journals` (main.py), `run_session_ownership_integrity_scan` (utils.py), `recreate_log_group_for_bot` (utils.py), `repair_fix_log_group` / `repair_replace_session` / `repair_fix_config` / `check_sessions_health_parallel` (repair.py), `session_move` (admin_control.py), `delete_bot_from_storage` (utils.py), admin_ptb zip/session add flows |
| **Written to** | Admin/PTB: single .session download → `config.SESSIONS_ACTIVE`; zip extract → `_extract_zip_and_copy_sessions(..., config.SESSIONS_ACTIVE)` (admin.py, admin_ptb.py). Creation assigns from `free_sessions` (filenames only; files already in active/). `repair_replace_session` takes replacement session from pool (file already in active/). |
| **When added** | (1) Admin “Add Sessions”: user sends .session or .zip → saved to active/. (2) Startup: `discover_local_sessions()` only *discovers* files already in active/ and adds their names to `free_sessions`; it does not copy files. (3) User upload via AdBot: files go to **users/** (see below), not active/. |
| **When removed** | (1) Validation failure: `validate_session` / `validate_session_with_reason` → `_move_session_to_dead(path)` (utils.py). (2) Runtime session death: `_mark_session_dead_and_replace` → `shutil.move(path, dead_path)` (users.py). (3) Delete bot with “move to dead”: `delete_bot_from_storage(bot_token, "dead")` → move each session file to dead/ (utils.py). (4) Replace session (Fix): `repair_replace_session` → move old file to frozen/limited/unauth (repair.py). (5) Admin “Remove session”: delete file from active/ (admin.py `_handle_del_session`). |
| **Processes that depend on it** | Main process: discovery, validation, creation, replace; admin bot (Telethon/PTB): add/remove/validate; session health monitor; posting workers resolve paths via `resolve_session_path()` (active/ or users/). |

---

### Folder: **dead/** (`config.SESSIONS_DEAD`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | `_handle_del_session` (admin.py, admin_ptb.py) for “Remove dead sessions” list and delete; `session_full_list` / `session_move` (admin_control.py) when moving from/to dead bucket. No code *loads* or validates sessions from dead/ for posting. |
| **Written to** | (1) `_move_session_to_dead(session_path)` (utils.py): called from `validate_session_with_reason` when validation fails; moves by `session_path.name` to `SESSIONS_DEAD`. (2) `_mark_session_dead_and_replace`: `dead_path = config.SESSIONS_DEAD / Path(session_file).name`; moves from `resolve_session_path(session_file)`. (3) `delete_bot_from_storage(bot_token, "dead")`: moves `config.SESSIONS_ACTIVE / fn` to `config.SESSIONS_DEAD / fn` (bug for user paths — see Consistency check). |
| **When added** | Invalid/revoked session (validation or runtime session_died); admin “Replace dead” only updates pool and assigns from free — does not move files into dead/ (files already moved by validator or runtime). |
| **When removed** | Admin “Remove dead sessions”: delete file from dead/ and remove from `dead_sessions` (admin.py, admin_ptb.py). `session_move(..., to_bucket="free"|"frozen")` moves file from dead/ to active/ or frozen/. |
| **Processes** | Admin flows; no posting or creation reads from dead/. |

---

### Folder: **frozen/** (`config.SESSIONS_FROZEN`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | `session_full_list` (admin_control.py) lists sessions in `pool["frozen_sessions"]` (status "frozen"); `session_move` (admin_control.py) moves file from frozen/ to free/dead when changing bucket. No code assigns or validates sessions from frozen/ for posting. |
| **Written to** | (1) `repair_replace_session`: when status is `SPAM_FROZEN`, `_get_session_dest_dir(status)` → `SESSIONS_FROZEN`; old session file moved from active/ to frozen/. (2) `session_move(..., to_bucket="frozen")`: file moved from active/ or dead/ to frozen/. |
| **When added** | Fix Sessions flow: replace session with status FROZEN → old file moved to frozen/. Admin control: move session to “frozen” bucket. |
| **When removed** | Only via `session_move(..., from_bucket="frozen", to_bucket="free"|"dead")` (admin_control.py). |
| **Processes** | Admin control API; repair module. **Validator and creation do not look in frozen/.** |

---

### Folder: **limited/** (`config.SESSIONS_LIMITED`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | **None.** No function reads or lists sessions from limited/. |
| **Written to** | `repair_replace_session`: when status is `SPAM_TEMP_LIMITED` or `SPAM_HARD_LIMITED`, `_get_session_dest_dir(status)` → `SESSIONS_LIMITED`; old session file moved from active/ to limited/. |
| **When added** | Fix Sessions: replace session with status TEMP_LIMITED or HARD_LIMITED. |
| **When removed** | **No code path removes or reuses sessions from limited/.** Files can only be moved manually or by a future feature. |
| **Processes** | Repair module only. |

---

### Folder: **unauth/** (`config.SESSIONS_UNAUTH`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | **None.** No function reads or lists sessions from unauth/. |
| **Written to** | `repair_replace_session`: for any other status (e.g. `SPAM_UNKNOWN`), `_get_session_dest_dir(status)` → `SESSIONS_UNAUTH`. |
| **When added** | Fix Sessions: replace session with status other than FROZEN/TEMP_LIMITED/HARD_LIMITED. |
| **When removed** | **No code path.** |
| **Processes** | Repair module only. |

---

### Folder: **userbot/** (`config.SESSIONS_DIR / "userbot"`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | `create_user_bot` (users.py): Telethon client uses `session_path = str(config.SESSIONS_DIR / "userbot" / f"bot_{token_fingerprint}")`; one session per AdBot (controller bot). |
| **Written to** | Telethon creates/updates the session file on first run when user uses the AdBot (e.g. /start). `create_user_bot` ensures dir exists: `(config.SESSIONS_DIR / "userbot").mkdir(parents=True, exist_ok=True)`. |
| **When added** | When an AdBot is first started (e.g. after creation or resume): `create_user_bot(bot_token)` is called; Telethon creates the session file when the client is used. |
| **When removed** | `disconnect_and_remove_controller_bot(bot_token)` (users.py): deletes `bot_{token_fingerprint}.session` and `.session-journal` under userbot/ so the token can be reused. Called on Delete AdBot (admin.py, main loop job). |
| **Processes** | Main process (controller bots); not used by posting workers. |

---

### Folder: **users/** (`config.SESSIONS_BY_USER` = `sessions/users/`)

| Aspect | Details |
|--------|---------|
| **Used by (read)** | Posting: `resolve_session_path(file_str)` (config.py) — if `file_str.startswith("users/")` → `SESSIONS_DIR / file_str` (e.g. `users/12345/foo.session`). Workers and controller use this path. `_mark_session_dead_and_replace` uses `resolve_session_path(session_file)` then moves to dead/ by name. |
| **Written to** | User upload in AdBot: when in upload_sessions state, .session or .zip → `user_dir = config.SESSIONS_BY_USER / str(event.sender_id)`; files saved under `users/<uid>/`; `rel = f"users/{event.sender_id}/{p.name}"` stored in bot config. |
| **When added** | User sends .session or .zip to their AdBot in “upload sessions” state (users.py). Validated; if valid, added to bot’s sessions with path `users/<uid>/<name>.session`. |
| **When removed** | (1) Session death: `_mark_session_dead_and_replace` moves file to dead/ (by name). (2) Delete bot: `delete_bot_from_storage` does **not** use `resolve_session_path` — it uses `config.SESSIONS_ACTIVE / fn`, so **user-stored sessions are never moved** on delete (see Consistency check). |
| **Processes** | User-facing AdBot (Telethon) for upload; main process for resolve and runtime death. |

---

## 2. Validator flow trace

### Functions found

| Function | File | Role |
|----------|------|------|
| `validate_session(path)` | utils.py | Thin wrapper: `ok, _ = await validate_session_with_reason(session_path)` |
| `validate_session_with_reason(session_path)` | utils.py | Full validator; moves invalid to dead/ |
| `check_all_active_sessions(data)` | utils.py | Startup: validate all free + assigned in active/; move invalid to dead/, update pool/bots |
| `run_startup_validation(data)` | utils.py | Same idea: validate sessions in active/ that appear in data; return (valid_count, invalid_count, invalid_list) |
| `_admin_validate_sessions(data, ..., bot_token?)` | admin.py | Validate free + (optionally one bot’s) assigned; invalid → dead_sessions, file moved by validate_session |
| `check_sessions_health_parallel(session_files)` | repair.py | SpamBot health check; returns status map (ACTIVE, TEMP_LIMITED, HARD_LIMITED, FROZEN, UNKNOWN); **does not move files** |
| `repair_replace_session(bot_token, old_session_file, status, ...)` | repair.py | Replaces one session with one from pool; moves **old** file to frozen/limited/unauth by status; validates new session from pool |

There are **no** functions named `session_assigner`, `session_replacer`, or `session_loader`. Session assignment is done inside `_core_create_adbot_async` (admin.py) and replace is `_admin_replace_dead` / `_admin_replace_error_sessions` / `repair_replace_session`.

### Validation steps (validate_session_with_reason)

1. Resolve path; if not a file → return `(False, "file missing")`.
2. If `_session_active_callback` set and returns true (session in use by posting) → return `(False, "in use by posting")` (no move).
3. If file is not SQLite magic header → `_move_session_to_dead(session_path)`; return `(False, "invalid format (not SQLite)")`.
4. Connect Telethon client, `client.connect()`, `is_user_authorized()`; if not authorized → return `(False, "UNAUTHORIZED")` (no move in code — but finally block runs only when `ok` is False and file still exists; see step 7).
5. Send test message to "me" via `with_floodwait_retry(...)`.
6. On exception: `reason = _session_failure_reason(e)` (revoked / FROZEN / UNAUTHORIZED). Return `(False, reason)`.
7. In `finally`: disconnect; **if not ok and session_path.is_file()**: `_move_session_to_dead(session_path)`.

So: **invalid sessions are moved to dead/** by `_move_session_to_dead`, which does `dest = config.SESSIONS_DEAD / session_path.name` and `shutil.move(str(session_path), str(dest))`.

### Where invalid / rate-limited / restricted are categorized

- **Validator (utils):** All failures (unauthorized, revoked, frozen, non-SQLite) → single outcome: move to **dead/** and return False. No separate buckets for “rate-limited” or “restricted” in the main validator.
- **Repair (SpamBot):** After `check_sessions_health_parallel`, admin chooses “Replace” with a status; `repair_replace_session` moves the **old** session file to:
  - **frozen/** — FROZEN
  - **limited/** — TEMP_LIMITED, HARD_LIMITED
  - **unauth/** — UNKNOWN / other

### Does the validator handle…

| Case | Handled? | Where |
|------|----------|--------|
| Unauthorized sessions | Yes | `is_user_authorized()` → False → return UNAUTHORIZED; finally moves to dead/ if path still exists (current code returns before finally without setting ok=True, so finally runs and moves). |
| Banned sessions | Yes | Via exception in connect/send; `_session_failure_reason` maps banned/deactivated/frozen → "FROZEN"; type in `_SESSION_DEAD_ERRORS` (e.g. PhoneNumberBannedError) → moved to dead/. |
| Flood-limited sessions | Partially | `with_floodwait_retry` retries send_message to "me"; if still failing after retries, exception and moved to dead/. No separate “flood-limited” folder. |
| Corrupted session files | Yes | Non-SQLite → `_move_session_to_dead` + "invalid format (not SQLite)". |

**Important:** The main validator only has one “invalid” destination: **dead/**. The **frozen/limited/unauth** split is only used in the **Fix Sessions** (repair) flow when **replacing** a session after a SpamBot check; the old file is moved to one of those three by status.

---

## 3. Session lifecycle map

```
uploaded (admin: .session/.zip → active/)
    → discover_local_sessions adds name to free_sessions (file already in active/)
    → validate_session (on Add Session / Create / Replace) → valid: stay in active/; invalid: → dead/

active/ (free_sessions or assigned)
    → assigned during creation: _core_create_adbot_async validates from free_list, assigns to bot (stays in active/)
    → runtime: worker reports session_died → _mark_session_dead_and_replace → remove from bot, dead_sessions, move file → dead/
    → admin Replace dead/error: remove from bot, add to dead_sessions; replacement from free (in active/); invalid replacement → dead/
    → repair_replace_session (Fix): old file → frozen/ | limited/ | unauth/ by status; new from pool (active/)

active/ → limited/
    Only via repair_replace_session when status is TEMP_LIMITED or HARD_LIMITED.

active/ → frozen/
    Via repair_replace_session (status FROZEN) or session_move(to_bucket="frozen").

active/ → dead/
    validate_session_with_reason (any failure); _mark_session_dead_and_replace; delete_bot_from_storage(bot_token, "dead").

dead/ → (anywhere)
    session_move(from_bucket="dead", to_bucket="free"|"frozen") moves file to active/ or frozen/.
    Admin “Remove dead sessions” deletes file and removes from dead_sessions.

users/<uid>/ (user upload)
    → validated on upload; if valid, path users/uid/name.session stored in bot; if invalid, validate_session moves to dead/ (by name)
    → session_died → _mark_session_dead_and_replace (resolve_session_path → move to dead/ by name)
    → delete bot: delete_bot_from_storage does NOT use resolve_session_path → user file not moved (bug).

userbot/
    Created when create_user_bot runs (Telethon); deleted when disconnect_and_remove_controller_bot runs (Delete AdBot).
```

### Functions controlling transitions

| Transition | Function(s) | File |
|------------|-------------|------|
| → active/ (add file) | Admin download to SESSIONS_ACTIVE; _extract_zip_and_copy_sessions to SESSIONS_ACTIVE | admin.py, admin_ptb.py |
| active/ → dead/ | _move_session_to_dead (from validate_session_with_reason); _mark_session_dead_and_replace; delete_bot_from_storage(..., "dead") | utils.py, users.py |
| active/ → frozen/ or limited/ or unauth/ | repair_replace_session → _get_session_dest_dir, shutil.move(old_path, dest_dir) | repair.py |
| free ↔ dead ↔ frozen (file move) | session_move: shutil.move between SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN | admin_control.py |
| userbot create/delete | create_user_bot (Telethon creates file); disconnect_and_remove_controller_bot (unlink .session) | users.py |
| users/<uid>/ → dead/ | _mark_session_dead_and_replace (resolve_session_path + SESSIONS_DEAD / name) | users.py |

---

## 4. Consistency check

### Folders that exist but are never used (for reading)

- **limited/**: Created in config, written by repair_replace_session. **Nothing ever reads or reassigns from limited/.** Sessions here are effectively archive-only unless an admin moves files manually or new logic is added.
- **unauth/**: Same as limited/ — write-only from repair; no reader, no reassignment.

### Sessions that may remain stuck

- **frozen/**: Can be moved back only via `session_move(..., from_bucket="frozen", to_bucket="free")` (admin_control). If that API is not exposed in the admin UI, frozen sessions stay stuck.
- **limited/**, **unauth/**: No move-back path at all; sessions stay until manual intervention or new feature.

### Folders not checked by validator

- **dead/, frozen/, limited/, unauth/, userbot/, users/**: The main validators (`validate_session_with_reason`, `check_all_active_sessions`, `run_startup_validation`, `_admin_validate_sessions`) only consider sessions that (1) appear in pool/bots and (2) are looked up under **active/** (`config.SESSIONS_ACTIVE / fn`). So:
  - User-stored paths (`users/uid/foo.session`) are **not** validated by `_admin_validate_sessions` or replace flows that use `SESSIONS_ACTIVE / fn` (they would check the wrong path).
  - Sessions in frozen/limited/unauth are never re-validated or re-assigned by current code.

### Session in multiple folders

- Normal design: a session filename should live in exactly one folder. Duplication could occur if:
  - A move fails after pool/index was updated (e.g. remove from free_sessions but move to dead fails) → name in dead_sessions but file still in active/.
  - `delete_bot_from_storage(..., "dead")` uses `SESSIONS_ACTIVE / fn` for user paths → file stays in users/ while name is in dead_sessions → “same” session conceptually in two places (users/ and dead_sessions list).

### Non-atomic moves

- All moves use `shutil.move(str(src), str(dest))` with no rename-then-delete or lock. On failure, pool/bot config may already be updated (e.g. removed from free_sessions, appended to dead_sessions) while file remains in source dir. No transactional “move file then update JSON” ordering is enforced.

### Critical bug: delete_bot_from_storage and user-stored sessions

- `delete_bot_from_storage` (utils.py) does:
  - `src = config.SESSIONS_ACTIVE / fn` and `if src.is_file(): ... shutil.move(..., config.SESSIONS_DEAD / fn)`.
- For sessions stored under **users/** (e.g. `fn = "users/12345/foo.session"`), `SESSIONS_ACTIVE / fn` is `sessions/active/users/12345/foo.session`, which does not exist (real path is `sessions/users/12345/foo.session`).
- Effect: On delete bot with “move to dead”, user-uploaded sessions are **not** moved to dead/ and **not** added to free pool correctly (the code path for “free” also uses `SESSIONS_ACTIVE / fn`.is_file(), which is false for user paths). So user-stored session files remain in users/ while the bot is removed and pool may list them in dead_sessions or free_sessions incorrectly.

---

## 5. Output summary

### Folder → function → lifecycle (condensed)

| Folder | Key functions (read/write/move) | Lifecycle |
|--------|----------------------------------|----------|
| **active/** | discover_local_sessions, validate_session*, _admin_validate_sessions, _admin_replace_*, _core_create_adbot_async, run_startup_validation, check_all_active_sessions, repair_replace_session (new from pool), session_move, delete_bot_from_storage | Source for free/assigned; add via admin; remove → dead/ or frozen/limited/unauth |
| **dead/** | _move_session_to_dead, _mark_session_dead_and_replace, delete_bot_from_storage(...,"dead"); _handle_del_session, session_move | Invalid/runtime-dead; remove via admin or move to free/frozen |
| **frozen/** | repair_replace_session (old file), session_move | From active/ on Fix (FROZEN) or admin move; move back via session_move only |
| **limited/** | repair_replace_session (old file) | From active/ on Fix (TEMP/HARD_LIMITED); no reader or move-back |
| **unauth/** | repair_replace_session (old file) | From active/ on Fix (UNKNOWN/other); no reader or move-back |
| **userbot/** | create_user_bot, disconnect_and_remove_controller_bot | Create on first use; delete on Delete AdBot |
| **users/** | resolve_session_path, user upload handler, _mark_session_dead_and_replace | User upload → users/uid/; posting and death use resolve_session_path; delete_bot does not |

### Validator pipeline (high level)

```
Session path
    → validate_session_with_reason
        → file missing? → return (False, "file missing") [no move]
        → in use by posting? → return (False, "in use by posting") [no move]
        → not SQLite? → _move_session_to_dead → return (False, "invalid format")
        → connect → not authorized? → return (False, "UNAUTHORIZED") [finally moves to dead if file exists]
        → send_message("me", ".") with floodwait retry
        → exception? → reason = revoked|FROZEN|UNAUTHORIZED → finally: _move_session_to_dead
        → ok → return (True, "")
```

Separately, **repair** (Fix Sessions) uses SpamBot status to **move old session file** to frozen/limited/unauth when replacing; it does not validate into those buckets — it only moves the replaced file there.

### Missing logic / improvement recommendations

1. **delete_bot_from_storage:** Use `config.resolve_session_path(fn)` instead of `config.SESSIONS_ACTIVE / fn` for source path and for the “free” branch file check, so user-stored sessions (`users/uid/...`) are moved to dead/ or returned to pool correctly when a bot is deleted.
2. **Admin validation/replace:** For bots that have sessions with `file` starting with `users/`, resolve path with `resolve_session_path(fn)` when checking `is_file()` and when calling `validate_session(path)`, so user-stored sessions are validated and replaced correctly.
3. **limited/ and unauth/:** Either add a way to list and move sessions back to free (e.g. extend session_move or admin UI to support limited/unauth), or document that these are archive-only and optionally run a periodic cleanup (e.g. delete or move to dead after N days).
4. **frozen/:** Ensure admin UI exposes moving sessions from frozen back to free (or dead) if not already (session_move in admin_control already supports it; confirm PTB/admin UI calls it).
5. **Atomicity:** Consider updating pool/bot config only after a successful move, or use a short retry for the move so that on transient failure the process can retry before updating JSON; alternatively document the risk and recommend manual reconciliation (e.g. session integrity scan already returns orphans to free).
6. **run_startup_validation / check_all_active_sessions:** If the system supports user-stored sessions, include them in the set of paths to validate (using resolve_session_path for each session file in bots) so that invalid user-stored sessions are moved to dead/ on startup.

---

## 6. Exact files where each behavior is implemented

| Behavior | File | Function or location |
|----------|------|----------------------|
| Folder paths | code/config.py | SESSIONS_ACTIVE, SESSIONS_DEAD, SESSIONS_FROZEN, SESSIONS_LIMITED, SESSIONS_UNAUTH, SESSIONS_BY_USER; resolve_session_path |
| Discover active/ → free_sessions | code/utils.py | discover_local_sessions |
| Validate session, move invalid to dead/ | code/utils.py | validate_session_with_reason, validate_session, _move_session_to_dead |
| Startup validation | code/utils.py | check_all_active_sessions, run_startup_validation |
| Session death at runtime | code/users.py | _mark_session_dead_and_replace |
| Admin validate/replace | code/admin.py | _admin_validate_sessions, _admin_replace_dead, _admin_replace_error_sessions |
| Create AdBot session assignment | code/admin.py | _core_create_adbot_async (assign from free_sessions, path = SESSIONS_ACTIVE / fn) |
| Replace session, move old to frozen/limited/unauth | code/repair.py | repair_replace_session, _get_session_dest_dir |
| SpamBot health check (no move) | code/repair.py | check_sessions_health_parallel, _check_session_spambot, classify_spambot_response |
| Move between free/dead/frozen | code/admin_control.py | session_move |
| Delete bot, move sessions to free or dead | code/utils.py | delete_bot_from_storage |
| Userbot create/delete | code/users.py | create_user_bot, disconnect_and_remove_controller_bot |
| User upload to users/ | code/users.py | Upload handler (upload_sessions state); user_dir = SESSIONS_BY_USER / str(sender_id); rel = f"users/{event.sender_id}/{p.name}" |
| Stale journal cleanup | main.py | _clean_stale_session_journals |
| Session integrity scan (orphans → free) | code/utils.py | run_session_ownership_integrity_scan |
| Session-dead error set | code/rpc_errors.py | _session_dead_errors(), SESSION_DEAD_ERRORS |

This completes the session-folder architecture trace and consistency check.
