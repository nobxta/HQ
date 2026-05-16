"""Security middleware: rate limiting, IP filtering, security headers."""
import time
import logging
from collections import defaultdict
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response, JSONResponse

logger = logging.getLogger("api.security")

RATE_LIMIT_PER_MINUTE = 120
RATE_LIMIT_AUTH_PER_MINUTE = 10

_request_counts: dict[str, list[float]] = defaultdict(list)


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _prune_old(timestamps: list[float], window: float = 60.0) -> list[float]:
    now = time.time()
    return [t for t in timestamps if now - t < window]


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path.startswith("/ws"):
            return await call_next(request)

        ip = _get_client_ip(request)
        key = f"{ip}:{request.url.path}" if "/auth/" in request.url.path else ip

        limit = RATE_LIMIT_AUTH_PER_MINUTE if "/auth/" in request.url.path else RATE_LIMIT_PER_MINUTE

        _request_counts[key] = _prune_old(_request_counts[key])

        if len(_request_counts[key]) >= limit:
            logger.warning("Rate limit hit: %s (%d req/min)", key, len(_request_counts[key]))
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Try again later."},
                headers={"Retry-After": "60"},
            )

        _request_counts[key].append(time.time())
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cache-Control"] = "no-store"
        return response
