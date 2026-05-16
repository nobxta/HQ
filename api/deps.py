"""FastAPI dependencies: auth guards, common parameters."""
from fastapi import Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from api.auth import decode_token

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
