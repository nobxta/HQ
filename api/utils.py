"""API utility functions."""
import os


def get_api_port() -> int:
    return int(os.getenv("API_PORT") or os.getenv("SERVER_PORT") or "8000")


def get_api_host() -> str:
    return os.getenv("API_HOST", "0.0.0.0")


def get_cors_origins() -> list[str]:
    origins = os.getenv("CORS_ORIGINS", "*")
    if origins == "*":
        return ["*"]
    return [o.strip() for o in origins.split(",") if o.strip()]


def get_api_workers() -> int:
    return int(os.getenv("API_WORKERS", "1"))
