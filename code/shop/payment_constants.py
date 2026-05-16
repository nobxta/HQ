"""
Supported currency mapping for NOWPayments.
Maps internal UI codes (used in callback_data) to provider pay_currency codes.
All invoice creation must use these codes and validate against the provider-supported list.
"""

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
