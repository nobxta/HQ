# Starter vs Enterprise: Sessions and Groups

How each plan assigns groups to sessions and when they start.

---

## Summary Table (e.g. 10 sessions, 80 or 100 groups)

| Aspect | Starter | Enterprise |
|--------|---------|------------|
| **Group assignment** | Every session gets the **full list** | **Partitioned**: session *i* gets slice *i* of the list (no overlap) |
| **Example (10 sessions, 80 groups)** | Each session: all 80 groups | Session 0: groups 1–8, session 1: 9–16, … session 9: 73–80 |
| **Example (10 sessions, 100 groups)** | Each session: all 100 groups | Session 0: groups 1–10, session 1: 11–20, … session 9: 91–100 |
| **Posts per session per cycle** | N (all groups) | N ÷ sessions (each session only its slice) |
| **Total posts per cycle** | sessions × N | N (each group posted once per cycle) |
| **Session start stagger** | Spread over 1 hour (0, 6, 12, … 54 min) | First half at 0 min, second half after 5 min |
| **Use case** | Max coverage; every group gets one post from every session | All groups covered once per cycle; lower volume per session |

---

## Starter Plan

### Group assignment
- Every session gets the **full list** from the group file. No partitioning.

### Posting (e.g. 10 sessions, 80 groups)
- Each of the 10 sessions posts to **all 80 groups** every cycle.
- **800 posts per cycle** (10 × 80). Each group receives **10 posts** (one per session).

### Start stagger
- `stagger_sec = (STAGGER_WINDOW_SEC / total_sessions) × session_index` (STAGGER_WINDOW_SEC = 3600).
- Session 0: 0 min, session 1: 6 min, … session 9: 54 min (spread over 1 hour).

---

## Enterprise Plan (partitioning)

### Group assignment
- Groups are **partitioned by session index**. Session *i* (0-based) gets:
  - `groups[ i * N // T : (i+1) * N // T ]`
  - where N = number of groups, T = total sessions.
- No overlap, no gap; every group belongs to exactly one session per cycle.

### Examples
- **100 groups, 10 sessions:**  
  Session 0: 1–10, session 1: 11–20, session 2: 21–30, … session 9: 91–100.
- **80 groups, 10 sessions:**  
  Session 0: 1–8, session 1: 9–16, … session 9: 73–80.

### Posting (e.g. 10 sessions, 100 groups)
- Each session posts only to **its slice** (10 groups). **100 posts per cycle** total; each group gets **1 post** per cycle.

### Start stagger
- First half of sessions (0–4): start at **0 min**.
- Second half (5–9): start **5 minutes** later (ENTERPRISE_STAGGER_SEC = 300).

### Edge cases (no crash)
- **total_sessions** missing or 0: treated as 1 (single session gets all groups).
- **session_index** out of range: clamped to `[0, total_sessions - 1]`.
- **Empty group file:** returns `[]`; session connects and sleeps without posting (no exception).
- **Uneven split** (e.g. 85 groups, 10 sessions): integer division gives 8 or 9 groups per session; all 85 groups are still assigned.

---

## Constants (reference)

| Constant | Value | Meaning |
|----------|--------|--------|
| `STAGGER_WINDOW_SEC` | 3600 | Starter: spread session starts over 1 hour |
| `ENTERPRISE_STAGGER_SEC` | 300 | Enterprise: delay for second half of sessions (5 min) |
