"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { useAdbots, useAdbotLogs } from "@/lib/hooks/useAdbots";
import {
  RotateCw, CheckCircle2, XCircle, Search, SlidersHorizontal, List, Hash,
  ChevronDown, X, Copy, Timer, ChevronRight, Radio, Check, Download,
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   Admin Logs — premium, calm, "invisible UI" redesign.
   Reuses the existing per-bot log endpoint (/api/bots/{name}/logs) —
   no new backend surface. Design tokens scoped to .premium-logs so
   the rest of the admin app is untouched.
   ═══════════════════════════════════════════════════════════════════ */

type LogType = "success" | "failure" | "flood" | "system" | "noise";

type ParsedLog = {
  raw: string;
  type: LogType;
  timestamp?: string;
  account?: string;
  groupName?: string;
  groupId?: string;
  error?: string;
  waitSeconds?: string;
  message?: string;
};

const NOISE_PREFIXES = ["[PostingScheduler]", "[Scheduler]", "[ShardCheck]", "[VerificationReport]", "[Connect]", "[FloodWait]"];

function extractGroupName(s: string): string {
  const m = s.match(/group_name=(.+?)\s+group_id=/);
  if (!m) return "";
  let name = m[1];
  if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) name = name.slice(1, -1);
  return name;
}

function cleanError(err: string): string {
  if (!err) return "";
  if (err.includes("can't write in this chat") || err.includes("CHAT_WRITE_FORBIDDEN")) return "No write permission";
  if (err.includes("CHANNEL_PRIVATE")) return "Private/banned channel";
  if (err.includes("USER_BANNED_IN_CHANNEL")) return "Account banned in group";
  if (err.includes("SLOWMODE_WAIT")) {
    const s = err.match(/(\d+)/)?.[1];
    return s ? `Slowmode (${s}s)` : "Slowmode active";
  }
  if (err.length > 90) return err.slice(0, 87) + "...";
  return err;
}

function parseLine(line: string): ParsedLog {
  const trimmed = line.replace(/<[^>]+>/g, "").trim();
  if (!trimmed) return { raw: line, type: "noise" };
  for (const p of NOISE_PREFIXES) if (trimmed.startsWith(p)) return { raw: line, type: "noise" };

  const tsMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/);
  const body = tsMatch ? tsMatch[2] : trimmed;
  const timestamp = tsMatch?.[1];

  if (body.startsWith("[POST_SUCCESS]")) {
    const account = body.match(/account=(\S+)/)?.[1] || "";
    const groupId = body.match(/group_id=(\S+)/)?.[1] || "";
    return { raw: line, type: "success", timestamp, account, groupName: extractGroupName(body) || "Unknown group", groupId };
  }
  if (body.startsWith("[POST_FAILURE]")) {
    const account = body.match(/account=(\S+)/)?.[1] || "";
    const groupId = body.match(/group_id=(\S+)/)?.[1] || "";
    let err = body.match(/error=(.*)/)?.[1] || "";
    if ((err.startsWith("'") && err.endsWith("'")) || (err.startsWith('"') && err.endsWith('"'))) err = err.slice(1, -1);
    return { raw: line, type: "failure", timestamp, account, groupName: extractGroupName(body) || "Unknown group", groupId, error: cleanError(err) };
  }
  if (body.startsWith("[FLOOD_WAIT]") || body.startsWith("[POST_SKIPPED]")) {
    const account = body.match(/account=(\S+)/)?.[1] || "";
    const groupId = body.match(/group_id=(\S+)/)?.[1] || "";
    const wait = body.match(/wait=(\d+)s/)?.[1] || body.match(/floodwait_(\d+)s/)?.[1] || "";
    return { raw: line, type: "flood", timestamp, account, groupName: extractGroupName(body) || "Unknown group", groupId, waitSeconds: wait };
  }
  const failMatch = body.match(/^Account\s+(\d+)\s*-\s*Failed in\s+(.+?):\s*(.+)$/);
  if (failMatch) return { raw: line, type: "failure", timestamp, account: `Account ${failMatch[1]}`, groupName: failMatch[2], error: cleanError(failMatch[3]) };
  const successMatch = body.match(/^Account\s+(\d+)\s*-\s*(?:Posted in|Sent to|Success in)\s+(.+)$/);
  if (successMatch) return { raw: line, type: "success", timestamp, account: `Account ${successMatch[1]}`, groupName: successMatch[2] };
  const floodMatch = body.match(/^Account\s+(\d+)\s*-\s*FloodWait\s+(\d+)s?\s+in\s+(.+)$/);
  if (floodMatch) return { raw: line, type: "flood", timestamp, account: `Account ${floodMatch[1]}`, groupName: floodMatch[3], waitSeconds: floodMatch[2] };

  return { raw: line, type: "system", timestamp, message: body };
}

