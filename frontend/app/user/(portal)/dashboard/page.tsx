"use client";
import { usePortalBot, usePortalStats, usePortalLogs, usePortalAnalytics } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  CheckCircle, XCircle, Play, Square, Loader2,
  Send, ShieldAlert, Clock, CalendarClock,
  ChevronRight, AlertTriangle, Zap,
  AlertOctagon, ExternalLink, RefreshCw, Activity,
  Target, TrendingUp, ArrowUpRight,
  Users, Timer,
  MoreVertical, Power, ChevronDown, Gem, Shield,
} from "lucide-react";
import { formatDate, parseFlexibleDate } from "@/lib/utils";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/* ─────────────────────── types ─────────────────────── */

type ControlStep = { message: string; status: "progress" | "done" | "failed"; time: number };
type MiniLog = { type: "success" | "failure" | "flood"; group: string; error?: string; time?: string };

type PreStartSession = {
  session_file: string; real_name: string; status: string;
  severity: string; reason: string; diag_status: string | null;
  diag_ts: number | null; failure_rate: number;
  lifetime_sent: number; lifetime_failed: number;
};
type PreStartCheck = {
  ok: boolean; healthy: number; dead: number; total: number;
  sessions: PreStartSession[];
};

type FailingSession = {
  session_file: string; real_name: string; failure_rate: number;
  last_cycle_attempted: number; last_cycle_failed: number; last_cycle_success: number;
  lifetime_sent?: number; lifetime_failed?: number;
};
type ReplacementEntry = {
  id: string; session_file: string; real_name: string;
  failure_rate: number; status: string; free_replacement: boolean; price_usd: number;
};
type ReplacementData = {
  failing_sessions: FailingSession[]; pending: ReplacementEntry[];
  free_remaining: number; price_per_session: number; total_failing: number; total_pending: number;
};

/* ─────────────────────── log parser ─────────────────────── */

