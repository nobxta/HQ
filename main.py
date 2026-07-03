"""Single entry point: starts admin bot and resumes user bots. Run with: python main.py
Kill process and rerun to test crash resume (running bots and posting workers resume from per-user storage).
On Ctrl+C: stop all posting workers, disconnect all sessions, so no .session-journal is left.

Architecture: Controller (main process) runs admin bot, log consumer, health monitor. Posting runs in
multiprocessing workers: each worker process has its own asyncio loop and handles 1 session.
Workers do not write storage; controller applies worker results (cycle_done, session_died, etc.).
"""
# Load .env at the very beginning, before any project imports (so NOWPAYMENTS_API_KEY etc. are set)
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

import asyncio
import json
import logging
import multiprocessing
import os
import time
import warnings

from code import config
from code.admin_ptb import (
    run_admin_bot_ptb,
    _alert_forward_loop_ptb,
    _daily_report_loop_ptb,
    _result_consumer_ptb,
    _main_loop_job_queue,
    _admin_ptb_running,
)
from code import notify
from code.crash import resume_adbots
from code.shop.handlers import start_shop_bot_thread
from code.shop.workers import (
    payment_polling_worker,
    payment_safety_sweep,
    renewal_scheduler_worker,
    order_recovery_on_startup,
    daily_orders_cleanup_worker,
    daily_supported_currencies_sync_worker,
    run_payment_reconciliation,
    PAYMENT_HEARTBEAT_PATH,
    WATCHDOG_STALE_SEC,
)
from code.shop.payment import validate_payment_config, fetch_supported_currencies, _startup_nowpayments_test

logger = logging.getLogger(__name__)

# Worker watchdog: restart payment/create workers if heartbeat > 15 min. Holder allows watchdog to replace task.
_payment_task_holder = [None]  # [asyncio.Task]
# Strong reference to admin bot task so it is not GC'd while pending ("Task was destroyed but it is pending").
_admin_task_holder = [None]  # [asyncio.Task]
WATCHDOG_CHECK_INTERVAL_SEC = 300  # 5 minutes

# Suppress Telethon "session already had an authorized user" when starting with bot_token (we use unique path per token to avoid reuse)
warnings.filterwarnings(
    "ignore",
    message=".*session already had an authorized user.*",
    category=UserWarning,
    module="telethon.client.auth",
)

# Skip unknown TL constructor IDs in recv loop so bot stays up when Telegram sends new types (e.g. 0x05A0E7FA)
from code.telethon_compat import apply_telethon_unknown_type_patch
apply_telethon_unknown_type_patch()


def _clean_stale_session_journals() -> None:
    """Remove leftover .session-journal files from sessions/active/ (from previous unclean exit)."""
    try:
        for p in config.SESSIONS_ACTIVE.iterdir():
            if p.is_file() and p.suffix.lower() == ".session-journal":
                try:
                    p.unlink()
                    logger.info("Removed stale session journal: %s", p.name)
                except OSError:
                    pass
    except OSError:
        pass


def _clean_stale_userbot_sessions() -> None:
    """Remove session files in sessions/userbot/ whose bot token is no longer configured.
    Each file is named bot_<sha256_prefix>.session; we check if any configured bot token
    maps to that fingerprint. If not, the file is stale and safe to delete."""
    import hashlib
    from code.utils import load_adbot
    userbot_dir = config.SESSIONS_DIR / "userbot"
    if not userbot_dir.is_dir():
        return
    data = load_adbot()
    # Build set of active fingerprints from all configured bot tokens
    active_fingerprints: set[str] = set()
    for bot_token in data.get("bots", {}):
        fp = hashlib.sha256(bot_token.encode()).hexdigest()[:16]
        active_fingerprints.add(f"bot_{fp}")
    # Also include admin bot token
    admin_token = (config.ADMIN_BOT_TOKEN or "").strip()
    if admin_token:
        fp = hashlib.sha256(admin_token.encode()).hexdigest()[:16]
        active_fingerprints.add(f"bot_{fp}")
    removed = 0
    try:
        for p in userbot_dir.iterdir():
            if not p.is_file():
                continue
            stem = p.stem  # e.g. "bot_f3d7d3ef020229fc"
            if stem not in active_fingerprints:
                try:
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
    except OSError:
        pass
    if removed:
        logger.info("Cleaned %d stale userbot session file(s)", removed)


def _read_heartbeat_ts(path) -> float | None:
    """Return timestamp from heartbeat JSON file or None if missing/invalid."""
    try:
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return float(data.get("ts", 0) or 0)
    except Exception:
        return None


