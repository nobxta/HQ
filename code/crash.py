"""Crash recovery: on start, resume running AdBots."""
import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from . import config
from .users import create_user_bot, _start_posting, cleanup_active_sessions_for_bot

logger = logging.getLogger(__name__)

EMERGENCY_STOPPED_FILE = config.DATA_DIR / "emergency_stopped.json"


def _load_emergency_stopped_tokens() -> set[str]:
    """Tokens that were emergency-stopped; must not auto-resume posting after restart."""
    if not EMERGENCY_STOPPED_FILE.exists():
        return set()
    try:
        data = json.loads(EMERGENCY_STOPPED_FILE.read_text(encoding="utf-8"))
        tokens = data.get("tokens") or []
        return set(t for t in tokens if t)
    except Exception as e:
        logger.warning("Could not load emergency_stopped.json: %s", e)
        return set()


def _valid_till(cfg: dict) -> bool:
    """True if valid_till is empty or parsed date is in the future."""
    vt = cfg.get("valid_till", "")
    if not vt:
        return True
    try:
        end = datetime.strptime(vt, "%d/%m/%Y")
        return datetime.now() <= end
    except ValueError:
        return True


async def resume_adbots(data: dict) -> None:
    """On start: load storage (data from main), for each bot start user client;
    if state==running and valid_till ok, start posting. Skip dead bots.
    Bots listed in emergency_stopped.json are not started for posting (persistence across restarts).
    """
    bots = data.get("bots", {})
    if not bots:
        logger.info("Resume: no bots in storage")
        return
    emergency_stopped = _load_emergency_stopped_tokens()
    if emergency_stopped:
        logger.info("Resume: %s bot(s) in emergency_stopped.json will not auto-start posting", len(emergency_stopped))
    for bot_token, cfg in bots.items():
        if not bot_token or not isinstance(cfg, dict):
            continue
        if cfg.get("state") in ("dead", "expired"):
            logger.info("Resume: skipping %s bot %s", cfg.get("state"), cfg.get("name") or bot_token[:20])
            continue
        try:
            asyncio.create_task(create_user_bot(bot_token))
        except Exception as e:
            logger.warning("Resume: could not start user bot %s: %s", (cfg.get("name") or bot_token[:20]), e)
            continue
        if bot_token in emergency_stopped:
            logger.info("Resume: skipping posting for %s (emergency stopped)", cfg.get("name") or bot_token[:20])
            continue
        if cfg.get("state") == "running" and _valid_till(cfg):
            try:
                cleanup_active_sessions_for_bot(bot_token)
                # preserve_cycle_time=True: keep the existing cycle anchor across the restart so the
                # scheduler resumes the interrupted cycle (skipping already-posted groups) when the
                # downtime is shorter than one cycle, and only starts a fresh cycle when the downtime
                # spanned a full cycle boundary. A fresh user "Run" still resets the anchor.
                started = await _start_posting(bot_token, preserve_cycle_time=True)
                if started:
                    logger.info("Resume: started posting for %s", cfg.get("name") or bot_token[:20])
                else:
                    logger.debug("Resume: no posting workers for %s (no sessions?)", cfg.get("name") or bot_token[:20])
            except Exception as e:
                logger.warning("Resume: could not start posting for %s: %s", cfg.get("name") or bot_token[:20], e)
    logger.info("Resume: %s bot(s) loaded", len(bots))
