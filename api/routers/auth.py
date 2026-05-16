"""Authentication endpoints: login, refresh, me."""
from fastapi import APIRouter, HTTPException, Depends, status

from api.auth import (
    authenticate_admin,
    create_access_token,
    create_refresh_token,
    decode_token,
    ACCESS_TOKEN_EXPIRE_SEC,
)
from api.deps import get_current_admin
from api.schemas import LoginRequest, TokenResponse, RefreshRequest, AdminInfo

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    if not authenticate_admin(body.username, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    return TokenResponse(
        access_token=create_access_token(body.username),
        refresh_token=create_refresh_token(body.username),
        expires_in=ACCESS_TOKEN_EXPIRE_SEC,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest):
    payload = decode_token(body.refresh_token)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )
    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )
    username = payload["sub"]
    return TokenResponse(
        access_token=create_access_token(username),
        refresh_token=create_refresh_token(username),
        expires_in=ACCESS_TOKEN_EXPIRE_SEC,
    )


@router.get("/me", response_model=AdminInfo)
async def me(admin: dict = Depends(get_current_admin)):
    return AdminInfo(username=admin["username"])
