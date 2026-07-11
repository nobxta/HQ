"""Payment provider integration (NOWPayments). Real API unless PAYMENT_DEV_MODE=1."""
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import config
from .payment_constants import SUPPORTED_PAY_CURRENCIES, internal_to_provider

logger = logging.getLogger(__name__)

# ── NOWPayments status semantics — single source of truth for every consumer ──────────
# Provider lifecycle (per NOWPayments docs):
#   waiting → confirming → confirmed → sending → finished          (success path)
#   partially_paid                                                 (underpaid)
#   failed / refunded / expired                                    (terminal negative)
# Product rule: DELIVER as soon as the blockchain CONFIRMS the payment — do not wait for the
# payout to reach "finished". So confirmed, sending, and finished all mean "provision now".
# ("sent" is kept as a legacy alias some provider payloads used.) get_payment_details() also
# normalises finished/sent/sending → "confirmed", but these helpers accept RAW provider status
# too (e.g. the IPN webhook body) so callers never need to know which form they hold.
PAYMENT_SUCCESS_STATUSES = frozenset({"confirmed", "sending", "sent", "finished"})
PAYMENT_FAILED_STATUSES = frozenset({"failed", "refunded", "expired"})


def is_payment_success(status: object) -> bool:
    """True once funds are confirmed on-chain — safe to provision/deliver (renewal, AdBot
    creation, session replacement, anything). Covers confirmed/sending/finished (+legacy sent)."""
    return str(status or "").strip().lower() in PAYMENT_SUCCESS_STATUSES


def is_payment_failed(status: object) -> bool:
    """True for terminal-negative provider statuses (failed / refunded / expired)."""
    return str(status or "").strip().lower() in PAYMENT_FAILED_STATUSES


# #region agent log
DEBUG_LOG_PATH = Path(__file__).resolve().parent.parent.parent / ".cursor" / "debug.log"
def _debug_log(message: str, data: dict, hypothesis_id: str | None = None, location: str = "") -> None:
    try:
        payload = {"timestamp": int(time.time() * 1000), "location": location or "payment.py", "message": message, "data": data}
        if hypothesis_id:
            payload["hypothesisId"] = hypothesis_id
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass
# #endregion

# Canonical base URL for NOWPayments; polling and all API calls use this when env is not set.
NOWPAYMENTS_DEFAULT_BASE = "https://api.nowpayments.io/v1"

def _api_key() -> str:
    return (getattr(config, "NOWPAYMENTS_API_KEY", None) or os.getenv("NOWPAYMENTS_API_KEY", "") or "").strip()

def _base_url() -> str:
    base = getattr(config, "NOWPAYMENTS_BASE_URL", None) or os.getenv("NOWPAYMENTS_BASE_URL", "") or ""
    if not base or base.strip() == "":
        base = NOWPAYMENTS_DEFAULT_BASE
    return base.strip().rstrip("/")

def _is_dev_mode() -> bool:
    return getattr(config, "PAYMENT_DEV_MODE", False)


def _np_headers() -> dict[str, str]:
    """Single global helper for ALL NOWPayments requests (GET and POST)."""
    api_key = (getattr(config, "NOWPAYMENTS_API_KEY", None) or os.getenv("NOWPAYMENTS_API_KEY", "") or "").strip()
    return {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }


def _mask_headers_for_log(headers: dict[str, str]) -> dict[str, str]:
    """Mask x-api-key to first 6 chars + *** for debug logs; leave other headers as-is."""
    return {k: (v[:6] + "***" if k.lower() == "x-api-key" and len(v) > 6 else v) for k, v in headers.items()}


def _log_payment_debug(method: str, url: str) -> None:
    """Temporary debug log before each request: URL and masked headers."""
    h = _np_headers()
    logger.info("[PAYMENT DEBUG] %s %s headers sent: %s", method, url, _mask_headers_for_log(h))


def load_supported_provider_currencies() -> set[str]:
    """
    Load the set of provider-supported pay_currency codes from data/now_supported.json.
    Returns lowercase codes (e.g. 'btc', 'usdttrc20'). If file missing or invalid, returns empty set.
    """
    path = getattr(config, "DATA_NOW_SUPPORTED_FILE", None) or Path(config.DATA_DIR) / "now_supported.json"
    if not path or not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        raw = data.get("currencies") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            return set()
        out = set()
        for item in raw:
            if isinstance(item, str):
                out.add(item.strip().lower())
            elif isinstance(item, dict):
                code = (item.get("code") or item.get("id") or item.get("currency") or "").strip().lower()
                if code:
                    out.add(code)
        return out
    except Exception as e:
        logger.warning("[PAYMENT] Failed to load supported currencies from %s: %s", path, e)
        return set()


