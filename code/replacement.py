"""
Session replacement system: auto-detect failing sessions, queue replacements,
handle free/paid replacement flows, and process the queue when sessions are available.
"""
import asyncio
import json
import logging
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from . import config
from .repair import (
    SPAM_ACTIVE,
    SPAM_FROZEN,
    SPAM_HARD_LIMITED,
    SPAM_TEMP_LIMITED,
    check_sessions_health_parallel,
    repair_replace_session,
)
from .utils import (
    add_admin_alert,
    get_name_by_token,
    load_pool,
    load_user_data,
    save_pool,
    save_user_data,
)

logger = logging.getLogger(__name__)

_queue_lock = threading.Lock()

FAILURE_THRESHOLD = 0.90
MIN_CYCLES_BEFORE_CHECK = 3
CHECK_COOLDOWN_SEC = 1800


def _notify_user(entry: dict, event: str, **kw):
    """Send a portal notification to the bot owner."""
    try:
        from api.routers.user_portal import add_portal_notification
        bot_name = entry.get("bot_name", "")
        real_name = (entry.get("real_name") or entry.get("session_file", "")).replace(".session", "")
        if event == "replaced":
            new_file = kw.get("new_file", "").replace(".session", "")
            add_portal_notification(
                bot_name,
                title="Session Replaced ✓",
                message=f"{real_name} was replaced with {new_file}. The new session is live and working.",
                type="success",
                icon="swap",
            )
        elif event == "queued":
            add_portal_notification(
                bot_name,
                title="Replacement Queued",
                message=f"{real_name} is queued for replacement but no sessions are available right now. Admin has been notified.",
                type="warning",
                icon="clock",
            )
        elif event == "failed":
            error = kw.get("error", "Unknown error")
            add_portal_notification(
                bot_name,
                title="Replacement Failed",
                message=f"Could not replace {real_name}: {error}. It will be retried when sessions are available.",
                type="error",
                icon="alert",
            )
    except Exception as exc:
        logger.warning("Failed to send portal notification: %s", exc)


def _queue_path() -> Path:
    return config.DATA_REPLACEMENT_QUEUE_FILE


def load_replacement_queue() -> list[dict[str, Any]]:
    path = _queue_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "queue" in data:
            return list(data["queue"])
        return []
    except Exception as e:
        logger.warning("Could not load replacement queue: %s", e)
        return []


def save_replacement_queue(queue: list[dict[str, Any]]) -> None:
    path = _queue_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(queue, indent=2), encoding="utf-8")


def _get_admin_settings() -> dict:
    path = Path(__file__).resolve().parent.parent / "data" / "admin_settings.json"
    if path.is_file():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            pass
    return {}


def get_session_replacement_price() -> float:
    settings = _get_admin_settings()
    return float(settings.get("session_replacement_price", 2.0))


def get_free_replacements_for_bot(cfg: dict) -> tuple[int, int]:
    """Return (free_replacements_limit, replacements_used) for a bot."""
    limit = int(cfg.get("free_replacements_limit", 0))
    used = int(cfg.get("replacements_used", 0))
    return limit, used


def get_free_replacements_remaining(cfg: dict) -> int:
    limit, used = get_free_replacements_for_bot(cfg)
    if limit < 0:
        return 999
    return max(0, limit - used)


def _reset_free_replacements_on_renewal(cfg: dict, plan: dict) -> None:
    """Called when a bot renews — reset the free replacement counter."""
    cfg["free_replacements_limit"] = int(plan.get("free_replacements", 0))
    cfg["replacements_used"] = 0


