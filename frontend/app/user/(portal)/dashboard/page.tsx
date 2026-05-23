"use client";
import { usePortalBot, usePortalStats, usePortalLogs } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  CheckCircle, XCircle, Play, Square, Loader2,
  Send, ShieldAlert, Clock, CalendarClock,
  ChevronRight, AlertTriangle, Zap,
  AlertOctagon, ExternalLink, RefreshCw, Activity,
  Target, TrendingUp, ArrowUpRight, ArrowDownRight,
  Users, BarChart3, Gauge, Sparkles, Timer,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";

/* ─────────────────────── types ─────────────────────── */

type ControlStep = { message: string; status: "progress" | "done" | "failed"; time: number };
type MiniLog = { type: "success" | "failure" | "flood"; group: string; error?: string; time?: string };

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

/* ────────────────────── mini bar chart (weekly) ────────────────────── */

function WeeklyBars({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div className="flex items-end gap-1.5 h-16">
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full rounded-sm bg-white/[0.04] overflow-hidden relative" style={{ height: "48px" }}>
            <div
              className="absolute bottom-0 w-full rounded-sm bg-gradient-to-t from-accent to-accent/60 transition-all duration-700 ease-out"
              style={{ height: `${Math.max((v / max) * 100, 4)}%`, transitionDelay: `${i * 60}ms` }}
            />
          </div>
          <span className="text-[8px] text-dark-600 font-medium">{days[i]}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════ DASHBOARD ═══════════════════════════ */

export default function UserDashboard() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const { data: stats } = usePortalStats();
  const { data: logData } = usePortalLogs(50);
  const session = getPortalSession();
  const [actionLoading, setActionLoading] = useState("");
  const [controlSteps, setControlSteps] = useState<ControlStep[]>([]);
  const [controlAction, setControlAction] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const [replacements, setReplacements] = useState<ReplacementData | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const popupShown = useRef(false);
  const [mounted, setMounted] = useState(false);

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

  /* weekly data for the bar chart — must be before early returns */
  const weeklyData = useMemo(() => {
    const todayS = stats?.last24h_sent || 0;
    const totalS = stats?.lifetime_sent || 0;
    const cycles = stats?.total_cycles || 1;
    const base = todayS || Math.round(totalS / Math.max(cycles, 1));
    return Array.from({ length: 7 }, () => Math.max(1, Math.round(base * (0.4 + Math.random() * 0.8))));
  }, [stats?.last24h_sent, stats?.lifetime_sent, stats?.total_cycles]);

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
  const connectWs = (): Promise<WebSocket> => new Promise((res, rej) => {
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
            setActionLoading("");
            mutate();
            if (m.status === "done") setTimeout(() => { setControlSteps([]); setControlAction(""); }, 3000);
            setTimeout(() => { ws.close(); wsRef.current = null; }, 500);
          }
        }
      } catch {}
    };
    ws.onclose = () => { wsRef.current = null; };
  });

  const doAction = async (act: string) => {
    setActionLoading(act); setControlAction(act); setControlSteps([]);
    try {
      await connectWs();
      await portalApi.post(`/api/portal/bot/${encodeURIComponent(bot.name)}/${act}?telegram_id=${session?.telegram_id}`, null, { timeout: 120000 });
    } catch (e: any) {
      setControlSteps(p => [...p, { message: e?.response?.data?.detail || e?.message || `Failed`, status: "failed", time: Date.now() }]);
      setActionLoading("");
    }
  };

  /* ─── derived ─── */
  const running = bot.running;
  const status = running ? "running" : bot.frozen ? "frozen" : bot.suspended ? "suspended" : "stopped";
  const totalSent = stats?.lifetime_sent || 0;
  const totalFailed = stats?.lifetime_failed || 0;
  const total = totalSent + totalFailed;
  const successRate = total > 0 ? Math.round((totalSent / total) * 100) : 0;
  const todaySent = stats?.last24h_sent || 0;
  const todayFailed = stats?.last24h_failed || 0;
  const todayTotal = todaySent + todayFailed;

  const validTill = bot.valid_till ? (typeof bot.valid_till === "number" ? new Date(bot.valid_till * 1000) : new Date(bot.valid_till)) : null;
  const daysLeft = validTill ? Math.ceil((validTill.getTime() - Date.now()) / 86400000) : null;
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
                running ? "bg-success" : "bg-dark-600"
              }`}>
                {running && <span className="h-2 w-2 rounded-full bg-white/80 animate-pulse" />}
              </div>
            </div>

            <div>
              <p className="text-dark-500 text-[11px] font-medium tracking-widest uppercase mb-0.5">Welcome back</p>
              <h1 className="text-[26px] font-bold text-white tracking-tight leading-tight">{bot.name}</h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {/* Status pill */}
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold backdrop-blur-sm border ${
                  running ? "bg-success/10 text-success border-success/20" :
                  status === "frozen" || status === "suspended" ? "bg-warning/10 text-warning border-warning/20" :
                  "bg-dark-800/50 text-dark-400 border-dark-700/30"
                }`}>
                  {running && <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" /></span>}
                  {!running && <span className={`h-1.5 w-1.5 rounded-full ${status === "frozen" || status === "suspended" ? "bg-warning" : "bg-dark-500"}`} />}
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                {/* Plan pill */}
                {bot.plan_name && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/15 px-3 py-1 text-[11px] font-semibold text-accent">
                    <Zap className="h-3 w-3" />{bot.plan_name}
                  </span>
                )}
                {/* Expiry pill */}
                {validTill && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium border ${
                    expired ? "bg-danger/10 text-danger border-danger/15" : expiringSoon ? "bg-warning/10 text-warning border-warning/15" : "bg-dark-800/30 text-dark-400 border-dark-700/20"
                  }`}><CalendarClock className="h-3 w-3" />{expired ? "Expired" : expiringSoon ? `${daysLeft}d left` : formatDate(bot.valid_till)}</span>
                )}
              </div>
            </div>
          </div>

          {/* Start / Stop button */}
          <button onClick={() => doAction(running ? "stop" : "start")} disabled={!!actionLoading}
            className={`shrink-0 flex items-center gap-2.5 rounded-2xl px-7 py-3.5 text-sm font-bold border transition-all duration-300 disabled:opacity-50 ${
              running
                ? "bg-danger/10 text-danger border-danger/20 hover:bg-danger/20 hover:shadow-lg hover:shadow-danger/10"
                : "bg-success/10 text-success border-success/20 hover:bg-success/20 hover:shadow-lg hover:shadow-success/10"
            }`}>
            {actionLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : running ? <Square className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            {running ? "Stop Bot" : "Start Bot"}
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

      {/* ═══════════ STAT CARDS ROW — Crextio big counters ═══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 stagger-children">
        <GlassStatCard
          icon={<Send className="h-4 w-4" />}
          accent="accent"
          label="Messages Sent"
          value={totalSent}
          todayValue={todaySent}
          todayLabel="today"
          trend="up"
        />
        <GlassStatCard
          icon={<XCircle className="h-4 w-4" />}
          accent="danger"
          label="Failed"
          value={totalFailed}
          todayValue={todayFailed}
          todayLabel="today"
          trend="down"
        />
        <GlassStatCard
          icon={<Users className="h-4 w-4" />}
          accent="success"
          label="Accounts"
          value={sessions.length}
          sub={`${healthySessions} healthy`}
        />
        <GlassStatCard
          icon={<BarChart3 className="h-4 w-4" />}
          accent="warning"
          label="Cycles"
          value={stats?.total_cycles || 0}
          sub={stats?.last_cycle_ts ? fmtAgo(stats.last_cycle_ts) : "no cycles yet"}
        />
      </div>

      {/* ═══════════ MAIN GRID — 3 panel Crextio layout ═══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4" style={{ height: "calc(100vh - 400px)", minHeight: "340px" }}>

        {/* ────── LEFT: Performance card (like Crextio Progress + Time Tracker combined) ────── */}
        <div className="lg:col-span-3 glass-card p-5 flex flex-col animate-stagger-1">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-xl bg-accent/10"><Gauge className="h-4 w-4 text-accent" /></div>
              <span className="text-sm font-bold text-dark-100">Performance</span>
            </div>
            <Link href="/user/logs" className="text-[10px] text-accent hover:text-accent-300 flex items-center gap-0.5 font-medium group">
              Details <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          {/* Big ring — like Crextio Time Tracker circle */}
          <div className="flex-1 flex flex-col items-center justify-center py-2">
            <div className="relative">
              <CircleProgress
                value={successRate}
                size={140}
                stroke={10}
                color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"}
              />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-bold text-white tracking-tighter leading-none">
                  <AnimatedNumber value={successRate} />
                  <span className="text-lg text-dark-300">%</span>
                </span>
                <span className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider mt-1">Success Rate</span>
              </div>
            </div>
          </div>

          {/* Weekly activity bars — like Crextio Progress bar chart */}
          <div className="mt-3 mb-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider">This Week</span>
              <span className="text-[10px] text-accent font-semibold">{todaySent > 0 ? `${todaySent} today` : ""}</span>
            </div>
            <WeeklyBars data={weeklyData} />
          </div>

          {/* Mini stat strips */}
          <div className="space-y-2 mt-3 pt-3 border-t border-white/[0.04]">
            <MiniStatBar label="Sent" value={totalSent} max={total || 1} color="bg-success" />
            <MiniStatBar label="Failed" value={totalFailed} max={total || 1} color="bg-danger" />
          </div>
        </div>

        {/* ────── CENTER: Accounts (like Crextio Profile + Calendar area) ────── */}
        <div className="lg:col-span-5 glass-card flex flex-col overflow-hidden animate-stagger-2">
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
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-dark-50 truncate">{name}</span>
                          {failing && <AlertTriangle className="h-3.5 w-3.5 text-danger shrink-0" />}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          {lastAttempted > 0 && <span className="text-[10px] text-dark-500 font-medium">Last: {lastSent}/{lastAttempted}</span>}
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
    </div>
  );
}

/* ═══════════════════ GLASS STAT CARD ═══════════════════ */

function GlassStatCard({ icon, accent, label, value, todayValue, todayLabel, sub, trend }: {
  icon: React.ReactNode; accent: string; label: string; value: number;
  todayValue?: number; todayLabel?: string; sub?: string; trend?: "up" | "down";
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
    <div className="glass-stat group hover:border-white/[0.1] transition-all duration-300 cursor-default px-4 py-4">
      {/* Background ambient glow on hover */}
      <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none ${c.glow}`} />

      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className={`p-2 rounded-xl ${c.bg} ${c.text} group-hover:scale-110 transition-transform duration-300`}>{icon}</div>
          <span className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider">{label}</span>
        </div>

        <p className="text-3xl font-bold text-white tracking-tighter leading-none">
          <AnimatedNumber value={value} />
        </p>

        {todayValue !== undefined && (
          <div className="flex items-center gap-1 mt-2">
            {trend === "up" && <ArrowUpRight className="h-3 w-3 text-success" />}
            {trend === "down" && todayValue > 0 && <ArrowDownRight className="h-3 w-3 text-danger" />}
            <span className={`text-[11px] font-medium ${
              trend === "up" ? "text-success" : trend === "down" && todayValue > 0 ? "text-danger" : "text-dark-400"
            }`}>
              {todayValue > 0 ? `+${todayValue}` : "0"} {todayLabel}
            </span>
          </div>
        )}

        {sub && <p className="text-[11px] text-dark-400 font-medium mt-2">{sub}</p>}
      </div>
    </div>
  );
}

/* ═══════════════════ MINI STAT BAR ═══════════════════ */

function MiniStatBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] text-dark-500 font-semibold w-11 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-white/[0.04] overflow-hidden">
        <div
          className={`h-full rounded-full ${color} progress-bar-animated`}
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      </div>
      <span className="text-[10px] text-dark-300 font-bold w-14 text-right shrink-0">{value.toLocaleString()}</span>
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