def fetch_supported_currencies() -> bool:
    """
    GET /v1/currencies, save to data/now_supported.json. Returns True on success.
    Call from daily sync task or on startup.
    """
    import requests
    headers = _np_headers()
    if not headers.get("x-api-key") or headers["x-api-key"] == "your_api_key":
        return False
    path = getattr(config, "DATA_NOW_SUPPORTED_FILE", None) or Path(config.DATA_DIR) / "now_supported.json"
    url = f"{_base_url()}/currencies"
    _log_payment_debug("GET", url)
    try:
        resp = requests.get(url, headers=_np_headers(), timeout=20)
        if resp.status_code != 200:
            logger.warning("[PAYMENT] GET /currencies failed: status_code=%s %s", resp.status_code, resp.text[:200])
            return False
        raw = resp.json()
        currencies = raw if isinstance(raw, list) else (raw.get("currencies") or raw.get("result") or [])
        if not isinstance(currencies, list):
            currencies = []
        codes = []
        for item in currencies:
            if isinstance(item, str):
                codes.append(item.strip().lower())
            elif isinstance(item, dict):
                c = (item.get("code") or item.get("id") or item.get("currency") or "").strip().lower()
                if c:
                    codes.append(c)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"currencies": codes, "updated_at": datetime.utcnow().isoformat() + "Z"}, indent=2),
            encoding="utf-8",
        )
        logger.info("[PAYMENT] Fetched %s supported currencies to %s", len(codes), path)
        return True
    except Exception as e:
        logger.warning("[PAYMENT] Failed to fetch supported currencies: %s", e)
        return False


def _startup_nowpayments_test() -> None:
    """Temporary startup test: GET /status and GET /currencies; log response status codes to confirm auth."""
    import requests
    base = _base_url()
    for path, name in [("status", "GET /status"), ("currencies", "GET /currencies")]:
        url = f"{base}/{path}"
        _log_payment_debug("GET", url)
        try:
            resp = requests.get(url, headers=_np_headers(), timeout=20)
            status = resp.status_code
        except Exception as e:
            status = str(e)
        logger.info("[PAYMENT] Startup test %s -> %s", name, status)


def validate_payment_config() -> None:
    """
    Call at startup when Shop Bot is enabled. Raises if production and API key missing.
    Stub only when PAYMENT_DEV_MODE=1 and key is empty or 'your_api_key'.
    """
    if not getattr(config, "SHOP_BOT_TOKEN", ""):
        return
    dev = _is_dev_mode()
    key = _api_key()
    if not dev and (not key or key == "your_api_key"):
        raise RuntimeError(
            "NOWPAYMENTS_API_KEY must be set in .env for Shop Bot. "
            "Set PAYMENT_DEV_MODE=1 to use stub payments without an API key."
        )
    base = _base_url()
    if not base.startswith("http"):
        raise RuntimeError("NOWPAYMENTS_BASE_URL must be a valid URL (e.g. https://api.nowpayments.io/v1)")
    logger.info("[PAYMENT] Config OK: base_url=%s dev_mode=%s", base, dev)


_MIN_AMOUNT_CACHE: dict[str, tuple[float, float]] = {}  # provider_currency -> (min_usd, fetched_at_epoch)
_MIN_AMOUNT_CACHE_TTL_SEC = 6 * 3600


def get_min_amount_usd(provider_currency: str) -> float | None:
    """
    GET /v1/min-amount for a direct (no-conversion) payment in this currency, fiat-equivalent
    in USD. NOWPayments' real minimum varies by coin (~$2-$12+, driven by network fees) — an
    invoice created below it can accept an unrefundable underpayment that never confirms.

    Cached in-process for a few hours per currency (safety-net lookup at invoice-creation time,
    not a per-keystroke call). Returns None on any failure — callers should fail OPEN on this
    check (never block checkout on a provider hiccup) and rely on the flat coupon-floor safety
    net (coupons.MIN_PAYABLE_USD_FLOOR) as the backstop instead.
    """
    cur = (provider_currency or "").strip().lower()
    if not cur:
        return None
    cached = _MIN_AMOUNT_CACHE.get(cur)
    now = time.time()
    if cached and (now - cached[1]) < _MIN_AMOUNT_CACHE_TTL_SEC:
        return cached[0]

    api_key = _api_key()
    if not api_key or api_key == "your_api_key":
        return None

    url = f"{_base_url()}/min-amount"
    params = {"currency_from": cur, "currency_to": cur, "fiat_equivalent": "usd"}
    _log_payment_debug("GET", url)
    try:
        import requests
        resp = requests.get(url, params=params, headers=_np_headers(), timeout=10)
        if resp.status_code != 200:
            logger.warning("[PAYMENT] GET /min-amount failed for %s: HTTP %s", cur, resp.status_code)
            return None
        out = resp.json()
        min_usd = out.get("fiat_equivalent")
        if not min_usd:
            min_usd = out.get("min_amount")
        min_usd = float(min_usd or 0)
        if min_usd <= 0:
            return None
        _MIN_AMOUNT_CACHE[cur] = (min_usd, now)
        return min_usd
    except Exception as e:
        logger.warning("[PAYMENT] GET /min-amount error for %s: %s", cur, e)
        return None


