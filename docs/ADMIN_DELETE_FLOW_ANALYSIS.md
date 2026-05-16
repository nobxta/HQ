# Admin Delete AdBot — Flow and Fix Summary

## Where the delete flow lives

There are **two** admin UIs; both now use the **same** single confirmation screen (info + one Delete button).

### 1. PTB Admin (`code/admin_ptb.py`) — “Control Center” / “Manage AdBots”

**Path:** Admin menu → **Control Center** → **Bots** (callback `manage_adbots`)  
**OR:** Admin menu → **Manage AdBots** (same callback `manage_adbots`)

- You see: “Manage AdBots - pick one:” with a list of bot names.
- Each bot name has callback `adb_sel:<i>` (e.g. `adb_sel:0`).
- You click a bot → per-bot screen: “**&lt;name&gt;** - Last activity: … Actions:” with buttons:
  - Validate this bot sessions  
  - Replace dead sessions  
  - Replace error sessions  
  - Recreate log group  
  - Suspend / Resume  
  - Force restart / Transfer ownership  
  - **Delete this AdBot** (`adb_del:<i>`)  
  - Back to list  

When you click **“Delete this AdBot”**:

- Callback: `adb_del:<i>` (e.g. `adb_del:0`).
- Handler: `if raw.startswith("adb_del:")` in `on_callback` (around line 1672).
- **Expected behavior:** One screen with:
  - Bot username, Bot name, Bot token (snippet), Plan name, Validity, Mode, Sessions list  
  - “Are you sure? …”  
  - Buttons: **🗑 Delete** (`adb_dconfirm:<i>`), **Cancel**  

There are **no** “Move sessions to free” / “Mark sessions dead” buttons in this code path.

### 2. Telethon Admin (`code/admin.py`)

**Path:** Admin menu → **Manage AdBots** → pick a bot → **Delete this AdBot**

- Same idea: list of bots (`PREFIX_ADBOT_SELECT`), then per-bot actions including “Delete this AdBot” (`PREFIX_ADBOT_DELETE + i` = `adb_del:<i>`).
- Handler: `elif raw.startswith(PREFIX_ADBOT_DELETE)` (around line 1717).
- **Expected behavior:** Same single confirmation screen (username, name, token, plan, validity, mode, sessions) and one **🗑 Delete** button (`PREFIX_ADBOT_DEL_CONFIRM`), plus Cancel.

Again, there are **no** “Move to free” / “Move to dead” options in this file.

---

## Why you might still see “Move to free” / “Move to dead”

The current codebase does **not** show those two buttons anywhere in the delete flow. If you still see them, it is almost certainly one of these:

1. **Old process still running**  
   Restart the app (PTB admin and/or main process that runs the Telethon admin) so the new code is loaded.

2. **Old deployment**  
   The server or environment you’re using may still be running a previous version. Deploy the latest code and restart.

3. **Different bot / token**  
   If you have two admin bots (e.g. one Telethon, one PTB), make sure you’re testing the one that was restarted with the new code.

4. **Cached message**  
   Less likely, but if the message isn’t updating, try starting a fresh flow: go back to the main menu, then Control Center → Bots → pick bot → Delete this AdBot again.

---

## Code references (for debugging)

| What | File | Location |
|------|------|----------|
| PTB: “Delete this AdBot” button | `admin_ptb.py` | ~1499, callback_data=`"adb_del:" + str(i)` |
| PTB: delete confirmation screen (info + Delete) | `admin_ptb.py` | `raw.startswith("adb_del:")` ~1672 |
| PTB: perform delete on Confirm | `admin_ptb.py` | `raw.startswith("adb_dconfirm:")` ~1718 |
| Telethon: “Delete this AdBot” button | `admin.py` | ~223, `PREFIX_ADBOT_DELETE + i` |
| Telethon: delete confirmation screen | `admin.py` | `raw.startswith(PREFIX_ADBOT_DELETE)` ~1717 |
| Telethon: perform delete on Confirm | `admin.py` | `raw.startswith(PREFIX_ADBOT_DEL_CONFIRM)` ~1755 |

---

## Robustness change (PTB)

If `adb_list` was missing (e.g. long delay or context cleared), the PTB handler now reloads the bot list from `load_adbot()` and continues, or shows “Session expired. Go to Manage AdBots and try again.” instead of failing silently.
