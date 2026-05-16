# AdBot Roadmap — Easy Overview

A simple roadmap of what the AdBot system does today: who uses it, what they see, and how it works. Written so anyone (product, support, or new devs) can understand.

---

## 1. What Is AdBot?

**AdBot** is a system that:

- **Hosts many Telegram “AdBots”** — each AdBot is a Telegram bot that belongs to a customer.
- **Uses “sessions”** — these are Telegram *user* accounts (not bots). They are the ones that actually post messages into groups.
- **Posts on a schedule** — each AdBot sends a message (or forwards a link) to a list of groups, over and over, on a cycle (e.g. every hour) with a delay between each post to avoid bans.
- **Is managed by one Admin** — a single admin bot and one admin user control everything: creating AdBots, adding sessions, fixing problems, and deleting AdBots.

So: **Admin** uses the **Admin Bot** to create and manage **AdBots**. **End users** (customers) use **their AdBot** to start/stop posting and set the message. Posting is done by **sessions** (user accounts) in the background.

---

## 2. Who Uses What?

| Who | What they use | What they do |
|-----|----------------|---------------|
| **Admin** | Admin Bot (one bot, one Telegram user) | Create AdBots, add/remove sessions, fix dead sessions, recreate log groups, delete AdBots, see health and logs. |
| **End user (customer)** | Their AdBot (one bot per customer) | Start/stop posting, set message (text or links), see status, validity, logs. Optionally change mode, group file, cycle, gap. |
| **System** | Sessions (Telegram user accounts) | Actually post the ads to groups; one or more sessions per AdBot. |

---

## 3. Admin Side — What Exists Today

### 3.1 How the admin starts

- Admin opens the **Admin Bot** in Telegram and sends **`/start`**.
- They see a **main menu** with three buttons:
  - **Create AdBots**
  - **Manage Sessions**
  - **Manage AdBots**

### 3.2 Commands (typed)

| Command | What it does |
|---------|----------------|
| `/start` | Shows main menu (Create AdBots, Manage Sessions, Manage AdBots). |
| `/cmd` | Shows short list of all admin commands and menu actions. |
| `/health` | Overview of all AdBots: state (running/stopped), valid till, sessions (ok vs dead), workers, last alerts. |
| `/cpu` | CPU, RAM, disk, uptime, Telegram API connectivity. |
| `/logs` | Sends today’s log files (main log + per-bot logs). |
| `/broadcast <text>` | Sends the message to all authorized users of all AdBots (and to the admin). |

### 3.3 Create AdBots (wizard)

When admin taps **Create AdBots**:

1. Bot shows session stats (how many bots, total/dead/assigned/free sessions) and asks: **Proceed to create a new AdBot?**
2. Admin taps **Proceed** (or Cancel).
3. If there are no free sessions, admin is told to add sessions first in **Manage Sessions**.
4. Wizard steps (admin types or taps):
   - **Name** — Internal name (e.g. “buyer2”).
   - **Sessions count** — How many sessions to assign (1 up to max per bot, limited by free sessions).
   - **Cycle** — Time between posting rounds in seconds (minimum 300).
   - **Gap** — Delay between each post in seconds (anti-ban).
   - **Bot token** — The Telegram bot token for this AdBot (checked for validity and duplicate).
   - **Valid till** — Date (dd/mm/yyyy) when the subscription ends.
   - **Mode** — **Starter** or **Enterprise** (see “Starter vs Enterprise” below).
   - **Group file** — Pick a `.txt` file from the `groups/` folder (list of groups to post to).
5. **Summary** — Bot shows a summary and warnings (e.g. group file missing/empty). Admin taps **Proceed** or **Cancel**.
6. On **Proceed**: Bot sends “Create queued. I’ll update this message when done.” Then in the background:
   - Sessions are taken from the free pool and validated.
   - A **log group** (Telegram group) is created for this AdBot; the bot and all assigned sessions are added to it.
   - The new AdBot is saved to `adbot.json`.
   - The admin’s message is updated to “Bot created: @username” or “Create failed…”.
   - The user-facing AdBot is started so the customer can send `/start` to it.

