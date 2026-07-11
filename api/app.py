"""FastAPI application: mounts all routers, middleware, and lifespan.
Run standalone: uvicorn api.app:app --host 0.0.0.0 --port 8000
Run with existing bot system: python run_api.py (starts main() + API together)
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.utils import get_cors_origins
from api.runtime.state import set_main_loop, mark_api_started
from api.middleware.logging import RequestLoggingMiddleware
from api.middleware.security import RateLimitMiddleware, SecurityHeadersMiddleware

from api.routers import auth, dashboard, bots, sessions, orders, groups, users, system, broadcast, user_portal, session_client, coupons, dm_inbox
from api.websocket import router as ws_router

logger = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle. Registers the running event loop for cross-module access."""
    loop = asyncio.get_running_loop()
    set_main_loop(loop)
    mark_api_started()
    logger.info("API layer started on loop %s", id(loop))
    yield
    logger.info("API layer shutting down")


app = FastAPI(
    title="TAdbot API",
    description="REST + WebSocket API overlay for the TAdbot Telegram advertising system",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# CORS
origins = get_cors_origins()
if origins == ["*"]:
    # Wildcard + credentials is forbidden by CORS spec; use regex to allow all
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Custom middleware (order: last added = first executed)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# REST routers
app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(bots.router)
app.include_router(sessions.router)
app.include_router(orders.router)
app.include_router(groups.router)
app.include_router(users.router)
app.include_router(system.router)
app.include_router(coupons.router)
app.include_router(dm_inbox.router)
app.include_router(broadcast.router)
app.include_router(user_portal.router)
app.include_router(session_client.router)

# WebSocket router
app.include_router(ws_router)


@app.get("/api/ping")
async def ping():
    return {"status": "ok", "service": "tadbot-api"}
