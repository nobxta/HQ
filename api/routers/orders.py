"""Order management endpoints: list, search, mark paid, cancel, recreate."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_admin, Pagination
from api.services import wrappers
from api.services.serializers import serialize_order, paginate
from api.schemas import OrderActionResponse

router = APIRouter(prefix="/api/orders", tags=["orders"], dependencies=[Depends(get_current_admin)])


@router.get("")
async def list_orders(
    status: str = Query(None),
    user_id: int = Query(None),
    order_type: str = Query(None),
    pagination: Pagination = Depends(),
):
    orders = await wrappers.load_orders()
    results = []
    for o in orders:
        if status and o.get("status") != status:
            continue
        if user_id and o.get("user_id") != user_id:
            continue
        if order_type and o.get("order_type") != order_type:
            continue
        results.append(serialize_order(o))

    results.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return paginate(results, pagination.page, pagination.per_page)


@router.get("/pending")
async def pending_orders():
    orders = await wrappers.load_orders()
    pending = [
        serialize_order(o) for o in orders
        if o.get("status") in ("payment_waiting", "confirming", "paid", "pending_creation", "creating")
    ]
    pending.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"orders": pending, "total": len(pending)}


@router.get("/{order_id}")
async def get_order(order_id: str):
    results = await wrappers.search_orders(order_id=order_id)
    if not results:
        raise HTTPException(404, f"Order '{order_id}' not found")
    return serialize_order(results[0])


@router.post("/{order_id}/mark-paid", response_model=OrderActionResponse)
async def mark_paid(order_id: str):
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
async def recreate_order(order_id: str):
    from code.shop.handlers import recreate_pending_order
    try:
        success, msg = await recreate_pending_order(order_id)
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
    from code.shop.payment import get_payment_details

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
    if pstatus in ("confirmed", "finished", "sent") and order.get("status") in ("payment_waiting", "confirming"):
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
    elif pstatus in ("expired", "failed") and order.get("status") in ("payment_waiting", "confirming"):
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
