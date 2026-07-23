"""Order management endpoints: list, search, mark paid, cancel, recreate."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_admin, Pagination
from api.services import wrappers
from api.services.serializers import serialize_order, paginate
from api.schemas import OrderActionResponse, RecreateOrderRequest

router = APIRouter(prefix="/api/orders", tags=["orders"], dependencies=[Depends(get_current_admin)])


def _temppay_as_order_rows() -> list[dict]:
    """Unpaid Shop Bot invoices live in temppay.json until payment confirms, so they are
    invisible to orders.json readers. Surface them as payment_waiting rows for the admin UI."""
    from code.shop.storage import temppay_load_all, order_from_temppay_entry
    rows = []
    for entry in temppay_load_all():
        o = order_from_temppay_entry(entry, status="payment_waiting")
        o["source"] = "shop"
        o["order_type"] = "purchase"
        o["is_temppay"] = True
        o["invoice_expires_at"] = (entry.get("expiry_at") or "").strip()
        rows.append(o)
    return rows


# Replacement-queue statuses → order-like display status so the payments UI can render them
# with the same Badge/filters as real orders (money-in → "paid", still-owed → "payment_waiting").
_REPLACEMENT_STATUS_MAP = {
    "pending_payment": "payment_waiting",
    "ready": "paid",
    "awaiting_session": "paid",
    "processing": "paid",
    "completed": "completed",
    "cancelled": "cancelled",
}


def _replacement_as_order_rows() -> list[dict]:
    """Surface one read-only payment row per replacement invoice.

    A grouped replacement stores the same blockchain payment id on every covered
    queue entry. The admin payments screen must represent that as one transaction,
    not one row per session.
    """
    from code.replacement import load_replacement_queue
    rows: list[dict] = []
    grouped: dict[str, list[dict]] = {}
    for e in load_replacement_queue():
        if e.get("free_replacement") or float(e.get("price_usd") or 0) <= 0:
            continue
        payment_id = str(e.get("payment_id") or (e.get("invoice_data") or {}).get("payment_id") or "").strip()
        # Replacement requests belong in the queue until a real provider invoice
        # exists; the payments ledger should only contain actual invoices.
        if not payment_id:
            continue
        group_key = f"payment:{payment_id}" if payment_id else f"job:{e.get('job_id') or e.get('id')}"
        grouped.setdefault(group_key, []).append(e)

    status_rank = {
        "pending_payment": 0, "ready": 1, "processing": 1, "awaiting_session": 1,
        "needs_admin": 1, "completed": 2, "cancelled": 3,
    }
    for entries in grouped.values():
        first = entries[0]
        inv = first.get("invoice_data") or {}
        names = [
            (e.get("real_name") or e.get("session_file") or "").replace(".session", "")
            for e in entries
        ]
        statuses = [str(e.get("status") or "") for e in entries]
        if "pending_payment" in statuses:
            queue_status = "pending_payment"
        elif statuses and all(status == "completed" for status in statuses):
            queue_status = "completed"
        elif statuses and all(status == "cancelled" for status in statuses):
            queue_status = "cancelled"
        else:
            queue_status = min(statuses, key=lambda status: status_rank.get(status, 1), default="")
        payment_id = str(first.get("payment_id") or inv.get("payment_id") or "").strip()
        rows.append({
            "order_id": first.get("job_id") or first.get("id", ""),
            "job_id": first.get("job_id") or first.get("id", ""),
            "user_id": first.get("owner_id"),
            "status": _REPLACEMENT_STATUS_MAP.get(queue_status, queue_status),
            "order_type": "replacement",
            "source": "replacement",
            "plan_name": f"Session replacement ×{len(entries)}",
            "amount_usd": sum(float(e.get("price_usd") or 0) for e in entries),
            "bot_name": first.get("bot_name", ""),
            "real_name": ", ".join(names),
            "session_names": names,
            "replacement_count": len(entries),
            "session_file": first.get("session_file", ""),
            "payment_id": payment_id,
            "pay_currency": inv.get("pay_currency", ""),
            "pay_amount": inv.get("pay_amount", ""),
            "pay_address": inv.get("pay_address", ""),
            "invoice_expires_at": inv.get("invoice_expires_at", ""),
            "created_at": min((e.get("created_at", "") for e in entries), default=""),
            "paid_at": max((e.get("paid_at", "") for e in entries), default=""),
            "is_replacement": True,
        })
    return rows


async def _all_payment_rows() -> list[dict]:
    """Every payment the admin should see: orders.json + live bot invoices (temppay) +
    paid session-replacement requests. Deduped by order_id/payment_id."""
    orders = await wrappers.load_orders()
    temppay_rows = await asyncio.to_thread(_temppay_as_order_rows)
    replacement_rows = await asyncio.to_thread(_replacement_as_order_rows)
    seen_ids = {o.get("order_id") for o in orders}
    seen_pids = {(o.get("payment_id") or "").strip() for o in orders if o.get("payment_id")}
    extra = [
        r for r in (temppay_rows + replacement_rows)
        if r.get("order_id") not in seen_ids and (r.get("payment_id") or "") not in seen_pids
    ]
    return orders + extra


@router.get("")
async def list_orders(
    status: str = Query(None),
    user_id: int = Query(None),
    order_type: str = Query(None),
    bot_name: str = Query(None),
    pagination: Pagination = Depends(),
):
    orders = await _all_payment_rows()
    results = []
    for o in orders:
        if status and o.get("status") != status:
            continue
        if user_id and o.get("user_id") != user_id:
            continue
        if order_type and o.get("order_type") != order_type:
            continue
        if bot_name and o.get("bot_name") != bot_name:
            continue
        results.append(serialize_order(o))

    results.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return paginate(results, pagination.page, pagination.per_page)


@router.get("/pending")
async def pending_orders():
    orders = await _all_payment_rows()
    pending = [
        serialize_order(o) for o in orders
        if o.get("status") in ("payment_waiting", "confirming", "paid", "pending_creation", "creating")
    ]
    pending.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"orders": pending, "total": len(pending)}


@router.get("/stats")
async def order_stats():
    """Aggregate metrics across ALL orders (incl. live bot invoices) for the payments dashboard."""
    orders = await _all_payment_rows()
    by_status: dict[str, int] = {}
    revenue = 0.0
    for o in orders:
        st = o.get("status", "") or "unknown"
        by_status[st] = by_status.get(st, 0) + 1
        if st == "completed":
            try:
                revenue += float(o.get("amount_usd") or 0)
            except (TypeError, ValueError):
                pass
    pending_states = ("payment_waiting", "confirming", "paid", "pending_creation", "creating")
    return {
        "total": len(orders),
        "by_status": by_status,
        "revenue_usd": round(revenue, 2),
        "completed": by_status.get("completed", 0),
        "pending": sum(by_status.get(s, 0) for s in pending_states),
        "expired": by_status.get("expired", 0) + by_status.get("cancelled", 0),
    }


@router.get("/{order_id}")
async def get_order(order_id: str):
    results = await wrappers.search_orders(order_id=order_id)
    if not results:
        raise HTTPException(404, f"Order '{order_id}' not found")
    return serialize_order(results[0])


@router.post("/{order_id}/mark-paid", response_model=OrderActionResponse)
async def mark_paid(order_id: str):
    from code.shop.storage import get_order
    order = get_order(order_id)
    if not order:
        raise HTTPException(404, f"Order '{order_id}' not found")
    # Renewals must EXTEND the bot's validity, never trigger a new-bot build. order_mark_paid
    # would wrongly push a renewal into "creating" (a provisioning state), stranding it — and
    # "creating" can't be cancelled. apply_confirmed_payment runs the renewal branch
    # (extend_valid_till_for_bot → paid → completed), is idempotent, and is the SAME path the
    # IPN webhook uses, so admin confirmation and automatic confirmation behave identically.
    if order.get("order_type") == "renewal" and order.get("status") in ("payment_waiting", "confirming"):
        from code.shop.workers import apply_confirmed_payment
        ok = await apply_confirmed_payment(order, {})
        if not ok:
            raise HTTPException(400, "Renewal is no longer awaiting payment")
        await wrappers.log_admin_action("web_admin", "order_mark_paid", target=f"{order_id} (renewal)")
        return OrderActionResponse(success=True, message="Renewal confirmed — validity extended")
    # Web orders must run the SAME provisioning the IPN webhook does — issue the web
    # access code, reserve a pooled bot token, and submit the build — not just a status
    # flip, or the order strands in "creating" with no bot. apply_confirmed_payment is
    # idempotent and self-guards on status.
    if (order.get("source") or "") == "web" and order.get("status") in ("payment_waiting", "confirming"):
        from code.shop.workers import apply_confirmed_payment
        ok = await apply_confirmed_payment(order, {})
        if not ok:
            raise HTTPException(400, "Order is no longer awaiting payment")
        await wrappers.log_admin_action("web_admin", "order_mark_paid", target=order_id)
        return OrderActionResponse(success=True, message="Marked paid — provisioning started")
    success, msg = await wrappers.order_mark_paid(order_id)
    if not success:
        raise HTTPException(400, msg)
    await wrappers.log_admin_action("web_admin", "order_mark_paid", target=order_id)
    return OrderActionResponse(success=True, message=msg)


@router.post("/{order_id}/cancel", response_model=OrderActionResponse)
async def cancel_order(order_id: str):
    success, msg = await wrappers.order_cancel(order_id)
    if not success:
        raise HTTPException(400, msg)
    await wrappers.log_admin_action("web_admin", "order_cancel", target=order_id)
    return OrderActionResponse(success=True, message=msg)


@router.post("/{order_id}/recreate", response_model=OrderActionResponse)
async def recreate_order(order_id: str, body: RecreateOrderRequest = RecreateOrderRequest()):
    from code.shop.handlers import recreate_pending_order
    try:
        success, msg = await recreate_pending_order(
            order_id,
            skip_health_check=body.skip_health_check,
            skip_chatlist_join=body.skip_chatlist_join,
        )
    except Exception as e:
        raise HTTPException(500, f"Recreate failed: {e}")
    if not success:
        raise HTTPException(400, msg)
    await wrappers.log_admin_action("web_admin", "order_recreate", target=order_id)
    return OrderActionResponse(success=True, message=msg)


@router.post("/{order_id}/sync")
async def sync_order(order_id: str):
    """Re-poll NOWPayments for this order right now and update it. If the provider says the
    payment is finished and we haven't processed it yet, confirm it (triggers build)."""
    from code.shop.storage import get_order, update_order, update_order_status
    from code.shop.payment import get_payment_details, is_payment_success, is_payment_failed

    order = get_order(order_id)
    if not order:
        raise HTTPException(404, f"Order '{order_id}' not found")
    payment_id = (order.get("payment_id") or "").strip()
    if not payment_id:
        return {"synced": False, "reason": "No payment_id on this order", "order": serialize_order(order)}

    details = await asyncio.to_thread(get_payment_details, payment_id)
    if not details:
        raise HTTPException(502, "Could not reach NOWPayments — try again")

    pstatus = (details.get("payment_status") or "").lower()
    update_order(order_id, {
        "amount_received": details.get("amount_received", 0) or 0,
        "pay_address": details.get("pay_address") or order.get("pay_address", ""),
        "tx_hash": details.get("tx_hash") or order.get("tx_hash", ""),
        "network": details.get("network") or order.get("network", ""),
        "last_synced_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    })

    confirmed = False
    if is_payment_success(pstatus) and order.get("status") in ("payment_waiting", "confirming"):
        from code.shop.workers import confirm_payment_for_invoice
        try:
            confirmed = await confirm_payment_for_invoice(payment_id, details)
        except Exception as e:
            raise HTTPException(500, f"Confirm failed: {e}")
    elif pstatus == "confirming" and order.get("status") == "payment_waiting":
        try:
            update_order_status(order_id, "confirming")
        except Exception:
            pass
    elif is_payment_failed(pstatus) and order.get("status") in ("payment_waiting", "confirming"):
        try:
            update_order_status(order_id, "expired" if pstatus == "expired" else "cancelled")
            from code.shop import token_pool
            token_pool.release_order(order_id)
        except Exception:
            pass

    fresh = get_order(order_id) or order
    await wrappers.log_admin_action("web_admin", "order_sync", target=order_id)
    return {
        "synced": True,
        "provider_status": pstatus,
        "confirmed": confirmed,
        "details": details,
        "order": serialize_order(fresh),
    }


@router.get("/search/by-payment")
async def search_by_payment(payment_id: str):
    results = await wrappers.search_orders(payment_id=payment_id)
    return {"orders": [serialize_order(o) for o in results], "total": len(results)}


@router.get("/search/by-user")
async def search_by_user(user_id: int):
    results = await wrappers.search_orders(user_id=user_id)
    return {"orders": [serialize_order(o) for o in results], "total": len(results)}
