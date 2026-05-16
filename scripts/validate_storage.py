"""
End-to-end validation of per-user JSON storage.
Run from project root: python scripts/validate_storage.py
Tests creation, loading, updates, delete, and logging without Telegram connections.
"""
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Ensure project root is in path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
os.chdir(PROJECT_ROOT)

# Use a temporary data dir for validation to avoid polluting real data
VALIDATION_DIR = Path(tempfile.mkdtemp(prefix="adbot_validation_"))
print(f"Validation using temp dir: {VALIDATION_DIR}")

# Patch config to use validation dir
import code.config as config
original_data_dir = config.DATA_DIR
config.DATA_DIR = VALIDATION_DIR / "data"
config.DATA_USER_DIR = config.DATA_DIR / "user"
config.DATA_LOGS_DIR = config.DATA_DIR / "logs"
config.DATA_INDEX_FILE = config.DATA_DIR / "index.json"
config.DATA_POOL_FILE = config.DATA_DIR / "pool.json"

# Create dirs
config.DATA_DIR.mkdir(parents=True, exist_ok=True)
config.DATA_USER_DIR.mkdir(parents=True, exist_ok=True)
config.DATA_LOGS_DIR.mkdir(parents=True, exist_ok=True)

# Create a fake session file so pool operations work
config.SESSIONS_ACTIVE.mkdir(parents=True, exist_ok=True)
FAKE_SESSION = "fake_validation.session"
(config.SESSIONS_ACTIVE / FAKE_SESSION).write_bytes(b"fake")  # Not a real session, just for file existence

bugs = []
fixes = []


def ok(msg: str) -> None:
    print(f"  [OK] {msg}")


def fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")
    bugs.append(msg)


def test_name_to_filename():
    print("\n--- 1. name_to_filename ---")
    from code.utils import name_to_filename
    assert name_to_filename("Nobi") == "nobi"
    assert name_to_filename("Rahul-K") == "rahul-k"  # hyphen kept (in "_-")
    assert name_to_filename("Test User") == "test_user"
    ok("name_to_filename sanitizes correctly")


def test_create_flow():
    print("\n--- 2. Creation Flow Simulation ---")
    from code.utils import (
        save_user_data, load_index, save_index, load_pool, save_pool,
        name_to_filename, load_user_data, get_name_by_token
    )
    # Simulate creating two bots (without Telegram)
    pool = load_pool()
    pool["free_sessions"] = [FAKE_SESSION, "another.session"]
    (config.SESSIONS_ACTIVE / "another.session").write_bytes(b"fake")
    save_pool(pool)

    # Bot 1: nobi
    entry1 = {
        "name": "Nobi",
        "bot_token": "111:AAfake1",
        "bot_username": "nobi_bot",
        "valid_till": "01/01/2027",
        "cycle": 300,
        "gap": 5,
        "mode": "Enterprise",
        "group_file": "Starter.txt",
        "log_group": "https://t.me/adbot_xxx",
        "log_file": "data/logs/nobi.log",
        "authorized": [],
        "sessions": [{"file": FAKE_SESSION, "real_name": "Fake", "user_id": 1, "index": 1}],
        "state": "stopped",
        "last_cycle_time": {},
    }
    safe_name1 = name_to_filename("Nobi")
    save_user_data(safe_name1, entry1)
    index = load_index()
    index.setdefault("by_token", {})["111:AAfake1"] = safe_name1
    index.setdefault("by_name", {})[safe_name1] = "111:AAfake1"
    save_index(index)
    pool["free_sessions"] = ["another.session"]
    save_pool(pool)

    if not (config.DATA_USER_DIR / "nobi.json").exists():
        fail("data/user/nobi.json was not created")
    else:
        ok("data/user/nobi.json created")

    if "111:AAfake1" not in load_index().get("by_token", {}):
        fail("index.json by_token not updated")
    else:
        ok("index.json by_token updated")

    if FAKE_SESSION in load_pool().get("free_sessions", []):
        fail("pool.json free_sessions still contains assigned session")
    else:
        ok("pool.json free_sessions updated (session removed)")

    cfg = load_user_data("nobi")
    if cfg and cfg.get("log_file") != "data/logs/nobi.log":
        fail(f"log_file incorrect: {cfg.get('log_file')}")
    else:
        ok("log_file stored as data/logs/nobi.log")

    # Bot 2: rahul
    entry2 = {**entry1, "name": "Rahul", "bot_token": "222:AAfake2", "bot_username": "rahul_bot",
              "log_file": "data/logs/rahul.log", "sessions": [{"file": "another.session", "real_name": "Fake2", "user_id": 2, "index": 1}]}
    save_user_data("rahul", entry2)
    index = load_index()
    index["by_token"]["222:AAfake2"] = "rahul"
    index["by_name"]["rahul"] = "222:AAfake2"
    save_index(index)
    pool = load_pool()
    pool["free_sessions"] = []
    save_pool(pool)

    if not (config.DATA_USER_DIR / "rahul.json").exists():
        fail("data/user/rahul.json was not created")
    else:
        ok("data/user/rahul.json created")


