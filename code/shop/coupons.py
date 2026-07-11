"""Coupon store + validation for web checkout. Same flat-JSON convention as plans.json."""
import json
import logging
import threading
from datetime import datetime
from typing import Any, Optional

from .. import config

logger = logging.getLogger(__name__)

_coupons_lock = threading.Lock()

# Absolute safety floor, independent of any admin coupon config. NOWPayments' real
# per-currency minimum (~$2-$12+, driven by network fees) is checked separately once a pay
# currency is chosen (see payment.get_min_amount_usd) — this catches the "$20 off a $7 plan"
# case immediately, before the user even reaches the currency step.
MIN_PAYABLE_USD_FLOOR = 1.00


def _coupons_path():
    return config.DATA_COUPONS_FILE


def load_coupons() -> dict[str, dict[str, Any]]:
    """Load data/coupons.json. Keyed by uppercase code. Missing file -> {}."""
    path = _coupons_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.warning("Could not load coupons: %s", e)
        return {}


def save_coupons(coupons: dict[str, dict[str, Any]]) -> None:
    path = _coupons_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(coupons, indent=2), encoding="utf-8")


def find_coupon(code: Optional[str]) -> Optional[dict[str, Any]]:
    if not code:
        return None
    return load_coupons().get(code.strip().upper())


def create_coupon(code: str, data: dict[str, Any]) -> dict[str, Any]:
    norm = (code or "").strip().upper()
    if not norm:
        raise ValueError("Coupon code is required")
    with _coupons_lock:
        coupons = load_coupons()
        if norm in coupons:
            raise ValueError(f"A coupon with code {norm} already exists")
        entry = {
            "type": (data.get("type") or "percent").strip().lower(),
            "value": float(data.get("value") or 0),
            "active": bool(data.get("active", True)),
            "starts_at": data.get("starts_at") or None,
            "expires_at": data.get("expires_at") or None,
            "max_redemptions": data.get("max_redemptions"),
            "max_per_user": data.get("max_per_user"),
            "min_order_usd": data.get("min_order_usd"),
            "max_order_usd": data.get("max_order_usd"),
            "billing": (data.get("billing") or "both").strip().lower(),
            "applies_to": list(data.get("applies_to") or []),
            "redeemed_count": 0,
            "redemptions": [],
            "note": data.get("note") or "",
            "created_at": datetime.utcnow().isoformat() + "Z",
        }
        coupons[norm] = entry
        save_coupons(coupons)
        return entry


def update_coupon(code: str, patch: dict[str, Any]) -> dict[str, Any]:
    norm = (code or "").strip().upper()
    editable = {
        "type", "value", "active", "starts_at", "expires_at", "max_redemptions",
        "max_per_user", "min_order_usd", "max_order_usd", "billing", "applies_to", "note",
    }
    with _coupons_lock:
        coupons = load_coupons()
        entry = coupons.get(norm)
        if not entry:
            raise ValueError(f"Coupon {norm} not found")
        for key in editable:
            if key in patch:
                entry[key] = patch[key]
        coupons[norm] = entry
        save_coupons(coupons)
        return entry