async def _daily_session_integrity_and_reconciliation() -> None:
    """Once per day: session ownership integrity scan and payment reconciliation (paid but no bot after X min)."""
    while True:
        await asyncio.sleep(86400)  # 24h
        try:
            from code.utils import run_session_ownership_integrity_scan
            report = await asyncio.to_thread(run_session_ownership_integrity_scan)
            if report.get("duplicates_removed") or report.get("orphans_returned"):
                logger.info("Session integrity scan: %s", report)
            count = await run_payment_reconciliation()
            if count:
                logger.info("Payment reconciliation: re-queued %s order(s)", count)
        except Exception as e:
            logger.warning("Daily session/reconciliation error: %s", e)


SPAMBOT_CHECK_INTERVAL_SEC = 48 * 3600  # 48 hours


async def _periodic_spambot_health_check() -> None:
    """Every 48 hours: run SpamBot check on all assigned sessions.
    Only act on results: FROZEN -> move to frozen/, DEAD errors -> move to dead/, ACTIVE -> no action.
    Do NOT act on LIMITED (user requested: leave limited sessions alone)."""
    import shutil
    from code.utils import load_pool, save_pool, load_adbot, add_admin_alert, get_name_by_token, load_user_data, save_user_data
    from code.repair import check_sessions_health_parallel, SPAM_FROZEN, SPAM_ACTIVE, SPAM_UNKNOWN
    await asyncio.sleep(SPAMBOT_CHECK_INTERVAL_SEC)  # first run after 48h
    while True:
        try:
            logger.info("[SpamBot Health] Starting 48h SpamBot health check")
            adbot = load_adbot()
            # Collect all assigned session files
            assigned_files: list[str] = []
            for token, cfg in adbot.get("bots", {}).items():
                for s in cfg.get("sessions", []):
                    fn = (s.get("file") or "").strip()
                    if fn:
                        assigned_files.append(fn)
            # Also check free sessions
            pool = load_pool()
            free_files = list(pool.get("free_sessions", []))
            all_files = list(set(assigned_files + free_files))
            if not all_files:
                logger.info("[SpamBot Health] No sessions to check")
            else:
                results = await check_sessions_health_parallel(all_files)
                frozen_count = 0
                for fn, status in results.items():
                    if status == SPAM_FROZEN:
                        # Move to frozen
                        frozen_count += 1
                        logger.warning("[SpamBot Health] Session %s is FROZEN — moving to frozen/", fn)
                        # Remove from assigned bot if applicable
                        adbot = load_adbot()
                        for token, cfg in adbot.get("bots", {}).items():
                            sess_files = [s.get("file") for s in cfg.get("sessions", [])]
                            if fn in sess_files:
                                cfg["sessions"] = [s for s in cfg["sessions"] if s.get("file") != fn]
                                name = get_name_by_token(token)
                                if name:
                                    save_user_data(name, cfg)
                                break
                        # Update pool
                        pool = load_pool()
                        for bk in ("free_sessions", "dead_sessions", "frozen_sessions", "limited_sessions", "unauth_sessions"):
                            pool[bk] = [x for x in pool.get(bk, []) if x != fn]
                        pool.setdefault("frozen_sessions", [])
                        if fn not in pool["frozen_sessions"]:
                            pool["frozen_sessions"].append(fn)
                        save_pool(pool)
                        # Move file
                        src = config.SESSIONS_ACTIVE / fn
                        if src.is_file():
                            try:
                                shutil.move(str(src), str(config.SESSIONS_FROZEN / fn))
                            except OSError as e:
                                logger.warning("[SpamBot Health] Move %s to frozen failed: %s", fn, e)
                        add_admin_alert("spambot_health", f"Session {fn} is FROZEN (SpamBot). Moved to frozen/.")
                    # ACTIVE or UNKNOWN: no action
                    # LIMITED: no action (user requested)
                if frozen_count:
                    logger.info("[SpamBot Health] Completed: %d session(s) moved to frozen", frozen_count)
                else:
                    logger.info("[SpamBot Health] Completed: all sessions OK")
        except Exception as e:
            logger.warning("[SpamBot Health] Error: %s", e)
        await asyncio.sleep(SPAMBOT_CHECK_INTERVAL_SEC)