const RANGES = [
  { key: "1h", label: "Last hour", ms: 3600e3 },
  { key: "24h", label: "Last 24h", ms: 24 * 3600e3 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 3600e3 },
  { key: "all", label: "All time", ms: Infinity },
];

function entryMs(p: ParsedLog): number {
  if (!p.timestamp) return NaN;
  let n = p.timestamp.trim();
  if (!n.endsWith("Z") && !n.includes("+")) n = n.replace(" ", "T") + "Z";
  const t = new Date(n).getTime();
  return isNaN(t) ? NaN : t;
}

function relTime(ts?: string): string {
  if (!ts) return "";
  const t = entryMs({ timestamp: ts } as ParsedLog);
  if (isNaN(t)) return ts;
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fullTime(ts?: string): string {
  if (!ts) return "";
  let n = ts.trim();
  if (!n.endsWith("Z") && !n.includes("+")) n = n.replace(" ", "T") + "Z";
  const d = new Date(n);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

/* ─── Animated counter — counts up on mount/value change, spring-eased ─── */
function Counter({ value }: { value: number }) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = value;
    if (from === to) { setDisplay(to); return; }
    const duration = 420;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <span>{display}</span>;
}

export default function AdminLogsPage() {
  const { data: botsData } = useAdbots();
  const bots = botsData?.items || [];
  const [botName, setBotName] = useState<string>("");
  useEffect(() => { if (!botName && bots.length) setBotName(bots[0].name); }, [bots, botName]);
  const currentBot = bots.find((b) => b.name === botName);

  const { data, mutate, isValidating } = useAdbotLogs(botName, 3000);
  const lines: string[] = data?.lines || [];

  const [range, setRange] = useState("24h");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [status, setStatus] = useState<"all" | "success" | "failure" | "flood">("all");
  const [view, setView] = useState<"timeline" | "groups">("timeline");
  const [botPickerOpen, setBotPickerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [spinRefresh, setSpinRefresh] = useState(false);

  const parsed = useMemo(() => lines.map(parseLine).filter((p) => p.type !== "noise"), [lines]);

  const rangeMs = RANGES.find((r) => r.key === range)?.ms ?? Infinity;
  const nowRef = useMemo(() => {
    let mx = 0;
    for (const p of parsed) { const t = entryMs(p); if (!isNaN(t) && t > mx) mx = t; }
    return mx || Date.now();
  }, [parsed]);

  const inRange = useMemo(() => {
    if (rangeMs === Infinity) return parsed;
    const cutoff = nowRef - rangeMs;
    return parsed.filter((p) => { const t = entryMs(p); return !isNaN(t) && t >= cutoff; });
  }, [parsed, nowRef, rangeMs]);

  const stats = useMemo(() => {
    let success = 0, failure = 0, flood = 0;
    for (const p of inRange) {
      if (p.type === "success") success++;
      else if (p.type === "failure") failure++;
      else if (p.type === "flood") flood++;
    }
    return { success, failure, flood, total: success + failure + flood };
  }, [inRange]);

  const sparkline = useMemo(() => {
    const buckets = 20;
    const arr = Array.from({ length: buckets }, () => ({ ok: 0, bad: 0 }));
    if (rangeMs === Infinity || inRange.length === 0) return arr;
    const bucketMs = rangeMs / buckets;
    const start = nowRef - rangeMs;
    for (const p of inRange) {
      if (p.type !== "success" && p.type !== "failure" && p.type !== "flood") continue;
      const t = entryMs(p);
      if (isNaN(t)) continue;
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((t - start) / bucketMs)));
      if (p.type === "success") arr[idx].ok++; else arr[idx].bad++;
    }
    return arr;
  }, [inRange, rangeMs, nowRef]);

  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 100;
  const health = stats.total === 0 ? "quiet" : stats.failure + stats.flood === 0 ? "healthy" : (stats.failure + stats.flood) / stats.total > 0.15 ? "critical" : "attention";
  const healthCopy = {
    quiet: { label: "No activity yet", color: "var(--muted)" },
    healthy: { label: "All systems normal", color: "var(--green)" },
    attention: { label: "Needs attention", color: "var(--orange)" },
    critical: { label: `${stats.failure + stats.flood} issues need attention`, color: "var(--red)" },
  }[health];

  const filtered = useMemo(() => {
    let result = inRange;
    if (status !== "all") result = result.filter((p) => p.type === status);
    const q = search.trim().toLowerCase();
    if (q) result = result.filter((p) => [p.account, p.groupName, p.groupId, p.error, p.message, p.raw].filter(Boolean).join(" ").toLowerCase().includes(q));
    return [...result].reverse();
  }, [inRange, status, search]);

  const groups = useMemo(() => {
    const map: Record<string, { name: string; sent: number; failed: number; flood: number; last?: string }> = {};
    for (const p of inRange) {
      if (!p.groupName || (p.type !== "success" && p.type !== "failure" && p.type !== "flood")) continue;
      if (!map[p.groupName]) map[p.groupName] = { name: p.groupName, sent: 0, failed: 0, flood: 0 };
      const g = map[p.groupName];
      if (p.type === "success") g.sent++; else if (p.type === "flood") g.flood++; else g.failed++;
      g.last = p.timestamp;
    }
    let list = Object.values(map);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((g) => g.name.toLowerCase().includes(q));
    return list.sort((a, b) => (b.failed + b.flood) - (a.failed + a.flood) || a.name.localeCompare(b.name));
  }, [inRange, search]);

  const activeFilterCount = status !== "all" ? 1 : 0;

  // Keyboard shortcut: ⌘K / Ctrl+K focuses search (Spotlight-style)
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") setExpandedId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const refresh = () => {
    setSpinRefresh(true);
    mutate();
    setTimeout(() => setSpinRefresh(false), 600);
  };

  return (
    <div className="premium-logs">
      <div className="pl-page">
        {/* ── Header ── */}
        <header className="pl-header">
          <div className="pl-fade-up" style={{ animationDelay: "0ms" }}>
            <h1 className="pl-title">Logs</h1>
            <p className="pl-subtitle">Real-time delivery activity across your bots</p>
          </div>

          <div className="pl-header-actions pl-fade-up" style={{ animationDelay: "40ms" }}>
            {/* Bot picker */}
            <div className="pl-botpicker">
              <button className="pl-chip-btn" onClick={() => setBotPickerOpen((v) => !v)}>
                <span className="pl-avatar" aria-hidden>
                  {(currentBot?.bot_username || currentBot?.name || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="pl-chip-label">{currentBot?.bot_username || currentBot?.name || "Select bot"}</span>
                <span className={`pl-status-dot ${currentBot?.running ? "is-live" : "is-off"}`} />
                <ChevronDown size={14} strokeWidth={2} className="pl-chip-chevron" />
              </button>
              {botPickerOpen && (
                <div className="pl-popover pl-spring-in" onMouseLeave={() => setBotPickerOpen(false)}>
                  {bots.length === 0 && <div className="pl-popover-empty">No bots yet</div>}
                  {bots.map((b) => (
                    <button
                      key={b.name}
                      className={`pl-popover-item ${b.name === botName ? "is-active" : ""}`}
                      onClick={() => { setBotName(b.name); setBotPickerOpen(false); }}
                    >
                      <span className="pl-avatar pl-avatar-sm">{(b.bot_username || b.name).slice(0, 1).toUpperCase()}</span>
                      <span className="pl-popover-item-label">{b.bot_username || b.name}</span>
                      <span className={`pl-status-dot ${b.running ? "is-live" : "is-off"}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className={`pl-icon-btn ${spinRefresh || isValidating ? "is-spinning" : ""}`} onClick={refresh} aria-label="Refresh">
              <RotateCw size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* ── Metrics ── */}
        <section className="pl-metrics pl-fade-up" style={{ animationDelay: "80ms" }}>
          <div className="pl-metric-card pl-metric-hero">
            <div className="pl-metric-hero-top">
              <span className="pl-status-pulse" style={{ ["--dot" as any]: healthCopy.color }}>
                <span className="pl-pulse-ring" />
                <span className="pl-pulse-dot" />
              </span>
              <span className="pl-metric-hero-label" style={{ color: healthCopy.color }}>{healthCopy.label}</span>
            </div>
            <div className="pl-sparkline" aria-hidden>
              {sparkline.map((b, i) => {
                const total = b.ok + b.bad;
                const h = total === 0 ? 3 : Math.max(6, Math.min(40, total * 5));
                const bad = b.bad > 0;
                return <span key={i} className="pl-spark-bar" style={{ height: `${h}px`, background: bad ? "var(--red)" : total > 0 ? "var(--green)" : "rgba(255,255,255,.06)" }} />;
              })}
            </div>
            <p className="pl-metric-hero-sub">{RANGES.find((r) => r.key === range)?.label} · updates every 3s</p>
          </div>

          <MetricCard icon={<CheckCircle2 size={18} strokeWidth={2} />} tint="green" label="Sent" value={stats.success} sub={`${successRate}% success rate`} />
          <MetricCard icon={<XCircle size={18} strokeWidth={2} />} tint="red" label="Failed" value={stats.failure} sub="need review" />
          <MetricCard icon={<Timer size={18} strokeWidth={2} />} tint="orange" label="Flood wait" value={stats.flood} sub="rate limited" />
        </section>

        {/* ── Controls ── */}
        <section className="pl-controls pl-fade-up" style={{ animationDelay: "120ms" }}>
          <div className={`pl-search ${searchFocused ? "is-focused" : ""}`}>
            <Search size={16} strokeWidth={2} className="pl-search-icon" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search group, account, error…"
              className="pl-search-input"
            />
            {search ? (
              <button className="pl-search-clear" onClick={() => setSearch("")}><X size={14} /></button>
            ) : (
              <kbd className="pl-kbd">⌘K</kbd>
            )}
          </div>

          <div className="pl-range">
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)} className={`pl-capsule ${range === r.key ? "is-active" : ""}`}>
                {r.label}
              </button>
            ))}
          </div>

          <div className="pl-viewtoggle">
            <button onClick={() => setView("timeline")} className={`pl-toggle-btn ${view === "timeline" ? "is-active" : ""}`}><List size={14} /></button>
            <button onClick={() => setView("groups")} className={`pl-toggle-btn ${view === "groups" ? "is-active" : ""}`}><Hash size={14} /></button>
          </div>
        </section>

        {/* ── Filter capsules ── */}
        <section className="pl-filters pl-fade-up" style={{ animationDelay: "150ms" }}>
          {([
            { key: "all", label: "All" },
            { key: "success", label: "Sent" },
            { key: "failure", label: "Failed" },
            { key: "flood", label: "Flood wait" },
          ] as const).map((o) => (
            <button key={o.key} onClick={() => setStatus(o.key)} className={`pl-capsule pl-capsule-filter ${status === o.key ? "is-active" : ""}`}>
              {o.label}
            </button>
          ))}
          {activeFilterCount > 0 && (
            <button onClick={() => setStatus("all")} className="pl-clear-link">Clear</button>
          )}
        </section>

        {/* ── Timeline ── */}
        <section className="pl-timeline pl-fade-up" style={{ animationDelay: "190ms" }}>
          {view === "groups" ? (
            groups.length === 0 ? (
              <EmptyState label={search ? "No group matches your search" : "No group activity yet"} />
            ) : (
              <div>
                {groups.map((g, i) => (
                  <div key={g.name} className="pl-row pl-row-stagger" style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                    <div className="pl-row-icon" style={{ background: "color-mix(in srgb, var(--purple) 16%, transparent)" }}>
                      <Hash size={16} strokeWidth={2} color="var(--purple)" />
                    </div>
                    <div className="pl-row-main">
                      <p className="pl-row-title">{g.name}</p>
                      <p className="pl-row-subtitle">{relTime(g.last)}</p>
                    </div>
                    <div className="pl-row-meta">
                      <Badge tone="green">{g.sent} sent</Badge>
                      {g.flood > 0 && <Badge tone="orange">{g.flood} flood</Badge>}
                      {g.failed > 0 && <Badge tone="red">{g.failed} failed</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : filtered.length === 0 ? (
            <EmptyState label={lines.length === 0 ? "No logs yet — start the bot to see output" : "No matching logs"} />
          ) : (
            <div>
              {filtered.slice(0, 300).map((entry, i) => (
                <LogRow
                  key={i}
                  entry={entry}
                  index={i}
                  expanded={expandedId === i}
                  onToggle={() => setExpandedId(expandedId === i ? null : i)}
                  botName={botName}
                />
              ))}
            </div>
          )}
        </section>

        <p className="pl-footer-caption pl-fade-up" style={{ animationDelay: "220ms" }}>
          {view === "groups" ? `${groups.length} groups` : `Showing ${Math.min(filtered.length, 300)} of ${filtered.length}`} · {RANGES.find((r) => r.key === range)?.label} · {data?.total_lines || 0} total log lines
        </p>
      </div>

      {/* ═══ Scoped premium design system — tokens, layout, motion ═══ */}
      <style jsx global>{`
        .premium-logs {
          --bg: #0A0B10;
          --surface: #11131A;
          --card: #171A22;
          --elevated: #1B1E28;
          --hover: #222636;
          --pressed: #2A3042;
          --border: rgba(255, 255, 255, 0.05);
          --text: #F8F9FC;
          --secondary: #B4BAC7;
          --muted: #7E8798;
          --purple: #7C5CFF;
          --blue: #4A8CFF;
          --green: #33D17A;
          --orange: #FFB347;
          --red: #FF5D73;
          --ease: cubic-bezier(0.16, 1, 0.3, 1);
          --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
          color: var(--text);
        }

        .pl-page {
          max-width: 1180px;
          margin: 0 auto;
          padding: 8px 4px 64px;
          display: flex;
          flex-direction: column;
          gap: 32px;
        }

        @keyframes pl-fadeUp {
          from { opacity: 0; transform: translateY(10px) scale(0.995); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .pl-fade-up {
          animation: pl-fadeUp 420ms var(--ease) both;
        }

        /* ── Header ── */
        .pl-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          flex-wrap: wrap;
        }
        .pl-title {
          font-size: clamp(26px, 3vw, 34px);
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1.15;
          color: var(--text);
          margin: 0;
        }
        .pl-subtitle {
          font-size: 15px;
          font-weight: 400;
          color: var(--muted);
          margin: 6px 0 0;
          letter-spacing: -0.005em;
        }
        .pl-header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .pl-botpicker { position: relative; }
        .pl-chip-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px 8px 8px;
          border-radius: 999px;
          background: var(--card);
          border: 1px solid var(--border);
          box-shadow: 0 2px 6px rgba(0,0,0,.15);
          cursor: pointer;
          transition: background 200ms var(--ease), transform 180ms var(--ease-spring), box-shadow 200ms var(--ease);
        }
        .pl-chip-btn:hover { background: var(--hover); box-shadow: 0 4px 14px rgba(0,0,0,.2); }
        .pl-chip-btn:active { transform: scale(0.97); background: var(--pressed); }
        .pl-avatar {
          width: 26px; height: 26px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 650; color: white;
          background: linear-gradient(135deg, var(--purple), var(--blue));
          flex-shrink: 0;
        }
        .pl-avatar-sm { width: 22px; height: 22px; font-size: 10px; }
        .pl-chip-label { font-size: 13px; font-weight: 600; color: var(--text); }
        .pl-chip-chevron { color: var(--muted); }
        .pl-status-dot {
          width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        }
        .pl-status-dot.is-live { background: var(--green); box-shadow: 0 0 6px var(--green); }
        .pl-status-dot.is-off { background: var(--muted); }

        @keyframes pl-springIn {
          from { opacity: 0; transform: translateY(-6px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .pl-spring-in { animation: pl-springIn 200ms var(--ease-spring) both; }

        .pl-popover {
          position: absolute; top: calc(100% + 8px); right: 0; min-width: 220px;
          background: var(--elevated);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 6px;
          box-shadow: 0 8px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.03);
          backdrop-filter: blur(20px);
          z-index: 30;
        }
        .pl-popover-empty { padding: 12px; font-size: 13px; color: var(--muted); }
        .pl-popover-item {
          display: flex; align-items: center; gap: 10px; width: 100%;
          padding: 8px 10px; border-radius: 12px; background: transparent;
          transition: background 150ms var(--ease);
          cursor: pointer;
        }
        .pl-popover-item:hover { background: var(--hover); }
        .pl-popover-item.is-active { background: color-mix(in srgb, var(--purple) 14%, transparent); }
        .pl-popover-item-label { font-size: 13px; font-weight: 500; color: var(--text); flex: 1; text-align: left; }

        .pl-icon-btn {
          width: 38px; height: 38px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: var(--card); border: 1px solid var(--border);
          color: var(--secondary);
          box-shadow: 0 2px 6px rgba(0,0,0,.15);
          transition: background 200ms var(--ease), color 200ms var(--ease), transform 180ms var(--ease-spring);
        }
        .pl-icon-btn:hover { background: var(--hover); color: var(--text); }
        .pl-icon-btn:active { transform: scale(0.92); }
        .pl-icon-btn svg { transition: transform 500ms var(--ease); }
        .pl-icon-btn.is-spinning svg { transform: rotate(360deg); }

        /* ── Metrics ── */
        .pl-metrics {
          display: grid;
          grid-template-columns: 1.6fr repeat(3, 1fr);
          gap: 16px;
        }
        .pl-metric-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 20px;
          box-shadow: 0 2px 6px rgba(0,0,0,.15);
          transition: transform 220ms var(--ease-spring), box-shadow 220ms var(--ease), background 220ms var(--ease);
        }
        .pl-metric-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 30px rgba(0,0,0,.25);
          background: var(--elevated);
        }
        .pl-metric-hero { display: flex; flex-direction: column; justify-content: space-between; gap: 14px; }
        .pl-metric-hero-top { display: flex; align-items: center; gap: 10px; }
        .pl-metric-hero-label { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
        .pl-metric-hero-sub { font-size: 12px; color: var(--muted); margin: 0; }

        .pl-status-pulse { position: relative; width: 10px; height: 10px; display: inline-flex; flex-shrink: 0; }
        .pl-pulse-ring, .pl-pulse-dot { position: absolute; inset: 0; border-radius: 50%; background: var(--dot); }
        .pl-pulse-ring { animation: pl-breathe 2.4s ease-in-out infinite; opacity: 0.5; }
        .pl-pulse-dot { transform: scale(0.55); }
        @keyframes pl-breathe {
          0%, 100% { transform: scale(0.7); opacity: 0.55; }
          50% { transform: scale(1.6); opacity: 0; }
        }

        .pl-sparkline { display: flex; align-items: flex-end; gap: 3px; height: 40px; }
        .pl-spark-bar { flex: 1; border-radius: 3px; transition: height 400ms var(--ease); min-width: 2px; }

        .pl-metric-icon {
          width: 38px; height: 38px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 14px;
        }
        .pl-metric-label { font-size: 13px; font-weight: 500; color: var(--muted); margin: 0 0 4px; }
        .pl-metric-value { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; margin: 0; }
        .pl-metric-sub { font-size: 12px; color: var(--muted); margin: 6px 0 0; }

        /* ── Controls ── */
        .pl-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

        .pl-search {
          position: relative;
          flex: 1;
          min-width: 240px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-radius: 16px;
          background: color-mix(in srgb, var(--card) 88%, transparent);
          backdrop-filter: blur(16px);
          border: 1px solid var(--border);
          box-shadow: 0 2px 6px rgba(0,0,0,.15);
          transition: box-shadow 220ms var(--ease), border-color 220ms var(--ease), background 220ms var(--ease);
        }
        .pl-search.is-focused {
          border-color: color-mix(in srgb, var(--purple) 45%, transparent);
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--purple) 14%, transparent), 0 8px 30px rgba(0,0,0,.2);
          background: var(--elevated);
        }
        .pl-search-icon { color: var(--muted); flex-shrink: 0; }
        .pl-search-input {
          flex: 1; background: transparent; border: none; outline: none;
          font-size: 14px; color: var(--text); font-weight: 400;
        }
        .pl-search-input::placeholder { color: var(--muted); }
        .pl-search-clear { color: var(--muted); display: flex; transition: color 150ms var(--ease); }
        .pl-search-clear:hover { color: var(--text); }
        .pl-kbd {
          font-size: 11px; font-weight: 500; color: var(--muted);
          background: rgba(255,255,255,.06); border-radius: 6px;
          padding: 3px 6px; font-family: inherit; letter-spacing: 0.02em;
        }

        .pl-range { display: flex; align-items: center; gap: 6px; }
        .pl-viewtoggle {
          display: flex; align-items: center; gap: 2px;
          background: var(--card); border: 1px solid var(--border);
          border-radius: 12px; padding: 3px;
        }
        .pl-toggle-btn {
          width: 32px; height: 32px; border-radius: 9px;
          display: flex; align-items: center; justify-content: center;
          color: var(--muted); transition: all 200ms var(--ease-spring);
        }
        .pl-toggle-btn.is-active { background: var(--hover); color: var(--text); box-shadow: 0 2px 6px rgba(0,0,0,.15); }
        .pl-toggle-btn:hover:not(.is-active) { color: var(--secondary); }

        /* ── Capsules ── */
        .pl-capsule {
          padding: 8px 16px;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 500;
          color: var(--muted);
          background: transparent;
          border: 1px solid transparent;
          transition: all 200ms var(--ease-spring);
          white-space: nowrap;
        }
        .pl-capsule:hover { color: var(--secondary); background: color-mix(in srgb, white 4%, transparent); }
        .pl-capsule.is-active {
          color: white;
          background: linear-gradient(135deg, var(--purple), color-mix(in srgb, var(--purple) 70%, var(--blue)));
          box-shadow: 0 4px 16px color-mix(in srgb, var(--purple) 35%, transparent);
          transform: scale(1.03);
        }
        .pl-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pl-clear-link {
          font-size: 12px; color: var(--muted); padding: 6px 8px;
          transition: color 150ms var(--ease);
        }
        .pl-clear-link:hover { color: var(--text); }

        /* ── Timeline ── */
        .pl-timeline {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 22px;
          overflow: hidden;
          box-shadow: 0 2px 6px rgba(0,0,0,.15);
        }

        @keyframes pl-rowIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .pl-row-stagger { animation: pl-rowIn 320ms var(--ease) both; }

        .pl-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          transition: background 200ms var(--ease);
          cursor: pointer;
          position: relative;
        }
        .pl-row:last-child { border-bottom: none; }
        .pl-row:hover {
          background: var(--hover);
        }
        .pl-row-icon {
          width: 36px; height: 36px; border-radius: 12px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .pl-row-main { min-width: 0; flex: 1; }
        .pl-row-title {
          font-size: 15px; font-weight: 600; color: var(--text);
          margin: 0; letter-spacing: -0.01em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pl-row-subtitle {
          font-size: 13px; color: var(--muted); margin: 3px 0 0;
          transition: opacity 200ms var(--ease);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pl-row-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .pl-row-time {
          font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums;
          width: 64px; text-align: right; flex-shrink: 0;
        }
        .pl-row-chevron {
          color: var(--muted); flex-shrink: 0; transition: transform 220ms var(--ease-spring);
        }
        .pl-row.is-expanded .pl-row-chevron { transform: rotate(90deg); }

        /* ── Expanded panel ── */
        @keyframes pl-expandIn {
          from { opacity: 0; transform: translateY(-4px) scaleY(0.97); }
          to { opacity: 1; transform: translateY(0) scaleY(1); }
        }
        .pl-expand {
          animation: pl-expandIn 260ms var(--ease-spring) both;
          transform-origin: top;
          background: var(--elevated);
          border-top: 1px solid var(--border);
          padding: 18px 20px 20px 70px;
        }
        .pl-expand-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 14px 24px;
          margin-bottom: 16px;
        }
        .pl-expand-field-label {
          font-size: 12px; color: var(--muted); margin: 0 0 3px; font-weight: 500;
        }
        .pl-expand-field-value {
          font-size: 13px; color: var(--text); margin: 0; word-break: break-word;
        }
        .pl-code-block {
          position: relative;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 14px 16px;
        }
        .pl-code-text {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px; line-height: 1.7; color: var(--secondary);
          word-break: break-all; white-space: pre-wrap; margin: 0;
        }
        .pl-code-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; }
        .pl-code-btn {
          width: 28px; height: 28px; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          background: var(--card); color: var(--muted);
          border: 1px solid var(--border);
          transition: all 180ms var(--ease-spring);
        }
        .pl-code-btn:hover { color: var(--text); background: var(--hover); }
        .pl-code-btn:active { transform: scale(0.9); }
        .pl-code-btn.is-done { color: var(--green); }

        /* ── Badges ── */
        .pl-badge {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 10px 4px 8px;
          border-radius: 999px;
          font-size: 12px; font-weight: 600;
          white-space: nowrap;
        }
        .pl-badge-dot { width: 6px; height: 6px; border-radius: 50%; }

        /* ── Empty state ── */
        .pl-empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 80px 20px; color: var(--muted); gap: 12px;
        }
        .pl-empty p { font-size: 14px; margin: 0; }

        .pl-footer-caption { font-size: 12px; color: var(--muted); text-align: right; margin: -12px 4px 0; }

        /* ── Responsive ── */
        @media (max-width: 860px) {
          .pl-metrics { grid-template-columns: 1fr 1fr; }
          .pl-metric-hero { grid-column: 1 / -1; }
        }
        @media (max-width: 640px) {
          .pl-metrics { grid-template-columns: 1fr; }
          .pl-row { padding: 14px 16px; }
          .pl-row-subtitle { display: none; }
          .pl-expand { padding-left: 16px; }
          .pl-search { min-width: 0; }
          .pl-range { overflow-x: auto; }
        }

        @media (prefers-reduced-motion: reduce) {
          .premium-logs * {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>
    </div>
  );
}

function MetricCard({ icon, tint, label, value, sub }: { icon: React.ReactNode; tint: "green" | "red" | "orange" | "blue" | "purple"; label: string; value: number; sub: string }) {
  const colorVar = `var(--${tint})`;
  return (
    <div className="pl-metric-card">
      <div className="pl-metric-icon" style={{ background: `color-mix(in srgb, ${colorVar} 16%, transparent)`, color: colorVar }}>
        {icon}
      </div>
      <p className="pl-metric-label">{label}</p>
      <p className="pl-metric-value" style={{ color: "var(--text)" }}><Counter value={value} /></p>
      <p className="pl-metric-sub">{sub}</p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "green" | "red" | "orange" | "purple" | "blue"; children: React.ReactNode }) {
  const colorVar = `var(--${tone})`;
  return (
    <span className="pl-badge" style={{ background: `color-mix(in srgb, ${colorVar} 14%, transparent)`, color: colorVar }}>
      <span className="pl-badge-dot" style={{ background: colorVar, boxShadow: `0 0 6px ${colorVar}` }} />
      {children}
    </span>
  );
}

function StatusIcon({ type }: { type: LogType }) {
  const map: Record<string, { icon: React.ReactNode; tone: string }> = {
    success: { icon: <CheckCircle2 size={16} strokeWidth={2} />, tone: "green" },
    failure: { icon: <XCircle size={16} strokeWidth={2} />, tone: "red" },
    flood: { icon: <Timer size={16} strokeWidth={2} />, tone: "orange" },
    system: { icon: <Radio size={16} strokeWidth={2} />, tone: "purple" },
  };
  const cfg = map[type] || map.system;
  const colorVar = `var(--${cfg.tone})`;
  return (
    <div className="pl-row-icon" style={{ background: `color-mix(in srgb, ${colorVar} 16%, transparent)`, color: colorVar }}>
      {cfg.icon}
    </div>
  );
}

function LogRow({ entry, index, expanded, onToggle, botName }: { entry: ParsedLog; index: number; expanded: boolean; onToggle: () => void; botName: string }) {
  const [copied, setCopied] = useState(false);
  const isPost = entry.type === "success" || entry.type === "failure" || entry.type === "flood";
  const title = entry.groupName || entry.message || "Log entry";
  const subtitle = [entry.account, isPost && entry.error].filter(Boolean).join(" · ");

  const copyRaw = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(entry.raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const downloadJson = (e: React.MouseEvent) => {
    e.stopPropagation();
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `log-${index}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="pl-row-stagger" style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}>
      <div className={`pl-row ${expanded ? "is-expanded" : ""}`} onClick={onToggle}>
        <StatusIcon type={entry.type} />
        <div className="pl-row-main">
          <p className="pl-row-title">{title}</p>
          {subtitle && <p className="pl-row-subtitle">{subtitle}</p>}
        </div>
        <div className="pl-row-meta">
          {entry.type === "success" && <Badge tone="green">Sent</Badge>}
          {entry.type === "failure" && <Badge tone="red">Failed</Badge>}
          {entry.type === "flood" && <Badge tone="orange">{entry.waitSeconds}s wait</Badge>}
        </div>
        <span className="pl-row-time">{relTime(entry.timestamp)}</span>
        <ChevronRight size={15} strokeWidth={2} className="pl-row-chevron" />
      </div>

      {expanded && (
        <div className="pl-expand">
          <div className="pl-expand-grid">
            <div>
              <p className="pl-expand-field-label">Group</p>
              <p className="pl-expand-field-value">{entry.groupName || "—"}</p>
            </div>
            {entry.groupId && (
              <div>
                <p className="pl-expand-field-label">Group ID</p>
                <p className="pl-expand-field-value" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{entry.groupId}</p>
              </div>
            )}
            <div>
              <p className="pl-expand-field-label">Account</p>
              <p className="pl-expand-field-value" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{entry.account || "—"}</p>
            </div>
            <div>
              <p className="pl-expand-field-label">Bot</p>
              <p className="pl-expand-field-value">{botName}</p>
            </div>
            {entry.error && (
              <div>
                <p className="pl-expand-field-label">Error</p>
                <p className="pl-expand-field-value" style={{ color: "var(--red)" }}>{entry.error}</p>
              </div>
            )}
            {entry.waitSeconds && (
              <div>
                <p className="pl-expand-field-label">Wait</p>
                <p className="pl-expand-field-value" style={{ color: "var(--orange)" }}>{entry.waitSeconds} seconds</p>
              </div>
            )}
            <div>
              <p className="pl-expand-field-label">Time</p>
              <p className="pl-expand-field-value" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fullTime(entry.timestamp) || "—"}</p>
            </div>
          </div>

          <div className="pl-code-block">
            <p className="pl-code-text">{entry.raw}</p>
            <div className="pl-code-actions">
              <button className={`pl-code-btn ${copied ? "is-done" : ""}`} onClick={copyRaw} title="Copy raw log">
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
              <button className="pl-code-btn" onClick={downloadJson} title="Download JSON">
                <Download size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="pl-empty">
      <SlidersHorizontal size={22} strokeWidth={1.5} style={{ opacity: 0.4 }} />
      <p>{label}</p>
    </div>
  );
}