Admin can type **`/cancel`** during the wizard to exit.

### 3.4 Manage Sessions

- **Add Sessions** — Admin is asked to send a file: a single `.session` file, a `.txt` (one session filename per line), or a `.zip` of session files. New valid sessions go to the **free** pool; invalid ones go to **dead**.
- **Remove Sessions** — Bot lists free and dead sessions with delete buttons; admin can remove them one by one.
- **Back** — Returns to main admin menu.

### 3.5 Manage AdBots

- Admin sees a list of all AdBots (by name). Taps one to see **per-bot actions**:
  - **Validate this bot’s sessions** — Check all sessions; bad ones are moved to dead.
  - **Replace dead sessions** — Take sessions from free pool to replace dead ones for this bot.
  - **Replace error sessions** — Replace sessions that had errors (e.g. bans).
  - **Recreate log group** — Create a new log group and re-invite the bot and sessions (e.g. if the old one was deleted).
  - **Delete this AdBot** — Remove the bot; choose whether to move its sessions back to **free** or mark them **dead**.
- **Back** — Returns to list or to main menu.

### 3.6 Alerts and reports

- **Alerts** — Important events (bot created, bot expired, session died, log group recreated, etc.) are stored and sent to the admin’s DM every 30 seconds (e.g. via the same admin bot or PTB).
- **Daily report** — Around 00:00 server time the admin gets a message: active bots count, sessions working, total posts, posts since last report.

### 3.7 Note: PTB vs Telethon admin

- The app can run with a **PTB (python-telegram-bot)** admin: `/start`, `/cmd`, `/health`, `/cpu`, `/logs`, `/broadcast`, and a simple menu (Create AdBots, Manage Sessions, Manage AdBots). For **Create AdBots** and **Manage Sessions / Manage AdBots**, the PTB UI may tell the admin to “use legacy admin” — the full wizard and per-bot actions live in the Telethon-based admin in `admin.py`. So “admin side” in this roadmap means the full set of features; some are only in the Telethon admin.

---

## 4. User Side (Customer) — What Exists Today

The **customer** talks to **their AdBot** (the bot created for them). Only **authorized** users can use it: the **admin** (via `ADMIN_USER_ID`) is always authorized; other users must be added with `/add <user_id>` by the admin.

### 4.1 First open: `/start`

- If the user is **not authorized**: nothing happens (no reply).
- If **subscription expired** (current date > valid_till): bot shows an expired message and one button: **Extend Subscription** (which tells them to contact the admin).
- If **authorized and not expired**: bot shows **Menu** with buttons (see below).

### 4.2 Main menu buttons

| Button | What it does |
|--------|----------------|
| **Run** | Starts posting: sessions post to groups on the configured cycle. Message updates to “Running.” |
| **Stop** | Stops posting. Message updates to “Stopped.” |
| **Set Message** | Opens sub-menu: set the text or links that get posted (see below). |
| **Status** | Shows state (running/stopped) and workers alive (e.g. 5/5). |
| **Logs** | Shows a link to open the **log group** (Telegram group where the bot posts activity). |
| **Validity** | Shows how many days left until valid_till (or “Expired”). |

### 4.3 Set Message

- **Custom text** — User taps “Custom text”, then sends one message; that becomes the text posted to groups.
- **Post links (forward)** — User can add/remove “post links” (e.g. `t.me/...`). When posting, the bot forwards from those links instead of (or in addition to) sending the custom text.
- **Back** — Returns to main menu or to Set Message sub-menu.

### 4.4 Config (Mode, Group file, Cycle, Gap)

Config is **not** on the main menu; the user uses **commands** (or inline buttons when the command is used without arguments):

