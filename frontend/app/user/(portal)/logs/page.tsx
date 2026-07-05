"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { usePortalBot, usePortalLogs, usePortalStats, usePortalSessionValid } from "@/lib/hooks/usePortal";
import Button from "@/components/ui/Button";
import {
  RotateCw, CheckCircle2, XCircle, Clock,
  Radio, Search, Zap, Hash, MessageSquare, Play,
  Timer, ChevronDown, ChevronRight, Send, Wifi,
  Activity, Users, Copy, Check,
} from "lucide-react";

/* ────────────────────── Types ────────────────────── */

type LogType = "success" | "failure" | "flood" | "cycle_start" | "cycle_end" | "connect" | "system" | "noise";

type ParsedLog = {
  raw: string;
  type: LogType;
  timestamp?: string;
  account?: string;
  accountShort?: string;
  groupName?: string;
  groupId?: string;
  groupLink?: string;
  error?: string;
  waitSeconds?: string;
  message?: string;
  detail?: string;
};

/* ────────────────────── Parser ────────────────────── */

// Lines that are pure noise for the user — hide completely
const NOISE_PREFIXES = [
  "[PostingScheduler]",
  "[Scheduler]",
  "[ShardCheck]",
  "[VerificationReport]",
];

function shortAccount(acct: string): string {
  if (!acct) return "";
  if (acct.length > 6) return "..." + acct.slice(-6);
  return acct;
}

function toLocalTime(ts: string): { time: string; full: string } {
  try {
    let normalized = ts.trim();
    // "2026-05-11 02:47:57" → add Z for UTC, or "2026-05-11T02:47:57Z" already has it
    if (!normalized.endsWith("Z") && !normalized.includes("+")) {
      normalized = normalized.replace(" ", "T") + "Z";
    }
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return { time: ts, full: ts };
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
    const full = d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
    return { time, full };
  } catch {
    return { time: ts, full: ts };
  }
}

