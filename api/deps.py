"""FastAPI dependencies: auth guards, common parameters."""
from urllib.parse import unquote

from fastapi import Depends, HTTPException, status, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from api.auth import decode_token, WEB_ADMIN_USER

_bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_admin(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> dict:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if payload.get("type") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )
    return {"username": payload["sub"]}


# ── Portal auth gate ───────────────────────────────────────────────────────────
# The portal router mixes public (pre-login / webhook) routes with user routes that
# were historically "authorized" only by a client-supplied ?telegram_id — a broken
# access control (any user could act on any bot). This gate is deny-by-default:
# unless a path is explicitly public, it requires a valid portal token whose subject
# (user:{owner_id}:{bot_name}) matches the bot in the path and the telegram_id in the
# query. /admin/* portal routes require an admin token.

# Exact public paths (no auth): pre-login and machine callbacks.
_PORTAL_PUBLIC_EXACT = {
    "/api/portal/login",
    "/api/portal/login-token",
    "/api/portal/unified-login",
    "/api/portal/plans",
    "/api/portal/currencies",
    "/api/portal/crypto/currencies",
    "/api/portal/payment/ipn",
}
# Public path prefixes (whole subtree is pre-login): coupon validation + purchase flow.
_PORTAL_PUBLIC_PREFIXES = (
    "/api/portal/coupon/",
    "/api/portal/purchase/",
)


def _portal_path_bot(path: str) -> str | None:
    """Extract the bot_name segment from a portal URL path, if present, so the gate
    doesn't depend on FastAPI having populated request.path_params yet."""
    segs = [s for s in path.split("/") if s]
    try:
        i = segs.index("portal")
    except ValueError:
        return None
    rest = segs[i + 1:]
    if not rest:
        return None
    if rest[0] == "bot" and len(rest) >= 2:
        return unquote(rest[1])
    if rest[0] in ("generate-web-token", "web-token") and len(rest) >= 2:
        return unquote(rest[1])
    return None


async def enforce_portal_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> None:
    if request.method == "OPTIONS":
        return
    path = request.url.path
    if path in _PORTAL_PUBLIC_EXACT or any(path.startswith(p) for p in _PORTAL_PUBLIC_PREFIXES):
        return

    payload = decode_token(credentials.credentials) if credentials else None

    # Admin-only portal routes (bot-token pool, support ticket triage).
    if path.startswith("/api/portal/admin/"):
        if not payload or payload.get("type") != "access" or payload.get("sub") != WEB_ADMIN_USER:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
        return

    # Everything else: a valid portal user token is required.
    if credentials is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Missing authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if payload is None or payload.get("type") != "access":
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    sub = str(payload.get("sub") or "")
    # An admin token may act on any user route (oversight/support).
    if sub == WEB_ADMIN_USER:
        return
    parts = sub.split(":", 2)
    if len(parts) != 3 or parts[0] != "user":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid token subject")
    token_owner, token_bot = parts[1], parts[2]

    # The token is bound to ONE bot: reject if the path targets a different bot.
    path_bot = _portal_path_bot(path)
    if path_bot is not None and path_bot.strip().lower() != token_bot.strip().lower():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Token is not valid for this bot")

    # The token is bound to ONE owner: reject a mismatched ?telegram_id (the old IDOR).
    q_tid = request.query_params.get("telegram_id")
    if q_tid is not None and str(q_tid).strip() != str(token_owner).strip():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Token does not match this account")


def validate_ws_token(token: str) -> bool:
    """Validate token for WebSocket connections."""
    payload = decode_token(token)
    if payload is None:
        return False
    if payload.get("type") != "access":
        return False
    return True


class Pagination:
    def __init__(
        self,
        page: int = Query(1, ge=1, description="Page number"),
        per_page: int = Query(50, ge=1, le=200, description="Items per page"),
    ):
        self.page = page
        self.per_page = per_page
        self.offset = (page - 1) * per_page
