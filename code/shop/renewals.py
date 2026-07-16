"""Shared renewal pricing and date helpers for web, shop bot, and controller bots."""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from .storage import load_plans

SUPPORTED_RENEWAL_DURATIONS = (7, 30)


def parse_valid_till(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw.replace("Z", "").split(".")[0], fmt)
        except ValueError:
            continue
    return None


def money(value: object) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        amount = Decimal(str(value).replace(",", ".").strip())
    except (InvalidOperation, AttributeError):
        return None
    if amount <= 0:
        return None
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def find_plan_for_bot(cfg: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    plan_id = (cfg.get("plan_name") or (cfg.get("plan") or {}).get("name") or "").strip()
    mode = ((cfg.get("mode") or cfg.get("plan_mode") or (cfg.get("plan") or {}).get("mode") or "starter").strip().lower())
    plans = load_plans()
    for candidate_mode in [mode, mode.capitalize(), "starter", "enterprise"]:
        for plan in plans.get(candidate_mode, []) or []:
            if plan_id and str(plan.get("id") or "").strip().lower() == plan_id.lower():
                return plan, candidate_mode
    for candidate_mode, plan_list in plans.items():
        for plan in plan_list or []:
            if plan_id and str(plan.get("id") or "").strip().lower() == plan_id.lower():
                return plan, candidate_mode
    return None, mode


def normalize_renewal_prices(cfg: dict[str, Any]) -> dict[str, Any]:
    existing = cfg.get("renewal_prices")
    if not isinstance(existing, dict):
        existing = {}
    out = {"7d": existing.get("7d"), "30d": existing.get("30d")}
    for key in ("7d", "30d"):
        parsed = money(out.get(key))
        out[key] = str(parsed) if parsed is not None else None
    legacy = cfg.get("renewal_price")
    if legacy not in (None, "") and "legacy_renewal_price" not in cfg:
        cfg["legacy_renewal_price"] = legacy
    cfg["renewal_prices"] = out
    return out


def effective_renewal_options(cfg: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.utcnow()
    overrides = normalize_renewal_prices(cfg)
    plan, mode = find_plan_for_bot(cfg)
    valid_dt = parse_valid_till(cfg.get("valid_till"))
    base_dt = max(valid_dt or now, now)
    options: dict[str, Any] = {}
    for days, key, plan_key in ((7, "7d", "price_week"), (30, "30d", "price_month")):
        override = money(overrides.get(key))
        plan_price = money((plan or {}).get(plan_key))
        amount = override or plan_price
        source = "override" if override is not None else ("plan" if plan_price is not None else "missing")
        new_expiry = base_dt + timedelta(days=days)
        options[key] = {
            "duration": key,
            "days": days,
            "available": amount is not None,
            "price": str(amount) if amount is not None else "",
            "currency": "USD",
            "source": source,
            "new_valid_till": new_expiry.strftime("%d/%m/%Y"),
            "unavailable_reason": "" if amount is not None else "No price is configured for this duration.",
        }
    return {
        "plan": plan or {},
        "plan_mode": mode,
        "current_valid_till": cfg.get("valid_till") or "",
        "base_valid_till": base_dt.strftime("%d/%m/%Y"),
        "options": options,
    }


def resolve_renewal_price(cfg: dict[str, Any], duration_days: int) -> dict[str, Any]:
    if duration_days not in SUPPORTED_RENEWAL_DURATIONS:
        raise ValueError("Unsupported renewal duration")
    opts = effective_renewal_options(cfg)
    key = f"{duration_days}d"
    opt = opts["options"].get(key) or {}
    amount = money(opt.get("price"))
    if amount is None:
        raise ValueError("No renewal price configured for this duration")
    return {
        "duration": key,
        "days": duration_days,
        "amount": amount,
        "currency": opt.get("currency") or "USD",
        "pricing_source": opt.get("source") or "plan",
        "new_valid_till_preview": opt.get("new_valid_till") or "",
        "base_valid_till": opts.get("base_valid_till") or "",
    }