- **`/config`** — Shows full config (name, state, valid_till, mode, group file, cycle, gap, message preview, post links count, sessions count, stats). Buttons: **Mode**, **Group file**, **Cycle**, **Gap**, **Back**.
- **Mode** — Choose **Starter** or **Enterprise** (with short explanation).
- **Group file** — Choose which `.txt` from `groups/` is used for the list of groups (paginated).
- **Cycle** — Choose interval between posting rounds: 5 min, 15 min, 30 min, 1 hr, 2 hr (min 300 sec).
- **Gap** — Choose delay between posts: 4, 5, or 6 seconds.

All changes are saved to `adbot.json` and apply to the next cycle.

### 4.5 Other user commands

| Command | What it does |
|---------|----------------|
| `/cmd` | Lists all commands and short help (menu, config, info, and for admin: /add, /remove, /subs). |
| `/sessions` | Lists session names and user IDs for this bot. |
| `/stat` or `/stats` | State, workers alive, total sent/failed, last activity. |
| `/stat full` or `/stats full` | Same plus per-session: sent, failed, cycles, last cycle. |
| `/logs` | Sends the bot’s log file. |
| `/mode` | With no arg: inline buttons for Starter/Enterprise. With arg: e.g. `/mode starter`. |
| `/group` | With no arg: inline buttons to pick group file. With arg: e.g. `/group Starter.txt`. |
| `/cycle` | With no arg: inline buttons for 5min–2hr. With arg: e.g. `/cycle 3600`. |
| `/gap` | With no arg: inline buttons for 4–6 sec. With arg: e.g. `/gap 5`. |
| **Admin only** (same bot, only for `ADMIN_USER_ID`): | |
| `/add <user_id>` | Adds that user to **authorized** for this AdBot. |
| `/remove <user_id>` | Removes that user from **authorized**. |
| `/subs <dd/mm/yyyy>` | Sets **valid_till** for this AdBot. |
| `/upload_sessions` | Puts the user in “upload” state; they can send `.session` or `.zip` to add sessions to this bot (saved under `sessions/users/<user_id>/` and added to the bot’s session list; workers update live). |

### 4.6 Expired subscription

- When **valid_till** has passed, the bot is marked expired (e.g. “dead” state with reason).
- On `/start` or any button, the user sees the expired message and **Extend Subscription**.
- **Extend Subscription** tells them to contact the admin (e.g. @admin or `ADMIN_CONTACT`).

---

## 5. Features and Tasks — Summary Tables

### 5.1 Admin: features and how they work

| Feature | How it works |
|--------|----------------|
| Create AdBot | Wizard (name → sessions → cycle → gap → token → valid_till → mode → group file → summary). Job runs in background: assign sessions, create log group, join sessions, save; admin sees progress and then “Bot created” or “Create failed”. |
| Add sessions | Menu → Manage Sessions → Add Sessions → send .session / .txt / .zip. Valid → free pool; invalid → dead. |
| Remove sessions | Manage Sessions → Remove Sessions → list of free/dead with delete buttons. |
| Validate sessions | Manage AdBots → pick bot → Validate. All sessions checked; bad ones moved to dead. |
| Replace dead/error | Same menu → Replace dead sessions or Replace error sessions; free pool used to fill. |
| Recreate log group | Same menu → Recreate log group; new group created, bot and sessions invited. |
| Delete AdBot | Same menu → Delete AdBot; sessions either to free or dead. |
| Health overview | `/health`: all bots, state, valid_till, sessions ok/dead, workers, recent alerts. |
| Alerts | Stored in `adbot.json`; sent to admin DM every 30s. |
| Daily report | 00:00: active bots, sessions working, total posts, posts since last report. |
| Broadcast | `/broadcast <text>`: sent to admin + all authorized users of all AdBots. |

### 5.2 User (customer): features and how they work

