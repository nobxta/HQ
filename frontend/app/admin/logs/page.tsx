"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { useAdbots, useAdbotLogs } from "@/lib/hooks/useAdbots";
import {
  RotateCw, CheckCircle2, XCircle, AlertTriangle, Clock, Search,
  SlidersHorizontal, List, Hash, ChevronDown, X, Copy, ExternalLink,
  Timer, Download, ChevronRight,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────
   Admin Logs — calm, hierarchy-first layout (see docs/logs-ui-spec.md §12)
   Reuses the existing per-bot log endpoint (/api/bots/{name}/logs) —
   no new backend surface required.
   ───────────────────────────────────────────────────────────── */

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

export default function AdminLogsPage() {
  const { data: botsData } = useAdbots();
  const bots = botsData?.items || [];
  const [botName, setBotName] = useState<string>("");
  useEffect(() => { if (!botName && bots.length) setBotName(bots[0].name); }, [bots, botName]);

  const { data, mutate } = useAdbotLogs(botName, 3000);
  const lines: string[] = data?.lines || [];

  const [range, setRange] = useState("24h");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "success" | "failure" | "flood">("all");
  const [view, setView] = useState<"timeline" | "groups">("timeline");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<ParsedLog | null>(null);
  const [drawerTab, setDrawerTab] = useState<"overview" | "raw">("overview");
  const [copied, setCopied] = useState(false);

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

  // Simple 12-bucket sparkline of success rate across the visible range.
  const sparkline = useMemo(() => {
    const buckets = 12;
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

  const health = stats.total === 0 ? "quiet" : stats.failure + stats.flood === 0 ? "healthy" : (stats.failure + stats.flood) / stats.total > 0.15 ? "critical" : "attention";
  const healthCopy = {
    quiet: { label: "No activity yet", color: "#64748B" },
    healthy: { label: "All systems normal", color: "#22C55E" },
    attention: { label: "Needs attention", color: "#F59E0B" },
    critical: { label: `${stats.failure + stats.flood} issues need attention`, color: "#EF4444" },
  }[health];

  const filtered = useMemo(() => {
    let result = inRange;
    if (status !== "all") result = result.filter((p) => p.type === status);
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((p) => [p.account, p.groupName, p.groupId, p.error, p.message, p.raw].filter(Boolean).join(" ").toLowerCase().includes(q));
    }
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

  const activeFilterCount = (status !== "all" ? 1 : 0);

  const copyRaw = () => {
    if (!selected) return;
    navigator.clipboard.writeText(selected.raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="space-y-4 animate-fade-in max-w-6xl">
      {/* Header row — title, bot switcher, refresh */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-hq-text">Logs</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              className="appearance-none rounded-[10px] border border-hq-border bg-hq-elev pl-3 pr-8 py-1.5 text-[12px] font-medium text-hq-text outline-none focus:border-hq-accent/60"
            >
              {bots.map((b) => <option key={b.name} value={b.name}>{b.bot_username || b.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-hq-muted" />
          </div>
          <button onClick={() => mutate()} className="flex items-center justify-center w-9 h-9 rounded-[10px] border border-hq-border bg-hq-elev text-hq-sub hover:text-hq-text hover:bg-white/[0.06] transition-colors duration-150">
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Status card — the single thing that answers "is everything healthy" in one glance */}
      <div
        className="rounded-[18px] p-4 sm:p-5"
        style={{ background: "linear-gradient(135deg,#171722 0%,#141420 100%)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {health === "healthy" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: healthCopy.color }} />}
              <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: healthCopy.color }} />
            </span>
            <div className="min-w-0">
              <p className="text-base sm:text-lg font-semibold truncate" style={{ color: healthCopy.color }}>{healthCopy.label}</p>
              <p className="text-[12px] text-hq-muted mt-0.5">
                {stats.total} posts · {stats.success} sent · {stats.failure} failed{stats.flood > 0 ? ` · ${stats.flood} flood` : ""} — {RANGES.find((r) => r.key === range)?.label.toLowerCase()}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Sparkline trend */}
            {rangeMs !== Infinity && (
              <div className="hidden sm:flex items-end gap-[3px] h-8">
                {sparkline.map((b, i) => {
                  const total = b.ok + b.bad || 1;
                  const h = Math.max(4, Math.min(32, (b.ok + b.bad) * 4));
                  const bad = b.bad > 0;
                  return (
                    <div key={i} className="w-1.5 rounded-full" style={{ height: `${h}px`, background: bad ? "#EF4444" : (b.ok > 0 ? "#22C55E" : "rgba(255,255,255,0.08)"), opacity: bad ? 0.8 : 0.6 }} title={`${b.ok} sent, ${b.bad} issues`} />
                  );
                })}
              </div>
            )}

            {/* Range dropdown */}
            <div className="relative">
              <select
                value={range}
                onChange={(e) => setRange(e.target.value)}
                className="appearance-none rounded-[10px] border border-hq-border bg-hq-bg pl-3 pr-7 py-1.5 text-[12px] font-medium text-hq-sub outline-none focus:border-hq-accent/60"
              >
                {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-hq-muted" />
            </div>
          </div>
        </div>
      </div>

      {/* Single control row: search + filters + view toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-hq-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search group, account, error…"
            className="w-full rounded-[10px] border border-hq-border bg-hq-elev pl-8 pr-8 py-2 text-[13px] text-hq-text placeholder:text-hq-muted outline-none focus:border-hq-accent/60"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-hq-muted hover:text-hq-text">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12px] font-medium transition-colors duration-150 ${
              activeFilterCount > 0 ? "border-hq-accent/40 bg-hq-accent/10 text-hq-accent" : "border-hq-border bg-hq-elev text-hq-sub hover:text-hq-text"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </button>
          {filtersOpen && (
            <div className="absolute right-0 mt-2 w-56 rounded-[14px] border border-hq-border bg-hq-elev p-3 shadow-[0_8px_32px_rgba(0,0,0,0.4)] z-20 animate-scale-in origin-top-right">
              <p className="text-[11px] font-medium text-hq-muted mb-2">Status</p>
              <div className="flex flex-col gap-1">
                {([
                  { key: "all", label: "All" },
                  { key: "success", label: "Sent" },
                  { key: "failure", label: "Failed" },
                  { key: "flood", label: "Flood wait" },
                ] as const).map((o) => (
                  <button
                    key={o.key}
                    onClick={() => { setStatus(o.key); }}
                    className={`text-left rounded-lg px-2.5 py-1.5 text-[12px] transition-colors duration-150 ${status === o.key ? "bg-hq-accent/15 text-hq-accent" : "text-hq-sub hover:bg-white/[0.04] hover:text-hq-text"}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center rounded-[10px] border border-hq-border bg-hq-elev overflow-hidden shrink-0">
          <button onClick={() => setView("timeline")} className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium transition-colors duration-150 ${view === "timeline" ? "bg-white/[0.06] text-hq-text" : "text-hq-muted hover:text-hq-sub"}`}>
            <List className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Timeline</span>
          </button>
          <button onClick={() => setView("groups")} className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium transition-colors duration-150 ${view === "groups" ? "bg-white/[0.06] text-hq-text" : "text-hq-muted hover:text-hq-sub"}`}>
            <Hash className="h-3.5 w-3.5" /> <span className="hidden sm:inline">By Group</span>
          </button>
        </div>
      </div>

      {/* Active filter chips — only rendered when something is actually set */}
      {activeFilterCount > 0 && (
        <div className="flex items-center gap-2 -mt-1 animate-fade-in">
          <button onClick={() => setStatus("all")} className="inline-flex items-center gap-1 rounded-full bg-hq-accent/10 text-hq-accent px-2.5 py-1 text-[11px] font-medium hover:bg-hq-accent/20 transition-colors duration-150">
            {status === "success" ? "Sent" : status === "failure" ? "Failed" : "Flood wait"}
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Table / list */}
      <div className="rounded-[18px] border border-hq-border bg-hq-bg2 overflow-hidden">
        {view === "groups" ? (
          groups.length === 0 ? (
            <EmptyState label={search ? "No group matches your search" : "No group activity yet"} />
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {groups.map((g) => (
                <div key={g.name} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-hq-text truncate">{g.name}</p>
                    <p className="text-[11px] text-hq-muted mt-0.5">{relTime(g.last)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-[11px]">
                    <span className="text-hq-success">{g.sent} sent</span>
                    {g.flood > 0 && <span className="text-hq-warning">{g.flood} flood</span>}
                    {g.failed > 0 && <span className="text-hq-danger">{g.failed} failed</span>}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : filtered.length === 0 ? (
          <EmptyState label={lines.length === 0 ? "No logs yet — start the bot to see output" : "No matching logs"} />
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {filtered.slice(0, 500).map((entry, i) => (
              <Row key={i} entry={entry} onOpen={() => { setSelected(entry); setDrawerTab("overview"); }} />
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-hq-muted text-right">
        {view === "groups" ? `${groups.length} groups` : `Showing ${Math.min(filtered.length, 500)} of ${filtered.length}`} · {RANGES.find((r) => r.key === range)?.label} · {data?.total_lines || 0} total log lines
      </p>

      {/* Details drawer */}
      {selected && (
        <>
          <div className="fixed inset-0 bg-black/50 z-30 animate-fade-in" onClick={() => setSelected(null)} />
          <div className="fixed inset-y-0 right-0 w-full sm:w-[420px] bg-hq-elev border-l border-hq-border z-40 flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-4 py-3 border-b border-hq-border">
              <div className="flex items-center gap-2">
                <StatusIcon type={selected.type} />
                <span className="text-[13px] font-semibold text-hq-text">
                  {selected.type === "success" ? "Sent" : selected.type === "failure" ? "Failed" : selected.type === "flood" ? "Flood wait" : "Log entry"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={copyRaw} className="flex items-center justify-center w-8 h-8 rounded-lg text-hq-muted hover:text-hq-text hover:bg-white/[0.06] transition-colors duration-150" title="Copy raw log">
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setSelected(null)} className="flex items-center justify-center w-8 h-8 rounded-lg text-hq-muted hover:text-hq-text hover:bg-white/[0.06] transition-colors duration-150">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex gap-1 px-4 pt-3">
              {(["overview", "raw"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setDrawerTab(t)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors duration-150 ${drawerTab === t ? "bg-white/[0.08] text-hq-text" : "text-hq-muted hover:text-hq-sub"}`}
                >
                  {t === "overview" ? "Overview" : "Raw"}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {drawerTab === "overview" ? (
                <div className="space-y-3">
                  <DetailRow label="Group" value={selected.groupName || "—"} />
                  {selected.groupId && <DetailRow label="Group ID" value={selected.groupId} mono />}
                  <DetailRow label="Account" value={selected.account || "—"} mono />
                  {selected.error && <DetailRow label="Error" value={selected.error} tone="danger" />}
                  {selected.waitSeconds && <DetailRow label="Wait" value={`${selected.waitSeconds} seconds`} tone="warning" />}
                  <DetailRow label="Time" value={fullTime(selected.timestamp) || "—"} mono />
                  <DetailRow label="Bot" value={botName} mono />
                </div>
              ) : (
                <div className="relative">
                  <p className="font-mono text-[11px] leading-relaxed text-hq-sub break-all whitespace-pre-wrap rounded-lg bg-hq-bg border border-hq-border p-3">{selected.raw}</p>
                  {copied && <span className="absolute top-2 right-2 text-[10px] text-hq-success bg-hq-success/10 px-2 py-0.5 rounded-full">Copied</span>}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <style jsx global>{`
        @keyframes slideInRight { from { transform: translateX(16px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .animate-slide-in-right { animation: slideInRight 200ms cubic-bezier(0.16,1,0.3,1); }
        @keyframes scaleInSm { from { transform: scale(0.97); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .animate-scale-in { animation: scaleInSm 150ms ease-out; }
      `}</style>
    </div>
  );
}

function StatusIcon({ type }: { type: LogType }) {
  if (type === "success") return <CheckCircle2 className="h-4 w-4 text-hq-success" />;
  if (type === "failure") return <XCircle className="h-4 w-4 text-hq-danger" />;
  if (type === "flood") return <Timer className="h-4 w-4 text-hq-warning" />;
  return <AlertTriangle className="h-4 w-4 text-hq-muted" />;
}

function Row({ entry, onOpen }: { entry: ParsedLog; onOpen: () => void }) {
  const isPost = entry.type === "success" || entry.type === "failure" || entry.type === "flood";
  const title = entry.groupName || entry.message || "Log entry";
  const meta = [entry.account, isPost && entry.error].filter(Boolean).join(" · ");

  return (
    <div
      onClick={onOpen}
      className="group flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-white/[0.03] transition-colors duration-150"
    >
      <StatusIcon type={entry.type} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-hq-text truncate">{title}</p>
        {meta && <p className="text-[11px] text-hq-muted truncate mt-0.5">{meta}</p>}
      </div>
      {entry.type === "flood" && (
        <span className="shrink-0 rounded-full bg-hq-warning/10 text-hq-warning px-2 py-0.5 text-[10px] font-medium">{entry.waitSeconds}s</span>
      )}
      <span className="shrink-0 text-[11px] text-hq-muted font-mono w-16 text-right" title={fullTime(entry.timestamp)}>
        {relTime(entry.timestamp)}
      </span>
      <ChevronRight className="h-3.5 w-3.5 text-hq-muted opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0" />
    </div>
  );
}

function DetailRow({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: "danger" | "warning" }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-[11px] text-hq-muted w-20 shrink-0 pt-0.5">{label}</span>
      <span className={`text-[12px] break-all ${mono ? "font-mono" : ""} ${tone === "danger" ? "text-hq-danger" : tone === "warning" ? "text-hq-warning" : "text-hq-text"}`}>{value}</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-hq-muted">
      <Clock className="h-6 w-6 mb-2 opacity-40" />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}