def detect_failing_sessions(bot_token: str, *, for_display: bool = False) -> list[dict[str, Any]]:
    """Check stats for sessions with >= 90% failure rate.

    Detection triggers when EITHER:
    - Last cycle failure rate >= 90% with <=1 success, OR
    - Lifetime failure rate >= 90% (persistent bad session)

    Args:
        bot_token: The bot's token.
        for_display: If True, skip the health-check cooldown so the portal
                     can always show current failing sessions on login.

    Returns list of {session_file, failure_rate, cycles, last_cycle_attempted, …}.
    """
    from .utils import load_stats
    name = get_name_by_token(bot_token)
    if not name:
        return []
    cfg = load_user_data(name)
    if not cfg:
        return []
    st = load_stats(name)
    if not st or not isinstance(st, dict):
        return []
    session_stats = st.get("session_stats", {})
    failing = []
    now = time.time()
    for s in cfg.get("sessions", []):
        fn = s.get("file")
        if not fn:
            continue
        ss = session_stats.get(fn, {})
        cycles = int(ss.get("cycles", 0))
        if cycles < MIN_CYCLES_BEFORE_CHECK:
            continue
        # Skip cooldown check when serving portal display
        if not for_display:
            last_check = float(ss.get("_last_health_check_ts", 0))
            if now - last_check < CHECK_COOLDOWN_SEC:
                continue

        # --- Last cycle check ---
        attempted = int(ss.get("last_cycle_attempted", 0))
        failed = int(ss.get("last_cycle_failed", 0))
        success = int(ss.get("last_cycle_success", 0))
        last_cycle_failing = (
            attempted > 0
            and (failed / attempted) >= FAILURE_THRESHOLD
            and success <= 1
        )

        # --- Lifetime check ---
        lt_sent = int(ss.get("lifetime_sent", 0))
        lt_failed = int(ss.get("lifetime_failed", 0))
        lt_total = lt_sent + lt_failed
        lifetime_failing = (
            lt_total >= 10
            and (lt_failed / lt_total) >= FAILURE_THRESHOLD
        )

        if last_cycle_failing or lifetime_failing:
            # Pick the more severe rate for display
            last_rate = (failed / attempted) if attempted > 0 else 0
            life_rate = (lt_failed / lt_total) if lt_total > 0 else 0
            display_rate = max(last_rate, life_rate)
            failing.append({
                "session_file": fn,
                "failure_rate": round(display_rate, 2),
                "cycles": cycles,
                "last_cycle_attempted": attempted,
                "last_cycle_failed": failed,
                "last_cycle_success": success,
                "lifetime_sent": lt_sent,
                "lifetime_failed": lt_failed,
                "real_name": s.get("real_name", fn),
                "user_id": s.get("user_id"),
                "spam_status": ss.get("_last_spam_status", ""),
            })
    return failing


async def check_and_flag_failing_sessions(bot_token: str) -> list[dict[str, Any]]:
    """Detect failing sessions, run SpamBot check, return those that are frozen/limited."""
    failing = detect_failing_sessions(bot_token)
    if not failing:
        return []
    files = [f["session_file"] for f in failing]
    statuses = await check_sessions_health_parallel(files)
    flagged = []
    name = get_name_by_token(bot_token)
    if not name:
        return []
    from .utils import load_stats, save_stats
    st = load_stats(name)
    if not st:
        st = {}
    session_stats = st.get("session_stats", {})
    from .utils import record_session_meta
    for f in failing:
        fn = f["session_file"]
        spam_status = statuses.get(fn, "UNKNOWN")
        if spam_status in (SPAM_FROZEN, SPAM_HARD_LIMITED, SPAM_TEMP_LIMITED):
            f["spam_status"] = spam_status
            flagged.append(f)
        ss = session_stats.get(fn, {})
        ss["_last_health_check_ts"] = time.time()
        ss["_last_spam_status"] = spam_status
        session_stats[fn] = ss
        # Mirror the SpamBot outcome into the shared per-session cache.
        if spam_status and spam_status != "UNKNOWN":
            record_session_meta(fn, None, spam_status=spam_status)
    st["session_stats"] = session_stats
    save_stats(name, st)
    return flagged


