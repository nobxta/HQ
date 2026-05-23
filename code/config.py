"""API credentials, paths, and logging setup.
When the app is run via main.py, load_dotenv() is called there before any project imports,
so env vars (e.g. NOWPAYMENTS_API_KEY) are set before this module runs. Below we also
call load_dotenv so that tests or other entrypoints get .env loaded before reading os.getenv.
"""
import logging
import logging.handlers
import os
import sys
from pathlib import Path

# Project root (parent of code/), so sessions/, groups/, logs/, data/ stay at root
BASE_DIR = Path(__file__).resolve().parent.parent

# Load .env before any os.getenv() below (redundant when imported after main.py entrypoint)
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except ModuleNotFoundError:
    _env_file = BASE_DIR / ".env"
    if _env_file.is_file():
        for line in _env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

# Telegram API (from .env)
API_ID = os.getenv("API_ID")
API_HASH = os.getenv("API_HASH")
ADMIN_BOT_TOKEN = os.getenv("ADMIN_BOT_TOKEN")
ADMIN_USER_ID = int(os.getenv("ADMIN_USER_ID", "0") or "0")
ADMIN_CONTACT = (os.getenv("ADMIN_CONTACT", "") or "admin").strip().lstrip("@")

# Shop Bot (self-service purchases)
SHOP_BOT_TOKEN = (os.getenv("SHOP_BOT_TOKEN", "") or "").strip()
# Support: prefer SUPPORT_CHAT_ID (opens direct chat via tg://user?id=). Fallback: SUPPORT_USER_ID / SUPPORT_ID.
SUPPORT_CHAT_ID = int(os.getenv("SUPPORT_CHAT_ID", "0") or "0")
SUPPORT_USER_ID = int(os.getenv("SUPPORT_USER_ID", "0") or os.getenv("SUPPORT_ID", "0") or "0")
WEBSITE_URL = (os.getenv("WEBSITE_URL", "") or "").strip()
NOWPAYMENTS_API_KEY = (os.getenv("NOWPAYMENTS_API_KEY", "") or "").strip()
NOWPAYMENTS_BASE_URL = (os.getenv("NOWPAYMENTS_BASE_URL", "https://api.nowpayments.io/v1") or "https://api.nowpayments.io/v1").rstrip("/")
# Stub payments only when explicitly enabled (set PAYMENT_DEV_MODE=1 to use stub without API key)
PAYMENT_DEV_MODE = (os.getenv("PAYMENT_DEV_MODE", "") or "").lower() in ("1", "true", "yes")

MAX_SESSIONS_PER_BOT = 50
# Minimum cycle interval (seconds) between posting rounds. Values below this are raised to this (e.g. 250 allowed if >= MIN_CYCLE_SEC).
MIN_CYCLE_SEC = 60

# Default chatlist links for each mode. Admin sets these in .env so group files stay in sync with live chatlists.
# When a user buys a plan or reverts to default, sessions auto-join these chatlists.
DEFAULT_CHATLIST_STARTER = (os.getenv("DEFAULT_CHATLIST_STARTER", "") or "").strip()
DEFAULT_CHATLIST_ENTERPRISE = (os.getenv("DEFAULT_CHATLIST_ENTERPRISE", "") or "").strip()
# Default group file per mode (must exist in groups/)
DEFAULT_GROUP_FILE_STARTER = (os.getenv("DEFAULT_GROUP_FILE_STARTER", "Starter.txt") or "Starter.txt").strip()
DEFAULT_GROUP_FILE_ENTERPRISE = (os.getenv("DEFAULT_GROUP_FILE_ENTERPRISE", "Enterprise.txt") or "Enterprise.txt").strip()

PROXY = None
_proxy_host = (os.getenv("PROXY_HOST") or "").strip()
if _proxy_host:
    try:
        import socks
        _ptype = (os.getenv("PROXY_TYPE") or "socks5").strip().lower()
        _typ = socks.SOCKS5 if _ptype == "socks5" else socks.SOCKS4
        PROXY = (_typ, _proxy_host, int(os.getenv("PROXY_PORT") or "1080"))
    except Exception:
        pass


def build_ptb_httpx_request():
    """When ``PROXY_*`` is configured, route python-telegram-bot (Bot API over HTTPS) through the same SOCKS proxy.

    Uses ``socks5h`` so hostname resolution happens on the proxy side, which avoids local DNS blocks for
    ``api.telegram.org`` while Telethon talks MTProto separately.

    Requires ``socksio`` (``pip install socksio`` or ``pip install httpx[socks]``).
    Returns ``None`` if ``PROXY_HOST`` is unset or ``socksio`` is missing.

    Uses ``PROXY_HOST`` explicitly (not only ``PROXY``) so PTB still gets a proxy if Telethon
    skipped SOCKS due to a PySocks import error.
    """
    host = (_proxy_host or "").strip()
    if not host:
        return None
    try:
        import socksio  # noqa: F401 — httpx SOCKS transport
        from telegram.request import HTTPXRequest
    except ImportError:
        logging.getLogger(__name__).warning(
            "PROXY_HOST is set but socksio is not installed; Bot API HTTP still goes direct (no SOCKS). "
            "Install socksio to align PTB with Telethon proxying."
        )
        return None
    ptype = (os.getenv("PROXY_TYPE") or "socks5").strip().lower()
    scheme = "socks5h" if ptype == "socks5" else "socks4"
    port = int(os.getenv("PROXY_PORT") or "1080")
    proxy_url = f"{scheme}://{host}:{port}"
    try:
        return HTTPXRequest(proxy_url=proxy_url)
    except Exception as e:
        logging.getLogger(__name__).warning("PTB HTTPXRequest SOCKS setup failed (%s); PTB stays direct.", e)
        return None


