"use client";
import { useState } from "react";
import { useDashboard, useAlerts } from "@/lib/hooks/useDashboard";
import Badge from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Bot, DollarSign, Cpu, AlertCircle,
  Zap, Shield, CheckCircle2, XCircle, Snowflake,
  Lock, Send, TrendingDown, Clock, Users,
  CalendarClock, ShoppingCart, Activity,
  ArrowRightLeft, Loader2, Play, Trash2, RefreshCw,
  HelpCircle, MessageSquare, AlertTriangle, HardDrive,
  ExternalLink, Hammer, Square, CheckSquare, ChevronDown,
  Calendar,
} from "lucide-react";
import { formatDateTime, timeAgo } from "@/lib/utils";
import type { RangeAnalytics } from "@/lib/types";
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

const replFetcher = (url: string) => api.get(url).then(r => r.data);

/* YYYY-MM-DD for a Date in the viewer's local timezone (native <input type="date"> format). */
function toLocalDateStr(d: Date): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

/* Axis label for a bucket start ts (unix seconds), tuned to the bucket size. */
function fmtRangeLabel(ts: number, bucketSeconds: number): string {
  const d = new Date(ts * 1000);
  if (bucketSeconds >= 86400) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (bucketSeconds >= 3600) return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const { data: alertsData } = useAlerts();
  const { data: replQueue, mutate: mutateRepl } = useSWR<ReplQueueData>(
    "/api/system/replacements", replFetcher, { refreshInterval: 10000 }
  );
  const { data: supportData } = useSWR<{ tickets: any[]; total: number; open: number }>(
    "/api/portal/admin/support-tickets", replFetcher, { refreshInterval: 15000 }
  );
  const [processing, setProcessing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [stuckOpen, setStuckOpen] = useState(false);

  // ── Custom-range analytics (all bots) ──
  const [rangeStart, setRangeStart] = useState(() => toLocalDateStr(new Date(Date.now() - 6 * 86400000)));
  const [rangeEnd, setRangeEnd] = useState(() => toLocalDateStr(new Date()));
  const startUnix = rangeStart ? Math.floor(new Date(`${rangeStart}T00:00:00`).getTime() / 1000) : 0;
  const endUnix = rangeEnd ? Math.floor(new Date(`${rangeEnd}T23:59:59`).getTime() / 1000) : 0;
  const rangeValid = startUnix > 0 && endUnix > 0 && startUnix < endUnix;
  const { data: rangeData, isLoading: rangeLoading } = useSWR<RangeAnalytics>(
    rangeValid ? `/api/dashboard/analytics?start=${startUnix}&end=${endUnix}` : null,
    replFetcher,
    { keepPreviousData: true }
  );

  const applyPreset = (preset: "7d" | "30d" | "90d" | "month") => {
    const now = new Date();
    setRangeEnd(toLocalDateStr(now));
    if (preset === "month") {
      setRangeStart(toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), 1)));
    } else {
      const days = preset === "7d" ? 6 : preset === "30d" ? 29 : 89;
      setRangeStart(toLocalDateStr(new Date(now.getTime() - days * 86400000)));
    }
  };

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

  if (isLoading) return <PageSkeleton />;

  const b = data?.bots || { total: 0, running: 0, stopped: 0, expired: 0, dead: 0 };
  const s = data?.sessions || { total: 0, assigned: 0, free: 0, dead: 0, frozen: 0, limited: 0, unauth: 0 };
  const o = data?.orders || { total: 0, completed: 0, pending: 0, revenue_usd: 0 };
  const sys = data?.system || { cpu_percent: 0, memory_percent: 0, memory_used_mb: 0, memory_total_mb: 0, uptime_seconds: 0 };
  const workers = data?.workers || { create_worker_ok: false, payment_worker_ok: false };
  const posting = data?.posting || { total_sent: 0, total_failed: 0, today_sent: 0, today_failed: 0, hourly: [] };
  const renewals = data?.renewals_soon || [];
  const topFailing = data?.top_failing || [];
  const recentOrders = data?.recent_orders || [];
  const alerts = alertsData?.items || [];
  const openTickets = supportData?.tickets?.filter((t: any) => t.status === "open") || [];
  const lowSessions = s.free <= 3;

  const successRate = posting.today_sent + posting.today_failed > 0
    ? ((posting.today_sent / (posting.today_sent + posting.today_failed)) * 100).toFixed(1)
    : "100";

  const hourlyChart = posting.hourly.map((h) => {
    const date = new Date(h.hour_ts * 3600 * 1000);
    return {
      time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      sent: h.sent,
      failed: h.failed,
    };
  });

  // Custom-range derived values
  const rangeChart = (rangeData?.points || []).map((p) => ({
    label: fmtRangeLabel(p.ts, rangeData?.bucket_seconds || 3600),
    sent: p.sent,
    failed: p.failed,
  }));
  const rSent = rangeData?.total_sent || 0;
  const rFailed = rangeData?.total_failed || 0;
  const rTotal = rSent + rFailed;
  const rSuccess = rTotal > 0 ? ((rSent / rTotal) * 100).toFixed(1) : "—";
  const rangePerBot = (rangeData?.per_bot || []).slice(0, 6);

  const clayStats = [
    {
      title: "Total Users", value: b.total, subtitle: `${b.running} running · ${b.stopped} stopped`,
      icon: Users, tone: "accent" as const,
    },
    {
      title: "Posts Today", value: posting.today_sent.toLocaleString(), subtitle: `${posting.today_failed} failed · ${successRate}% success`,
      icon: Send, tone: "info" as const, live: true,
    },
    {
      title: "Total Revenue",
      value: `$${(o.revenue_usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      subtitle: `${o.completed} completed · ${o.pending} pending`, icon: DollarSign, tone: "success" as const,
    },
    {
      title: "CPU / RAM", value: `${sys.cpu_percent?.toFixed(0) || 0}% / ${sys.memory_percent?.toFixed(0) || 0}%`,
      subtitle: `${Math.round(sys.memory_used_mb)}MB used`, icon: Cpu, tone: "warning" as const,
    },
  ];
  const toneMap: Record<string, string> = {
    accent: "clay-tone-accent", info: "clay-tone-info", success: "clay-tone-success", warning: "clay-tone-warning",
  };

  return (
    <div className="clay-root space-y-6 animate-fade-in">
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
        /* Raised clay surface */
        .clay-card {
          position: relative; border-radius: 26px;
          background: linear-gradient(152deg, #23232f 0%, #17171f 100%);
          border: 1px solid rgba(255,255,255,0.05); overflow: hidden;
          box-shadow:
            12px 14px 30px rgba(0,0,0,0.55),
            -8px -8px 22px rgba(255,255,255,0.022),
            inset 1px 1px 1px rgba(255,255,255,0.06),
            inset 0 -9px 18px rgba(0,0,0,0.30);
        }
        /* Depth-only (keeps a coloured tint for alert surfaces) */
        .clay-raise {
          border-radius: 22px;
          box-shadow:
            10px 12px 26px rgba(0,0,0,0.5),
            -7px -7px 18px rgba(255,255,255,0.02),
            inset 1px 1px 1px rgba(255,255,255,0.06);
        }
        /* Stat tile */
        .clay-stat {
          position: relative; border-radius: 24px; overflow: hidden;
          background: linear-gradient(152deg, #25252f 0%, #171720 100%);
          border: 1px solid rgba(255,255,255,0.055);
          box-shadow:
            10px 12px 26px rgba(0,0,0,0.52),
            -7px -7px 18px rgba(255,255,255,0.025),
            inset 1px 1px 1px rgba(255,255,255,0.07),
            inset 0 -8px 16px rgba(0,0,0,0.28);
          transition: transform .25s cubic-bezier(.16,1,.3,1), box-shadow .25s cubic-bezier(.16,1,.3,1);
        }
        .clay-stat:hover {
          transform: translateY(-4px);
          box-shadow:
            16px 20px 38px rgba(0,0,0,0.58),
            -7px -7px 20px rgba(255,255,255,0.03),
            inset 1px 1px 1px rgba(255,255,255,0.08),
            inset 0 -8px 16px rgba(0,0,0,0.26);
        }
        /* Squishy icon pill (embossed) */
        .clay-pill {
          border-radius: 18px;
          box-shadow:
            inset 2px 2px 5px rgba(0,0,0,0.45),
            inset -2px -2px 6px rgba(255,255,255,0.07),
            4px 5px 12px rgba(0,0,0,0.35);
        }
        .clay-tone-accent   { background: linear-gradient(150deg,#8b6cff,#5a45d6); color:#fff; }
        .clay-tone-info     { background: linear-gradient(150deg,#74b9ff,#3d7bd6); color:#fff; }
        .clay-tone-success  { background: linear-gradient(150deg,#2fe0c4,#00a89f); color:#04241f; }
        .clay-tone-warning  { background: linear-gradient(150deg,#ffd479,#e5a900); color:#3a2600; }
        /* Recessed inset (tracks, tiles) */
        .clay-inset {
          border-radius: 14px; background: #131319;
          box-shadow: inset 3px 3px 7px rgba(0,0,0,0.55), inset -2px -2px 5px rgba(255,255,255,0.03);
        }
        /* Buttons */
        .clay-btn-primary {
          border-radius: 16px; color:#fff;
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
          border-radius: 14px;
          background: linear-gradient(150deg,#26262f,#181820);
          box-shadow: 4px 4px 10px rgba(0,0,0,0.42), -3px -3px 8px rgba(255,255,255,0.03), inset 1px 1px 1px rgba(255,255,255,0.05);
          transition: transform .15s cubic-bezier(.16,1,.3,1), filter .15s;
        }
        .clay-btn-soft:hover { filter: brightness(1.2); }
        .clay-btn-soft:active { transform: scale(0.93); }
        @media (prefers-reduced-motion: reduce) {
          .clay-stat, .clay-btn-primary, .clay-btn-soft { transition: none; }
        }
      `}</style>

      {/* ────── Paid-but-stuck orders — collapsed notification; click to reveal who ────── */}
      {stuckOrders.length > 0 && (
        <div className="clay-raise border border-warning/30 bg-warning/5 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3">
            <button
              type="button"
              onClick={() => setStuckOpen((v) => !v)}
              aria-expanded={stuckOpen}
              className="flex items-center gap-2.5 min-w-0 text-left group"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full clay-pill bg-warning/20 text-warning shrink-0">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-warning truncate">
                  {stuckOrders.length} order{stuckOrders.length > 1 ? "s" : ""} paid but stuck in queue
                </span>
                <span className="block text-[11px] text-dark-500 truncate">
                  {stuckOpen ? "Tap to collapse" : "Tap to see exactly who — and recreate them"}
                </span>
              </span>
              <ChevronDown className={`h-4 w-4 text-warning/80 shrink-0 transition-transform duration-200 ${stuckOpen ? "rotate-180" : ""}`} />
            </button>
            <Link href="/admin/payments" className="text-[11px] text-dark-400 hover:text-dark-200 flex items-center gap-1 shrink-0">
              <span className="hidden sm:inline">View all in Payments</span>
              <span className="sm:hidden">All</span>
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          {stuckOpen && (
            <div className="border-t border-warning/20 divide-y divide-warning/10 max-h-72 overflow-y-auto custom-scrollbar animate-slide-down">
              {stuckOrders.slice(0, 12).map((o: any) => (
                <div key={o.order_id} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-dark-200 truncate">{o.order_id}</p>
                    <p className="text-[11px] text-dark-500 truncate mt-0.5">
                      {o.plan_name || "—"} {o.amount_usd ? `· $${o.amount_usd}` : ""}
                      {o.user_id ? ` · User ${o.user_id}` : ""}
                      {o.creation_step ? ` — ${o.creation_step}` : ""}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openRecreate(o)}>
                    <Hammer className="h-3.5 w-3.5 text-warning" /> Recreate
                  </Button>
                </div>
              ))}
              {stuckOrders.length > 12 && (
                <div className="px-5 py-2.5 text-[11px] text-dark-500">
                  +{stuckOrders.length - 12} more —{" "}
                  <Link href="/admin/payments" className="text-warning hover:underline">open Payments</Link>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ────── Stat Cards (claymorphism) ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        {clayStats.map((st) => {
          const Icon = st.icon;
          return (
            <div key={st.title} className="clay-stat p-5">
              <div className="flex items-center justify-between mb-4">
                <div className={`flex h-12 w-12 items-center justify-center clay-pill ${toneMap[st.tone]}`}>
                  <Icon className="h-5 w-5" />
                </div>
                {st.live && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-emerald-400 text-xs font-bold">Live</span>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  </div>
                )}
              </div>
              <p className="text-[10px] font-bold text-dark-500 uppercase tracking-widest mb-1.5">{st.title}</p>
              <p className="text-2xl sm:text-[30px] font-bold text-white tracking-tight leading-none">{st.value}</p>
              {st.subtitle && <p className="text-[11px] text-dark-500 mt-2.5">{st.subtitle}</p>}
            </div>
          );
        })}
      </div>

      {/* ────── Alert Banners (side by side like Stitch) ────── */}
      {(lowSessions || openTickets.length > 0) && (
        <div className={`grid gap-4 ${lowSessions && openTickets.length > 0 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}>
          {lowSessions && (
            <div className="clay-raise border border-red-500/30 bg-red-500/[0.07] px-4 py-3 flex items-center gap-3">
              <div className="h-10 w-10 rounded-full clay-pill bg-red-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-red-400">Low Session Pool</p>
                <p className="text-xs text-red-400/70 mt-0.5">
                  Only <span className="font-bold text-red-300">{s.free}</span> free session{s.free !== 1 ? "s" : ""} remaining.
                  {replQueue && replQueue.total_awaiting > 0 && ` ${replQueue.total_awaiting} replacement(s) waiting.`}
                </p>
              </div>
              <Link href="/admin/sessions"
                className="px-3 py-1.5 bg-red-500 text-white font-bold text-[11px] rounded-lg hover:brightness-110 transition-all shrink-0 uppercase tracking-wide">
                Upload
              </Link>
            </div>
          )}
          {openTickets.length > 0 && (
            <div className="clay-raise border border-amber-500/30 bg-amber-900/20 px-4 py-3 flex items-center gap-3">
              <div className="h-10 w-10 rounded-full clay-pill bg-amber-500/20 flex items-center justify-center shrink-0">
                <HelpCircle className="h-5 w-5 text-amber-500" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-amber-500">
                  {openTickets.length} Open Support Ticket{openTickets.length !== 1 ? "s" : ""}
                </p>
                <p className="text-xs text-amber-500/70 mt-0.5">
                  Users need help — check and respond.
                </p>
              </div>
              <Link href="/admin/support"
                className="px-3 py-1.5 bg-amber-600 text-white font-bold text-[11px] rounded-lg hover:brightness-110 transition-all shrink-0 uppercase tracking-wide">
                View All
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ────── Replacement Queue ────── */}
      {replQueue && (replQueue.total_pending > 0 || (replQueue.total_awaiting_payment || 0) > 0 || replQueue.completed_recent?.length > 0) && (() => {
        const pending = replQueue.queue || [];
        const awaiting = replQueue.awaiting_sessions || [];
        const awaitingPayment = replQueue.awaiting_payment || [];
        const completed = replQueue.completed_recent || [];

        const handleProcess = async () => {
          setProcessing(true);
          try {
            const { data: result } = await api.post("/api/system/replacements/process");
            if (result.processed > 0) {
              toast.success(`Processed ${result.processed} replacement(s) successfully`);
            } else if (result.error) {
              toast.error(result.error);
            } else if (result.failed > 0) {
              const reasons = (result.errors || []).filter(Boolean).join("; ");
              toast.error(`${result.failed} replacement(s) failed: ${reasons || "session validation failed"}`);
            } else if (result.message) {
              toast(result.message);
            } else {
              toast.error("No replacements could be processed");
            }
            mutateRepl();
          } catch (e: any) {
            toast.error(e?.response?.data?.detail || "Failed to process queue");
          }
          setProcessing(false);
        };

        const handleCancel = async (entryId: string) => {
          setCancelling(entryId);
          try {
            await api.post(`/api/system/replacements/${entryId}/cancel`);
            toast.success("Cancelled replacement request");
            mutateRepl();
          } catch (e: any) {
            toast.error(e?.response?.data?.detail || "Failed to cancel");
          }
          setCancelling(null);
        };

        const statusBadge = (status: string) => {
          switch (status) {
            case "awaiting_session":
              return <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400 uppercase">Awaiting</span>;
            case "ready":
              return <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-2 py-0.5 text-[10px] font-bold text-blue-400 uppercase">Ready</span>;
            case "pending_payment":
              return <span className="inline-flex items-center gap-1 rounded bg-purple-500/15 px-2 py-0.5 text-[10px] font-bold text-purple-400 uppercase">Payment</span>;
            case "completed":
              return <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400 uppercase">Done</span>;
            case "cancelled":
              return <span className="inline-flex items-center gap-1 rounded bg-dark-700 px-2 py-0.5 text-[10px] font-bold text-dark-400 uppercase">Cancelled</span>;
            default:
              return <Badge status={status} />;
          }
        };

        return (
          <div className={`overflow-hidden ${
            awaiting.length > 0
              ? "clay-raise border-2 border-amber-500/30 bg-amber-500/[0.05]"
              : "clay-card"
          }`}>
            <div className={`flex items-center justify-between px-5 py-4 border-b border-dark-800/50 ${
              awaiting.length > 0 ? "bg-amber-500/[0.04]" : ""
            }`}>
              <div className="flex items-center gap-3">
                <ArrowRightLeft className={`h-5 w-5 ${awaiting.length > 0 ? "text-amber-400" : "text-accent"}`} />
                <h3 className="text-sm font-semibold text-white">Replacement Queue</h3>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                  awaiting.length > 0
                    ? "bg-amber-500/20 text-amber-400"
                    : "bg-accent/20 text-accent"
                }`}>
                  {pending.length} Pending
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => mutateRepl()} className="clay-btn-soft text-dark-400 hover:text-white p-2">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                {(awaiting.length > 0 || pending.some(e => e.status === "ready")) && (
                  <button
                    onClick={handleProcess}
                    disabled={processing}
                    className="clay-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold"
                  >
                    {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Process Queue
                  </button>
                )}
              </div>
            </div>

            {/* Awaiting warning */}
            {awaiting.length > 0 && (
              <div className="mx-5 mt-4 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-amber-300">
                      {awaiting.length} replacement{awaiting.length > 1 ? "s" : ""} waiting — no free sessions in pool
                    </p>
                    <p className="text-xs text-amber-400/70 mt-0.5">
                      Upload sessions to the free pool on the <Link href="/admin/sessions" className="underline hover:text-amber-300">Sessions page</Link>, then click &quot;Process Queue&quot;
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Awaiting payment — not actionable until the buyer pays */}
            {awaitingPayment.length > 0 && (
              <div className="mx-5 mt-4 rounded-xl bg-purple-500/10 border border-purple-500/20 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-purple-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-purple-300">
                      {awaitingPayment.length} replacement{awaitingPayment.length > 1 ? "s" : ""} awaiting payment
                    </p>
                    <p className="text-xs text-purple-400/70 mt-0.5">
                      These are not ready to process — they&apos;re queued until the buyer&apos;s invoice clears. They&apos;ll appear above automatically once paid.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Table */}
            {pending.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-dark-900/50 border-b border-dark-700/30">
                    <tr>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Bot</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Session</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Reason</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Type</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Status</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider">Requested</th>
                      <th className="px-5 py-2.5 text-[11px] font-bold text-dark-500 uppercase tracking-wider w-20">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-800/20">
                    {pending.map((entry) => (
                      <tr key={entry.id} className="hover:bg-white/[0.03] transition-colors">
                        <td className="px-5 py-3 font-medium text-white text-sm">{entry.bot_name}</td>
                        <td className="px-5 py-3 font-mono text-xs text-accent">{entry.real_name || entry.session_file}</td>
                        <td className="px-5 py-3">
                          <span className={`text-xs font-medium ${
                            entry.spam_status === "FROZEN" || entry.spam_status === "DEAD" ? "text-red-400" :
                            entry.spam_status === "HARD_LIMITED" ? "text-red-400" :
                            entry.spam_status === "TEMP_LIMITED" ? "text-amber-400" : "text-dark-400"
                          }`}>
                            {entry.spam_status || "Unknown"}
                          </span>
                          {entry.failure_rate != null && entry.failure_rate > 0 && (
                            <span className="text-[10px] text-dark-500 ml-1">
                              ({(entry.failure_rate * 100).toFixed(0)}% fail)
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`text-xs font-medium ${entry.free_replacement ? "text-emerald-400" : "text-purple-400"}`}>
                            {entry.free_replacement ? "Free" : `$${(entry.price_usd || 0).toFixed(2)}`}
                          </span>
                        </td>
                        <td className="px-5 py-3">{statusBadge(entry.status)}</td>
                        <td className="px-5 py-3">
                          <span className="text-xs text-dark-500">
                            {entry.created_at ? timeAgo((Date.now() - new Date(entry.created_at).getTime()) / 1000) : "—"}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <button
                            onClick={() => handleCancel(entry.id)}
                            disabled={cancelling === entry.id}
                            className="text-accent hover:underline text-xs font-bold transition-colors"
                          >
                            {cancelling === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "CANCEL"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recently completed */}
            {completed.length > 0 && pending.length === 0 && (
              <div className="px-5 py-4">
                <p className="text-[10px] font-bold text-dark-500 uppercase tracking-widest mb-2">Recently Completed</p>
                <div className="space-y-1.5">
                  {completed.slice(-5).reverse().map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between rounded-lg bg-dark-800/30 px-3 py-2">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-xs text-dark-300">{entry.bot_name}</span>
                        <span className="text-[10px] text-dark-500 font-mono">{entry.real_name || entry.session_file}</span>
                        <span className="text-[10px] text-dark-600">→</span>
                        <span className="text-[10px] text-emerald-400 font-mono">{entry.new_session_file || "—"}</span>
                      </div>
                      <span className="text-[10px] text-dark-600">{entry.completed_at ? timeAgo((Date.now() - new Date(entry.completed_at).getTime()) / 1000) : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ────── Posting Activity Chart ────── */}
      <div className="clay-card">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-800/50">
          <h3 className="text-sm font-semibold text-white">Posting Activity (24h)</h3>
          <div className="flex gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-400" />
              <span className="text-[11px] text-dark-500 font-bold uppercase tracking-tight">Sent</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-400" />
              <span className="text-[11px] text-dark-500 font-bold uppercase tracking-tight">Failed</span>
            </div>
          </div>
        </div>
        <div className="px-5 pt-3 pb-2">
          <div className="h-[160px]">
            {hourlyChart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-dark-500">
                <Activity className="h-12 w-12 text-dark-700 mb-3" />
                <p className="text-sm font-medium text-dark-400">No posting data yet</p>
                <p className="text-xs text-dark-600 mt-1">Chart will populate as bots send messages</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyChart}>
                  <defs>
                    <linearGradient id="sentGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f87171" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e30" vertical={false} />
                  <XAxis dataKey="time" stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: "#252533", border: "1px solid rgba(52,211,153,0.2)",
                      borderRadius: "12px", fontSize: "12px", padding: "10px 14px",
                      boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                    }}
                    labelStyle={{ color: "#acacbe", marginBottom: "4px" }}
                  />
                  <Area type="monotone" dataKey="sent" stroke="#34d399" strokeWidth={2} fill="url(#sentGrad)" dot={false} />
                  <Area type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={2} fill="url(#failGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* ────── Custom Range Analytics (all bots) ────── */}
      <div className="clay-card">
        <div className="flex flex-col gap-3 px-5 py-4 border-b border-dark-800/50 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Calendar className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-white">Custom Range Analytics</h3>
            <span className="text-[11px] text-dark-500 hidden sm:inline">· all bots</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Presets */}
            {([
              { k: "7d", label: "7d" },
              { k: "30d", label: "30d" },
              { k: "90d", label: "90d" },
              { k: "month", label: "This month" },
            ] as const).map((p) => (
              <button
                key={p.k}
                onClick={() => applyPreset(p.k)}
                className="clay-btn-soft px-2.5 py-1.5 text-[11px] font-bold text-dark-300 hover:text-white uppercase tracking-wide"
              >
                {p.label}
              </button>
            ))}
            {/* Date inputs */}
            <input
              type="date"
              value={rangeStart}
              max={rangeEnd || undefined}
              onChange={(e) => setRangeStart(e.target.value)}
              className="clay-inset bg-transparent px-2.5 py-1.5 text-xs text-dark-200 [color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <span className="text-dark-500 text-xs">→</span>
            <input
              type="date"
              value={rangeEnd}
              min={rangeStart || undefined}
              max={toLocalDateStr(new Date())}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="clay-inset bg-transparent px-2.5 py-1.5 text-xs text-dark-200 [color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
        </div>

        {!rangeValid ? (
          <div className="flex flex-col items-center justify-center py-12 text-dark-500">
            <Calendar className="h-10 w-10 text-dark-700 mb-2" />
            <p className="text-sm font-medium text-dark-400">Pick a valid start and end date</p>
          </div>
        ) : (
          <div className="p-5">
            {/* Summary tiles */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
              {[
                { label: "Sent", val: rSent.toLocaleString(), color: "text-emerald-400" },
                { label: "Failed", val: rFailed.toLocaleString(), color: "text-red-400" },
                { label: "Success Rate", val: rSuccess === "—" ? "—" : `${rSuccess}%`, color: "text-white" },
                { label: "Active Bots", val: (rangeData?.bots_with_data || 0).toLocaleString(), color: "text-accent" },
              ].map((t) => (
                <div key={t.label} className="clay-inset p-3.5 text-center">
                  <p className={`text-xl font-bold ${t.color} tabular-nums`}>{t.val}</p>
                  <p className="text-[9px] text-dark-600 font-bold uppercase tracking-widest mt-1">{t.label}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Chart */}
              <div className="lg:col-span-2">
                <div className="h-[220px]">
                  {rangeLoading && rangeChart.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-dark-500">
                      <Loader2 className="h-6 w-6 animate-spin text-dark-600" />
                    </div>
                  ) : rTotal === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-dark-500">
                      <Activity className="h-10 w-10 text-dark-700 mb-2" />
                      <p className="text-sm font-medium text-dark-400">No posts in this range</p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={rangeChart}>
                        <defs>
                          <linearGradient id="rangeSentGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="rangeFailGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f87171" stopOpacity={0.2} />
                            <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e30" vertical={false} />
                        <XAxis dataKey="label" stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
                        <YAxis stroke="#4a4a5a" fontSize={10} tickLine={false} axisLine={false} />
                        <Tooltip
                          contentStyle={{
                            background: "#252533", border: "1px solid rgba(52,211,153,0.2)",
                            borderRadius: "12px", fontSize: "12px", padding: "10px 14px",
                            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                          }}
                          labelStyle={{ color: "#acacbe", marginBottom: "4px" }}
                        />
                        <Area type="monotone" dataKey="sent" stroke="#34d399" strokeWidth={2} fill="url(#rangeSentGrad)" dot={false} />
                        <Area type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={2} fill="url(#rangeFailGrad)" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {/* Per-bot breakdown for the range */}
              <div className="clay-inset p-3">
                <p className="text-[10px] font-bold text-dark-500 uppercase tracking-widest mb-2 px-1">Bots in range</p>
                {rangePerBot.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-xs text-dark-600">No activity</div>
                ) : (
                  <div className="space-y-1.5 max-h-[180px] overflow-y-auto custom-scrollbar">
                    {rangePerBot.map((bot) => {
                      const t = bot.sent + bot.failed;
                      const fr = t > 0 ? ((bot.failed / t) * 100).toFixed(0) : "0";
                      return (
                        <div key={bot.name} className="flex items-center justify-between rounded-lg bg-dark-800/30 px-2.5 py-2">
                          <span className="text-xs font-medium text-dark-200 truncate mr-2">{bot.name}</span>
                          <span className="text-[11px] text-dark-500 shrink-0">
                            {bot.sent.toLocaleString()} sent · <span className={bot.failed > 0 ? "text-red-400" : "text-dark-500"}>{fr}% fail</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ────── Top Failing + Renewals + Support Tickets ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Top Failing Bots */}
        <div className="clay-card flex flex-col max-h-[400px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-bold text-white">Top Failing Bots</h3>
            <TrendingDown className="h-4 w-4 text-dark-500" />
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {topFailing.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <CheckCircle2 className="h-10 w-10 text-emerald-500/30 mb-2" />
                <p className="text-sm text-dark-400">No failures in 24h</p>
              </div>
            ) : (
              <div className="p-4 space-y-2">
                {topFailing.map((bot, i) => {
                  const total = bot.today_sent + bot.today_failed;
                  const failRate = total > 0 ? ((bot.today_failed / total) * 100).toFixed(1) : "0";
                  return (
                    <div key={bot.name} className="flex items-center justify-between hover:bg-dark-800/40 p-2 rounded-lg transition-colors cursor-pointer">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400 font-bold text-[10px]">
                          #{i + 1}
                        </div>
                        <div>
                          <p className="text-[13px] font-medium text-white">{bot.name}</p>
                          <p className="text-[11px] text-dark-500">
                            {bot.today_sent} sent · {bot.today_failed} failed
                          </p>
                        </div>
                      </div>
                      <span className="text-xs font-bold text-red-400">{failRate}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Renewals */}
        <div className="clay-card flex flex-col max-h-[400px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-bold text-white">Upcoming Renewals</h3>
            <CalendarClock className="h-4 w-4 text-dark-500" />
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {renewals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <CalendarClock className="h-10 w-10 text-dark-700 mb-2" />
                <p className="text-sm text-dark-400">No upcoming renewals</p>
              </div>
            ) : (
              <div className="p-4 space-y-3">
                {renewals.map((r) => {
                  const parts = r.valid_till ? r.valid_till.split("/") : null; // DD/MM/YYYY
                  const d = parts && parts.length === 3 ? new Date(+parts[2], +parts[1] - 1, +parts[0]) : null;
                  const month = d ? d.toLocaleString("en-US", { month: "short" }).toUpperCase() : "—";
                  const day = d ? d.getDate() : "—";
                  return (
                    <div key={r.name} className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center shrink-0 border ${
                        r.expired ? "bg-red-500/10 border-red-500/20" :
                        r.days_left <= 3 ? "bg-amber-500/10 border-amber-500/20" :
                        "bg-dark-800 border-dark-700/30"
                      }`}>
                        <span className="text-[9px] font-bold text-dark-500 leading-none">{month}</span>
                        <span className={`text-sm font-bold leading-none ${
                          r.expired ? "text-red-400" : r.days_left <= 3 ? "text-amber-400" : "text-white"
                        }`}>{day}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-white truncate">{r.name}</p>
                        <p className={`text-[11px] font-bold ${
                          r.expired ? "text-red-400" : r.days_left <= 3 ? "text-amber-400" : "text-dark-500"
                        }`}>
                          {r.expired ? "EXPIRED" : `$${r.renewal_price || 0} · ${r.days_left}d left`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Support Tickets */}
        <div className="clay-card flex flex-col max-h-[400px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-bold text-white">Support Tickets</h3>
            <MessageSquare className="h-4 w-4 text-dark-500" />
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {openTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <CheckCircle2 className="h-10 w-10 text-emerald-500/30 mb-2" />
                <p className="text-sm text-dark-400">No open tickets</p>
              </div>
            ) : (
              <div className="p-4 space-y-3">
                {openTickets.slice(0, 8).map((t: any) => (
                  <Link key={t.id} href="/admin/support" className="block">
                    <div className="border-l-2 border-accent pl-3 py-1 hover:bg-dark-800/30 rounded-r-lg transition-colors">
                      <p className="text-[13px] font-bold text-white truncate">
                        {t.session_name || t.session_file}
                      </p>
                      <p className="text-[11px] text-dark-500">
                        {t.bot_name} · {t.issue_type?.replace(/_/g, " ")} · {t.created_at ? timeAgo((Date.now() / 1000) - t.created_at) : "—"}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ────── Recent Orders + Session Pool ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Recent Orders */}
        <div className="clay-card lg:col-span-2 flex flex-col max-h-[420px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-semibold text-white">Recent Orders</h3>
            <Link href="/admin/payments" className="text-xs font-bold text-accent hover:underline uppercase">
              View Report
            </Link>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
            {recentOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <ShoppingCart className="h-10 w-10 text-dark-700 mb-2" />
                <p className="text-sm text-dark-400">No orders yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentOrders.map((order) => (
                  <div key={order.order_id} className="flex items-center justify-between p-3 clay-inset hover:brightness-125 transition-all">
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-full clay-pill flex items-center justify-center shrink-0 ${
                        order.status === "completed" ? "bg-emerald-500/10" :
                        order.status === "cancelled" ? "bg-red-500/10" : "bg-amber-500/10"
                      }`}>
                        {order.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> :
                         order.status === "cancelled" ? <XCircle className="h-4 w-4 text-red-400" /> :
                         <Clock className="h-4 w-4 text-amber-400" />}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white">{order.plan_name || order.order_type}</p>
                        <p className="text-xs text-dark-500">
                          {order.order_type} · User {order.user_id || "?"} · {order.created_at ? new Date(order.created_at).toLocaleDateString() : "—"}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-white">${order.amount_usd.toFixed(2)}</p>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                        order.status === "completed" ? "bg-emerald-500/20 text-emerald-400" :
                        order.status === "cancelled" ? "bg-red-500/20 text-red-400" :
                        "bg-amber-500/20 text-amber-400"
                      }`}>
                        {order.status === "completed" ? "Success" : order.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Session Pool */}
        <div className="clay-card flex flex-col">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Session Pool</h3>
            <div className="flex gap-1">
              <span className={`w-2 h-2 rounded-full ${workers.create_worker_ok ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className={`w-2 h-2 rounded-full ${workers.payment_worker_ok ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {s.dead > 0 && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />}
            </div>
          </div>
          <div className="p-5 space-y-5 flex-1">
            {[
              { label: "ASSIGNED", val: s.assigned, total: s.total, color: "bg-accent", textColor: "text-white" },
              { label: "FREE / AVAILABLE", val: s.free, total: s.total, color: "bg-emerald-400", textColor: "text-emerald-400" },
              { label: "DEAD / FROZEN", val: s.dead + s.frozen, total: s.total, color: "bg-red-500", textColor: "text-red-400" },
            ].map((row) => {
              const pct = row.total > 0 ? (row.val / row.total) * 100 : 0;
              return (
                <div key={row.label}>
                  <div className="flex justify-between text-xs font-bold mb-1">
                    <span className="text-dark-500">{row.label}</span>
                    <span className={row.textColor}>{row.val}</span>
                  </div>
                  <div className="h-2.5 w-full clay-inset overflow-hidden">
                    <div className={`h-full rounded-full ${row.color} transition-all duration-700`}
                      style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />
                  </div>
                </div>
              );
            })}

            {/* Detailed counts */}
            <div className="grid grid-cols-3 gap-2 pt-2">
              {[
                { label: "Limited", val: s.limited, color: "text-amber-400" },
                { label: "Unauth", val: s.unauth, color: "text-dark-400" },
                { label: "Total", val: s.total, color: "text-white" },
              ].map((item) => (
                <div key={item.label} className="clay-inset p-2.5 text-center">
                  <p className={`text-sm font-bold ${item.color}`}>{item.val}</p>
                  <p className="text-[9px] text-dark-600 font-bold uppercase tracking-wider">{item.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Worker threads */}
          <div className="px-5 py-3 border-t border-dark-800/50">
            <p className="text-[10px] font-bold text-dark-500 uppercase tracking-widest mb-2">Worker Status</p>
            <div className="flex flex-wrap gap-1.5">
              <div className={`w-3 h-3 rounded-full ${workers.create_worker_ok ? "bg-emerald-400" : "bg-red-400"}`} title="Create Worker" />
              <div className={`w-3 h-3 rounded-full ${workers.payment_worker_ok ? "bg-emerald-400" : "bg-red-400"}`} title="Payment Worker" />
              <div className="w-3 h-3 rounded-full bg-emerald-400" title="Scheduler" />
              <div className="w-3 h-3 rounded-full bg-emerald-400" title="Monitor" />
            </div>
          </div>
        </div>
      </div>

      {/* ────── System Log / Alerts ────── */}
      {alerts.length > 0 && (
        <div className="clay-card flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-dark-800/50 shrink-0">
            <h3 className="text-sm font-semibold text-white">System Security Log</h3>
            <span className="text-[11px] text-dark-500">Real-time update active</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto custom-scrollbar divide-y divide-dark-800/20">
            {alerts.slice(0, 15).map((a: any, i: number) => (
              <div key={i} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.03] transition-colors">
                <span className="text-xs font-mono text-dark-500 shrink-0 w-16">
                  {a.ts ? new Date(a.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                  a.type === "error" || a.type === "critical" ? "bg-red-500/10 text-red-400" :
                  a.type === "warning" || a.type === "pending_creation" || a.type === "queue_sessions" ? "bg-amber-500/10 text-amber-400" :
                  a.type === "bot" ? "bg-accent/10 text-accent" :
                  "bg-emerald-500/10 text-emerald-400"
                }`}>
                  {a.type || "INFO"}
                </span>
                <p className="text-[13px] text-dark-300 truncate">{a.msg}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recreate modal — pick which steps to skip */}
      <Modal open={!!recreateTarget} onClose={() => setRecreateTarget(null)} title="Recreate Bot" size="sm">
        {recreateTarget && (
          <div className="space-y-4">
            <p className="text-xs text-dark-400">
              Rebuild the bot for order <span className="font-mono text-dark-200">{recreateTarget.order_id}</span>.
              {recreateTarget.creation_step && (
                <span className="block mt-2 rounded-lg bg-warning/10 border border-warning/20 px-2.5 py-2 text-[11px] text-warning">
                  {recreateTarget.creation_step}
                </span>
              )}
            </p>
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-dark-500 uppercase tracking-wider">Skip steps</p>
              <button type="button" onClick={() => setRecreateSkipHealth((v) => !v)}
                className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  recreateSkipHealth ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"
                }`}
              >
                {recreateSkipHealth ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span>
                  <span className={`block text-xs font-medium ${recreateSkipHealth ? "text-warning" : "text-dark-300"}`}>Skip session health check</span>
                  <span className="block text-[11px] text-dark-500 mt-0.5">Use sessions even if they'd normally fail validation (lets bad/dead sessions through).</span>
                </span>
              </button>
              <button type="button" onClick={() => setRecreateSkipChatlist((v) => !v)}
                className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  recreateSkipChatlist ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"
                }`}
              >
                {recreateSkipChatlist ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span>
                  <span className={`block text-xs font-medium ${recreateSkipChatlist ? "text-warning" : "text-dark-300"}`}>Skip default chatlist auto-join</span>
                  <span className="block text-[11px] text-dark-500 mt-0.5">Don't auto-join assigned sessions to the mode's default chatlist folders.</span>
                </span>
              </button>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setRecreateTarget(null)}>Cancel</Button>
              <Button variant="primary" size="sm" className="flex-1" loading={recreating} onClick={confirmRecreate}>
                <Hammer className="h-3.5 w-3.5" /> Recreate
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
