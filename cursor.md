TADBOT TELEGRAM ADVERTISING BOT - COMPLETE ARCHITECTURE AUDIT REPORT
====================================================================
Generated from full codebase analysis. Plain text only.

================================================================================
SYSTEM ARCHITECTURE SUMMARY
================================================================================

The system is a multi-bot Telegram advertising platform with four main subsystems:

1. Shop Bot (python-telegram-bot, SHOP_BOT_TOKEN): User self-service purchase flow. Users select plan, duration, pay via NowPayments crypto; on payment confirmation an order is created and a create job is enqueued. Shop bot runs in a separate thread (start_shop_bot_thread in main.py) with its own PTB Application.

2. Controller Bot (main process): The main entry point is main.py. It runs a single asyncio event loop. Admin bot (PTB), log consumer, alert forward, daily report, result consumer, session health monitor, stats flush, drift check, user log flush, main loop job consumer, and resume_adbots all run as asyncio tasks on this loop. Shop bot runs in a separate thread. Posting runs in multiprocessing worker processes: each worker is a separate Python process with its own asyncio loop and handles exactly one Telegram user session (SESSIONS_PER_WORKER=1 in workers.py).

3. Admin Bot (python-telegram-bot, ADMIN_BOT_TOKEN): Admin UI for Create AdBots wizard, Manage Sessions, Manage AdBots (validate, replace dead/error, recreate logs, delete). Create jobs are pushed to a queue consumed by create worker threads (admin.py: _create_job_queue, _create_worker_loop). Admin bot can run as Telethon (admin.py run_admin_bot) or PTB (admin_ptb.py run_admin_bot_ptb). main.py uses admin_ptb.

4. Backend worker system: For each user AdBot that is "running", the controller spawns N multiprocessing processes where N = number of sessions assigned to that bot. Each process runs workers.worker_entry, which calls asyncio.run(worker_main_async(...)). Inside worker_main_async, the process waits for a START command from the controller, then creates one asyncio task per session in its chunk (one session per worker). Each task runs users._async_session_loop. The session loop: connects Telethon client, waits stagger, then in an infinite loop: checks stop_event and config, validates expiry, applies cooldown, computes next cycle time from cycle_anchor_ts and cycle_sec (deterministic zero-drift scheduling), sleeps until next_cycle_time, runs one posting cycle (assign groups via _assigned_groups_for_session, iterate groups, apply gap/delay, post via forward_messages or send_message), reports cycle_done with scheduled_run_ts, then sleeps until next_scheduled = scheduled_run_ts + cycle_sec. Workers do not write storage; they push results (cycle_done, session_died, session_paused, etc.) to a multiprocessing.Queue read by the controller's _worker_result_handler_async, which applies updates via _apply_worker_result (save_user_data, config_patch to workers).

Session storage: Telegram user sessions are .session files (Telethon SQLite). They live under config.SESSIONS_ACTIVE (sessions/active/). Pool state (free_sessions, dead_sessions) is in data/pool.json. Per-bot config is in data/user/<safe_name>.json. Index data/user -> bot_token is in data/index.json (used by get_name_by_token from utils.load_adbot which builds bots from DATA_USER_DIR glob). Group lists are in groups/ (e.g. Starter.txt, enterprise.txt); format per line: -100xxxxxxxxxx or -100xxxxxxxxxx | topic_id.

Payment: NowPayments API. Shop creates invoice via shop/payment.py create_invoice; payment_polling_worker in shop/workers.py polls get_payment_details; on confirmed status it creates/updates order in data/orders.json and for new purchases calls submit_create_job(chat_id, msg_id, form) so the create pipeline runs. Create pipeline: admin _create_job_queue -> _create_worker_loop (thread) -> with creation_pool_lock: load_adbot(), _sync_execute_create_adbot (runs _core_create_adbot_async in a new event loop in thread), _result_queue.put. Result consumer (admin or admin_ptb) edits message and calls create_user_bot(bot_token). create_user_bot starts the Telethon controller client for that token (user talks to their bot); it does NOT start posting. Posting is started when user sends /start and clicks Run, which triggers _start_posting(bot_token) from the controller bot or from the user's bot handler.

================================================================================
COMPONENT RELATIONSHIP MAP
================================================================================

main.py
  - Imports: config, admin_ptb (run_admin_bot_ptb, _alert_forward_loop_ptb, _daily_report_loop_ptb, _result_consumer_ptb, _main_loop_job_queue, _admin_ptb_running), notify, crash (resume_adbots), shop.handlers (start_shop_bot_thread), shop.workers (payment_polling_worker, renewal_scheduler_worker, order_recovery_on_startup, daily_orders_cleanup_worker, daily_supported_currencies_sync_worker, run_payment_reconciliation, PAYMENT_HEARTBEAT_PATH, WATCHDOG_STALE_SEC), shop.payment (validate_payment_config, fetch_supported_currencies, _startup_nowpayments_test), utils (load_adbot, discover_local_sessions, get_shutdown_clients), users (_stop_posting, _log_queue_consumer, run_session_health_monitor, await_all_pending_stop_cleanup, _stats_flush_loop, _drift_check_loop, _user_log_flush_loop).
  - Starts: admin PTB task, log consumer, alert forward, daily report, result consumer, session health monitor, stats flush, drift check, user log flush, main loop job consumer, shop order recovery, payment polling worker, renewal scheduler, daily orders cleanup, daily currencies sync, worker watchdog, daily session integrity and reconciliation, start_shop_bot_thread (thread). Then resume_adbots(data). Then waits on asyncio.Event(). On shutdown: cancel tasks, _stop_posting for all bots, await_all_pending_stop_cleanup, disconnect get_shutdown_clients().

admin_ptb.py
  - Uses admin.py for create job queue, result queue, _session_counts, _create_status_text, _get_system_stats, load_adbot, save_adbot, _workers_alive, _start_create_worker_if_needed, _process_upload_standalone, _admin_validate_sessions, _admin_replace_dead, _admin_replace_error_sessions, _admin_recreate_log_group, _extract_zip_and_copy_sessions, _unique_session_path. Uses users.create_user_bot. Provides submit_main_loop_job(job_type, payload) which puts (job_type, payload) on _main_loop_job_queue. Provides submit_create_job(chat_id, msg_id, form, progress_queue, notification_bot_token) which enqueues create job and starts progress consumer; create worker threads (started by admin._start_create_worker_if_needed) consume and run _sync_execute_create_adbot -> _core_create_adbot_async; result is put on _result_queue; _result_consumer_ptb (in main) or admin's _result_consumer gets it and calls create_user_bot(bot_token) and edits message.

users.py
  - Core posting and controller bot logic. _async_session_loop: one session loop (Telethon connect, stagger, while True: schedule next cycle, sleep until due, get assigned groups, post to each with gap/delay, report_cycle_done(scheduled_run_ts), sleep until next_scheduled). _start_posting: build config snapshot, chunk_sessions (1 per worker), spawn multiprocessing.Process(worker_entry, ...) per chunk, send START to each cmd_queue. _stop_posting: put STOP in cmd_queues, spawn _stop_worker_cleanup_background to join processes. create_user_bot: start Telethon client for user's bot token, register /start and Run/Stop handlers; on Run calls _start_posting via submit_main_loop_job or inline. Worker result handler: _worker_result_handler_async reads _worker_result_queue, _apply_worker_result updates storage and optionally sends config_patch to workers.