# Paths (all under project root)
SESSIONS_DIR = BASE_DIR / "sessions"
SESSIONS_ACTIVE = SESSIONS_DIR / "active"
SESSIONS_DEAD = SESSIONS_DIR / "dead"
SESSIONS_FROZEN = SESSIONS_DIR / "frozen"
SESSIONS_LIMITED = SESSIONS_DIR / "limited"
SESSIONS_UNAUTH = SESSIONS_DIR / "unauth"
SESSIONS_BY_USER = SESSIONS_DIR / "users"
GROUPS_DIR = BASE_DIR / "groups"
LOGS_DIR = BASE_DIR / "logs"

# Per-user storage (new architecture)
DATA_DIR = BASE_DIR / "data"
DATA_USER_DIR = DATA_DIR / "user"
DATA_LOGS_DIR = DATA_DIR / "logs"
DATA_INDEX_FILE = DATA_DIR / "index.json"
DATA_POOL_FILE = DATA_DIR / "pool.json"
DATA_PLANS_FILE = DATA_DIR / "plans.json"
DATA_ORDERS_FILE = DATA_DIR / "orders.json"
DATA_TEMPPAY_FILE = DATA_DIR / "temppay.json"
DATA_NOW_SUPPORTED_FILE = DATA_DIR / "now_supported.json"
DATA_MAINTENANCE_FILE = DATA_DIR / "maintenance.json"
DATA_MAINTENANCE_QUEUE_FILE = DATA_DIR / "maintenance_notify_queue.json"
DATA_REPLACEMENT_QUEUE_FILE = DATA_DIR / "replacement_queue.json"
DATA_BROADCAST_LOG_FILE = DATA_DIR / "broadcast_log.json"
DATA_BROADCAST_USERS_FILE = DATA_DIR / "broadcast_users.json"
# Per-user stats (counts only; no event list). Keeps config small.
DATA_STATS_DIR = DATA_DIR / "stats"

# Broadcast rate limit: max messages per minute when notifying after maintenance or segmented broadcast
BROADCAST_RATE_LIMIT_PER_MIN = int(os.getenv("BROADCAST_RATE_LIMIT_PER_MIN", "30") or "30")
# Broadcast wizard: session timeout (seconds) if admin does not send message in time
BROADCAST_SESSION_TIMEOUT_SEC = int(os.getenv("BROADCAST_SESSION_TIMEOUT_SEC", "600") or "600")

LOGS_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_USER_DIR.mkdir(parents=True, exist_ok=True)
DATA_STATS_DIR.mkdir(parents=True, exist_ok=True)
DATA_LOGS_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_ACTIVE.mkdir(parents=True, exist_ok=True)
SESSIONS_DEAD.mkdir(parents=True, exist_ok=True)
SESSIONS_FROZEN.mkdir(parents=True, exist_ok=True)
SESSIONS_LIMITED.mkdir(parents=True, exist_ok=True)
SESSIONS_UNAUTH.mkdir(parents=True, exist_ok=True)
SESSIONS_BY_USER.mkdir(parents=True, exist_ok=True)
GROUPS_DIR.mkdir(parents=True, exist_ok=True)


def resolve_session_path(file_str: str) -> Path:
    if not file_str or not isinstance(file_str, str):
        return SESSIONS_ACTIVE / (file_str or "")
    if file_str.startswith("users/") or file_str.replace("\\", "/").startswith("users/"):
        return SESSIONS_DIR / file_str.lstrip("/").replace("\\", "/")
    return SESSIONS_ACTIVE / file_str


def setup_logging() -> None:
    log_file = LOGS_DIR / "adbot.log"
    file_handler = logging.handlers.TimedRotatingFileHandler(
        log_file,
        when="midnight",
        interval=1,
        backupCount=7,
        encoding="utf-8",
    )
    file_handler.suffix = "%Y-%m-%d"
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    for h in (file_handler, console_handler):
        h.setFormatter(logging.Formatter(fmt, datefmt=datefmt))
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        datefmt=datefmt,
        handlers=[file_handler, console_handler],
    )
    # Suppress httpx HTTP request spam (every getUpdates poll)
    logging.getLogger("httpx").setLevel(logging.WARNING)
