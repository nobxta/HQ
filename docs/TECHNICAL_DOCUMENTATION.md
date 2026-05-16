# TAdbot — Technical Documentation

A structured technical document for developers. Use this to understand the system without reading the entire codebase.

---

## 1. Project Overview

### What this system does

**TAdbot** is a **Telegram AdBot hosting system**. It lets you run multiple **user-facing AdBots**, each backed by one or more **Telegram user sessions** (posting accounts). Each AdBot can post a configurable message or link to a list of groups/channels on a schedule. A single **admin bot** manages creation, session pool, and maintenance of all AdBots.

### Main purpose and use-case

- **Multi-tenant AdBot hosting:** One deployment serves many AdBots (e.g. one per customer).
- **Scheduled posting:** Each AdBot posts to its group list on a **cycle** (e.g. every hour) with a **gap** (e.g. 5 seconds) between posts to reduce flood risk.
- **Session pool:** Posting is done by **user sessions** (`.session` files). Sessions are stored in a pool (free / assigned / dead) and assigned to AdBots when creating or replacing.
- **Admin control:** One admin (via `ADMIN_USER_ID`) uses the admin bot to create AdBots, add/remove sessions, validate/replace dead sessions, recreate log groups, and delete AdBots.

### Type of automation implemented

- **Telegram Bot API (admin + user bots):** Admin bot and each user AdBot are Telegram bots (bot tokens).
- **Telethon user clients:** Posting is done by **Telethon user clients** using `.session` files (user accounts), not the bot token. This allows posting to groups as a user (e.g. forward or send text).
- **Multiprocessing workers:** Posting runs in **separate worker processes** (one session per worker). Each worker has its own asyncio loop and connects only during a posting cycle, then disconnects and sleeps until the next cycle.
- **Crash recovery:** On restart, the system loads `adbot.json`, starts each user bot, and resumes posting for bots that were `state == "running"` and still within `valid_till`.

---

## 2. Folder & File Structure

### Complete folder tree (logical)

```
TAdbot/
├── main.py              # Entry point
├── config.py             # API credentials, paths, logging
├── admin.py              # Admin bot logic
├── users.py              # User AdBots + posting workers
├── workers.py            # Multiprocessing worker entry + session loop wiring
├── crash.py              # Resume AdBots on start
├── utils.py              # adbot.json load/save, session validation, helpers
├── rpc_errors.py         # Centralized Telethon RPC error handling
├── diagnostic.py         # Standalone diagnostic script (no Telegram run)
├── adbot.json            # Persistent state (bots, sessions, alerts)
├── groups.txt            # Optional root-level group list (see groups/)
├── groups/               # Group list files per AdBot
│   ├── .gitkeep
│   ├── Starter.txt
│   └── kartik.txt
├── sessions/             # Created at runtime if missing
│   ├── active/           # Posting-account .session files
│   ├── dead/              # Invalid sessions moved here
│   ├── users/            # sessions/users/<user_id>/ (optional)
│   └── userbot/          # Controller-bot session files (one per AdBot)
├── logs/                 # Rotating logs
│   ├── adbot.log         # Main log (daily rotate, 7 backups)
│   └── bots/             # Per-bot log files (e.g. <bot_username>.log)
├── tools/                # Standalone utilities (not part of main process)
│   ├── group_joiner.py   # Bulk join sessions to one group/link
│   └── extract.py        # Extract group IDs from Telegram to file
├── docs/
│   ├── TECHNICAL_DOCUMENTATION.md  # This file
│   ├── OBSERVABILITY.md
│   ├── FAILURE_SCENARIOS.md
│   └── LOG_FORENSIC_AUDIT.md
├── requirements.txt
├── README.md
└── .env                  # Not in repo; copy from .env.example
```

### Role of each folder