async def _worker_watchdog_loop() -> None:
    """If payment or create worker heartbeat > 15 min, restart worker and alert admin."""
    from code.utils import add_admin_alert
    from code.admin import request_create_worker_restart, _start_create_worker_if_needed, CREATE_HEARTBEAT_PATH, CREATE_WATCHDOG_STALE_SEC
    while True:
        try:
            await asyncio.sleep(WATCHDOG_CHECK_INTERVAL_SEC)
            now = time.time()
            if config.PAYMENT_POLLING_ENABLED and config.SHOP_BOT_TOKEN and PAYMENT_HEARTBEAT_PATH.exists():
                ts = _read_heartbeat_ts(PAYMENT_HEARTBEAT_PATH)
                if ts is not None and (now - ts) > WATCHDOG_STALE_SEC:
                    task = _payment_task_holder[0]
                    if task and not task.done():
                        logger.warning("Payment worker heartbeat stale (%.0f min); restarting", (now - ts) / 60)
                        task.cancel()
                        try:
                            await asyncio.wait_for(asyncio.shield(task), timeout=10.0)
                        except (asyncio.CancelledError, asyncio.TimeoutError):
                            pass
                    _payment_task_holder[0] = asyncio.create_task(payment_polling_worker())
                    add_admin_alert("worker_restart", "Payment polling worker was restarted (heartbeat was stale).")
            if CREATE_HEARTBEAT_PATH.exists():
                ts = _read_heartbeat_ts(CREATE_HEARTBEAT_PATH)
                if ts is not None and (now - ts) > CREATE_WATCHDOG_STALE_SEC:
                    logger.warning("Create worker heartbeat stale (%.0f min); restarting threads", (now - ts) / 60)
                    await asyncio.to_thread(request_create_worker_restart)
                    _start_create_worker_if_needed()
                    add_admin_alert("worker_restart", "Create worker threads were restarted (heartbeat was stale).")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Worker watchdog error: %s", e)


def _asyncio_exception_handler(loop: object, ctx: dict) -> None:
    """Log unhandled asyncio exceptions with task name so logs show which coroutine failed (e.g. run_admin_bot_ptb)."""
    exc = ctx.get("exception")
    task = ctx.get("task")
    task_name = task.get_name() if task and getattr(task, "get_name", None) else (repr(task) if task else "?")
    message = ctx.get("message", "Exception in async task")
    logger.exception("asyncio unhandled [task=%s]: %s", task_name, message, exc_info=exc)


