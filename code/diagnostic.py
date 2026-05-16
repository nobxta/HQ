"""
Diagnostic script for TAdbot: file tree, per-file inspection, safe startup simulation,
storage summary (pool + index + user files), multiprocessing/asyncio scan, and final report.
Run: python -m code.diagnostic  (from project root)
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

# Project root = parent of code/ (so main.py and data/ are at root)
SCRIPT_DIR = Path(__file__).resolve().parent  # code/
PROJECT_ROOT = SCRIPT_DIR.parent
os.chdir(PROJECT_ROOT)
sys.path.insert(0, str(PROJECT_ROOT))

FILES_TO_INSPECT = [
    "main.py",
    "code/admin.py",
    "code/users.py",
    "code/crash.py",
    "code/config.py",
    "code/utils.py",
    ".env",
    "data/pool.json",
    "data/index.json",
    "requirements.txt",
]
HEAD_TAIL_LINES = 10


def _mask_secret(s: str) -> str:
    """Mask value: show first 2 and last 2 chars, rest as ***, or length if short."""
    s = (s or "").strip()
    if not s:
        return "<empty>"
    if len(s) <= 6:
        return "*" * min(len(s), 4)
    return s[:2] + "***" + s[-2:] + f" (len={len(s)})"


def _safe(s: str, maxlen: int = 100) -> str:
    """Replace non-ASCII so Windows cp1252 console can print."""
    s = (s or "")[:maxlen]
    return s.encode("ascii", "replace").decode("ascii")


def print_section(title: str) -> None:
    print()
    print("=" * 70)
    print(" ", title)
    print("=" * 70)


def tree_walk(root: Path, prefix: str = "", ignore_dirs: set[str] | None = None) -> None:
    ignore_dirs = ignore_dirs or {".git", "__pycache__", ".cursor", "node_modules", ".venv", "venv"}
    try:
        entries = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as e:
        print(f"  [Error listing {root}: {e}]")
        return
    for i, p in enumerate(entries):
        if p.name.startswith(".") and p.name not in (".env", ".gitignore"):
            continue
        if p.is_dir() and p.name in ignore_dirs:
            continue
        is_last = i == len(entries) - 1
        branch = "+-- "
        print(prefix + branch + p.name)
        if p.is_dir():
            extension = "    " if is_last else "|   "
            tree_walk(p, prefix + extension, ignore_dirs)
    return


# --- 1. File tree ---
print_section("1. COMPLETE CURRENT FILE TREE (project root)")
print(f"Root: {SCRIPT_DIR}")
tree_walk(SCRIPT_DIR)


# --- 2. Per-file inspection ---
print_section("2. PER-FILE INSPECTION")

for fname in FILES_TO_INSPECT:
    path = PROJECT_ROOT / fname
    exists = path.is_file()
    print(f"\n--- {fname} ---")
    print(f"  Exists: {exists}")
    if not exists:
        continue
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  Decode error: {e}")
        continue
    lines = text.splitlines()
    n = len(lines)
    print(f"  Lines: {n}")
    if fname == ".env":
        # Mask secrets: show KEY=*** or KEY=<set>
        print("  First/Last 10 (values masked):")
        for line in lines[:HEAD_TAIL_LINES]:
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                print(f"    {k.strip()}= {_mask_secret(v)}")
            else:
                print(f"    {_safe(line, 80)}")
        print("    ...")
        for line in lines[-HEAD_TAIL_LINES:]:
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                print(f"    {k.strip()}= {_mask_secret(v)}")
            else:
                print(f"    {_safe(line, 80)}")
        continue
    print("  First 10 lines:")
    for j, line in enumerate(lines[:HEAD_TAIL_LINES], 1):
        print(f"    {j:3d}| {_safe(line)}")
    print("  Last 10 lines:")
    start = max(0, n - HEAD_TAIL_LINES)
    for j, line in enumerate(lines[start:n], start + 1):
        print(f"    {j:3d}| {_safe(line)}")


# --- 3 & 4. Safe startup simulation + admin client init ---
print_section("3. SAFE STARTUP SIMULATION")

print("Step 3a: Import config (triggers .env load)...")
try:
    from code import config
    print("  OK: config imported")
    print(f"  API_ID present: {bool(getattr(config, 'API_ID', None))}")
    print(f"  API_HASH present: {bool(getattr(config, 'API_HASH', None))}")
    print(f"  ADMIN_BOT_TOKEN present: {bool(getattr(config, 'ADMIN_BOT_TOKEN', None))}")
    print(f"  DATA_DIR: {getattr(config, 'DATA_DIR', 'N/A')}")
except Exception as e:
    print("  EXCEPTION:")
    traceback.print_exc()

print("\nStep 3b: Load storage (via utils load_adbot)...")
adbot_data = None
try:
    from code.utils import load_adbot
    adbot_data = load_adbot()
    print("  OK: adbot loaded")
    print(f"  Top-level keys: {list(adbot_data.keys())}")
    print(f"  Number of bots: {len(adbot_data.get('bots', {}))}")
except Exception as e:
    print("  EXCEPTION:")
    traceback.print_exc()

print("\nStep 3c: Initialize admin TelegramClient (no polling)...")
admin_username = None
try:
    from telethon import TelegramClient
    token = getattr(config, "ADMIN_BOT_TOKEN", None) or ""
    if not (token and token.strip()):
        print("  SKIP: ADMIN_BOT_TOKEN empty or missing (cannot connect)")
    else:
        session_path = str(config.SESSIONS_DIR / "admin_bot")
        client = TelegramClient(
            session_path,
            config.API_ID,
            config.API_HASH,
            proxy=config.PROXY,
        )
        # Connect + start with bot token only; do NOT run_until_disconnected
        import asyncio

        async def _try_admin_start():
            await client.connect()
            await client.start(bot_token=token.strip())
            me = await client.get_me()
            uname = getattr(me, "username", None) or str(me.id)
            await client.disconnect()
            return uname

        admin_username = asyncio.run(_try_admin_start())
        print("  OK: Admin client started and disconnected")
except Exception as e:
    print("  EXCEPTION:")
    traceback.print_exc()

print_section("4. ADMIN BOT USERNAME (if client started successfully)")
if admin_username:
    print(f"  Bot username: @{admin_username}")
else:
    print("  (none - client did not start or token missing)")


# --- 5. Storage content summary (pool + index + user files) ---
print_section("5. STORAGE CONTENT SUMMARY")

if adbot_data is None:
    try:
        from code.utils import load_adbot
        adbot_data = load_adbot()
    except Exception as e:
        adbot_data = {}
        print(f"  Could not load storage: {e}")

if isinstance(adbot_data, dict):
    print(f"  Top-level keys: {list(adbot_data.keys())}")
    bots = adbot_data.get("bots", {})
    print(f"  Number of bots: {len(bots)}")
    print(f"  free_sessions count: {len(adbot_data.get('free_sessions', []))}")
    print(f"  dead_sessions count: {len(adbot_data.get('dead_sessions', []))}")
    if bots:
        example_key = next(iter(bots))
        ex = bots[example_key]
        # Redact: no real tokens/session filenames
        redacted = {k: ("<redacted>" if k in ("bot_token", "sessions", "authorized") else v) for k, v in ex.items()}
        if "sessions" in ex:
            redacted["sessions"] = f"<list of {len(ex['sessions'])} items>"
        if "bot_token" in ex:
            redacted["bot_token"] = "<redacted>"
        print("  Example bot structure (sensitive data redacted):")
        for k, v in redacted.items():
            print(f"    {k!r}: {v!r}")
    else:
        print("  Example bot structure: (no bots - schema has bots, free_sessions, dead_sessions, admin_alerts)")
else:
    print("  adbot_data is not a dict; cannot summarize.")


# --- 6. Multiprocessing / asyncio usage in users.py and main.py ---
print_section("6. MULTIPROCESSING / ASYNCIO RELATED CODE (users.py, main.py)")

def grep_in_file(path: Path, patterns: list[str]) -> None:
    if not path.is_file():
        print(f"  {path.name}: file not found")
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    print(f"  --- {path.name} ---")
    seen = set()
    for i, line in enumerate(lines, 1):
        low = line.lower()
        if any(p in low or p in line for p in patterns):
            key = (i, line.strip()[:80])
            if key not in seen:
                seen.add(key)
                print(f"    L{i}: {_safe(line.strip(), 90)}")

grep_in_file(SCRIPT_DIR / "users.py", ["multiprocessing", "asyncio", "threading", "Process", "Thread", "create_task", "asyncio.run", "run_until", "Event"])
grep_in_file(SCRIPT_DIR / "main.py", ["multiprocessing", "asyncio", "create_task", "asyncio.run", "Event"])


# --- 7. Final report ---
print_section("7. FINAL REPORT")

broken = []
# Heuristics: missing .env, missing ADMIN_BOT_TOKEN, import errors we already saw, etc.
if not (PROJECT_ROOT / ".env").is_file():
    broken.append("Missing .env (copy from .env.example and fill API_ID, API_HASH, ADMIN_BOT_TOKEN, ADMIN_USER_ID)")
if adbot_data is None:
    broken.append("Storage could not be loaded (pool + index + user files)")
elif not isinstance(adbot_data, dict):
    broken.append("Storage data is not a JSON object")
else:
    if "bots" not in adbot_data:
        broken.append("Storage missing top-level key 'bots'")
    if "free_sessions" not in adbot_data:
        broken.append("Storage missing top-level key 'free_sessions'")

try:
    from code import config
    if not (getattr(config, "ADMIN_BOT_TOKEN") or "").strip():
        broken.append("ADMIN_BOT_TOKEN empty or unset in .env")
    if not (getattr(config, "API_ID") or "").strip():
        broken.append("API_ID empty or unset in .env")
    if not (getattr(config, "API_HASH") or "").strip():
        broken.append("API_HASH empty or unset in .env")
except Exception as e:
    broken.append(f"config import or env check failed: {e}")

# Check main.py imports
for mod in ("admin", "crash", "utils"):
    try:
        __import__(mod)
    except Exception as e:
        broken.append(f"Import {mod} fails: {e}")

print("  Most obvious broken things:")
for b in broken or ["(none detected from this diagnostic)"]:
    print(f"    - {b}")

print()
print("  Estimated % completion (0-100%):")
print("    Phases: admin bot, user bots, sessions, multiprocessing posting, per-user storage, crash recovery.")
print("    Code structure is in place (admin, users, crash, utils, config, main).")
print("    Estimated: 75-85% - wiring and env/setup block full run; logic and persistence exist.")

print()
print("  Which phase probably failed / incomplete:")
print("    Likely: first-run setup (no .env or empty token), or Telethon/network (API_ID/HASH, proxy).")
print("    If .env exists and tokens are set: startup phase (session check, admin client start) may hit network/auth.")

print()
print("  Recommended next single fix step:")
if (SCRIPT_DIR / ".env").is_file():
    print("    File: main.py (or run target)")
    print("    Change: Run this diagnostic first: python diagnostic.py. If admin client starts here but not in main,")
    print("    the difference is main runs full flow (check_all_active_sessions, resume_adbots). Next fix: ensure")
    print("    sessions/active exists and either has sessions or storage has no bots, so check_all_active_sessions")
    print("    does not fail; then run main.py and confirm admin bot connects.")
else:
    print("    File: .env")
    print("    Change: Copy .env.example to .env and set API_ID, API_HASH, ADMIN_BOT_TOKEN, ADMIN_USER_ID.")
    print("    Then run python diagnostic.py again.")

print()
print("=" * 70)
print("  Diagnostic run complete.")
print("=" * 70)