def create_invoice(
    amount_usd: float,
    currency: str,
    order_id: str,
    description: str = "AdBot purchase",
) -> dict[str, Any]:
    """
    Create a direct payment via NOWPayments POST /payment.
    currency = internal UI code (e.g. BTC, USDT_TRC20). Mapped via SUPPORTED_PAY_CURRENCIES to provider code.
    Validates provider code against data/now_supported.json before creating invoice.
    Returns dict with payment_id, pay_address, pay_amount, pay_currency.
    If not in map or not supported by provider: {_invoice_failed: True, order_id: ..., _reason: "unavailable"}.
    """
    provider_currency = internal_to_provider(currency)
    if not provider_currency:
        logger.error("[PAYMENT] Currency not in SUPPORTED_PAY_CURRENCIES: %s", currency)
        return {"_invoice_failed": True, "order_id": order_id, "_reason": "unavailable"}

    provider_supported = load_supported_provider_currencies()
    if provider_supported and provider_currency.lower() not in provider_supported:
        logger.warning("[PAYMENT] Currency %s (%s) not in provider supported list", currency, provider_currency)
        return {"_invoice_failed": True, "order_id": order_id, "_reason": "unavailable"}

    api_key = _api_key()
    dev = _is_dev_mode()
    if dev and (not api_key or api_key == "your_api_key"):
        from datetime import timedelta
        expires_dt = datetime.utcnow() + timedelta(hours=12)
        return {
            "payment_id": f"stub_{order_id}",
            "invoice_url": f"https://example.com/pay/{order_id}",
            "pay_address": "STUB_ADDRESS",
            "pay_amount": amount_usd,
            "pay_currency": provider_currency.lower(),
            "invoice_expiry": "12 hours",
            "invoice_expires_at": expires_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "order_id": order_id,
        }
    if not api_key or api_key == "your_api_key":
        return {"_invoice_failed": True, "order_id": order_id}
    url = f"{_base_url()}/payment"
    _log_payment_debug("POST", url)
    try:
        import requests
        payload = {
            "price_amount": amount_usd,
            "price_currency": "usd",
            "pay_currency": provider_currency,
            "order_id": order_id,
        }
        resp = requests.post(url, json=payload, headers=_np_headers(), timeout=15)
        if resp.status_code not in (200, 201):
            logger.warning(
                "[PAYMENT] Payment request failed: status_code=%s payload=%s response=%s",
                resp.status_code, payload, resp.text,
            )
            return {"_invoice_failed": True, "order_id": order_id}
        out = resp.json()
        payment_id = str(out.get("payment_id") or out.get("id") or order_id)
        pay_addr = (out.get("pay_address") or "").strip()
        pay_amt = float(out.get("pay_amount") or amount_usd)
        pay_cur = (out.get("pay_currency") or provider_currency).lower()
        expiration_estimate_date = out.get("expiration_estimate_date") or out.get("expires_at") or out.get("expiration_estimate")
        if isinstance(expiration_estimate_date, (int, float)):
            invoice_expiry = f"{int(expiration_estimate_date)} min" if expiration_estimate_date < 120 else f"{int(expiration_estimate_date) // 60} h"
        else:
            invoice_expiry = str(expiration_estimate_date).strip() if expiration_estimate_date else ""
        if not pay_addr:
            logger.error(
                "[PAYMENT] Provider response missing pay_address for order_id=%s; full response: %s",
                order_id, out,
            )
            return {"_invoice_failed": True, "order_id": order_id}
        from datetime import datetime, timedelta
        # Always 12h window so user can pay anytime; display "Valid for: 12 hours"
        expires_dt = datetime.utcnow() + timedelta(hours=12)
        invoice_expires_at = expires_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        result = {
            "payment_id": payment_id,
            "pay_address": pay_addr,
            "pay_amount": pay_amt,
            "pay_currency": pay_cur,
            "expiration_estimate_date": expiration_estimate_date,
            "invoice_expiry": "12 hours",
            "invoice_expires_at": invoice_expires_at,
            "order_id": order_id,
        }
        logger.info(
            "[PAYMENT] Created payment: order_id=%s payment_id=%s address=%s amount=%s %s",
            order_id, payment_id, pay_addr[:8] + "..." if len(pay_addr) > 8 else pay_addr, pay_amt, pay_cur,
        )
        return result
    except Exception as e:
        logger.warning("NOWPayments create invoice failed: %s", e)
        return {"_invoice_failed": True, "order_id": order_id}


