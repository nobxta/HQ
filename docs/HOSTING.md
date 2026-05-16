# Hosting TAdbot on a Server

This guide helps you run TAdbot on a VPS or dedicated server with a clean state: only **plans** and **main config** are kept; user data, logs, and temp data are reset for a fresh deploy.

## What is kept (main data)

- **`data/plans.json`** — Your subscription plans (Starter/Enterprise tiers, prices, sessions).
- **`.env`** — Your API credentials, admin bot token, admin user ID, and optional Shop Bot / payment / proxy settings.
- **`data/pool.json`** — Empty session pools (free/dead/frozen, admin_alerts).
- **`data/maintenance.json`** — Maintenance mode flag (off by default).
- **`data/index.json`** — Empty bot index (by_token / by_name); new AdBots will register here.
- **`data/orders.json`**, **`data/broadcast_*.json`**, **`data/admin_audit.json`**, etc. — Reset to empty/defaults.

## What is cleaned on reset

- All **user bot configs** (`data/user/*.json`) — removed.
- All **logs** (`logs/`, `data/logs/`) — removed.
- **Orders, broadcast logs, audit entries** — cleared.
- **Worker heartbeats** and **maintenance notify queue** — cleared.
- **Supported currencies cache** — cleared (refetched on first run if using Shop Bot).

## Server setup

### 1. Copy project to server

Upload the TAdbot folder (or clone from your repo). Do **not** commit `.env` or secrets.

### 2. Environment

```bash
cd TAdbot
cp .env.example .env
# Edit .env with your values:
#   API_ID, API_HASH       — from https://my.telegram.org
#   ADMIN_BOT_TOKEN        — BotFather token for the admin bot
#   ADMIN_USER_ID          — Your Telegram user ID (numeric)
#   ADMIN_CONTACT          — Optional; e.g. youradmin (shown when subscription expired)
```

For **Shop Bot** (self-service purchases):

- `SHOP_BOT_TOKEN` — Shop bot token from BotFather.
- `NOWPAYMENTS_API_KEY` and `NOWPAYMENTS_BASE_URL` for real payments, or `PAYMENT_DEV_MODE=1` for stub.
- Optional: `SUPPORT_CHAT_ID`, `WEBSITE_URL`.

### 3. Install and run

```bash
python -m venv venv
# Windows: venv\Scripts\activate
# Linux/macOS: source venv/bin/activate
pip install -r requirements.txt
python main.py
```

The process starts the admin bot, discovers sessions from `sessions/active/`, and runs until you stop it.

### 4. Sessions (posting accounts)

- Put Telegram **user** `.session` files in `sessions/active/`. On next start they are added to the free pool.
- Or use the admin bot: **Manage Sessions** → **Add Sessions** (send .session, .txt list, or .zip).

### 5. Run as a service (Linux)

Example **systemd** unit (`/etc/systemd/system/tadbot.service`):

```ini
[Unit]
Description=TAdbot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/TAdbot
Environment=PATH=/path/to/TAdbot/venv/bin
ExecStart=/path/to/TAdbot/venv/bin/python main.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable tadbot
sudo systemctl start tadbot
sudo systemctl status tadbot
```

Logs go to `logs/adbot.log` (rotated daily). Use `journalctl -u tadbot -f` for systemd logs.

## Summary

- **Plans** and **main details** (`.env`, pool/index/maintenance) stay; everything else is reset for a clean server deploy.
- Keep `.env` and `data/plans.json` as your “main data”; the rest is recreated as users create AdBots and use the system.
