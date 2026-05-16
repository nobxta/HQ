# How Posting Works When the User Clicks Run

Plain-English explanation based on the code: what happens when you click Run, what the system needs, what it fetches, and how multiple Telegram accounts work.

---

## 1. What Happens When the User Clicks Run

When the user taps the **Run** button in their AdBot chat:

1. **The button is an inline callback**  
   The Run button sends a callback with data `CB_RUN` (code: `b"run"`). The handler for that callback runs in the user’s **controller bot** (the bot that talks to that user).

2. **Checks before starting**  
   - If the bot is **suspended**, the user sees “Bot is suspended by admin. Contact support.” and nothing starts.  
   - The user must have **at least one post link** (message to forward) **or** **custom text** set. If both are empty, the user sees “Set a message before running…” and is sent to **Set Message**; Run does not start posting.

3. **Starting posting**  
   The code calls `_start_posting(bot_token, update_status=_edit_status)`.  
   - The UI message is updated with short status lines (“Checking configuration…”, “Checking sessions…”, “Assigning groups…”, “Starting workers…”) and finally “AdBot started successfully” with the normal menu buttons.

4. **If Run fails**  
   - “No sessions to run” means there were no valid, non-excluded sessions with at least one assigned group.  
   - Any other error is shown in the message and written to the bot event log.

So: **Run** = “start the posting workers for this AdBot (this `bot_token`)”.

---

## 2. What Info the System Needs to Run

Posting only starts if all of the following are in place.

### From the user’s config (saved in `data/user/<name>.json`)

- **`bot_token`**  
  The token of this AdBot. Used to find the config and to send log messages to the log group.

- **`sessions`**  
  A list of session objects. Each has at least `"file"` (e.g. `"abc.session"` or `"users/xyz.session"`).  
  These are the **Telegram user accounts** (MTProto sessions) that will post. No sessions ⇒ no Run.

- **At least one of:**
  - **`post_links`** (or legacy `post_link`) – links to messages to **forward** into groups (e.g. `https://t.me/c/123/456` or `t.me/username/789`).
  - **`message_text`** – custom text to **send as a new message** in each group (plain text, no markdown when sending).

- **`group_file`**  
  Filename of the groups list (e.g. `"Starter.txt"`). The file must live under `groups/` (see below).  
  If the file is missing or gives no valid groups, sessions get zero groups and are not started.

- **Other config used by workers**  
  - `cycle` – seconds between full cycles (e.g. 3600).  
  - `gap` – seconds between posts (minimum enforced by code is 4–6).  
  - `mode` – `"Starter"` or `"Enterprise"` (controls how groups are assigned to sessions).  
  - `log_group` – where to send post results (link or @username).  
  - `valid_till` – used to detect expiry; expired bots are stopped and sessions returned.  
  - Plus ban/pause/cooldown state: `excluded_sessions`, `session_pause_until`, `session_cooldown_until`, `ban_error_count_by_session`, etc.

### From the index (who this bot is)

- **`data/index.json`**  
  Maps `bot_token` → `name`.  
  Config is then loaded from `data/user/<name>.json`. Without an index entry for this token, there is no config and Run cannot proceed.

### From disk (sessions and groups)

- **Session files**  
  For each session in `sessions`, the code resolves the path (e.g. `sessions/active/abc.session` or `sessions/users/xyz.session`) and checks that the file **exists**. Missing or excluded sessions are skipped.

- **Groups file**  
  Path: `groups/<group_file>` (e.g. `groups/Starter.txt`).  
  The file is read from disk. Each line is a group (or forum topic): e.g. `-1001234567890` or `-1001234567890 | 34` for a topic. Invalid lines are skipped. If there are no valid groups, no posting runs.

So in short: **Run needs** the AdBot’s config (with sessions, message source, group file name), the index mapping token → name, existing session files, and an existing groups file with at least one valid target.

---

## 3. What the System Fetches (Reads) When Run Is Clicked

Nothing is “fetched” from the internet to *decide* whether to run. Everything is read from **local config and files**.

- **Config**  
  - `data/index.json` → get `name` for this `bot_token`.  
  - `data/user/<name>.json` → full user config (sessions, post_links/message_text, group_file, cycle, gap, mode, log_group, etc.).

- **Sessions**  
  For each session in config, the code checks that the session file exists under `sessions/active/` or `sessions/users/` (depending on path). No HTTP/API call here.

- **Groups**  
  The path `groups/<group_file>` is read from disk. The list of `{chat_id, topic_id}` is built from that file. Again, no fetch.

