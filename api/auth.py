"""JWT authentication: encode, decode, verify. Uses HS256 with .env secrets."""
import os
import time
from pathlib import Path
from typing import Optional

import jwt
import bcrypt

# Ensure .env is loaded before reading env vars
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production-64-chars-minimum-secret-key")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_SEC = 86400  # 24 hours
REFRESH_TOKEN_EXPIRE_SEC = 2592000  # 30 days
PORTAL_ACCESS_TOKEN_EXPIRE_SEC = 7776000  # 90 days
PORTAL_REFRESH_TOKEN_EXPIRE_SEC = 15552000  # 180 days

WEB_ADMIN_USER = os.getenv("WEB_ADMIN_USER", "admin")
WEB_ADMIN_PASS_HASH = os.getenv("WEB_ADMIN_PASS_HASH", "")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not hashed_password:
        return False
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"),
            hashed_password.encode("utf-8"),
        )
    except Exception:
        return False


def hash_password(plain_password: str) -> str:
    return bcrypt.hashpw(
        plain_password.encode("utf-8"),
        bcrypt.gensalt(),
    ).decode("utf-8")


def create_access_token(username: str) -> str:
    payload = {
        "sub": username,
        "type": "access",
        "iat": int(time.time()),
        "exp": int(time.time()) + ACCESS_TOKEN_EXPIRE_SEC,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(username: str) -> str:
    payload = {
        "sub": username,
        "type": "refresh",
        "iat": int(time.time()),
        "exp": int(time.time()) + REFRESH_TOKEN_EXPIRE_SEC,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_portal_access_token(subject: str) -> str:
    payload = {
        "sub": subject,
        "type": "access",
        "iat": int(time.time()),
        "exp": int(time.time()) + PORTAL_ACCESS_TOKEN_EXPIRE_SEC,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_portal_refresh_token(subject: str) -> str:
    payload = {
        "sub": subject,
        "type": "refresh",
        "iat": int(time.time()),
        "exp": int(time.time()) + PORTAL_REFRESH_TOKEN_EXPIRE_SEC,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def authenticate_admin(username: str, password: str) -> bool:
    if username != WEB_ADMIN_USER:
        return False
    return verify_password(password, WEB_ADMIN_PASS_HASH)
