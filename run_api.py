"""Unified entry point: starts existing bot system + FastAPI on the same event loop.
Usage: python run_api.py
This replaces 'python main.py' when you want both Telegram bots AND web API running together.
"""
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

import asyncio
import logging
import uvicorn

logger = logging.getLogger(__name__)


def main():
    from api.app import app
    from api.utils import get_api_port, get_api_host

    config = uvicorn.Config(
        app=app,
        host=get_api_host(),
        port=get_api_port(),
        log_level="info",
        access_log=False,
        ws_max_size=16 * 1024 * 1024,
    )
    server = uvicorn.Server(config)

    async def run_all():
        from main import main as bot_main

        bot_task = asyncio.create_task(bot_main(), name="bot_system_main")
        api_task = asyncio.create_task(server.serve(), name="uvicorn_api")

        logger.info("Starting TAdbot system + API on port %d", get_api_port())

        try:
            await asyncio.gather(bot_task, api_task)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            server.should_exit = True
            bot_task.cancel()
            try:
                await asyncio.wait_for(bot_task, timeout=15.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

    try:
        asyncio.run(run_all())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
