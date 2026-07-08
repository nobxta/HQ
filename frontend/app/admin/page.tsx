"use client";
import { useState, useEffect } from "react";
import { useDashboard, useAlerts } from "@/lib/hooks/useDashboard";
import Badge from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Bot, DollarSign, Cpu, AlertCircle,
  Shield, CheckCircle2, XCircle,
  Send, Clock, Users,
  ShoppingCart, Activity, Server,
  ArrowRightLeft, Loader2, Play, RefreshCw,
  AlertTriangle, HardDrive,
  ExternalLink, Hammer, Square, CheckSquare, ChevronDown, ChevronRight,
  PauseCircle, Wrench, MoreVertical, Layers, Gauge,
} from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { RangeAnalytics, BotHealthRow, FailureReasons } from "@/lib/types";
import useSWR from "swr";
import api from "@/lib/api";
import toast from "react-hot-toast";
import Link from "next/link";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { usePendingOrders } from "@/lib/hooks/usePayments";

/* ── Replacement Queue types ── */
type ReplEntry = {
  id: string;
  bot_name: string;
  session_file: string;
  real_name?: string;
  spam_status?: string;
  failure_rate?: number;
  free_replacement?: boolean;
  price_usd?: number;
  status: string;
  created_at?: string;
  completed_at?: string;
  new_session_file?: string;
  owner_id?: number;
};

type ReplQueueData = {
  queue: ReplEntry[];
  awaiting_payment?: ReplEntry[];
  awaiting_sessions: ReplEntry[];
  completed_recent: ReplEntry[];
  total_pending: number;
  total_awaiting_payment?: number;
  total_awaiting: number;
};

type Issue = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  impact: string;
  affected?: string;
  action?: { label: string; href?: string; onClick?: () => void };
};

const replFetcher = (url: string) => api.get(url).then(r => r.data);

const ACT_RANGES: Record<string, number> = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };

/* Tiny dependency-free sparkline. */
function Sparkline({ values, color = "#34d399", width = 96, height = 26 }: {
  values: number[]; color?: string; width?: number; height?: number;
}) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`);
  return (
    <svg width={width} height={height} className="overflow-visible" preserveAspectRatio="none">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  );
}

/* Humanize an audit action slug, e.g. "emergency_stop" -> "Emergency stop". */
function humanizeAction(a: string): string {
  const s = (a || "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Action";
}

function fmtActLabel(ts: number, bs: number): string {
  const d = new Date(ts * 1000);
  if (bs >= 86400) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (bs >= 3600) return d.toLocaleTimeString([], { hour: "numeric" });
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtCycle(s: number): string {
  if (!s) return "—";
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

const sevChip: Record<string, string> = {
  critical: "bg-red-500/12 text-red-400 border-red-500/25",
  warning: "bg-amber-500/12 text-amber-400 border-amber-500/25",
  info: "bg-accent/10 text-accent border-accent/20",
};

export default function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const { data: alertsData } = useAlerts();
  const { data: replQueue, mutate: mutateRepl } = useSWR<ReplQueueData>(
    "/api/system/replacements", replFetcher, { refreshInterval: 10000 }
  );
  const { data: supportData } = useSWR<{ tickets: any[]; total: number; open: number }>(
    "/api/portal/admin/support-tickets", replFetcher, { refreshInterval: 15000 }
  );
  const { data: botHealth } = useSWR<{ bots: BotHealthRow[] }>(
    "/api/dashboard/bot-health", replFetcher, { refreshInterval: 15000, keepPreviousData: true }
  );
  const [processing, setProcessing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [stuckOpen, setStuckOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [activityRange, setActivityRange] = useState<"1h" | "6h" | "24h" | "7d">("24h");
  const [failRange, setFailRange] = useState<"1h" | "6h" | "24h" | "7d">("24h");

  // ── System controls: maintenance state, real worker heartbeats, emergency actions ──
  const { data: maint, mutate: mutateMaint } = useSWR<{ maintenance_enabled: boolean }>(
    "/api/system/maintenance", replFetcher, { refreshInterval: 15000 }
  );
  const { data: workerHb } = useSWR<Record<string, { last_heartbeat: number; age_sec: number; healthy: boolean }>>(
    "/api/system/workers", replFetcher, { refreshInterval: 15000 }
  );
  const [sysBusy, setSysBusy] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);

  const maintenanceOn = !!maint?.maintenance_enabled;

  const doEmergency = async (kind: "stop" | "resume") => {
    setSysBusy(kind);
    try {
      const { data } = await api.post(`/api/system/emergency-${kind}`);
      toast.success(data?.message || `Emergency ${kind} complete`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Emergency ${kind} failed`);
    }
    setSysBusy("");
    setConfirmStop(false);
    setConfirmResume(false);
  };

  const toggleMaintenance = async () => {
    const next = !maintenanceOn;
    setSysBusy("maint");
    try {
      await api.post(`/api/system/maintenance?enabled=${next}`);
      toast.success(`Maintenance mode ${next ? "enabled" : "disabled"}`);
      mutateMaint();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to toggle maintenance");
    }
    setSysBusy("");
  };

  const fmtAge = (age?: number) => {
    if (age == null || age < 0) return "no signal";
    if (age < 90) return `${Math.round(age)}s ago`;
    if (age < 5400) return `${Math.round(age / 60)}m ago`;
    return `${Math.round(age / 3600)}h ago`;
  };

  // ── Posts trend: last 24h vs prior 24h + sparkline (log-derived, throttled) ──
  const nowRounded = Math.floor(Date.now() / 1000);
  const trendNow = nowRounded - (nowRounded % 300); // 5-min steps keep the SWR key stable
  const { data: postsTrend } = useSWR<RangeAnalytics>(
    `/api/dashboard/analytics?start=${trendNow - 48 * 3600}&end=${trendNow}`,
    replFetcher,
    { refreshInterval: 60000, keepPreviousData: true }
  );
  const trend = (() => {
    const pts = postsTrend?.points || [];
    if (!postsTrend || pts.length === 0) return { delta: null as number | null, spark: [] as number[] };
    const cut = postsTrend.end - 24 * 3600;
    let cur = 0, prev = 0;
    const spark: number[] = [];
    for (const p of pts) {
      if (p.ts >= cut) { cur += p.sent; spark.push(p.sent); }
      else prev += p.sent;
    }
    const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
    return { delta, spark };
  })();

  // ── Merged posting activity (range-based, log-derived) ──
  const { data: activity } = useSWR<RangeAnalytics>(
    `/api/dashboard/analytics?start=${trendNow - ACT_RANGES[activityRange]}&end=${trendNow}`,
    replFetcher, { refreshInterval: 30000, keepPreviousData: true }
  );
  const actChart = (activity?.points || []).map((p) => ({
    label: fmtActLabel(p.ts, activity?.bucket_seconds || 3600), sent: p.sent, failed: p.failed,
  }));

  // ── Failure reasons ──
  const { data: failData } = useSWR<FailureReasons>(
    `/api/dashboard/failure-reasons?range=${failRange}`, replFetcher, { refreshInterval: 30000, keepPreviousData: true }
  );

  // ── Recent admin actions (audit log) ──
  const { data: auditData } = useSWR<{ entries: any[]; total: number }>(
    "/api/system/audit?limit=15", replFetcher, { refreshInterval: 20000 }
  );
  const auditEntries = auditData?.entries || [];

  // Orders that got paid but are stuck (insufficient/bad sessions, no token, etc.) —
  // payment is already received, so these need attention, not silence.
  const { data: pendingOrdersData, mutate: mutatePendingOrders } = usePendingOrders();
  const stuckOrders = (pendingOrdersData?.orders || []).filter((o: any) =>
    o.status === "pending_creation" || (o.source === "web" && o.status === "paid" && !!o.queued)
  );
  const [recreateTarget, setRecreateTarget] = useState<any | null>(null);
  const [recreateSkipHealth, setRecreateSkipHealth] = useState(false);
  const [recreateSkipChatlist, setRecreateSkipChatlist] = useState(false);
  const [recreating, setRecreating] = useState(false);

  const openRecreate = (o: any) => {
    setRecreateSkipHealth(false);
    setRecreateSkipChatlist(false);
    setRecreateTarget(o);
  };

  const confirmRecreate = async () => {
    if (!recreateTarget) return;
    setRecreating(true);
    try {
      await api.post(`/api/orders/${recreateTarget.order_id}/recreate`, {
        skip_health_check: recreateSkipHealth,
        skip_chatlist_join: recreateSkipChatlist,
      });
      toast.success(`Order ${recreateTarget.order_id} — recreate submitted`);
      mutatePendingOrders();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Recreate failed");
    }
    setRecreating(false);
    setRecreateTarget(null);
  };

  // Track last successful refresh for the status strip.
  const [lastUpdate, setLastUpdate] = useState(Date.now());
  useEffect(() => { if (data) setLastUpdate(Date.now()); }, [data]);

  if (isLoading) return <PageSkeleton />;

  const b = data?.bots || { total: 0, running: 0, stopped: 0, expired: 0, dead: 0, frozen: 0, suspended: 0 };
  const s = data?.sessions || { total: 0, assigned: 0, free: 0, dead: 0, frozen: 0, limited: 0, unauth: 0 };
  const o = data?.orders || { total: 0, completed: 0, pending: 0, revenue_usd: 0 };
  const sys = data?.system || { cpu_percent: 0, memory_percent: 0, memory_used_mb: 0, memory_total_mb: 0, uptime_seconds: 0 };
  const workers = data?.workers || { create_worker_ok: false, payment_worker_ok: false };
  const posting = data?.posting || { total_sent: 0, total_failed: 0, today_sent: 0, today_failed: 0, hourly: [] };
  const renewals = data?.renewals_soon || [];
  const recentOrders = data?.recent_orders || [];
  const alerts = alertsData?.items || [];
  const openTickets = supportData?.tickets?.filter((t: any) => t.status === "open") || [];
  const rows = botHealth?.bots || [];

  const postsToday = posting.today_sent + posting.today_failed;
  const successRate = postsToday > 0 ? ((posting.today_sent / postsToday) * 100).toFixed(1) : null;
  const avgPerHour = Math.round(posting.today_sent / 24);
  const diskPct = sys.disk_percent;

  // Worker health (real heartbeat first, fall back to boolean).
  const cw = workerHb?.create_worker_heartbeat;
  const pw = workerHb?.payment_worker_heartbeat;
  const cwHealthy = cw ? cw.healthy : workers.create_worker_ok;
  const pwHealthy = pw ? pw.healthy : workers.payment_worker_ok;
  const workersHealthy = (cwHealthy ? 1 : 0) + (pwHealthy ? 1 : 0);
  const deadFrozen = s.dead + s.frozen;

  // ── Needs Attention: derive real issues, worst first ──
  const issues: Issue[] = [];
  if (pw && !pw.healthy) issues.push({ id: "pw", severity: "critical", title: `Payment worker offline (${fmtAge(pw.age_sec)})`, impact: "New payments are not being processed.", action: { label: "View Logs", href: "/admin/logs" } });
  if (cw && !cw.healthy) issues.push({ id: "cw", severity: "critical", title: `Create worker offline (${fmtAge(cw.age_sec)})`, impact: "New bot creation is stalled.", action: { label: "View Logs", href: "/admin/logs" } });
  if (diskPct != null && diskPct >= 85) issues.push({ id: "disk", severity: diskPct >= 95 ? "critical" : "warning", title: `Disk ${diskPct.toFixed(0)}% full`, impact: `Posting halts if the disk fills — per-bot logs never rotate${sys.logs_size_mb != null ? ` (data/logs is ${sys.logs_size_mb.toLocaleString()} MB)` : ""}.`, action: { label: "View Logs", href: "/admin/logs" } });
  if (s.free <= 3) issues.push({ id: "pool", severity: s.free === 0 ? "critical" : "warning", title: `Only ${s.free} free session${s.free !== 1 ? "s" : ""} in pool`, impact: "New users can't be assigned sessions and replacements will stall.", action: { label: "Upload Sessions", href: "/admin/sessions" } });
  if (deadFrozen > 0) issues.push({ id: "deadsess", severity: "warning", title: `${deadFrozen} dead/frozen session${deadFrozen !== 1 ? "s" : ""}`, impact: "Affected bots run under capacity until replaced.", action: { label: "View Sessions", href: "/admin/sessions" } });
  if (replQueue && replQueue.total_awaiting > 0) issues.push({ id: "repl", severity: "warning", title: `${replQueue.total_awaiting} replacement${replQueue.total_awaiting !== 1 ? "s" : ""} waiting for sessions`, impact: "Users are waiting for working accounts.", action: { label: "Upload Sessions", href: "/admin/sessions" } });
  if (stuckOrders.length > 0) issues.push({ id: "stuck", severity: "warning", title: `${stuckOrders.length} paid order${stuckOrders.length !== 1 ? "s" : ""} stuck in queue`, impact: "Payment received but the bot was not created.", action: { label: "View Payments", href: "/admin/payments" } });
  if (b.expired > 0) issues.push({ id: "expired", severity: "warning", title: `${b.expired} expired bot${b.expired !== 1 ? "s" : ""}`, impact: "These bots stopped posting when their plan lapsed.", action: { label: "Open AdBots", href: "/admin/adbots" } });
  if (openTickets.length > 0) issues.push({ id: "tickets", severity: "info", title: `${openTickets.length} open support ticket${openTickets.length !== 1 ? "s" : ""}`, impact: "Users are waiting for a response.", action: { label: "View Support", href: "/admin/support" } });
  if (maintenanceOn) issues.push({ id: "maint", severity: "info", title: "Maintenance mode is ON", impact: "User-facing actions (purchases, renewals, replacements) are paused.", action: { label: "Turn Off", onClick: toggleMaintenance } });
  const sevRank = { critical: 0, warning: 1, info: 2 } as const;
  issues.sort((a, c) => sevRank[a.severity] - sevRank[c.severity]);

  const platform = issues.some(i => i.severity === "critical")
    ? { label: "Critical", cls: "text-red-400", dot: "bg-red-400" }
    : issues.some(i => i.severity === "warning")
      ? { label: "Warning", cls: "text-amber-400", dot: "bg-amber-400" }
      : { label: "Operational", cls: "text-emerald-400", dot: "bg-emerald-400" };

  const botStatus = (r: BotHealthRow) => {
    if (r.frozen) return { t: "Frozen", c: "text-red-400 bg-red-500/10" };
    if (r.state === "expired" || (r.days_left != null && r.days_left < 0)) return { t: "Expired", c: "text-red-400 bg-red-500/10" };
    if (r.suspended) return { t: "Suspended", c: "text-amber-400 bg-amber-500/10" };
    if (r.running) return { t: "Running", c: "text-emerald-400 bg-emerald-500/10" };
    return { t: "Stopped", c: "text-dark-400 bg-dark-700/40" };
  };

  const rangeBtns = (val: string, set: (v: any) => void) => (
    <div className="flex items-center gap-1">
      {(["1h", "6h", "24h", "7d"] as const).map((r) => (
        <button key={r} onClick={() => set(r)}
          className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase tracking-wide transition-all ${
            val === r ? "bg-accent/20 text-accent" : "text-dark-500 hover:text-white"
          }`}>{r}</button>
      ))}
    </div>
  );

  return (
    <div className="clay-root space-y-4 sm:space-y-5 animate-fade-in">
      <style jsx>{`
        .clay-root { position: relative; isolation: isolate; }
        .clay-root::before {
          content: ""; position: absolute; inset: -60px -30px; z-index: -2; pointer-events: none;
          background:
            radial-gradient(48% 40% at 12% -4%, rgba(108,92,231,0.20), transparent 70%),
            radial-gradient(42% 38% at 100% 8%, rgba(0,206,201,0.12), transparent 72%),
            radial-gradient(55% 55% at 88% 108%, rgba(219,39,119,0.10), transparent 70%);
          filter: blur(14px);
        }
        .clay-card {
          position: relative; border-radius: 22px;
          background: linear-gradient(152deg, #23232f 0%, #17171f 100%);
          border: 1px solid rgba(255,255,255,0.05); overflow: hidden;
          box-shadow:
            12px 14px 30px rgba(0,0,0,0.55),
            -8px -8px 22px rgba(255,255,255,0.022),
            inset 1px 1px 1px rgba(255,255,255,0.06),
            inset 0 -9px 18px rgba(0,0,0,0.30);
        }
        .clay-raise {
          border-radius: 18px;
          box-shadow:
            10px 12px 26px rgba(0,0,0,0.5),
            -7px -7px 18px rgba(255,255,255,0.02),
            inset 1px 1px 1px rgba(255,255,255,0.06);
        }
        .clay-stat {
          position: relative; border-radius: 20px; overflow: hidden;
          background: linear-gradient(152deg, #25252f 0%, #171720 100%);
          border: 1px solid rgba(255,255,255,0.055);
          box-shadow:
            8px 10px 22px rgba(0,0,0,0.5),
            -6px -6px 16px rgba(255,255,255,0.022),
            inset 1px 1px 1px rgba(255,255,255,0.06),
            inset 0 -7px 14px rgba(0,0,0,0.26);
        }
        .clay-pill {
          border-radius: 14px;
          box-shadow:
            inset 2px 2px 5px rgba(0,0,0,0.45),
            inset -2px -2px 6px rgba(255,255,255,0.07),
            4px 5px 12px rgba(0,0,0,0.35);
        }
        .clay-tone-accent   { background: linear-gradient(150deg,#8b6cff,#5a45d6); color:#fff; }
        .clay-tone-info     { background: linear-gradient(150deg,#74b9ff,#3d7bd6); color:#fff; }
        .clay-tone-success  { background: linear-gradient(150deg,#2fe0c4,#00a89f); color:#04241f; }
        .clay-tone-warning  { background: linear-gradient(150deg,#ffd479,#e5a900); color:#3a2600; }
        .clay-tone-danger   { background: linear-gradient(150deg,#ff8080,#d64545); color:#fff; }
        .clay-inset {
          border-radius: 12px; background: #131319;
          box-shadow: inset 3px 3px 7px rgba(0,0,0,0.55), inset -2px -2px 5px rgba(255,255,255,0.03);
        }
        .clay-btn-primary {
          border-radius: 14px; color:#fff;
          background: linear-gradient(150deg,#8b6cff,#5a45d6);
          box-shadow:
            5px 6px 14px rgba(0,0,0,0.45), -3px -3px 9px rgba(255,255,255,0.05),
            inset 1px 1px 2px rgba(255,255,255,0.35), inset -2px -4px 8px rgba(40,28,100,0.55);
          transition: transform .15s cubic-bezier(.16,1,.3,1), filter .15s;
        }
        .clay-btn-primary:hover { filter: brightness(1.09); }
        .clay-btn-primary:active { transform: scale(0.95); }
        .clay-btn-primary:disabled { opacity: .55; }
        .clay-btn-soft {
          border-radius: 12px;
          background: linear-gradient(150deg,#26262f,#181820);
          box-shadow: 4px 4px 10px rgba(0,0,0,0.42), -3px -3px 8px rgba(255,255,255,0.03), inset 1px 1px 1px rgba(255,255,255,0.05);
          transition: transform .15s cubic-bezier(.16,1,.3,1), filter .15s;
        }
        .clay-btn-soft:hover { filter: brightness(1.2); }
        .clay-btn-soft:active { transform: scale(0.93); }
        @media (prefers-reduced-motion: reduce) {
          .clay-btn-primary, .clay-btn-soft { transition: none; }
        }
      `}</style>

      {/* ══════════ STATUS STRIP ══════════ */}
      <div className="clay-card px-4 py-2.5 flex items-center gap-x-5 gap-y-2 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <span className={`relative flex h-2.5 w-2.5`}>
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${platform.dot} opacity-60`} />
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${platform.dot}`} />
          </span>
          <span className={`text-sm font-bold ${platform.cls}`}>{platform.label}</span>
        </div>
        <div className="h-4 w-px bg-white/10 hidden sm:block" />
        <div className="flex items-center gap-x-5 gap-y-1 flex-wrap text-[12px] text-dark-300">
          <span><b className="text-white">{b.running}</b><span className="text-dark-500">/{b.total}</span> bots</span>
          <span><b className="text-white">{s.assigned}</b> sessions <span className={s.free <= 3 ? "text-red-400 font-bold" : "text-dark-500"}>({s.free} free)</span></span>
          <span className={posting.today_failed > 0 ? "text-red-400" : ""}><b className={posting.today_failed > 0 ? "text-red-400" : "text-white"}>{posting.today_failed}</b> failed 24h</span>
          <span className={workersHealthy < 2 ? "text-red-400" : ""}>workers <b className={workersHealthy < 2 ? "text-red-400" : "text-white"}>{workersHealthy}/2</b></span>
          <span className="text-dark-500">updated {timeAgo((Date.now() - lastUpdate) / 1000)}</span>
        </div>
        <div className="ml-auto relative shrink-0">
          <button onClick={() => setActionsOpen(v => !v)} aria-label="System actions"
            className="clay-btn-soft flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-dark-300 hover:text-white">
            <MoreVertical className="h-4 w-4" /> Actions
          </button>
          {actionsOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setActionsOpen(false)} />
              <div className="absolute right-0 mt-2 w-56 z-20 clay-card p-1.5">
                <button onClick={() => { toggleMaintenance(); }} disabled={sysBusy === "maint"}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-dark-200 hover:bg-white/[0.04] disabled:opacity-50">
                  <Wrench className="h-4 w-4 text-amber-400" /> Maintenance: {maintenanceOn ? "On" : "Off"}
                </button>
                <button onClick={() => { setActionsOpen(false); setConfirmResume(true); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-dark-200 hover:bg-white/[0.04]">
                  <Play className="h-4 w-4 text-emerald-400" /> Resume Paused Bots
                </button>
                <button onClick={() => { setActionsOpen(false); setConfirmStop(true); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-red-400 hover:bg-red-500/10">
                  <PauseCircle className="h-4 w-4" /> Emergency Stop
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ══════════ NEEDS ATTENTION ══════════ */}
      {issues.length === 0 ? (
        <div className="clay-raise border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-2.5 flex items-center gap-2.5">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          <p className="text-sm font-semibold text-emerald-400">All systems operational — nothing needs attention.</p>
        </div>
      ) : (
        <div className="clay-card overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-dark-800/50">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white">Needs Attention</h3>
            <span className="text-[10px] font-bold text-dark-400 bg-dark-800/60 rounded-full px-2 py-0.5">{issues.length}</span>
          </div>
          <div className="divide-y divide-dark-800/30">
            {issues.map((iss) => (
              <div key={iss.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border shrink-0 ${sevChip[iss.severity]}`}>
                  {iss.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-dark-100 truncate">{iss.title}</p>
                  <p className="text-[11px] text-dark-500 truncate">{iss.impact}</p>
                </div>
                {iss.action && (
                  iss.action.href ? (
                    <Link href={iss.action.href} className="clay-btn-soft shrink-0 px-3 py-1.5 text-[11px] font-bold text-dark-200 hover:text-white flex items-center gap-1">
                      {iss.action.label}<ChevronRight className="h-3 w-3" />
                    </Link>
                  ) : (
                    <button onClick={iss.action.onClick} className="clay-btn-soft shrink-0 px-3 py-1.5 text-[11px] font-bold text-dark-200 hover:text-white">
                      {iss.action.label}
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════ COMPACT METRIC CARDS ══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">

        {/* Posting Health */}
        <div className="clay-stat p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center clay-pill clay-tone-info shrink-0"><Send className="h-4 w-4" /></span>
              <span className="text-[10px] font-bold text-dark-500 uppercase tracking-widest truncate">Posting</span>
            </div>
            {trend.spark.length > 1 && <Sparkline values={trend.spark} color={trend.delta != null && trend.delta < 0 ? "#f87171" : "#34d399"} width={48} height={18} />}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div><p className="text-xl font-bold text-white tabular-nums leading-none">{posting.today_sent.toLocaleString()}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Sent 24h</p></div>
            <div><p className={`text-xl font-bold tabular-nums leading-none ${posting.today_failed > 0 ? "text-red-400" : "text-white"}`}>{posting.today_failed.toLocaleString()}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Failed</p></div>
            <div><p className="text-sm font-bold text-emerald-400 tabular-nums leading-none">{successRate === null ? "—" : `${successRate}%`}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Success</p></div>
            <div><p className="text-sm font-bold text-dark-200 tabular-nums leading-none">{avgPerHour}<span className="text-[10px] text-dark-500">/h</span></p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">{trend.delta != null ? <span className={trend.delta >= 0 ? "text-emerald-400" : "text-red-400"}>{trend.delta >= 0 ? "▲" : "▼"}{Math.abs(trend.delta)}% vs 24h</span> : "avg rate"}</p></div>
          </div>
        </div>

        {/* Session Pool */}
        <div className="clay-stat p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center clay-pill clay-tone-accent shrink-0"><Layers className="h-4 w-4" /></span>
              <span className="text-[10px] font-bold text-dark-500 uppercase tracking-widest truncate">Sessions</span>
            </div>
            <Link href="/admin/sessions" className="text-[10px] font-bold text-accent hover:text-accent-300 flex items-center">Upload<ChevronRight className="h-3 w-3" /></Link>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div><p className="text-xl font-bold text-white tabular-nums leading-none">{s.total}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Total</p></div>
            <div><p className={`text-xl font-bold tabular-nums leading-none ${s.free <= 3 ? "text-red-400" : "text-emerald-400"}`}>{s.free}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Free</p></div>
            <div><p className="text-sm font-bold text-dark-200 tabular-nums leading-none">{s.assigned}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Assigned</p></div>
            <div><p className={`text-sm font-bold tabular-nums leading-none ${deadFrozen > 0 ? "text-red-400" : "text-dark-200"}`}>{deadFrozen}<span className="text-dark-600 text-[10px]"> · {s.limited}L</span></p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Dead/Frozen</p></div>
          </div>
        </div>

        {/* Bots Overview */}
        <div className="clay-stat p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center clay-pill clay-tone-success shrink-0"><Bot className="h-4 w-4" /></span>
              <span className="text-[10px] font-bold text-dark-500 uppercase tracking-widest truncate">Bots</span>
            </div>
            <Link href="/admin/adbots" className="text-[10px] font-bold text-accent hover:text-accent-300 flex items-center">Open<ChevronRight className="h-3 w-3" /></Link>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div><p className="text-xl font-bold text-emerald-400 tabular-nums leading-none">{b.running}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Running</p></div>
            <div><p className="text-xl font-bold text-dark-200 tabular-nums leading-none">{b.stopped}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Stopped</p></div>
            <div><p className={`text-sm font-bold tabular-nums leading-none ${b.expired ? "text-red-400" : "text-dark-200"}`}>{b.expired}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Expired</p></div>
            <div><p className={`text-sm font-bold tabular-nums leading-none ${renewals.length ? "text-amber-400" : "text-dark-200"}`}>{renewals.length}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Expiring</p></div>
          </div>
        </div>

        {/* Orders */}
        <div className="clay-stat p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center clay-pill clay-tone-success shrink-0"><DollarSign className="h-4 w-4" /></span>
              <span className="text-[10px] font-bold text-dark-500 uppercase tracking-widest truncate">Orders</span>
            </div>
            <Link href="/admin/payments" className="text-[10px] font-bold text-accent hover:text-accent-300 flex items-center">View<ChevronRight className="h-3 w-3" /></Link>
          </div>
          {(o.revenue_today || 0) > 0 && (
            <p className="text-xl font-bold text-white tabular-nums leading-none mb-2">${(o.revenue_today || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<span className="text-[10px] text-dark-500 font-medium"> today</span></p>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div><p className="text-sm font-bold text-emerald-400 tabular-nums leading-none">{o.paid_today_count || 0}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Paid today</p></div>
            <div><p className={`text-sm font-bold tabular-nums leading-none ${o.pending_count ? "text-amber-400" : "text-dark-200"}`}>{o.pending_count || 0}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Pending</p></div>
            <div><p className="text-sm font-bold text-dark-200 tabular-nums leading-none">{o.expired_count || 0}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Expired</p></div>
            <div><p className={`text-sm font-bold tabular-nums leading-none ${o.failed_count ? "text-red-400" : "text-dark-200"}`}>{o.failed_count || 0}</p><p className="text-[9px] font-bold uppercase text-dark-600 mt-1">Failed</p></div>
          </div>
        </div>

        {/* Worker Health */}
        <div className="clay-stat p-4 col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center clay-pill clay-tone-warning shrink-0"><Server className="h-4 w-4" /></span>
              <span className="text-[10px] font-bold text-dark-500 uppercase tracking-widest truncate">Workers</span>
            </div>
          </div>
          <div className="space-y-1.5">
            {[{ label: "Create", h: cw, ok: cwHealthy }, { label: "Payment", h: pw, ok: pwHealthy }].map((w) => (
              <div key={w.label} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] text-dark-300">
                  <span className={`w-1.5 h-1.5 rounded-full ${w.ok ? "bg-emerald-400" : "bg-red-400 animate-pulse"}`} />{w.label}
                </span>
                <span className={`text-[10px] font-medium ${w.ok ? "text-dark-500" : "text-red-400"}`}>{w.h ? fmtAge(w.h.age_sec) : (w.ok ? "healthy" : "no signal")}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-white/[0.04]">
              <span className="flex items-center gap-1.5 text-[11px] text-dark-300"><Gauge className="h-3 w-3 text-dark-500" />CPU/RAM</span>
              <span className="text-[10px] font-medium text-dark-400">{sys.cpu_percent?.toFixed(0) || 0}% / {sys.memory_percent?.toFixed(0) || 0}%{diskPct != null ? ` · ${diskPct.toFixed(0)}%💽` : ""}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ════════ Paid-but-stuck orders (inline recreate) ════════ */}
      {stuckOrders.length > 0 && (
        <div className="clay-raise border border-warning/30 bg-warning/5 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <button type="button" onClick={() => setStuckOpen((v) => !v)} aria-expanded={stuckOpen}
              className="flex items-center gap-2.5 min-w-0 text-left group">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
              <span className="text-sm font-semibold text-warning truncate">
                {stuckOrders.length} paid order{stuckOrders.length > 1 ? "s" : ""} stuck — tap to recreate
              </span>
              <ChevronDown className={`h-4 w-4 text-warning/80 shrink-0 transition-transform ${stuckOpen ? "rotate-180" : ""}`} />
            </button>
            <Link href="/admin/payments" className="text-[11px] text-dark-400 hover:text-dark-200 flex items-center gap-1 shrink-0">
              <span className="hidden sm:inline">Payments</span><ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          {stuckOpen && (
            <div className="border-t border-warning/20 divide-y divide-warning/10 max-h-72 overflow-y-auto custom-scrollbar">
              {stuckOrders.slice(0, 12).map((o: any) => (
                <div key={o.order_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-dark-200 truncate">{o.order_id}</p>
                    <p className="text-[11px] text-dark-500 truncate mt-0.5">
                      {o.plan_name || "—"} {o.amount_usd ? `· $${o.amount_usd}` : ""}{o.user_id ? ` · User ${o.user_id}` : ""}{o.creation_step ? ` — ${o.creation_step}` : ""}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openRecreate(o)}>
                    <Hammer className="h-3.5 w-3.5 text-warning" /> Recreate
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════ BOT HEALTH TABLE ══════════ */}
      <div className="clay-card flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
          <div className="flex items-center gap-2.5">
            <Activity className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-bold text-white">Bot Health</h3>
            <span className="text-[10px] font-bold text-dark-400 bg-dark-800/60 rounded-full px-2 py-0.5">{rows.length}</span>
          </div>
          <Link href="/admin/adbots" className="text-[11px] font-bold text-accent hover:underline flex items-center gap-0.5">Open AdBots<ChevronRight className="h-3 w-3" /></Link>
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-dark-500">
            <Bot className="h-9 w-9 text-dark-700 mb-2" />
            <p className="text-sm text-dark-400">No bots yet. Create one from AdBots.</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-dark-900/40 border-b border-dark-800/40">
                  <tr>
                    {["Bot", "Owner", "Plan", "Status", "Sessions", "Cycle", "Last post", "Sent 24h", "Failed 24h", "Issue", ""].map((h) => (
                      <th key={h} className="px-3 py-2 text-[10px] font-bold text-dark-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-800/20">
                  {rows.map((r) => {
                    const st = botStatus(r);
                    const attempted = r.sent_24h + r.failed_24h;
                    const failRate = attempted > 0 ? (r.failed_24h / attempted) * 100 : 0;
                    return (
                      <tr key={r.name} className={`hover:bg-white/[0.03] transition-colors ${r.issue?.severity === "critical" ? "bg-red-500/[0.04]" : r.issue?.severity === "warning" ? "bg-amber-500/[0.03]" : ""}`}>
                        <td className="px-3 py-2.5 text-sm font-semibold text-white whitespace-nowrap">{r.name}</td>
                        <td className="px-3 py-2.5 text-xs text-dark-400 whitespace-nowrap">{r.owner_id ?? "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-dark-400 whitespace-nowrap">{r.plan_name || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${st.c}`}>{st.t}</span></td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                          <span className={r.failing_sessions ? "text-red-400 font-bold" : "text-dark-300"}>{r.failing_sessions}</span>
                          <span className="text-dark-600"> / {r.sessions_count}</span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-dark-400 whitespace-nowrap">{fmtCycle(r.cycle_sec)}</td>
                        <td className="px-3 py-2.5 text-xs text-dark-400 whitespace-nowrap">{r.last_cycle_ts ? timeAgo(Date.now() / 1000 - r.last_cycle_ts) : "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-dark-200 tabular-nums whitespace-nowrap">{r.sent_24h.toLocaleString()}</td>
                        <td className={`px-3 py-2.5 text-xs tabular-nums whitespace-nowrap ${r.failed_24h > 0 ? "text-red-400 font-semibold" : "text-dark-400"}`}>{r.failed_24h.toLocaleString()}{failRate > 0 ? ` (${failRate.toFixed(0)}%)` : ""}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {r.issue ? (
                            <span className={`text-[11px] font-semibold ${r.issue.severity === "critical" ? "text-red-400" : r.issue.severity === "warning" ? "text-amber-400" : "text-dark-400"}`}>{r.issue.label}</span>
                          ) : <span className="text-[11px] text-emerald-400">Healthy</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap"><Link href="/admin/adbots" className="text-accent hover:underline text-[11px] font-bold">Open</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile stacked cards */}
            <div className="md:hidden divide-y divide-dark-800/30">
              {rows.map((r) => {
                const st = botStatus(r);
                return (
                  <div key={r.name} className="px-4 py-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-bold text-white truncate">{r.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${st.c}`}>{st.t}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dark-400">
                      <span>Sent <b className="text-dark-200">{r.sent_24h}</b></span>
                      <span className={r.failed_24h > 0 ? "text-red-400" : ""}>Failed <b className={r.failed_24h > 0 ? "text-red-400" : "text-dark-200"}>{r.failed_24h}</b></span>
                      <span>Sess <b className={r.failing_sessions ? "text-red-400" : "text-dark-200"}>{r.failing_sessions}</b>/{r.sessions_count}</span>
                      <span>Last {r.last_cycle_ts ? timeAgo(Date.now() / 1000 - r.last_cycle_ts) : "—"}</span>
                    </div>
                    {r.issue && <p className={`text-[11px] font-semibold mt-1 ${r.issue.severity === "critical" ? "text-red-400" : "text-amber-400"}`}>⚠ {r.issue.label}</p>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ══════════ Replacement Queue (kept, compact) ══════════ */}
      {replQueue && (replQueue.total_pending > 0 || (replQueue.total_awaiting_payment || 0) > 0) && (() => {
        const pending = replQueue.queue || [];
        const awaiting = replQueue.awaiting_sessions || [];
        const awaitingPayment = replQueue.awaiting_payment || [];

        const handleProcess = async () => {
          setProcessing(true);
          try {
            const { data: result } = await api.post("/api/system/replacements/process");
            if (result.processed > 0) toast.success(`Processed ${result.processed} replacement(s)`);
            else if (result.error) toast.error(result.error);
            else if (result.failed > 0) toast.error(`${result.failed} failed: ${(result.errors || []).filter(Boolean).join("; ") || "validation failed"}`);
            else if (result.message) toast(result.message);
            else toast.error("No replacements could be processed");
            mutateRepl();
          } catch (e: any) {
            toast.error(e?.response?.data?.detail || "Failed to process queue");
          }
          setProcessing(false);
        };
        const handleCancel = async (entryId: string) => {
          setCancelling(entryId);
          try { await api.post(`/api/system/replacements/${entryId}/cancel`); toast.success("Cancelled"); mutateRepl(); }
          catch (e: any) { toast.error(e?.response?.data?.detail || "Failed to cancel"); }
          setCancelling(null);
        };

        return (
          <div className={`clay-card overflow-hidden ${awaiting.length > 0 ? "border border-amber-500/25" : ""}`}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
              <div className="flex items-center gap-2.5">
                <ArrowRightLeft className={`h-4 w-4 ${awaiting.length > 0 ? "text-amber-400" : "text-accent"}`} />
                <h3 className="text-sm font-bold text-white">Replacement Queue</h3>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${awaiting.length > 0 ? "bg-amber-500/20 text-amber-400" : "bg-accent/20 text-accent"}`}>{pending.length} pending</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => mutateRepl()} className="clay-btn-soft text-dark-400 hover:text-white p-2"><RefreshCw className="h-3.5 w-3.5" /></button>
                {(awaiting.length > 0 || pending.some(e => e.status === "ready")) && (
                  <button onClick={handleProcess} disabled={processing} className="clay-btn-primary inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold">
                    {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Process
                  </button>
                )}
              </div>
            </div>
            {awaiting.length > 0 && (
              <div className="mx-4 mt-3 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-300">{awaiting.length} waiting — no free sessions. <Link href="/admin/sessions" className="underline">Upload</Link>, then Process.</p>
              </div>
            )}
            {awaitingPayment.length > 0 && (
              <div className="mx-4 mt-3 rounded-lg bg-purple-500/10 border border-purple-500/20 px-3 py-2 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-purple-400 mt-0.5 shrink-0" />
                <p className="text-xs text-purple-300">{awaitingPayment.length} awaiting payment — queued until the invoice clears.</p>
              </div>
            )}
            {pending.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-dark-900/40 border-b border-dark-800/40">
                    <tr>{["Bot", "Session", "Reason", "Type", "Status", ""].map(h => <th key={h} className="px-4 py-2 text-[10px] font-bold text-dark-500 uppercase tracking-wider">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-dark-800/20">
                    {pending.map((entry) => (
                      <tr key={entry.id} className="hover:bg-white/[0.03]">
                        <td className="px-4 py-2.5 text-sm font-medium text-white">{entry.bot_name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-accent">{entry.real_name || entry.session_file}</td>
                        <td className="px-4 py-2.5 text-xs text-dark-400">{entry.spam_status || "Unknown"}{entry.failure_rate ? <span className="text-dark-500 ml-1">({(entry.failure_rate * 100).toFixed(0)}%)</span> : ""}</td>
                        <td className="px-4 py-2.5 text-xs"><span className={entry.free_replacement ? "text-emerald-400" : "text-purple-400"}>{entry.free_replacement ? "Free" : `$${(entry.price_usd || 0).toFixed(2)}`}</span></td>
                        <td className="px-4 py-2.5"><Badge status={entry.status} /></td>
                        <td className="px-4 py-2.5"><button onClick={() => handleCancel(entry.id)} disabled={cancelling === entry.id} className="text-accent hover:underline text-xs font-bold">{cancelling === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Cancel"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════ Posting Activity + Failure Reasons ══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Posting Activity */}
        <div className="clay-card lg:col-span-2 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
            <div className="flex items-center gap-2.5">
              <Activity className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-bold text-white">Posting Activity</h3>
              <div className="flex gap-3 ml-2">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /><span className="text-[10px] text-dark-500 font-bold uppercase">Sent</span></span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /><span className="text-[10px] text-dark-500 font-bold uppercase">Failed</span></span>
              </div>
            </div>
            {rangeBtns(activityRange, setActivityRange)}
          </div>
          <div className="px-4 pt-3 pb-2">
            <div className="h-[180px]">
              {(activity?.total_sent || 0) + (activity?.total_failed || 0) === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-dark-500">
                  <Activity className="h-9 w-9 text-dark-700 mb-2" />
                  <p className="text-sm text-dark-400">No posting in this window</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={actChart}>
                    <defs>
                      <linearGradient id="sentGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity={0.3} /><stop offset="100%" stopColor="#34d399" stopOpacity={0} /></linearGradient>
                      <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f87171" stopOpacity={0.25} /><stop offset="100%" stopColor="#f87171" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e1e30" vertical={false} />
                    <XAxis dataKey="label" stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "#252533", border: "1px solid rgba(52,211,153,0.2)", borderRadius: "12px", fontSize: "12px", padding: "8px 12px" }} labelStyle={{ color: "#acacbe", marginBottom: "4px" }} />
                    <Area type="monotone" dataKey="sent" stroke="#34d399" strokeWidth={2} fill="url(#sentGrad)" dot={false} />
                    <Area type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={2} fill="url(#failGrad)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* Failure Reasons */}
        <div className="clay-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
            <div className="flex items-center gap-2.5"><AlertTriangle className="h-4 w-4 text-amber-400" /><h3 className="text-sm font-bold text-white">Failure Reasons</h3></div>
            {rangeBtns(failRange, setFailRange)}
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 max-h-[220px]">
            {(failData?.reasons?.length || 0) === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-dark-500">
                <CheckCircle2 className="h-8 w-8 text-emerald-500/30 mb-1.5" />
                <p className="text-xs text-dark-400">No failures in this window</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {(failData?.reasons || []).map((r) => (
                  <div key={r.key} className="flex items-center justify-between clay-inset px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-dark-200">{r.label}</p>
                      {r.sessions.length > 0 && <p className="text-[10px] text-dark-500 truncate">{r.sessions.length} account{r.sessions.length !== 1 ? "s" : ""}: {r.sessions.slice(0, 3).join(", ")}{r.sessions.length > 3 ? "…" : ""}</p>}
                    </div>
                    <span className="text-sm font-bold text-red-400 tabular-nums shrink-0 ml-2">{r.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══════════ Recent Orders + Recent Admin Actions ══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Orders / Queue */}
        <div className="clay-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
            <h3 className="text-sm font-bold text-white">Recent Orders</h3>
            <Link href="/admin/payments" className="text-[11px] font-bold text-accent hover:underline uppercase">View report</Link>
          </div>
          {recentOrders.length === 0 ? (
            <div className="px-4 py-3 flex items-center gap-2 text-xs text-dark-500"><ShoppingCart className="h-4 w-4 text-dark-700" />No orders yet. New purchases appear here.</div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto custom-scrollbar divide-y divide-dark-800/20">
              {recentOrders.map((order) => (
                <div key={order.order_id} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {order.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" /> : order.status === "cancelled" ? <XCircle className="h-4 w-4 text-red-400 shrink-0" /> : <Clock className="h-4 w-4 text-amber-400 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-white truncate">{order.plan_name || order.order_type}</p>
                      <p className="text-[11px] text-dark-500 truncate">User {order.user_id || "?"} · {order.created_at ? new Date(order.created_at).toLocaleDateString() : "—"}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="text-[13px] font-bold text-white">${order.amount_usd.toFixed(2)}</p>
                    <span className={`text-[10px] font-bold uppercase ${order.status === "completed" ? "text-emerald-400" : order.status === "cancelled" ? "text-red-400" : "text-amber-400"}`}>{order.status === "completed" ? "Paid" : order.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Admin Actions */}
        <div className="clay-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
            <div className="flex items-center gap-2.5"><Shield className="h-4 w-4 text-dark-400" /><h3 className="text-sm font-bold text-white">Recent Admin Actions</h3></div>
            <span className="text-[11px] text-dark-500">{auditData?.total || 0} logged</span>
          </div>
          {auditEntries.length === 0 ? (
            <div className="px-4 py-3 text-xs text-dark-500">No admin actions logged yet.</div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto custom-scrollbar divide-y divide-dark-800/20">
              {auditEntries.map((e: any, i: number) => {
                const ts = e.ts ? new Date(e.ts) : null;
                const valid = ts && !isNaN(ts.getTime());
                return (
                  <div key={i} className="px-4 py-2 flex items-center gap-2.5 hover:bg-white/[0.02]">
                    <span className="text-[10px] font-mono text-dark-500 shrink-0 w-16">{valid ? timeAgo((Date.now() - ts!.getTime()) / 1000) : "—"}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 bg-accent/10 text-accent">{humanizeAction(e.action)}</span>
                    <p className="text-[12px] text-dark-300 truncate flex-1">{e.target ? <span className="font-mono text-dark-400">{e.target}</span> : <span className="text-dark-600">—</span>}</p>
                    <span className="text-[10px] text-dark-500 shrink-0">{e.admin_id != null ? `by ${e.admin_id}` : ""}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ══════════ System Security Log (secondary) ══════════ */}
      {alerts.length > 0 && (
        <div className="clay-card flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
            <h3 className="text-sm font-bold text-white">System Security Log</h3>
            <span className="text-[11px] text-dark-500">live</span>
          </div>
          <div className="max-h-[240px] overflow-y-auto custom-scrollbar divide-y divide-dark-800/20">
            {alerts.slice(0, 15).map((a: any, i: number) => (
              <div key={i} className="px-4 py-2 flex items-center gap-2.5 hover:bg-white/[0.02]">
                <span className="text-[11px] font-mono text-dark-500 shrink-0 w-14">{a.ts ? new Date(a.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 ${a.type === "error" || a.type === "critical" ? "bg-red-500/10 text-red-400" : a.type === "warning" ? "bg-amber-500/10 text-amber-400" : a.type === "bot" ? "bg-accent/10 text-accent" : "bg-emerald-500/10 text-emerald-400"}`}>{a.type || "info"}</span>
                <p className="text-[12px] text-dark-300 truncate">{a.msg}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recreate modal */}
      <Modal open={!!recreateTarget} onClose={() => setRecreateTarget(null)} title="Recreate Bot" size="sm">
        {recreateTarget && (
          <div className="space-y-4">
            <p className="text-xs text-dark-400">
              Rebuild the bot for order <span className="font-mono text-dark-200">{recreateTarget.order_id}</span>.
              {recreateTarget.creation_step && (<span className="block mt-2 rounded-lg bg-warning/10 border border-warning/20 px-2.5 py-2 text-[11px] text-warning">{recreateTarget.creation_step}</span>)}
            </p>
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-dark-500 uppercase tracking-wider">Skip steps</p>
              <button type="button" onClick={() => setRecreateSkipHealth((v) => !v)} className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${recreateSkipHealth ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"}`}>
                {recreateSkipHealth ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span><span className={`block text-xs font-medium ${recreateSkipHealth ? "text-warning" : "text-dark-300"}`}>Skip session health check</span><span className="block text-[11px] text-dark-500 mt-0.5">Use sessions even if they'd normally fail validation.</span></span>
              </button>
              <button type="button" onClick={() => setRecreateSkipChatlist((v) => !v)} className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${recreateSkipChatlist ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"}`}>
                {recreateSkipChatlist ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span><span className={`block text-xs font-medium ${recreateSkipChatlist ? "text-warning" : "text-dark-300"}`}>Skip default chatlist auto-join</span><span className="block text-[11px] text-dark-500 mt-0.5">Don't auto-join assigned sessions to default chatlist folders.</span></span>
              </button>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setRecreateTarget(null)}>Cancel</Button>
              <Button variant="primary" size="sm" className="flex-1" loading={recreating} onClick={confirmRecreate}><Hammer className="h-3.5 w-3.5" /> Recreate</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Emergency Stop confirmation */}
      <Modal open={confirmStop} onClose={() => setConfirmStop(false)} title="Stop all bots?" size="sm">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 shrink-0"><PauseCircle className="h-6 w-6 text-red-400" /></div>
            <p className="text-sm text-dark-300">This immediately halts posting for all <b className="text-white">{b.running} running bots</b>. Users can restart their own, or use <b className="text-emerald-400">Resume Paused</b>. This does not delete anything.</p>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => setConfirmStop(false)}>Cancel</Button>
            <Button variant="danger" size="sm" className="flex-1" loading={sysBusy === "stop"} onClick={() => doEmergency("stop")}><PauseCircle className="h-3.5 w-3.5" /> Stop All Bots</Button>
          </div>
        </div>
      </Modal>

      {/* Resume confirmation */}
      <Modal open={confirmResume} onClose={() => setConfirmResume(false)} title="Resume paused bots?" size="sm">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 shrink-0"><Play className="h-6 w-6 text-emerald-400" /></div>
            <p className="text-sm text-dark-300">Restarts bots that were emergency-stopped. Bots stopped by their owners stay stopped.</p>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => setConfirmResume(false)}>Cancel</Button>
            <Button variant="success" size="sm" className="flex-1" loading={sysBusy === "resume"} onClick={() => doEmergency("resume")}><Play className="h-3.5 w-3.5" /> Resume</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