| Folder        | Role |
|---------------|------|
| **Root**      | Application code, config, and single state file (`adbot.json`). |
| **groups/**   | `.txt` group list files. Each line: group ID (`-100...`) or `chat_id \| topic_id` for forum topics. One file per list; chosen per AdBot (e.g. `Starter.txt`, `kartik.txt`). |
| **sessions/active/** | **Posting** Telegram user session files. Discovered on start or added via admin (Manage Sessions). Assigned to AdBots when creating or replacing. |
| **sessions/dead/**   | Invalid/revoked sessions moved here by validation; can be removed via admin. |
| **sessions/users/**  | Optional; per-user session storage. |
| **sessions/userbot/**| Controller-bot session files: one per AdBot (`bot_<token_hash>.session`). Used by the Telethon client that handles /start, Run/Stop, Set Message, etc. Created when the AdBot is first used; deleted when the AdBot is deleted. |
| **logs/**     | `adbot.log` (main, daily rotate); `logs/bots/<username>.log` per AdBot. |
| **tools/**    | Standalone scripts (group joiner, ID extractor); not used by `main.py`. |
| **docs/**     | Documentation and observability/failure notes. |

### Responsibility of each major file

| File          | Responsibility |
|---------------|----------------|
| **main.py**   | Entry point. Sets up logging, multiprocessing spawn, cleans stale `.session-journal` in `sessions/active/`, loads `adbot.json`, discovers local sessions, starts admin bot task, log consumer, session health monitor, then runs `resume_adbots()`. Runs until shutdown; on exit stops posting, awaits stop cleanup, disconnects all registered clients. |
| **config.py** | Reads `.env` (via python-dotenv or manual), defines `API_ID`, `API_HASH`, `ADMIN_BOT_TOKEN`, `ADMIN_USER_ID`, `ADMIN_CONTACT`, `MAX_SESSIONS_PER_BOT`, optional `PROXY`. Defines paths: `SESSIONS_DIR`, `SESSIONS_ACTIVE`, `SESSIONS_DEAD`, `SESSIONS_BY_USER`, `GROUPS_DIR`, `LOGS_DIR`, `ADBOT_JSON`. Creates dirs; `setup_logging()` for daily rotating file + console. `resolve_session_path()` for session file paths. |
| **admin.py**  | Admin bot (Telethon client with `ADMIN_BOT_TOKEN`). Handles /start, /cmd, /health, /cpu, /logs, /broadcast; inline menus: Create AdBots, Manage Sessions, Manage AdBots. Create flow: name → sessions_count → cycle → gap → bot_token → valid_till → mode → group_file → summary → enqueue create job. Background **create worker thread** does session assign, log group creation, joins; result consumer on main loop starts user bot and edits final message. Add Sessions: file/txt/zip upload; Remove Sessions: delete free/dead. Manage AdBots: per-bot Validate, Replace dead, Replace error, Recreate log group, Delete (sessions to free or dead). Alert forward loop (30s); daily report (00:00). |
| **users.py**  | User AdBot logic and posting. **Controller:** one Telethon client per AdBot (bot token), session in `sessions/userbot/`. Handles /start (authorize → menu), Run, Stop, Set Message (text/link), Status, Logs, Validity, config menus (group file, mode, cycle, gap). **Posting:** started via Run; uses **multiprocessing workers** (one process per session). Each worker runs `_async_session_loop` with callbacks; controller applies results via `_worker_result_queue` and `_apply_worker_result`. Log queue consumer batches messages to log group. Session health monitor: heartbeat watchdog, restart posting only when worker count drops (no timer-based stall restart). FloodWait: session marked PAUSED when wait > threshold; other sessions continue. |
| **workers.py** | **Worker process entry:** `worker_entry(bot_token, worker_id, session_chunk, config_snapshot, command_queue, result_queue)`. Runs `asyncio.run(worker_main_async(...))`. Phase 1: wait for START (no Telethon yet); Phase 2: on START, stagger, run one `_async_session_loop` per session in chunk (SESSIONS_PER_WORKER=1). Listens for STOP; on STOP sets shutting_down, exits cleanly. Reports cycle_done, session_died, expired, ban_error, admin_alert, log, audit_log, heartbeat via result_queue. `chunk_sessions()` splits sessions for one-per-worker. |
| **crash.py**  | `resume_adbots(data)`: for each bot in `adbot.json`, starts `create_user_bot(bot_token)`; if `state == "running"` and `valid_till` ok, calls `_start_posting(bot_token)` so posting resumes. |
| **utils.py**  | `load_adbot()` / `save_adbot()` (orjson or json). `validate_session(path)`: connect, authorized, send to "me"; move to dead/ on session-dead errors. `get_session_user(path)`, `validate_bot_token(token)`, `discover_local_sessions(data)`. `join_chat_by_link()`, `recreate_log_group_for_bot()`. `add_admin_alert()`, `get_bot_log_path()`, `log_bot_event()`. Shutdown client registration; `resolve_session_path` uses config. |
| **rpc_errors.py** | Central RPC handling: `AdBotAction` (RETRY, SKIP_GROUP, SLEEP_ACCOUNT, MARK_SESSION_BANNED, STOP_BOT, IGNORE). `AdBotErrorHandler.handle(exc)` → (action, seconds). Session-dead, FloodWait, skip-group, message-skip, retryable, unknown. `FLOODWAIT_THRESHOLD_SEC`; `FloodWaitPause` for long waits. `with_retry()`, `safe_send_message()`, `safe_forward_messages()`, `safe_join_chat()`. |
| **diagnostic.py** | Standalone script: file tree, per-file inspection, safe startup (config, load adbot, admin client connect), adbot.json summary, multiprocessing/asyncio grep, final report. No Telegram run loop. |
| **adbot.json** | Single source of truth: `bots`, `free_sessions`, `dead_sessions`, `admin_alerts`, optional `last_report_snapshot`. Bots keyed by bot_token; per-bot: name, bot_username, valid_till, cycle, gap, mode, group_file, log_group, log_file, authorized, sessions, state, last_cycle_time, ban_error_count_by_session, message_text, post_link, etc. |

---

## 3. System Architecture

### Logical modules

1. **Controller (main process)**  
   - One asyncio event loop.  
   - Runs: admin bot, log queue consumer, session health monitor, worker result handler, and (after resume) waits on `asyncio.Event()` until shutdown.

2. **Admin bot**  
   - Single Telethon client (admin bot token).  
   - Handles commands and callbacks; enqueues create jobs; consumes create result queue; forwards alerts; sends daily report.

3. **User AdBots (controller bots)**  
   - One Telethon client per AdBot (same bot token, session in `sessions/userbot/`).  
   - Handles /start, Run/Stop, Set Message, Status, Logs, Validity, config.  
   - Sends log-group messages (from log queue) and runs only in the main process.

4. **Posting workers**  
   - Multiprocessing: one process per session (SESSIONS_PER_WORKER=1).  
   - Each process: asyncio loop, command_queue (START/STOP), result_queue (cycle_done, session_died, log, audit_log, heartbeat, etc.).  
   - Workers do not write `adbot.json`; controller applies their results.

5. **Persistence**  
   - `adbot.json` read/written only by the controller (and admin create worker thread, which runs create then saves via utils).

### How modules communicate

- **Controller ↔ Admin bot:** Same process; admin bot is an asyncio task.
- **Controller ↔ User bots:** Same process; user bots are asyncio tasks; log queue is a `queue.Queue` consumed by controller task.
- **Controller ↔ Workers:**  
  - **Command:** `multiprocessing.Queue` per worker; controller puts `{"cmd": "start"}` or `{"cmd": "stop"}`.  
  - **Result:** Single shared `multiprocessing.Queue`; workers put result dicts; controller runs `_worker_result_handler_async()` which calls `_apply_worker_result()` and updates adbot.json / alerts / log queue / audit log.
- **Create flow:** Admin puts (chat_id, msg_id, form, progress_queue) into `_create_job_queue`. Create worker thread runs `_sync_execute_create_adbot`, pushes progress via progress_queue (consumed on main loop), then result to `_result_queue`. Main loop result consumer edits message and starts user bot.

### Entry point and execution flow

- **Entry:** `python main.py` → `asyncio.run(main())` in `main.py`.
- **Sequence:**  
  1. `config.setup_logging()`  
  2. `multiprocessing.set_start_method("spawn", force=True)`  
  3. `_clean_stale_session_journals()`  
  4. `data = load_adbot()`; `discover_local_sessions(data)`; `data = load_adbot()` again  
  5. `asyncio.create_task(run_admin_bot())`  
  6. `asyncio.create_task(_log_queue_consumer())`  
  7. `asyncio.create_task(run_session_health_monitor())`  
  8. `await resume_adbots(data)` (starts user bots and posting for running bots)  
  9. `await asyncio.Event().wait()` (runs until Ctrl+C)  
  10. On shutdown: stop all posting, `await_all_pending_stop_cleanup()`, disconnect all registered clients.

---

## 4. Working Flow (Step-by-Step Runtime Flow)

### When the system starts

1. Logging and multiprocessing spawn are set up.  
2. Stale `.session-journal` in `sessions/active/` are removed.  
3. `adbot.json` is loaded; `discover_local_sessions()` adds any new `.session` files from `sessions/active/` to `free_sessions` and saves.  
4. Admin bot, log consumer, and session health monitor tasks are started.  
5. `resume_adbots(data)` runs (see below).  
6. Main loop waits on an event until shutdown.

### Session loading flow

- **Discovery:** `discover_local_sessions()` scans `sessions/active/`, adds filenames not in `free_sessions` or any bot’s `sessions` to `free_sessions`, saves.  
- **Add via admin:** Manage Sessions → Add Sessions → user sends .session, .txt (filenames), or .zip. Files are written to `sessions/active/`, validated; valid → `free_sessions`, invalid → moved to `sessions/dead/` and added to `dead_sessions`.  
- **Assignment:** On Create AdBot, sessions are taken from `free_sessions` (up to `sessions_count`, max `MAX_SESSIONS_PER_BOT`), validated; valid ones are assigned to the new bot and removed from `free_sessions`.  
- **Validation:** `validate_session(path)` connects, checks authorized, sends a test message to "me"; on session-dead errors moves file to `sessions/dead/` and returns False.  
- **Posting workers** use session paths from config snapshot; they do not discover or assign; controller owns all adbot.json updates.

### Group loading flow

- Group list is chosen per AdBot: `group_file` (e.g. `Starter.txt`) under `config.GROUPS_DIR` (or `groups_dir` in worker config snapshot).  
- **Parsing:** `_parse_groups_file(cfg)` reads the file; each non-empty line: `chat_id` or `chat_id | topic_id`. Numeric ids normalized to `-100...` form. Output: list of `{"chat_id": int, "topic_id": int | None}`.  
- **Assignment to sessions:**  
  - **Starter:** All sessions get the full list (every session posts to every group).  
  - **Enterprise:** Groups are partitioned by worker ordinal; each session gets a slice; per-session cap `MAX_POSTS_PER_CYCLE` applied in the loop.  
- Workers receive `groups_dir` in config snapshot so they can resolve `group_file` path in child process.

### Message/post processing flow

- **Per session (in worker):**  
  1. Wait for START (if not already).  
  2. Stagger (Starter: spread over 1 hour; Enterprise: second half after 5 min).  
  3. Loop: check stop_event, validity, cycle timing; connect for cycle; load groups; optionally join log group; get message_text and post_link from config.  
  4. For each group (respecting ban skip): wait until scheduled time (gap between posts, min 4–6 s with jitter); get entity (with retry); send or forward via `with_retry` / safe helpers; on success/failure call `report_log` (and report_ban_error if applicable).  
  5. Report cycle_done(session_file, timestamp); disconnect; sleep until next cycle (or heartbeat interval).  
- **Log group:** Worker sends log lines via result queue (`type: "log"`); controller enqueues to `_log_queue`; log consumer batches and sends to log group with controller bot client.  
- **Errors:** RPC handled by `rpc_errors`: session dead → report_session_died; FloodWait short → sleep and retry; FloodWait long → mark session PAUSED, skip cycle; skip-group → report_ban_error when appropriate and skip target; retryable → retry with backoff.

### Cycle/loop behavior

- **Cycle length:** `cycle` (seconds, min 300).  
- **Next cycle start:** `next_start = max(last_cycle_time[session] + cycle, now)` so cycles are not skipped after long waits.  
- **Gap:** User `gap` clamped to MIN_GAP_SEC–MAX_GAP_SEC with jitter.  
- **Within cycle:** Posts scheduled at `cycle_start + i * gap`; if late (e.g. after FloodWait), posts still attempted (sleep_until capped).  
- **After cycle:** Worker reports `cycle_done(session_file, timestamp)`; controller updates `last_cycle_time`; worker disconnects and sleeps until next cycle (or sends heartbeats during sleep).

### Error handling flow

- **Session dead (AuthKeyInvalid, SessionRevoked, etc.):** Worker reports `session_died`; controller calls `_mark_session_dead_and_replace()` (remove from bot, add to dead_sessions, move file to dead/, alert).  
- **Bot expired (valid_till):** Worker reports `expired`; controller marks bot expired and alerts.  
- **FloodWait &lt; threshold:** Worker sleeps then retries.  
- **FloodWait &gt; threshold:** Worker marks session PAUSED (via result queue / controller state), skips cycle, does not sleep in worker for full duration; health monitor can see heartbeats.  
- **Skip group (banned, private, etc.):** `report_ban_error` so target is skipped next time; continue to next group.  
- **Create failure:** Create worker returns None; result consumer edits message to failure.  
- **Worker crash:** Health monitor sees alive worker count &lt; assigned (or frozen: no heartbeat); restarts posting with `preserve_cycle_time=True`.  
- **Shutdown:** STOP sent to all workers; controller awaits pending stop cleanup; then disconnects all clients so no `.session-journal` remains.

---

## 5. Features List

### Implemented features

- Multi-AdBot hosting with one admin bot.  
- Create AdBot wizard: name, sessions count, cycle, gap, bot token, valid_till, mode (Starter/Enterprise), group file.  
- Session pool: free / assigned / dead; add via file/txt/zip; remove; validate; replace dead/error.  
- Posting: multiprocessing workers, one session per worker; connect per cycle, then disconnect.  
- Starter mode: all sessions post to all groups; stagger over 1 hour.  
- Enterprise mode: partition groups by worker; second-half stagger 5 min; per-session cap MAX_POSTS_PER_CYCLE.  
- Log group per AdBot: create on create flow; recreate via admin; auto-recreate on invalid log group.  
- Set message: text and/or link per AdBot; stored in adbot.json.  
- Validity: valid_till date; expiry marks bot expired and alerts.  
- Ban/target skip: permanent skip per (session, chat_id[/topic_id]) after first ban/error.

### Admin features

- /start, /cmd, /health, /cpu, /logs, /broadcast.  
- Create AdBots (wizard + background create worker).  
- Manage Sessions: Add (single .session, .txt, .zip), Remove (free/dead).  
- Manage AdBots: per-bot Validate, Replace dead, Replace error, Recreate log group, Delete (sessions to free or dead).  
- Alerts forwarded to admin DM (periodic drain).  
- Daily report at 00:00 (active bots, sessions, total posts, posts since last report).

### User features (per AdBot)

- /start: authorize (admin or in authorized list) → menu.  
- Run / Stop posting.  
- Set Message (text, link).  
- Status, Logs (log group link / instructions), Validity (valid_till, extend hint).  
- Config: group file, mode (Starter/Enterprise), cycle, gap (via menus).

### Automation features

- Scheduled posting with cycle and gap.  
- Crash resume: on start, resume user bots and posting for running bots within valid_till.  
- Session health monitor: restart posting when worker count drops or worker frozen (heartbeat timeout).  
- FloodWait: short wait in-worker; long wait → session PAUSED, other sessions continue.  
- Anti-ban: min gap 4–6 s with jitter; MAX_POSTS_PER_CYCLE in Enterprise; permanent target skip after ban/error.

### Logging, monitoring, scheduling

- **Logging:** Daily rotating `logs/adbot.log`; per-bot `logs/bots/<username>.log`; console INFO.  
- **Audit:** Worker sends audit_log (SESSION_CYCLE_START, SESSION_DELAYED, SESSION_PAUSED, SESSION_STOPPED, SESSION_CYCLE_DONE); controller writes to same logger → adbot.log.  
- **Heartbeat:** Workers send heartbeat; controller rate-limits heartbeat log lines; health monitor uses heartbeat for frozen detection.  
- **Scheduling:** Cycle and gap from config; next cycle = max(last + cycle, now); gap jitter ±20%.

---

## 6. Configuration System

### Config files

- **adbot.json** — Runtime state: bots, free_sessions, dead_sessions, admin_alerts, last_report_snapshot. Edited by controller and (during create) by create worker thread.  
- **.env** — Not in repo; copy from .env.example. Loaded by config.py (python-dotenv or manual).

### Environment variables

| Variable           | Purpose |
|--------------------|--------|
| API_ID             | Telegram API id (my.telegram.org). |
| API_HASH           | Telegram API hash. |
| ADMIN_BOT_TOKEN    | Bot token for the admin bot. |
| ADMIN_USER_ID      | Telegram user id; only this user can use admin bot and gets alerts/reports. Optional; 0 = no restriction. |
| ADMIN_CONTACT      | Shown to users when expired (e.g. "Contact @admin"). |
| PROXY_HOST         | Optional; proxy host for all Telegram clients. |
| PROXY_PORT         | Optional; e.g. 1080. |
| PROXY_TYPE         | Optional; socks5 or socks4 (default socks5). |

### How settings affect runtime

- **API_ID / API_HASH:** All Telethon clients use these.  
- **ADMIN_USER_ID:** Restricts admin bot and alert/report recipient; 0 = any user.  
- **MAX_SESSIONS_PER_BOT (config.py):** Cap on sessions per AdBot (default 50).  
- **PROXY_*:** If set, all clients use this proxy (PySocks).  
- **adbot.json `state`:** "running" → posting workers run; "stopped" / "dead" / "expired" → no posting.  
- **valid_till:** Empty = no expiry; else bot is expired after that date.  
- **cycle / gap / mode / group_file:** Read by workers from config snapshot; control schedule and target list.

---

## 7. Dependencies & Libraries

| Library       | Use |
|---------------|-----|
| **telethon**  | Telegram MTProto client for admin bot, user bots, and posting sessions. |
| **python-dotenv** | Load .env (optional; fallback manual parse in config). |
| **aiofiles** | Async file I/O if used (e.g. in tools or future code). |
| **orjson**    | Fast JSON for adbot.json load/save (optional; fallback stdlib json). |
| **PySocks**   | SOCKS proxy for Telegram when PROXY_HOST set. |
| **psutil**    | /cpu: CPU, RAM, disk, uptime; optional. |

---

## 8. Scalability / Extension Points

### Easy to extend

- **Group sources:** Group list is from `_parse_groups_file` / `_load_groups`; you can add other sources (e.g. API, DB) and keep the same `list[dict]` with `chat_id` / `topic_id`.  
- **Message content:** Currently `message_text` and `post_link`; posting loop can be extended for more message types (e.g. media, buttons).  
- **Admin commands:** New commands in admin.py; new callbacks for new buttons.  
- **User bot commands:** New handlers in users.py for the controller bot.  
- **RPC handling:** New error types or actions in rpc_errors.py; handlers in posting loop.

### Concurrency and multi-account behavior

- **Workers:** One process per session (`SESSIONS_PER_WORKER=1` in workers.py). Changing `chunk_sessions` / per_worker would change how many sessions run in one process.  
- **START command:** Controller sends START after spawning all workers to avoid connection storms.  
- **Result queue:** Single shared result queue; one handler task applies all results (no per-bot queue).  
- **Session pool:** Single adbot.json; concurrent writes are not allowed (single process + one create worker thread that does discrete create then save).  
- **Scaling:** README suggests one process per AdBot or worker pool per N bots for isolation; process managers (e.g. systemd, PM2) for multiple processes.

---

## 9. Deployment / Running Instructions

### Steps to run

1. **Prepare environment**  
   - Python 3.10+ (or version matching project).  
   - `pip install -r requirements.txt`

2. **Configure**  
   - Copy `.env.example` to `.env`.  
   - Set `API_ID`, `API_HASH`, `ADMIN_BOT_TOKEN`, `ADMIN_USER_ID` (optional).  
   - Optionally set `ADMIN_CONTACT`, `PROXY_HOST`, `PROXY_PORT`, `PROXY_TYPE`.

3. **Sessions**  
   - Put Telegram user `.session` files in `sessions/active/` (discovered on start), or add later via admin bot (Manage Sessions → Add Sessions).

4. **Group files**  
   - Add `.txt` files in `groups/` (e.g. `Starter.txt`) with one group id or `chat_id | topic_id` per line.

5. **Run**  
   - `python main.py`  
   - Process runs until Ctrl+C. Admin bot is available; create AdBots via menu; send /start to each AdBot to use Run/Stop and Set Message.

6. **Optional diagnostic**  
   - `python diagnostic.py` — checks tree, config, adbot load, admin client connect, and reports issues.

### Required setup before running

- **.env** with at least `API_ID`, `API_HASH`, `ADMIN_BOT_TOKEN`.  
- **Admin bot** created via @BotFather; token in ADMIN_BOT_TOKEN.  
- **ADMIN_USER_ID** (recommended): get your user id (e.g. from @userinfobot) and set so only you can use the admin bot.  
- **Session files:** At least one valid `.session` in `sessions/active/` (or add via admin) to create an AdBot.  
- **Group file:** At least one `.txt` in `groups/` if AdBot should post to groups.

### Shutdown

- Ctrl+C triggers shutdown: stop all posting (STOP to workers, await cleanup), then disconnect all registered clients (admin + user bots). This avoids leaving `.session-journal` files. Restart with `python main.py` to resume from adbot.json.

---

*This document reflects the codebase as of the last review. For observability and failure analysis, see `docs/OBSERVABILITY.md` and `docs/FAILURE_SCENARIOS.md`.*