- **Worker snapshot**  
  A **config snapshot** is built with `_build_worker_config_snapshot(cfg, total_sessions, run_first_cycle_immediately=True)`. That snapshot is a **copy** of the bits workers need (cycle, gap, group_file, groups_dir, message_text, post_links, mode, log_group, valid_till, last_cycle_time, ban/pause/cooldown state, etc.). Workers get this snapshot only; they do not read `data/user/*.json` themselves.

So: **all info to run is loaded from local paths** (index, user JSON, session files, groups file). The only “fetch” is that snapshot being sent to worker processes. After Run, when workers actually post, they use the **Telegram API** (Telethon) to connect sessions and send/forward messages.

---

## 4. How It Works With Multiple Telegram Accounts

There are two different “multi” things: **multiple sessions (Telegram accounts) per AdBot** and **multiple AdBots (multiple users)**.

### Multiple Telegram accounts (sessions) under one AdBot

- One AdBot = one `bot_token` = one config in `data/user/<name>.json`.  
  That config has a list **`sessions`**: e.g. 5 session files = 5 Telegram user accounts.

- When you click Run for that AdBot:
  - The code only keeps sessions that: have a non-empty `file`, the session file exists on disk, and the session is not in `excluded_sessions`.
  - For each of those sessions it asks: “how many groups would this session get?” (from `_assigned_groups_for_session`). Sessions that would get **zero** groups (e.g. excluded, paused, or in Enterprise mode not in the active list) are **not** started.
  - **One worker process per session** (with `SESSIONS_PER_WORKER = 1`). So 5 valid sessions ⇒ 5 worker processes.
  - Each worker gets the **same** config snapshot. Each worker runs **one** session (one Telegram account).
  - **Starter mode:** every (non-excluded, non-paused) session gets the **full** group list (rotated by time). So all accounts post to the same groups, each on its own cycle.
  - **Enterprise mode:** groups are **split** across sessions (each session gets a slice of the list). So each account posts to a different subset of groups.

So: **multiple Telegram accounts** = multiple entries in `sessions` in that AdBot’s config. Run starts one worker per (valid, assigned) session; config and group list come from that single AdBot’s config and its `group_file`.

### Multiple AdBots (multiple users / multiple bot tokens)

- The system can run **many AdBots** at once. Each has its own `bot_token` and its own config (its own `name` in the index and its own `data/user/<name>.json`).

- **Index:** `data/index.json` has `by_token`: each token maps to a `name`. So many tokens ⇒ many names ⇒ many config files.

- **When Run is clicked**, it only starts posting for **that** AdBot (that `bot_token`). Other AdBots are unchanged. Each has its own:
  - Sessions (its own Telegram accounts)
  - Group file
  - Post links / message text
  - Workers (processes)

- On **server startup**, `resume_adbots` loads all bots from the index and, for each bot whose state is `"running"` and not expired, calls `_start_posting(bot_token)`. So after a restart, every AdBot that was running is started again.

So: **multiple AdBots** = multiple entries in the index and multiple `data/user/<name>.json` files. Run only affects the one AdBot whose Run button was pressed; each AdBot has its own config and its own set of Telegram accounts (sessions).

---

## 5. Config Summary (What Is Used for Posting)

| Source | What |
|--------|------|
| `data/index.json` | Map `bot_token` → `name`. |
| `data/user/<name>.json` | Full config: `sessions`, `post_links` / `message_text`, `group_file`, `cycle`, `gap`, `mode`, `log_group`, `valid_till`, and ban/pause/cooldown fields. |
| `groups/<group_file>` | List of groups (and optional topic IDs). Read from disk when building targets. |
| Session files under `sessions/active/` or `sessions/users/` | One file per Telegram account; must exist to be used. |

Workers do not read these files themselves. They receive a **snapshot** (built by `_build_worker_config_snapshot`) with everything they need to run one or more cycles (cycle, gap, group_file, groups_dir, message_text, post_links, mode, log_group, valid_till, last_cycle_time, pause/ban/cooldown state, etc.). The controller (main process) is the one that reads and saves config; workers only report results (e.g. cycle_done, session_died) back to the controller.

---

## 6. Short Flow Summary

1. User clicks **Run** → Run callback handler runs for that AdBot’s chat.
2. Checks: not suspended; at least one post link or custom text.
3. `_start_posting(bot_token)` runs: load config from `data/user/<name>.json` (name from index), validate sessions and group assignment, build config snapshot, start one worker process per valid session, send **START** to each worker.
4. Workers wait for START, then connect their session (Telegram account), load groups from `groups/<group_file>`, and every `cycle` seconds post (forward or send text) to each group with the configured `gap`.
5. Multiple Telegram accounts = multiple sessions in that AdBot’s config; multiple AdBots = multiple bot tokens and multiple config files; Run only starts the AdBot whose Run button was clicked.
