"""Admin coupon management endpoints."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from api.deps import get_current_admin
from api.services.wrappers import log_admin_action

router = APIRouter(prefix="/api/system/coupons", tags=["coupons"], dependencies=[Depends(get_current_admin)])


class CouponWriteRequest(BaseModel):
    type: str = "percent"          # "percent" | "fixed"
    value: float = 0
    active: bool = True
    starts_at: Optional[str] = None
    expires_at: Optional[str] = None
    max_redemptions: Optional[int] = None
    max_per_user: Optional[int] = None
    min_order_usd: Optional[float] = None
    max_order_usd: Optional[float] = None
    billing: str = "both"          # "week" | "month" | "both"
    applies_to: list[str] = []
    note: str = ""


@router.get("")
async def list_coupons():
    from code.shop.coupons import load_coupons
    return await asyncio.to_thread(load_coupons)


@router.post("/{code}")
async def create_coupon(code: str, body: CouponWriteRequest):
    from code.shop.coupons import create_coupon as _create
    try:
        entry = await asyncio.to_thread(_create, code, body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
    await log_admin_action("web_admin", "create_coupon", target=code.strip().upper())
    return entry


@router.put("/{code}")
async def update_coupon(code: str, body: CouponWriteRequest):
    from code.shop.coupons import update_coupon as _update
    try:
        entry = await asyncio.to_thread(_update, code, body.model_dump())
    except ValueError as e:
        raise HTTPException(404, str(e))
    await log_admin_action("web_admin", "update_coupon", target=code.strip().upper())
    return entry


@router.delete("/{code}")
async def delete_coupon(code: str):
    from code.shop.coupons import delete_coupon as _delete
    ok = await asyncio.to_thread(_delete, code)
    if not ok:
        raise HTTPException(404, f"Coupon {code.strip().upper()} not found")
    await log_admin_action("web_admin", "delete_coupon", target=code.strip().upper())
    return {"status": "deleted"}
