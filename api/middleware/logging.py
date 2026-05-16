"""Request/response logging middleware for API observability."""
import time
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("api.access")


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
        elif status >= 400:
            logger.warning("%s %s → %d [%sms]", method, path, status, elapsed_ms)
        else:
            logger.info("%s %s → %d [%sms]", method, path, status, elapsed_ms)

        response.headers["X-Response-Time"] = f"{elapsed_ms}ms"
        return response
