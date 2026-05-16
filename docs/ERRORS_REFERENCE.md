# TAdbot — Common runtime errors reference

This document explains the main errors you may see in logs and what to do about them.

---

## 1. Telegram “internal issues” (PersistentTimestampOutdatedError / HistoryGetFailedError)

**Log examples:**
- `Telegram is having internal issues PersistentTimestampOutdatedError: Persistent timestamp outdated (caused by GetChannelDifferenceRequest)`
- `Telegram is having internal issues HistoryGetFailedError: Fetching of history failed (caused by GetChannelDifferenceRequest)`
- `Getting difference for channel updates … caused ValueError; ending getting difference prematurely until server issues are resolved`

**Cause:** Telegram’s servers are having temporary problems, or your session’s stored “persistent timestamp” (pts) for a channel is too old. Telethon uses `GetChannelDifferenceRequest` to sync channel updates; when the server returns these errors, it logs “Telegram is having internal issues” and backs off.

**What to do:**
- **Do nothing** in normal cases. Telethon backs off and will retry when the server is healthy again. Your posting and heartbeats can continue; only the internal “get difference” sync is affected.
- If it goes on for hours, you can try restarting the bot once. Do **not** restart repeatedly.
- If you use a proxy, you can try another DC (e.g. another proxy) in case one DC is worse.

---

## 2. Task was destroyed but it is pending

**Log example:**
- `asyncio unhandled [task=Task-…]: Task was destroyed but it is pending!`

**Cause:** The event loop is shutting down (e.g. worker process exit, STOP, or main process exit) while some asyncio tasks (often Telethon’s internal `_recv_loop` or update handlers) are still running. They get destroyed without being properly cancelled/awaited.

**What to do:**
- On **intentional shutdown** (e.g. STOP, restart): this is mostly cosmetic. The process is exiting anyway. We try to cancel tasks and await them in `main.py`; worker processes also disconnect the client and then exit, so a small delay after `client.disconnect()` can reduce how often this appears.
- If you see it **during normal operation** (no stop/restart), it may indicate a reconnection or disconnect path that doesn’t wait for all internal tasks. In that case, consider reporting the sequence (e.g. “happens right after reconnect” or “right after STOP”).

---

## 3. database is locked (sqlite3.OperationalError)

**Log examples:**
- `Error executing high-level request after reconnect: … database is locked`
- `Cannot get difference for channel … since the account is likely misusing the session: database is locked`
- `Task exception … _disconnect_coro() … exception=OperationalError('database is locked')`

**Cause:** SQLite allows only one writer at a time. Telethon stores session state (entities, etc.) in a `.session` SQLite file. The lock happens when:
- Two writers run at once (e.g. “save state” on disconnect and “process entities” from an update), or
- Reconnect and disconnect happen close together so that one write is still in progress when another starts.

**What to do:**
- Ensure **each `.session` file is used by only one process**. TAdbot already gives each worker its own session file; do not point two processes at the same file.
- If the lock appears **during reconnect or right after STOP**, it’s often transient. A short delay after `client.disconnect()` before the process exits (or before opening the same session again) can help.
- If it’s frequent, consider running fewer concurrent sessions per bot or spacing out restarts so that disconnects don’t pile up.

---

## 4. MsgidDecreaseRetryError

**Log example:**
- `Telegram is having internal issues MsgidDecreaseRetryError: The request should be retried with a lower message ID (caused by SendMessageRequest)`

**Cause:** After a reconnect or network glitch, Telegram’s idea of the next message ID and the client’s can get out of sync. The server asks the client to retry with a lower message ID.

**What to do:** Nothing. Telethon retries with the correct ID. If it keeps happening, check network stability and avoid restarting the same session too often in a short time.

---

## 5. SpamBot / anti-spam message

**Log example:**
- `SpamBot UNKNOWN classification: Unfortunately, some phone numbers may trigger a harsh response from our anti-spam systems…`

**Cause:** Telegram sent an anti-spam or restriction message to the session (e.g. in a chat or via a bot). The classifier doesn’t map this text to a specific category, so it logs “UNKNOWN”.

**What to do:** Treat it as informational. If the session is restricted or limited, reduce posting frequency or targets and avoid aggressive behavior.

---

## 6. Connection closed / Server closed the connection

**Log examples:**
- `Server closed the connection: 0 bytes read on a total of 8 expected bytes`
- `Connection closed while receiving data … Closing current connection to begin reconnect...`

**Cause:** The TCP connection to Telegram was closed (by the server, network, or proxy). Telethon will try to reconnect.

**What to do:** Normal for unstable networks or Telegram issues. If it happens very often, check proxy/network and consider a different DC or proxy.

---

## Summary

| Error / message                         | Likely cause              | Action                          |
|----------------------------------------|---------------------------|---------------------------------|
| PersistentTimestampOutdated / HistoryGetFailed | Telegram server / pts    | Wait; optional single restart   |
| Task was destroyed but it is pending   | Shutdown with pending tasks | Often cosmetic; add delay after disconnect if needed |
| database is locked                     | Concurrent SQLite writes   | One process per session; delay after disconnect |
| MsgidDecreaseRetryError                | ID sync after reconnect   | None; Telethon retries          |
| SpamBot UNKNOWN                        | Anti-spam message         | Informational; reduce load if restricted |
| Connection closed                      | Network / server          | Normal; Telethon reconnects     |