| Feature | How it works |
|--------|----------------|
| Run | Button or flow: state set to “running”, posting workers started; each session runs cycles (connect → post to groups with gap → disconnect → sleep until next cycle). |
| Stop | Button: state set to “stopped”, workers told to stop and cleaned up. |
| Set Message | Sub-menu: custom text (one message) and/or post links (add/remove t.me/… links for forwarding). |
| Status | Shows state and workers alive (e.g. 5/5). |
| Logs | Link to open the AdBot’s log group in Telegram. |
| Validity | Shows days left or “Expired”. |
| Config | `/config`: view and change Mode, Group file, Cycle, Gap via buttons or `/mode`, `/group`, `/cycle`, `/gap`. |
| Stats | `/stat` or `/stats`: totals and last activity; `/stat full`: per-session stats. |
| Upload sessions | Admin only: `/upload_sessions` then send .session or .zip; sessions added to this bot and workers updated. |
| Add/remove authorized, set valid_till | Admin only: `/add`, `/remove`, `/subs` on the user bot. |

### 5.3 Buttons quick reference

**Admin bot (main menu)**  
- Create AdBots | Manage Sessions | Manage AdBots  

**User bot (main menu)**  
- Run | Stop | Set Message  
- Status | Logs | Validity  

**User bot (Set Message)**  
- Custom text | Post links (forward) | ‹ Back  

**User bot (Config)**  
- Mode | Group file | Cycle | Gap | ‹ Back  

---

## 6. Key Concepts (in simple words)

- **Session** — A Telegram *user* account (saved as a `.session` file). It’s the “worker” that actually joins groups and sends/forwards messages. Sessions live in a pool: **free** (not assigned), **assigned** (to an AdBot), or **dead** (invalid).
- **AdBot** — One customer-facing Telegram *bot*. It has a name, token, list of sessions, cycle/gap, mode, group file, message/links, valid_till, and state (running/stopped). Users talk to it to Run/Stop and Set Message.
- **Log group** — A Telegram group created for each AdBot. The bot and all its sessions are members. The system posts activity (cycle start, posts, errors) there so the customer (or admin) can see what’s happening.
- **Group file** — A `.txt` in the `groups/` folder. Each line is a group (ID or invite link). Each AdBot picks one group file; that’s the list of groups it posts to.
- **Starter vs Enterprise** — **Starter**: every session posts to *all* groups in the file; more posts per cycle, more coverage. **Enterprise**: groups are split between sessions (each group gets one session per cycle); fewer posts per session, one post per group per cycle.
- **Cycle** — Time between full “rounds” of posting (e.g. 3600 = every hour). **Gap** — Seconds between each post in a round (anti-ban, e.g. 5 sec).
- **Authorized** — List of Telegram user IDs that can use this AdBot. Admin (`ADMIN_USER_ID`) is always authorized. Others are added with `/add <user_id>` by the admin.
- **Valid till** — Date when the subscription ends. After that, the bot shows “Expired” and “Extend Subscription”.

---

## 7. What the roadmap is for

- **Current state** — This document describes the **current** AdBot system: admin side, user side, features, buttons, and tasks in plain language.
- **Future** — You can use this as a base to add a “Planned” or “Future” section: e.g. full Create AdBot wizard in PTB, extra user features, or UI changes. Right now the roadmap is “as-is” so everyone agrees what exists and how it works.

---

## 8. Where things live in code (short)

| What | Where |
|------|--------|
| Admin bot (Telethon: full wizard, Manage Sessions/AdBots) | `code/admin.py` |
| Admin bot (PTB: commands + simple menu) | `code/admin_ptb.py` |
| User bot (Run/Stop, Set Message, Status, Logs, Validity, Config, commands) | `code/users.py` |
| Posting workers (one process per session, cycle/gap, Starter/Enterprise) | `code/workers.py`, `code/users.py` |
| Create job (background thread + result consumer) | `code/admin.py` |
| State (bots, sessions, alerts) | `adbot.json` (load/save in `code/utils.py`) |
| Starter vs Enterprise logic | `docs/STARTER_VS_ENTERPRISE.md`, constants in `code/users.py` |

This roadmap stays in **docs** and can be updated when features or flows change.
