"""Repair sessions whose validation was corrupted by the busy->invalid bug.

Before the fix, `POST /api/bots/{name}/sessions/{file}/validate` collapsed a
"session is busy / in use by posting" SKIP into a persisted `validation_status =
"invalid"` on the bot config. That made a healthy, in-use session render as Dead.

This script clears ONLY those falsely-invalid entries:
    validation_status == "invalid"
    AND validation_reason contains "is busy:" OR "in use by posting"

It removes `validation_status`, `validation_reason` and `last_validated_at` from
the affected session entry, returning it to the un-validated state. It is pure
local config cleanup — it never connects to Telegram, never touches .session
files, the pool, or lock files.

Usage:
    python scripts/repair_busy_validation.py            # dry-run (report only)
    python scripts/repair_busy_validation.py --apply     # write the changes
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from code import config
from code.utils import _file_lock, _loads, _dumps  # reuse the same atomic-write primitives

_BUSY_MARKERS = ("is busy:", "in use by posting")


def _is_falsely_invalid(entry: dict) -> bool:
    if entry.get("validation_status") != "invalid":
        return False
    reason = (entry.get("validation_reason") or "").lower()
    return any(m in reason for m in _BUSY_MARKERS)


def repair(apply: bool) -> int:
    user_dir = config.DATA_USER_DIR
    if not user_dir.is_dir():
        print(f"No user config dir at {user_dir}")
        return 0

    total_changed = 0
    for path in sorted(user_dir.glob("*.json")):
        try:
            data = _loads(path.read_bytes())
        except Exception as e:
            print(f"skip {path.name}: unreadable ({e})")
            continue
        if not isinstance(data, dict):
            continue

        changed_files: list[str] = []
        for entry in data.get("sessions", []) or []:
            if not isinstance(entry, dict):
                continue
            if _is_falsely_invalid(entry):
                changed_files.append(entry.get("file", "?"))
                if apply:
                    entry.pop("validation_status", None)
                    entry.pop("validation_reason", None)
                    entry.pop("last_validated_at", None)

        if not changed_files:
            continue

        total_changed += len(changed_files)
        bot = data.get("name", path.stem)
        verb = "cleared" if apply else "would clear"
        print(f"[{bot}] {verb} {len(changed_files)} session(s): {', '.join(changed_files)}")

        if apply:
            with _file_lock(path):
                tmp = path.parent / (path.name + ".repair.tmp")
                tmp.write_bytes(_dumps(data))
                os.replace(tmp, path)

    mode = "APPLIED" if apply else "DRY-RUN (no files written)"
    print(f"\n{mode}: {total_changed} falsely-invalid session entr(y/ies) across all bots.")
    if not apply and total_changed:
        print("Re-run with --apply to write the changes.")
    return total_changed


if __name__ == "__main__":
    repair(apply="--apply" in sys.argv)
