"use client";
import { useState, useEffect, useMemo } from "react";
import { usePortalBot, usePortalLogs, usePortalStats, usePortalSessionValid } from "@/lib/hooks/usePortal";
import Button from "@/components/ui/Button";
import {
  RotateCw, CheckCircle2, XCircle, Clock,
  Search, MessageSquare,
  ChevronDown, ChevronRight, ChevronLeft, Send,
  Users, Copy, Check, Download, Filter,
  ExternalLink, X, Info,
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

// Stable key for matching the SAME physical account across its two log representations:
// post events carry account=<number>, cycle/connect events carry session=<number>.session.
// Both are phone numbers, so the last-6 digits identify one account. Falls back to a lowercased
// string for non-numeric ids like "Account 3".
function digitsKey(s?: string): string {
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  return d ? d.slice(-6) : s.trim().toLowerCase();
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

// Resolve where a post went. Order of preference:
//  1. a link already parsed off the line (groupLink) — the exact message permalink when present,
//  2. any t.me / telegram.me URL sitting in the raw text (human-readable "Posted in X (https://…)"),
//  3. a link built from the structured group_id, which for supergroups looks like -100<channel>#<thread>
//     (e.g. -1002359309381#21) → https://t.me/c/<channel>/<thread> so it opens the exact topic.
function messageLink(entry: ParsedLog): string | undefined {
  if (entry.groupLink) return entry.groupLink;
  const m = entry.raw.match(/https?:\/\/(?:t\.me|telegram\.me)\/[^\s"'<>)]+/i);
  if (m) return m[0];
  const gid = (entry.groupId || "").trim();
  const sup = gid.match(/^-100(\d+)(?:[#/](\d+))?$/);
  if (sup) return sup[2] ? `https://t.me/c/${sup[1]}/${sup[2]}` : `https://t.me/c/${sup[1]}`;
  return undefined;
}

// Split a trailing "(https://…)" off a human-readable group name so the name stays clean and the
// URL becomes the link. Handles "Pork Market (https://t.me/c/2359309381/3679132?thread=21)".
function splitTrailingLink(g: string): { name: string; link?: string } {
  const m = g.match(/^(.*?)\s*\((https?:\/\/[^\s()]+)\)\s*$/);
  if (m) return { name: m[1].trim(), link: m[2] };
  return { name: g.trim() };
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
    const g = splitTrailingLink(group);
    return {
      raw: line, type: "failure",
      account: `Account ${acctNum}`, accountShort: `Acc ${acctNum}`,
      groupName: g.name, groupLink: g.link || extractedLink, error: cleanError(err),
    };
  }

  // ─── Human-readable: "Account N - Posted in GROUP (link)" / "Account N - Sent to GROUP" ───
  const successMatch = trimmed.match(/^Account\s+(\d+)\s*-\s*(?:Posted in|Sent to|Success in)\s+(.+)$/);
  if (successMatch) {
    const g = splitTrailingLink(successMatch[2]);
    return {
      raw: line, type: "success",
      account: `Account ${successMatch[1]}`, accountShort: `Acc ${successMatch[1]}`,
      groupName: g.name, groupLink: g.link || extractedLink,
    };
  }

  // ─── Human-readable: "Account N - FloodWait Ns in GROUP" ───
  const floodMatch = trimmed.match(/^Account\s+(\d+)\s*-\s*FloodWait\s+(\d+)s?\s+in\s+(.+)$/);
  if (floodMatch) {
    const g = splitTrailingLink(floodMatch[3]);
    return {
      raw: line, type: "flood",
      account: `Account ${floodMatch[1]}`, accountShort: `Acc ${floodMatch[1]}`,
      groupName: g.name, groupLink: g.link || extractedLink, waitSeconds: floodMatch[2],
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

// Time ranges shown as the segmented control. `seg` marks the ones in the top segmented control;
// `label` is the short segment label, `long` the descriptive form used in captions/empty states.
const TIME_RANGES: { key: string; label: string; long: string; ms: number }[] = [
  { key: "all", label: "All Time", long: "all time", ms: Infinity },
  { key: "1h", label: "1H", long: "last hour", ms: 3600e3 },
  { key: "6h", label: "6H", long: "last 6 hours", ms: 6 * 3600e3 },
  { key: "12h", label: "12H", long: "last 12 hours", ms: 12 * 3600e3 },
  { key: "24h", label: "24H", long: "last 24 hours", ms: 24 * 3600e3 },
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
  // Light by default (fast, low load), but escalates automatically — no manual buttons:
  //   • typing a search looks through the WHOLE file (fetchLines = 0),
  //   • paging toward the oldest rows grows the live tail (browseLines) a chunk at a time.
  const [browseLines, setBrowseLines] = useState(1500);  // depth of the live tail; grows as you page back
  const [search, setSearch] = useState("");              // free-text search (account, group, status, reason)
  const searching = search.trim().length > 0;
  const fetchLines = searching ? 0 : browseLines;        // 0 = whole file
  const [displayCount] = useState(1000);  // how many rows to render
  // usePortalSessionValid() reads localStorage, which doesn't exist during SSR — evaluating it
  // immediately would render a different tree on the server vs. the client's first paint and
  // trigger a hydration mismatch. Defer the invalid-session branch until after mount so the first
  // client render matches the server's, then swap in the real check.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const sessionValid = usePortalSessionValid();
  const { data: bot } = usePortalBot();
  // Poll fast for the light live tail; back off to 12s once a big window (or the whole file) is
  // loaded so we don't re-transfer thousands of lines every 3 seconds.
  const logsPollMs = fetchLines === 0 || fetchLines > 3000 ? 12000 : 3000;
  const { data, error: logsError, isLoading: logsLoading, mutate } = usePortalLogs(fetchLines, logsPollMs);

  useEffect(() => {
    const status = (logsError as any)?.response?.status;
    if (status === 422 && browseLines > 100) {
      setBrowseLines((n) => (n > 500 ? 500 : n > 200 ? 200 : 100));
    }
  }, [logsError, browseLines]);

  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [selected, setSelected] = useState<ParsedLog | null>(null);   // row expanded inline
  const [range, setRange] = useState("all");        // time window for stats + list (All time default)
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [view, setView] = useState<"timeline" | "groups">("timeline");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [acctOpen, setAcctOpen] = useState(false);  // account dropdown
  const [funnelOpen, setFunnelOpen] = useState(false);  // toolbar filter popover
  // Reset to page 1 whenever the underlying result set changes.
  useEffect(() => { setPage(1); }, [filter, accountFilter, search, range, sort, perPage, view]);

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

  // The account list is driven by the bot's CONFIGURED sessions — so every account shows in a stable
  // slot (numbered by its real config index), including ones that never posted this window (e.g. a
  // session that was temporarily unable to connect). Falling back to log-discovered accounts only
  // when the config sessions aren't available keeps older/detached views working.
  type AcctItem = { id: string; index: number; name: string; digits: string };
  const accountList: AcctItem[] = useMemo(() => {
    const sessions = (bot?.sessions as Array<{ file?: string; real_name?: string; index?: number }> | undefined) || [];
    if (sessions.length) {
      return sessions
        .map((s, i) => {
          const file = String(s.file || "");
          const phone = file.replace(/\.session$/, "");
          const index = Number(s.index) || i + 1;
          return { id: phone || `idx-${index}`, index, name: (s.real_name || phone || `Account ${index}`), digits: digitsKey(phone) };
        })
        .sort((a, b) => a.index - b.index);
    }
    // Fallback: discover from logs (previous behaviour) when config sessions are unavailable.
    const set = new Set<string>();
    for (const p of parsed) if (p.account) set.add(p.account);
    return Array.from(set).sort().map((a, i) => ({ id: a, index: i + 1, name: `Account ${i + 1}`, digits: digitsKey(a) }));
  }, [bot, parsed]);

  // A log line identifies its account inconsistently: post lines carry account=+14699469531,
  // forwarded lines carry "Account N" (an ordinal), cycle/connect lines carry only a session tail
  // (…469531). Match a line to a configured account by last-6 digits OR by that ordinal → index.
  const entryOrdinal = (p: ParsedLog): number => {
    const m = /^Account\s+(\d+)$/.exec(p.account || "");
    return m ? Number(m[1]) : 0;
  };
  const matchesAccount = (p: ParsedLog, acct: AcctItem): boolean => {
    const k = digitsKey(p.account || p.accountShort);
    if (acct.digits && k && k === acct.digits) return true;
    const ord = entryOrdinal(p);
    return ord > 0 && ord === acct.index;
  };
  const resolveAcctIndex = (entry: ParsedLog): number => {
    const hit = accountList.find((a) => matchesAccount(entry, a));
    return hit ? hit.index : 0;
  };
  // Raw account ids exactly as they appear in the logs (group.byAccount is keyed by these).
  const logAccountIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of parsed) if (p.account) set.add(p.account);
    return Array.from(set).sort();
  }, [parsed]);
  // Map a raw log account id to its configured 1-based index (for stable "Acc N" labels).
  const logAcctIndex = (rawId: string): number => resolveAcctIndex({ account: rawId } as ParsedLog);

  const rangeMs = TIME_RANGES.find((r) => r.key === range)?.ms ?? Infinity;

  // Entries within the selected time window, measured from the ACTUAL current time — so "Last hour"
  // means the hour up to right now, not the last hour of whenever the newest log happened to be.
  // (Previously this anchored to the newest log line, so a bot idle for a day still showed a full
  // "last hour" of day-old posts. Timestamps are UTC and Date.now() is UTC epoch, so this is a
  // correct comparison; a re-render each poll keeps it fresh.) Re-evaluated whenever data changes.
  const inRange = useMemo(() => {
    if (rangeMs === Infinity) return parsed;
    const cutoff = Date.now() - rangeMs;
    return parsed.filter((p) => { const t = entryMs(p); return !isNaN(t) && t >= cutoff; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, rangeMs, data]);

  // Per-account stats (within the selected time window), keyed by configured account id so a
  // non-posting account still gets an entry (shown as 0/0 rather than vanishing).
  const accountStats = useMemo(() => {
    const map: Record<string, { sent: number; failed: number; flood: number; lastSent?: string; lastFailed?: string; lastEventType?: LogType; lastEventTime?: string }> = {};
    for (const acct of accountList) map[acct.id] = { sent: 0, failed: 0, flood: 0 };
    for (const p of inRange) {
      if (!p.account) continue;
      const acct = accountList.find((a) => matchesAccount(p, a));
      if (!acct) continue;
      const s = map[acct.id];
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
  }, [inRange, accountList]);

  // Full matching set (sorted), then a page slice for the table. inRange is oldest→newest.
  const sortedAll = useMemo(() => {
    let result = inRange;
    if (filter === "success") result = result.filter((p) => p.type === "success");
    else if (filter === "failure") result = result.filter((p) => p.type === "failure");
    else if (filter === "flood") result = result.filter((p) => p.type === "flood");
    else if (filter === "system") result = result.filter((p) => ["system", "cycle_start", "cycle_end", "connect"].includes(p.type));
    if (accountFilter !== "all") {
      const acct = accountList.find((a) => a.id === accountFilter);
      if (acct) result = result.filter((p) => matchesAccount(p, acct));
    }
    const q = search.trim().toLowerCase();
    if (q) result = result.filter((p) => matchesSearch(p, q));
    return sort === "newest" ? [...result].reverse() : [...result];
  }, [inRange, filter, accountFilter, search, sort, accountList]);

  const matchTotal = sortedAll.length;
  const totalPages = Math.max(1, Math.ceil(matchTotal / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => sortedAll.slice((safePage - 1) * perPage, safePage * perPage),
    [sortedAll, safePage, perPage]
  );

  // Auto-load older history as the user pages toward the end of what's loaded. Reaching the last
  // page while more log lines exist on the server pulls the next chunk — so scrolling far back just
  // works, with no "Load older" button. (Search already loads the whole file via fetchLines=0.)
  const hasMoreOnServer = (data?.total_lines ?? 0) > lines.length;
  useEffect(() => {
    if (searching || logsLoading) return;
    if (safePage >= totalPages && hasMoreOnServer) {
      setBrowseLines((n) => (n >= 20000 ? n : n + 5000));
    }
  }, [safePage, totalPages, hasMoreOnServer, searching, logsLoading]);

  // Per-group aggregation for the "By Group" view (respects search).
  const groupAgg = useMemo(() => {
    const map: Record<string, {
      name: string; groupId?: string; groupLink?: string;
      byAccount: Record<string, { type: LogType; time?: string; wait?: string; link?: string }>;
      sent: Set<string>; flood: Set<string>; failed: Set<string>; lastTime?: string;
    }> = {};
    for (const p of inRange) {
      if (!p.groupName || !p.account) continue;
      if (p.type !== "success" && p.type !== "failure" && p.type !== "flood") continue;
      const key = p.groupName;
      if (!map[key]) map[key] = { name: p.groupName, groupId: p.groupId, groupLink: p.groupLink, byAccount: {}, sent: new Set(), flood: new Set(), failed: new Set() };
      const g = map[key];
      if (!g.groupId && p.groupId) g.groupId = p.groupId;
      if (!g.groupLink && p.groupLink) g.groupLink = p.groupLink;
      g.byAccount[p.account] = { type: p.type, time: p.timestamp, wait: p.waitSeconds, link: p.groupLink };
      if (p.timestamp) g.lastTime = p.timestamp;
      (p.type === "success" ? g.sent : p.type === "flood" ? g.flood : g.failed).add(p.account);
    }
    let list = Object.values(map);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((g) => g.name.toLowerCase().includes(q) || (g.groupId || "").toLowerCase().includes(q));
    return list.sort((a, b) => (b.failed.size + b.flood.size) - (a.failed.size + a.flood.size) || a.name.localeCompare(b.name));
  }, [inRange, search]);

  // Top stats. On "All time" with no account filter, Sent/Failed show the bot's persisted lifetime
  // counters — the same numbers the Dashboard reads — so the two pages agree. For any OTHER time
  // range (or a specific account) the numbers are counted purely from the entries inside that
  // window, so picking "Last hour" / "Today" actually narrows the counts (and shows 0 when there
  // was no activity in that span) instead of being frozen at the lifetime total. Flood never has a
  // persisted lifetime counter server-side, so it's always windowed.
  const { data: lifetimeStats } = usePortalStats();
  const stats = useMemo(() => {
    let success = 0, failure = 0, flood = 0;
    const _acct = accountFilter !== "all" ? accountList.find((a) => a.id === accountFilter) : undefined;
    const source = _acct ? inRange.filter((p) => matchesAccount(p, _acct)) : inRange;
    for (const p of source) {
      if (p.type === "success") success++;
      else if (p.type === "failure") failure++;
      else if (p.type === "flood") flood++;
    }
    const usingLifetime = range === "all" && accountFilter === "all" && !!lifetimeStats;
    if (usingLifetime) {
      success = lifetimeStats!.lifetime_sent ?? success;
      failure = lifetimeStats!.lifetime_failed ?? failure;
      // flood has no persisted lifetime counter server-side — stays windowed (best effort from the fetched log tail)
    }
    // Total tracks whichever scale Sent/Failed are on — lifetime when available, otherwise the same
    // windowed count as everything else — so it never mixes a lifetime figure with a windowed one.
    const total = usingLifetime ? success + failure : success + failure + flood;
    return { success, failure, flood, total, usingLifetime };
  }, [inRange, accountFilter, range, lifetimeStats, accountList]);

  // Counts for the filter chips MUST come from the rows the table can actually show (the fetched
  // window, honouring the account filter) — NOT the lifetime totals used by the top stat cards.
  // Otherwise a chip promises "Problems 156" while the fetched log tail holds none, and clicking it
  // shows "Nothing here". These counts always match what the list renders.
  const windowCounts = useMemo(() => {
    const _acct = accountFilter !== "all" ? accountList.find((a) => a.id === accountFilter) : undefined;
    const src = _acct ? inRange.filter((p) => matchesAccount(p, _acct)) : inRange;
    let success = 0, failure = 0, flood = 0, system = 0;
    for (const p of src) {
      if (p.type === "success") success++;
      else if (p.type === "failure") failure++;
      else if (p.type === "flood") flood++;
      else if (["system", "cycle_start", "cycle_end", "connect"].includes(p.type)) system++;
    }
    return { success, failure, flood, system, total: src.length };
  }, [inRange, accountFilter, accountList]);
  const systemCount = windowCounts.system;

  const refresh = () => {
    setRefreshing(true);
    mutate();
    setTimeout(() => setRefreshing(false), 700);
  };

  // Download the currently-filtered logs as a text file.
  const exportLogs = () => {
    const text = sortedAll.map((p) => p.raw).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `logs-${bot?.name || "bot"}-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
    URL.revokeObjectURL(url);
  };

  const filterOptions: { key: FilterType; label: string; count: number }[] = [
    { key: "all", label: "All Activity", count: windowCounts.total },
    { key: "success", label: "Successful", count: windowCounts.success },
    { key: "failure", label: "Problems", count: windowCounts.failure },
    { key: "flood", label: "Waiting", count: windowCounts.flood },
    { key: "system", label: "System Events", count: windowCounts.system },
  ];

  const pct = (n: number) => (stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);

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

  const _activeAcct = accountList.find((a) => a.id === accountFilter);
  const acctLabel = accountFilter === "all" || !_activeAcct ? "All Accounts" : `Account ${_activeAcct.index}`;

  return (
    <div className="animate-fade-in" onClick={() => { setAcctOpen(false); setFunnelOpen(false); }}>
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-dark-100">Live Logs</h1>
            {bot?.running && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
                </span>
                Live
              </span>
            )}
          </div>
          <p className="text-sm text-dark-500 mt-1">
            {searching
              ? "Searching across your full log history"
              : "Real-time activity from all your accounts"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Segmented time range (timestamp-wise) */}
          <div className="flex items-center rounded-xl border border-dark-700 bg-dark-900 p-1">
            {TIME_RANGES.map((r) => {
              const active = range === r.key;
              return (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-colors ${active ? "bg-accent text-white shadow-sm" : "text-dark-400 hover:text-dark-200"}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); refresh(); }}
            className="flex items-center justify-center h-9 w-9 rounded-xl border border-dark-700 bg-dark-900 text-dark-400 hover:text-dark-200 hover:border-dark-600 transition-colors"
            aria-label="Refresh"
          >
            <RotateCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="flex sm:grid sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 mb-4 overflow-x-auto sm:overflow-visible no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
        <StatCard icon={Send} label="Total Sent" value={stats.total} tint="accent" sub="All attempts" />
        <StatCard icon={CheckCircle2} label="Successful" value={stats.success} tint="success" sub={`${pct(stats.success)}% success rate`} subTint="success" />
        <StatCard icon={XCircle} label="Failed" value={stats.failure} tint="danger" sub={`${pct(stats.failure)}% failure rate`} subTint="danger" />
        <StatCard icon={Clock} label="Waiting" value={stats.flood} tint="warning" sub="In queue" subTint="warning" />
        <StatCard icon={Users} label="Active Accounts" value={accountList.length} tint="info" sub="Active sessions" />
      </div>
      {stats.usingLifetime && (
        <p className="text-[11px] text-dark-600 -mt-2 mb-3">Showing lifetime totals (match the Dashboard) · pick a range to see recent activity.</p>
      )}

      {/* ── View + account controls (status filtering lives in the funnel next to search) ── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-2 ml-auto">
          {/* Timeline / By Group */}
          <div className="flex items-center rounded-xl border border-dark-700 bg-dark-900 overflow-hidden">
            <button onClick={() => setView("timeline")} className={`px-3 py-2 text-xs font-semibold transition-colors ${view === "timeline" ? "bg-dark-700 text-dark-100" : "text-dark-500 hover:text-dark-300"}`}>Timeline</button>
            <button onClick={() => setView("groups")} className={`px-3 py-2 text-xs font-semibold transition-colors ${view === "groups" ? "bg-dark-700 text-dark-100" : "text-dark-500 hover:text-dark-300"}`}>By Group</button>
          </div>

          {/* Account-wise dropdown — lists every configured account (even non-posting ones) */}
          {accountList.length > 1 && (
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setAcctOpen((v) => !v)}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${accountFilter !== "all" ? "border-accent/40 bg-accent/10 text-accent" : "border-dark-700 bg-dark-900 text-dark-300 hover:border-dark-600"}`}
              >
                {acctLabel}
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
              {acctOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[200px] rounded-xl border border-dark-700 bg-dark-850 p-1.5 shadow-2xl animate-scale-in">
                  <button onClick={() => { setAccountFilter("all"); setAcctOpen(false); }} className={`flex w-full items-center rounded-lg px-2.5 py-2 text-[13px] transition-colors ${accountFilter === "all" ? "bg-dark-800 text-dark-100 font-semibold" : "text-dark-400 hover:bg-dark-800/60"}`}>All Accounts</button>
                  {accountList.map((a) => {
                    const st = accountStats[a.id];
                    return (
                      <button key={a.id} onClick={() => { setAccountFilter(a.id); setAcctOpen(false); }} className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${accountFilter === a.id ? "bg-dark-800 text-dark-100 font-semibold" : "text-dark-400 hover:bg-dark-800/60"}`}>
                        <span className="truncate">Account {a.index}</span>
                        <span className="text-[11px] text-dark-500 tabular-nums shrink-0">{st ? `${st.sent}/${st.sent + st.failed}` : "0/0"}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Table / group card ── */}
      <div className="rounded-2xl border border-dark-700/50 bg-dark-900 overflow-hidden">
        {/* Toolbar: search + sort + export */}
        <div className="flex flex-wrap items-center gap-2 p-2.5 sm:p-3 border-b border-dark-800">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={view === "groups" ? "Search a group…" : "Search group or account…"}
              className="w-full rounded-xl border border-dark-700 bg-dark-950 pl-10 pr-9 py-2 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:border-accent/60 focus:ring-4 focus:ring-accent/10 transition-all"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {view === "timeline" && (
            <div className="relative">
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
                className="appearance-none rounded-xl border border-dark-700 bg-dark-950 pl-3 pr-8 py-2 text-sm text-dark-200 outline-none focus:border-accent/60"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
            </div>
          )}
          {/* Filter funnel */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setFunnelOpen((v) => !v)}
              className={`flex items-center justify-center h-[38px] w-[38px] rounded-xl border transition-colors ${filter !== "all" || accountFilter !== "all" ? "border-accent/40 bg-accent/10 text-accent" : "border-dark-700 bg-dark-950 text-dark-400 hover:text-dark-200 hover:border-dark-600"}`}
              aria-label="Filters"
            >
              <Filter className="h-4 w-4" />
            </button>
            {funnelOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-60 rounded-2xl border border-dark-700 bg-dark-850 p-3 shadow-2xl animate-scale-in">
                <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-2">Status</p>
                <div className="flex flex-col gap-1 mb-3">
                  {filterOptions.map((o) => (
                    <button key={o.key} onClick={() => setFilter(o.key)} className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-[13px] transition-colors ${filter === o.key ? "bg-accent/15 text-accent font-semibold" : "text-dark-300 hover:bg-dark-800"}`}>
                      {o.label}<span className="text-xs font-bold tabular-nums opacity-70">{o.count}</span>
                    </button>
                  ))}
                </div>
                {accountList.length > 1 && (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-2">Account</p>
                    <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} className="w-full rounded-lg border border-dark-700 bg-dark-900 px-2.5 py-2 text-[13px] text-dark-200 outline-none focus:border-accent/60">
                      <option value="all">All accounts</option>
                      {accountList.map((a) => <option key={a.id} value={a.id}>Account {a.index}</option>)}
                    </select>
                  </>
                )}
                {(filter !== "all" || accountFilter !== "all") && (
                  <button onClick={() => { setFilter("all"); setAccountFilter("all"); }} className="mt-3 w-full rounded-lg border border-dark-700 py-2 text-xs font-semibold text-dark-400 hover:text-dark-200 hover:border-dark-600 transition-colors">Clear filters</button>
                )}
              </div>
            )}
          </div>
          <button
            onClick={exportLogs}
            className="flex items-center justify-center h-[38px] w-[38px] rounded-xl border border-dark-700 bg-dark-950 text-dark-400 hover:text-dark-200 hover:border-dark-600 transition-colors"
            aria-label="Export logs"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>

        {view === "groups" ? (
          groupAgg.length === 0 ? (
            <EmptyState title={search ? "No group matches" : "No group activity"} label={search ? `Nothing matches "${search}".` : "No posts in this range yet."} />
          ) : (
            <div className="divide-y divide-dark-800/60">
              {groupAgg.map((g) => <GroupRow key={g.name} group={g} accounts={logAccountIds} acctIndexOf={logAcctIndex} />)}
            </div>
          )
        ) : (
          <>
            {/* Header row (desktop) */}
            <div className="hidden md:grid grid-cols-[96px_112px_1fr_120px_28px] gap-3 px-4 py-2 border-b border-dark-800 text-[10px] font-bold uppercase tracking-wider text-dark-500">
              <span>Time</span>
              <span>Status</span>
              <span>Group / Channel</span>
              <span>Account</span>
              <span />
            </div>

            {logsError ? (
              <EmptyState title="Couldn't load logs" label="Retrying every few seconds…" />
            ) : logsLoading && lines.length === 0 ? (
              <div className="py-16 flex flex-col items-center justify-center gap-2 text-dark-500">
                <RotateCw className="h-6 w-6 animate-spin opacity-50" />
                <p className="text-sm">Loading logs…</p>
              </div>
            ) : pageRows.length === 0 ? (
              lines.length === 0 ? (
                <EmptyState title="No logs yet" label="Start the bot to see output here." />
              ) : search ? (
                <EmptyState title="No results" label={`Nothing matches "${search}".`} />
              ) : range !== "all" ? (
                <EmptyState title="No recent activity" label={`Nothing in the ${(TIME_RANGES.find((r) => r.key === range)?.long || "")}. Try a longer range or All Time.`} />
              ) : (
                <EmptyState title="Nothing here" label="No activity for this filter." />
              )
            ) : (
              <div className="divide-y divide-dark-800/60">
                {pageRows.map((entry, i) => (
                  <LogTableRow
                    key={i}
                    entry={entry}
                    accountIndex={resolveAcctIndex(entry)}
                    expanded={selected === entry}
                    botName={bot?.name}
                    onToggle={() => setSelected(selected === entry ? null : entry)}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {matchTotal > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-dark-800">
                <p className="text-xs text-dark-500">
                  Showing {(safePage - 1) * perPage + 1} to {Math.min(safePage * perPage, matchTotal)} of {matchTotal.toLocaleString()} logs
                </p>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} className="flex items-center justify-center h-8 w-8 rounded-lg border border-dark-700 text-dark-400 hover:text-dark-200 hover:border-dark-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  {pageNumbers(safePage, totalPages).map((n, idx) =>
                    n === "…" ? (
                      <span key={`e${idx}`} className="px-1.5 text-dark-600 text-sm">…</span>
                    ) : (
                      <button key={n} onClick={() => setPage(n as number)} className={`h-8 min-w-8 px-2 rounded-lg text-sm font-semibold transition-colors ${n === safePage ? "bg-accent text-white" : "border border-dark-700 text-dark-400 hover:text-dark-200 hover:border-dark-600"}`}>{n}</button>
                    )
                  )}
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} className="flex items-center justify-center h-8 w-8 rounded-lg border border-dark-700 text-dark-400 hover:text-dark-200 hover:border-dark-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <div className="relative ml-1">
                    <select value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} className="appearance-none rounded-lg border border-dark-700 bg-dark-950 pl-2.5 pr-7 py-1.5 text-xs text-dark-300 outline-none focus:border-accent/60">
                      {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-dark-500" />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <style jsx global>{`
        @keyframes scaleInSm { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .animate-scale-in { animation: scaleInSm 150ms cubic-bezier(0.16,1,0.3,1); }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}

/* ────────────────────── Pagination helper ────────────────────── */

function pageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push("…");
  out.push(total);
  return out;
}

/* ────────────────────── Status meta ────────────────────── */

function statusMeta(type: LogType): { label: string; dot: string; text: string; action: string } {
  switch (type) {
    case "success": return { label: "Sent", dot: "bg-success", text: "text-success", action: "Message Sent" };
    case "failure": return { label: "Failed", dot: "bg-danger", text: "text-danger", action: "Send Failed" };
    case "flood": return { label: "Waiting", dot: "bg-warning", text: "text-warning", action: "Rate Limited (FloodWait)" };
    case "connect": return { label: "Connected", dot: "bg-blue-400", text: "text-blue-400", action: "Account Connected" };
    case "cycle_start":
    case "cycle_end": return { label: "Cycle", dot: "bg-accent", text: "text-accent", action: "Scheduler" };
    default: return { label: "System", dot: "bg-dark-500", text: "text-dark-400", action: "System Event" };
  }
}

/* ────────────────────── Stat card ────────────────────── */

function StatCard({ icon: Icon, label, value, tint, sub, subTint }: {
  icon: any; label: string; value: number; tint: "accent" | "success" | "danger" | "warning" | "info";
  sub?: string; subTint?: "success" | "danger" | "warning" | "muted";
}) {
  const t: Record<string, { text: string; bg: string; ring: string }> = {
    accent: { text: "text-accent", bg: "bg-accent/10", ring: "ring-accent/20" },
    success: { text: "text-success", bg: "bg-success/10", ring: "ring-success/20" },
    danger: { text: "text-danger", bg: "bg-danger/10", ring: "ring-danger/20" },
    warning: { text: "text-warning", bg: "bg-warning/10", ring: "ring-warning/20" },
    info: { text: "text-blue-400", bg: "bg-blue-500/10", ring: "ring-blue-500/20" },
  };
  const c = t[tint];
  const subColor = subTint === "success" ? "text-success" : subTint === "danger" ? "text-danger" : subTint === "warning" ? "text-warning" : "text-dark-500";
  return (
    <div className="shrink-0 w-[132px] sm:w-auto rounded-xl sm:rounded-2xl border border-dark-700/50 bg-dark-900 p-2.5 sm:p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-dark-600">
      <div className="flex items-center gap-2 sm:justify-between">
        <span className={`flex items-center justify-center h-7 w-7 sm:h-8 sm:w-8 rounded-lg shrink-0 ring-1 sm:order-2 ${c.bg} ${c.ring}`}>
          <Icon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${c.text}`} />
        </span>
        <span className="text-[11px] sm:text-[13px] font-medium text-dark-400 truncate sm:order-1">{label}</span>
      </div>
      <p className="mt-1.5 sm:mt-2.5 text-xl sm:text-[28px] font-bold leading-none tracking-tight tabular-nums text-dark-100">{value.toLocaleString()}</p>
      {sub && <p className={`mt-1 sm:mt-2 text-[10px] sm:text-xs font-medium truncate ${subColor}`}>{sub}</p>}
    </div>
  );
}

/* ────────────────────── Table row (with inline expand) ────────────────────── */

function LogTableRow({ entry, accountIndex, expanded, onToggle, botName }: {
  entry: ParsedLog; accountIndex: number; expanded: boolean; onToggle: () => void; botName?: string;
}) {
  const s = statusMeta(entry.type);
  const groupPrimary = entry.groupName || entry.message || "System event";
  const groupSecondary = entry.groupId ? entry.groupId : entry.type === "flood" && entry.waitSeconds ? `wait ${entry.waitSeconds}s` : "";
  const timeShort = entry.timestamp ? toLocalTime(entry.timestamp).time : "—";
  const statusLabel = entry.type === "flood" && entry.waitSeconds ? `${entry.waitSeconds}s` : s.label;

  const isPost = entry.type === "success" || entry.type === "failure" || entry.type === "flood";
  const accLabel = accountIndex > 0 ? `Account ${accountIndex}` : entry.account || "—";
  const hasAccount = accountIndex > 0 || !!entry.account;
  const link = messageLink(entry);
  const response = entry.type === "success" ? "Message delivered successfully"
    : entry.type === "failure" ? (entry.error || "Send failed")
    : entry.type === "flood" ? `Rate limited — waiting ${entry.waitSeconds || "?"}s`
    : entry.message || "—";
  const session = entry.account ? `${entry.account}.session` : "—";

  return (
    <div className={`relative ${expanded ? "bg-accent/[0.05]" : ""}`}>
      {expanded && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
      {/* Row (denser: py-2.5) */}
      <div
        onClick={onToggle}
        className={`grid grid-cols-[1fr_auto] md:grid-cols-[96px_112px_1fr_120px_28px] items-center gap-2 md:gap-3 px-4 py-2.5 cursor-pointer transition-colors ${expanded ? "" : "hover:bg-white/[0.02]"}`}
      >
        <span className="hidden md:block text-[13px] font-mono text-dark-400 tabular-nums">{timeShort}</span>
        <span className="hidden md:flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${s.dot}`} />
          <span className={`text-[13px] font-medium ${s.text}`}>{statusLabel}</span>
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 md:hidden mb-0.5">
            <span className={`h-2 w-2 rounded-full ${s.dot}`} />
            <span className={`text-[11px] font-medium ${s.text}`}>{statusLabel}</span>
            <span className="text-[11px] font-mono text-dark-600 tabular-nums">{timeShort}</span>
          </div>
          <p className="text-sm font-semibold text-dark-100 truncate">{groupPrimary}</p>
          {groupSecondary && <p className="text-[11px] text-dark-600 font-mono truncate">{groupSecondary}</p>}
        </div>
        <span className="hidden md:block text-[13px] text-dark-400 truncate">{accountIndex > 0 ? `Account ${accountIndex}` : "—"}</span>
        <ChevronRight className={`h-4 w-4 shrink-0 justify-self-end transition-transform ${expanded ? "rotate-90 text-accent" : "text-dark-600"}`} />
      </div>

      {/* Inline detail tab */}
      {expanded && (
        <div className="px-4 pb-4 animate-scale-in">
          {isPost ? (
            /* ── Post event: group + message link ── */
            <div className="rounded-xl border border-dark-700/60 bg-dark-950 p-4 grid lg:grid-cols-2 gap-x-8 gap-y-4">
              <div className="grid gap-2.5">
                <Field label="Group / Channel" value={entry.groupName || "—"} />
                {entry.groupId && <Field label="Group ID" value={entry.groupId} copy={entry.groupId} mono />}
                <Field label="Account" value={accLabel} copy={entry.account} />
                {entry.account && <Field label="Session" value={session} mono />}
                <Field label="Sent" value={entry.timestamp ? toLocalTime(entry.timestamp).full : "—"} />
                <Field label="Status" value={statusLabel} valueClass={s.text} />
                <Field label="Response" value={response} valueClass={entry.type === "failure" ? "text-danger" : undefined} />
                {botName && <Field label="Bot" value={botName} />}
              </div>
              <div className="min-w-0 grid gap-3 content-start">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-1.5">Message Link</p>
                  {link ? (
                    <>
                      <a href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[13px] font-semibold text-accent hover:bg-accent/20 transition-colors break-all">
                        Open in Telegram <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <p className="mt-1.5 text-[11px] text-dark-600 font-mono break-all">{link}</p>
                    </>
                  ) : (
                    <p className="text-[13px] text-dark-500">Link not available for this post.</p>
                  )}
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-1.5">Raw Log</p>
                  <RawBlock text={entry.raw} />
                </div>
              </div>
            </div>
          ) : (
            /* ── Info / system event: no group, no link — just the event ── */
            <div className="rounded-xl border border-dark-700/60 bg-dark-950 p-4">
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 flex items-center justify-center h-8 w-8 rounded-lg shrink-0 ring-1 ${s.text} bg-white/[0.04] ring-white/10`}>
                  <Info className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-dark-500">Information</p>
                  <p className="text-sm font-semibold text-dark-100 mt-0.5">{entry.message || s.action}</p>
                  <div className="mt-3 grid sm:grid-cols-2 gap-x-8 gap-y-2.5">
                    <Field label="Event" value={s.action} />
                    {hasAccount && <Field label="Account" value={accLabel} copy={entry.account} />}
                    <Field label="Time" value={entry.timestamp ? toLocalTime(entry.timestamp).full : "—"} />
                    {botName && <Field label="Bot" value={botName} />}
                  </div>
                  <div className="mt-3">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-dark-500 mb-1.5">Raw Log</p>
                    <RawBlock text={entry.raw} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────── Group row (By Group, expandable) ────────────────────── */

function GroupRow({ group, accounts, acctIndexOf }: {
  group: {
    name: string; groupId?: string; groupLink?: string;
    byAccount: Record<string, { type: LogType; time?: string; wait?: string; link?: string }>;
    sent: Set<string>; flood: Set<string>; failed: Set<string>;
  };
  accounts: string[];
  acctIndexOf: (rawId: string) => number;
}) {
  const [open, setOpen] = useState(false);
  const rows = accounts
    .map((acct, i) => ({ acct, i: (acctIndexOf(acct) || i + 1) - 1, rec: group.byAccount[acct] }))
    .filter((r) => r.rec)
    .sort((a, b) => (entryMs({ timestamp: b.rec!.time } as ParsedLog) || 0) - (entryMs({ timestamp: a.rec!.time } as ParsedLog) || 0));

  return (
    <div className={`relative ${open ? "bg-accent/[0.05]" : ""}`}>
      {open && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
      <div onClick={() => setOpen((v) => !v)} className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${open ? "" : "hover:bg-white/[0.02]"}`}>
        <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-90 text-accent" : "text-dark-600"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-dark-100 truncate">{group.name}</p>
          <p className="text-[11px] text-dark-600 font-mono truncate">{group.groupId ? `ID ${group.groupId}` : "ID unknown"}</p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0 text-xs">
          <span className="text-success font-semibold">{group.sent.size} sent</span>
          {group.flood.size > 0 && <span className="text-warning font-semibold">{group.flood.size} waiting</span>}
          {group.failed.size > 0 && <span className="text-danger font-semibold">{group.failed.size} failed</span>}
        </div>
      </div>
      {open && (
        <div className="px-4 pb-4 pl-11 animate-scale-in">
          <div className="rounded-xl border border-dark-700/60 bg-dark-950 p-3">
            {group.groupId && (
              <div className="flex items-center gap-2 pb-2.5 mb-2.5 border-b border-dark-800">
                <span className="text-[10px] font-bold uppercase tracking-wider text-dark-600">Group ID</span>
                <span className="text-xs font-mono text-dark-300">{group.groupId}</span>
                {group.groupLink && (
                  <a href={group.groupLink} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline">
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
            <div className="grid gap-1.5">
              {rows.map(({ acct, i, rec }) => {
                const tone = rec!.type === "success" ? "text-success" : rec!.type === "flood" ? "text-warning" : "text-danger";
                const verb = rec!.type === "success" ? "posted" : rec!.type === "flood" ? `waiting ${rec!.wait ? rec!.wait + "s" : ""}`.trim() : "failed";
                return (
                  <div key={acct} className="flex items-center gap-2 text-xs">
                    <span className="rounded bg-dark-800 px-1.5 py-0.5 text-[10px] font-semibold text-dark-300 shrink-0">Acc {i + 1}</span>
                    <span className="font-mono text-dark-500 shrink-0">{acct}.session</span>
                    <span className={`font-semibold shrink-0 ${tone}`}>{verb}</span>
                    <span className="text-dark-500 ml-auto shrink-0">{rec!.time ? toLocalTime(rec!.time).full : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, sub, copy, link, mono, valueClass }: {
  label: string; value: string; sub?: string; copy?: string; link?: string; mono?: boolean; valueClass?: string;
}) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => { if (copy) navigator.clipboard.writeText(copy).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 items-start">
      <span className="text-[13px] text-dark-500 pt-px">{label}</span>
      <div className="min-w-0 flex items-center gap-2">
        <div className="min-w-0">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline break-words">
              {value}<ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
            </a>
          ) : (
            <span className={`text-[13px] font-medium break-words ${mono ? "font-mono" : ""} ${valueClass || "text-dark-200"}`}>{value}</span>
          )}
          {sub && <span className="block text-[11px] text-dark-600 font-mono truncate">{sub}</span>}
        </div>
        {copy && (
          <button onClick={doCopy} className="shrink-0 text-dark-600 hover:text-dark-300 transition-colors" aria-label="Copy">
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

function RawBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  return (
    <div className="relative rounded-xl bg-dark-950 border border-dark-800 p-3.5">
      <p className="font-mono text-[11px] leading-relaxed text-dark-400 break-all whitespace-pre-wrap pr-8">{text}</p>
      <button onClick={copy} className="absolute right-2.5 top-2.5 flex items-center justify-center h-6 w-6 rounded-md text-dark-500 hover:text-dark-200 hover:bg-dark-800 transition-colors" aria-label="Copy raw log">
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function EmptyState({ label, title }: { label: string; title?: string }) {
  return (
    <div className="py-16 px-6 text-center">
      <MessageSquare className="h-8 w-8 mx-auto opacity-25 mb-3" />
      {title && <p className="text-base font-bold text-dark-200 mb-1">{title}</p>}
      <p className="text-sm text-dark-500">{label}</p>
    </div>
  );
}
