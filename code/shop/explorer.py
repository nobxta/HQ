"""
Universal blockchain tx hash + explorer link system.
Network-aware explorer resolution tied to pay_currency / network from NOWPayments.
"""

# Explorer base URLs (no tx hash). Keys are normalized network/currency codes.
EXPLORER_MAP = {
    "btc": "https://www.blockchain.com/btc/tx/",
    "eth": "https://etherscan.io/tx/",
    "bsc": "https://bscscan.com/tx/",
    "bnb": "https://bscscan.com/tx/",
    "bnbbsc": "https://bscscan.com/tx/",
    "trx": "https://tronscan.org/#/transaction/",
    "ltc": "https://blockchair.com/litecoin/transaction/",
    "doge": "https://blockchair.com/dogecoin/transaction/",
    "xrp": "https://xrpscan.com/tx/",
    "sol": "https://solscan.io/tx/",
    "matic": "https://polygonscan.com/tx/",
    "arb": "https://arbiscan.io/tx/",
    "ada": "https://cardanoscan.io/transaction/",
    "ton": "https://tonscan.org/tx/",
    "xmr": "https://xmrchain.net/tx/",
    # Stablecoins by network (same as pay_currency from NOWPayments)
    "usdttrc20": "https://tronscan.org/#/transaction/",
    "usdtbsc": "https://bscscan.com/tx/",
    "usdterc20": "https://etherscan.io/tx/",
    "usdtsol": "https://solscan.io/tx/",
    "usdtarb": "https://arbiscan.io/tx/",
    "usdcbsc": "https://bscscan.com/tx/",
    "usdcerc20": "https://etherscan.io/tx/",
    "usdcsol": "https://solscan.io/tx/",
    "usdcmatic": "https://polygonscan.com/tx/",
    "usdcarb": "https://arbiscan.io/tx/",
}


def normalize_network_for_explorer(pay_currency: str, network_from_api: str = "") -> str:
    """
    Normalize to a key used in EXPLORER_MAP.
    pay_currency: from NOWPayments (e.g. btc, eth, usdttrc20, usdtbsc).
    network_from_api: optional network from API response.
    """
    key = (pay_currency or "").strip().lower()
    net = (network_from_api or "").strip().lower()
    if key in EXPLORER_MAP:
        return key
    if net and net in EXPLORER_MAP:
        return net
    if net:
        n = net.replace("-", "").replace(" ", "")
        if n in EXPLORER_MAP:
            return n
    return key


def build_explorer_link(network: str, tx_hash: str) -> str | None:
    """Return full explorer URL for the given network and tx hash, or None if not supported."""
    if not (tx_hash or "").strip():
        return None
    tx = (tx_hash or "").strip()
    key = (network or "").strip().lower()
    base = EXPLORER_MAP.get(key)
    if not base:
        return None
    return f"{base}{tx}"


# Display names for confirmation screen (aligned with handlers.CRYPTO_DISPLAY_NAMES).
CURRENCY_DISPLAY_NAMES = {
    "btc": "Bitcoin", "eth": "Ethereum", "ltc": "Litecoin", "xmr": "Monero",
    "trx": "TRON", "bnb": "BNB Chain", "bnbbsc": "BNB Chain",
    "doge": "Dogecoin", "xrp": "Ripple", "sol": "Solana", "matic": "Polygon",
    "ada": "Cardano", "ton": "TON", "arb": "Arbitrum",
    "usdttrc20": "USDT TRC20", "usdtbsc": "USDT BEP20", "usdterc20": "USDT ERC20",
    "usdtsol": "USDT SOL", "usdtarb": "USDT ARB",
    "usdcbsc": "USDC BEP20", "usdcerc20": "USDC ERC20", "usdcsol": "USDC SOL",
    "usdcmatic": "USDC MATIC", "usdcarb": "USDC ARB",
}


def get_currency_display_name(pay_currency: str) -> str:
    """User-friendly name for pay_currency."""
    key = (pay_currency or "").strip().lower()
    return CURRENCY_DISPLAY_NAMES.get(key, (pay_currency or "").upper())