workers.py
  - worker_entry: sync entry, applies telethon compat patch, asyncio.run(worker_main_async(...)). worker_main_async: command_listener task (get from command_queue, on "stop" set stop_event, on "start" set start_event, on "config_patch" update local_config_patch); wait for start or stop; if stop before start exit; else create one task per session in session_chunk calling _async_session_loop with get_config, report_cycle_done, report_* callbacks that put on result_queue. chunk_sessions(sessions, per_worker=1) -> list of lists, one session per chunk.

utils.py
  - load_adbot: load pool (data/pool.json), glob data/user/*.json, load_user_data each, return {bots: {token: cfg}, free_sessions, dead_sessions, ...}. save_adbot: save_pool + save_user_data for each bot. Session validation (validate_session, validate_session_with_reason), get_session_user, join_chat_by_link, discover_local_sessions, expire_bot_return_sessions_to_pool, delete_bot_from_storage, run_session_ownership_integrity_scan. File lock and atomic writes for user/pool/stats. register_session_active_check used by users to avoid validating a session that is in use by a worker.

config.py
  - BASE_DIR, paths (SESSIONS_DIR, SESSIONS_ACTIVE, GROUPS_DIR, DATA_DIR, DATA_USER_DIR, DATA_POOL_FILE, etc.), API_ID/API_HASH, ADMIN_BOT_TOKEN, SHOP_BOT_TOKEN, NOWPAYMENTS_*, MIN_CYCLE_SEC, MAX_SESSIONS_PER_BOT, resolve_session_path, setup_logging.

shop/handlers.py
  - PTB handlers for /start, Buy AdBot, plan/duration selection, payment (create_invoice), Proceed -> submit_create_job(chat_id, msg_id, form). Order recovery and payment polling in shop/workers.py; on confirmed payment shop can submit_create_job (e.g. after user sends bot name and token in wizard).

shop/workers.py
  - payment_polling_worker: loop over temppay and orders with status confirming/waiting, get_payment_details; on confirmed create order and notify; for new purchases trigger submit_create_job. order_recovery_on_startup: load orders pending_creation, submit_create_job for each. renewal_scheduler_worker, daily_orders_cleanup_worker, daily_supported_currencies_sync_worker, run_payment_reconciliation.

shop/payment.py
  - create_invoice (NowPayments), get_payment_details, validate_payment_config, fetch_supported_currencies.

shop/storage.py
  - load_orders, get_order, update_order_status, create_order, create_renewal_order, orders_pending_creation, etc. (data/orders.json, plans.json).

crash.py
  - resume_adbots(data): for each bot in data["bots"], create_user_bot(bot_token); if state==running and valid_till ok and not in emergency_stopped, _start_posting(bot_token).

rpc_errors.py
  - AdBotErrorHandler, with_retry (FloodWait sleep and retry, session-dead re-raise), SESSION_DEAD_ERRORS, FloodWaitPause (session-level), FloodWaitGroupSkip (group-level skip), is_permanent_error for Enterprise pruning.

================================================================================
SESSION MANAGEMENT ANALYSIS
================================================================================

SESSION POOL STRUCTURE
  - Pool is stored in data/pool.json: free_sessions (list of session filenames), dead_sessions, frozen_sessions, admin_alerts. load_pool/save_pool in utils.py. Session files on disk: config.SESSIONS_ACTIVE (sessions/active/) for active, SESSIONS_DEAD for dead. resolve_session_path(file_str): if file_str starts with "users/" then SESSIONS_DIR / file_str else SESSIONS_ACTIVE / file_str.

SESSION ASSIGNMENT TO USERS
  - When an AdBot is created (admin _core_create_adbot_async or shop-triggered create): form has sessions_count. adbot_data = load_adbot(); free_list = adbot_data["free_sessions"]. For each of sessions_count: take next fn from free_list, validate path exists and validate_session(path), get_session_user for real_name/user_id, append {"file": fn, "real_name", "user_id", "index"} to assigned, remove fn from free_sessions (or dead_sessions if invalid). save_user_data(safe_name, entry) with entry["sessions"] = assigned. save_pool with updated free_sessions/dead_sessions. Assignment is done under creation_pool_lock in admin _create_worker_loop so the same session cannot be assigned to two bots.

SESSION ROTATION
  - There is no automatic rotation of sessions between bots. Sessions are assigned once at creation. Replace dead/error (admin Replace dead sessions, Replace error sessions) takes missing or invalid sessions from a bot's list and replaces them from free_sessions (one-for-one). Session replacement history is stored in cfg["session_replacements"].

SESSION FAILURE HANDLING
  - In posting: if with_retry or AdBotErrorHandler raises or returns session-dead (MARK_SESSION_BANNED), report_session_died(session_file, reason) is called (worker) or _mark_session_dead_and_replace (controller). _mark_session_dead_and_replace: add session to excluded_sessions, optionally replace from free pool (replace_dead_session_for_bot), notify admin. In worker, session_died result is applied by _apply_worker_result which calls _mark_session_dead_and_replace. FloodWait: account-level FloodWait causes report_session_paused(session_file, unblock_time, wait_seconds); controller persists session_pause_until[session_file] = unblock_time and pushes config_patch so workers exclude that session from active_session_files until pause expires. Session then disconnects and sleeps until pause_until then continues loop. cycle_failed: when a session attempted 0 posts in a cycle (e.g. all groups skipped or no assignment), report_cycle_failed is called; controller adds session to excluded_sessions so it gets no groups on next assignment. Health monitor: run_session_health_monitor checks heartbeats and stalled workers; if a worker has no heartbeat for threshold it can trigger _restart_single_worker (terminate process, spawn new one with same session, send START).

================================================================================
FORWARDING ENGINE ANALYSIS
================================================================================

MAIN POSTING LOOP
  - The main posting loop is inside users._async_session_loop. After scheduling (next_cycle_time, sleep until due), it calls _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers) to get (groups, total_groups). Then it iterates: for idx, g in enumerate(groups): check cycle_end_ts (if time.time() >= cycle_end_ts break or rollover pending_groups in Starter); check stop_event; check group_key in posted_this_cycle (skip if already posted); group cooldown (group_cooldowns); get_ban_skip; FloodWait remaining wait; session_gap_wait = scheduled_for - now where scheduled_for = cycle_start + idx * effective_gap_cycle; final_wait = max(global_wait, min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), retry_wait); await asyncio.sleep(final_wait); then get_entity (with_retry), forward_messages or send_message (with_retry). Handler catches FloodWaitGroupSkip (skip group, set group_cooldowns[chat_id]), FloodWaitPause (Enterprise: short wait sleep and retry, long wait skip group), other exceptions via AdBotErrorHandler (MARK_SESSION_BANNED, SKIP_GROUP, etc.). After the for-loop, Starter mode may drain _pop_deferred_groups and post (deferred from FloodWait pause). Then report_cycle_done(session_file, scheduled_run_ts, ...), and sleep until next_scheduled = scheduled_run_ts + cycle_sec in chunks (heartbeat, stop_event check).

SESSION LOOP
  - The session loop is the same _async_session_loop. One loop per session. While True: update _worker_last_activity; report_heartbeat; get_config() (worker) or load_adbot (in-process); check no config / state not running / expired / cooldown; compute cycle_anchor, cycle_index, next_cycle_time (current boundary), delta_sec; if run_first_cycle_immediately and not run_first_cycle_done then next_cycle_time = now; if delta_sec > 0 sleep in chunks; then one cycle (connect if needed, assign groups, for g in groups: delay then post), report_cycle_done(scheduled_run_ts), sleep until next_scheduled. So the session loop is: schedule -> sleep to boundary -> run one cycle -> report -> sleep to next boundary -> repeat.

GROUP ITERATION
  - groups = assigned from _assigned_groups_for_session. Starter: full list rotated by _rotate_group_list_by_cycle_index (idx = int(time.time() // cycle_sec) % len(groups); return groups[idx:] + groups[:idx]). Enterprise: partition by session index, start = idx_global * n // total_denom, end = (idx_global+1)*n // total_denom; return all_groups[start:end]. Excluded: excluded_sessions (session in excluded -> []), session_pause_until > now -> [], session_cooldown_until > now -> [], excluded_groups (persistent) filter from all_groups. Enterprise also requires session_file in active_session_files (not paused, not excluded, not cooldown).

DELAY LOGIC
  - effective_gap_cycle = max(MIN_GAP_SEC, _effective_gap_sec.get((bot_token, session_file), gap) - 1) per cycle (decay). scheduled_for = cycle_start + idx * effective_gap_cycle. session_gap_wait = max(0, scheduled_for - now) (capped by MAX_DRIFT_SEC). final_wait = max(global_wait, min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), retry_wait). await asyncio.sleep(final_wait). So delay is applied once per group before posting; next iteration may have session_gap_wait from the next scheduled_for. FloodWait: if flood_wait_remaining > 0 the loop first waits until pause_until in chunks, then recomputes session_gap_wait.

CYCLE WAITING
  - next_scheduled = scheduled_run_ts + cycle_sec. After cycle, while time.time() < next_scheduled: sleep in chunks (min(SCHEDULER_POLL_INTERVAL_SEC, heartbeat_interval, remaining)), report_heartbeat, check stop_event. So cycle wait is deterministic: next run at last cycle start + cycle_sec, not at cycle end. cycle_anchor_ts is set once at _start_posting (cycle_anchor_ts = time.time()) so all sessions share the same boundary; cycle_index = (now_ts - cycle_anchor) // cycle_sec; current_boundary = cycle_anchor + cycle_index * cycle_sec; next_cycle_time = current_boundary (or now for run_first_cycle_immediately).

RESTART LOGIC
  - After sleep until next_scheduled the while True loop continues: next iteration gets fresh get_config()/load_adbot(), recomputes next_cycle_time (same anchor), so next run is at next boundary. No explicit "restart" of cycle; the loop naturally runs again. Worker process never exits unless stop_event or session died or no config or expired.

GROUP SKIP CONDITIONS
  - Session excluded (excluded_sessions): _assigned_groups_for_session returns []. Session paused (session_pause_until > now): returns []. Session cooldown (session_cooldown_until > now): returns []. Enterprise and session not in active_session_files: returns []. In-loop: group_key in posted_this_cycle (duplicate); group_cooldowns[chat_id] > now (FloodWait group skip); get_ban_skip(session_file, g) (ban_error_count_by_session >= 1). Permanent exclusion: excluded_groups in config; permanently_excluded_groups in-memory in session loop; Enterprise is_permanent_error or SKIP_GROUP adds to permanently_excluded_groups and optionally report_permanent_exclusion -> controller adds to excluded_groups and config_patch.

RATE LIMIT HANDLING
  - FloodWait from Telethon: with_retry in rpc_errors catches FloodWaitError; if wait seconds >= FLOODWAIT_THRESHOLD_SEC (e.g. 300) then session-level: raise FloodWaitPause, session disconnects and sleeps until unblock_time, report_session_paused; else group-level: raise FloodWaitGroupSkip, group_cooldowns[chat_id] = now + seconds, skip group. FLOODWAIT_GAP_BOOST_SEC and effective_gap decay in users. Enterprise: FLOODWAIT_SLEEP_RETRY_THRESHOLD_SEC (60): below sleep and retry same group; above skip group. MIN_GAP_SEC/MAX_GAP_SEC (4-6) enforce inter-post delay; GAP_JITTER ±20%.

ERROR HANDLING AND RETRY
  - with_retry(coro_factory, handler): loop max_tries, on FloodWaitError sleep and retry; on SESSION_DEAD_ERRORS re-raise; on _RETRYABLE sleep backoff and retry; on _SKIP_GROUP handler returns SKIP_GROUP; on _MESSAGE_SKIP return None (skip); else handler.handle(e). AdBotErrorHandler maps exceptions to AdBotAction (RETRY, SKIP_GROUP, SLEEP_ACCOUNT, MARK_SESSION_BANNED, etc.). Post failure: log, report_post_attempt, ban_error or _increment_ban_error_count, permanent exclusion in Enterprise; session_died if MARK_SESSION_BANNED.

================================================================================
POSTING WORKFLOW TRACE
================================================================================

USER PURCHASE FLOW
  1. User starts shop bot (PTB), /start.
  2. User selects Buy AdBot -> plan (from plans.json), duration.
  3. handlers create order or use existing; create_invoice (NowPayments), show payment message (address, amount).
  4. payment_polling_worker (shop/workers.py) polls get_payment_details for temppay/orders; on status confirmed amount_received >= pay_amount: append_order_from_temppay or update order, build_payment_confirmation_screen, notify_edit_message (Proceed button).
  5. User clicks Proceed; handler may ask for AdBot name and bot token (STEP5, STEP6); form built with order_id, user_id, plan, duration, bot_token, bot_username, etc.
  6. submit_create_job(chat_id, msg_id, form) in admin_ptb: _create_job_queue.put((chat_id, msg_id, form, progress_queue)); _start_create_worker_if_needed() starts create worker threads.
  7. Create worker thread: _create_job_queue.get(); with creation_pool_lock: adbot_data = load_adbot(); _sync_execute_create_adbot(...) runs _core_create_adbot_async in a new event loop in that thread. _core_create_adbot_async: validate bot token, assign sessions from free_sessions (validate each, get_session_user), create log group (Telethon CreateChannelRequest, invite bot, join all sessions), save_user_data(safe_name, entry), save_pool, add_admin_alert. _result_queue.put((chat_id, msg_id, username, form)).
  8. Result consumer (_result_consumer_ptb in main): _result_queue.get(); if username: asyncio.create_task(create_user_bot(bot_token)); edit message "Bot created: @username".
  9. create_user_bot(bot_token): Telethon client with session in sessions/userbot/bot_<token_fingerprint>; client.start(bot_token=bot_token); register /start and Run/Stop handlers. User can /start and click Run.
  10. Run handler: calls _start_posting(bot_token) (via submit_main_loop_job("start_posting", (token,)) from controller or directly from user bot context). _start_posting: valid_sessions = sessions with file present and not in excluded; filter valid_sessions_with_groups (skip sessions with 0 assigned groups); chunk_sessions(valid_sessions, 1) -> one chunk per session; config_snapshot = _build_worker_config_snapshot(cfg, ..., run_first_cycle_immediately=True); for each chunk spawn Process(worker_entry, bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, _worker_result_queue); _worker_handles[bot_token] = workers_list; send START to each cmd_queue. Workers then run _async_session_loop (after stagger). Log group already created in step 7; message configured in user config (message_text or post_links); forwarding starts when first cycle runs (run_first_cycle_immediately so next_cycle_time = now).

RUNTIME: HOW SESSIONS ARE LOADED
  - Sessions are not "loaded" at worker start in the sense of loading from disk again; the worker receives session_chunk (list of dicts with "file" key, e.g. [{"file": "919749080844.session", "real_name": "...", "user_id": ..., "index": 1}]). config_snapshot has groups_dir, group_file, so _parse_groups_file in the worker uses Path(cfg["groups_dir"]) / cfg["group_file"] to read groups from disk (worker process has its own cwd/paths from config at start). Session file path: config.resolve_session_path(session_file) -> SESSIONS_ACTIVE / session_file.

RUNTIME: HOW SESSIONS ARE ASSIGNED TO A USER
  - Assignment to a user (bot) is fixed at creation time: cfg["sessions"] in data/user/<name>.json. At runtime, _assigned_groups_for_session uses that cfg (from get_config() in worker, which merges config_snapshot with local_last_cycle and local_config_patch). So the user's sessions are already assigned; group assignment (which groups this session posts to) is computed per cycle: Starter full list rotated, Enterprise shard [start:end].

RUNTIME: HOW SESSIONS START WORKERS
  - _start_posting spawns len(valid_sessions) processes (one per session). Each process runs worker_entry(bot_token, worker_id, session_chunk, config_snapshot, cmd_queue, result_queue). After START is sent, worker_main_async creates one asyncio task per session in session_chunk, each running _async_session_loop(..., get_config=get_config, report_cycle_done=..., ...). So one process per session, one session loop per process.

RUNTIME: HOW WORKERS RECEIVE GROUP LISTS
  - Groups are not received via queue. Each cycle, inside _async_session_loop, cfg = get_config() (worker) or load_adbot()["bots"][bot_token] (in-process). _assigned_groups_for_session(bot_token, cfg, session_file, session_ordinal, total_workers) calls _load_groups(cfg) -> _parse_groups_file(cfg) which reads Path(cfg["groups_dir"]) / cfg["group_file"] from disk. So every cycle the worker reads the group file (or uses cached list from config_snapshot for group_file path; groups_dir and group_file are in config_snapshot). _parse_groups_file reads the file each time (path.read_text().splitlines()). So workers receive group list by reading the same group file path each cycle.

RUNTIME: HOW GROUPS ARE ITERATED
  - assigned, total_groups = _assigned_groups_for_session(...). groups = list(assigned) (Enterprise) or pending_groups + assigned with cap (Starter). for idx, g in enumerate(groups): check cycle_end_ts (break or rollover); stop_event; posted_this_cycle; group_cooldowns; get_ban_skip; FloodWait wait; session_gap_wait = cycle_start + idx * effective_gap_cycle - now; final_wait = max(..., min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), ...); await asyncio.sleep(final_wait); get_entity; forward_messages or send_message; on success posted_this_cycle.add(group_key). So strict order over groups; one post per group per cycle; delay between posts.

RUNTIME: HOW DELAYS ARE APPLIED
  - final_wait computed from session_gap_wait (scheduled_for - now). await asyncio.sleep(final_wait). Then post. Next iteration: next idx, next scheduled_for = cycle_start + (idx+1)*effective_gap_cycle, so delay is spacing between posts. effective_gap_cycle is decayed each cycle (minus 1) from FLOODWAIT_GAP_BOOST or previous value, floored at MIN_GAP_SEC.

RUNTIME: HOW CYCLE WAITING WORKS
  - scheduled_run_ts is the time at which this cycle started (next_cycle_time that was due). After cycle, next_scheduled = scheduled_run_ts + cycle_sec. report_cycle_done(session_file, scheduled_run_ts). Then while time.time() < next_scheduled: sleep chunk, heartbeat, stop check. So the wait is until the next fixed boundary (cycle_anchor + (cycle_index+1)*cycle_sec). No drift: anchor is set once at start.

RUNTIME: HOW SESSIONS RESTART AFTER A CYCLE
  - There is no process restart. The same _async_session_loop while True continues. After "sleep until next_scheduled" the loop goes to the top: get config, check expiry/cooldown, compute next_cycle_time (same anchor, next boundary), if delta_sec > 0 sleep again (should be 0 or small after just sleeping to next_scheduled), then run another cycle. So "restart" is just the next iteration; cycle_index increases each time.

================================================================================
FILE LEVEL ANALYSIS
================================================================================

main.py
  Purpose: Single entry point; starts admin bot (PTB), log consumer, health monitor, shop-related tasks, main loop job consumer; resumes AdBots from storage; on shutdown stops posting and disconnects sessions.
  Classes: None.
  Functions: _clean_stale_session_journals, _read_heartbeat_ts, _daily_session_integrity_and_reconciliation, _worker_watchdog_loop, _asyncio_exception_handler, main (async).
  Imports: code.config, code.admin_ptb, code.notify, code.crash, code.shop.handlers, code.shop.workers, code.shop.payment, code.utils, code.users.
  Imported by: None (entry).
  Controls: Process lifecycle, task creation for admin/log/health/stats/drift/user_log/watchdog/reconciliation/shop workers, resume_adbots, main loop job consumer, shutdown.

code/config.py
  Purpose: API credentials, paths (sessions, groups, data, logs), MIN_CYCLE_SEC, MAX_SESSIONS_PER_BOT, PROXY, resolve_session_path, setup_logging.
  Classes: None.
  Functions: resolve_session_path, setup_logging.
  Imports: os, pathlib, dotenv, logging.
  Imported by: main (indirect via code.*), admin, admin_ptb, users, workers, utils, shop, repair, etc.
  Controls: Global paths and env-based config.

code/workers.py
  Purpose: Multiprocessing worker entry; each process runs one asyncio loop and one session loop (per session in chunk; chunk size 1).
  Classes: WorkerLogFilter.
  Functions: worker_entry, worker_main_async, chunk_sessions.
  Imports: asyncio, logging, multiprocessing, config, users (_async_session_loop, ENTERPRISE_STAGGER_SEC, STAGGER_WINDOW_SEC, _target_key_for_skip).
  Imported by: users (_start_posting, _restart_single_worker).
  Controls: Worker process lifecycle, command_listener (START/STOP/config_patch), creation of _async_session_loop tasks, result_queue puts (cycle_done, session_died, etc.).

code/users.py
  Purpose: User AdBot logic: controller bot (create_user_bot), posting (_start_posting, _stop_posting), session loop (_async_session_loop), group assignment (_assigned_groups_for_session), group loading (_load_groups, _parse_groups_file), worker result application (_apply_worker_result), health monitor (run_session_health_monitor), log queue consumer (_log_queue_consumer).
  Classes: None (uses AdBotErrorHandler from rpc_errors).
  Functions: Many; key: enqueue_log, _log_queue_consumer, _async_session_loop, _assigned_groups_for_session, _load_groups, _parse_groups_file, _rotate_group_list_by_cycle_index, _start_posting, _stop_posting, _apply_worker_result, _worker_result_handler_async, create_user_bot, run_session_health_monitor, _build_worker_config_snapshot.
  Imports: config, bot_ptb, notify, maintenance, rpc_errors, utils, repair.
  Imported by: workers, admin (create_user_bot, _stop_posting, etc.), admin_ptb, crash, main.
  Controls: Posting lifecycle, session loop logic, group iteration, delay/cycle timing, worker result handling, controller bot.

code/utils.py
  Purpose: Per-user and pool storage (load_adbot, save_adbot, load_user_data, save_user_data, load_pool, save_pool, load_stats, save_stats), session validation, get_session_user, join_chat_by_link, discover_local_sessions, expire_bot_return_sessions_to_pool, delete_bot_from_storage, validate_bot_token, name_to_filename, get_name_by_token, register_for_shutdown, add_admin_alert, append_to_user_log, recreate_log_group_for_bot.
  Classes: None.
  Functions: name_to_filename, load_user_data, save_user_data, load_pool, save_pool, load_adbot, save_adbot, get_name_by_token, get_token_by_name, validate_session, get_session_user, join_chat_by_link, discover_local_sessions, expire_bot_return_sessions_to_pool, delete_bot_from_storage, run_session_ownership_integrity_scan, etc.
  Imports: config, telethon, rpc_errors, filelock, orjson/json.
  Imported by: admin, admin_ptb, users, main, shop, repair.
  Controls: All persistent state (pool, user JSON, stats), session validation, bot token validation.

code/admin.py
  Purpose: Admin bot logic (Telethon variant), create AdBot wizard, manage sessions/adbots, create worker threads (_create_worker_loop), _core_create_adbot_async (session assignment, log group creation, save_user_data), validate/replace/recreate log/delete.
  Classes: None.
  Functions: _core_create_adbot_async, _sync_execute_create_adbot, _create_worker_loop, _start_create_worker_if_needed, request_create_worker_restart, execute_create_adbot, _result_consumer, _admin_validate_sessions, _admin_replace_dead, _admin_replace_error_sessions, _admin_recreate_log_group, etc.
  Imports: config, users, utils.
  Imported by: admin_ptb (heavy use of admin create queue, result queue, create worker, validation, replace, recreate).
  Controls: Create pipeline (queue, worker threads, result), admin UI (Telethon), session add/remove, bot CRUD.

code/admin_ptb.py
  Purpose: Admin bot using PTB; same UI as admin but with python-telegram-bot; submit_main_loop_job, submit_create_job; result consumer PTB; broadcast; main loop job queue consumer runs in main.py.
  Classes: None.
  Functions: submit_main_loop_job, submit_create_job, run_admin_bot_ptb, _result_consumer_ptb, _alert_forward_loop_ptb, _daily_report_loop_ptb, etc.
  Imports: config, bot_ptb, notify, admin, users, utils, repair.
  Imported by: main (run_admin_bot_ptb, result consumer, alert, daily report, job queue), shop/handlers (submit_create_job), users (submit_main_loop_job for expire_bot), admin_control (submit_main_loop_job).
  Controls: Admin PTB app, create job submission, main loop job submission.

code/bot_ptb.py
  Purpose: PTB Bot instances for log group sending and admin DM; cache _ptb_bots; send_log_message, send_admin_dm_alert, edit_message_with_bot.
  Classes: None.
  Functions: _get_ptb_bot, _get_admin_bot, send_log_message, send_admin_dm_alert, edit_message_with_bot, send_message_with_bot_return_id.
  Imports: config.
  Imported by: users (enqueue_log -> notify -> bot_ptb for log), admin_ptb (notify), notify (bot_ptb).
  Controls: Sending to log groups and admin DM via PTB.

code/crash.py
  Purpose: Resume running AdBots on startup; load emergency_stopped; for each bot create_user_bot and if state==running and valid_till and not emergency_stopped then _start_posting.
  Classes: None.
  Functions: _load_emergency_stopped_tokens, _valid_till, resume_adbots.
  Imports: config, users.
  Imported by: main.
  Controls: Startup resume behavior.

code/rpc_errors.py
  Purpose: Centralized RPC error handling; AdBotErrorHandler, with_retry, FloodWaitPause, FloodWaitGroupSkip, SESSION_DEAD_ERRORS, is_permanent_error.
  Classes: AdBotErrorHandler (or similar).
  Functions: with_retry, is_permanent_error, error class builders.
  Imports: telethon.errors.
  Imported by: users, utils.
  Controls: Retry/skip/session-dead behavior in posting and validation.

code/shop/handlers.py
  Purpose: Shop bot PTB handlers: /start, Buy AdBot, plan/duration, payment, Proceed, submit_create_job.
  Classes: None.
  Functions: Handlers for callback and message; submit_create_job called when user completes payment and bot name/token.
  Imports: config, admin_ptb, maintenance, ui.emoji_entities, utils, shop.workers, shop.storage, shop.payment.
  Imported by: main (start_shop_bot_thread loads and runs shop bot).
  Controls: Shop purchase flow and create job submission.

code/shop/workers.py
  Purpose: Payment polling, order recovery on startup, renewal scheduler, daily cleanup, currencies sync; on payment confirmed creates order and submit_create_job.
  Classes: None.
  Functions: payment_polling_worker, order_recovery_on_startup, renewal_scheduler_worker, daily_orders_cleanup_worker, daily_supported_currencies_sync_worker, run_payment_reconciliation, build_payment_confirmation_screen.
  Imports: config, notify, shop.storage, shop.payment, shop.explorer, ui.
  Imported by: main (payment_polling_worker, etc.), shop/handlers (build_payment_confirmation_screen, messages).
  Controls: Payment polling and order -> create job trigger.

code/shop/payment.py
  Purpose: NowPayments API: create_invoice, get_payment_details, validate_payment_config, fetch_supported_currencies.
  Classes: None.
  Functions: create_invoice, get_payment_details, validate_payment_config, fetch_supported_currencies, _startup_nowpayments_test.
  Imports: config, payment_constants.
  Imported by: shop/handlers, shop/workers.
  Controls: Payment provider integration.

code/shop/storage.py
  Purpose: Orders and plans storage (data/orders.json, data/plans.json), get_order, update_order_status, create_order, temppay.
  Classes: None.
  Functions: load_orders, get_order, update_order_status, create_order, orders_pending_creation, etc.
  Imports: config.
  Imported by: shop/handlers, shop/workers, admin (create worker order status).
  Controls: Order and plan persistence.

code/user_config.py
  Purpose: User JSON schema, merge_for_save, migrate_user_config, build_plan_section, build_history_section, build_stats_section.
  Classes: None.
  Functions: merge_for_save, migrate_user_config, ensure_legacy_compatibility, build_plan_section, build_history_section, build_stats_section.
  Imports: config.
  Imported by: utils (save_user_data uses merge_for_save, migrate_user_config), admin (_core_create_adbot_async uses build_plan_section, etc.).
  Controls: User config schema and migration.

code/repair.py
  Purpose: Repair utilities (repair_fix_log_group, repair_fix_config, repair_fix_sessions, repair_replace_session, check_sessions_health_parallel).
  Imported by: users, admin_ptb.
  Controls: Repair flows from admin/controller.

code/notify.py
  Purpose: Notify helpers (notify_log_group, notify_edit_message, notify_send_to_chat, notify_admin, notify_dm_received) using bot_ptb or config tokens.
  Imported by: users, main, shop/workers, admin_ptb.
  Controls: Sending messages to users and admin.

code/maintenance.py
  Purpose: Maintenance mode (is_maintenance_enabled, add_to_maintenance_queue, MAINTENANCE_MESSAGE).
  Imported by: users, shop/handlers, admin (create worker checks maintenance).
  Controls: Maintenance flag and queue.

code/admin_control.py
  Purpose: Controller bot logic for user's bot: /start, Run, Stop, status; submit_main_loop_job for stop_posting, emergency_stop_all, emergency_resume_all; delete bot flow.
  Imported by: users (create_user_bot registers handlers that may use admin_control or similar), admin_ptb (delete flow).
  Controls: User-facing controller bot commands and main loop job submission.

================================================================================
FORWARDING ENGINE DIAGNOSTIC
================================================================================

WHERE THE MAIN POSTING LOOP EXISTS
  - users.py _async_session_loop, inside the "for idx, g in enumerate(groups):" block (approx. lines 1846-2253). The loop body: cycle_end_ts check, stop_event check, posted_this_cycle check, group_cooldowns check, get_ban_skip check, FloodWait wait, session_gap_wait and final_wait sleep, get_entity (with_retry), forward_messages or send_message (with_retry), exception handling (FloodWaitGroupSkip, FloodWaitPause, MARK_SESSION_BANNED, SKIP_GROUP, permanent exclusion). After the for-loop, Starter deferred drain (while _pop_deferred_groups) then report_cycle_done and sleep until next_scheduled.

WHERE THE SESSION LOOP EXISTS
  - Same _async_session_loop. The outer "while True:" (approx. 1609-2478) is the session loop: heartbeat, get config, expiry/state/cooldown checks, cycle timing (next_cycle_time, delta_sec), sleep if delta_sec > 0, then one cycle (connect, assign groups, for g in groups post, report_cycle_done), then sleep until next_scheduled. So one session loop = while True { schedule; sleep to boundary; one cycle; report; sleep to next boundary }.

WHERE GROUP ITERATION HAPPENS
  - _async_session_loop, "for idx, g in enumerate(groups):" (line 1846). groups = assigned (Enterprise) or _combined (Starter). assigned from _assigned_groups_for_session at line 1742.

WHERE DELAY LOGIC HAPPENS
  - Same loop: scheduled_for = cycle_start + idx * effective_gap_cycle; session_gap_wait = max(0, scheduled_for - now) (with MAX_DRIFT_SEC); final_wait = max(global_wait, min(session_gap_wait, MAX_ALLOWED_DELAY_SEC), retry_wait); await asyncio.sleep(final_wait) (lines 1888-1895). Then post. So delay is one sleep per group before posting.

WHERE CYCLE WAITING HAPPENS
  - After the for-loop and report_cycle_done: next_scheduled = scheduled_run_ts + cycle_sec (line 2462); "while time.time() < next_scheduled: ... chunk = min(SCHEDULER_POLL_INTERVAL_SEC, heartbeat_interval, max(0.5, remaining)); await asyncio.sleep(chunk)" (lines 2470-2477). So cycle wait is at the end of each loop iteration.

WHY SESSIONS MIGHT SKIP GROUPS
  - (1) Session excluded: excluded_sessions (cycle_failed with 0 attempted, or admin); _assigned_groups_for_session returns [] so no groups. (2) Session paused: session_pause_until > now (FloodWait); returns []. (3) Enterprise and session not in active_session_files: returns []. (4) In-loop: group in posted_this_cycle (duplicate); group in group_cooldowns; get_ban_skip true; FloodWaitGroupSkip or FloodWaitPause skip. (5) cycle_end_ts: if time.time() >= cycle_end_ts the loop breaks so remaining groups are not posted this cycle (Enterprise no rollover; Starter rollover to pending_groups). (6) _parse_groups_file: if groups_dir or group_file wrong in worker config_snapshot, path may be wrong and return []. (7) active_session_files in Enterprise is computed from non-paused, non-excluded, non-cooldown; if config_patch is delayed or lost, worker might still have old active_list and get [].

WHY SESSIONS MIGHT POST INCONSISTENTLY
  - (1) effective_gap_cycle varies (decay, FloodWait slowdown) so spacing between posts changes. (2) Cycle boundary: if run_first_cycle_immediately only first cycle is immediate; next cycle is at anchor + cycle_sec. If anchor is set at start and workers start at different times (stagger), they still share same anchor so next_cycle_time can be in the past for a late-starting worker (delta_sec < 0) so it runs immediately; then next_scheduled = scheduled_run_ts + cycle_sec could be same for all, so next cycle alignment. But first cycle: first worker runs at now, second after stagger; so first cycle completion times differ. (3) get_config() in worker merges local_last_cycle and local_config_patch; if controller is slow to send config_patch (session_pause_until, active_session_files), worker may run one more cycle with stale config. (4) File IO: _parse_groups_file reads from disk each cycle; if file is missing or empty temporarily, assigned could be [].

WHY SESSIONS MIGHT STOP POSTING
  - (1) stop_event set (controller sent STOP). (2) No config: cfg is None (bot removed). (3) state not running/activating. (4) Expired: valid_till in the past, report_expired or _mark_bot_expired. (5) Session died: with_retry or handler raises/reports MARK_SESSION_BANNED, report_session_died, loop returns. (6) Connect failure: _connect_session_for_cycle fails, break and report_alert. (7) Worker process crash: process exits; controller health monitor may restart worker. (8) cycle_failed: if posts_attempted_cycle == 0, report_cycle_failed; controller adds session to excluded_sessions; next cycle _assigned_groups_for_session returns [] for that session so it does no posts again (cycle_failed again) until admin clears excluded_sessions or restarts.

WHY DELAY MIGHT BE INCORRECT
  - (1) final_wait is capped by MAX_ALLOWED_DELAY_SEC; if session_gap_wait is larger it is capped so delay is shorter than intended. (2) scheduled_for = cycle_start + idx * effective_gap_cycle uses cycle_start = time.time() at start of cycle (line 1843); if the cycle started late, cycle_start is late so scheduled_for for same idx is later; but now is already past cycle_start so session_gap_wait can be 0 or small. (3) effective_gap_cycle can be 0 if decay brought it below MIN_GAP_SEC and then max(MIN_GAP_SEC, ...) but the decay is effective_gap_cycle - 1 so it can go to MIN_GAP_SEC and stay. (4) Clock skew between controller and worker: worker uses time.time() locally so no cross-process clock issue for in-process delay; but cycle_anchor_ts is set on controller at _start_posting and passed in config_snapshot; worker uses it for next_cycle_time so if worker clock is behind, next_cycle_time could be in the future longer than intended.

CODE SMELLS
  - Blocking in async: _parse_groups_file does path.read_text() (blocking file IO) inside _assigned_groups_for_session which is called from async _async_session_loop; could block event loop briefly. Same for load_adbot in controller path (but worker uses get_config() which is in-memory). (2) Global shared state: _effective_gap_sec, _worker_last_activity, _worker_handles, _worker_result_queue, _pending_stop_cleanup, bot_runtime_state, etc. are module-level dicts; in multiprocessing only the controller process uses them; workers have their own process so no shared memory for those. (3) config_snapshot is built once at _start_posting and passed to workers; workers merge with local_last_cycle and local_config_patch; so updates (last_cycle_time, session_pause_until, active_session_files, excluded_groups) are pushed via config_patch. If result_queue is slow or handler drops a message, worker can run with stale config. (4) command_queue.get in worker is run in run_in_executor (command_listener) so it does not block the event loop. (5) result_queue.put in worker is synchronous; if controller is slow to get(), the put() can block (multiprocessing.Queue has a buffer). So long as controller _worker_result_handler_async keeps draining, this is ok. (6) Missing error recovery: if _async_session_loop raises an unhandled exception, the task dies; worker_main_async has await asyncio.gather(listener, *tasks) so exception propagates; worker process might exit. No per-task try/except around _async_session_loop in worker. (7) Debug logging to file 'debug-084dc5.log' in users.py (_assigned_groups_for_session, session_paused, config_patch) and workers.py (config_patch) is left in code; should be removed or gated.

================================================================================
CRITICAL BUGS FOUND
================================================================================

1. cycle_failed exclusion is permanent for the session until restart or admin clears excluded_sessions. If a session gets 0 groups once (e.g. all groups excluded for that session, or pause_until just expired after assignment run), it reports cycle_failed and is excluded; next cycle it gets [] again so it will always report cycle_failed. So one bad cycle can permanently disable the session until state is cleared.

2. Enterprise active_session_files: computed from non-paused, non-excluded, non-cooldown. When session_paused is applied, controller pushes config_patch with new active_session_files. If the worker has already started the cycle and called _assigned_groups_for_session with old get_config(), it might have already received a non-empty list; the patch applies for the next cycle. So no bug for "current" cycle. But if config_patch is lost (e.g. queue full or worker not reading), worker keeps old active_list and could get groups when it should be paused (Enterprise). Actually in Enterprise, assignment also checks session_pause_until > time.time() and returns [] so even with stale active_list, if pause_until is in config and get_config() returns it, assignment is []. So the risk is get_config() in worker merges local_config_patch; config_patch from controller updates local_config_patch. So worker should get updated pause and active list. No clear bug unless patch is never sent or worker ignores it.

3. run_first_cycle_immediately: on first run, next_cycle_time = now_ts so first cycle runs immediately. run_first_cycle_done is set so next iteration uses normal cycle boundary. But cycle_anchor_ts was set at _start_posting to time.time() on controller. So first cycle runs at worker's "now"; next_cycle_time for next iteration = cycle_anchor + cycle_index * cycle_sec. If worker started 5 minutes after anchor, cycle_index could be 0 still (if cycle_sec is 3600), so next_cycle_time = cycle_anchor (in the past), delta_sec < 0, so we don't sleep and run again. So second cycle runs immediately after first. Then cycle_index becomes 1, next_cycle_time = cycle_anchor + cycle_sec, which could be ~55 min from now; so we sleep. So actually the first two cycles can run back-to-back (first immediate, second because next_cycle_time is in the past). Code: "current_boundary = cycle_anchor + cycle_index * cycle_sec; next_cycle_time = current_boundary". After first cycle, scheduled_run_ts was now_ts (run_first_cycle_immediately). So next_scheduled = scheduled_run_ts + cycle_sec = first_run_time + cycle_sec. After sleep until next_scheduled, we go to top of loop; now_ts = time.time() ~= first_run_time + cycle_sec; cycle_index = (now_ts - cycle_anchor) // cycle_sec. If cycle_anchor was set at controller start and first_run_time was ~controller start + stagger, then now_ts after sleep is controller start + stagger + cycle_sec; cycle_index = 1. So next_cycle_time = cycle_anchor + cycle_sec. So we're aligned. The only oddity is run_first_cycle_immediately makes the first cycle run at "now" and then we sleep until next_scheduled = that now + cycle_sec. So no double immediate in normal case. If there were no sleep (e.g. cycle_sec very large and we break out of sleep due to stop_event), next iteration would have now_ts still near first run, cycle_index 0, next_cycle_time = cycle_anchor (past), so we'd run again. So only if sleep is skipped.

4. _apply_worker_result cycle_done: when updating last_cycle_time it also conditionally clears session_pause_until for that session if pause_ts <= time.time(). Comment says "a session that just hit FloodWait sends cycle_done immediately after session_paused - clearing a still-active pause here would corrupt active_session_files (BUG-1 fix)." So they only clear if already expired. Good.

5. Worker restart (_restart_single_worker): config_snapshot is built with run_first_cycle_immediately not set (preserve_cycle_time path is not used in restart; actually restart passes bot_token to _build_worker_config_snapshot but the third arg is run_first_cycle_immediately; in _restart_single_worker the call is _build_worker_config_snapshot(cfg, total_sessions, bot_token=bot_token) so run_first_cycle_immediately is default False). So restarted worker does not run first cycle immediately; it will wait until next boundary. Good for not double-posting.

6. create_user_bot is called from result_consumer after create; it only starts the Telethon client for the user's bot. It does not call _start_posting. So after purchase, the user must open their bot and click Run to start posting. If the UI is "your bot is ready" without explicit "click Run", users might think posting started automatically. Design choice, not a bug.

7. _start_posting clears session_pause_until and excluded_sessions on start (when not preserve_cycle_time). So after Stop -> Start, paused and excluded state is reset. So cycle_failed-excluded session gets another chance. Good.

================================================================================
RACE CONDITIONS FOUND
================================================================================

1. load_adbot in controller vs save_user_data in _apply_worker_result: multiple results (cycle_done, session_paused, post_attempt) can be applied in sequence; each _save_bot_config does load_user_data (in save_user_data merge), update, write. So two concurrent _apply_worker_result calls could interleave (but _worker_result_handler_async is a single task that gets one msg at a time and applies it; so no concurrent apply). So no race in handler. But main loop job consumer (delete_bot, expire_bot, stop_posting) can call _stop_posting and _save_bot_config from same loop; and result handler also calls _save_bot_config. So two tasks can call _save_bot_config for the same bot_token: one from job consumer (e.g. expire_bot -> _stop_posting, expire_bot_return_sessions_to_pool), one from result handler. save_user_data uses file lock and merge (read-modify-write). So the last write wins; if result handler writes after job consumer, cycle_done might restore state that expire_bot just cleared. So race: expire_bot clears bot from storage and returns sessions to pool; simultaneously cycle_done for that bot updates last_cycle_time. The order depends on scheduling. Usually expire_bot will have stopped posting first so workers are exiting and maybe no more cycle_done. But if a cycle_done is in the queue, it could be applied after delete and then we're updating a user file that may already be deleted (expire_bot deletes user file). So _apply_worker_result should check that the bot still exists (e.g. get_name_by_token(bot_token)) before updating. Partial mitigation: expire_bot calls _stop_posting so workers get STOP; they may still push one more cycle_done before exiting. So cycle_done after expire could try to save_user_data(name, upd); if name was already deleted, save_user_data would write a new file (name_to_filename from cfg["name"]). So we could recreate a deleted bot's file. Bug.

2. creation_pool_lock and load_adbot in create worker: only one create job runs at a time per lock; adbot_data = load_adbot() inside lock; so no concurrent create. Good.

3. _worker_handles and workers_list: updated in _start_posting (set) and _stop_posting (pop). Only main loop tasks touch these. So single-threaded for that. But _apply_worker_result reads _worker_handles.get(bot_token) to send config_patch. If _stop_posting just popped _worker_handles[bot_token], result handler might still have a reference to the old list and send patch to old cmd_queues. So after stop, a few result messages might still be applied and try to send config_patch; the queues might still be valid until processes exit. So low risk.

================================================================================
TIMING ISSUES FOUND
================================================================================

1. Stagger: Starter uses (STAGGER_WINDOW_SEC / total_sessions) * global_ordinal so sessions spread over 1 hour. Enterprise: first half stagger 0, second half ENTERPRISE_STAGGER_SEC (300). So Enterprise second-half sessions start 5 min later. If cycle_sec is 3600, first cycle for second half runs at anchor + 0 (they wait 5 min then run) so their first next_cycle_time could be cycle_anchor (same as first half). So all sessions align to same boundary after first cycle. Ok.

2. Scheduler poll: SCHEDULER_POLL_INTERVAL_SEC is used as chunk for sleep when waiting for next_cycle_time or pause_until. So we wake up every N seconds to check stop_event and heartbeat. If N is large, shutdown or stop can be delayed. Default not seen in snippet; likely 60 or 30.

3. Worker heartbeat: health monitor checks _worker_last_heartbeat; workers send heartbeat via report_heartbeat which puts on result_queue. So heartbeat is async (queued). If result_queue is slow, controller might think worker is dead and restart it. So queue congestion can cause false restarts.

4. Cycle anchor: Set once at _start_posting. If system clock is adjusted (NTP) during run, cycle_anchor_ts is still the old value so boundaries drift. No NTP handling.

================================================================================
DESIGN FLAWS
================================================================================

1. Single _worker_result_handler_async for all bots: one queue, one task. If handling one message is slow (e.g. save_user_data blocks on file lock), other bots' results are delayed. So config_patch can be delayed for all bots.

2. config_snapshot is built at _start_posting and passed to workers; groups_dir is str(config.GROUPS_DIR). Workers run in separate processes so they inherit no in-memory state; they get groups_dir and group_file and read from disk. So if GROUPS_DIR is relative and worker cwd differs, path could be wrong. config.py uses BASE_DIR = Path(__file__).resolve().parent.parent so it's absolute. So groups_dir is absolute. Ok.

3. Per-session cycle_failed exclusion: once excluded, session never gets groups until Start is pressed again (which clears excluded_sessions). So a single 0-post cycle (e.g. all groups banned for that session, or transient) permanently disables the session. Design could be: exclude only after N consecutive 0-post cycles, or timeout exclusion.

4. No backpressure on result_queue: workers put without size limit (multiprocessing.Queue has a buffer). If controller is slow, queue grows. No drop or backpressure.

5. create_user_bot is started as asyncio.create_task in result_consumer. So many bots can be created in parallel; each runs a Telethon client.run_until_disconnected() in that task. So we have one long-running task per user bot. If 100 bots, 100 tasks. All in same event loop. So 100 Telethon clients in one process. Might be a scalability limit.

6. Log queue _log_queue: bounded 500. enqueue_log put_nowait; if full, drop. So under load, log messages can be lost. Design: drop is intentional to not block posting.

================================================================================
RECOMMENDED ARCHITECTURE IMPROVEMENTS
================================================================================

1. In _apply_worker_result, before any save_user_data or config update for a bot, check that the bot still exists (e.g. load_adbot()["bots"].get(bot_token) or get_name_by_token(bot_token)). If bot was just deleted/expired, skip applying cycle_done/session_paused/post_attempt for that bot to avoid recreating deleted user file or writing to stale state.

2. Consider making cycle_failed exclusion soft: e.g. exclude only after 2 or 3 consecutive cycles with 0 attempted, or add a timeout (e.g. clear excluded_sessions for a session after 1 hour) so transient issues (e.g. all groups temporarily in cooldown) do not permanently disable the session.

3. Move _parse_groups_file (file read) to asyncio.to_thread in the worker so the session loop never blocks on disk IO. Alternatively cache the group list in config_snapshot and push updates via config_patch when group file changes (complex).

4. Remove or gate debug writes to debug-084dc5.log (and workers.py debug log) behind a env flag or remove before production.

5. Consider a dedicated result handler per bot or a pool of handler tasks to reduce head-of-line blocking in result processing.

6. Document for operators: after purchase, user must open their controller bot and press Run to start posting; posting does not start automatically.

7. Consider validating that worker and controller share the same cycle_anchor_ts semantics (e.g. log cycle_index and next_cycle_time on first run after restart to confirm alignment).

8. Add integration test: start one bot with one session and one group, trigger one cycle, assert one post and one cycle_done; then stop and assert clean shutdown and no orphan state.

ERRORS REFERENCE
  - See docs/ERRORS_REFERENCE.md for: PersistentTimestampOutdatedError, HistoryGetFailedError,
    "Task was destroyed but it is pending", "database is locked", MsgidDecreaseRetryError,
    SpamBot/anti-spam, connection closed. Summary: Telegram "internal issues" = server-side,
    wait or single restart; database locked = one process per session + delay after disconnect;
    pending tasks = shutdown/cleanup timing, 0.5s delay after client.disconnect() in session
    loop helps.

END OF REPORT