def create_replacement_request(
    bot_token: str,
    bot_name: str,
    owner_id: int,
    sessions: list[dict[str, Any]],
    free_count: int = 0,
) -> list[dict[str, Any]]:
    """Create replacement queue entries for failing sessions.
    free_count: how many can use free replacement. Rest need payment."""
    entries = []
    price_per = get_session_replacement_price()
    with _queue_lock:
        queue = load_replacement_queue()
        existing_files = {e["session_file"] for e in queue if e.get("bot_token") == bot_token and e.get("status") not in ("completed", "cancelled")}
        for i, sess in enumerate(sessions):
            fn = sess["session_file"]
            if fn in existing_files:
                continue
            is_free = i < free_count
            entry = {
                "id": str(uuid.uuid4())[:12],
                "bot_token": bot_token,
                "bot_name": bot_name,
                "owner_id": owner_id,
                "session_file": fn,
                "real_name": sess.get("real_name", fn),
                "spam_status": sess.get("spam_status", "UNKNOWN"),
                "failure_rate": sess.get("failure_rate", 0),
                "free_replacement": is_free,
                "price_usd": 0 if is_free else price_per,
                "status": "ready" if is_free else "pending_payment",
                "payment_id": "",
                "invoice_data": {},
                "created_at": datetime.utcnow().isoformat() + "Z",
                "completed_at": "",
                "new_session_file": "",
            }
            entries.append(entry)
            queue.append(entry)
        save_replacement_queue(queue)
    return entries


def get_pending_replacements_for_bot(bot_token: str) -> list[dict[str, Any]]:
    queue = load_replacement_queue()
    return [e for e in queue if e.get("bot_token") == bot_token and e.get("status") not in ("completed", "cancelled")]


def get_all_pending_replacements() -> list[dict[str, Any]]:
    queue = load_replacement_queue()
    return [e for e in queue if e.get("status") not in ("completed", "cancelled")]


def get_queued_awaiting_sessions() -> list[dict[str, Any]]:
    """Return entries that are ready but waiting for free sessions in pool."""
    queue = load_replacement_queue()
    return [e for e in queue if e.get("status") == "awaiting_session"]


def update_replacement_status(entry_id: str, status: str, **extra: Any) -> bool:
    with _queue_lock:
        queue = load_replacement_queue()
        for e in queue:
            if e.get("id") == entry_id:
                e["status"] = status
                for k, v in extra.items():
                    e[k] = v
                save_replacement_queue(queue)
                return True
    return False


def mark_replacement_paid(entry_id: str, payment_id: str = "") -> bool:
    return update_replacement_status(entry_id, "ready", payment_id=payment_id, paid_at=datetime.utcnow().isoformat() + "Z")


def cancel_replacement(entry_id: str) -> bool:
    return update_replacement_status(entry_id, "cancelled")


async def process_ready_replacements() -> list[dict[str, Any]]:
    """Process all 'ready' replacement entries: swap sessions from free pool.
    Returns list of processed entries with results."""
    results = []
    # Atomically CLAIM every 'ready' entry by flipping it to 'processing' under the lock,
    # then work on the claimed snapshot. A concurrent caller (portal auto-process, IPN
    # confirm, admin, background loop) will now see 'processing' — not 'ready' — and skip
    # them, so one dead session can never be replaced twice (double free-session spend).
    with _queue_lock:
        queue = load_replacement_queue()
        ready = [e for e in queue if e.get("status") == "ready"]
        if ready:
            for e in ready:
                e["status"] = "processing"
            save_replacement_queue(queue)
    if not ready:
        return results

    pool = load_pool()
    free_count = len(pool.get("free_sessions", []))

    for entry in ready:
        if free_count <= 0:
            update_replacement_status(entry["id"], "awaiting_session")
            add_admin_alert(
                "replacement_queue",
                f"Replacement for {entry['bot_name']} session {entry['session_file']} queued — no free sessions available. Add sessions to pool.",
            )
            results.append({**entry, "result": "queued_no_sessions"})
            _notify_user(entry, "queued")
            continue

        bot_token = entry["bot_token"]
        old_file = entry["session_file"]
        spam_status = entry.get("spam_status", "UNKNOWN")
        try:
            msg = await repair_replace_session(bot_token, old_file, spam_status)
        except Exception as exc:
            logger.error("repair_replace_session crashed for %s: %s", old_file, exc, exc_info=True)
            msg = f"Session swap failed: {exc}"
        if "Replaced" in msg:
            new_file = msg.split("with ")[-1].rstrip(".")
            update_replacement_status(
                entry["id"], "completed",
                new_session_file=new_file,
                completed_at=datetime.utcnow().isoformat() + "Z",
            )
            name = get_name_by_token(bot_token)
            if name:
                cfg = load_user_data(name)
                if cfg:
                    cfg["replacements_used"] = int(cfg.get("replacements_used", 0)) + 1
                    save_user_data(name, cfg)
            free_count -= 1
            results.append({**entry, "result": "replaced", "new_session_file": new_file})

            # Notify user
            _notify_user(entry, "replaced", new_file=new_file)

            await _join_chatlist_for_new_session(bot_token, new_file)
        else:
            update_replacement_status(entry["id"], "awaiting_session")
            results.append({**entry, "result": "failed", "error": msg})
            _notify_user(entry, "failed", error=msg)

    return results