// Relative "N minutes ago" label, matching the reference design's friendlier row timestamps.
function relTime(ts?: string): string {
  if (!ts) return "";
  let n = ts.trim();
  if (!n.endsWith("Z") && !n.includes("+")) n = n.replace(" ", "T") + "Z";
  const t = new Date(n).getTime();
  if (isNaN(t)) return ts;
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? "" : "s"} ago`;
}

function extractGroupNameStructured(s: string): string {
  const m = s.match(/group_name=(.+?)\s+group_id=/);
  if (!m) return "";
  let name = m[1];
  if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
    name = name.slice(1, -1);
  }
  return name;
}

function stripHtml(text: string): { clean: string; link?: string } {
  const anchorMatch = text.match(/<a\s+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (anchorMatch) {
    const link = anchorMatch[1];
    const inner = anchorMatch[2];
    const clean = text.replace(/<a\s+href=["'][^"']*["'][^>]*>[\s\S]*?<\/a>/gi, inner).replace(/<[^>]+>/g, "").trim();
    return { clean, link };
  }
  const clean = text.replace(/<[^>]+>/g, "").trim();
  return { clean };
}

function isHtmlDuplicate(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("<a ") && t.endsWith("</a>")) return true;
  if (/<a\s+href=/.test(t) && /Account\s+\d+\s*-\s*(?:Posted in|Sent to|Failed in|Success in)/.test(t)) return true;
  return false;
}

function parseLine(line: string): ParsedLog {
  if (isHtmlDuplicate(line)) return { raw: line, type: "noise" };
  const { clean: trimmed, link: extractedLink } = stripHtml(line.trim());
  if (!trimmed) return { raw: line, type: "noise" };

  // ─── Hide noise lines ───
  for (const prefix of NOISE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { raw: line, type: "noise" };
    }
  }
  // "918077466203.session 61 groups" / "+18584268801.session 22 groups" — session assignment summary, noise
  if (/^\+?\d+\.session\s+\d+\s+groups$/.test(trimmed)) {
    return { raw: line, type: "noise" };
  }

  // ─── Structured: [POST_SUCCESS] ───
  if (trimmed.startsWith("[POST_SUCCESS]")) {
    const acct = trimmed.match(/account=(\S+)/)?.[1] || "";
    const gid = trimmed.match(/group_id=(\S+)/)?.[1] || "";
    return {
      raw: line, type: "success",
      account: acct, accountShort: shortAccount(acct),
      groupName: extractGroupNameStructured(trimmed),
      groupId: gid,
    };
  }

  // ─── Structured: [POST_FAILURE] ───
  if (trimmed.startsWith("[POST_FAILURE]")) {
    const acct = trimmed.match(/account=(\S+)/)?.[1] || "";
    const gid = trimmed.match(/group_id=(\S+)/)?.[1] || "";
    let err = trimmed.match(/error=(.*)/)?.[1] || "";
    if ((err.startsWith("'") && err.endsWith("'")) || (err.startsWith('"') && err.endsWith('"'))) {
      err = err.slice(1, -1);
    }
    // Shorten common errors
    err = cleanError(err);
    return {
      raw: line, type: "failure",
      account: acct, accountShort: shortAccount(acct),
      groupName: extractGroupNameStructured(trimmed),
      groupId: gid, error: err,
    };
  }

  // ─── Structured: [FLOOD_WAIT] ───
  if (trimmed.startsWith("[FLOOD_WAIT]")) {
    const acct = trimmed.match(/account=(\S+)/)?.[1] || "";
    const gid = trimmed.match(/group_id=(\S+)/)?.[1] || "";
    const wait = trimmed.match(/wait=(\d+)s/)?.[1] || "0";
    return {
      raw: line, type: "flood",
      account: acct, accountShort: shortAccount(acct),
      groupName: extractGroupNameStructured(trimmed),
      groupId: gid, waitSeconds: wait,
    };
  }

  // ─── Structured: [POST_SKIPPED] — a rate-limit/FloodWait deferral (group's own limit), not a failure ───
  if (trimmed.startsWith("[POST_SKIPPED]")) {
    const acct = trimmed.match(/account=(\S+)/)?.[1] || "";
    const gid = trimmed.match(/group_id=(\S+)/)?.[1] || "";
    const wait = trimmed.match(/floodwait_(\d+)s/)?.[1] || "";
    return {
      raw: line, type: "flood",
      account: acct, accountShort: shortAccount(acct),
      groupName: extractGroupNameStructured(trimmed),
      groupId: gid, waitSeconds: wait,
    };
  }

  // ─── [FloodWait] session=… paused Ns — account-level pause notice (keep, readable) ───
  if (trimmed.startsWith("[FloodWait]") && trimmed.includes("paused")) {
    const sess = (trimmed.match(/session=(\S+)/)?.[1] || "").replace(".session", "");
    const wait = trimmed.match(/paused\s+(\d+)s/)?.[1] || "";
    return {
      raw: line, type: "flood",
      account: sess, accountShort: shortAccount(sess),
      waitSeconds: wait,
      message: `Account paused ${wait}s — Telegram rate-limited this account`,
    };
  }
  // [FloodWait] chat_id=… "skipping group" duplicates the [POST_SKIPPED] line above — hide it.
  if (trimmed.startsWith("[FloodWait]")) {
    return { raw: line, type: "noise" };
  }

  // ─── Human-readable: "Account N - Failed in GROUP: error" ───
  const failMatch = trimmed.match(/^Account\s+(\d+)\s*-\s*Failed in\s+(.+?):\s*(.+)$/);
  if (failMatch) {
    const [, acctNum, group, err] = failMatch;
    return {
      raw: line, type: "failure",
      account: `Account ${acctNum}`, accountShort: `Acc ${acctNum}`,
      groupName: group, groupLink: extractedLink, error: cleanError(err),
    };
  }

  // ─── Human-readable: "Account N - Posted in GROUP" / "Account N - Sent to GROUP" ───
  const successMatch = trimmed.match(/^Account\s+(\d+)\s*-\s*(?:Posted in|Sent to|Success in)\s+(.+)$/);
  if (successMatch) {
    return {
      raw: line, type: "success",
      account: `Account ${successMatch[1]}`, accountShort: `Acc ${successMatch[1]}`,
      groupName: successMatch[2], groupLink: extractedLink,
    };
  }

  // ─── Human-readable: "Account N - FloodWait Ns in GROUP" ───
  const floodMatch = trimmed.match(/^Account\s+(\d+)\s*-\s*FloodWait\s+(\d+)s?\s+in\s+(.+)$/);
  if (floodMatch) {
    return {
      raw: line, type: "flood",
      account: `Account ${floodMatch[1]}`, accountShort: `Acc ${floodMatch[1]}`,
      groupName: floodMatch[3], groupLink: extractedLink, waitSeconds: floodMatch[2],
    };
  }

  // ─── Cycle events ───
  if (trimmed.startsWith("[CycleScheduler]") || trimmed.startsWith("[CycleAssignment]")) {
    const session = trimmed.match(/session=(\S+)/)?.[1] || "";
    const groups = trimmed.match(/groups_ready=(\d+)/)?.[1] || trimmed.match(/assigned=(\d+)/)?.[1] || "";
    return {
      raw: line, type: "cycle_start",
      accountShort: shortAccount(session.replace(".session", "")),
      message: groups ? `Cycle started — ${groups} groups` : "Cycle started",
      detail: trimmed,
    };
  }

  if (trimmed.startsWith("[CycleWindow]")) {
    const session = trimmed.match(/session=(\S+)/)?.[1] || "";
    const cycleEnd = trimmed.match(/expected_next_run_ts=(\d+)/)?.[1];
    let nextIn = "";
    if (cycleEnd) {
      const secs = parseInt(cycleEnd) - Math.floor(Date.now() / 1000);
      if (secs > 0) {
        const mins = Math.floor(secs / 60);
        nextIn = mins > 0 ? `next in ${mins}m` : `next in ${secs}s`;
      }
    }
    return {
      raw: line, type: "cycle_start",
      accountShort: shortAccount(session.replace(".session", "")),
      message: `Cycle window${nextIn ? ` — ${nextIn}` : ""}`,
      detail: trimmed,
    };
  }

  // ─── [NextCycle] session=… next run in N min (cycle continues) — scheduling notice, not a new event ───
  if (trimmed.startsWith("[NextCycle]")) {
    const session = trimmed.match(/session=(\S+)/)?.[1] || "";
    const mins = trimmed.match(/next run in\s+(\d+)\s*min/)?.[1];
    return {
      raw: line, type: "cycle_end",
      accountShort: shortAccount(session.replace(".session", "")),
      message: mins ? `Next cycle in ${mins}m` : "Cycle continues",
      detail: trimmed,
    };
  }

  // ─── Connect events ───
  if (trimmed.startsWith("[Connect]")) {
    const session = trimmed.match(/session=(\S+)/)?.[1] || "";
    if (trimmed.includes("prewarm_ready") || trimmed.includes("connect_end")) {
      const dur = trimmed.match(/duration_sec=([\d.]+)/)?.[1] || "";
      return {
        raw: line, type: "connect",
        accountShort: shortAccount(session.replace(".session", "")),
        message: dur ? `Connected (${dur}s)` : "Connected",
      };
    }
    // Other connect events (prewarm_start, connect_start) — noise
    return { raw: line, type: "noise" };
  }

  // ─── Stagger ───
  if (trimmed.startsWith("[Stagger]")) {
    const wait = trimmed.match(/waiting\s+(\d+)s/)?.[1] || "";
    const session = trimmed.match(/session=(\S+)/)?.[1] || "";
    return {
      raw: line, type: "system",
      accountShort: shortAccount(session.replace(".session", "")),
      message: `Stagger delay — ${wait}s before first cycle`,
    };
  }

  // ─── Timestamp prefix: "2026-05-11 02:47:57 Message" ───
  const tsMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/);
  if (tsMatch) {
    const msg = tsMatch[2];
    // Recursively parse the inner message (handles [POST_SUCCESS], Account N, noise, etc.)
    const inner = parseLine(msg);
    if (inner.type === "noise") return { raw: line, type: "noise" };
    inner.timestamp = tsMatch[1];
    inner.raw = line;
    if (extractedLink && !inner.groupLink) inner.groupLink = extractedLink;
    return inner;
  }

  // ─── Generic system/info ───
  if (trimmed.includes("AdBot started") || trimmed.includes("started")) {
    return { raw: line, type: "system", message: trimmed };
  }
  if (trimmed.includes("AdBot stopped") || trimmed.includes("stopped")) {
    return { raw: line, type: "system", message: trimmed };
  }
  // "+1908…368.session - cycle completed (no groups assigned)" — session-scoped idle notice
  const cycleCompleteMatch = trimmed.match(/^(\S+)\.session\s*-\s*cycle completed\s*(\(.*\))?/);
  if (cycleCompleteMatch) {
    return {
      raw: line, type: "cycle_end",
      accountShort: shortAccount(cycleCompleteMatch[1]),
      message: cycleCompleteMatch[2] === "(no groups assigned)" ? "Cycle complete — no groups assigned" : "Cycle complete",
    };
  }
  if (trimmed.includes("failure rate") || trimmed.includes("cycle complete")) {
    return { raw: line, type: "cycle_end", message: trimmed };
  }

  // Anything else — generic info, not noise
  return { raw: line, type: "system", message: trimmed };
}

function cleanError(err: string): string {
  if (!err) return "";
  // Common Telegram errors → short form
  if (err.includes("can't write in this chat")) return "No write permission";
  if (err.includes("CHAT_WRITE_FORBIDDEN")) return "No write permission";
  if (err.includes("CHANNEL_PRIVATE")) return "Private/banned channel";
  if (err.includes("USER_BANNED_IN_CHANNEL")) return "Account banned in group";
  if (err.includes("SLOWMODE_WAIT")) {
    const s = err.match(/(\d+)/)?.[1];
    return s ? `Slowmode (${s}s)` : "Slowmode active";
  }
  if (err.includes("skip or ignore")) return "Skipped";
  if (err.includes("ForwardMessagesRequest")) {
    // Extract the actual error before "(caused by..."
    const m = err.match(/^(.+?)\s*\(caused by/);
    if (m) return cleanError(m[1]);
  }
  // Truncate very long errors
  if (err.length > 80) return err.slice(0, 77) + "...";
  return err;
}

/* ────────────────────── Filter ────────────────────── */

type FilterType = "all" | "success" | "failure" | "flood" | "system";

// Time ranges for the top stats + list window. ms = Infinity means "all time".
const TIME_RANGES: { key: string; label: string; ms: number }[] = [
  { key: "all", label: "All time", ms: Infinity },
  { key: "1h", label: "Last hour", ms: 3600e3 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3600e3 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 3600e3 },
  { key: "48h", label: "Last 48 hours", ms: 48 * 3600e3 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 3600e3 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 3600e3 },
];

// Parse an entry's UTC timestamp string to epoch ms (NaN if missing/unparseable).
function entryMs(p: ParsedLog): number {
  if (!p.timestamp) return NaN;
  let n = p.timestamp.trim();
  if (!n.endsWith("Z") && !n.includes("+")) n = n.replace(" ", "T") + "Z";
  const t = new Date(n).getTime();
  return isNaN(t) ? NaN : t;
}

// Match a parsed entry against a lowercase free-text query (account, group, status word, reason, raw).
function matchesSearch(p: ParsedLog, q: string): boolean {
  const statusWord = p.type === "success" ? "sent" : p.type === "failure" ? "failed" : p.type === "flood" ? "skipped flood rate limit" : p.type;
  const hay = [
    p.account, p.accountShort, p.groupName, p.groupId, p.error, p.message, p.waitSeconds, statusWord, p.raw,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

/* ────────────────────── Component ────────────────────── */

export default function UserLogsPage() {
  // Fetch a generous window so the top stats & time-range buttons are accurate regardless of how many
  // rows the user chooses to display. Some deployments cap the `lines` query param lower than the API
  // allows (a request for 10000 was seen 422-ing while 1000 succeeded) — rather than hardcode a number
  // that might again exceed whatever the server currently accepts, start generous and step the request
  // size down automatically on a 422 until it succeeds, so the page always shows whatever it can get.
  const [fetchLines, setFetchLines] = useState(1000);
  const [displayCount] = useState(1000);  // how many rows to render
  // usePortalSessionValid() reads localStorage, which doesn't exist during SSR — evaluating it
  // immediately would render a different tree on the server vs. the client's first paint and
  // trigger a hydration mismatch. Defer the invalid-session branch until after mount so the first
  // client render matches the server's, then swap in the real check.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const sessionValid = usePortalSessionValid();
  const { data: bot } = usePortalBot();
  const { data, error: logsError, isLoading: logsLoading, mutate } = usePortalLogs(fetchLines);

  useEffect(() => {
    const status = (logsError as any)?.response?.status;
    if (status === 422 && fetchLines > 100) {
      setFetchLines((n) => (n > 500 ? 500 : n > 200 ? 200 : 100));
    }
  }, [logsError, fetchLines]);

  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [search, setSearch] = useState("");        // free-text search (account, group, status, reason)
  const [view, setView] = useState<"timeline" | "groups">("timeline");  // timeline vs per-group insights
  const [range, setRange] = useState("all");        // time window for stats + list (All time default)
  const [rangeOpen, setRangeOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);

  const lines: string[] = data?.lines || [];

  // Parse all, filter out noise, then collapse each session's scheduler chatter run down to its
  // latest line. A single idle cycle logs "Cycle started" → "Cycle window" → "Cycle started" →
  // "[NextCycle]" for the same session back to back — none of the intermediate states matter once
  // the run moves on, so we keep only the most recent line per same-session chatter run (e.g. just
  // "Next cycle in 30m") instead of rendering all 4-5 as separate rows.
  const parsed = useMemo(() => {
    const list = lines.map(parseLine).filter((p) => p.type !== "noise");
    const collapsed: ParsedLog[] = [];
    const isChatter = (p: ParsedLog) => p.type === "cycle_start" || p.type === "cycle_end" || p.type === "system" || p.type === "connect";
    for (const p of list) {
      const prev = collapsed[collapsed.length - 1];
      if (isChatter(p) && prev && isChatter(prev) && prev.accountShort === p.accountShort && p.accountShort) {
        collapsed[collapsed.length - 1] = p; // supersede — same session's chatter run continues
        continue;
      }
      collapsed.push(p);
    }
    return collapsed;
  }, [lines]);

  // Discover unique accounts (from ALL history so options are stable regardless of the time window)
  const accounts = useMemo(() => {
    const set = new Set<string>();
    for (const p of parsed) {
      if (p.account) set.add(p.account);
    }
    return Array.from(set).sort();
  }, [parsed]);

  // Anchor "now" to the newest log line (robust to client/server clock skew); fall back to real now.
  const nowRef = useMemo(() => {
    let mx = 0;
    for (const p of parsed) { const t = entryMs(p); if (!isNaN(t) && t > mx) mx = t; }
    return mx || Date.now();
  }, [parsed]);
  const rangeMs = TIME_RANGES.find((r) => r.key === range)?.ms ?? Infinity;

  // Entries within the selected time window. Everything below (stats, list, groups) works off this,
  // so the time-range dropdown drives the whole page while the "rows" cap only limits how many render.
  const inRange = useMemo(() => {
    if (rangeMs === Infinity) return parsed;
    const cutoff = nowRef - rangeMs;
    return parsed.filter((p) => { const t = entryMs(p); return !isNaN(t) && t >= cutoff; });
  }, [parsed, nowRef, rangeMs]);

  // Per-account stats (within the selected time window)
  const accountStats = useMemo(() => {
    const map: Record<string, { sent: number; failed: number; flood: number; lastSent?: string; lastFailed?: string; lastEventType?: LogType; lastEventTime?: string }> = {};
    for (const p of inRange) {
      if (!p.account) continue;
      if (!map[p.account]) map[p.account] = { sent: 0, failed: 0, flood: 0 };
      const s = map[p.account];
      if (p.type === "success") {
        s.sent++;
        if (!s.lastSent && p.groupName) s.lastSent = p.groupName;
      } else if (p.type === "failure") {
        s.failed++;
        if (!s.lastFailed && p.groupName) s.lastFailed = p.groupName;
      } else if (p.type === "flood") {
        s.flood++;
      }
      if (p.type === "success" || p.type === "failure" || p.type === "flood") {
        s.lastEventType = p.type;
        s.lastEventTime = p.timestamp;
      }
    }
    return map;
  }, [inRange]);

  // Total matches before we cap to displayCount (so the footer can say "showing 1000 of N")
  const [filtered, matchTotal] = useMemo(() => {
    let result = inRange;
    // Type filter
    if (filter === "success") result = result.filter((p) => p.type === "success");
    else if (filter === "failure") result = result.filter((p) => p.type === "failure");
    else if (filter === "flood") result = result.filter((p) => p.type === "flood");
    else if (filter === "system") result = result.filter((p) => ["system", "cycle_start", "cycle_end", "connect"].includes(p.type));
    // Account filter
    if (accountFilter !== "all") result = result.filter((p) => p.account === accountFilter);
    // Free-text search (account / group / status / reason / raw)
    const q = search.trim().toLowerCase();
    if (q) result = result.filter((p) => matchesSearch(p, q));
    const reversed = [...result].reverse();  // newest first
    const capped = displayCount >= fetchLines ? reversed : reversed.slice(0, displayCount);
    return [capped, reversed.length] as const;
  }, [inRange, filter, accountFilter, search, displayCount, fetchLines]);

  // Per-group aggregation: for every group, which accounts posted / were rate-limited / failed, and when.
  const groupAgg = useMemo(() => {
    const map: Record<string, {
      name: string; groupId?: string;
      byAccount: Record<string, { type: LogType; time?: string; wait?: string }>;
      sent: Set<string>; flood: Set<string>; failed: Set<string>;
      lastTime?: string;
    }> = {};
    for (const p of inRange) {
      if (!p.groupName || !p.account) continue;
      if (p.type !== "success" && p.type !== "failure" && p.type !== "flood") continue;
      const key = p.groupName;
      if (!map[key]) map[key] = { name: p.groupName, groupId: p.groupId, byAccount: {}, sent: new Set(), flood: new Set(), failed: new Set() };
      const g = map[key];
      if (!g.groupId && p.groupId) g.groupId = p.groupId;
      // Keep the most recent status per account (inRange is oldest→newest, so overwrite is fine)
      g.byAccount[p.account] = { type: p.type, time: p.timestamp, wait: p.waitSeconds };
      if (p.timestamp) g.lastTime = p.timestamp;
      (p.type === "success" ? g.sent : p.type === "flood" ? g.flood : g.failed).add(p.account);
    }
    let list = Object.values(map);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((g) => g.name.toLowerCase().includes(q) || (g.groupId || "").toLowerCase().includes(q));
    // Sort: groups with problems (failed/flood) first, then by name
    return list.sort((a, b) => (b.failed.size + b.flood.size) - (a.failed.size + a.flood.size) || a.name.localeCompare(b.name));
  }, [inRange, search]);

  // Top stats. Sent/Failed (with no account filter) always show the bot's persisted lifetime
  // counters — the same numbers the Dashboard reads — regardless of which time range is selected,
  // so the two pages never disagree. The fetched log-file window can only ever hold a slice of
  // history (bounded by fetchLines), so deriving these from the parsed window instead of the
  // lifetime counter is exactly what caused Logs to undercount vs. Dashboard. Flood has no
  // persisted lifetime counter server-side, so it stays windowed either way. Picking a specific
  // account switches back to the windowed per-account count, since lifetime stats aren't broken
  // down by account here.
  const { data: lifetimeStats } = usePortalStats();
  const stats = useMemo(() => {
    let success = 0, failure = 0, flood = 0;
    const source = accountFilter !== "all" ? inRange.filter((p) => p.account === accountFilter) : inRange;
    for (const p of source) {
      if (p.type === "success") success++;
      else if (p.type === "failure") failure++;
      else if (p.type === "flood") flood++;
    }
    const usingLifetime = accountFilter === "all" && !!lifetimeStats;
    if (usingLifetime) {
      success = lifetimeStats!.lifetime_sent ?? success;
      failure = lifetimeStats!.lifetime_failed ?? failure;
      // flood has no persisted lifetime counter server-side — stays windowed (best effort from the fetched log tail)
    }
    // Total tracks whichever scale Sent/Failed are on — lifetime when available, otherwise the same
    // windowed count as everything else — so it never mixes a lifetime figure with a windowed one.
    const total = usingLifetime ? success + failure : success + failure + flood;
    return { success, failure, flood, total };
  }, [inRange, accountFilter, lifetimeStats]);

  const systemCount = useMemo(
    () => inRange.filter((p) => ["system", "cycle_start", "cycle_end", "connect"].includes(p.type)).length,
    [inRange]
  );

  // Accounts currently sitting in a flood/waiting state (their most recent post-event was a flood).
  const waitingAccounts = useMemo(
    () => Object.values(accountStats).filter((s) => s.lastEventType === "flood").length,
    [accountStats]
  );

  const lastSuccessTime = useMemo(() => {
    for (let i = inRange.length - 1; i >= 0; i--) {
      if (inRange[i].type === "success") return inRange[i].timestamp;
    }
    return undefined;
  }, [inRange]);

  const topActiveGroups = useMemo(
    () => [...groupAgg].sort((a, b) => b.sent.size - a.sent.size).filter((g) => g.sent.size > 0).slice(0, 5),
    [groupAgg]
  );
  const topWaitingGroups = useMemo(
    () => [...groupAgg].sort((a, b) => b.flood.size - a.flood.size).filter((g) => g.flood.size > 0).slice(0, 4),
    [groupAgg]
  );

  // Overall health verdict, used by the System Status card + sidebar pill.
  const health = stats.total === 0 ? "quiet" : stats.failure / Math.max(1, stats.total) > 0.15 ? "critical" : stats.failure > 0 || waitingAccounts > 0 ? "attention" : "healthy";
  const healthCopy: Record<string, { label: string; color: string }> = {
    quiet: { label: "No activity yet", color: "text-dark-500" },
    healthy: { label: "Healthy", color: "text-success" },
    attention: { label: "Needs attention", color: "text-warning" },
    critical: { label: "Critical", color: "text-danger" },
  };

  const refresh = () => {
    setRefreshing(true);
    mutate();
    setTimeout(() => setRefreshing(false), 700);
  };

  const filterChips: { key: FilterType; label: string; count: number }[] = [
    { key: "all", label: "All Activity", count: stats.total },
    { key: "success", label: "Successful", count: stats.success },
    { key: "failure", label: "Problems", count: stats.failure },
    { key: "flood", label: "Waiting", count: stats.flood },
    { key: "system", label: "System Events", count: systemCount },
  ];

  if (mounted && !sessionValid) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center gap-3 animate-fade-in">
        <XCircle className="h-8 w-8 text-danger/60" />
        <div>
          <p className="text-sm font-medium text-dark-200">Your session looks invalid</p>
          <p className="text-xs text-dark-500 mt-1">Please log out and log back in to keep seeing live data.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { window.location.href = "/user/login"; }}>
          Go to login
        </Button>
      </div>
    );
  }

  const closeMenus = () => { setRangeOpen(false); setAcctOpen(false); };

  return (
    <div className="space-y-5 animate-fade-in" onClick={closeMenus}>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-dark-100">Live Activity</h1>
          <p className="text-sm text-dark-500 mt-1">See everything your accounts are doing in real time.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={(e) => { e.stopPropagation(); refresh(); }}
            className="flex items-center gap-2 rounded-xl border border-dark-700 bg-dark-900 px-3.5 py-2.5 text-sm font-semibold text-dark-300 hover:bg-dark-800 hover:border-dark-600 transition-colors"
          >
            <RotateCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>

          {/* Time-range dropdown */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setRangeOpen((v) => !v); setAcctOpen(false); }}
              className="flex items-center gap-2.5 rounded-xl border border-dark-700 bg-dark-900 px-3.5 py-2.5 text-sm text-dark-100 hover:bg-dark-800 hover:border-dark-600 transition-colors"
            >
              <span className="text-dark-500 font-medium hidden sm:inline">Showing Data From</span>
              <span className="font-bold">{TIME_RANGES.find((r) => r.key === range)?.label}</span>
              <ChevronDown className="h-3 w-3 text-dark-500" />
            </button>
            {rangeOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-30 min-w-[200px] rounded-2xl border border-dark-700 bg-dark-850 p-1.5 shadow-2xl animate-scale-in">
                {TIME_RANGES.map((r) => {
                  const active = range === r.key;
                  return (
                    <button
                      key={r.key}
                      onClick={() => { setRange(r.key); setRangeOpen(false); }}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "text-dark-100 font-bold bg-dark-800" : "text-dark-400 font-medium hover:bg-dark-800/60"}`}
                    >
                      <span className="w-4 text-accent">{active ? "✓" : ""}</span>
                      {r.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Health overview cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <HealthCard icon={CheckCircle2} value={stats.success} label="Posts Sent" tint="success" />
        <HealthCard icon={Send} value={stats.total} label="Total Posts" tint="accent" />
        <HealthCard icon={XCircle} value={stats.failure} label="Failed Posts" tint="danger" />
        <HealthCard icon={Timer} value={stats.flood} label="Waiting" tint="warning" />
        <HealthCard icon={Users} value={accounts.length} label="Active Accounts" tint="info" />
        <div className="rounded-2xl border border-dark-700/50 bg-gradient-to-br from-dark-900 to-dark-850 px-4 py-3.5 flex items-center gap-3.5">
          <div className="h-9 w-9 rounded-xl bg-success/10 flex items-center justify-center shrink-0">
            <span className="relative flex h-2.5 w-2.5">
              {health === "healthy" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${health === "healthy" ? "bg-success" : health === "attention" ? "bg-warning" : health === "critical" ? "bg-danger" : "bg-dark-600"}`} />
            </span>
          </div>
          <div className="min-w-0">
            <p className={`text-lg font-bold leading-tight ${healthCopy[health].color}`}>{healthCopy[health].label}</p>
            <p className="text-xs text-dark-500 mt-0.5 whitespace-nowrap">System Status</p>
          </div>
        </div>
      </div>
      {accountFilter === "all" && lifetimeStats && (
        <p className="text-[11px] text-dark-600 -mt-3">
          Sent/Failed/Total are lifetime totals (always match the Dashboard) · Waiting reflects the selected time range only
        </p>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={view === "groups" ? "Search a group by name…" : "Search group names, accounts, or messages…"}
          className="w-full rounded-2xl border border-dark-700 bg-dark-900 pl-11 pr-11 py-3.5 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:border-accent/60 focus:ring-4 focus:ring-accent/10 transition-all"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-4 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Filter chips + account dropdown + view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {filterChips.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-all ${
                  active ? "bg-dark-700 text-dark-100 ring-1 ring-dark-500" : "bg-dark-900 text-dark-400 border border-dark-700/50 hover:text-dark-200 hover:border-dark-600"
                }`}
              >
                {f.label}
                <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${active ? "bg-dark-600 text-dark-100" : "bg-dark-800 text-dark-500"}`}>{f.count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-xl border border-dark-700 bg-dark-900 overflow-hidden">
            <button
              onClick={() => setView("timeline")}
              className={`px-3 py-2.5 text-xs font-semibold transition-colors ${view === "timeline" ? "bg-dark-700 text-dark-100" : "text-dark-500 hover:text-dark-300"}`}
            >
              Timeline
            </button>
            <button
              onClick={() => setView("groups")}
              className={`px-3 py-2.5 text-xs font-semibold transition-colors ${view === "groups" ? "bg-dark-700 text-dark-100" : "text-dark-500 hover:text-dark-300"}`}
            >
              By Group
            </button>
          </div>

          {/* Account dropdown */}
          {accounts.length > 1 && (
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => { setAcctOpen((v) => !v); setRangeOpen(false); }}
                className="flex items-center gap-2.5 rounded-xl border border-dark-700 bg-dark-900 px-3.5 py-2.5 text-sm text-dark-100 hover:bg-dark-800 hover:border-dark-600 transition-colors"
              >
                <span className="text-dark-500 font-medium hidden sm:inline">Showing Accounts</span>
                <span className="font-bold">{accountFilter === "all" ? "All Accounts" : `Acc ${accounts.indexOf(accountFilter) + 1}`}</span>
                <ChevronDown className="h-3 w-3 text-dark-500" />
              </button>
              {acctOpen && (
                <div className="absolute right-0 top-[calc(100%+8px)] z-30 min-w-[260px] rounded-2xl border border-dark-700 bg-dark-850 p-1.5 shadow-2xl animate-scale-in">
                  <button
                    onClick={() => { setAccountFilter("all"); setAcctOpen(false); }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors ${accountFilter === "all" ? "bg-dark-800 text-dark-100 font-bold" : "text-dark-400 font-medium hover:bg-dark-800/60"}`}
                  >
                    <span className="w-4 text-accent">{accountFilter === "all" ? "✓" : ""}</span>
                    <span className="flex-1 text-left">All Accounts</span>
                  </button>
                  {accounts.map((acct, i) => {
                    const active = accountFilter === acct;
                    const as = accountStats[acct];
                    return (
                      <button
                        key={acct}
                        onClick={() => { setAccountFilter(acct); setAcctOpen(false); }}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "bg-dark-800 text-dark-100 font-bold" : "text-dark-400 font-medium hover:bg-dark-800/60"}`}
                      >
                        <span className="w-4 text-accent">{active ? "✓" : ""}</span>
                        <span className="flex-1 text-left">Acc {i + 1}</span>
                        <span className={`h-1.5 w-1.5 rounded-full ${as?.lastEventType === "flood" ? "bg-warning" : "bg-success"}`} />
                        <span className="text-xs text-dark-500">{as ? `${as.sent}/${as.sent + as.failed}` : "—"}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Log list + sidebar */}
      <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
          {/* LOG LIST */}
          <div className="min-w-0">
            {view === "groups" ? (
              groupAgg.length === 0 ? (
                <EmptyState label={search ? "No group matches your search" : "No group activity yet"} />
              ) : (
                <div className="grid gap-2.5">
                  {groupAgg.map((g) => (
                    <GroupRow key={g.name} group={g} accounts={accounts} />
                  ))}
                </div>
              )
            ) : logsError ? (
              <div className="rounded-2xl border border-dark-700/50 bg-dark-900 py-16 flex flex-col items-center justify-center gap-2 text-dark-500">
                <XCircle className="h-7 w-7 text-danger/60" />
                <p className="text-sm text-danger/80">Couldn't load logs — retrying every few seconds</p>
                <p className="text-[11px] text-dark-600">{(logsError as any)?.message || "Connection issue"}</p>
              </div>
            ) : logsLoading && lines.length === 0 ? (
              <div className="rounded-2xl border border-dark-700/50 bg-dark-900 py-16 flex flex-col items-center justify-center gap-2 text-dark-500">
                <RotateCw className="h-6 w-6 animate-spin opacity-50" />
                <p className="text-sm">Loading logs…</p>
              </div>
            ) : filtered.length === 0 ? (
              lines.length === 0 ? (
                <EmptyState label="No logs yet — start the bot to see output" icon="🎉" title="Everything looks good." />
              ) : (
                <EmptyState label="No activity found for this time period." title="Nothing matches yet." />
              )
            ) : (
              <div className="grid gap-2.5">
                {filtered.map((entry, i) => (
                  <LogRow
                    key={i}
                    entry={entry}
                    expanded={expandedIdx === i}
                    onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                    showAccount={accountFilter === "all" && accounts.length > 1}
                    accountIndex={accounts.indexOf(entry.account || "") + 1}
                  />
                ))}
              </div>
            )}

            <p className="text-[11px] text-dark-600 text-right mt-3">
              {view === "groups"
                ? `${groupAgg.length} groups · ${accounts.length} accounts · ${TIME_RANGES.find((r) => r.key === range)?.label} · ${data?.total_lines || 0} total log lines`
                : `Showing ${filtered.length} of ${matchTotal} matches · ${TIME_RANGES.find((r) => r.key === range)?.label} · ${data?.total_lines || 0} total in log file`}
            </p>
          </div>

          {/* SIDEBAR */}
          <div className="hidden lg:grid gap-4 sticky top-4">
            <div className="rounded-2xl border border-dark-700/50 bg-dark-900 p-5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-4">Current Status</p>
              <div className={`flex items-center gap-2.5 rounded-xl px-3.5 py-3 mb-5 border ${
                health === "healthy" ? "bg-success/10 border-success/25" : health === "attention" ? "bg-warning/10 border-warning/25" : health === "critical" ? "bg-danger/10 border-danger/25" : "bg-dark-800 border-dark-700"
              }`}>
                <span className="relative flex h-2.5 w-2.5">
                  {health === "healthy" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />}
                  <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${health === "healthy" ? "bg-success" : health === "attention" ? "bg-warning" : health === "critical" ? "bg-danger" : "bg-dark-600"}`} />
                </span>
                <span className={`text-sm font-bold ${healthCopy[health].color}`}>
                  {health === "healthy" ? "All Systems Working" : healthCopy[health].label}
                </span>
              </div>
              <div className="grid gap-3.5">
                <SidebarStat label="Accounts posting" value={`${Object.values(accountStats).filter((s) => s.sent > 0).length} of ${accounts.length || 0}`} />
                <SidebarStat label="Last successful post" value={lastSuccessTime ? relTime(lastSuccessTime) : "—"} />
                <SidebarStat label="Accounts waiting" value={String(waitingAccounts)} tint={waitingAccounts > 0 ? "warning" : undefined} />
                <SidebarStat label="Recent problems" value={String(stats.failure)} tint={stats.failure > 0 ? "danger" : undefined} />
              </div>
            </div>

            {topActiveGroups.length > 0 && (
              <div className="rounded-2xl border border-dark-700/50 bg-dark-900 p-5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-4">Top Active Groups</p>
                <div className="grid gap-3">
                  {topActiveGroups.map((g) => (
                    <div key={g.name} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-dark-200 font-medium truncate">{g.name}</span>
                      <span className="text-xs font-bold text-success shrink-0">{g.sent.size} posts</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {topWaitingGroups.length > 0 && (
              <div className="rounded-2xl border border-dark-700/50 bg-dark-900 p-5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-4">Top Waiting Groups</p>
                <div className="grid gap-3">
                  {topWaitingGroups.map((g) => (
                    <div key={g.name} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-dark-200 font-medium truncate">{g.name}</span>
                      <span className="text-xs font-bold text-warning shrink-0">{g.flood.size}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes scaleInSm { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .animate-scale-in { animation: scaleInSm 150ms cubic-bezier(0.16,1,0.3,1); }
      `}</style>
    </div>
  );
}

/* ────────────────────── Health card ────────────────────── */

function HealthCard({
  icon: Icon,
  value,
  label,
  tint,
}: {
  icon: any;
  value: number;
  label: string;
  tint: "success" | "accent" | "danger" | "warning" | "info";
}) {
  const tintClasses: Record<string, { bg: string; text: string }> = {
    success: { bg: "bg-success/10", text: "text-success" },
    accent: { bg: "bg-accent/10", text: "text-accent" },
    danger: { bg: "bg-danger/10", text: "text-danger" },
    warning: { bg: "bg-warning/10", text: "text-warning" },
    info: { bg: "bg-blue-500/10", text: "text-blue-400" },
  };
  const c = tintClasses[tint];
  return (
    <div className="rounded-2xl border border-dark-700/50 bg-dark-900 px-4 py-3.5 flex items-center gap-3.5 transition-transform hover:-translate-y-0.5">
      <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${c.bg}`}>
        <Icon className={`h-4 w-4 ${c.text}`} />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-bold text-dark-100 leading-tight">{value}</p>
        <p className="text-xs text-dark-500 mt-0.5 whitespace-nowrap">{label}</p>
      </div>
    </div>
  );
}

function SidebarStat({ label, value, tint }: { label: string; value: string; tint?: "warning" | "danger" }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm text-dark-500">{label}</span>
      <span className={`text-sm font-bold ${tint === "warning" ? "text-warning" : tint === "danger" ? "text-danger" : "text-dark-100"}`}>{value}</span>
    </div>
  );
}

/* ────────────────────── Group Row (By Group view) ────────────────────── */

function GroupRow({
  group,
  accounts,
}: {
  group: {
    name: string; groupId?: string;
    byAccount: Record<string, { type: LogType; time?: string; wait?: string }>;
    sent: Set<string>; flood: Set<string>; failed: Set<string>;
  };
  accounts: string[];
}) {
  const total = accounts.length || Object.keys(group.byAccount).length;
  return (
    <div className="rounded-2xl border border-dark-700/50 bg-dark-900 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-dark-100 truncate">{group.name}</p>
          {group.groupId && <p className="text-[10px] text-dark-600 font-mono truncate">{group.groupId}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs">
          <span className="text-success font-semibold">{group.sent.size} sent</span>
          {group.flood.size > 0 && <span className="text-warning font-semibold">{group.flood.size} waiting</span>}
          {group.failed.size > 0 && <span className="text-danger font-semibold">{group.failed.size} failed</span>}
          <span className="text-dark-500">{group.sent.size}/{total} acc</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map((acct, i) => {
          const rec = group.byAccount[acct];
          const t = rec?.time ? toLocalTime(rec.time).time : "";
          const cls = !rec
            ? "bg-dark-800 text-dark-500"
            : rec.type === "success"
            ? "bg-success/10 text-success"
            : rec.type === "flood"
            ? "bg-warning/10 text-warning"
            : "bg-danger/10 text-danger";
          const label = !rec ? "no post" : rec.type === "success" ? "sent" : rec.type === "flood" ? `wait ${rec.wait ? rec.wait + "s" : ""}`.trim() : "failed";
          return (
            <span key={acct} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${cls}`} title={rec?.time ? toLocalTime(rec.time).full : "never posted"}>
              <span className="font-medium">Acc {i + 1}</span>
              <span className="opacity-70">{label}</span>
              {t && <span className="opacity-50">{t}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────── Log Row (Timeline view) ────────────────────── */

// Friendly, plain-language copy for the expand panel — mirrors the reference design's
// "What happened" / "Do you need to do anything?" framing instead of dumping raw fields.
function friendlyCopy(entry: ParsedLog): { title: string; subtitle: string; what: string; action: string } {
  const group = entry.groupName || entry.groupId || "";
  switch (entry.type) {
    case "success":
      return {
        title: "Successfully posted",
        subtitle: group ? `${group}${entry.account ? ` · Using ${entry.account}` : ""}` : entry.account || "",
        what: `Your post was delivered${group ? ` to the ${group} group` : ""} without any issues.`,
        action: "No — everything worked as expected.",
      };
    case "failure":
      return {
        title: "Couldn't send post",
        subtitle: [group, entry.error].filter(Boolean).join(" · "),
        what: `Telegram returned an error while sending this post${group ? ` to ${group}` : ""}.${entry.error ? ` Reason: ${entry.error}.` : ""}`,
        action: "Usually not — we'll retry automatically. If this keeps happening for days, consider checking this group.",
      };
    case "flood": {
      const mins = entry.waitSeconds ? Math.round(Number(entry.waitSeconds) / 60) : null;
      const waitLabel = mins ? `about ${mins} minute${mins === 1 ? "" : "s"}` : entry.waitSeconds ? `${entry.waitSeconds} seconds` : "a short while";
      return {
        title: `Waiting ${waitLabel}`,
        subtitle: entry.message || (group ? `${group} · Telegram asked this account to slow down` : "Telegram asked this account to slow down"),
        what: `Telegram asked this account to wait ${waitLabel} before posting again${group ? ` in ${group}` : ""}. This is normal and happens when an account posts frequently.`,
        action: "Nothing — posting will resume automatically once the wait is over.",
      };
    }
    case "connect":
      return {
        title: "Account connected successfully",
        subtitle: "Ready to post",
        what: "The account connected successfully and is ready to post.",
        action: "No — this is just a confirmation.",
      };
    case "cycle_start":
    case "cycle_end":
      return {
        title: entry.message || "Scheduler update",
        subtitle: "Scheduled automatically",
        what: entry.message?.includes("no groups assigned")
          ? "This account has no groups assigned right now, so its posting cycle completed without sending anything."
          : "The posting scheduler moved to its next step for this account automatically.",
        action: "No — this is background activity.",
      };
    default:
      return {
        title: entry.message || "System event",
        subtitle: "",
        what: entry.message || entry.raw,
        action: "No — this is background activity.",
      };
  }
}

function typeMeta(type: LogType): { icon: any; tint: string; glyphBg: string } {
  switch (type) {
    case "success": return { icon: CheckCircle2, tint: "text-success", glyphBg: "bg-success/10" };
    case "failure": return { icon: XCircle, tint: "text-danger", glyphBg: "bg-danger/10" };
    case "flood": return { icon: Timer, tint: "text-warning", glyphBg: "bg-warning/10" };
    case "connect": return { icon: Wifi, tint: "text-blue-400", glyphBg: "bg-blue-500/10" };
    case "cycle_start": return { icon: Activity, tint: "text-accent", glyphBg: "bg-accent/10" };
    case "cycle_end": return { icon: Zap, tint: "text-dark-400", glyphBg: "bg-dark-800" };
    default: return { icon: Radio, tint: "text-dark-400", glyphBg: "bg-dark-800" };
  }
}

function LogRow({
  entry,
  expanded,
  onToggle,
  showAccount,
  accountIndex,
}: {
  entry: ParsedLog;
  expanded: boolean;
  onToggle: () => void;
  showAccount?: boolean;
  accountIndex?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = friendlyCopy(entry);
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;

  const copyRaw = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div
      onClick={onToggle}
      className={`rounded-2xl border bg-dark-900 px-4 sm:px-5 py-4 cursor-pointer transition-all hover:-translate-y-0.5 hover:border-dark-600 ${expanded ? "border-dark-600 shadow-lg shadow-black/20" : "border-dark-700/50"}`}
    >
      <div className="flex gap-3.5 items-start flex-wrap sm:flex-nowrap">
        <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${meta.glyphBg}`}>
          <Icon className={`h-4 w-4 ${meta.tint}`} />
        </div>
        <div className="flex-1 min-w-[180px]">
          <p className="text-[11px] font-semibold text-dark-500 mb-0.5">
            {entry.timestamp ? relTime(entry.timestamp) : ""}
          </p>
          <p className="text-sm font-bold text-dark-100">{copy.title}</p>
          {copy.subtitle && <p className="text-xs text-dark-500 mt-0.5 truncate">{copy.subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {showAccount && accountIndex && accountIndex > 0 && (
            <span className="rounded-full bg-dark-800 border border-dark-700 px-2.5 py-1 text-[11px] font-semibold text-dark-400">
              Acc {accountIndex}
            </span>
          )}
          <ChevronRight className={`h-4 w-4 text-dark-600 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </div>
      </div>

      {expanded && (
        <div className="mt-4 ml-0 sm:ml-[52px] rounded-xl bg-dark-950 border border-dark-700/50 p-4 sm:p-5 grid gap-3.5 animate-scale-in">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pb-3.5 border-b border-dark-800">
            <ExpandField label="Posted at" value={entry.timestamp ? toLocalTime(entry.timestamp).full : "—"} />
            <ExpandField label="Account" value={entry.account || "—"} />
            <ExpandField label="Group" value={entry.groupName || entry.groupId || "—"} />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-dark-500 mb-1">What happened</p>
            <p className="text-sm text-dark-300 leading-relaxed">{copy.what}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-dark-500 mb-1">Do you need to do anything?</p>
            <p className="text-sm text-dark-300 leading-relaxed">{copy.action}</p>
          </div>
          <div className="pt-3 border-t border-dark-800 relative">
            <p className="text-[10px] font-bold uppercase tracking-wider text-dark-600 mb-1">Log detail</p>
            <p className="text-[11px] font-mono text-dark-600 break-all leading-relaxed pr-8">{entry.raw}</p>
            <button onClick={copyRaw} className="absolute right-0 top-2.5 flex items-center justify-center h-6 w-6 rounded-md text-dark-500 hover:text-dark-200 hover:bg-dark-800 transition-colors" title="Copy raw log">
              {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] font-bold uppercase tracking-wider text-dark-600 block mb-0.5">{label}</span>
      <span className="text-sm font-semibold text-dark-200 break-words">{value}</span>
    </div>
  );
}

function EmptyState({ label, title, icon }: { label: string; title?: string; icon?: string }) {
  return (
    <div className="rounded-2xl border border-dark-700/50 bg-dark-900 py-16 px-6 text-center">
      <div className="text-4xl mb-3">{icon || <MessageSquare className="h-9 w-9 mx-auto opacity-30" />}</div>
      {title && <p className="text-base font-bold text-dark-200 mb-1">{title}</p>}
      <p className="text-sm text-dark-500">{label}</p>
    </div>
  );
}
