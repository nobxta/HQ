"""Request/response logging middleware for API observability."""
import time
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("api.access")

# Automated vulnerability scanners constantly probe public hosts for PHP/WordPress/config
# files that don't exist here (a Python/Next app). Their 404s are harmless noise, so they're
# logged at DEBUG instead of WARNING. A genuine missing API route still logs at WARNING.
_PROBE_SUFFIXES = (".php", ".asp", ".aspx", ".jsp", ".cgi", ".env", ".ini", ".sql", ".bak", ".old", ".cfg")
_PROBE_PREFIXES = ("/wp-", "/.git", "/.env", "/vendor/", "/cgi-bin/", "/.aws", "/.ssh")


def _is_scanner_probe(path: str) -> bool:
    p = path.lower()
    return p.endswith(_PROBE_SUFFIXES) or any(p.startswith(pre) for pre in _PROBE_PREFIXES)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        start = time.time()
        method = request.method
        path = request.url.path

        response = await call_next(request)

        elapsed_ms = round((time.time() - start) * 1000, 1)
        status = response.status_code

        if path.startswith("/ws"):
            logger.debug("%s %s → %d (WebSocket upgrade)", method, path, status)
        elif status >= 500:
            logger.error("%s %s → %d [%sms]", method, path, status, elapsed_ms)
        elif status == 404 and _is_scanner_probe(path):
            logger.debug("%s %s → 404 (scanner probe) [%sms]", method, path, elapsed_ms)
        elif status >= 400:
            logger.warning("%s %s → %d [%sms]", method, path, status, elapsed_ms)
        else:
            logger.info("%s %s → %d [%sms]", method, path, status, elapsed_ms)

        response.headers["X-Response-Time"] = f"{elapsed_ms}ms"
        return response