async def _join_chatlist_for_new_session(bot_token: str, new_session_file: str) -> None:
    """Join the new replacement session to the bot's chatlist groups."""
    name = get_name_by_token(bot_token)
    if not name:
        return
    cfg = load_user_data(name)
    if not cfg:
        return
    custom_chatlist = cfg.get("custom_chatlist") or {}
    slugs = custom_chatlist.get("slugs", [])
    if not slugs:
        return
    try:
        from .chatlist import join_chatlist_on_session
        from .session_guard import open_session
        path = config.SESSIONS_ACTIVE / new_session_file
        if not path.is_file():
            return
        async with open_session(path, "session replacement (chatlist join)", wait_timeout=20, expected_sec=90) as client:
            if not await client.is_user_authorized():
                return
            for slug in slugs:
                try:
                    ok, err = await join_chatlist_on_session(client, slug, new_session_file)
                    if ok:
                        logger.info("[Replacement] Session %s joined chatlist slug=%s", new_session_file, slug)
                    else:
                        logger.warning("[Replacement] Session %s chatlist join failed slug=%s: %s", new_session_file, slug, err)
                except Exception as e:
                    logger.warning("[Replacement] Chatlist join error for %s: %s", new_session_file, e)
    except Exception as e:
        logger.warning("[Replacement] Chatlist join outer error: %s", e)


def generate_replacement_invoice_data(
    entries: list[dict[str, Any]],
    currency: str = "USDT_TRC20",
) -> dict[str, Any] | None:
    """Generate a payment invoice for paid replacement entries.
    Returns invoice data or None if all are free."""
    paid_entries = [e for e in entries if not e.get("free_replacement")]
    if not paid_entries:
        return None
    total_usd = sum(float(e.get("price_usd", 0)) for e in paid_entries)
    if total_usd <= 0:
        return None
    order_id = f"rep_{uuid.uuid4().hex[:8]}"
    entry_ids = [e["id"] for e in paid_entries]
    from .shop.payment import create_invoice
    invoice = create_invoice(
        amount_usd=total_usd,
        currency=currency,
        order_id=order_id,
        description=f"Session replacement x{len(paid_entries)}",
    )
    if invoice.get("_invoice_failed"):
        return None
    with _queue_lock:
        queue = load_replacement_queue()
        for e in queue:
            if e["id"] in entry_ids:
                e["invoice_data"] = invoice
                e["payment_id"] = invoice.get("payment_id", "")
                e["status"] = "pending_payment"
        save_replacement_queue(queue)
    return {
        "order_id": order_id,
        "total_usd": total_usd,
        "count": len(paid_entries),
        "entry_ids": entry_ids,
        "invoice": invoice,
    }


def check_replacement_payment(entry_ids: list[str]) -> bool:
    """Check if payment for replacement entries has been received. Returns True if paid."""
    queue = load_replacement_queue()
    entries = [e for e in queue if e["id"] in entry_ids and e.get("payment_id")]
    if not entries:
        return False
    payment_id = entries[0].get("payment_id", "")
    if not payment_id:
        return False
    from .shop.payment import get_payment_details, is_payment_success
    details = get_payment_details(payment_id)
    if not details:
        return False
    status = (details.get("payment_status") or "").lower()
    if is_payment_success(status):
        for e in entries:
            mark_replacement_paid(e["id"], payment_id)
        return True
    return False