function parseMiniLog(line: string): MiniLog | null {
  const stripped = line.trim().replace(/<[^>]+>/g, "");
  if (!stripped) return null;
  let rest = stripped, time: string | undefined;
  const tsMatch = stripped.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/);
  if (tsMatch) {
    try {
      const d = new Date(tsMatch[1].replace(" ", "T") + "Z");
      if (!isNaN(d.getTime())) time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
    } catch {}
    rest = tsMatch[2];
  }
  if (rest.startsWith("[POST_SUCCESS]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || rest.match(/group_name=(\S+)/)?.[1] || "";
    return { type: "success", group: gn.replace(/^['"]|['"]$/g, ""), time };
  }
  if (rest.startsWith("[POST_FAILURE]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || rest.match(/group_name=(\S+)/)?.[1] || "";
    let err = rest.match(/error='?([^']+)/)?.[1] || "";
    if (err.includes("can't write")) err = "No permission";
    else if (err.includes("CHANNEL_PRIVATE")) err = "Private";
    else if (err.includes("BANNED")) err = "Banned";
    else if (err.includes("FloodWait")) { const s = err.match(/(\d+)/)?.[1]; err = s ? `Flood ${s}s` : "Flood"; }
    else if (err.length > 24) err = err.slice(0, 21) + "...";
    return { type: "failure", group: gn.replace(/^['"]|['"]$/g, ""), error: err, time };
  }
  if (rest.startsWith("[FLOOD_WAIT]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || "";
    const wait = rest.match(/wait=(\d+)s/)?.[1] || "";
    return { type: "flood", group: gn.replace(/^['"]|['"]$/g, ""), error: wait ? `${wait}s` : "", time };
  }
  return null;
}

const POPUP_SHOWN_KEY = "replacement_popup_shown";

/* ──────────────────── animated number ──────────────────── */

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<number>(0);

  useEffect(() => {
    const start = ref.current;
    const diff = value - start;
    if (diff === 0) return;
    const duration = 800;
    const startTime = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const current = Math.round(start + diff * ease(progress));
      setDisplay(current);
      if (progress < 1) requestAnimationFrame(tick);
      else ref.current = value;
    };
    requestAnimationFrame(tick);
  }, [value]);

  return <span className={className}>{display.toLocaleString()}</span>;
}

/* ──────────────────── circle progress ──────────────────── */

function CircleProgress({ value, size = 120, stroke = 8, color = "accent", delay = 0 }: {
  value: number; size?: number; stroke?: number; color?: string; delay?: number;
}) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAnimated(true), delay + 100); return () => clearTimeout(t); }, [delay]);

  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = animated ? circ - (value / 100) * circ : circ;
  const colorMap: Record<string, string> = {
    accent: "#6c5ce7", success: "#00cec9", warning: "#fdcb6e", danger: "#ff6b6b",
  };
  const glowMap: Record<string, string> = {
    accent: "rgba(108,92,231,0.3)", success: "rgba(0,206,201,0.3)", warning: "rgba(253,203,110,0.3)", danger: "rgba(255,107,107,0.3)",
  };
  return (
    <svg width={size} height={size} className="transform -rotate-90 drop-shadow-sm">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={colorMap[color] || colorMap.accent} strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
        style={{
          transition: `stroke-dashoffset 1.4s cubic-bezier(0.16, 1, 0.3, 1)`,
          filter: `drop-shadow(0 0 6px ${glowMap[color] || glowMap.accent})`,
        }} />
    </svg>
  );
}

/* ──────────────── Performance ranges + series builders ──────────────── */

type PerfRange = "1h" | "6h" | "24h" | "7d" | "30d";
type AnalyticsPoint = { ts: number; sent: number; failed: number };

const PERF_RANGES: { val: PerfRange; label: string }[] = [
  { val: "1h", label: "Last 1 hour" },
  { val: "6h", label: "Last 6 hours" },
  { val: "24h", label: "Last 24 hours" },
  { val: "7d", label: "Last 7 days" },
  { val: "30d", label: "Last 30 days" },
];

/** Format a bucket's start timestamp (unix seconds) as a local axis label, based on bucket size.
 *  Daily buckets are aligned to UTC midnight, so nudge to noon-UTC to pick the correct calendar day. */
function fmtBucketLabel(ts: number, bucketSeconds: number): string {
  if (bucketSeconds >= 86400) return new Date(ts * 1000 + 43200000).toLocaleDateString([], { weekday: "short" });
  if (bucketSeconds >= 3600) return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric" });
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* ═══════════════════════════ DASHBOARD ═══════════════════════════ */

export default function UserDashboard() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const { data: stats } = usePortalStats();
  const { data: logData } = usePortalLogs(50);
  const [perfPeriod, setPerfPeriod] = useState<PerfRange>("7d");
  const { data: analytics } = usePortalAnalytics(perfPeriod);
  const session = getPortalSession();
  const [actionLoading, setActionLoading] = useState("");
  const [controlSteps, setControlSteps] = useState<ControlStep[]>([]);
  const [controlAction, setControlAction] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const [replacements, setReplacements] = useState<ReplacementData | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const popupShown = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [preStartCheck, setPreStartCheck] = useState<PreStartCheck | null>(null);
  const [showPreStart, setShowPreStart] = useState(false);
  const [preStartLoading, setPreStartLoading] = useState(false);
  const [perfOpen, setPerfOpen] = useState(false);
  const router = useRouter();

  useEffect(() => { setMounted(true); }, []);

  const fetchReplacements = useCallback(() => {
    if (!session?.bot_name || !session?.telegram_id) return;
    portalApi.get(`/api/portal/bot/${session.bot_name}/replacements?telegram_id=${session.telegram_id}`)
      .then(r => {
        const d = r.data as ReplacementData;
        setReplacements(d);
        const hasIssues = d.total_failing > 0 || d.pending?.some(p => !["completed", "cancelled"].includes(p.status));
        if (hasIssues && !popupShown.current && !sessionStorage.getItem(POPUP_SHOWN_KEY)) {
          setShowPopup(true); sessionStorage.setItem(POPUP_SHOWN_KEY, "1"); popupShown.current = true;
        }
        if (!hasIssues) { setShowPopup(false); sessionStorage.removeItem(POPUP_SHOWN_KEY); popupShown.current = false; }
      }).catch(() => {});
  }, [session?.bot_name, session?.telegram_id]);

  useEffect(() => { fetchReplacements(); const iv = setInterval(fetchReplacements, 30000); return () => clearInterval(iv); }, [fetchReplacements]);
  useEffect(() => () => { wsRef.current?.close(); }, []);

  const miniLogs = useMemo(() => {
    const lines: string[] = logData?.lines || [];
    const out: MiniLog[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 12; i--) {
      const m = parseMiniLog(lines[i]);
      if (m) out.push(m);
    }
    return out;
  }, [logData]);

  /* ─── real Performance series from the log-derived analytics endpoint ─── */
  const perfPoints: AnalyticsPoint[] = analytics?.points || [];
  const bucketSeconds: number = analytics?.bucket_seconds || 3600;

  const perf = useMemo(() => {
    if (perfPeriod === "30d") {
      const cells = perfPoints.map(p => {
        const sent = p.sent || 0, failed = p.failed || 0;
        return { date: new Date(p.ts * 1000 + 43200000), sent, failed, value: sent + failed };
      });
      return { mode: "heatmap" as const, cells };
    }
    return {
      mode: "bars" as const,
      values: perfPoints.map(p => p.sent || 0),
      labels: perfPoints.map(p => fmtBucketLabel(p.ts, bucketSeconds)),
    };
  }, [perfPeriod, perfPoints, bucketSeconds]);

  /* exact sent/failed totals for the selected range (from the same log parse) */
  const rangeTotals = { sent: analytics?.range_sent || 0, failed: analytics?.range_failed || 0 };
  const perfTitle = PERF_RANGES.find(r => r.val === perfPeriod)?.label || "";

  /* ─── loading / error ─── */
  if (isLoading) return (
    <div className="animate-fade-in space-y-4 p-2">
      {/* Shimmer skeleton */}
      <div className="h-28 rounded-2xl shimmer-bg bg-dark-900/40" />
      <div className="grid grid-cols-4 gap-3">
        {[0,1,2,3].map(i => <div key={i} className="h-24 rounded-2xl shimmer-bg bg-dark-900/40" style={{ animationDelay: `${i * 0.15}s` }} />)}
      </div>
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-3 h-72 rounded-2xl shimmer-bg bg-dark-900/40" />
        <div className="col-span-5 h-72 rounded-2xl shimmer-bg bg-dark-900/40" style={{ animationDelay: "0.1s" }} />
        <div className="col-span-4 h-72 rounded-2xl shimmer-bg bg-dark-900/40" style={{ animationDelay: "0.2s" }} />
      </div>
    </div>
  );
  if (!bot) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-dark-400">
      <ShieldAlert className="h-12 w-12 mb-3 opacity-30" /><p className="text-lg font-medium">Bot not found</p>
    </div>
  );

  /* ─── WS ─── */
  const connectWs = (act: string): Promise<WebSocket> => new Promise((res, rej) => {
    wsRef.current?.close();
    const base = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
    const ws = new WebSocket(`${base}/ws/control/${encodeURIComponent(bot.name)}?token=${session?.access_token}`);
    wsRef.current = ws;
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("Connection failed"));
    ws.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.event === "bot_control") {
          setControlSteps(p => [...p, { message: m.message, status: m.status, time: Date.now() }]);
          if (m.status === "done" || m.status === "failed") {
            // Optimistically reflect the new state in the cache BEFORE clearing the loading flag, so the
            // button goes Starting→Stop (or Stopping→Start) directly instead of flashing back to its old
            // label in the gap before the next poll confirms it. revalidate to reconcile with the server.
            if (m.status === "done") {
              const next = act === "start" ? { state: "activating" } : { state: "stopped", running: false };
              mutate((prev: any) => (prev ? { ...prev, ...next } : prev), { revalidate: true });
            } else {
              mutate();
            }
            setActionLoading("");
            if (m.status === "done") setTimeout(() => { setControlSteps([]); setControlAction(""); }, 3000);
            setTimeout(() => { ws.close(); wsRef.current = null; }, 500);
          }
        }
      } catch {}
    };
    ws.onclose = () => { wsRef.current = null; };
  });

  const doAction = async (act: string, skipPreCheck = false) => {
    // Pre-start health check — only for "start" action
    if (act === "start" && !skipPreCheck) {
      setPreStartLoading(true);
      try {
        const { data } = await portalApi.get(
          `/api/portal/bot/${encodeURIComponent(bot.name)}/pre-start-check?telegram_id=${session?.telegram_id}`
        );
        const check = data as PreStartCheck;
        if (!check.ok) {
          // Found issues — show modal instead of starting
          setPreStartCheck(check);
          setShowPreStart(true);
          setPreStartLoading(false);
          return;
        }
        // All healthy — proceed with start
      } catch {
        // Pre-check failed — proceed anyway (don't block user)
      }
      setPreStartLoading(false);
    }

    setActionLoading(act); setControlAction(act); setControlSteps([]);
    try {
      await connectWs(act);
      await portalApi.post(`/api/portal/bot/${encodeURIComponent(bot.name)}/${act}?telegram_id=${session?.telegram_id}`, null, { timeout: 120000 });
    } catch (e: any) {
      setControlSteps(p => [...p, { message: e?.response?.data?.detail || e?.message || `Failed`, status: "failed", time: Date.now() }]);
      setActionLoading("");
    }
  };

  /* ─── derived ─── */
  const running = bot.running;
  // The backend sets state to "activating" the moment a start succeeds, then flips to "running" only
  // after the first post/cycle (which, with staggered accounts, can be minutes later). Treat activating
  // as ON so the button shows Starting/Stop and never snaps back to "Start Bot" mid-startup (which made
  // users think it failed and re-click).
  const activating = (bot as any).state === "activating";
  const active = running || activating;                 // bot is on (coming up or fully running)
  const starting = actionLoading === "start" || (activating && !running);
  const stopping = actionLoading === "stop";
  const controlBusy = !!actionLoading || preStartLoading;
  const controlLabel = preStartLoading ? "Checking…" : starting ? "Starting…" : stopping ? "Stopping…" : active ? "Stop Bot" : "Start Bot";
  const status = running ? "running" : activating ? "activating" : bot.frozen ? "frozen" : bot.suspended ? "suspended" : "stopped";
  const totalSent = stats?.lifetime_sent || 0;
  const totalFailed = stats?.lifetime_failed || 0;
  const total = totalSent + totalFailed;
  const successRate = total > 0 ? Math.round((totalSent / total) * 100) : 0;
  // "today" = last 24h, from the log-derived analytics (reliable) with stats as fallback.
  const todaySent = analytics?.summary?.h24?.sent ?? stats?.last24h_sent ?? 0;
  const todayFailed = analytics?.summary?.h24?.failed ?? stats?.last24h_failed ?? 0;
  const todayTotal = todaySent + todayFailed;

  const validTill = bot.valid_till ? parseFlexibleDate(bot.valid_till) : null;
  const daysLeft = validTill && !isNaN(validTill.getTime()) ? Math.ceil((validTill.getTime() - Date.now()) / 86400000) : null;
  const expiringSoon = daysLeft !== null && daysLeft <= 3 && daysLeft >= 0;
  const expired = daysLeft !== null && daysLeft < 0;

  const lastStep = controlSteps[controlSteps.length - 1];
  const controlDone = lastStep?.status === "done";
  const controlFailed = lastStep?.status === "failed";
  const controlInProgress = controlSteps.length > 0 && !controlDone && !controlFailed;

  const activePending = replacements?.pending?.filter(p => !["completed", "cancelled"].includes(p.status)) || [];
  const failingCount = (replacements?.total_failing || 0) + activePending.length;
  const failingFiles = new Set([
    ...(replacements?.failing_sessions?.map(f => f.session_file) || []),
    ...activePending.map(p => p.session_file),
  ]);

  const sessions: Array<any> = bot.sessions || [];
  const healthySessions = sessions.filter((s: any) => !failingFiles.has(typeof s === "string" ? s : s.file)).length;

  /* ─── shared: control progress toast (used by mobile + desktop) ─── */
  const controlToast = controlSteps.length > 0 ? (
    <div className={`rounded-2xl border p-3.5 mb-4 animate-slide-up backdrop-blur-sm ${
      controlDone ? "border-success/20 bg-success/[0.05]" : controlFailed ? "border-danger/20 bg-danger/[0.05]" : "border-accent/20 bg-accent/[0.05]"
    }`}>
      <div className="flex items-center gap-2.5">
        {controlInProgress && <Loader2 className="h-4 w-4 text-accent animate-spin" />}
        {controlDone && <CheckCircle className="h-4 w-4 text-success" />}
        {controlFailed && <XCircle className="h-4 w-4 text-danger" />}
        <span className={`text-sm font-semibold ${controlDone ? "text-success" : controlFailed ? "text-danger" : "text-accent"}`}>
          {lastStep?.message}
        </span>
        {(controlDone || controlFailed) && (
          <button onClick={() => { setControlSteps([]); setControlAction(""); }} className="ml-auto text-xs text-dark-500 hover:text-dark-300 transition-colors">Dismiss</button>
        )}
      </div>
    </div>
  ) : null;

  /* ─── shared: alert rows (used by mobile + desktop) ─── */
  const alertsBlock = (
    <>
      {failingCount > 0 && !showPopup && (
        <button onClick={() => setShowPopup(true)} className="w-full text-left mb-4 group animate-fade-in">
          <div className="flex items-center gap-2.5 rounded-2xl border border-danger/15 bg-danger/[0.04] hover:bg-danger/[0.08] px-4 py-3 transition-all duration-300">
            <div className="p-1.5 rounded-lg bg-danger/15"><AlertOctagon className="h-4 w-4 text-danger" /></div>
            <span className="text-xs font-semibold text-danger flex-1">{failingCount} session{failingCount !== 1 ? "s" : ""} failing &mdash; tap to replace</span>
            <ChevronRight className="h-4 w-4 text-danger/40 group-hover:text-danger/70 group-hover:translate-x-0.5 transition-all" />
          </div>
        </button>
      )}
      {(expired || expiringSoon) && (
        <div className={`flex items-center gap-2.5 rounded-2xl px-4 py-3 text-xs font-semibold mb-4 border animate-fade-in ${
          expired ? "bg-danger/[0.04] text-danger border-danger/15" : "bg-warning/[0.04] text-warning border-warning/15"
        }`}><AlertTriangle className="h-4 w-4 shrink-0" />{expired ? "Plan expired. Renew to continue." : `Expires in ${daysLeft}d. Renew soon.`}</div>
      )}
    </>
  );

  return (
    <div className={`h-full transition-opacity duration-500 ${mounted ? "opacity-100" : "opacity-0"}`}>

      {/* ═══════════ Replacement Popup ═══════════ */}
      <Modal open={showPopup} onClose={() => setShowPopup(false)} size="md">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-danger/10 border border-danger/20 shrink-0">
              <AlertOctagon className="h-6 w-6 text-danger" />
            </div>
            <div>
              <h2 className="text-base font-bold text-dark-100">Sessions Failing</h2>
              <p className="text-sm text-dark-400 mt-0.5">{failingCount} session{failingCount !== 1 ? "s" : ""} with 90%+ failure rate.</p>
            </div>
          </div>
          {replacements?.failing_sessions?.map(f => (
            <div key={f.session_file} className="flex items-center justify-between rounded-lg border border-danger/15 bg-danger/[0.03] px-3 py-2.5">
              <div className="min-w-0">
                <span className="text-sm font-medium text-dark-200 truncate block">{f.real_name?.replace(".session", "") || f.session_file.slice(-10)}</span>
                <span className="text-[10px] text-dark-500">{f.last_cycle_failed}/{f.last_cycle_attempted} failed last cycle</span>
              </div>
              <span className="text-sm font-bold text-danger shrink-0">{Math.round(f.failure_rate * 100)}%</span>
            </div>
          ))}
          <div className="flex items-start gap-2 rounded-lg bg-accent/5 border border-accent/20 p-3">
            <ExternalLink className="h-4 w-4 text-accent shrink-0 mt-0.5" />
            <p className="text-xs text-dark-300">Open your <b className="text-accent">Telegram bot</b> &rarr; repair menu to replace sessions.</p>
          </div>
          <div className="flex justify-between pt-1">
            <button onClick={fetchReplacements} className="text-xs text-dark-400 hover:text-dark-200 flex items-center gap-1"><RefreshCw className="h-3 w-3" /> Refresh</button>
            <button onClick={() => setShowPopup(false)} className="px-4 py-1.5 rounded-lg bg-dark-800 hover:bg-dark-700 text-sm font-medium text-dark-200">Got it</button>
          </div>
        </div>
      </Modal>

      {/* ═══════════ Pre-Start Health Check Modal ═══════════ */}
      <Modal open={showPreStart} onClose={() => setShowPreStart(false)} size="md">
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-warning/10 border border-warning/20 shrink-0">
              <ShieldAlert className="h-6 w-6 text-warning" />
            </div>
            <div>
              <h2 className="text-base font-bold text-dark-100">Session Issues Detected</h2>
              <p className="text-sm text-dark-400 mt-0.5">
                {preStartCheck?.dead || 0} of {preStartCheck?.total || 0} session{(preStartCheck?.total || 0) !== 1 ? "s" : ""} {(preStartCheck?.dead || 0) === 1 ? "is" : "are"} dead or banned.
                {(preStartCheck?.healthy || 0) > 0 && ` ${preStartCheck?.healthy} still healthy.`}
              </p>
            </div>
          </div>

          {/* Session list */}
          <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
            {preStartCheck?.sessions?.map((s) => {
              const isBad = s.status === "dead" || s.status === "failing";
              const isWarn = s.status === "warning" || s.status === "busy";
              const isUnknown = s.status === "unknown";
              return (
                <div key={s.session_file} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 border ${
                  isBad ? "border-danger/15 bg-danger/[0.04]" :
                  isWarn ? "border-warning/15 bg-warning/[0.04]" :
                  isUnknown ? "border-dark-700/30 bg-dark-800/20" :
                  "border-success/15 bg-success/[0.04]"
                }`}>
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isBad ? "bg-danger/15" : isWarn ? "bg-warning/15" : isUnknown ? "bg-dark-700/30" : "bg-success/15"
                  }`}>
                    {isBad ? <XCircle className="h-4 w-4 text-danger" /> :
                     isWarn ? <AlertTriangle className="h-4 w-4 text-warning" /> :
                     isUnknown ? <Clock className="h-4 w-4 text-dark-400" /> :
                     <CheckCircle className="h-4 w-4 text-success" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-semibold ${isBad ? "text-danger" : isWarn ? "text-warning" : "text-dark-200"}`}>
                      {s.real_name}
                    </p>
                    <p className="text-[10px] text-dark-500 truncate">{s.reason}</p>
                  </div>
                  <span className={`text-[10px] font-bold shrink-0 px-2 py-0.5 rounded-full ${
                    isBad ? "bg-danger/10 text-danger" :
                    isWarn ? "bg-warning/10 text-warning" :
                    isUnknown ? "bg-dark-700/30 text-dark-400" :
                    "bg-success/10 text-success"
                  }`}>
                    {s.status === "dead" ? "DEAD" : s.status === "failing" ? "FAILING" : s.status === "busy" ? "BUSY" : s.status === "warning" ? "LIMITED" : s.status === "unknown" ? "UNCHECKED" : "OK"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Info box */}
          {(preStartCheck?.healthy || 0) > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-accent/5 border border-accent/20 p-3">
              <Zap className="h-4 w-4 text-accent shrink-0 mt-0.5" />
              <p className="text-xs text-dark-300">
                You can still start with <b className="text-accent">{preStartCheck?.healthy}</b> healthy session{(preStartCheck?.healthy || 0) !== 1 ? "s" : ""}. Dead sessions will be skipped automatically.
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-2 pt-1">
            {/* Go to Accounts */}
            <button
              onClick={() => { setShowPreStart(false); router.push("/user/accounts"); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent/10 border border-accent/20 hover:bg-accent/20 text-accent text-sm font-semibold transition-all"
            >
              <ExternalLink className="h-4 w-4" />
              Go to Accounts — Replace Sessions
            </button>

            {/* Start with healthy sessions */}
            {(preStartCheck?.healthy || 0) > 0 && (
              <button
                onClick={() => { setShowPreStart(false); doAction("start", true); }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-success/10 border border-success/20 hover:bg-success/20 text-success text-sm font-semibold transition-all"
              >
                <Play className="h-4 w-4" />
                Start Anyway with {preStartCheck?.healthy} Session{(preStartCheck?.healthy || 0) !== 1 ? "s" : ""}
              </button>
            )}

            {/* Cancel */}
            <button
              onClick={() => setShowPreStart(false)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-dark-800/50 border border-dark-700/30 hover:bg-dark-700/50 text-dark-300 text-sm font-medium transition-all"
            >
              <Clock className="h-4 w-4" />
              Wait for Replacement
            </button>
          </div>
        </div>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ═══════════════════════  MOBILE VIEW  ════════════════════════ */}
      {/* ══════════════════════════════════════════════════════════════ */}
      <div className="lg:hidden">

        {/* ─────────── Hero card ─────────── */}
        <div className="relative mb-4 rounded-3xl overflow-hidden border border-white/[0.06] noise-bg animate-fade-in"
          style={{ background: "linear-gradient(160deg, rgba(34,30,64,0.85) 0%, rgba(17,17,28,0.96) 55%, rgba(20,18,40,0.9) 100%)" }}>
          <div className="absolute -top-6 left-6 w-28 h-28 rounded-full bg-accent/20 blur-[60px] pointer-events-none" />
          <div className="relative p-4">
            {/* top: avatar + name */}
            <div className="flex items-center gap-3.5">
              <div className="relative shrink-0">
                <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-700 flex items-center justify-center shadow-lg shadow-accent/30">
                  <span className="text-[26px] font-bold text-white leading-none drop-shadow-sm">{(bot.name || "A").charAt(0).toUpperCase()}</span>
                </div>
                <div className={`absolute -bottom-1 -right-1 h-[18px] w-[18px] rounded-full border-[3px] border-dark-950 ${active ? "bg-success" : "bg-dark-600"}`}>
                  {active && <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse" />}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-dark-400 text-[13px] font-normal leading-tight">Welcome back,</p>
                <h1 className="text-[24px] font-bold text-white tracking-tight leading-tight truncate">{bot.name}</h1>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold border ${
                    active ? "bg-success/10 text-success border-success/20" :
                    status === "frozen" || status === "suspended" ? "bg-warning/10 text-warning border-warning/20" :
                    "bg-dark-800/60 text-dark-300 border-white/[0.06]"
                  }`}>
                    {active
                      ? <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" /></span>
                      : <span className={`h-1.5 w-1.5 rounded-full ${status === "frozen" || status === "suspended" ? "bg-warning" : "bg-dark-500"}`} />}
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </span>
                  {bot.plan_name && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/20 px-2.5 py-1 text-[11px] font-semibold text-accent max-w-[150px]">
                      <Zap className="h-3 w-3 shrink-0" /><span className="truncate">{bot.plan_name}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* divider */}
            <div className="h-px bg-white/[0.07] my-3.5" />

            {/* plan / valid */}
            <div className="flex items-stretch gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-dark-500 text-[11px] font-medium mb-1">Plan</p>
                <div className="flex items-center gap-1.5">
                  <Gem className="h-4 w-4 text-accent shrink-0" />
                  <span className="text-white text-[14px] font-bold truncate">{bot.plan_name || "—"}</span>
                </div>
              </div>
              <div className="w-px bg-white/[0.08] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-dark-500 text-[11px] font-medium mb-1">Valid Until</p>
                <div className="flex items-center gap-1.5">
                  <CalendarClock className="h-4 w-4 text-dark-400 shrink-0" />
                  <span className={`text-[14px] font-bold truncate ${expired ? "text-danger" : expiringSoon ? "text-warning" : "text-white"}`}>
                    {validTill ? formatDate(bot.valid_till) : "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* start / stop button — full width */}
            <button onClick={() => doAction(active ? "stop" : "start")} disabled={controlBusy}
              className="mt-4 w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-white font-bold text-[15px] transition-all duration-300 disabled:opacity-60"
              style={active
                ? { background: "linear-gradient(135deg, #ff8080, #ff6b6b)", boxShadow: "0 6px 18px rgba(255,107,107,0.35)" }
                : { background: "linear-gradient(135deg, #8b6cff, #6c5ce7)", boxShadow: "0 6px 18px rgba(108,92,231,0.4)" }}>
              {controlBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : active ? <Square className="h-5 w-5 fill-white" /> : <Play className="h-5 w-5 fill-white" />}
              {controlLabel}
            </button>
          </div>
        </div>

        {controlToast}
        {alertsBlock}

        {/* ─────────── Stat cards (2×2) ─────────── */}
        <div className="grid grid-cols-2 gap-3 mb-4 stagger-children">
          <MobileStatCard icon={<Send className="h-5 w-5" />} accent="accent" label="Messages Sent"
            value={totalSent}
            footer={<span className="flex items-center gap-1 text-[12px] font-medium text-success"><ArrowUpRight className="h-3.5 w-3.5" />{todaySent > 0 ? `+${todaySent}` : "0"} today</span>} />
          <MobileStatCard icon={<XCircle className="h-5 w-5" />} accent="danger" label="Failed" highlight
            value={totalFailed}
            footer={<span className={`flex items-center gap-1 text-[12px] font-medium ${todayFailed > 0 ? "text-danger" : "text-dark-400"}`}><ArrowUpRight className="h-3.5 w-3.5" />{todayFailed > 0 ? `+${todayFailed}` : "0"} today</span>} />
          <MobileStatCard icon={<Users className="h-5 w-5" />} accent="accent" label="Accounts"
            value={sessions.length}
            footer={<span className="flex items-center gap-1.5 text-[12px] font-medium text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />{healthySessions} healthy</span>} />
          <MobileStatCard icon={<RefreshCw className="h-5 w-5" />} accent="accent" label="Cycles"
            value={stats?.total_cycles || 0}
            footer={<span className="flex items-center gap-1.5 text-[12px] font-medium text-dark-400"><Clock className="h-3.5 w-3.5" />{stats?.last_cycle_ts ? fmtAgo(stats.last_cycle_ts) : "no cycles"}</span>} />
        </div>

        {/* ─────────── Performance ─────────── */}
        <div className="rounded-3xl border border-white/[0.06] bg-[#101019] p-4 mb-4 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <TrendingUp className="h-[18px] w-[18px] text-accent shrink-0" />
              <span className="text-[15px] font-bold text-white truncate">Performance</span>
            </div>
            {/* working period dropdown */}
            <PerfRangeDropdown period={perfPeriod} open={perfOpen} setOpen={setPerfOpen} setPeriod={setPerfPeriod} title={perfTitle} />
          </div>

          {perf.mode === "heatmap" ? (
            <div className="flex items-center justify-center gap-4">
              <div className="relative shrink-0">
                <CircleProgress value={successRate} size={92} stroke={8}
                  color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[22px] font-bold text-white leading-none"><AnimatedNumber value={successRate} /><span className="text-sm text-dark-300">%</span></span>
                </div>
              </div>
              <ContribHeatmap cells={perf.cells} />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                <CircleProgress value={successRate} size={110} stroke={9}
                  color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[28px] font-bold text-white tracking-tighter leading-none">
                    <AnimatedNumber value={successRate} /><span className="text-base text-dark-300">%</span>
                  </span>
                  <span className="text-[9px] text-dark-500 font-semibold mt-0.5">Success Rate</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <PerfBars values={perf.values} labels={perf.labels} />
              </div>
            </div>
          )}

          <div className="space-y-2.5 mt-4">
            <PerfStatBar label="Sent" value={rangeTotals.sent} max={rangeTotals.sent + rangeTotals.failed || 1} color="bg-accent" />
            <PerfStatBar label="Failed" value={rangeTotals.failed} max={rangeTotals.sent + rangeTotals.failed || 1} color="bg-danger" />
          </div>
        </div>

        {/* ─────────── Bottom status strip ─────────── */}
        <div className="rounded-[22px] border border-white/[0.06] bg-[#101019] px-3 py-4 mb-2 grid grid-cols-4">
          <StatusCol icon={<Power className="h-4 w-4" />} iconColor="text-success" label="Bot Status"
            value={running ? "Running" : activating ? "Starting" : "Stopped"} sub={active ? "Tap to stop" : "Tap to start"} />
          <StatusCol icon={<Clock className="h-4 w-4" />} iconColor="text-info" label="Last Activity" divider
            value={stats?.last_cycle_ts ? fmtAgo(stats.last_cycle_ts) : "—"}
            sub={stats?.last_cycle_ts ? new Date(stats.last_cycle_ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "no activity"} />
          <StatusCol icon={<Gem className="h-4 w-4" />} iconColor="text-accent" label="Plan" divider
            value={bot.plan_name || "—"} sub={expired ? "Expired" : "Active"} />
          <StatusCol icon={<Shield className="h-4 w-4" />} iconColor="text-info" label="Uptime" divider
            value={`${successRate}%`} sub={failingCount > 0 ? `${failingCount} failing` : "No interruptions"} />
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* ═══════════════════════  DESKTOP VIEW  ═══════════════════════ */}
      {/* ══════════════════════════════════════════════════════════════ */}
      <div className="hidden lg:block">

      {/* ═══════════ HERO WELCOME BANNER ═══════════ */}
      <div className="relative mb-5 rounded-[20px] overflow-hidden animate-fade-in noise-bg"
        style={{
          background: "linear-gradient(135deg, rgba(108,92,231,0.12) 0%, rgba(15,15,26,0.95) 40%, rgba(0,206,201,0.06) 100%)",
        }}>
        {/* Ambient glow orbs */}
        <div className="absolute top-0 left-10 w-32 h-32 rounded-full bg-accent/20 blur-[60px] pointer-events-none" />
        <div className="absolute bottom-0 right-20 w-24 h-24 rounded-full bg-success/15 blur-[50px] pointer-events-none" />

        <div className="relative flex items-center justify-between px-6 py-5">
          <div className="flex items-center gap-5">
            {/* Bot avatar — Crextio profile card style */}
            <div className="relative group">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-700 flex items-center justify-center shadow-xl shadow-accent/25 group-hover:shadow-accent/40 transition-shadow duration-500">
                <span className="text-2xl font-bold text-white drop-shadow-sm">{(bot.name || "A").charAt(0).toUpperCase()}</span>
              </div>
              {/* Status dot */}
              <div className={`absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-[2.5px] border-dark-950 flex items-center justify-center ${
                active ? "bg-success" : "bg-dark-600"
              }`}>
                {active && <span className="h-2 w-2 rounded-full bg-white/80 animate-pulse" />}
              </div>
            </div>

            <div>
              <p className="text-dark-500 text-[11px] font-medium tracking-widest uppercase mb-0.5">Welcome back</p>
              <h1 className="text-[26px] font-bold text-white tracking-tight leading-tight">{bot.name}</h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {/* Status pill */}
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold backdrop-blur-sm border ${
                  active ? "bg-success/10 text-success border-success/20" :
                  status === "frozen" || status === "suspended" ? "bg-warning/10 text-warning border-warning/20" :
                  "bg-dark-800/50 text-dark-400 border-dark-700/30"
                }`}>
                  {active && <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" /></span>}
                  {!active && <span className={`h-1.5 w-1.5 rounded-full ${status === "frozen" || status === "suspended" ? "bg-warning" : "bg-dark-500"}`} />}
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                {/* Plan pill */}
                {bot.plan_name && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/15 px-3 py-1 text-[11px] font-semibold text-accent">
                    <Zap className="h-3 w-3" />{bot.plan_name}
                  </span>
                )}
                {/* Expiry pill — "Valid until · date" */}
                {validTill && (
                  <span className={`inline-flex items-center rounded-full border overflow-hidden text-[11px] font-medium ${
                    expired ? "border-danger/15 text-danger" : expiringSoon ? "border-warning/15 text-warning" : "border-dark-700/30 text-dark-400"
                  }`}>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-dark-800/40"><CalendarClock className="h-3 w-3" />Valid until</span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-dark-800/20 border-l border-white/[0.05]"><Clock className="h-3 w-3" />{expired ? "Expired" : expiringSoon ? `${daysLeft}d left` : formatDate(bot.valid_till)}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Start / Stop button — filled gradient */}
          <button onClick={() => doAction(active ? "stop" : "start")} disabled={controlBusy}
            className="shrink-0 flex items-center gap-2.5 rounded-2xl px-8 py-4 text-[15px] font-bold text-white transition-all duration-300 disabled:opacity-60 hover:brightness-110"
            style={active
              ? { background: "linear-gradient(135deg, #ff8080, #ff6b6b)", boxShadow: "0 8px 24px rgba(255,107,107,0.35)" }
              : { background: "linear-gradient(135deg, #8b6cff, #6c5ce7)", boxShadow: "0 8px 24px rgba(108,92,231,0.4)" }}>
            {controlBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : active ? <Square className="h-5 w-5 fill-white" /> : <Play className="h-5 w-5 fill-white" />}
            {controlLabel}
          </button>
        </div>
      </div>

      {/* Control progress toast */}
      {controlSteps.length > 0 && (
        <div className={`rounded-2xl border p-3.5 mb-4 animate-slide-up backdrop-blur-sm ${
          controlDone ? "border-success/20 bg-success/[0.05]" : controlFailed ? "border-danger/20 bg-danger/[0.05]" : "border-accent/20 bg-accent/[0.05]"
        }`}>
          <div className="flex items-center gap-2.5">
            {controlInProgress && <Loader2 className="h-4 w-4 text-accent animate-spin" />}
            {controlDone && <CheckCircle className="h-4 w-4 text-success" />}
            {controlFailed && <XCircle className="h-4 w-4 text-danger" />}
            <span className={`text-sm font-semibold ${controlDone ? "text-success" : controlFailed ? "text-danger" : "text-accent"}`}>
              {lastStep?.message}
            </span>
            {(controlDone || controlFailed) && (
              <button onClick={() => { setControlSteps([]); setControlAction(""); }} className="ml-auto text-xs text-dark-500 hover:text-dark-300 transition-colors">Dismiss</button>
            )}
          </div>
        </div>
      )}

      {/* Alerts row */}
      {failingCount > 0 && !showPopup && (
        <button onClick={() => setShowPopup(true)} className="w-full text-left mb-4 group animate-fade-in">
          <div className="flex items-center gap-2.5 rounded-2xl border border-danger/15 bg-danger/[0.04] hover:bg-danger/[0.08] px-4 py-3 transition-all duration-300">
            <div className="p-1.5 rounded-lg bg-danger/15"><AlertOctagon className="h-4 w-4 text-danger" /></div>
            <span className="text-xs font-semibold text-danger flex-1">{failingCount} session{failingCount !== 1 ? "s" : ""} failing &mdash; tap to replace</span>
            <ChevronRight className="h-4 w-4 text-danger/40 group-hover:text-danger/70 group-hover:translate-x-0.5 transition-all" />
          </div>
        </button>
      )}
      {(expired || expiringSoon) && (
        <div className={`flex items-center gap-2.5 rounded-2xl px-4 py-3 text-xs font-semibold mb-4 border animate-fade-in ${
          expired ? "bg-danger/[0.04] text-danger border-danger/15" : "bg-warning/[0.04] text-warning border-warning/15"
        }`}><AlertTriangle className="h-4 w-4 shrink-0" />{expired ? "Plan expired. Renew to continue." : `Expires in ${daysLeft}d. Renew soon.`}</div>
      )}

      {/* ═══════════ STAT CARDS ROW ═══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4 stagger-children">
        <GlassStatCard icon={<Send className="h-[18px] w-[18px]" />} accent="accent" label="Messages Sent" value={totalSent}
          footer={<span className="flex items-center gap-1 text-[13px] font-medium text-success"><ArrowUpRight className="h-4 w-4" />{todaySent > 0 ? `+${todaySent}` : "0"} today</span>} />
        <GlassStatCard icon={<XCircle className="h-[18px] w-[18px]" />} accent="danger" label="Failed" value={totalFailed} highlight
          footer={<span className={`flex items-center gap-1 text-[13px] font-medium ${todayFailed > 0 ? "text-danger" : "text-dark-400"}`}><ArrowUpRight className="h-4 w-4" />{todayFailed > 0 ? `+${todayFailed}` : "0"} today</span>} />
        <GlassStatCard icon={<Users className="h-[18px] w-[18px]" />} accent="accent" label="Accounts" value={sessions.length}
          footer={<div className="flex items-center gap-3 text-[13px] font-medium">
            <span className="flex items-center gap-1.5 text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />{healthySessions} healthy</span>
            {failingCount > 0 && <span className="flex items-center gap-1.5 text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" />{failingCount} issue{failingCount !== 1 ? "s" : ""}</span>}
          </div>} />
        <GlassStatCard icon={<RefreshCw className="h-[18px] w-[18px]" />} accent="accent" label="Cycles" value={stats?.total_cycles || 0}
          footer={<span className="flex items-center gap-1.5 text-[13px] font-medium text-dark-400"><Clock className="h-4 w-4" />{stats?.last_cycle_ts ? fmtAgo(stats.last_cycle_ts) : "no cycles yet"}</span>} />
      </div>

      {/* ═══════════ MAIN GRID — 3 panel Crextio layout ═══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4" style={{ height: "calc(100vh - 400px)", minHeight: "340px" }}>

        {/* ────── LEFT: Performance ────── */}
        <div className="lg:col-span-4 glass-card p-5 flex flex-col animate-stagger-1">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-accent" />
              <span className="text-[15px] font-bold text-white">Performance</span>
            </div>
            {/* working range dropdown */}
            <PerfRangeDropdown period={perfPeriod} open={perfOpen} setOpen={setPerfOpen} setPeriod={setPerfPeriod} title={perfTitle} wide />
          </div>

          {perf.mode === "heatmap" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 py-2">
              <div className="relative shrink-0">
                <CircleProgress value={successRate} size={120} stroke={9}
                  color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[28px] font-bold text-white tracking-tighter leading-none"><AnimatedNumber value={successRate} /><span className="text-base text-dark-300">%</span></span>
                  <span className="text-[10px] text-dark-500 font-semibold mt-1">Success Rate</span>
                </div>
              </div>
              <ContribHeatmap cells={perf.cells} big />
            </div>
          ) : (
            <div className="flex-1 flex items-center gap-4 py-2">
              <div className="relative shrink-0">
                <CircleProgress value={successRate} size={140} stroke={10}
                  color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[34px] font-bold text-white tracking-tighter leading-none">
                    <AnimatedNumber value={successRate} /><span className="text-lg text-dark-300">%</span>
                  </span>
                  <span className="text-[10px] text-dark-500 font-semibold mt-1">Success Rate</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <PerfBars values={perf.values} labels={perf.labels} height={150} />
              </div>
            </div>
          )}

          {/* Sent / Failed strips */}
          <div className="space-y-3 mt-3 pt-4 border-t border-white/[0.04]">
            <PerfStatBar label="Sent" value={rangeTotals.sent} max={rangeTotals.sent + rangeTotals.failed || 1} color="bg-accent" />
            <PerfStatBar label="Failed" value={rangeTotals.failed} max={rangeTotals.sent + rangeTotals.failed || 1} color="bg-danger" />
          </div>
        </div>

        {/* ────── CENTER: Accounts ────── */}
        <div className="lg:col-span-4 glass-card flex flex-col overflow-hidden animate-stagger-2">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.04]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-xl bg-accent/10"><Target className="h-4 w-4 text-accent" /></div>
              <span className="text-sm font-bold text-dark-100">Accounts</span>
              <span className="text-[10px] text-dark-400 bg-dark-800/50 rounded-full px-2.5 py-0.5 font-semibold">{sessions.length}</span>
              {failingCount > 0 && (
                <span className="text-[10px] text-danger bg-danger/10 border border-danger/15 rounded-full px-2.5 py-0.5 font-semibold flex items-center gap-1">
                  <span className="h-1 w-1 rounded-full bg-danger animate-pulse" />{failingCount} failing
                </span>
              )}
            </div>
            <Link href="/user/accounts" className="text-[10px] text-accent hover:text-accent-300 flex items-center gap-0.5 font-semibold group">
              Manage <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          <div className="flex-1 overflow-y-auto smooth-scroll">
            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-8">
                <div className="p-4 rounded-2xl bg-dark-800/20 mb-3"><Users className="h-8 w-8 text-dark-600" /></div>
                <p className="text-xs text-dark-500 font-medium">No accounts connected</p>
              </div>
            ) : (
              <div className="stagger-children">
                {sessions.map((sess: any, idx: number) => {
                  const key = typeof sess === "string" ? sess : (sess.file || "");
                  const s: any = stats?.session_stats?.[key] || null;
                  const sent = s?.lifetime_sent || 0;
                  const failed = s?.lifetime_failed || 0;
                  const t = sent + failed;
                  const pct = t > 0 ? Math.round((sent / t) * 100) : 0;
                  const failing = failingFiles.has(key);
                  const name = (sess.real_name || key).replace(".session", "");
                  const lastSent = s?.last_cycle_success || 0;
                  const lastAttempted = s?.last_cycle_attempted || 0;

                  const avatarColors = [
                    "from-accent-400 to-accent-700",
                    "from-success to-emerald-700",
                    "from-warning to-amber-700",
                    "from-info to-blue-700",
                    "from-pink-400 to-rose-700",
                  ];

                  return (
                    <div key={key} className={`flex items-center gap-3.5 px-5 py-3 border-b border-white/[0.03] transition-all duration-200 ${
                      failing ? "bg-danger/[0.03] hover:bg-danger/[0.06]" : "hover:bg-white/[0.02]"
                    }`}>
                      {/* Avatar — Crextio-style colored circle */}
                      <div className={`flex items-center justify-center h-10 w-10 rounded-2xl text-xs font-bold shrink-0 shadow-lg ${
                        failing
                          ? "bg-gradient-to-br from-danger to-red-800 text-white shadow-danger/20"
                          : `bg-gradient-to-br ${avatarColors[idx % avatarColors.length]} text-white shadow-accent/15`
                      }`}>
                        {name.charAt(0).toUpperCase()}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-dark-50 truncate">{name}</span>
                          <span className={`text-[11px] font-semibold shrink-0 ${failing ? "text-danger" : "text-success"}`}>
                            {failing ? "Issue" : "Healthy"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 mt-0.5">
                          {lastAttempted > 0 && <span className="text-[10px] text-dark-500 font-medium">Last: {lastSent}/{lastAttempted}</span>}
                          <span className="h-0.5 w-0.5 rounded-full bg-dark-600" />
                          <span className="text-[10px] text-dark-600">{sent.toLocaleString()} sent</span>
                        </div>
                      </div>

                      {/* Mini ring */}
                      <div className="shrink-0 hidden sm:block">
                        <div className="relative">
                          <CircleProgress
                            value={t > 0 ? pct : 0} size={38} stroke={3}
                            color={failing ? "danger" : pct >= 70 ? "success" : pct >= 40 ? "warning" : "danger"}
                          />
                          <span className={`absolute inset-0 flex items-center justify-center text-[9px] font-bold ${
                            failing ? "text-danger" : pct >= 70 ? "text-success" : pct >= 40 ? "text-warning" : "text-danger"
                          }`}>{t > 0 ? `${pct}%` : "—"}</span>
                        </div>
                      </div>
                      <span className={`sm:hidden text-xs font-bold ${
                        failing ? "text-danger" : pct >= 70 ? "text-success" : pct >= 40 ? "text-warning" : "text-danger"
                      }`}>{t > 0 ? `${pct}%` : "—"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer link */}
          {sessions.length > 0 && (
            <div className="px-5 py-3 border-t border-white/[0.04]">
              <Link href="/user/accounts" className="flex items-center justify-center gap-1.5 text-xs text-accent hover:text-accent-300 font-semibold transition-colors group">
                View all {sessions.length} account{sessions.length !== 1 ? "s" : ""} <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>
          )}
        </div>

        {/* ────── RIGHT: Live Activity (like Crextio Onboarding Task dark card) ────── */}
        <div className="lg:col-span-4 rounded-[20px] overflow-hidden flex flex-col animate-stagger-3"
          style={{
            background: "linear-gradient(165deg, rgba(20,20,35,0.95) 0%, rgba(12,12,22,0.98) 100%)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.04]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-xl bg-accent/15"><Activity className="h-4 w-4 text-accent" /></div>
              <span className="text-sm font-bold text-white">Live Activity</span>
              {running && (
                <span className="flex items-center gap-1.5 text-[10px] text-success bg-success/10 border border-success/15 rounded-full px-2.5 py-0.5 font-semibold">
                  <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" /></span>
                  Live
                </span>
              )}
            </div>
            {/* Counter badge — like Crextio 2/8 */}
            {miniLogs.length > 0 && (
              <span className="text-lg font-bold text-white">
                {miniLogs.filter(l => l.type === "success").length}
                <span className="text-dark-500 text-sm font-medium">/{miniLogs.length}</span>
              </span>
            )}
          </div>

          {/* Activity list */}
          <div className="flex-1 overflow-y-auto smooth-scroll">
            {miniLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-10 px-4">
                <div className="p-5 rounded-2xl bg-white/[0.03] mb-3 animate-float">
                  <Activity className="h-8 w-8 text-dark-600" />
                </div>
                <p className="text-sm text-dark-500 font-medium text-center">
                  {running ? "Waiting for activity..." : "Start the bot to see live activity"}
                </p>
              </div>
            ) : (
              <div className="px-3 py-2 space-y-1 stagger-children">
                {miniLogs.map((log, i) => (
                  <div key={i} className={`flex items-start gap-3 rounded-xl px-3.5 py-3 transition-all duration-300 group ${
                    log.type === "failure" ? "bg-danger/[0.05] hover:bg-danger/[0.08]" :
                    log.type === "flood" ? "bg-warning/[0.05] hover:bg-warning/[0.08]" :
                    "bg-white/[0.02] hover:bg-white/[0.04]"
                  }`}>
                    {/* Icon */}
                    <div className={`mt-0.5 p-2 rounded-xl shrink-0 ${
                      log.type === "success" ? "bg-success/15 text-success" :
                      log.type === "flood" ? "bg-warning/15 text-warning" :
                      "bg-danger/15 text-danger"
                    }`}>
                      {log.type === "success" ? <CheckCircle className="h-3.5 w-3.5" /> :
                       log.type === "flood" ? <Timer className="h-3.5 w-3.5" /> :
                       <XCircle className="h-3.5 w-3.5" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-dark-200 leading-tight">
                        {log.type === "success" ? "Sent to " : log.type === "flood" ? "Rate limited in " : "Failed in "}
                        <span className="font-semibold text-white">{log.group}</span>
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {log.time && <span className="text-[10px] font-mono text-dark-600">{log.time}</span>}
                        {log.error && (
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            log.type === "flood" ? "bg-warning/10 text-warning/80" : "bg-danger/10 text-danger/80"
                          }`}>{log.error}</span>
                        )}
                      </div>
                    </div>

                    {/* Status indicator — like Crextio green checkmarks */}
                    <div className={`shrink-0 mt-0.5 h-6 w-6 rounded-full flex items-center justify-center ${
                      log.type === "success" ? "bg-success/20" : log.type === "flood" ? "bg-warning/20" : "bg-danger/20"
                    }`}>
                      {log.type === "success" ? <CheckCircle className="h-3.5 w-3.5 text-success" /> :
                       log.type === "flood" ? <Clock className="h-3.5 w-3.5 text-warning" /> :
                       <XCircle className="h-3.5 w-3.5 text-danger" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer link */}
          <div className="px-5 py-3 border-t border-white/[0.04]">
            <Link href="/user/logs" className="flex items-center justify-center gap-1.5 text-xs text-accent hover:text-accent-300 font-semibold transition-colors group">
              View All Logs <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>
      </div>
      </div>{/* end desktop view */}
    </div>
  );
}

/* ═══════════════════ GLASS STAT CARD ═══════════════════ */

function GlassStatCard({ icon, accent, label, value, footer, highlight }: {
  icon: React.ReactNode; accent: string; label: string; value: number;
  footer: React.ReactNode; highlight?: boolean;
}) {
  const colorMap: Record<string, { bg: string; text: string; glow: string }> = {
    accent:  { bg: "bg-accent/12", text: "text-accent", glow: "shadow-glow-accent" },
    success: { bg: "bg-success/12", text: "text-success", glow: "shadow-glow-success" },
    danger:  { bg: "bg-danger/12", text: "text-danger", glow: "shadow-glow-danger" },
    warning: { bg: "bg-warning/12", text: "text-warning", glow: "" },
    info:    { bg: "bg-info/12", text: "text-info", glow: "" },
  };
  const c = colorMap[accent] || colorMap.accent;

  return (
    <div className={`glass-stat group transition-all duration-300 cursor-default px-5 py-5 ${
      highlight ? "!border-danger/20" : "hover:border-white/[0.1]"
    }`}>
      {highlight
        ? <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-danger/12 blur-[50px] pointer-events-none" />
        : <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none ${c.glow}`} />}

      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2.5 rounded-xl ${c.bg} ${c.text} group-hover:scale-105 transition-transform duration-300`}>{icon}</div>
            <span className="text-[14px] text-dark-300 font-medium truncate">{label}</span>
          </div>
          <MoreVertical className="h-[18px] w-[18px] text-dark-600 shrink-0 -mr-1" />
        </div>

        <p className="text-[34px] font-bold text-white tracking-tight leading-none mt-3">
          <AnimatedNumber value={value} />
        </p>

        <div className="mt-2.5">{footer}</div>
      </div>
    </div>
  );
}

/* ═══════════════════ MOBILE STAT CARD ═══════════════════ */

function MobileStatCard({ icon, accent, label, value, footer, highlight }: {
  icon: React.ReactNode; accent: string; label: string; value: number;
  footer: React.ReactNode; highlight?: boolean;
}) {
  const colorMap: Record<string, { bg: string; text: string }> = {
    accent:  { bg: "bg-accent/12", text: "text-accent" },
    success: { bg: "bg-success/12", text: "text-success" },
    danger:  { bg: "bg-danger/12", text: "text-danger" },
    warning: { bg: "bg-warning/12", text: "text-warning" },
  };
  const c = colorMap[accent] || colorMap.accent;
  return (
    <div className={`relative rounded-2xl border p-3.5 overflow-hidden ${
      highlight ? "border-danger/20 bg-danger/[0.04]" : "border-white/[0.06] bg-[#101019]"
    }`}>
      {highlight && <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full bg-danger/15 blur-[40px] pointer-events-none" />}
      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <div className={`p-2 rounded-lg ${c.bg} ${c.text}`}>{icon}</div>
          <div className="flex items-start gap-1 flex-1 min-w-0 pt-0.5">
            <span className="text-[12px] text-dark-300 font-medium leading-tight flex-1 min-w-0">{label}</span>
            <MoreVertical className="h-4 w-4 text-dark-600 shrink-0 -mr-1" />
          </div>
        </div>
        <p className="text-[24px] font-bold text-white tracking-tight leading-none mt-2.5">
          <AnimatedNumber value={value} />
        </p>
        <div className="mt-1.5">{footer}</div>
      </div>
    </div>
  );
}

/* ═══════════════════ MOBILE PERF BARS ═══════════════════ */

function PerfBars({ values, labels, height = 104 }: { values: number[]; labels: string[]; height?: number }) {
  const max = Math.max(...values, 1);
  // numeric y-axis derived from the real max (not a fake percentage scale)
  const ticks = [max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0];
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  // thin out x labels when there are many bars (e.g. 24h) so they stay readable
  const step = values.length > 12 ? Math.ceil(values.length / 8) : 1;
  const allZero = values.every(v => v === 0);
  return (
    <div className="flex gap-1.5">
      <div className="flex flex-col justify-between shrink-0" style={{ height }}>
        {ticks.map((t, i) => <span key={i} className="text-[8px] text-dark-600 leading-none tabular-nums">{fmt(t)}</span>)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative" style={{ height }}>
          {ticks.map((t, i) => (
            <div key={i} className="absolute left-0 right-0 border-t border-dashed border-white/[0.06]" style={{ top: `${i * 25}%` }} />
          ))}
          {allZero && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] text-dark-600 font-medium">No activity in this range</span>
            </div>
          )}
          <div className="absolute inset-0 flex items-end justify-between gap-1">
            {values.map((v, i) => (
              <div key={i} className="flex-1 rounded-t-[3px] bg-gradient-to-t from-accent-600 to-accent-400 transition-all duration-700 ease-out"
                style={{ height: `${v > 0 ? Math.max((v / max) * 100, 4) : 0}%`, transitionDelay: `${i * 40}ms` }} />
            ))}
          </div>
        </div>
        <div className="flex justify-between gap-1 mt-1.5">
          {labels.map((d, i) => <span key={i} className="flex-1 text-center text-[9px] text-dark-500 font-medium truncate">{i % step === 0 ? d : ""}</span>)}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ PERF RANGE DROPDOWN ═══════════════════ */

function PerfRangeDropdown({ period, open, setOpen, setPeriod, title, wide }: {
  period: PerfRange; open: boolean; setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  setPeriod: (v: PerfRange) => void; title: string; wide?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] text-[12px] text-dark-200 font-medium hover:bg-white/[0.05] ${wide ? "px-3 py-1.5" : "px-2.5 py-1.5"}`}>
        <CalendarClock className="h-3.5 w-3.5 text-dark-400" />
        {title}
        <ChevronDown className={`h-3.5 w-3.5 text-dark-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-20 w-36 rounded-xl border border-white/[0.08] bg-dark-900 shadow-xl overflow-hidden">
            {PERF_RANGES.map(({ val, label }) => (
              <button key={val} onClick={() => { setPeriod(val); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-[12px] font-medium transition-colors ${
                  period === val ? "bg-accent/15 text-accent" : "text-dark-300 hover:bg-white/[0.04]"
                }`}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ═══════════════════ GITHUB-STYLE HEATMAP ═══════════════════ */

function ContribHeatmap({ cells, big }: { cells: { date: Date; sent: number; failed: number; value: number }[]; big?: boolean }) {
  const max = Math.max(1, ...cells.map(c => c.value));
  const level = (v: number) => (v === 0 ? 0 : v / max > 0.66 ? 4 : v / max > 0.33 ? 3 : v / max > 0.1 ? 2 : 1);
  const colors = ["bg-white/[0.05]", "bg-success/30", "bg-success/50", "bg-success/75", "bg-success"];
  const sz = big ? "h-4 w-4" : "h-3.5 w-3.5";
  const gap = big ? "gap-[4px]" : "gap-[3px]";
  // pad the first column so the first day lands on its real weekday row (Sun=0 … Sat=6)
  const first = cells[0]?.date.getDay() ?? 0;
  const padded: (typeof cells[number] | null)[] = [...Array(first).fill(null), ...cells];
  const cols: (typeof cells[number] | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) cols.push(padded.slice(i, i + 7));
  return (
    <div>
      <div className={`flex ${gap}`}>
        {cols.map((col, ci) => (
          <div key={ci} className={`flex flex-col ${gap}`}>
            {Array.from({ length: 7 }).map((_, ri) => {
              const cell = col[ri];
              if (!cell) return <div key={ri} className={`${sz} rounded-[3px] bg-transparent`} />;
              return (
                <div key={ri} className={`${sz} rounded-[3px] ${colors[level(cell.value)]}`}
                  title={`${cell.date.toLocaleDateString([], { month: "short", day: "numeric" })} — ${cell.sent} sent, ${cell.failed} failed`} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1 mt-2 text-[9px] text-dark-500">
        <span>Less</span>
        {colors.map((c, i) => <span key={i} className={`${big ? "h-3 w-3" : "h-2.5 w-2.5"} rounded-[2px] ${c}`} />)}
        <span>More</span>
      </div>
    </div>
  );
}

/* ═══════════════════ MOBILE PERF STAT BAR ═══════════════════ */

function PerfStatBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-[13px] text-dark-400 font-medium w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 rounded-full bg-white/[0.05] overflow-hidden">
        <div className={`h-full rounded-full ${color} progress-bar-animated`} style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <span className="text-[15px] font-bold text-white w-12 text-right shrink-0 tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

/* ═══════════════════ MOBILE STATUS COLUMN ═══════════════════ */

function StatusCol({ icon, iconColor, label, value, sub, divider }: {
  icon: React.ReactNode; iconColor: string; label: string; value: string; sub: string; divider?: boolean;
}) {
  return (
    <div className={`px-2.5 ${divider ? "border-l border-white/[0.06]" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={iconColor}>{icon}</span>
        <span className="text-[10px] text-dark-400 font-medium leading-tight">{label}</span>
      </div>
      <p className="text-[13px] font-bold text-white leading-tight truncate">{value}</p>
      <p className="text-[9px] text-dark-500 mt-0.5 leading-tight">{sub}</p>
    </div>
  );
}

/* ═══════════════════ HELPERS ═══════════════════ */

function fmtAgo(ts: number): string {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