async def main() -> None:
    config.setup_logging()
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(_asyncio_exception_handler)
    logger.info("Starting AdBot system")

    _clean_stale_session_journals()
    _clean_stale_userbot_sessions()

    from code.utils import load_adbot, discover_local_sessions, get_shutdown_clients
    from code.users import _stop_posting, _log_queue_consumer, run_session_health_monitor, await_all_pending_stop_cleanup, _stats_flush_loop, _drift_check_loop, _user_log_flush_loop

    data = load_adbot()

    # Discover .session files in sessions/active/ that aren't in pool yet; add to free_sessions
    discover_local_sessions(data)
    data = load_adbot()

    # Control-plane: start all notification/create-job consumers from main (no Telethon admin dependency)
    # No startup validation here — validation runs only when creating AdBot, replacing a session, or when user starts their AdBot
    # Keep strong reference to admin task so it is not GC'd while pending
    _admin_task_holder[0] = asyncio.create_task(run_admin_bot_ptb(), name="run_admin_bot_ptb")
    asyncio.create_task(_log_queue_consumer(), name="_log_queue_consumer")
    asyncio.create_task(_alert_forward_loop_ptb(), name="alert_forward_loop_ptb")
    asyncio.create_task(_daily_report_loop_ptb(), name="daily_report_loop_ptb")
    asyncio.create_task(_result_consumer_ptb(), name="result_consumer_ptb")
    asyncio.create_task(run_session_health_monitor(), name="run_session_health_monitor")
    asyncio.create_task(_stats_flush_loop(), name="_stats_flush_loop")
    asyncio.create_task(_drift_check_loop(), name="_drift_check_loop")
    asyncio.create_task(_user_log_flush_loop(), name="_user_log_flush_loop")
    # Shop Bot: validate payment config (raises if production and NOWPAYMENTS_API_KEY missing)
    if config.SHOP_BOT_TOKEN:
        validate_payment_config()
        try:
            _startup_nowpayments_test()
        except Exception:
            pass
        # One-time fetch of supported currencies so validation works before first daily sync
        async def _fetch_currencies_once() -> None:
            try:
                await asyncio.to_thread(fetch_supported_currencies)
            except Exception:
                pass
        asyncio.create_task(_fetch_currencies_once())
    # Shop Bot: order recovery (once), payment polling, renewal scheduler, daily cleanup, currencies sync
    asyncio.create_task(order_recovery_on_startup(), name="order_recovery_on_startup")
    if config.PAYMENT_POLLING_ENABLED:
        _payment_task_holder[0] = asyncio.create_task(payment_polling_worker(), name="payment_polling_worker")
    else:
        logger.info("Payment polling disabled (webhook-only). Set PAYMENT_POLLING=1 to re-enable the fallback worker.")
        asyncio.create_task(payment_safety_sweep(), name="payment_safety_sweep")
    asyncio.create_task(renewal_scheduler_worker(), name="renewal_scheduler_worker")
    asyncio.create_task(daily_orders_cleanup_worker(), name="daily_orders_cleanup_worker")
    asyncio.create_task(daily_supported_currencies_sync_worker(), name="daily_supported_currencies_sync_worker")
    asyncio.create_task(_worker_watchdog_loop(), name="_worker_watchdog_loop")
    asyncio.create_task(_daily_session_integrity_and_reconciliation(), name="_daily_session_integrity_and_reconciliation")
    asyncio.create_task(_periodic_spambot_health_check(), name="_periodic_spambot_health_check")
    start_shop_bot_thread()

    async def _main_loop_job_consumer() -> None:
        """Run jobs that must execute on the main loop (e.g. delete_bot, expire_bot).
        Never call application.shutdown/stop or request.shutdown here; guard PTB sends with _admin_ptb_running()."""
        from code.users import disconnect_and_remove_controller_bot, _stop_posting, _start_posting
        from code.utils import delete_bot_from_storage, expire_bot_return_sessions_to_pool, get_name_by_token, load_user_data
        from telegram.helpers import escape_markdown
        while True:
            try:
                job_type, payload = await asyncio.to_thread(_main_loop_job_queue.get)
            except Exception:
                break
            if job_type == "delete_bot":
                bot_token, chat_id, msg_id, move_to, name = payload
                try:
                    await _stop_posting(bot_token)
                    await asyncio.sleep(1)
                    await disconnect_and_remove_controller_bot(bot_token)
                    await delete_bot_from_storage(bot_token, move_to)
                    if _admin_ptb_running():
                        name_esc = escape_markdown(str(name), version=2)
                        pool_esc = escape_markdown("free" if move_to == "free" else "dead", version=2)
                        text = f"Deleted *{name_esc}*\\. Sessions moved to {pool_esc} pool\\."
                        await notify.notify_edit_admin_message(chat_id, msg_id, text, parse_mode="MarkdownV2")
                except Exception as e:
                    logger.exception("delete_bot job failed: %s", e)
                    if _admin_ptb_running():
                        try:
                            await notify.notify_edit_admin_message(
                                chat_id, msg_id, f"Delete failed: {escape_markdown(str(e), version=2)}", parse_mode="MarkdownV2"
                            )
                        except Exception:
                            pass
            elif job_type == "expire_bot":
                (bot_token,) = payload
                try:
                    name = get_name_by_token(bot_token)
                    cfg = load_user_data(name) if name else {}
                    name_display = (cfg.get("name") or bot_token[:20]) if cfg else bot_token[:20]
                    await _stop_posting(bot_token)
                    await asyncio.sleep(1)
                    await disconnect_and_remove_controller_bot(bot_token)
                    returned, dead = await expire_bot_return_sessions_to_pool(bot_token)
                    msg = f"AdBot expired: {name_display}. Sessions returned: {returned}. Sessions dead: {dead}."
                    if _admin_ptb_running():
                        notify.notify_admin("bot_expired", msg)
                except Exception as e:
                    logger.exception("expire_bot job failed: %s", e)
                    if _admin_ptb_running():
                        notify.notify_admin("bot_expired", f"AdBot expiry failed: {e}")
            elif job_type == "stop_posting":
                (bot_token,) = payload
                try:
                    await _stop_posting(bot_token)
                except Exception as e:
                    logger.exception("stop_posting job failed: %s", e)
            elif job_type == "emergency_stop_all":
                running_tokens, admin_id = payload[0], (payload[1] if len(payload) > 1 else None)
                from code.admin_control import EMERGENCY_STOPPED_FILE
                from code.audit import log_admin_action
                stopped = []
                for token in running_tokens:
                    try:
                        await _stop_posting(token)
                        stopped.append(token)
                    except Exception as e:
                        logger.warning("Emergency stop %s: %s", token[:15], e)
                if stopped:
                    import json
                    from datetime import datetime, timezone
                    EMERGENCY_STOPPED_FILE.parent.mkdir(parents=True, exist_ok=True)
                    EMERGENCY_STOPPED_FILE.write_text(
                        json.dumps({"tokens": stopped, "at": datetime.now(timezone.utc).isoformat()}, indent=2),
                        encoding="utf-8",
                    )
                log_admin_action(admin_id or "main_loop", "emergency_stop", target=f"{len(stopped)} bots", count=len(stopped))
                if _admin_ptb_running():
                    notify.notify_admin("emergency_stop", f"Emergency stop complete. Stopped {len(stopped)} bot(s).")
            elif job_type == "emergency_resume_all":
                tokens = payload[0]
                admin_id = payload[1] if len(payload) > 1 else None
                from code.users import _start_posting, cleanup_active_sessions_for_bot
                from code.admin_control import EMERGENCY_STOPPED_FILE
                from code.audit import log_admin_action
                started = 0
                for token in tokens:
                    try:
                        cleanup_active_sessions_for_bot(token)
                        await _start_posting(token)
                        started += 1
                    except Exception as e:
                        logger.warning("Emergency resume %s: %s", token[:15], e)
                try:
                    EMERGENCY_STOPPED_FILE.write_text(json.dumps({"tokens": [], "at": ""}, indent=2), encoding="utf-8")
                except Exception:
                    pass
                log_admin_action(admin_id or "main_loop", "emergency_resume", target=f"{started} bots", count=started)
                if _admin_ptb_running():
                    notify.notify_admin("emergency_resume", f"Emergency resume complete. Started {started} bot(s).")
            elif job_type == "restart_bot":
                (bot_token,) = payload
                try:
                    await _stop_posting(bot_token)
                    await asyncio.sleep(2)
                    from code.users import cleanup_active_sessions_for_bot as _cleanup_active_sessions_for_bot
                    _cleanup_active_sessions_for_bot(bot_token)
                    await _start_posting(bot_token)
                except Exception as e:
                    logger.exception("restart_bot job failed: %s", e)

    asyncio.create_task(_main_loop_job_consumer(), name="_main_loop_job_consumer")
    await resume_adbots(data)

    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    finally:
        # Cancel all pending tasks first so we don't get "Task was destroyed but it is pending"
        current = asyncio.current_task()
        pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            try:
                await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), timeout=15.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            for t in pending:
                if not t.done():
                    logger.debug("Shutdown: task %s did not finish in time", getattr(t, "get_name", lambda: str(t))())
        logger.info("Shutting down: stopping posting and disconnecting all sessions…")
        data = load_adbot()
        for bot_token in data.get("bots", {}):
            try:
                await _stop_posting(bot_token)
            except Exception:
                pass
        await await_all_pending_stop_cleanup()
        await asyncio.sleep(0.5)
        for client in get_shutdown_clients():
            try:
                await client.disconnect()
            except Exception:
                pass
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    _enable_api = os.getenv("ENABLE_WEB_API", "1").strip().lower() in ("1", "true", "yes")

    if _enable_api:
        # Auto-start the Cloudflare Tunnel (api.hqadz.io). Fail-open: never blocks the API.
        try:
            import tunnel
            tunnel.start()
        except Exception as _tunnel_exc:
            print(f"[tunnel] startup skipped: {_tunnel_exc}", flush=True)

        import uvicorn
        from api.app import app as _fastapi_app
        from api.utils import get_api_port, get_api_host

        _api_port = get_api_port()
        _api_host = get_api_host()

        _uvicorn_config = uvicorn.Config(
            app=_fastapi_app,
            host=_api_host,
            port=_api_port,
            log_level="info",
            access_log=False,
            ws_max_size=16 * 1024 * 1024,
        )
        _uvicorn_server = uvicorn.Server(_uvicorn_config)

        async def _run_combined():
            bot_task = asyncio.create_task(main(), name="bot_system")
            api_task = asyncio.create_task(_uvicorn_server.serve(), name="api_server")
            try:
                import tunnel as _tunnel_mod
                asyncio.create_task(_tunnel_mod.watchdog_loop(), name="tunnel_watchdog")
            except Exception as _tw_exc:
                logger.warning("tunnel watchdog not started: %s", _tw_exc)
            logger.info("Web API started on http://%s:%d/api/docs", _api_host, _api_port)
            try:
                await asyncio.gather(bot_task, api_task)
            except (KeyboardInterrupt, asyncio.CancelledError):
                pass
            finally:
                _uvicorn_server.should_exit = True
                bot_task.cancel()
                try:
                    await asyncio.wait_for(bot_task, timeout=15.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass

        try:
            asyncio.run(_run_combined())
        except KeyboardInterrupt:
            pass
    else:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            pass