def test_get_cfg():
    print("\n--- 3. Runtime Config Loading (_get_cfg) ---")
    from code.users import _get_cfg
    cfg1 = _get_cfg("111:AAfake1")
    if cfg1 is None or cfg1.get("name") != "Nobi":
        fail(f"_get_cfg returned wrong data: {cfg1}")
    else:
        ok("_get_cfg loads from correct user file")
    cfg2 = _get_cfg("222:AAfake2")
    if cfg2 is None or cfg2.get("name") != "Rahul":
        fail(f"_get_cfg for bot2 failed: {cfg2}")
    else:
        ok("_get_cfg loads multiple users correctly")
    if _get_cfg("999:nonexistent") is not None:
        fail("_get_cfg should return None for unknown token")
    else:
        ok("_get_cfg returns None for unknown token")


def test_save_bot_config():
    print("\n--- 4. Runtime Updates (_save_bot_config) ---")
    from code.users import _save_bot_config, _get_cfg
    result = _save_bot_config("111:AAfake1", lambda c: c.update({"state": "running"}))
    if not result:
        fail("_save_bot_config returned False")
    else:
        ok("_save_bot_config returned True")
    cfg = _get_cfg("111:AAfake1")
    if cfg.get("state") != "running":
        fail(f"Config not updated: state={cfg.get('state')}")
    else:
        ok("_save_bot_config updates correct user file")
    # Simulate stats update
    _save_bot_config("111:AAfake1", lambda c: c.setdefault("stats", {}).update({"total_sent": 10}))
    cfg = _get_cfg("111:AAfake1")
    if cfg.get("stats", {}).get("total_sent") != 10:
        fail(f"Stats not persisted: {cfg.get('stats')}")
    else:
        ok("Stats updates persist correctly")


def test_logging():
    print("\n--- 5. Logging Verification ---")
    from code.utils import get_bot_log_path, log_bot_event
    path = get_bot_log_path("111:AAfake1")
    if path is None:
        fail("get_bot_log_path returned None")
    elif "data" not in str(path) or "logs" not in str(path) or "nobi" not in str(path):
        fail(f"get_bot_log_path wrong path: {path}")
    else:
        ok(f"get_bot_log_path returns data/logs/ path: {path}")
    log_bot_event("111:AAfake1", "Test log message")
    log_path = config.DATA_LOGS_DIR / "nobi.log"
    if not log_path.exists():
        fail("log file was not created")
    else:
        ok("log_bot_event creates data/logs/<name>.log")
    content = log_path.read_text(encoding="utf-8")
    if "Test log message" not in content:
        fail(f"Log content incorrect: {content[:100]}")
    else:
        ok("log_bot_event writes to correct file")