def delete_coupon(code: str) -> bool:
    norm = (code or "").strip().upper()
    with _coupons_lock:
        coupons = load_coupons()
        if norm not in coupons:
            return False
        del coupons[norm]
        save_coupons(coupons)
        return True


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    try:
        return datetime.strptime(text.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")
    except Exception:
        try:
            return datetime.strptime(text[:10], "%Y-%m-%d")
        except Exception:
            return None


def validate_coupon(
    code: Optional[str],
    plan_id: str,
    billing: str,
    base_amount_usd: float,
    user_key: str = "",
) -> dict[str, Any]:
    """Validate a coupon against a specific plan/billing/price/buyer. Does NOT redeem it —
    call redeem_coupon() separately once payment is actually confirmed, not at checkout.

    Returns {"ok", "reason", "coupon" (snapshot or None), "discount_usd", "final_amount_usd"}.
    final_amount_usd == base_amount_usd and discount_usd == 0 whenever ok is False.
    """
    result: dict[str, Any] = {
        "ok": False, "reason": "", "coupon": None,
        "discount_usd": 0.0, "final_amount_usd": round(base_amount_usd, 2),
    }
    if not code or not code.strip():
        result["reason"] = "No coupon code"
        return result

    norm = code.strip().upper()
    c = load_coupons().get(norm)
    if not c:
        result["reason"] = "Invalid coupon code"
        return result
    if not c.get("active", True):
        result["reason"] = "This coupon is no longer active"
        return result

    now = datetime.utcnow()
    starts_at = _parse_dt(c.get("starts_at"))
    if starts_at and now < starts_at:
        result["reason"] = "This coupon isn't active yet"
        return result
    expires_at = _parse_dt(c.get("expires_at"))
    if expires_at and now > expires_at:
        result["reason"] = "This coupon has expired"
        return result

    max_redemptions = c.get("max_redemptions")
    if max_redemptions is not None and int(c.get("redeemed_count", 0)) >= int(max_redemptions):
        result["reason"] = "This coupon has reached its usage limit"
        return result

    max_per_user = c.get("max_per_user")
    if max_per_user is not None and user_key:
        used = sum(1 for r in c.get("redemptions", []) if (r.get("user_key") or "") == user_key)
        if used >= int(max_per_user):
            result["reason"] = "You've already used this coupon"
            return result

    applies_to = c.get("applies_to") or []
    if applies_to and plan_id not in applies_to:
        result["reason"] = "This coupon isn't valid for the selected plan"
        return result

    coupon_billing = (c.get("billing") or "both").strip().lower()
    req_billing = (billing or "").strip().lower()
    if coupon_billing != "both" and coupon_billing != req_billing:
        result["reason"] = f"This coupon only applies to {coupon_billing}ly billing"
        return result

    min_order = c.get("min_order_usd")
    if min_order is not None and base_amount_usd < float(min_order):
        result["reason"] = f"This coupon requires an order of at least ${float(min_order):.2f}"
        return result
    max_order = c.get("max_order_usd")
    if max_order is not None and base_amount_usd > float(max_order):
        result["reason"] = f"This coupon only applies to orders up to ${float(max_order):.2f}"
        return result

    ctype = (c.get("type") or "percent").strip().lower()
    value = float(c.get("value") or 0)
    if ctype == "fixed":
        discount = max(0.0, min(value, base_amount_usd))
    else:
        pct = max(0.0, min(100.0, value))
        discount = base_amount_usd * pct / 100.0
    final_amount = round(max(0.0, base_amount_usd - discount), 2)

    if final_amount < MIN_PAYABLE_USD_FLOOR:
        result["reason"] = (
            f"This discount would bring the order below the ${MIN_PAYABLE_USD_FLOOR:.2f} minimum "
            "— try a smaller discount or a different plan"
        )
        return result

    result["ok"] = True
    result["coupon"] = {"code": norm, "type": ctype, "value": value}
    result["discount_usd"] = round(discount, 2)
    result["final_amount_usd"] = final_amount
    return result


def redeem_coupon(code: str, order_id: str, user_key: str = "", email: str = "") -> None:
    """Record a redemption and bump the counter. Call ONLY once a payment is confirmed —
    never at order-creation — so abandoned/spam orders never burn real redemptions."""
    norm = (code or "").strip().upper()
    if not norm or not order_id:
        return
    with _coupons_lock:
        coupons = load_coupons()
        c = coupons.get(norm)
        if not c:
            return
        # Idempotency: apply_confirmed_payment is called across worker cycles + the IPN
        # webhook for the same order — never double-count a single order's redemption.
        if any((r.get("order_id") or "") == order_id for r in c.get("redemptions", [])):
            return
        c.setdefault("redemptions", []).append({
            "order_id": order_id,
            "user_key": user_key,
            "email": email,
            "at": datetime.utcnow().isoformat() + "Z",
        })
        c["redeemed_count"] = int(c.get("redeemed_count", 0)) + 1
        coupons[norm] = c
        save_coupons(coupons)
