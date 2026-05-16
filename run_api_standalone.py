"""Standalone API server (without bot system). For development/testing only.
Usage: python run_api_standalone.py
Or: uvicorn api.app:app --host 0.0.0.0 --port 8000 --reload
"""
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

import uvicorn


def main():
    from api.utils import get_api_port, get_api_host

    uvicorn.run(
        "api.app:app",
        host=get_api_host(),
        port=get_api_port(),
        reload=True,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    main()
