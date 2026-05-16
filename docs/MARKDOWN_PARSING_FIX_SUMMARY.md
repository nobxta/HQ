# Telegram Markdown Parsing Fix Summary

**Date:** 2026-02-12  
**Problem:** User-provided values (names, usernames, tokens, filenames) in admin bot messages caused `BadRequest: Can't parse entities: can't find end of the entity` when using `parse_mode="Markdown"`.

**Solution:** Switch to `parse_mode="MarkdownV2"` and escape all dynamic content with `telegram.helpers.escape_markdown(text, version=2)`.

---

## Files Modified

| File | Changes |
|------|---------|
| `code/admin_ptb.py` | Added `_md_escape()` helper; updated 9 message handlers to escape dynamic content and use MarkdownV2 |
| `main.py` | Escaped delete confirmation and error messages; switched to MarkdownV2 |

---

## Message Handlers Updated

| Handler | Location | Dynamic Content Escaped |
|---------|----------|-------------------------|
| `_alert_forward_loop_ptb` | admin_ptb.py ~77 | Alert messages |
| `_daily_report_loop_ptb` | admin_ptb.py ~115 | Date, counts, stats |
| `cmd_cmd` | admin_ptb.py ~227 | Static only; MarkdownV2 syntax fixes |
| `cmd_health` | admin_ptb.py ~248 | Bot names, states, valid_till, session counts, dead_reason, alert snippets |
| `cmd_cpu` | admin_ptb.py ~264 | System stats lines (paths, numbers) |
| `cmd_broadcast` | admin_ptb.py ~315 | Broadcast message text |
| `on_callback` (gf:) | admin_ptb.py ~421 | Creation summary: name, username, sessions, cycle, gap, valid_till, mode, group filename |
| `on_callback` (adb_sel:) | admin_ptb.py ~538 | AdBot name |
| `on_callback` (adb_del:) | admin_ptb.py ~657 | AdBot name (delete confirmation) |
| `_main_loop_job_consumer` | main.py ~94 | Bot name, pool type; delete error message |

---

## Locations Where Escaping Was Added

1. **admin_ptb.py**
   - `_md_escape()` helper — wraps `escape_markdown(..., version=2)`
   - Alert forward loop: `msg = _md_escape(msg)`
   - Daily report: `_md_escape(today)`, `_md_escape(active)`, etc.
   - cmd_health: `_md_escape(name)`, `_md_escape(state)`, `_md_escape(valid)`, etc.
   - cmd_cpu: `_md_escape(line)` for each stats line
   - Broadcast: `_md_escape(text)` for user message
   - Creation summary: `_md_escape(d.get('name'))`, `_md_escape(d.get('bot_username'))`, etc.
   - AdBot actions: `_md_escape(name)`
   - Delete confirmation: `_md_escape(name)`

2. **main.py**
   - Delete success: `escape_markdown(str(name), version=2)`, `escape_markdown("free"|"dead", version=2)`
   - Delete failure: `escape_markdown(str(e), version=2)`

---

## MarkdownV2 Syntax Notes

- Bold: `*text*` (single asterisk; double `**` not used)
- Literal special chars: `\\(`, `\\)`, `\\.`, `\\-`, `\\|`, etc.
- All user-provided text must be escaped before insertion

---

## Messages Without parse_mode (unchanged)

These use plain text (no parse_mode) and were not modified:

- `_manage_sessions_text()` — session counts
- Validate/Replace/Recreate result messages — no parse_mode in `edit_message_text`
- Progress messages ("Validating...", "Replacing...", etc.)
- Create job progress/result — `parse_mode=None` already
