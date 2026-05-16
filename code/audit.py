"""
Admin action audit logging.
Every admin action logs: admin_id, action, target, timestamp (and optional extra).
Stored in data/admin_audit.json (append-only list, last N entries).
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

logger = logging.getLogger(__name__)

AUDIT_FILE = config.DATA_DIR / "admin_audit.json"
MAX_AUDIT_ENTRIES = 2000


def log_admin_action(admin_id: int | str, action: str, target: str | None = None, **extra: Any) -> None:
    """
    Append one audit entry. admin_id can be Telegram user id or "main_loop" for job-driven actions.
    action: e.g. mark_paid, cancel_order, extend_plan, transfer_ownership, emergency_stop, emergency_resume, maintenance_on, maintenance_off.
    target: order_id, bot_username, user_id, etc.
    """
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "admin_id": admin_id,
        "action": action,
        "target": target,
        **{k: v for k, v in extra.items() if v is not None},
    }
    try:
        AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {"entries": []}
        if AUDIT_FILE.exists():
            try:
                data = json.loads(AUDIT_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        if not isinstance(data, dict):
            data = {"entries": []}
        data.setdefault("entries", []).append(entry)
        data["entries"] = data["entries"][-MAX_AUDIT_ENTRIES:]
        AUDIT_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning("Audit log write failed: %s", e)