def find_replacement_by_payment_id(payment_id: str) -> dict[str, Any] | None:
    """Return the (first) replacement queue entry holding this NOWPayments payment_id."""
    pid = (payment_id or "").strip()
    if not pid:
        return None
    for e in load_replacement_queue():
        if (e.get("payment_id") or "").strip() == pid:
            return e
    return None


async def confirm_replacement_payment_by_id(payment_id: str) -> bool:
    """Mark the replacement entry(ies) for this payment_id as paid and process them.

    Used by the IPN webhook and the payment safety sweep so a paid replacement is
    fulfilled even if the buyer closed the portal before the poll caught it.
    Idempotent: entries already ready/completed are skipped. Returns True if any
    matching replacement entry was found.
    """
    pid = (payment_id or "").strip()
    if not pid:
        return False
    matched = False
    for e in load_replacement_queue():
        if (e.get("payment_id") or "").strip() != pid:
            continue
        matched = True
        if e.get("status") == "pending_payment":
            mark_replacement_paid(e["id"], payment_id=pid)
            try:
                from api.routers.user_portal import add_portal_notification
                real_name = (e.get("real_name") or e.get("session_file", "")).replace(".session", "")
                add_portal_notification(
                    e.get("bot_name", ""),
                    title="Payment Confirmed ✓",
                    message=f"Payment received for {real_name}. Replacement will be processed shortly.",
                    type="success",
                    icon="swap",
                )
            except Exception:
                pass
    if matched:
        try:
            await process_ready_replacements()
        except Exception as exc:
            logger.warning("confirm_replacement_payment_by_id: process failed for %s: %s", pid, exc)
    return matched


def expire_replacement_invoice_by_id(payment_id: str) -> bool:
    """An unpaid replacement invoice expired/failed at the provider. Clear the dead
    invoice from the entry but KEEP it queued (status stays pending_payment) so the
    failing session isn't silently dropped and the buyer can start a fresh invoice.
    Clearing payment_id also stops the safety sweep from polling a dead id forever.
    Returns True if any matching entry was updated.
    """
    pid = (payment_id or "").strip()
    if not pid:
        return False
    affected_bots: set[str] = set()
    with _queue_lock:
        queue = load_replacement_queue()
        for e in queue:
            if (e.get("payment_id") or "").strip() == pid and e.get("status") == "pending_payment":
                e["payment_id"] = ""
                e["invoice_data"] = {}
                affected_bots.add(e.get("bot_name", ""))
        if affected_bots:
            save_replacement_queue(queue)
    for bot_name in affected_bots:
        try:
            from api.routers.user_portal import add_portal_notification
            add_portal_notification(
                bot_name,
                title="Payment Expired",
                message="A session-replacement invoice expired before payment. Start the replacement payment again when ready.",
                type="warning",
                icon="clock",
            )
        except Exception:
            pass
    return bool(affected_bots)


async def process_queue_by_admin() -> dict[str, Any]:
    """Admin action: process all queued replacements (ready + awaiting_session)."""
    pool = load_pool()
    free_count = len(pool.get("free_sessions", []))
    if free_count <= 0:
        return {"processed": 0, "error": "No free sessions in pool"}
    with _queue_lock:
        queue = load_replacement_queue()
        # Pick up "awaiting_session", "ready", and any "processing" entries left stuck by
        # a crash mid-swap (a live processor already holds real 'ready' ones, so re-marking
        # them 'ready' here is harmless — process_ready_replacements re-claims atomically).
        processable = [e for e in queue if e.get("status") in ("awaiting_session", "ready", "processing")]
    if not processable:
        return {"processed": 0, "message": "No queued replacements"}
    # Mark all as "ready" so process_ready_replacements picks them up
    for e in processable:
        if e["status"] != "ready":
            update_replacement_status(e["id"], "ready")
    results = await process_ready_replacements()
    completed = [r for r in results if r.get("result") == "replaced"]
    failed = [r for r in results if r.get("result") == "failed"]
    return {
        "processed": len(completed),
        "failed": len(failed),
        "total": len(processable),
        "results": results,
        "errors": [r.get("error", "") for r in failed] if failed else [],
    }
