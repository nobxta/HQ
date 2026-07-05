"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { usePortalBot, usePortalLogs, usePortalStats, usePortalSessionValid } from "@/lib/hooks/usePortal";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  RotateCw, CheckCircle2, XCircle, AlertTriangle, Clock,
  Radio, Filter, List, Zap, Hash, MessageSquare, Play,
  Timer, ChevronDown, ChevronRight, Send, Wifi, WifiOff,
  Activity, Server, ExternalLink,
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

type FilterType = "all" | "posting" | "success" | "failure" | "flood" | "system";

// Time ranges for the top stats + list window. ms = Infinity means "all time".
const TIME_RANGES: { key: string; label: string; ms: number }[] = [
  { key: "1h", label: "1 hour", ms: 3600e3 },
  { key: "6h", label: "6 hours", ms: 6 * 3600e3 },
  { key: "24h", label: "24 hours", ms: 24 * 3600e3 },
  { key: "48h", label: "48 hours", ms: 48 * 3600e3 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 3600e3 },
  { key: "30d", label: "30 days", ms: 30 * 24 * 3600e3 },
  { key: "all", label: "All time", ms: Infinity },
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
  const [displayCount, setDisplayCount] = useState(1000);  // how many rows to render (default 1000)
  const sessionValid = usePortalSessionValid();
  const { data: bot } = usePortalBot();
  const { data, error: logsError, isLoading: logsLoading, mutate } = usePortalLogs(fetchLines);

  useEffect(() => {
    const status = (logsError as any)?.response?.status;
    if (status === 422 && fetchLines > 100) {
      setFetchLines((n) => (n > 500 ? 500 : n > 200 ? 200 : 100));
    }
  }, [logsError, fetchLines]);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");        // free-text search (account, group, status, reason)
  const [view, setView] = useState<"timeline" | "groups">("timeline");  // timeline vs per-group insights
  const [range, setRange] = useState("24h");       // time window for stats + list (24h default)

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

  // Discover unique accounts (from ALL history so chips are stable regardless of the time window)
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
  // so the time-range buttons drive the whole page while the "rows" selector only limits how many render.
  const inRange = useMemo(() => {
    if (rangeMs === Infinity) return parsed;
    const cutoff = nowRef - rangeMs;
    return parsed.filter((p) => { const t = entryMs(p); return !isNaN(t) && t >= cutoff; });
  }, [parsed, nowRef, rangeMs]);

  // Per-account stats (within the selected time window)
  const accountStats = useMemo(() => {
    const map: Record<string, { sent: number; failed: number; flood: number; lastSent?: string; lastFailed?: string }> = {};
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
    }
    return map;
  }, [inRange]);

  // Total matches before we cap to displayCount (so the footer can say "showing 1000 of N")
  const [filtered, matchTotal] = useMemo(() => {
    let result = inRange;
    // Type filter
    if (filter === "posting") result = result.filter((p) => p.type === "success" || p.type === "failure" || p.type === "flood");
    else if (filter === "success") result = result.filter((p) => p.type === "success");
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
  // lifetime counter is exactly what caused Logs (175) to undercount vs. Dashboard (402). Flood has
  // no persisted lifetime counter server-side, so it stays windowed either way. Picking a specific
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

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = 0;
  }, [data, autoScroll]);

  const toggleExpand = (idx: number) => {
    setExpandedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const filterBtns: { key: FilterType; label: string; icon: any; color: string }[] = [
    { key: "all", label: "All", icon: List, color: "text-dark-300" },
    { key: "posting", label: `Posts (${stats.total})`, icon: Send, color: "text-accent" },
    { key: "success", label: `Sent (${stats.success})`, icon: CheckCircle2, color: "text-success" },
    { key: "failure", label: `Failed (${stats.failure})`, icon: XCircle, color: "text-danger" },
    { key: "flood", label: `Flood (${stats.flood})`, icon: Timer, color: "text-warning" },
    { key: "system", label: "System", icon: Server, color: "text-dark-400" },
  ];

  // Active account stats for the sidebar chip
  const activeAcctStats = accountFilter !== "all" ? accountStats[accountFilter] : null;

  if (!sessionValid) {
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

  return (
    <div className="space-y-4 sm:space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Live Logs</h1>
          {accountFilter !== "all" && (
            <p className="text-xs text-accent mt-0.5">Filtered: {accountFilter}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {bot?.running && (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
              </span>
              Live
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => mutate()}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Time-range selector — drives the stats + list window */}
      <div className="-mx-1 overflow-x-auto pb-1">
        <div className="flex items-center gap-1.5 px-1 min-w-max">
          <Clock className="h-3.5 w-3.5 text-dark-500 shrink-0" />
          {TIME_RANGES.map((r) => {
            const active = range === r.key;
            return (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] sm:text-xs font-medium transition-all ${
                  active ? "bg-accent/20 text-accent ring-1 ring-accent/30" : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Stats Bar — Sent/Failed are lifetime totals (matching the Dashboard) unless a specific
          account is filtered; Flood always reflects the selected time range. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <MiniStat icon={Send} label="Total" value={stats.total} color="text-accent" />
        <MiniStat icon={CheckCircle2} label="Sent" value={stats.success} color="text-success" />
        <MiniStat icon={XCircle} label="Failed" value={stats.failure} color="text-danger" />
        <MiniStat icon={Timer} label="Flood" value={stats.flood} color="text-warning" />
      </div>
      {accountFilter === "all" && lifetimeStats && (
        <p className="text-[10px] text-dark-600 -mt-2">
          Sent/Failed are lifetime totals (always match the Dashboard) · Flood and the rows below only cover the recent log window
        </p>
      )}

      {/* Account filter chips (when active account selected, show its details) */}
      {activeAcctStats && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent/5 border border-accent/20 px-3 py-2.5 animate-slide-up">
          <span className="text-xs font-medium text-accent">{accountFilter}</span>
          <span className="h-3 border-r border-dark-700" />
          <span className="text-[10px] text-success">{activeAcctStats.sent} sent</span>
          <span className="text-[10px] text-danger">{activeAcctStats.failed} failed</span>
          {activeAcctStats.flood > 0 && <span className="text-[10px] text-warning">{activeAcctStats.flood} flood</span>}
          {activeAcctStats.lastSent && (
            <>
              <span className="h-3 border-r border-dark-700" />
              <span className="text-[10px] text-dark-400">Last sent: <span className="text-dark-200">{activeAcctStats.lastSent}</span></span>
            </>
          )}
          {activeAcctStats.lastFailed && (
            <>
              <span className="h-3 border-r border-dark-700 hidden sm:inline" />
              <span className="text-[10px] text-dark-400 hidden sm:inline">Last failed: <span className="text-dark-200">{activeAcctStats.lastFailed}</span></span>
            </>
          )}
          <div className="flex-1" />
          <button onClick={() => setAccountFilter("all")} className="text-[10px] text-dark-500 hover:text-dark-300">Clear</button>
        </div>
      )}

      {/* Filters + Controls */}
      <Card className="!p-3">
        {/* Row 0: Search + view toggle */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="relative flex-1 min-w-[180px]">
            <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={view === "groups" ? "Search a group by name…" : "Search account, group, status, error…"}
              className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-8 pr-8 py-1.5 text-[11px] sm:text-xs text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
                <XCircle className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center rounded-lg border border-dark-700 overflow-hidden">
            <button
              onClick={() => setView("timeline")}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[10px] sm:text-xs font-medium transition-all ${view === "timeline" ? "bg-dark-700 text-dark-100" : "text-dark-400 hover:text-dark-200"}`}
            >
              <List className="h-3 w-3" /> Timeline
            </button>
            <button
              onClick={() => setView("groups")}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[10px] sm:text-xs font-medium transition-all ${view === "groups" ? "bg-dark-700 text-dark-100" : "text-dark-400 hover:text-dark-200"}`}
            >
              <Hash className="h-3 w-3" /> By Group
            </button>
          </div>
        </div>
        {/* Row 1: Type filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {filterBtns.map((f) => {
            const Icon = f.icon;
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[10px] sm:text-xs font-medium transition-all ${
                  active
                    ? "bg-dark-700 text-dark-100 ring-1 ring-dark-500"
                    : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"
                }`}
              >
                <Icon className={`h-3 w-3 ${active ? f.color : ""}`} />
                {f.label}
              </button>
            );
          })}
          <div className="flex-1" />
          <select
            value={displayCount}
            onChange={(e) => setDisplayCount(Number(e.target.value))}
            className="rounded border border-dark-600 bg-dark-800 px-2 py-1 text-[10px] sm:text-xs text-dark-200"
          >
            <option value={200}>200 rows</option>
            <option value={500}>500 rows</option>
            <option value={1000}>1,000 rows</option>
            <option value={2000}>2,000 rows</option>
            <option value={5000}>5,000 rows</option>
            <option value={10000}>All rows</option>
          </select>
        </div>

        {/* Row 2: Account filter (only if 2+ accounts) */}
        {accounts.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-dark-800/50">
            <span className="text-[10px] text-dark-500 mr-1">Account:</span>
            <button
              onClick={() => setAccountFilter("all")}
              className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-all ${
                accountFilter === "all"
                  ? "bg-accent/20 text-accent ring-1 ring-accent/30"
                  : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"
              }`}
            >
              All
            </button>
            {accounts.map((acct, i) => {
              const as = accountStats[acct];
              const active = accountFilter === acct;
              return (
                <button
                  key={acct}
                  onClick={() => setAccountFilter(acct)}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-all ${
                    active
                      ? "bg-accent/20 text-accent ring-1 ring-accent/30"
                      : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"
                  }`}
                >
                  Acc {i + 1}
                  {as && <span className="ml-1 opacity-60">({as.sent}/{as.sent + as.failed})</span>}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Log Entries */}
      <div
        ref={logRef}
        className="h-[60vh] sm:h-[calc(100vh-380px)] min-h-[300px] overflow-y-auto rounded-xl bg-dark-950 border border-dark-700/50"
      >
        {view === "groups" ? (
          groupAgg.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-dark-500">
              <Hash className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-sm">{search ? "No group matches your search" : "No group activity yet"}</p>
            </div>
          ) : (
            <div className="divide-y divide-dark-800/30">
              {groupAgg.map((g) => (
                <GroupRow key={g.name} group={g} accounts={accounts} />
              ))}
            </div>
          )
        ) : logsError ? (
          <div className="flex flex-col items-center justify-center h-full text-dark-500 gap-2">
            <XCircle className="h-8 w-8 mb-1 opacity-40 text-danger" />
            <p className="text-sm text-danger/80">Couldn't load logs — retrying every few seconds</p>
            <p className="text-[10px] text-dark-600">{(logsError as any)?.message || "Connection issue"}</p>
          </div>
        ) : logsLoading && lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-dark-500">
            <RotateCw className="h-6 w-6 mb-2 opacity-40 animate-spin" />
            <p className="text-sm">Loading logs…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-dark-500">
            <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">
              {lines.length === 0 ? "No logs yet — start the bot to see output" : "No matching logs for this filter"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-dark-800/30">
            {filtered.map((entry, i) => (
              <LogEntry
                key={i}
                entry={entry}
                expanded={expandedIdx.has(i)}
                onToggle={() => toggleExpand(i)}
                showAccount={accountFilter === "all" && accounts.length > 1}
                accountIndex={accounts.indexOf(entry.account || "") + 1}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-dark-600 text-right">
        {view === "groups"
          ? `${groupAgg.length} groups · ${accounts.length} accounts · ${TIME_RANGES.find((r) => r.key === range)?.label} · ${data?.total_lines || 0} total log lines`
          : `Showing ${filtered.length} of ${matchTotal} matches · ${TIME_RANGES.find((r) => r.key === range)?.label} · ${data?.total_lines || 0} total in log file`}
      </p>
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
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <p className="text-xs sm:text-sm font-medium text-dark-100 truncate">{group.name}</p>
          {group.groupId && <p className="text-[9px] text-dark-600 font-mono truncate">{group.groupId}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[10px]">
          <span className="text-success">{group.sent.size} sent</span>
          {group.flood.size > 0 && <span className="text-warning">{group.flood.size} skipped</span>}
          {group.failed.size > 0 && <span className="text-danger">{group.failed.size} failed</span>}
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
          const label = !rec ? "no post" : rec.type === "success" ? "sent" : rec.type === "flood" ? `skip ${rec.wait ? rec.wait + "s" : ""}`.trim() : "failed";
          return (
            <span key={acct} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] ${cls}`} title={rec?.time ? toLocalTime(rec.time).full : "never posted"}>
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

/* ────────────────────── Log Entry ────────────────────── */

function LogEntry({
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
  const isPostEvent = entry.type === "success" || entry.type === "failure" || entry.type === "flood";

  // ─── Post events: success / failure / flood ───
  if (isPostEvent) {
    // Account-level events (e.g. "paused …") carry a readable message but no group — show that, not "Unknown group".
    const groupDisplay = entry.groupName || entry.message || entry.groupId || "Unknown group";

    return (
      <div
        className={`px-3 sm:px-4 py-2 cursor-pointer transition-colors hover:bg-dark-900/30 ${
          entry.type === "failure" ? "bg-danger/[0.03]" :
          entry.type === "flood" ? "bg-warning/[0.03]" : ""
        }`}
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Icon */}
          {entry.type === "success" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
          ) : entry.type === "flood" ? (
            <Timer className="h-3.5 w-3.5 text-warning shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-danger shrink-0" />
          )}

          {/* Timestamp */}
          {entry.timestamp && (
            <span className="text-[10px] font-mono text-dark-600 shrink-0 hidden sm:inline" title={toLocalTime(entry.timestamp).full}>
              {toLocalTime(entry.timestamp).time}
            </span>
          )}

          {/* Group name */}
          {entry.groupLink ? (
            <a
              href={entry.groupLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`flex-1 min-w-0 text-xs sm:text-sm truncate inline-flex items-center gap-1 hover:underline ${
                entry.type === "success" ? "text-dark-200 hover:text-accent" :
                entry.type === "flood" ? "text-warning/80 hover:text-warning" : "text-dark-300 hover:text-dark-100"
              }`}
            >
              {groupDisplay}
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
            </a>
          ) : (
            <span className={`flex-1 min-w-0 text-xs sm:text-sm truncate ${
              entry.type === "success" ? "text-dark-200" :
              entry.type === "flood" ? "text-warning/80" : "text-dark-300"
            }`}>
              {groupDisplay}
            </span>
          )}

          {/* Error reason (short) */}
          {entry.type === "failure" && entry.error && (
            <span className="shrink-0 text-[10px] text-danger/60 hidden sm:inline max-w-[180px] truncate">
              {entry.error}
            </span>
          )}

          {/* Status badge */}
          {entry.type === "success" ? (
            <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
              Sent
            </span>
          ) : entry.type === "flood" ? (
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {entry.waitSeconds}s
            </span>
          ) : (
            <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
              Failed
            </span>
          )}

          {/* Account badge */}
          {showAccount && accountIndex && accountIndex > 0 && (
            <span className="shrink-0 rounded bg-dark-800 px-1.5 py-0.5 text-[9px] font-medium text-dark-400 hidden sm:inline">
              Acc {accountIndex}
            </span>
          )}

          {/* Expand */}
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-dark-600 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-dark-600 shrink-0" />
          )}
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="mt-2 ml-5 sm:ml-6 rounded-lg bg-dark-900/50 border border-dark-800/50 p-2.5 space-y-1.5">
            <DetailRow label="Account" value={entry.account || "—"} mono />
            <DetailRow label="Group" value={entry.groupName || "—"} link={entry.groupLink} />
            {entry.groupId && <DetailRow label="Group ID" value={entry.groupId} mono />}
            {entry.error && <DetailRow label="Error" value={entry.error} className="text-danger" />}
            {entry.waitSeconds && <DetailRow label="Wait" value={`${entry.waitSeconds} seconds`} className="text-warning" />}
            {entry.timestamp && <DetailRow label="Time" value={toLocalTime(entry.timestamp).full} mono />}
            <div className="pt-1.5 border-t border-dark-800/50">
              <p className="text-[9px] font-mono text-dark-700 break-all leading-relaxed">{entry.raw}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Cycle start / connect / cycle end — quiet scheduler chatter, not actionable events ───
  // Rendered identically (session chip + muted message) so a run of these reads as one calm
  // status strip instead of three visually distinct row types competing for attention.
  if (entry.type === "cycle_start" || entry.type === "connect" || entry.type === "cycle_end") {
    const icon = entry.type === "connect"
      ? <Wifi className="h-3 w-3 text-success/50 shrink-0" />
      : entry.type === "cycle_end"
      ? <Zap className="h-3 w-3 text-dark-600 shrink-0" />
      : <Activity className="h-3 w-3 text-accent/50 shrink-0" />;
    const isIdle = entry.message?.includes("no groups assigned");

    return (
      <div className="px-3 sm:px-4 py-1 flex items-center gap-2">
        {icon}
        {entry.accountShort && (
          <span className="shrink-0 rounded bg-dark-900 px-1.5 py-[1px] text-[9px] font-mono text-dark-500">
            {entry.accountShort}
          </span>
        )}
        <span className={`text-[11px] truncate ${isIdle ? "text-dark-600" : "text-dark-500"}`}>{entry.message}</span>
      </div>
    );
  }

  // ─── System / info ───
  return (
    <div className="px-3 sm:px-4 py-1.5 flex items-start gap-2">
      {entry.message?.toLowerCase().includes("start") ? (
        <Play className="h-3 w-3 text-success/60 shrink-0 mt-0.5" />
      ) : entry.message?.toLowerCase().includes("stop") ? (
        <XCircle className="h-3 w-3 text-danger/60 shrink-0 mt-0.5" />
      ) : entry.message?.toLowerCase().includes("stagger") || entry.message?.toLowerCase().includes("wait") ? (
        <Clock className="h-3 w-3 text-dark-500 shrink-0 mt-0.5" />
      ) : (
        <Radio className="h-3 w-3 text-dark-500 shrink-0 mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        {entry.timestamp && (
          <span className="text-[10px] font-mono text-dark-600 mr-2" title={toLocalTime(entry.timestamp).full}>{toLocalTime(entry.timestamp).time}</span>
        )}
        <span className={`text-[11px] break-all ${
          entry.message?.toLowerCase().includes("start") ? "text-success/70" :
          entry.message?.toLowerCase().includes("stop") ? "text-danger/70" :
          "text-dark-500"
        }`}>
          {entry.message || entry.raw}
        </span>
      </div>
    </div>
  );
}

/* ────────────────────── Helpers ────────────────────── */

function DetailRow({ label, value, mono, className, link }: { label: string; value: string; mono?: boolean; className?: string; link?: string }) {
  return (
    <div className="flex gap-2 text-[10px] sm:text-xs">
      <span className="text-dark-600 shrink-0 w-16">{label}</span>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline inline-flex items-center gap-1 break-all">
          {value}
          <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
        </a>
      ) : (
        <span className={`${mono ? "font-mono" : ""} ${className || "text-dark-400"} break-all`}>{value}</span>
      )}
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-lg bg-dark-900 border border-dark-700/50 px-2.5 py-2 sm:px-3 sm:py-2.5 text-center">
      <Icon className={`h-3.5 w-3.5 mx-auto mb-0.5 ${color}`} />
      <p className={`text-sm sm:text-base font-bold ${color}`}>{value}</p>
      <p className="text-[9px] sm:text-[10px] text-dark-500">{label}</p>
    </div>
  );
}