def test_delete_flow():
    print("\n--- 6. Delete Flow Simulation ---")
    from code.utils import delete_bot_from_storage, load_adbot, load_pool
    # Delete nobi (delete_bot_from_storage is async; run it)
    user_file = config.DATA_USER_DIR / "nobi.json"
    log_file = config.DATA_LOGS_DIR / "nobi.log"
    assert user_file.exists(), "Precondition: nobi.json exists"
    assert log_file.exists(), "Precondition: nobi.log exists"

    result = asyncio.run(delete_bot_from_storage("111:AAfake1", "free"))
    if not result:
        fail("delete_bot_from_storage returned False")
    else:
        ok("delete_bot_from_storage returned True")

    if user_file.exists():
        fail("data/user/nobi.json was not deleted")
    else:
        ok("data/user/nobi.json removed")

    if log_file.exists():
        fail("data/logs/nobi.log was not deleted")
    else:
        ok("data/logs/nobi.log removed")

    data = load_adbot()
    if "111:AAfake1" in (data.get("bots") or {}):
        fail("bots still contains deleted bot")
    else:
        ok("bot removed from storage")

    pool = load_pool()
    # With move_to=free we run health check; invalid sessions go to dead, valid to free
    in_free = FAKE_SESSION in pool.get("free_sessions", [])
    in_dead = FAKE_SESSION in pool.get("dead_sessions", [])
    if not (in_free or in_dead):
        fail("Sessions not returned to pool (free or dead)")
    else:
        ok("Sessions returned to pool (free or dead)")


def test_pool_only_save():
    print("\n--- 7. Session Pool Integrity (save_adbot pool-only) ---")
    from code.utils import load_adbot, save_adbot, load_pool
    data = load_adbot()
    # Add a temp session to free, save, then remove and save (simulates admin del_f)
    temp_session = "temp_validation.session"
    data["free_sessions"] = list(data.get("free_sessions", [])) + [temp_session]
    save_adbot(data)
    if temp_session not in load_pool().get("free_sessions", []):
        fail("save_adbot did not persist pool add")
    data["free_sessions"] = [f for f in data.get("free_sessions", []) if f != temp_session]
    save_adbot(data)
    if temp_session in load_pool().get("free_sessions", []):
        fail("save_adbot did not persist pool removal")
    else:
        ok("save_adbot correctly persists pool-only changes")


def test_load_adbot():
    print("\n--- 8. load_adbot merged structure ---")
    from code.utils import load_adbot
    data = load_adbot()
    if "bots" not in data or "free_sessions" not in data:
        fail(f"load_adbot missing keys: {list(data.keys())}")
    else:
        ok("load_adbot returns merged structure")
    # Should have 1 bot (rahul), nobi was deleted
    if len(data.get("bots", {})) != 1:
        fail(f"load_adbot bots count wrong: {len(data.get('bots', {}))}")
    else:
        ok("load_adbot reflects current storage state")


def run_all():
    print("=" * 60)
    print("PER-USER STORAGE VALIDATION")
    print("=" * 60)
    try:
        test_name_to_filename()
        test_create_flow()
        test_get_cfg()
        test_save_bot_config()
        test_logging()
        test_pool_only_save()
        test_delete_flow()
        test_load_adbot()
    except Exception as e:
        fail(f"Validation crashed: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Cleanup temp dir
        try:
            shutil.rmtree(VALIDATION_DIR, ignore_errors=True)
        except Exception:
            pass
        # Restore config (for any subsequent imports)
        config.DATA_DIR = original_data_dir
        config.DATA_USER_DIR = config.DATA_DIR / "user"
        config.DATA_LOGS_DIR = config.DATA_DIR / "logs"
        config.DATA_INDEX_FILE = config.DATA_DIR / "index.json"
        config.DATA_POOL_FILE = config.DATA_DIR / "pool.json"

    print("\n" + "=" * 60)
    if bugs:
        print("BUGS DETECTED:")
        for b in bugs:
            print(f"  - {b}")
        sys.exit(1)
    else:
        print("ALL VALIDATIONS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    run_all()