def get_payment_details(payment_id: str) -> dict[str, Any] | None:
    """
    GET /v1/payment/{payment_id} with required x-api-key header.
    Returns dict with payment_status, pay_amount, amount_received, pay_currency.
    On API failure (including HTTP 403 auth failure) returns None; caller retries next cycle.
    """
    api_key = _api_key()
    dev = _is_dev_mode()
    if not api_key or api_key == "your_api_key":
        if dev and payment_id.startswith("stub_"):
            if "confirmed" in payment_id:
                return {
                    "payment_status": "confirmed",
                    "pay_amount": 0.001,
                    "amount_received": 0.001,
                    "pay_currency": "btc",
                }
            return {
                "payment_status": "waiting",
                "pay_amount": 0.001,
                "amount_received": 0,
                "pay_currency": "btc",
            }
        if payment_id.startswith("confirmed_") or payment_id == "confirmed":
            return {
                "payment_status": "confirmed",
                "pay_amount": 0.001,
                "amount_received": 0.001,
                "pay_currency": "btc",
            }
        return {"payment_status": "waiting", "pay_amount": 0, "amount_received": 0, "pay_currency": ""}

    url = f"{_base_url()}/payment/{payment_id}"
    _log_payment_debug("GET", url)
    try:
        import requests
        resp = requests.get(url, headers=_np_headers(), timeout=20)
        if resp.status_code != 200:
            if resp.status_code == 403:
                logger.error(
                    "[PAYMENT] GET /payment/%s returned HTTP 403: auth/header failure. "
                    "Check NOWPAYMENTS_API_KEY and that x-api-key is sent correctly.",
                    payment_id,
                )
            else:
                logger.warning("[PAYMENT] GET /payment/%s failed: HTTP %s %s", payment_id, resp.status_code, resp.reason_phrase)
            return None
        out = resp.json()
    except Exception as e:
        logger.warning("[PAYMENT] GET /payment/%s failed: %s", payment_id, e)
        return None

    status = (out.get("payment_status") or out.get("status") or "waiting").lower()
    # Collapse every on-chain-confirmed state to "confirmed" so downstream consumers see one
    # canonical success value (delivery happens at confirmation, not at payout "finished").
    if status in ("finished", "sent", "sending"):
        status = "confirmed"
    if status in ("waiting_for_confirmations",):
        status = "waiting"
    pay_amount = float(out.get("pay_amount") or 0)
    amount_received = float(out.get("amount_received") or out.get("actually_paid") or 0)
    pay_currency = (out.get("pay_currency") or "").strip().lower()
    pay_address = (out.get("pay_address") or "").strip()
    network_raw = (out.get("network") or out.get("pay_currency") or pay_currency or "").strip().lower()
    # Real blockchain tx hash (user's incoming tx), not partner_liability_tx or internal payout
    tx_hash = (
        (out.get("payin_hash") or out.get("payin_extra_id") or "").strip()
        or (out.get("outcome_transaction_id") or "").strip()
        or (out.get("payout_hash") or "").strip()
    )
    return {
        "payment_status": status,
        "pay_amount": pay_amount,
        "amount_received": amount_received,
        "pay_currency": pay_currency,
        "pay_address": pay_address,
        "network": network_raw,
        "tx_hash": tx_hash,
    }


def check_payment_status(payment_id: str) -> str:
    """
    Check payment status via GET /v1/payment/{payment_id}.
    Returns: 'waiting' | 'confirming' | 'confirmed' | 'failed' | 'expired'.
    Prefer get_payment_details() for full amount handling.
    """
    d = get_payment_details(payment_id)
    if d is None:
        return "waiting"
    return (d.get("payment_status") or "waiting").lower()


async def check_payment_status_async(payment_id: str) -> str:
    """Async version for polling worker."""
    return check_payment_status(payment_id)
