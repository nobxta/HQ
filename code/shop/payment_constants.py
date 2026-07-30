"""
Supported currency mapping for NOWPayments.
Maps internal UI codes (used in callback_data) to provider pay_currency codes.
All invoice creation must use these codes and validate against the provider-supported list.
"""

import json

from .. import config


DEFAULT_INVOICE_LIFETIME_HOURS = 12
MIN_INVOICE_LIFETIME_HOURS = 1
MAX_INVOICE_LIFETIME_HOURS = 168
ADMIN_SETTINGS_FILE = config.DATA_DIR / "admin_settings.json"


def get_invoice_lifetime_hours() -> int:
    """Return the single admin-configured lifetime used by every new invoice."""
    try:
        settings = json.loads(ADMIN_SETTINGS_FILE.read_text("utf-8"))
        value = int(settings.get("invoice_lifetime_hours", DEFAULT_INVOICE_LIFETIME_HOURS))
        if MIN_INVOICE_LIFETIME_HOURS <= value <= MAX_INVOICE_LIFETIME_HOURS:
            return value
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return DEFAULT_INVOICE_LIFETIME_HOURS


def format_invoice_lifetime(hours: int | None = None) -> str:
    value = get_invoice_lifetime_hours() if hours is None else int(hours)
    return f"{value} hour" if value == 1 else f"{value} hours"

# Internal code (UI) → NOWPayments provider pay_currency code
# Use internal codes in callback_data; never send provider codes to the UI.
SUPPORTED_PAY_CURRENCIES = {
    "BTC": "btc",
    "ETH": "eth",
    "LTC": "ltc",
    "XMR": "xmr",
    "TRX": "trx",
    "DOGE": "doge",
    "XRP": "xrp",
    "SOL": "sol",
    "BNB": "bnbbsc",
    "MATIC": "matic",
    "ADA": "ada",
    "TON": "ton",
    "USDT_TRC20": "usdttrc20",
    "USDT_BEP20": "usdtbsc",
    "USDT_ERC20": "usdterc20",
    "USDT_SOL": "usdtsol",
    "USDT_ARB": "usdtarb",
    "USDC_BEP20": "usdcbsc",
    "USDC_ERC20": "usdcerc20",
    "USDC_SOL": "usdcsol",
    "USDC_MATIC": "usdcmatic",
    "USDC_ARB": "usdcarb",
}


def internal_to_provider(internal_code: str) -> str | None:
    """Convert internal UI code to provider pay_currency. Returns None if not in map."""
    key = (internal_code or "").strip().upper().replace(" ", "_")
    return SUPPORTED_PAY_CURRENCIES.get(key)
