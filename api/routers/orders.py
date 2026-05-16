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


@router.get("/search/by-payment")
async def search_by_payment(payment_id: str):
    results = await wrappers.search_orders(payment_id=payment_id)
    return {"orders": [serialize_order(o) for o in results], "total": len(results)}


@router.get("/search/by-user")
async def search_by_user(user_id: int):
    results = await wrappers.search_orders(user_id=user_id)
    return {"orders": [serialize_order(o) for o in results], "total": len(results)}
