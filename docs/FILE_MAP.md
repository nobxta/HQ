# TAdbot — File Map: What’s Used vs What’s Trash

Quick reference for which files are part of the running app, which are tools/docs, and which can be removed.

---

## Core app (required — do not delete)

**Entry point (project root):**
| File | Role |
|------|------|
| **main.py** | Single entry point. Imports from `code/` and starts admin bot, log consumer, health monitor, resume AdBots. Run: `python main.py` |

**Application code (all under `code/`):**
| File | Role |
|------|------|
| **code/config.py** | Paths (project root = parent of `code/`), API keys, env. |
| **code/admin_ptb.py** | Admin bot (PTB): /start, /health, /cmd, /cpu, /logs, /broadcast, alert forward. |
| **code/admin.py** | Create AdBot wizard, Manage Sessions/AdBots, shared helpers. |
| **code/users.py** | User bots, posting, DM handler, log queue, session loops. Core logic. |
| **code/workers.py** | Multiprocessing posting workers. Used by users._start_posting. |
| **code/crash.py** | Resume running AdBots on startup. Used by main. |
| **code/utils.py** | adbot.json load/save, session validation, join_chat, alerts storage. |
| **code/rpc_errors.py** | Telethon error handling, retries. |
| **code/bot_ptb.py** | PTB helpers: log-group send, admin DM alerts. |

---

## Config and data (keep; some are generated)

| File / folder | Role |
|---------------|------|
| **.env** | API_ID, API_HASH, ADMIN_BOT_TOKEN, ADMIN_USER_ID. Not in git. |
| **adbot.json** | All bot config, sessions, alerts. Created/updated by app. |
| **requirements.txt** | Python deps. Needed for `pip install`. |
| **groups/** | Group lists. App uses `group_file` (e.g. `Starter.txt`, `kartik.txt`) from here. |
| **groups/.gitkeep** | Keeps `groups/` in git when empty. |

---

## Optional / standalone (not imported by main)

| File | Role | Verdict |
|------|------|--------|
| **code/diagnostic.py** | Run `python -m code.diagnostic` from project root to check env, tokens, sessions. | **Tool** — keep if you use it. |
| **code/tools/extract.py** | Script to export group list from Telegram (writes e.g. groups.txt). | **Tool** — keep if you use it. |
| **code/tools/group_joiner.py** | Script to join groups from a list. | **Tool** — keep if you use it. |

---

## Likely trash or optional (safe to remove if you don’t need them)

| File | Why it might be trash |
|------|------------------------|
| **groups.txt** (in project root) | App reads group files from **groups/** (e.g. `groups/Starter.txt`), not `groups.txt` at root. This is often leftover from `tools/extract.py` or manual copy. **Safe to delete** if you don’t use it. |
| **README.md** | Docs only. Keep for project description. |

---

## Docs (reference only)

| Path | Role |
|------|------|
| **docs/FAILURE_SCENARIOS.md** | Failure scenarios. |
| **docs/LOG_FORENSIC_AUDIT.md** | Log audit. |
| **docs/OBSERVABILITY.md** | Observability. |
| **docs/POSTING_FLOW_AND_FAILURES.md** | Posting flow. |
| **docs/STARTER_VS_ENTERPRISE.md** | Starter vs Enterprise. |
| **docs/TECHNICAL_DOCUMENTATION.md** | Technical overview. |
| **docs/FILE_MAP.md** | This file. |

---

## Import chain (how core files connect)

```
main.py (at project root)
├── code.config
├── code.admin_ptb.run_admin_bot_ptb
├── code.crash.resume_adbots
├── code.utils (load_adbot, …)
└── code.users (_stop_posting, _log_queue_consumer, …)

code/
├── config.py     (BASE_DIR = parent of code/ = project root)
├── admin_ptb.py  → .admin, .config, .bot_ptb
├── admin.py      → .config, .users, .utils
├── users.py      → .config, .bot_ptb, .rpc_errors, .utils, .workers
├── workers.py    → .config, .users
├── crash.py      → .users
├── utils.py      → .config, .rpc_errors
├── bot_ptb.py    → .config
└── rpc_errors.py (no internal project imports)
```

---

## Summary

- **Do not delete:** `main.py`, `config.py`, `admin_ptb.py`, `admin.py`, `users.py`, `workers.py`, `crash.py`, `utils.py`, `rpc_errors.py`, `bot_ptb.py`, `adbot.json`, `requirements.txt`, **groups/** (and its .txt files you use).
- **Optional tools:** `diagnostic.py`, `tools/extract.py`, `tools/group_joiner.py` — keep if you use them.
- **Safe to delete if unused:** **groups.txt** at project root (only if you’re not using it; app uses **groups/*.txt**).
- **Docs:** All under **docs/** and **README.md** are for humans only; no code imports them.
