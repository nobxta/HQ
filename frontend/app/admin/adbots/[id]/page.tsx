"use client";
import { useState, useRef, useEffect, useCallback, forwardRef, type ReactNode, type InputHTMLAttributes } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSession } from "next-auth/react";
import { useAdbot, useAdbotStats, useAdbotLogs, useSessionsOverview } from "@/lib/hooks/useAdbots";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { useForm } from "react-hook-form";
import {
  Play, Square, RotateCw, Trash2, ArrowLeft, Settings, Terminal,
  BarChart3, FolderOpen, HardDrive, Wrench, Pause, PlayCircle,
  MessageSquare, Clock, Users, Zap, Eye, Edit, Save, Copy,
  TrendingUp, TrendingDown, AlertCircle, CheckCircle, XCircle,
  Calendar, DollarSign, Hash, Globe, Shield, User, Plus, RefreshCw,
  CreditCard, KeyRound, Timer,
  Loader2, Phone, AtSign, Crown, Ban, ShieldCheck, ArrowRightLeft,
  Minus, FileText, Search, Key, EyeOff, ChevronDown, ChevronRight,
  ExternalLink, CheckCircle2, Download, Sparkles, List,
  CheckSquare, MinusSquare, Bold, Italic, Underline, Strikethrough,
  Code, Link2, Activity, Zap as ZapIcon, Layout, Smartphone, Server,
  Power, Send, Upload, Filter, MoreVertical, Wifi, Check, AlertOctagon,
  AlertTriangle, Folder,
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, Tooltip, PieChart, Pie, Cell } from "recharts";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDate, formatDateTime, timeAgo, formatUSD, ddmmyyyyToIso, isoToDdmmyyyy } from "@/lib/utils";
import type { BotUpdatePayload } from "@/lib/types";
import { useAdbotAnalytics, type TimeRange } from "@/lib/hooks/useAdbotAnalytics";
import { PostingActivityChart } from "@/components/charts/PostingActivityChart";
import { SessionPerformanceChart } from "@/components/charts/SessionPerformanceChart";
import { DeliveryBreakdownCard } from "@/components/charts/DeliveryBreakdownCard";
import { FailureReasonsChart } from "@/components/charts/FailureReasonsChart";
import { CycleTimingCard } from "@/components/charts/CycleTimingCard";

const tabs = [
  { id: "overview", label: "Overview", icon: Layout },
  { id: "sessions", label: "Sessions", icon: Smartphone },
  { id: "groups", label: "Groups", icon: Users },
  { id: "content", label: "Content", icon: FileText },
  { id: "logs", label: "Logs", icon: Terminal },
  { id: "payments", label: "Payments", icon: CreditCard },
  { id: "access", label: "Access", icon: KeyRound },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "actions", label: "Actions", icon: Wrench },
];

export default function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const name = decodeURIComponent(id);
  const { data: bot, isLoading, mutate, is404 } = useAdbot(name);
  const { data: headerStats } = useAdbotStats(name);
  const [activeTab, setActiveTab] = useState("overview");
  const [actionLoading, setActionLoading] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  if (isLoading) return <BotDetailSkeleton />;
  if (is404 || !bot) return (
    <div className="flex flex-col items-center justify-center py-24 space-y-4 animate-fade-in text-hq-text">
      <div className="w-16 h-16 rounded-[18px] bg-hq-danger/10 border border-hq-danger/20 flex items-center justify-center">
        <AlertCircle className="h-8 w-8 text-hq-danger" strokeWidth={1.75} />
      </div>
      <h2 className="text-[19px] font-semibold text-hq-text">Bot Not Found</h2>
      <p className="text-hq-sub text-[13px] text-center max-w-md">
        &quot;{name}&quot; has been deleted or expired. Sessions have been returned to the free pool.
      </p>
      <HqBtn tone="secondary" onClick={() => router.push("/admin/adbots")} icon={ArrowLeft}>Back to Bots</HqBtn>
    </div>
  );

  const doAction = async (act: string) => {
    setActionLoading(act);
    try {
      await api.post(`/api/bots/${name}/${act}`);
      toast.success(`${act} — success`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Failed: ${act}`);
    }
    setActionLoading("");
  };

  const sp = botStatus(bot);
  const sSent = headerStats?.lifetime_sent || 0;
  const sFailed = headerStats?.lifetime_failed || 0;
  const health = sSent + sFailed > 0 ? Math.round((sSent / (sSent + sFailed)) * 100) : null;
  const dLeft = daysUntil(bot.valid_till);

  return (
    <div className="animate-fade-in text-hq-text -mx-4 -my-4 sm:-mx-6 sm:-my-6 relative">
      {/* Ambient background */}
      <div className="fixed inset-0 pointer-events-none -z-10" style={{
        background: "radial-gradient(ellipse 80% 50% at 70% -10%, rgba(124,92,255,0.10) 0%, transparent 60%), radial-gradient(ellipse 40% 30% at 10% 80%, rgba(0,212,255,0.05) 0%, transparent 50%)",
      }} />

      {/* Sticky bot header */}
      <header className="sticky top-0 z-20 px-4 sm:px-6 py-4" style={{ background: "rgba(9,9,11,0.85)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="flex items-center gap-4 flex-wrap">
          <button onClick={() => router.push("/admin/adbots")} className="w-9 h-9 rounded-[12px] border border-hq-border bg-hq-card text-hq-sub hover:text-hq-text hover:bg-hq-elev transition-colors flex items-center justify-center shrink-0" title="Back to bots">
            <ArrowLeft className="h-4.5 w-4.5" strokeWidth={1.75} />
          </button>
          {/* Avatar with status dot */}
          <div className="relative shrink-0">
            <div className="w-12 h-12 rounded-[16px] flex items-center justify-center text-xl" style={{ background: "linear-gradient(135deg,#7C5CFF22,#9B7FFF22)", border: "1px solid rgba(124,92,255,0.25)", boxShadow: "0 0 16px rgba(124,92,255,0.15)" }}>🤖</div>
            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2" style={{ borderColor: "#09090B", background: sp.color, animation: bot.running ? "pulse 2s cubic-bezier(.4,0,.6,1) infinite" : "none" }} />
          </div>
          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-[18px] font-bold text-hq-text leading-none truncate">{bot.name}</h1>
              {bot.bot_username && <span className="text-[13px] text-hq-muted font-mono">@{bot.bot_username}</span>}
              <HqStatusPill label={sp.label} color={sp.color} />
              {health !== null && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
                  style={{ color: health >= 80 ? "#22C55E" : health >= 50 ? "#F59E0B" : "#EF4444", backgroundColor: (health >= 80 ? "#22C55E" : health >= 50 ? "#F59E0B" : "#EF4444") + "1f" }}>
                  <Activity size={11} strokeWidth={2} /> Health {health}%
                </span>
              )}
            </div>
            <div className="flex items-center gap-x-4 gap-y-1 mt-1.5 flex-wrap text-[12px] text-hq-muted">
              <span className="flex items-center gap-1.5"><User size={11} />Owner: {String(bot.owner_id || "admin")}</span>
              <span className="flex items-center gap-1.5"><Calendar size={11} />{dLeft !== null ? (dLeft >= 0 ? `${dLeft}d left · ` : `expired · `) : ""}{formatDate(bot.valid_till)}</span>
              <span className="flex items-center gap-1.5"><Smartphone size={11} />{bot.sessions_count || 0} sessions</span>
              <span className="flex items-center gap-1.5"><Timer size={11} />Cycle {bot.cycle}s</span>
            </div>
          </div>
          {/* Global actions — the full set lives in the More menu / Actions tab */}
          <div className="flex items-center gap-2 shrink-0">
            <HqBtn tone="secondary" onClick={() => setActiveTab("actions")} icon={Wrench} className="hidden sm:inline-flex">Manage</HqBtn>
            <ActionMenu
              items={[
                bot.running
                  ? { label: "Stop bot", icon: Square, tone: "danger", onClick: () => doAction("stop") }
                  : { label: "Start bot", icon: Play, tone: "success", onClick: () => doAction("start") },
                { label: "Restart bot", icon: RotateCw, onClick: () => doAction("restart") },
                bot.suspended
                  ? { label: "Resume bot", icon: PlayCircle, onClick: () => doAction("resume") }
                  : { label: "Suspend bot", icon: Pause, onClick: () => doAction("suspend") },
                { separator: true },
                { label: "Repair & actions", icon: Wrench, onClick: () => setActiveTab("actions") },
                { label: "Access code", icon: KeyRound, onClick: () => setActiveTab("access") },
                { separator: true },
                { label: "Delete bot", icon: Trash2, tone: "danger", onClick: () => setDeleteConfirm(true) },
              ]}
            />
          </div>
        </div>

        {/* Underline tabs */}
        <div className="flex items-center gap-1 mt-4 -mb-4 overflow-x-auto no-scrollbar">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium transition-all border-b-2 whitespace-nowrap ${
                activeTab === t.id ? "text-hq-text border-hq-accent" : "text-hq-muted border-transparent hover:text-hq-sub hover:border-white/10"
              }`}>
              <t.icon size={14} strokeWidth={1.75} />
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Tab content */}
      <main className="px-4 sm:px-6 py-6">
        {activeTab === "overview" && <OverviewTab name={name} bot={bot} onNavigate={setActiveTab} />}
        {activeTab === "sessions" && <SessionsTab bot={bot} name={name} onUpdate={() => mutate()} />}
        {activeTab === "groups" && <GroupsTab bot={bot} name={name} onUpdate={() => mutate()} />}
        {activeTab === "content" && <PostingTab name={name} bot={bot} onUpdate={() => mutate()} />}
        {activeTab === "logs" && <LogsTab name={name} />}
        {activeTab === "payments" && <PaymentsTab name={name} bot={bot} />}
        {activeTab === "access" && <AccessTab name={name} bot={bot} onUpdate={() => mutate()} />}
        {activeTab === "settings" && <SettingsTab name={name} bot={bot} onUpdate={() => mutate()} />}
        {activeTab === "actions" && <ActionsTab name={name} bot={bot} onUpdate={() => mutate()} onDelete={() => setDeleteConfirm(true)} />}
      </main>

      <ConfirmModal
        open={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        onConfirm={async () => {
          try {
            await api.delete(`/api/bots/${name}`);
            toast.success("Bot deleted");
            router.push("/admin/adbots");
          } catch (e: any) {
            toast.error(e?.response?.data?.detail || "Delete failed");
          }
          setDeleteConfirm(false);
        }}
        title="Delete Bot"
        message={`Permanently delete "${name}"? This will stop the bot, return admin sessions to the free pool, delete user-uploaded sessions, remove custom group files, and erase all bot data/logs/stats. This cannot be undone.`}
        confirmText="Delete"
      />
    </div>
  );
}

/* ─── OVERVIEW ─── */
/* ── Premium dashboard primitives (HQ design system, matched to Figma) ── */
function HqCard({ children, className = "", hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div
      className={`relative rounded-[18px] overflow-hidden transition-all duration-150 ${hover ? "hover:-translate-y-1 hover:shadow-[0_8px_32px_rgba(124,92,255,0.12)]" : ""} ${className}`}
      style={{
        background: "linear-gradient(135deg,#171722 0%,#141420 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {children}
    </div>
  );
}

/* Deterministic avatar gradients (Figma-style session avatars) */
const AVATAR_GRADIENTS = [
  "#7C5CFF,#9B7FFF", "#00D4FF,#0891B2", "#22C55E,#15803D",
  "#F59E0B,#D97706", "#EF4444,#B91C1C", "#8B5CF6,#6D28D9",
];

/* Single source of truth for a bot's headline status → label + colour */
function botStatus(bot: any): { label: string; color: string } {
  if (bot?.suspended) return { label: "Suspended", color: "#F59E0B" };
  if (bot?.frozen) return { label: "Frozen", color: "#EF4444" };
  if (bot?.running) return { label: "Running", color: "#22C55E" };
  return { label: "Stopped", color: "#64748B" };
}

/* Days until a dd/mm/yyyy (or ISO) validity date; null if unparseable */
function daysUntil(valid?: string): number | null {
  try {
    const raw = valid || "";
    const iso = raw.includes("/") ? ddmmyyyyToIso(raw) : raw;
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.ceil((d.getTime() - Date.now()) / 86400000);
  } catch { return null; }
}

/* Pulsing-dot status pill (Figma StatusBadge) */
function HqStatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
      style={{ color, backgroundColor: `${color}1f` }}>
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

const HQ_BTN_TONES: Record<string, string> = {
  primary: "bg-hq-accent hover:brightness-110 text-white shadow-[0_2px_10px_rgba(124,92,255,0.35)]",
  success: "bg-hq-success/10 hover:bg-hq-success/20 text-hq-success border border-hq-success/20",
  danger: "bg-hq-danger/10 hover:bg-hq-danger/20 text-hq-danger border border-hq-danger/20",
  secondary: "bg-hq-elev hover:bg-white/[0.06] text-hq-text border border-hq-border",
  ghost: "bg-transparent hover:bg-hq-hover text-hq-sub border border-hq-border",
};

function HqBtn({ children, onClick, loading, disabled, icon: Icon, tone = "primary", iconOnly = false, className = "", type = "button" }: {
  children?: ReactNode; onClick?: () => void; loading?: boolean; disabled?: boolean; icon?: any;
  tone?: "primary" | "success" | "danger" | "secondary" | "ghost"; iconOnly?: boolean; className?: string; type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[12px] font-medium text-[13px] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${iconOnly ? "w-9 h-9" : "px-3.5 py-2"} ${HQ_BTN_TONES[tone]} ${className}`}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : Icon ? <Icon className="h-4 w-4" strokeWidth={1.75} /> : null}
      {children}
    </button>
  );
}

const HqInput = forwardRef<HTMLInputElement, { label?: string } & InputHTMLAttributes<HTMLInputElement>>(
  ({ label, id, className = "", ...props }, ref) => (
    <div className="space-y-1.5">
      {label && <label htmlFor={id} className="block text-[12px] font-medium text-hq-sub">{label}</label>}
      <input
        ref={ref}
        id={id}
        className={`w-full rounded-[14px] border border-hq-border bg-hq-bg px-3 py-2 text-[13px] text-hq-text placeholder:text-hq-muted focus:outline-none focus:border-hq-accent/60 transition-colors disabled:opacity-60 ${className}`}
        {...props}
      />
    </div>
  )
);
HqInput.displayName = "HqInput";

/* Key/value row used inside hq detail cards */
function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[13px] text-hq-sub">{k}</span>
      <span className="text-[13px] text-hq-text font-medium text-right truncate">{v}</span>
    </div>
  );
}

/* Section title used inside hq cards */
function HqTitle({ children, sub, right }: { children: ReactNode; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h3 className="text-[15px] font-semibold text-hq-text">{children}</h3>
        {sub && <p className="text-[12px] text-hq-muted mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/* Shimmer block + full-page skeleton matching the hq dashboard layout */
function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[10px] bg-white/[0.05] ${className}`} />;
}

function BotDetailSkeleton() {
  return (
    <div className="space-y-5 animate-fade-in" suppressHydrationWarning>
      {/* header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Shimmer className="w-9 h-9 !rounded-[12px]" />
          <div className="space-y-2">
            <Shimmer className="h-5 w-40" />
            <Shimmer className="h-3 w-56" />
          </div>
        </div>
        <div className="hidden sm:flex gap-2">
          {[0, 1, 2].map((i) => <Shimmer key={i} className="h-9 w-20 !rounded-[12px]" />)}
        </div>
      </div>
      {/* tabs */}
      <Shimmer className="h-11 w-full !rounded-[14px]" />
      {/* stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-[18px] border border-hq-border bg-hq-card p-5 space-y-3">
            <Shimmer className="h-3 w-20" />
            <Shimmer className="h-7 w-24" />
            <Shimmer className="h-3 w-16" />
          </div>
        ))}
      </div>
      {/* charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-[18px] border border-hq-border bg-hq-card p-5 lg:col-span-2 space-y-4">
          <Shimmer className="h-4 w-40" />
          <Shimmer className="h-[220px] w-full !rounded-[14px]" />
        </div>
        <div className="rounded-[18px] border border-hq-border bg-hq-card p-5 space-y-4">
          <Shimmer className="h-4 w-28" />
          <Shimmer className="h-[168px] w-full !rounded-full mx-auto max-w-[168px]" />
          <div className="grid grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((i) => <Shimmer key={i} className="h-8" />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, icon: Icon, tone = "accent" }: {
  label: string; value: string | number; sub?: string; icon: any; tone?: "accent" | "success" | "danger" | "warning";
}) {
  const toneMap: Record<string, string> = {
    accent: "text-hq-accent bg-hq-accent/10",
    success: "text-hq-success bg-hq-success/10",
    danger: "text-hq-danger bg-hq-danger/10",
    warning: "text-hq-warning bg-hq-warning/10",
  };
  return (
    <HqCard hover className="p-5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-hq-sub">{label}</span>
        <span className={`w-8 h-8 rounded-[10px] flex items-center justify-center ${toneMap[tone]}`}>
          <Icon className="w-4 h-4" strokeWidth={1.75} />
        </span>
      </div>
      <p className="mt-3 text-[26px] leading-none font-semibold text-hq-text tabular-nums">{value}</p>
      {sub && <p className="mt-2 text-[12px] text-hq-muted">{sub}</p>}
    </HqCard>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-2.5 h-2.5 rounded-[4px]" style={{ background: color }} />
      <div className="min-w-0">
        <p className="text-[11px] text-hq-muted leading-tight">{label}</p>
        <p className="text-[15px] font-semibold text-hq-text tabular-nums leading-tight">{value}</p>
      </div>
    </div>
  );
}

/* ── Missing-value formatter: never render raw undefined/null/empty ── */
function fmt(v: any, fallback = "Not set"): string {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" || s === "undefined" || s === "null" ? fallback : s;
}
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/* Compact metric card — read-only headline number + one line of context */
function MetricCard({ label, value, sub, icon: Icon, tone = "accent" }: {
  label: string; value: string | number; sub?: ReactNode; icon: any; tone?: "accent" | "success" | "danger" | "warning";
}) {
  const toneMap: Record<string, string> = {
    accent: "text-hq-accent bg-hq-accent/10",
    success: "text-hq-success bg-hq-success/10",
    danger: "text-hq-danger bg-hq-danger/10",
    warning: "text-hq-warning bg-hq-warning/10",
  };
  return (
    <div className="rounded-[16px] border border-hq-border bg-hq-card p-4 transition-colors hover:border-white/[0.12]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-hq-muted">{label}</span>
        <span className={`w-7 h-7 rounded-[9px] flex items-center justify-center ${toneMap[tone]}`}>
          <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
        </span>
      </div>
      <p className="mt-2.5 text-[24px] leading-none font-semibold text-hq-text tabular-nums">{value}</p>
      {sub && <p className="mt-1.5 text-[12px] text-hq-muted truncate">{sub}</p>}
    </div>
  );
}

/* Small label:value operational chip for the health strip */
function HealthChip({ label, value, tone = "muted", pulse = false }: {
  label: string; value: string; tone?: "success" | "danger" | "warning" | "muted" | "info"; pulse?: boolean;
}) {
  const map: Record<string, string> = {
    success: "#22C55E", danger: "#EF4444", warning: "#F59E0B", info: "#38BDF8", muted: "#667085",
  };
  const c = map[tone];
  return (
    <span className="inline-flex items-center gap-2 rounded-[10px] border border-hq-border bg-hq-elev px-2.5 py-1.5 text-[12px]">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c, animation: pulse ? "pulse 2s infinite" : "none" }} />
      <span className="text-hq-muted">{label}</span>
      <span className="font-medium" style={{ color: tone === "muted" ? "#98A2B3" : c }}>{value}</span>
    </span>
  );
}

/* Thin health bar */
function HealthBar({ pct }: { pct: number | null }) {
  const col = pct === null ? "#667085" : pct >= 80 ? "#22C55E" : pct >= 50 ? "#F59E0B" : "#EF4444";
  return (
    <div className="h-1.5 w-full rounded-full bg-hq-bg overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct ?? 0}%`, background: col }} />
    </div>
  );
}

/* 2-column definition grid (single column on mobile) */
function DetailGrid({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
      {rows.map(([k, v], i) => (
        <div key={k} className={`flex items-center justify-between gap-3 py-2.5 ${i < rows.length - (rows.length % 2 === 0 ? 2 : 1) ? "border-b border-hq-border/50" : ""}`}>
          <span className="text-[12px] text-hq-muted shrink-0">{k}</span>
          <span className="text-[13px] text-hq-text font-medium text-right truncate min-w-0">{v}</span>
        </div>
      ))}
    </div>
  );
}

/* Empty state */
function EmptyState({ icon: Icon = AlertCircle, title, hint }: { icon?: any; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <span className="w-10 h-10 rounded-[12px] bg-hq-elev border border-hq-border flex items-center justify-center mb-3">
        <Icon className="w-5 h-5 text-hq-muted" strokeWidth={1.75} />
      </span>
      <p className="text-[13px] text-hq-sub font-medium">{title}</p>
      {hint && <p className="text-[12px] text-hq-muted mt-1">{hint}</p>}
    </div>
  );
}

/* Kebab dropdown for global bot actions (closes on outside click / Escape) */
type MenuItem = { label: string; icon?: any; tone?: "danger" | "success" | "default"; onClick: () => void; separator?: undefined } | { separator: true };
function ActionMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} title="More actions"
        className={`w-9 h-9 rounded-[12px] border flex items-center justify-center transition-colors ${open ? "border-hq-accent/40 bg-hq-accent/10 text-hq-text" : "border-hq-border bg-hq-card text-hq-sub hover:text-hq-text hover:bg-hq-elev"}`}>
        <MoreVertical className="h-4.5 w-4.5" strokeWidth={1.75} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-52 rounded-[14px] border border-hq-border bg-hq-card p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)] animate-fade-in">
          {items.map((it, i) => it.separator ? (
            <div key={i} className="my-1 h-px bg-hq-border/70" />
          ) : (
            <button key={i} onClick={() => { setOpen(false); it.onClick(); }}
              className={`w-full flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] text-left transition-colors ${
                it.tone === "danger" ? "text-hq-danger hover:bg-hq-danger/10" : it.tone === "success" ? "text-hq-success hover:bg-hq-success/10" : "text-hq-sub hover:text-hq-text hover:bg-hq-elev"
              }`}>
              {it.icon && <it.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── OVERVIEW (read-only) ─── */
function OverviewTab({ name, bot, onNavigate }: { name: string; bot: any; onNavigate: (tab: string) => void }) {
  const [range, setRange] = useState<TimeRange>("7d");
  const analytics = useAdbotAnalytics(name, range, bot);

  const botToken = bot.bot_username ? "Connected" : "Not configured";
  const details: [string, ReactNode][] = [
    ["Mode", cap(fmt(bot.mode))],
    ["Plan", fmt(bot.plan_name)],
    ["Owner", fmt(bot.owner_id, "Admin")],
    ["Group file", fmt(bot.group_file, "Not configured")],
    ["Created", bot.created_at ? formatDate(bot.created_at) : "Not tracked"],
    ["Valid until", bot.valid_till ? formatDate(bot.valid_till) : "Not set"],
    ["Bot token", <span className={bot.bot_username ? "text-hq-success" : "text-hq-warning"}>{botToken}{bot.bot_username ? ` · @${bot.bot_username}` : ""}</span>],
    ["Log group", bot.log_group
      ? <a href={bot.log_group} target="_blank" rel="noreferrer" className="text-hq-accent hover:underline inline-flex items-center gap-1 justify-end">Open <ExternalLink className="w-3 h-3" /></a>
      : "Not set"],
  ];

  const systemRows: [string, ReactNode][] = [
    ["Posting", <span className={bot.running ? "text-hq-success" : "text-hq-muted"}>{bot.running ? "Running" : "Stopped"}</span>],
    ["Active sessions", analytics.sessions.filter(s => s.status === "active").length],
    ["Dead sessions", <span className={analytics.sessions.filter(s => s.status === "dead").length > 0 ? "text-hq-danger" : ""}>{analytics.sessions.filter(s => s.status === "dead").length}</span>],
  ];

  return (
    <div className="space-y-4">
      {/* 1. Full-width main activity chart */}
      <PostingActivityChart 
        timeline={analytics.timeline} 
        range={range} 
        onRangeChange={setRange} 
      />

      {/* 2. Split view: 60% Session perf, 40% Delivery + Failures */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        <div className="lg:col-span-3 w-full min-w-0">
          <SessionPerformanceChart 
            sessions={analytics.sessions} 
            onViewAll={() => onNavigate("sessions")} 
          />
        </div>
        <div className="lg:col-span-2 w-full flex flex-col gap-4 min-w-0">
          <DeliveryBreakdownCard delivery={analytics.delivery} />
          <FailureReasonsChart reasons={analytics.failureReasons} />
        </div>
      </div>

      <CycleTimingCard cycle={analytics.cycle} />

      {/* Details + System state */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        <HqCard className="p-5 lg:col-span-2">
          <h3 className="text-[15px] font-semibold text-hq-text mb-2">Details</h3>
          <DetailGrid rows={details} />
        </HqCard>
        <HqCard className="p-5">
          <h3 className="text-[15px] font-semibold text-hq-text mb-2">System state</h3>
          <div>
            {systemRows.map(([k, v], i) => (
              <div key={k} className={`flex items-center justify-between gap-3 py-2.5 ${i < systemRows.length - 1 ? "border-b border-hq-border/50" : ""}`}>
                <span className="text-[12px] text-hq-muted">{k}</span>
                <span className="text-[13px] text-hq-text font-medium tabular-nums text-right truncate">{v}</span>
              </div>
            ))}
          </div>
        </HqCard>
      </div>
    </div>
  );
}

/* ─── ACCESS (web access code + login history) ─── */
function AccessTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const [showToken, setShowToken] = useState(false);
  const [customToken, setCustomToken] = useState("");
  const [editToken, setEditToken] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);

  const lastLogin = bot.last_web_login;
  const loginHistory: any[] = bot.web_login_history || [];

  const resetToken = async (custom?: string) => {
    setTokenLoading(true);
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/web-access/set-token`, { web_token: custom || null });
      toast.success(`Access code ${custom ? "set" : "regenerated"}: ${data.web_token}`);
      setEditToken(false);
      setCustomToken("");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
    setTokenLoading(false);
  };

  const formatTs = (ts: string | number) => {
    if (!ts) return "—";
    if (typeof ts === "string") return ts;
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <div className="space-y-4">
      <HqCard className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-4 w-4 text-hq-sub" strokeWidth={1.75} />
          <h3 className="text-[15px] font-semibold text-hq-text">Web access</h3>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[13px] text-hq-sub w-24 shrink-0">Access code</span>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <code className="rounded-[10px] bg-hq-elev border border-hq-border px-3 py-1.5 text-[13px] font-mono text-hq-accent select-all">
                {showToken ? (bot.web_token || "not set") : "••••••••"}
              </code>
              <button onClick={() => setShowToken(!showToken)} className="text-hq-muted hover:text-hq-sub p-1">
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => { navigator.clipboard.writeText(bot.web_token || ""); toast.success("Copied"); }} className="text-hq-muted hover:text-hq-sub p-1">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <HqBtn tone="secondary" onClick={() => resetToken()} loading={tokenLoading && !editToken} icon={RefreshCw}>Regenerate</HqBtn>
            <HqBtn tone="ghost" onClick={() => setEditToken(!editToken)} icon={Edit}>Set custom</HqBtn>
          </div>

          {editToken && (
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-[14px] border border-hq-border bg-hq-bg px-3 py-2 text-[13px] text-hq-text font-mono focus:outline-none focus:border-hq-accent/60"
                placeholder="Enter custom code (4-32 chars)"
                value={customToken}
                onChange={(e) => setCustomToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && customToken.trim() && resetToken(customToken.trim())}
              />
              <HqBtn onClick={() => resetToken(customToken.trim())} loading={tokenLoading} disabled={!customToken.trim()} icon={Save}>Set</HqBtn>
            </div>
          )}
        </div>
      </HqCard>

      <HqCard className="p-5">
        <h3 className="text-[15px] font-semibold text-hq-text mb-4">Login history</h3>
        <div className="mb-4 rounded-[12px] bg-hq-elev border border-hq-border px-3.5 py-3">
          <p className="text-[11px] text-hq-muted font-medium uppercase tracking-wider mb-1.5">Last login</p>
          {lastLogin ? (
            <div className="flex items-center gap-4 flex-wrap text-[13px]">
              <span className="inline-flex items-center gap-2 text-hq-sub"><Clock className="h-3.5 w-3.5 text-hq-muted" />{formatTs(lastLogin.ts || lastLogin.time)}</span>
              {lastLogin.ip && <span className="inline-flex items-center gap-2 text-hq-sub"><Globe className="h-3.5 w-3.5 text-hq-muted" /><span className="font-mono text-xs">{lastLogin.ip}</span></span>}
            </div>
          ) : (
            <p className="text-[13px] text-hq-muted">Never logged in</p>
          )}
        </div>
        {loginHistory.length === 0 ? (
          <EmptyState icon={Globe} title="No login history yet" />
        ) : (
          <div className="rounded-[12px] bg-hq-bg border border-hq-border divide-y divide-hq-border/50 max-h-72 overflow-y-auto">
            {[...loginHistory].reverse().map((h: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-[12px] px-3.5 py-2.5">
                <Clock className="h-3.5 w-3.5 text-hq-muted shrink-0" />
                <span className="text-hq-sub w-44 shrink-0">{formatTs(h.ts || h.time)}</span>
                <span className="font-mono text-hq-muted truncate">{h.ip}</span>
              </div>
            ))}
          </div>
        )}
      </HqCard>
    </div>
  );
}

/* ─── PAYMENTS (plan, pricing, renewal history) ─── */
function PaymentsTab({ name, bot }: { name: string; bot: any }) {
  const plan = bot.plan || {};
  const daysLeft = daysUntil(bot.valid_till);
  const expired = daysLeft !== null && daysLeft < 0;
  const price = plan.price_month ?? plan.price_week ?? null;

  // history may be a dict { renewals: [...] } or absent
  const renewals: any[] = Array.isArray(bot.history?.renewals) ? bot.history.renewals
    : Array.isArray(bot.renewal_history) ? bot.renewal_history : [];

  const rows: [string, ReactNode][] = [
    ["Plan", fmt(bot.plan_name)],
    ["Mode", cap(fmt(bot.mode))],
    ["Sessions", fmt(plan.sessions ?? bot.sessions_count)],
    ["Cycle", (plan.cycle ?? bot.cycle) != null ? `${plan.cycle ?? bot.cycle}s` : "Not set"],
    ["Gap", (plan.gap ?? bot.gap) != null ? `${plan.gap ?? bot.gap}s` : "Not set"],
    ["Monthly price", price != null && price !== "" ? formatUSD(Number(price)) : "Not set"],
    ["Free replacements", fmt(plan.free_replacements, "Not set")],
    ["Created", bot.created_at ? formatDate(bot.created_at) : "Not tracked"],
  ];

  return (
    <div className="space-y-4">
      {/* Subscription status banner */}
      <HqCard className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold text-hq-text">{fmt(bot.plan_name, "No plan")}</h3>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${expired ? "text-hq-danger bg-hq-danger/10" : "text-hq-success bg-hq-success/10"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${expired ? "bg-hq-danger" : "bg-hq-success"}`} />
                {expired ? "Expired" : "Active"}
              </span>
            </div>
            <p className="text-[12px] text-hq-muted mt-1.5">
              {bot.valid_till
                ? (expired ? `Expired ${formatDate(bot.valid_till)}` : `${Math.max(daysLeft ?? 0, 0)} days left · renews ${formatDate(bot.valid_till)}`)
                : "No validity date set"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[24px] font-semibold text-hq-text tabular-nums leading-none">{price != null && price !== "" ? formatUSD(Number(price)) : "—"}</p>
            <p className="text-[11px] text-hq-muted mt-1.5">per month</p>
          </div>
        </div>
      </HqCard>

      <HqCard className="p-5">
        <h3 className="text-[15px] font-semibold text-hq-text mb-2">Subscription details</h3>
        <DetailGrid rows={rows} />
      </HqCard>

      <HqCard className="p-5">
        <h3 className="text-[15px] font-semibold text-hq-text mb-4">Renewal history</h3>
        {renewals.length === 0 ? (
          <EmptyState icon={CreditCard} title="No renewal history" hint="Renewals and orders appear here once recorded." />
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[13px] min-w-[420px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-hq-muted border-b border-hq-border">
                  {["Date", "Days added", "Order ID", "Source"].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-hq-border/50">
                {[...renewals].reverse().map((r: any, i: number) => (
                  <tr key={i}>
                    <td className="px-2 py-2.5 text-hq-sub">{r.at ? formatDate(r.at) : "—"}</td>
                    <td className="px-2 py-2.5 tabular-nums text-hq-text">{r.days ? `+${r.days}d` : "—"}</td>
                    <td className="px-2 py-2.5 font-mono text-[12px] text-hq-muted">{fmt(r.order_id, "—")}</td>
                    <td className="px-2 py-2.5 text-hq-muted">{fmt(r.source, "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HqCard>
    </div>
  );
}

/* ─── ACTIONS (bot control + repair + danger zone) ─── */
function ActionsTab({ name, bot, onUpdate, onDelete }: { name: string; bot: any; onUpdate: () => void; onDelete: () => void }) {
  const [busy, setBusy] = useState("");

  const control = async (action: string, label: string) => {
    setBusy(action);
    try {
      await api.post(`/api/bots/${encodeURIComponent(name)}/${action}`);
      toast.success(`${label} — done`);
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `${label} failed`);
    }
    setBusy("");
  };

  const controls = bot.running
    ? [
        { id: "stop", label: "Stop", icon: Square, tone: "danger" as const },
        { id: "restart", label: "Restart", icon: RotateCw, tone: "secondary" as const },
      ]
    : [{ id: "start", label: "Start", icon: Play, tone: "primary" as const }];

  return (
    <div className="space-y-4">
      {/* Bot control */}
      <HqCard className="p-5">
        <HqTitle sub="Runtime state — takes effect immediately">Bot control</HqTitle>
        <div className="flex flex-wrap gap-2">
          {controls.map((c) => (
            <HqBtn key={c.id} tone={c.tone} icon={c.icon} loading={busy === c.id} disabled={!!busy} onClick={() => control(c.id, c.label)}>{c.label}</HqBtn>
          ))}
          {bot.suspended
            ? <HqBtn tone="secondary" icon={PlayCircle} loading={busy === "resume"} disabled={!!busy} onClick={() => control("resume", "Resume")}>Resume</HqBtn>
            : <HqBtn tone="secondary" icon={Pause} loading={busy === "suspend"} disabled={!!busy} onClick={() => control("suspend", "Suspend")}>Suspend</HqBtn>}
        </div>
      </HqCard>

      {/* Repair */}
      <RepairTab name={name} bot={bot} onUpdate={onUpdate} />

      {/* Danger zone */}
      <div className="rounded-[16px] border border-hq-danger/25 bg-hq-danger/[0.04] p-5">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="h-4 w-4 text-hq-danger" strokeWidth={1.75} />
          <h3 className="text-[15px] font-semibold text-hq-danger">Danger zone</h3>
        </div>
        <p className="text-[12px] text-hq-muted mb-4">Irreversible. Deleting stops the bot, returns admin sessions to the free pool, and erases all data, logs and stats.</p>
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-hq-danger/20 bg-hq-card px-4 py-3 flex-wrap">
          <div>
            <p className="text-[13px] font-medium text-hq-text">Delete this AdBot</p>
            <p className="text-[12px] text-hq-muted">Permanently remove &quot;{name}&quot;.</p>
          </div>
          <HqBtn tone="danger" icon={Trash2} onClick={onDelete}>Delete bot</HqBtn>
        </div>
      </div>
    </div>
  );
}

/* ─── POSTING / MESSAGE ─── */
/* Render Telegram-supported HTML into a safe preview (escape everything, then
   re-enable only the allowed tags). Prevents arbitrary HTML injection. */
function telegramPreviewHtml(raw: string): string {
  let h = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  h = h.replace(/&lt;(\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote))&gt;/gi, "<$1>");
  h = h.replace(/&lt;a href="([^"<>]*)"&gt;/gi, '<a href="$1" class="text-hq-accent2 underline">').replace(/&lt;\/a&gt;/gi, "</a>");
  return h.replace(/\n/g, "<br/>");
}

const TG_TAGS: { tag: string; label: string; icon: any; wrap: [string, string] }[] = [
  { tag: "b", label: "Bold", icon: Bold, wrap: ["<b>", "</b>"] },
  { tag: "i", label: "Italic", icon: Italic, wrap: ["<i>", "</i>"] },
  { tag: "u", label: "Underline", icon: Underline, wrap: ["<u>", "</u>"] },
  { tag: "s", label: "Strike", icon: Strikethrough, wrap: ["<s>", "</s>"] },
  { tag: "code", label: "Code", icon: Code, wrap: ["<code>", "</code>"] },
  { tag: "a", label: "Link", icon: Link2, wrap: ['<a href="https://">', "</a>"] },
];

function PostingTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const [message, setMessage] = useState(bot.message || "");
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const dirty = message !== (bot.message || "");

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/bots/${name}`, { message });
      toast.success("Post message updated");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to update message");
    }
    setSaving(false);
  };

  const applyWrap = (open: string, close: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    const sel = message.slice(start, end) || "text";
    const next = message.slice(0, start) + open + sel + close + message.slice(end);
    setMessage(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = start + open.length;
      ta.selectionEnd = start + open.length + sel.length;
    });
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Editor */}
        <HqCard className="p-5">
          <HqTitle sub="Posted to every group each cycle">Post Message / Link</HqTitle>
          {/* Formatting toolbar */}
          <div className="flex items-center gap-1 mb-3 p-1 rounded-[12px] border border-hq-border bg-hq-bg w-fit">
            {TG_TAGS.map((t) => (
              <button key={t.tag} type="button" title={t.label} onClick={() => applyWrap(t.wrap[0], t.wrap[1])}
                className="w-8 h-8 rounded-[8px] flex items-center justify-center text-hq-sub hover:text-hq-text hover:bg-hq-hover transition-colors">
                <t.icon className="h-4 w-4" strokeWidth={1.75} />
              </button>
            ))}
          </div>
          <textarea
            ref={taRef}
            className="w-full h-56 rounded-[14px] border border-hq-border bg-hq-bg px-4 py-3 text-[13px] text-hq-text font-mono placeholder:text-hq-muted focus:outline-none focus:border-hq-accent/60 resize-none transition-colors"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter post message or link… e.g. <b>Bold</b> and <a href=&quot;https://t.me&quot;>link</a>"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-hq-muted tabular-nums">{message.length} chars{message.length > 4096 && <span className="text-hq-danger"> · over Telegram's 4096 limit</span>}</span>
            <div className="flex items-center gap-2">
              <HqBtn tone="ghost" onClick={() => { navigator.clipboard.writeText(message); toast.success("Copied"); }} icon={Copy}>Copy</HqBtn>
              <HqBtn onClick={handleSave} loading={saving} icon={Save} disabled={!dirty}>Save</HqBtn>
            </div>
          </div>
        </HqCard>

        {/* Live preview */}
        <HqCard className="p-5">
          <HqTitle sub="How it renders in Telegram">Live Preview</HqTitle>
          <div className="rounded-[14px] bg-hq-bg border border-hq-border p-4 min-h-[224px]">
            {message.trim() ? (
              <div className="max-w-[85%] rounded-[14px] rounded-tl-sm px-3.5 py-2.5 text-[13px] text-hq-text leading-relaxed break-words"
                style={{ background: "linear-gradient(135deg,#7C5CFF22,#00D4FF14)", border: "1px solid rgba(255,255,255,0.06)" }}
                dangerouslySetInnerHTML={{ __html: telegramPreviewHtml(message) }} />
            ) : (
              <div className="h-full flex items-center justify-center text-[13px] text-hq-muted italic py-16">No message set</div>
            )}
          </div>
        </HqCard>
      </div>

      {/* Telegram formatting helper */}
      <HqCard className="p-5">
        <HqTitle sub="Supported Telegram HTML tags">Formatting Helper</HqTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            ["<b>bold</b>", "Bold"], ["<i>italic</i>", "Italic"], ["<u>underline</u>", "Underline"],
            ["<s>strike</s>", "Strikethrough"], ["<code>mono</code>", "Monospace"], ['<a href="url">link</a>', "Hyperlink"],
          ].map(([code, label]) => (
            <div key={label} className="rounded-[12px] border border-hq-border bg-hq-bg px-3 py-2">
              <p className="text-[12px] font-medium text-hq-text">{label}</p>
              <code className="text-[11px] text-hq-accent2 font-mono break-all">{code}</code>
            </div>
          ))}
        </div>
      </HqCard>
    </div>
  );
}

/* ─── STATS ─── */
function StatsTab({ name }: { name: string }) {
  const { data: stats, isLoading } = useAdbotStats(name);

  if (isLoading) return <BotDetailSkeleton />;
  if (!stats) return <HqCard className="p-5"><p className="text-hq-muted text-[13px]">No stats available</p></HqCard>;

  const sessions = stats.session_stats || {};
  const totalSent = stats.lifetime_sent || 0;
  const totalFailed = stats.lifetime_failed || 0;
  const overallRate = totalSent + totalFailed > 0 ? Math.round((totalSent / (totalSent + totalFailed)) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Totals */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile icon={CheckCircle2} label="Total Sent" value={totalSent.toLocaleString()} tone="success" />
        <StatTile icon={XCircle} label="Total Failed" value={totalFailed.toLocaleString()} tone="danger" />
        <StatTile icon={RotateCw} label="Cycles" value={(stats.cycles || 0).toLocaleString()} tone="accent" />
        <StatTile icon={TrendingUp} label="Success Rate" value={`${overallRate}%`} tone={overallRate > 80 ? "success" : "warning"} sub={`${Object.keys(sessions).length} sessions`} />
      </div>

      {/* Per-session stats */}
      <HqCard className="p-5">
        <HqTitle sub="Delivery breakdown per account">Per-Session Stats</HqTitle>
        {Object.keys(sessions).length === 0 ? (
          <div className="py-10 text-center text-[13px] text-hq-muted">No session stats recorded yet</div>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[13px] min-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-hq-muted border-b border-hq-border">
                  {["Session", "Sent", "Failed", "Rate", "Cycles", "Avg", "Last Cycle", "Best"].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hq-border/60">
                {Object.entries(sessions).map(([sess, s]: [string, any]) => {
                  const sent = s.lifetime_sent || s.sent || 0;
                  const failed = s.lifetime_failed || s.failed || 0;
                  const total = sent + failed;
                  const rate = total > 0 ? ((sent) / total * 100).toFixed(1) : "—";
                  const cycles = s.cycles || 0;
                  const avgDur = s.avg_cycle_duration_sec || 0;
                  const lastSuccess = s.last_cycle_success || 0;
                  const lastAttempted = s.last_cycle_attempted || 0;
                  const lastDur = s.last_cycle_duration_sec || 0;
                  const lastTs = s.last_cycle_ts || 0;
                  const bestSuccess = s.best_cycle_success || 0;
                  return (
                    <tr key={sess} className="hover:bg-hq-hover transition-colors">
                      <td className="px-3 py-2.5 font-mono text-[12px] text-hq-sub">{sess.replace(".session", "")}</td>
                      <td className="px-3 py-2.5 text-hq-success font-medium tabular-nums">{sent}</td>
                      <td className="px-3 py-2.5 text-hq-danger font-medium tabular-nums">{failed}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        <span className={Number(rate) > 80 ? "text-hq-success" : Number(rate) > 50 ? "text-hq-warning" : "text-hq-danger"}>
                          {rate}{rate !== "—" ? "%" : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-hq-accent font-medium tabular-nums">{cycles}</td>
                      <td className="px-3 py-2.5 text-[12px] text-hq-sub">{avgDur > 0 ? `${Math.round(avgDur)}s` : "—"}</td>
                      <td className="px-3 py-2.5 text-[12px]">
                        {lastTs > 0 ? (
                          <span className="text-hq-sub" title={new Date(lastTs * 1000).toLocaleString()}>{lastSuccess}/{lastAttempted} in {Math.round(lastDur)}s</span>
                        ) : <span className="text-hq-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-hq-accent">{bestSuccess > 0 ? `${bestSuccess} sent` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </HqCard>
    </div>
  );
}

/* ─── SESSIONS (deep) ─── */
/* Real operational status → label + colour. No fabricated "health" scores. */
const SESSION_STATUS: Record<string, { label: string; color: string }> = {
  running:   { label: "Running",   color: "#22C55E" },
  disabled:  { label: "Disabled",  color: "#F59E0B" },
  paused:    { label: "Paused",    color: "#64748B" },
  floodwait: { label: "FloodWait", color: "#F97316" },
  dead:      { label: "Dead",      color: "#EF4444" },
  stopped:   { label: "Stopped",   color: "#64748B" },
  unknown:   { label: "Unknown",   color: "#64748B" },
};

function SessionStatusChip({ status }: { status: string }) {
  const meta = SESSION_STATUS[status] || SESSION_STATUS.unknown;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0"
      style={{ color: meta.color, backgroundColor: `${meta.color}1f` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </span>
  );
}

/* Deterministic avatar colour from the session file (stable, not random). */
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

/* Compact copy-to-clipboard button. */
function CopyBtn({ text }: { text: string }) {
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); toast.success("Copied"); }}
      className="text-hq-muted hover:text-hq-text p-0.5 shrink-0" title="Copy">
      <Copy className="h-3 w-3" />
    </button>
  );
}

function MetricPill({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-[10px] px-2 py-1.5 text-center min-w-0" style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="text-[12px] font-semibold tabular-nums truncate" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="text-[10px] text-hq-muted mt-0.5">{label}</div>
    </div>
  );
}

/* Relative time from a unix seconds timestamp; "Never" when absent. */
function relTime(ts?: number | null): string {
  if (!ts) return "Never";
  const secs = Math.floor(Date.now() / 1000 - ts);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function SessionsTab({ bot, name, onUpdate }: { bot: any; name: string; onUpdate: () => void }) {
  const [selected, setSelected] = useState<any>(null);
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState({ first_name: "", last_name: "", bio: "", username: "" });
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [showReplace, setShowReplace] = useState<string>("");
  const [freeSessions, setFreeSessions] = useState<string[]>([]);
  const [loadingFree, setLoadingFree] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [freeFilter, setFreeFilter] = useState("");
  const [bulkAction, setBulkAction] = useState<"" | "validating" | "spambot" | "info">("");
  const [bulkResult, setBulkResult] = useState<any>(null);
  const [spambotResults, setSpambotResults] = useState<Record<string, string>>({});

  // Real, backend-backed session view (no mock data, no live Telethon on load).
  const [range, setRange] = useState<"1h" | "6h" | "24h" | "7d" | "all">("24h");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [logsFor, setLogsFor] = useState<string>("");
  const { data: overview, isLoading: ovLoading, error: ovError, mutate: reloadOverview } =
    useSessionsOverview(name, range);

  // Action handlers refresh the real overview (and the parent bot detail via onUpdate).
  const fetchDetails = async () => { await reloadOverview(); };

  const runValidateAll = async () => {
    setBulkAction("validating");
    setBulkResult(null);
    setSpambotResults({});
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/validate-all`);
      setBulkResult({ type: "validate", active: data.active, dead: data.dead, dead_removed: data.dead_removed });
      reloadOverview();
      onUpdate();
      if (data.dead > 0) {
        toast.error(`${data.dead} dead session(s) removed`);
      } else {
        toast.success(`All ${data.active} session(s) are valid`);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Validation failed");
    }
    setBulkAction("");
  };

  const runSpambotCheck = async () => {
    setBulkAction("spambot");
    setBulkResult(null);
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/spambot-check`);
      const map: Record<string, string> = {};
      for (const s of data.sessions) map[s.file] = s.spambot_status;
      setSpambotResults(map);
      reloadOverview();
      const movedCount = (data.moved_limited?.length || 0) + (data.moved_frozen?.length || 0);
      setBulkResult({
        type: "spambot", active: data.active, limited: data.limited,
        frozen: data.frozen || 0, total: data.total,
        moved_limited: data.moved_limited || [], moved_frozen: data.moved_frozen || [],
      });
      if (movedCount > 0) {
        toast.error(`${movedCount} session(s) moved to limited/frozen pool`);
      } else if (data.limited > 0 || (data.frozen || 0) > 0) {
        toast.error(`${data.limited + (data.frozen || 0)} session(s) are spam-limited/frozen`);
      } else {
        toast.success(`All ${data.active} session(s) clean — no spam limits`);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "SpamBot check failed");
    }
    setBulkAction("");
  };

  const fetchFreeSessions = async () => {
    setLoadingFree(true);
    try {
      const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/sessions/available`);
      setFreeSessions(data.sessions || []);
    } catch { setFreeSessions([]); }
    setLoadingFree(false);
  };

  const openEdit = (s: any) => {
    const parts = (s.display_name || s.real_name || "").split(" ");
    setEditData({
      first_name: parts[0] || "",
      last_name: parts.slice(1).join(" ") || "",
      bio: s.bio || "",
      username: s.username || "",
    });
    setSelected(s);
    setEditMode(true);
  };

  const saveProfile = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const { data } = await api.patch(
        `/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(selected.file)}/profile`,
        editData
      );
      toast.success(`Profile updated: ${data.changes?.join(", ") || "done"}`);
      setEditMode(false);
      setSelected(null);
      fetchDetails();
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to update profile");
    }
    setSaving(false);
  };

  const validateSession = async (file: string) => {
    setValidating(file);
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(file)}/validate`);
      if (data.status === "valid") {
        toast.success(`${file}: Valid ✓`);
      } else {
        toast.error(`${file}: ${data.reason}`);
        onUpdate();
      }
      fetchDetails();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Validation failed");
    }
    setValidating("");
  };

  const removeSession = async (file: string) => {
    if (!confirm(`Remove ${file} from ${name}? It will return to the free pool.`)) return;
    setActionLoading(file);
    try {
      await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(file)}/remove`);
      toast.success(`${file} removed`);
      fetchDetails();
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Remove failed");
    }
    setActionLoading("");
  };

  const toggleSession = async (file: string, currentlyDisabled: boolean) => {
    if (!currentlyDisabled && !confirm(`Disable ${file}?\n\nIt will stop being used in ads until you enable it again. The other accounts keep running.`)) return;
    const action = currentlyDisabled ? "enable" : "disable";
    setActionLoading(file);
    try {
      await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(file)}/${action}`);
      toast.success(currentlyDisabled ? `${file} enabled` : `${file} disabled`);
      onUpdate();
      fetchDetails();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `${action} failed`);
    }
    setActionLoading("");
  };

  const addSession = async (file: string) => {
    setActionLoading(file);
    try {
      await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/add`, { session_file: file });
      toast.success(`${file} added`);
      setShowAdd(false);
      fetchDetails();
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Add failed");
    }
    setActionLoading("");
  };

  const replaceSession = async (oldFile: string, newFile: string) => {
    setActionLoading(newFile);
    try {
      await api.post(
        `/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(oldFile)}/replace`,
        { new_session_file: newFile }
      );
      toast.success(`Replaced ${oldFile} → ${newFile}`);
      setShowReplace("");
      fetchDetails();
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Replace failed");
    }
    setActionLoading("");
  };

  // ── Real data from the overview endpoint ──
  const summary = overview?.summary;
  const allSessions = overview?.sessions || [];
  const filteredSessions = allSessions.filter((s) => {
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      (s.display_name || "").toLowerCase().includes(q) ||
      String(s.telegram_user_id || "").includes(q) ||
      (s.file || "").toLowerCase().includes(q)
    );
  });
  const deadFiles = allSessions.filter((s) => s.status === "dead").map((s) => s.file);

  const RANGES: Array<typeof range> = ["1h", "6h", "24h", "7d", "all"];
  const rangeLabel = (r: string) => (r === "all" ? "All time" : r);

  const spambotBadge = (status: string) => {
    const map: Record<string, [string, string]> = {
      ACTIVE: ["bg-hq-success/10 text-hq-success", "Clean"],
      TEMP_LIMITED: ["bg-hq-warning/10 text-hq-warning", "Temp Limited"],
      HARD_LIMITED: ["bg-hq-danger/10 text-hq-danger", "Hard Limited"],
      FROZEN: ["bg-hq-danger/10 text-hq-danger", "Frozen"],
    };
    const [cls, label] = map[status] || ["bg-white/[0.05] text-hq-muted", "Unknown"];
    return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
  };

  const PoolPicker = ({ onPick, actionIcon: ActionIcon, actionLabel }: { onPick: (f: string) => void; actionIcon: any; actionLabel: string }) => (
    loadingFree ? (
      <div className="flex items-center gap-2 py-8 justify-center text-hq-muted text-[13px]"><Loader2 className="h-5 w-5 animate-spin" /> Loading free sessions…</div>
    ) : freeSessions.length === 0 ? (
      <p className="text-[13px] text-hq-muted text-center py-8">No sessions available in the free pool</p>
    ) : (
      <>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-hq-muted" />
          <input className="w-full rounded-[12px] border border-hq-border bg-hq-bg pl-9 pr-3 py-2 text-[13px] text-hq-text placeholder:text-hq-muted focus:outline-none focus:border-hq-accent/60"
            placeholder="Filter sessions…" value={freeFilter} onChange={(e) => setFreeFilter(e.target.value)} />
        </div>
        <p className="text-[12px] text-hq-muted">{freeSessions.length} sessions available</p>
        <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
          {freeSessions.filter(f => !freeFilter || f.includes(freeFilter)).map((f) => (
            <div key={f} className="flex items-center justify-between rounded-[12px] bg-hq-elev border border-hq-border px-3 py-2">
              <span className="text-[12px] font-mono text-hq-sub truncate">{f}</span>
              <HqBtn tone="secondary" onClick={() => onPick(f)} loading={actionLoading === f} icon={ActionIcon} className="!py-1.5 !text-[12px] shrink-0">{actionLabel}</HqBtn>
            </div>
          ))}
        </div>
      </>
    )
  );

  return (
    <div className="space-y-4">
      {/* Summary tiles — real counts from the backend */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {[
          { label: "Total", value: summary?.total ?? "—", color: undefined },
          { label: "Active", value: summary?.active ?? "—", color: "#22C55E" },
          { label: "Disabled", value: summary?.disabled ?? "—", color: "#F59E0B" },
          { label: "Dead", value: summary?.dead ?? "—", color: "#EF4444" },
          { label: `Sent · ${rangeLabel(range)}`, value: summary?.sent ?? "—", color: "#22C55E" },
          { label: `Failed · ${rangeLabel(range)}`, value: summary?.failed ?? "—", color: "#EF4444" },
        ].map((t) => (
          <HqCard key={t.label} className="px-3 py-2.5">
            <div className="text-[20px] leading-none font-semibold tabular-nums" style={t.color ? { color: t.color } : undefined}>
              {typeof t.value === "number" ? t.value.toLocaleString() : t.value}
            </div>
            <div className="text-[11px] text-hq-muted mt-1 truncate">{t.label}</div>
          </HqCard>
        ))}
      </div>

      {/* Filter / search / actions row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-hq-muted" />
          <input
            className="w-full rounded-[12px] border border-hq-border bg-hq-bg pl-9 pr-3 py-2 text-[13px] text-hq-text placeholder:text-hq-muted focus:outline-none focus:border-hq-accent/60"
            placeholder="Search name, ID, or session file…"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-[12px] border border-hq-border bg-hq-bg px-3 py-2 text-[13px] text-hq-text focus:outline-none focus:border-hq-accent/60">
          <option value="all">All statuses</option>
          <option value="running">Running</option>
          <option value="disabled">Disabled</option>
          <option value="paused">Paused</option>
          <option value="floodwait">FloodWait</option>
          <option value="dead">Dead</option>
          <option value="stopped">Stopped</option>
        </select>
        <div className="flex items-center rounded-[12px] border border-hq-border bg-hq-bg p-0.5">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-2.5 py-1.5 text-[12px] font-medium rounded-[10px] transition-colors ${range === r ? "bg-hq-accent text-white" : "text-hq-muted hover:text-hq-text"}`}>
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
        <HqBtn tone="secondary" onClick={runValidateAll} loading={bulkAction === "validating"} disabled={!!bulkAction} icon={ShieldCheck}>Bulk Validate</HqBtn>
        <HqBtn tone="secondary" onClick={runSpambotCheck} loading={bulkAction === "spambot"} disabled={!!bulkAction} icon={Shield}>SpamBot</HqBtn>
        <HqBtn
          tone="secondary"
          icon={ArrowRightLeft}
          loading={actionLoading === "__bulk_replace_dead"}
          disabled={deadFiles.length === 0 || !!actionLoading}
          onClick={async () => {
            if (deadFiles.length === 0) { toast.error("No dead sessions to replace"); return; }
            setActionLoading("__bulk_replace_dead");
            try {
              const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/sessions/available`);
              const pool: string[] = data.sessions || [];
              if (pool.length === 0) { toast.error("No free sessions available."); setActionLoading(""); return; }
              let i = 0, done = 0;
              for (const df of deadFiles) {
                if (i >= pool.length) break;
                await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/${encodeURIComponent(df)}/replace`, { new_session_file: pool[i++] });
                done++;
              }
              toast.success(`Replaced ${done} dead session${done === 1 ? "" : "s"}`);
              reloadOverview(); onUpdate();
            } catch (e: any) {
              toast.error(e?.response?.data?.detail || "Bulk replace failed");
            }
            setActionLoading("");
          }}
        >Replace Dead</HqBtn>
        <HqBtn tone="primary" onClick={() => { fetchFreeSessions(); setShowAdd(true); }} icon={Plus}>Add</HqBtn>
      </div>

      {/* Bulk result summary */}
      {bulkResult && (
        <div className={`rounded-[14px] border px-4 py-3 text-[13px] flex items-center gap-3 flex-wrap ${
          bulkResult.type === "validate" && bulkResult.dead > 0 ? "border-hq-danger/30 bg-hq-danger/[0.06]"
          : bulkResult.type === "spambot" && bulkResult.limited > 0 ? "border-hq-warning/30 bg-hq-warning/[0.06]"
          : "border-hq-success/30 bg-hq-success/[0.06]"
        }`}>
          {bulkResult.type === "validate" && (<>
            <span className="font-medium text-hq-text">Validation Complete</span>
            <span className="text-hq-success text-[12px]">{bulkResult.active} active</span>
            {bulkResult.dead > 0 && <span className="text-hq-danger text-[12px]">{bulkResult.dead} dead (removed: {bulkResult.dead_removed?.join(", ")})</span>}
          </>)}
          {bulkResult.type === "spambot" && (<>
            <span className="font-medium text-hq-text">SpamBot Check Complete</span>
            <span className="text-hq-success text-[12px]">{bulkResult.active} clean</span>
            {bulkResult.limited > 0 && <span className="text-hq-warning text-[12px]">{bulkResult.limited} limited</span>}
            {bulkResult.frozen > 0 && <span className="text-hq-danger text-[12px]">{bulkResult.frozen} frozen</span>}
            {((bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)) > 0 && (
              <span className="text-hq-muted text-[12px]">({(bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)} moved to pool)</span>
            )}
            <span className="text-hq-muted text-[12px]">{bulkResult.total} total</span>
          </>)}
          {bulkResult.type === "info" && <span className="font-medium text-hq-text">Session info loaded</span>}
          <button onClick={() => setBulkResult(null)} className="ml-auto text-hq-muted hover:text-hq-sub text-[12px]">✕ dismiss</button>
        </div>
      )}

      {/* Session card grid — loading / error / empty / data */}
      {ovError ? (
        <HqCard className="p-8 text-center">
          <AlertCircle className="h-6 w-6 text-hq-danger mx-auto mb-2" />
          <p className="text-[13px] text-hq-text font-medium">Could not load sessions. Check backend logs.</p>
        </HqCard>
      ) : ovLoading && !overview ? (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))" }}>
          {[0, 1, 2].map((i) => <HqCard key={i} className="p-4"><Shimmer className="h-4 w-32 mb-3" /><Shimmer className="h-3 w-24 mb-4" /><Shimmer className="h-16 w-full" /></HqCard>)}
        </div>
      ) : allSessions.length === 0 ? (
        <HqCard className="p-10 text-center"><p className="text-[13px] text-hq-muted">No sessions assigned to this AdBot.</p></HqCard>
      ) : filteredSessions.length === 0 ? (
        <HqCard className="p-10 text-center"><p className="text-[13px] text-hq-muted">No sessions match your filters.</p></HqCard>
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))" }}>
          {filteredSessions.map((s) => {
            const isDisabled = !s.enabled;
            const busy = actionLoading === s.file;
            const st = s.stats;
            const spambot = spambotResults[s.file];
            return (
              <HqCard key={s.file} className={`p-3.5 flex flex-col ${s.status === "dead" ? "!border-hq-danger/25" : isDisabled ? "!border-hq-warning/30" : ""}`}>
                {/* Header */}
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className="w-9 h-9 rounded-[10px] flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                    style={{ background: `linear-gradient(135deg, ${avatarColor(s.file)})` }}>
                    {(s.display_name || `A${s.index}`).trim().slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-hq-text truncate leading-tight">{s.display_name || "Unknown Account"}</div>
                    <div className="text-[12px] text-hq-muted truncate">Account {s.index} · TG ID: {s.telegram_user_id || "N/A"}</div>
                  </div>
                  <SessionStatusChip status={s.status} />
                </div>

                {/* Session file */}
                <div className="flex items-center gap-1.5 mb-2 rounded-[10px] bg-hq-bg border border-hq-border px-2.5 py-1.5">
                  <span className="text-[12px] font-mono text-hq-sub truncate flex-1">{s.file}</span>
                  <CopyBtn text={s.file} />
                </div>

                {/* Meta rows */}
                <div className="space-y-0.5 mb-2.5 text-[12px]">
                  <div className="flex justify-between gap-2"><span className="text-hq-muted">Last active</span><span className="text-hq-sub" title={s.last_active_at ? formatDateTime(s.last_active_at) : ""}>{relTime(s.last_active_at)}</span></div>
                  <div className="flex justify-between gap-2">
                    <span className="text-hq-muted">Last validation</span>
                    <span style={{ color: s.validation_status === "valid" ? "#22C55E" : s.validation_status === "invalid" ? "#EF4444" : undefined }} className={s.validation_status === "unknown" ? "text-hq-muted" : ""}>
                      {s.validation_status === "valid" ? "Valid" : s.validation_status === "invalid" ? "Invalid" : "Not validated yet"}
                      {s.last_validated_at ? ` · ${relTime(s.last_validated_at)}` : ""}
                    </span>
                  </div>
                  {spambot && <div className="flex justify-between gap-2"><span className="text-hq-muted">SpamBot</span>{spambotBadge(spambot)}</div>}
                  {s.phone_from_file && <div className="flex justify-between gap-2"><span className="text-hq-muted">Session file number</span><span className="text-hq-sub font-mono">{s.phone_from_file}</span></div>}
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-4 gap-1.5 mb-2.5">
                  <MetricPill label="Sent" value={st.sent.toLocaleString()} tone="#22C55E" />
                  <MetricPill label="Failed" value={st.failed.toLocaleString()} tone={st.failed > 0 ? "#EF4444" : undefined} />
                  <MetricPill label="Flood" value={st.flood.toLocaleString()} tone={st.flood > 0 ? "#F97316" : undefined} />
                  <MetricPill label="Success" value={st.success_rate === null ? "—" : `${st.success_rate}%`} />
                </div>

                {/* Actions */}
                <div className="mt-auto space-y-1.5">
                  <HqBtn tone={isDisabled ? "success" : "secondary"} onClick={() => toggleSession(s.file, isDisabled)} loading={busy} icon={Power}
                    className="!py-1.5 !text-[12px] justify-center w-full">
                    {isDisabled ? "Enable (use in ads)" : "Disable (pause in ads)"}
                  </HqBtn>
                  <div className="grid grid-cols-4 gap-1.5">
                    <HqBtn tone="ghost" onClick={() => validateSession(s.file)} loading={validating === s.file} icon={ShieldCheck} className="!py-1.5 !text-[11px] justify-center">Validate</HqBtn>
                    <HqBtn tone="ghost" onClick={() => { fetchFreeSessions(); setShowReplace(s.file); }} icon={ArrowRightLeft} className="!py-1.5 !text-[11px] justify-center">Replace</HqBtn>
                    <HqBtn tone="ghost" onClick={() => openEdit(s)} icon={Edit} className="!py-1.5 !text-[11px] justify-center">Edit</HqBtn>
                    <HqBtn tone="ghost" onClick={() => setLogsFor(s.file)} icon={Terminal} className="!py-1.5 !text-[11px] justify-center">Logs</HqBtn>
                  </div>
                  <HqBtn tone="danger" onClick={() => removeSession(s.file)} loading={busy} icon={Trash2} className="!py-1.5 !text-[12px] justify-center w-full">Remove</HqBtn>
                </div>
              </HqCard>
            );
          })}
        </div>
      )}

      {/* Excluded sessions */}
      {bot.excluded_sessions?.length > 0 && (
        <HqCard className="p-5">
          <HqTitle>Excluded Sessions ({bot.excluded_sessions.length})</HqTitle>
          <div className="flex flex-wrap gap-2">
            {bot.excluded_sessions.map((s: string, i: number) => (
              <span key={i} className="rounded-[10px] bg-hq-danger/10 text-hq-danger px-2 py-1 text-[12px] font-mono border border-hq-danger/20">{s}</span>
            ))}
          </div>
        </HqCard>
      )}

      {/* Edit Profile Modal */}
      {editMode && selected && (
        <Modal open onClose={() => { setEditMode(false); setSelected(null); }} title={`Edit Profile: ${selected.file}`} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <HqInput label="First Name" value={editData.first_name} onChange={(e: any) => setEditData({ ...editData, first_name: e.target.value })} />
              <HqInput label="Last Name" value={editData.last_name} onChange={(e: any) => setEditData({ ...editData, last_name: e.target.value })} />
            </div>
            <HqInput label="Username (without @)" value={editData.username} onChange={(e: any) => setEditData({ ...editData, username: e.target.value })} placeholder="username123" />
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-hq-sub">Bio</label>
              <textarea
                className="w-full rounded-[14px] border border-hq-border bg-hq-bg px-3 py-2 text-[13px] text-hq-text focus:outline-none focus:border-hq-accent/60 resize-none h-24"
                value={editData.bio} onChange={(e) => setEditData({ ...editData, bio: e.target.value })}
                placeholder="Session bio…" maxLength={70}
              />
              <p className="text-[10px] text-hq-muted">{editData.bio.length}/70 characters</p>
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-hq-border">
              <HqBtn onClick={saveProfile} loading={saving} icon={Save}>Save Changes</HqBtn>
              <HqBtn tone="ghost" onClick={() => { setEditMode(false); setSelected(null); }}>Cancel</HqBtn>
            </div>
            <p className="text-[10px] text-hq-muted">Changes are applied immediately via Telegram API. Name/bio/username updates are rate-limited by Telegram.</p>
          </div>
        </Modal>
      )}

      {/* Add Session Modal */}
      {showAdd && (
        <Modal open onClose={() => setShowAdd(false)} title="Add Session from Free Pool" size="lg">
          <div className="space-y-3">
            <PoolPicker onPick={addSession} actionIcon={Plus} actionLabel="Add" />
          </div>
        </Modal>
      )}

      {/* Replace Session Modal */}
      {showReplace && (
        <Modal open onClose={() => setShowReplace("")} title={`Replace: ${showReplace}`} size="lg">
          <div className="space-y-3">
            <p className="text-[12px] text-hq-muted">
              Select a session from the free pool to replace <span className="font-mono text-hq-sub">{showReplace}</span>. The old session returns to the free pool.
            </p>
            <PoolPicker onPick={(f) => replaceSession(showReplace, f)} actionIcon={ArrowRightLeft} actionLabel="Replace" />
          </div>
        </Modal>
      )}

      {/* Session Logs Modal — filtered to this session file only */}
      {logsFor && <SessionLogsModal name={name} file={logsFor} onClose={() => setLogsFor("")} />}
    </div>
  );
}

/* ── Structured per-session log viewer ── */
type LogTag = "POST_SUCCESS" | "POST_FAILURE" | "FLOOD_WAIT" | "POST_SKIPPED" | "OTHER";
interface ParsedLog {
  raw: string; date: string; time: string; tag: LogTag;
  group: string; groupId: string; extraLabel: string; extra: string;
}

const LOG_TAG_META: Record<LogTag, { label: string; color: string }> = {
  POST_SUCCESS: { label: "Sent", color: "#22C55E" },
  POST_FAILURE: { label: "Failed", color: "#EF4444" },
  FLOOD_WAIT:   { label: "Flood", color: "#F97316" },
  POST_SKIPPED: { label: "Skipped", color: "#EAB308" },
  OTHER:        { label: "Info", color: "#64748B" },
};

const LOG_FILTERS: { key: string; label: string; tags: LogTag[] }[] = [
  { key: "all", label: "All", tags: [] },
  { key: "success", label: "Sent", tags: ["POST_SUCCESS"] },
  { key: "failed", label: "Failed", tags: ["POST_FAILURE"] },
  { key: "flood", label: "Flood", tags: ["FLOOD_WAIT"] },
  { key: "skipped", label: "Skipped", tags: ["POST_SKIPPED"] },
];

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

function parseLogLine(raw: string): ParsedLog {
  const tsM = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  const tagM = raw.match(/\[(POST_SUCCESS|POST_FAILURE|FLOOD_WAIT|POST_SKIPPED)\]/);
  const out: ParsedLog = {
    raw, date: tsM?.[1] || "", time: tsM?.[2] || "",
    tag: (tagM?.[1] as LogTag) || "OTHER", group: "", groupId: "", extraLabel: "", extra: "",
  };
  const gnIdx = raw.indexOf("group_name=");
  const giIdx = raw.indexOf(" group_id=");
  if (gnIdx >= 0 && giIdx > gnIdx) out.group = unquote(raw.slice(gnIdx + 11, giIdx));
  if (giIdx >= 0) {
    const m = raw.slice(giIdx + 10).match(/^(\S+)(?:\s+(reason|error|wait)=([\s\S]*))?$/);
    if (m) {
      out.groupId = m[1];
      if (m[2]) { out.extraLabel = m[2]; out.extra = unquote(m[3]); }
    }
  }
  return out;
}

function SessionLogsModal({ name, file, onClose }: { name: string; file: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const account = file.replace(".session", "");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/logs?lines=3000`);
      const all: string[] = data.lines || [];
      // Log lines are `[TAG] account=<account> group_name=…` — match on the account token.
      setLines(all.filter((l) => l.includes(`account=${account} `)));
      setError(false);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [name, account]);

  useEffect(() => { load(); }, [load]);

  const parsed = (lines || []).map(parseLogLine);
  const counts = parsed.reduce<Record<string, number>>((acc, p) => {
    for (const f of LOG_FILTERS) {
      if (f.key === "all" || f.tags.includes(p.tag)) acc[f.key] = (acc[f.key] || 0) + 1;
    }
    return acc;
  }, {});

  const activeTags = LOG_FILTERS.find((f) => f.key === filter)?.tags || [];
  const q = query.trim().toLowerCase();
  const rows = parsed.filter((p) => {
    if (activeTags.length && !activeTags.includes(p.tag)) return false;
    if (!q) return true;
    return (
      p.group.toLowerCase().includes(q) ||
      p.groupId.toLowerCase().includes(q) ||
      p.extra.toLowerCase().includes(q) ||
      p.time.includes(q)
    );
  }).reverse();

  return (
    <Modal open onClose={onClose} title={`Session Logs · ${account}`} size="xl">
      {/* Toolbar: search + status filters + refresh */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-hq-muted" />
          <input
            className="w-full rounded-[12px] border border-hq-border bg-hq-bg pl-9 pr-3 py-2 text-[13px] text-hq-text placeholder:text-hq-muted focus:outline-none focus:border-hq-accent/60"
            placeholder="Search group, ID, reason, or time…" value={query} onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center rounded-[12px] border border-hq-border bg-hq-bg p-0.5">
          {LOG_FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1.5 text-[12px] font-medium rounded-[10px] transition-colors flex items-center gap-1.5 ${filter === f.key ? "bg-hq-accent text-white" : "text-hq-muted hover:text-hq-text"}`}>
              {f.label}
              <span className={`tabular-nums ${filter === f.key ? "opacity-80" : "opacity-60"}`}>{counts[f.key] || 0}</span>
            </button>
          ))}
        </div>
        <HqBtn tone="ghost" onClick={load} loading={loading} icon={RefreshCw}>Refresh</HqBtn>
      </div>

      {/* Body */}
      {error ? (
        <p className="text-[13px] text-hq-danger py-10 text-center">Could not load logs. Check backend logs.</p>
      ) : lines === null ? (
        <div className="flex items-center gap-2 py-14 justify-center text-hq-muted text-[13px]"><Loader2 className="h-5 w-5 animate-spin" /> Loading logs…</div>
      ) : parsed.length === 0 ? (
        <p className="text-[13px] text-hq-muted py-14 text-center">No log activity for this session yet.</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-hq-muted py-14 text-center">No lines match your search / filter.</p>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto rounded-[12px] bg-hq-bg border border-hq-border divide-y divide-hq-border/40">
          {rows.map((p, i) => {
            const meta = LOG_TAG_META[p.tag];
            return (
              <div key={i} className="flex items-start gap-3 px-3 py-2 hover:bg-white/[0.03] transition-colors">
                <span className="text-[11px] text-hq-muted font-mono tabular-nums shrink-0 pt-0.5" title={`${p.date} ${p.time}`}>{p.time || "—"}</span>
                <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold shrink-0 w-[62px] justify-center"
                  style={{ color: meta.color, backgroundColor: `${meta.color}1f` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  {p.group || p.groupId ? (
                    <div className="text-[12px] text-hq-text truncate">
                      {p.group || "Unknown group"}
                      {p.groupId && <span className="text-hq-muted font-mono ml-1.5">{p.groupId}</span>}
                    </div>
                  ) : (
                    <div className="text-[12px] text-hq-sub font-mono break-all">{p.raw}</div>
                  )}
                  {p.extra && (
                    <div className="text-[11px] mt-0.5 break-words" style={{ color: p.tag === "POST_FAILURE" ? "#F87171" : p.tag === "FLOOD_WAIT" ? "#FB923C" : "#9CA3AF" }}>
                      {p.extraLabel === "wait" ? `Flood wait: ${p.extra}` : p.extraLabel === "reason" ? `Reason: ${p.extra}` : p.extra}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-hq-muted mt-2.5 text-center">
        Showing {rows.length} of {parsed.length} line{parsed.length === 1 ? "" : "s"} · newest first
      </p>
    </Modal>
  );
}

/* ─── GROUPS (merged with chatlist) ─── */
/* ─── Groups Tab Types ─── */

type StepId = "validate" | "join_first" | "scrape" | "join_rest" | "done";
type StepStatus = "waiting" | "active" | "done" | "error";
interface StepState { status: StepStatus; detail?: string }
interface ScrapeStats { current: number; total: number; forums: number; topics: number }
interface JoinStats { done: number; total: number }
interface FinalStats { groups: number; forums: number; joined: number; failed: number; file: string }
interface GroupEntry { id: string; topic: string; title: string; raw: string }

const STEP_META: Record<StepId, { label: string; desc: string; icon: React.ReactNode }> = {
  validate:   { label: "Validate",  desc: "Checking chatlist link",      icon: <Search className="h-4 w-4" /> },
  join_first: { label: "Join",      desc: "Joining chatlist on session",  icon: <Zap className="h-4 w-4" /> },
  scrape:     { label: "Scan",      desc: "Detecting forums & topics",    icon: <Download className="h-4 w-4" /> },
  join_rest:  { label: "Sync",      desc: "Syncing all sessions",         icon: <Users className="h-4 w-4" /> },
  done:       { label: "Done",      desc: "Setup complete",               icon: <CheckCircle2 className="h-4 w-4" /> },
};
const STEP_ORDER: StepId[] = ["validate", "join_first", "scrape", "join_rest", "done"];

function parseGroupLine(line: string): GroupEntry {
  const parts = line.split("|").map(s => s.trim());
  return { id: parts[0] || line.trim(), topic: parts[1] || "", title: parts[2] || "", raw: line.trim() };
}
function buildGroupLine(g: GroupEntry): string {
  if (g.topic && g.title) return `${g.id} | ${g.topic} | ${g.title}`;
  if (g.topic) return `${g.id} | ${g.topic}`;
  if (g.title) return `${g.id} || ${g.title}`;
  return g.id;
}
function shortId(id: string): string { return id.replace(/^-100/, ""); }

function GroupsTab({ bot, name, onUpdate }: { bot: any; name: string; onUpdate: () => void }) {
  // --- Chatlist link setup state ---
  const [chatlistLinks, setChatlistLinks] = useState<string[]>([]);
  const [newLink, setNewLink] = useState("");
  const [joining, setJoining] = useState(false);
  const [steps, setSteps] = useState<Record<StepId, StepState>>({
    validate: { status: "waiting" }, join_first: { status: "waiting" },
    scrape: { status: "waiting" }, join_rest: { status: "waiting" }, done: { status: "waiting" },
  });
  const [pipelineVisible, setPipelineVisible] = useState(false);
  const [scrapeStats, setScrapeStats] = useState<ScrapeStats>({ current: 0, total: 0, forums: 0, topics: 0 });
  const [joinStats, setJoinStats] = useState<JoinStats>({ done: 0, total: 0 });
  const [finalStats, setFinalStats] = useState<FinalStats | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // --- Group list state ---
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => { if (bot) setChatlistLinks(bot.custom_chatlist?.links || []); }, [bot]);
  useEffect(() => { if (bot?.group_file) loadGroupFile(); }, [bot?.group_file]);
  useEffect(() => () => { wsRef.current?.close(); wsRef.current = null; }, []);

  const loadGroupFile = async () => {
    if (!bot?.name) return;
    setLoadingGroups(true);
    try {
      const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/groups`);
      if (data.groups && Array.isArray(data.groups)) {
        setGroups(data.groups.map((g: any) => ({
          id: g.id || "", topic: g.topic || "", title: g.title || "",
          raw: buildGroupLine(g),
        })));
      } else {
        const lines = (data.content || "").split("\n").filter(Boolean);
        setGroups(lines.map(parseGroupLine));
      }
    } catch { setGroups([]); }
    setLoadingGroups(false);
    setSelected(new Set());
  };

  const saveGroups = async (newGroups: GroupEntry[]) => {
    if (!bot?.name) return;
    setSaving(true);
    try {
      const lines = newGroups.map(buildGroupLine);
      await api.put(`/api/bots/${encodeURIComponent(name)}/groups`, { lines });
      setGroups(newGroups);
      setSelected(new Set());
      toast.success("Group list saved");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSaving(false);
  };

  const deleteSelected = () => {
    if (selected.size === 0) return;
    const newGroups = groups.filter((_, i) => !selected.has(i));
    saveGroups(newGroups);
  };

  const addManualGroups = () => {
    const lines = addInput.split("\n").map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const newEntries = lines.map(parseGroupLine);
    const existingIds = new Set(groups.map(g => g.id));
    const toAdd = newEntries.filter(e => !existingIds.has(e.id));
    if (toAdd.length === 0) { toast.error("All IDs already exist"); return; }
    saveGroups([...groups, ...toAdd]);
    setAddInput("");
    setAddModalOpen(false);
  };

  const toggleSelect = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filteredGroups.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredGroups.map((_, i) => filteredIndexMap[i])));
    }
  };

  const filteredIndexMap: number[] = [];
  const filteredGroups = groups.filter((g, i) => {
    if (!searchQuery) { filteredIndexMap.push(i); return true; }
    const q = searchQuery.toLowerCase();
    const match = g.id.includes(q) || g.title.toLowerCase().includes(q) || g.topic.includes(q);
    if (match) filteredIndexMap.push(i);
    return match;
  });

  /* ─── Link management ─── */
  const addLink = () => {
    const link = newLink.trim();
    if (!link) return;
    if (chatlistLinks.length >= 2) { toast.error("Max 2 chatlist links"); return; }
    if (!link.includes("t.me/addlist/")) { toast.error("Must be a t.me/addlist/ link"); return; }
    if (chatlistLinks.includes(link)) { toast.error("Link already added"); return; }
    setChatlistLinks([...chatlistLinks, link]);
    setNewLink("");
  };

  const removeLink = (i: number) => setChatlistLinks(chatlistLinks.filter((_, idx) => idx !== i));

  /* ─── Pipeline ─── */
  const setStep = (id: StepId, status: StepStatus, detail?: string) => {
    setSteps(prev => {
      const next = { ...prev };
      const idx = STEP_ORDER.indexOf(id);
      for (let i = 0; i < idx; i++) {
        if (next[STEP_ORDER[i]].status === "active") next[STEP_ORDER[i]] = { status: "done", detail: next[STEP_ORDER[i]].detail };
      }
      next[id] = { status, detail: detail ?? prev[id]?.detail };
      return next;
    });
  };

  const connectWs = (): Promise<WebSocket> => {
    return new Promise(async (resolve, reject) => {
      wsRef.current?.close();
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
      const session = await getSession();
      const token = (session as any)?.accessToken || "";
      const ws = new WebSocket(`${apiBase}/ws/chatlist/${encodeURIComponent(name)}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("WebSocket failed"));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event !== "chatlist_progress") return;
          const text: string = msg.message || "";

          if (text.startsWith("__step:")) {
            const parts = text.slice(7).split(":");
            const cmd = parts[0];
            switch (cmd) {
              case "validate":
                if (parts[1] === "done") setStep("validate", "done", `${parts[2] || "?"} groups found`);
                else setStep("validate", "active", "Checking chatlist link...");
                break;
              case "join_first":
                if (parts[1] === "done") setStep("join_first", "done", "Primary session ready");
                else setStep("join_first", "active", "Joining on primary session...");
                break;
              case "scrape":
                if (parts[1] === "done") {
                  const total = parseInt(parts[2]) || 0;
                  const forums = parseInt(parts[3]) || 0;
                  setScrapeStats(p => ({ ...p, current: total, total, forums, topics: forums }));
                  setStep("scrape", "done", `${total} groups · ${forums} forums`);
                } else setStep("scrape", "active", "Detecting groups & forum topics...");
                break;
              case "scrape_progress": {
                const cur = parseInt(parts[1]) || 0;
                const tot = parseInt(parts[2]) || 0;
                const forums = parseInt(parts[3]) || 0;
                const topics = parseInt(parts[4]) || 0;
                setScrapeStats({ current: cur, total: tot, forums, topics });
                setStep("scrape", "active", `${cur}/${tot} groups · ${forums} forums · ${topics} topics`);
                break;
              }
              case "join_rest": {
                const sessTotal = parseInt(parts[1]) || 0;
                setJoinStats({ done: 1, total: sessTotal });
                setStep("join_rest", "active", `1/${sessTotal} sessions`);
                break;
              }
              case "join_session": {
                const jd = parseInt(parts[1]) || 0;
                const jt = parseInt(parts[2]) || 0;
                setJoinStats({ done: jd, total: jt });
                setStep("join_rest", "active", `${jd}/${jt} sessions synced`);
                break;
              }
              case "done": {
                const dGroups = parseInt(parts[1]) || 0;
                const dForums = parseInt(parts[2]) || 0;
                const dJoined = parseInt(parts[3]) || 0;
                const dFailed = parseInt(parts[4]) || 0;
                const dFile = parts.slice(5).join(":") || "";
                setFinalStats({ groups: dGroups, forums: dForums, joined: dJoined, failed: dFailed, file: dFile });
                setStep("join_rest", "done");
                setStep("done", "done", `${dGroups} groups saved`);
                setJoining(false);
                onUpdate();
                loadGroupFile();
                setTimeout(() => { ws.close(); wsRef.current = null; }, 1000);
                break;
              }
            }
            return;
          }

          if (msg.status === "done") {
            setJoining(false); onUpdate(); loadGroupFile();
            setTimeout(() => { ws.close(); wsRef.current = null; }, 1000);
          } else if (msg.status === "failed") {
            setErrorMsg(text);
            setJoining(false);
            setSteps(prev => {
              const next = { ...prev };
              for (const id of STEP_ORDER) {
                if (next[id].status === "active") next[id] = { status: "error", detail: text };
              }
              return next;
            });
            setTimeout(() => { ws.close(); wsRef.current = null; }, 1000);
          }
        } catch {}
      };
      ws.onclose = () => { wsRef.current = null; };
    });
  };

  const startJoin = async () => {
    if (chatlistLinks.length === 0) { toast.error("Add at least one chatlist link"); return; }
    setShowConfirm(false);
    setJoining(true);
    setPipelineVisible(true);
    setSteps({ validate: { status: "waiting" }, join_first: { status: "waiting" }, scrape: { status: "waiting" }, join_rest: { status: "waiting" }, done: { status: "waiting" } });
    setScrapeStats({ current: 0, total: 0, forums: 0, topics: 0 });
    setJoinStats({ done: 0, total: 0 });
    setFinalStats(null);
    setErrorMsg("");

    try {
      await connectWs();
      await api.put(`/api/bots/${encodeURIComponent(name)}/chatlist`, { links: chatlistLinks }, { timeout: 600000 });
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || "Failed";
      setErrorMsg(detail);
      setSteps(prev => {
        const next = { ...prev };
        for (const id of STEP_ORDER) { if (next[id].status === "active") next[id] = { status: "error", detail }; }
        return next;
      });
      setJoining(false);
    }
  };

  const clearChatlist = async () => {
    setJoining(true); setPipelineVisible(false); setErrorMsg("");
    try {
      await api.delete(`/api/bots/${encodeURIComponent(name)}/chatlist`);
      setChatlistLinks([]);
      setGroups([]);
      toast.success("Chatlist cleared — using default groups");
      onUpdate();
    } catch (e: any) { toast.error(e?.response?.data?.detail || "Failed to clear"); }
    setJoining(false);
  };

  /* ─── Computed ─── */
  const hasExistingChatlist = bot.custom_chatlist?.active && (bot.custom_chatlist?.links?.length || 0) > 0;
  const linksChanged = JSON.stringify(chatlistLinks) !== JSON.stringify(bot.custom_chatlist?.links || []);
  const forumCount = groups.filter(g => g.topic).length;
  const plainCount = groups.length - forumCount;
  const allDone = STEP_ORDER.every(id => steps[id].status === "done");
  const hasError = STEP_ORDER.some(id => steps[id].status === "error");

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">

      {/* ────── Header ────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-hq-text flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-hq-accent2/20 to-hq-accent/20 flex items-center justify-center">
              <List className="h-4.5 w-4.5 text-hq-accent2" />
            </div>
            Chat List
          </h1>
          <p className="text-xs text-hq-muted mt-1">Manage chatlist folders &amp; groups for {name}</p>
        </div>
        {groups.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-hq-elev/80 border border-hq-border/60">
              <Globe className="h-3 w-3 text-hq-sub" />
              <span className="font-semibold text-hq-text">{groups.length}</span>
              <span className="text-hq-muted">total</span>
            </div>
            {forumCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-hq-accent2/10 border border-hq-accent2/20">
                <MessageSquare className="h-3 w-3 text-hq-accent2" />
                <span className="font-semibold text-hq-accent2">{forumCount}</span>
                <span className="text-hq-accent2/60">forums</span>
              </div>
            )}
            {plainCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-hq-accent/10 border border-hq-accent/20">
                <Users className="h-3 w-3 text-hq-accent" />
                <span className="font-semibold text-hq-accent">{plainCount}</span>
                <span className="text-hq-accent/60">groups</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ────── Active Chatlist Status ────── */}
      {hasExistingChatlist && (
        <div className="rounded-xl bg-gradient-to-r from-hq-accent2/5 via-hq-card to-hq-accent/5 border border-hq-accent2/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 w-2 rounded-full bg-hq-success animate-pulse" />
            <span className="text-xs font-semibold text-hq-success uppercase tracking-wider">Active Chatlist</span>
          </div>
          <div className="space-y-1.5">
            {(bot.custom_chatlist?.links || []).map((link: string, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-hq-elev/50 px-3 py-2">
                <ExternalLink className="h-3 w-3 text-hq-accent2 shrink-0" />
                <span className="text-xs font-mono text-hq-accent2/80 truncate">{link}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-hq-muted">
            <FolderOpen className="h-3 w-3" />
            <span className="font-mono">{bot.group_file}</span>
          </div>
        </div>
      )}

      {/* ────── Chatlist Links Editor ────── */}
      <HqCard className="p-4 sm:p-5">
        <h3 className="text-[15px] font-semibold text-hq-text mb-4 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-hq-accent2" strokeWidth={1.75} />
          {hasExistingChatlist ? "Update Chatlist" : "Setup Chatlist"}
        </h3>
        <div className="space-y-4">
          {hasExistingChatlist && linksChanged && (
            <div className="rounded-lg bg-hq-warning/10 border border-hq-warning/20 px-3 py-2.5 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-hq-warning shrink-0 mt-0.5" />
              <p className="text-xs text-hq-warning/80">Saving will replace existing groups and re-join all sessions.</p>
            </div>
          )}

          {chatlistLinks.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-hq-border p-8 text-center">
              <div className="h-12 w-12 mx-auto rounded-xl bg-hq-elev flex items-center justify-center mb-3">
                <List className="h-6 w-6 text-hq-muted" />
              </div>
              <p className="text-sm text-hq-sub font-medium">No chatlist configured</p>
              <p className="text-xs text-hq-muted mt-1">Add a t.me/addlist/ link below to get started</p>
            </div>
          ) : (
            <div className="space-y-2">
              {chatlistLinks.map((link, i) => (
                <div key={i} className="group flex items-center gap-2 rounded-xl bg-hq-elev/60 border border-hq-border px-4 py-3 transition-all hover:border-hq-accent2/30">
                  <div className="h-7 w-7 rounded-lg bg-hq-accent2/10 flex items-center justify-center shrink-0">
                    <Hash className="h-3.5 w-3.5 text-hq-accent2" />
                  </div>
                  <span className="flex-1 text-sm text-hq-accent2 font-mono truncate">{link}</span>
                  <button onClick={() => removeLink(i)} disabled={joining}
                    className="opacity-0 group-hover:opacity-100 text-hq-muted hover:text-hq-danger transition-all p-1.5 rounded-lg hover:bg-hq-danger/10 disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                className="w-full rounded-xl border border-hq-border bg-hq-bg pl-4 pr-3 py-2.5 text-sm text-hq-text placeholder:text-hq-muted focus:outline-none focus:ring-2 focus:ring-hq-accent2/40 focus:border-hq-accent2/40 disabled:opacity-50 transition-all"
                placeholder="https://t.me/addlist/..."
                value={newLink}
                onChange={(e) => setNewLink(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addLink()}
                disabled={joining}
              />
            </div>
            <Button variant="secondary" size="sm" onClick={addLink} className="shrink-0 rounded-xl" disabled={joining || chatlistLinks.length >= 2}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 justify-between items-center pt-1">
            {hasExistingChatlist && (
              <Button variant="ghost" size="sm" onClick={clearChatlist} disabled={joining} className="text-hq-muted hover:text-hq-danger hover:bg-hq-danger/10">
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            <div className="flex-1" />
            {!showConfirm ? (
              <Button
                onClick={() => { if (hasExistingChatlist && linksChanged) setShowConfirm(true); else startJoin(); }}
                disabled={joining || chatlistLinks.length === 0}
                loading={joining}
                className="rounded-xl bg-gradient-to-r from-hq-accent2 to-hq-accent hover:from-hq-accent2 hover:to-hq-accent border-0 shadow-lg shadow-hq-accent2/20"
              >
                <Zap className="h-4 w-4" />
                {joining ? "Processing..." : "Join & Scan Groups"}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-hq-warning">Replace existing?</span>
                <Button variant="ghost" size="sm" onClick={() => setShowConfirm(false)}>Cancel</Button>
                <Button size="sm" onClick={startJoin} className="bg-hq-warning hover:bg-hq-warning border-0">
                  <RefreshCw className="h-3.5 w-3.5" /> Replace
                </Button>
              </div>
            )}
          </div>
        </div>
      </HqCard>

      {/* ────── Pipeline Progress ────── */}
      {pipelineVisible && (
        <div className="rounded-2xl bg-hq-card border border-hq-border overflow-hidden">
          <div className="px-5 py-3.5 border-b border-hq-border flex items-center gap-3">
            {joining ? (
              <div className="h-5 w-5 relative">
                <div className="absolute inset-0 rounded-full border-2 border-hq-accent2/30" />
                <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-hq-accent2 animate-spin" />
              </div>
            ) : hasError ? (
              <XCircle className="h-5 w-5 text-hq-danger" />
            ) : allDone ? (
              <div className="h-5 w-5 rounded-full bg-hq-success/20 flex items-center justify-center">
                <CheckCircle2 className="h-3.5 w-3.5 text-hq-success" />
              </div>
            ) : null}
            <span className="text-sm font-semibold text-hq-text">
              {joining ? "Setting up chatlist..." : hasError ? "Setup failed" : allDone ? "Chatlist ready" : "Setup"}
            </span>
          </div>

          <div className="p-4 space-y-1">
            {STEP_ORDER.map((id, i) => {
              const step = steps[id];
              const meta = STEP_META[id];
              const isActive = step.status === "active";
              const isDone = step.status === "done";
              const isError = step.status === "error";

              return (
                <div key={id} className={`rounded-xl px-4 py-3 transition-all duration-500 ${
                  isActive ? "bg-hq-accent2/8 ring-1 ring-hq-accent2/25 shadow-lg shadow-hq-accent2/5" :
                  isDone ? "bg-hq-success/5 ring-1 ring-hq-success/15" :
                  isError ? "bg-hq-danger/5 ring-1 ring-hq-danger/20" :
                  "bg-transparent opacity-40"
                }`}>
                  <div className="flex items-center gap-3">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 ${
                      isActive ? "bg-hq-accent2/15 text-hq-accent2" :
                      isDone ? "bg-hq-success/15 text-hq-success" :
                      isError ? "bg-hq-danger/15 text-hq-danger" :
                      "bg-hq-elev text-hq-muted"
                    }`}>
                      {isActive ? <Loader2 className="h-4 w-4 animate-spin" /> :
                       isDone ? <CheckCircle2 className="h-4 w-4" /> :
                       isError ? <XCircle className="h-4 w-4" /> :
                       meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium transition-colors ${
                        isActive ? "text-hq-accent2" : isDone ? "text-hq-success" : isError ? "text-hq-danger" : "text-hq-muted"
                      }`}>{meta.label}</div>
                      {step.detail && (
                        <div className={`text-[11px] mt-0.5 truncate ${
                          isActive ? "text-hq-accent2/60" : isDone ? "text-hq-success/50" : isError ? "text-hq-danger/60" : "text-hq-muted"
                        }`}>{step.detail}</div>
                      )}
                    </div>
                    <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md ${
                      isActive ? "bg-hq-accent2/20 text-hq-accent2" :
                      isDone ? "bg-hq-success/15 text-hq-success" :
                      isError ? "bg-hq-danger/15 text-hq-danger" :
                      "bg-hq-elev text-hq-muted"
                    }`}>
                      {isActive ? "Running" : isDone ? "Done" : isError ? "Failed" : `Step ${i + 1}`}
                    </span>
                  </div>

                  {id === "scrape" && isActive && scrapeStats.total > 0 && (
                    <div className="mt-3 space-y-2.5">
                      <div className="h-1 rounded-full bg-hq-elev overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-hq-accent2 to-hq-accent transition-all duration-700 ease-out"
                          style={{ width: `${Math.min(100, (scrapeStats.current / scrapeStats.total) * 100)}%` }} />
                      </div>
                      <div className="flex gap-2">
                        {[
                          { v: `${scrapeStats.current}/${scrapeStats.total}`, l: "Scanned", c: "text-hq-sub" },
                          { v: scrapeStats.forums, l: "Forums", c: "text-hq-accent" },
                          { v: scrapeStats.topics, l: "Topics", c: "text-hq-success" },
                        ].map((s, si) => (
                          <div key={si} className="flex-1 rounded-lg bg-hq-elev/60 px-2.5 py-2 text-center">
                            <div className={`text-base font-bold ${s.c}`}>{s.v}</div>
                            <div className="text-[9px] text-hq-muted uppercase tracking-wider">{s.l}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {id === "join_rest" && isActive && joinStats.total > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-hq-accent2/60">Sessions</span>
                        <span className="text-hq-accent2 font-medium">{joinStats.done}/{joinStats.total}</span>
                      </div>
                      <div className="h-1 rounded-full bg-hq-elev overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-hq-accent2 to-hq-accent transition-all duration-500"
                          style={{ width: `${(joinStats.done / joinStats.total) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {allDone && finalStats && (
            <div className="mx-4 mb-4 rounded-xl bg-gradient-to-br from-hq-success/10 via-hq-accent2/5 to-hq-accent/10 border border-hq-success/20 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="h-4 w-4 text-hq-success" />
                <span className="text-sm font-semibold text-hq-success">Chatlist Ready</span>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {[
                  { v: finalStats.groups, l: "Groups", c: "text-white", bg: "from-hq-border to-hq-elev" },
                  { v: finalStats.forums, l: "Forums", c: "text-hq-accent", bg: "from-hq-accent/10 to-hq-accent/5" },
                  { v: finalStats.joined, l: "Sessions", c: "text-hq-success", bg: "from-hq-success/10 to-hq-success/5" },
                  { v: finalStats.failed, l: "Failed", c: finalStats.failed > 0 ? "text-hq-danger" : "text-hq-muted", bg: finalStats.failed > 0 ? "from-hq-danger/10 to-hq-danger/5" : "from-hq-elev to-hq-elev" },
                ].map((s, si) => (
                  <div key={si} className={`rounded-xl bg-gradient-to-b ${s.bg} p-3 text-center`}>
                    <div className={`text-2xl font-bold ${s.c}`}>{s.v}</div>
                    <div className="text-[9px] text-hq-muted uppercase tracking-wider mt-1">{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="mx-4 mb-4 rounded-xl bg-hq-danger/8 border border-hq-danger/20 px-4 py-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-hq-danger shrink-0 mt-0.5" />
              <p className="text-xs text-hq-danger/80">{errorMsg}</p>
            </div>
          )}
        </div>
      )}

      {/* ────── Group List Manager ────── */}
      {!pipelineVisible && groups.length > 0 && (
        <div className="rounded-2xl bg-hq-card border border-hq-border overflow-hidden">

          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-hq-border flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <FolderOpen className="h-4 w-4 text-hq-accent2 shrink-0" />
              <span className="text-sm font-semibold text-hq-text truncate">Groups</span>
              <span className="text-[10px] text-hq-muted font-mono truncate hidden sm:inline">{bot.group_file}</span>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-hq-muted" />
              <input
                className="w-40 sm:w-52 rounded-lg border border-hq-border bg-hq-bg pl-7 pr-3 py-1.5 text-xs text-hq-sub placeholder:text-hq-muted focus:outline-none focus:ring-1 focus:ring-hq-accent2/40 transition-all"
                placeholder="Search groups..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-1.5">
              <button onClick={() => setAddModalOpen(true)} title="Add groups manually"
                className="p-1.5 rounded-lg text-hq-sub hover:text-hq-accent2 hover:bg-hq-accent2/10 transition-all">
                <Plus className="h-4 w-4" />
              </button>
              <button onClick={loadGroupFile} title="Refresh"
                className="p-1.5 rounded-lg text-hq-sub hover:text-hq-accent hover:bg-hq-accent/10 transition-all">
                <RefreshCw className={`h-4 w-4 ${loadingGroups ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="px-4 py-2.5 bg-hq-accent2/8 border-b border-hq-accent2/20 flex items-center gap-3">
              <button onClick={toggleSelectAll} className="text-hq-accent2 hover:text-hq-accent2 transition-colors">
                {selected.size === filteredGroups.length
                  ? <CheckSquare className="h-4 w-4" />
                  : <MinusSquare className="h-4 w-4" />
                }
              </button>
              <span className="text-xs text-hq-accent2 font-medium">{selected.size} selected</span>
              <div className="flex-1" />
              <button onClick={() => setSelected(new Set())}
                className="text-xs text-hq-sub hover:text-hq-text px-2 py-1 rounded-lg hover:bg-hq-elev transition-all">
                Deselect
              </button>
              <button onClick={deleteSelected} disabled={saving}
                className="flex items-center gap-1.5 text-xs text-hq-danger hover:text-hq-danger px-2.5 py-1.5 rounded-lg bg-hq-danger/10 hover:bg-hq-danger/15 border border-hq-danger/20 transition-all disabled:opacity-50">
                <Trash2 className="h-3 w-3" />
                Delete {selected.size}
              </button>
            </div>
          )}

          {/* Group rows */}
          <div className="max-h-[500px] overflow-y-auto">
            {filteredGroups.length === 0 && searchQuery && (
              <div className="px-4 py-8 text-center text-hq-muted text-xs">
                No groups matching &ldquo;{searchQuery}&rdquo;
              </div>
            )}

            {filteredGroups.map((g, fIdx) => {
              const realIdx = filteredIndexMap[fIdx];
              const isSelected = selected.has(realIdx);
              const hasTopic = Boolean(g.topic);

              return (
                <div
                  key={realIdx}
                  className={`group flex items-center gap-3 px-4 py-2.5 border-b border-hq-border/50 transition-all cursor-pointer hover:bg-hq-elev/40 ${
                    isSelected ? "bg-hq-accent2/5" : ""
                  }`}
                  onClick={() => toggleSelect(realIdx)}
                >
                  {/* Checkbox */}
                  <div className={`h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                    isSelected
                      ? "bg-hq-accent2 border-hq-accent2 text-white"
                      : "border-hq-border text-transparent group-hover:border-hq-border"
                  }`}>
                    {isSelected && <CheckCircle2 className="h-3 w-3" />}
                  </div>

                  {/* Index */}
                  <span className="text-[10px] text-hq-muted font-mono w-6 text-right shrink-0 select-none">
                    {realIdx + 1}
                  </span>

                  {/* Type badge */}
                  {hasTopic ? (
                    <div className="h-6 w-6 rounded-md bg-hq-accent2/15 flex items-center justify-center shrink-0" title="Forum with topic">
                      <MessageSquare className="h-3 w-3 text-hq-accent2" />
                    </div>
                  ) : (
                    <div className="h-6 w-6 rounded-md bg-hq-elev flex items-center justify-center shrink-0" title="Group">
                      <Users className="h-3 w-3 text-hq-muted" />
                    </div>
                  )}

                  {/* Name + ID */}
                  <div className="flex-1 min-w-0">
                    {g.title ? (
                      <>
                        <div className="text-sm text-hq-text truncate leading-tight">{g.title}</div>
                        <div className="text-[10px] text-hq-muted font-mono leading-tight mt-0.5">{g.id}</div>
                      </>
                    ) : (
                      <div className="text-sm text-hq-sub font-mono truncate">{g.id}</div>
                    )}
                  </div>

                  {/* Topic badge */}
                  {hasTopic && (
                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-hq-accent/10 border border-hq-accent/20 shrink-0">
                      <Hash className="h-2.5 w-2.5 text-hq-accent" />
                      <span className="text-[10px] font-mono text-hq-accent font-medium">{g.topic}</span>
                    </div>
                  )}

                  {/* Short ID */}
                  <span className="text-[10px] text-hq-muted font-mono shrink-0 hidden sm:block">
                    {shortId(g.id)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-hq-border flex items-center justify-between text-[10px] text-hq-muted">
            <span>{groups.length} groups · {forumCount} forums · {plainCount} regular</span>
            {saving && (
              <span className="flex items-center gap-1 text-hq-accent2">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving...
              </span>
            )}
          </div>
        </div>
      )}

      {/* Empty state when no groups */}
      {!pipelineVisible && groups.length === 0 && !loadingGroups && hasExistingChatlist && (
        <div className="rounded-xl border-2 border-dashed border-hq-border p-8 text-center">
          <div className="h-12 w-12 mx-auto rounded-xl bg-hq-elev flex items-center justify-center mb-3">
            <FolderOpen className="h-6 w-6 text-hq-muted" />
          </div>
          <p className="text-sm text-hq-sub">No groups loaded</p>
          <p className="text-xs text-hq-muted mt-1">Click &ldquo;Join &amp; Scan Groups&rdquo; to populate</p>
        </div>
      )}

      {/* ────── Add Groups Modal ────── */}
      <Modal open={addModalOpen} onClose={() => { setAddModalOpen(false); setAddInput(""); }} title="Add Groups Manually" size="md">
        <div className="space-y-4">
          <p className="text-xs text-hq-sub">
            Paste group IDs (one per line). Optionally include topic ID and title separated by <code className="text-hq-accent2">|</code>.
          </p>
          <div className="space-y-1.5">
            <div className="flex gap-2 text-[10px] text-hq-muted font-mono px-1">
              <span>Format:</span>
              <span className="text-hq-sub">-100xxx</span>
              <span>or</span>
              <span className="text-hq-sub">-100xxx | topic_id | Title</span>
            </div>
            <textarea
              className="w-full rounded-xl border border-hq-border bg-hq-bg p-3 text-sm text-hq-text placeholder:text-hq-muted focus:outline-none focus:ring-2 focus:ring-hq-accent2/40 font-mono resize-none h-40"
              placeholder={"-1001234567890\n-1009876543210 | 123 | My Forum Group"}
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setAddModalOpen(false); setAddInput(""); }}>Cancel</Button>
            <Button size="sm" onClick={addManualGroups} disabled={!addInput.trim()}
              className="bg-gradient-to-r from-hq-accent2 to-hq-accent hover:from-hq-accent2 hover:to-hq-accent border-0">
              <Plus className="h-3.5 w-3.5" /> Add Groups
            </Button>
          </div>
        </div>
      </Modal>

      {/* ────── Excluded groups ────── */}
      {bot.excluded_groups?.length > 0 && (
        <HqCard className="p-4 sm:p-5">
          <h3 className="text-[15px] font-semibold text-hq-text mb-4">Excluded Groups ({bot.excluded_groups.length})</h3>
          <div className="flex flex-wrap gap-1.5">
            {bot.excluded_groups.map((g: number) => (
              <span key={g} className="rounded-lg bg-hq-elev border border-hq-border px-2 py-1 text-[10px] font-mono text-hq-muted">{g}</span>
            ))}
          </div>
        </HqCard>
      )}
    </div>
  );
}

/* ─── LOGS ─── */
const LOG_LEVELS = [
  { id: "all", label: "All", match: () => true },
  { id: "error", label: "Errors", match: (l: string) => /\[ERROR\]/i.test(l) },
  { id: "warn", label: "Warnings", match: (l: string) => /\[WARNING\]|FloodWait/i.test(l) },
  { id: "info", label: "Info", match: (l: string) => /\[INFO\]/i.test(l) },
  { id: "success", label: "Posts", match: (l: string) => /sent to|Posted/i.test(l) },
];

function LogsTab({ name }: { name: string }) {
  const [lineCount, setLineCount] = useState(200);
  const { data, mutate } = useAdbotLogs(name, lineCount);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const frozen = useRef<string[]>([]);

  const rawLines: string[] = data?.lines || [];
  // When paused, keep showing the snapshot captured at pause time.
  if (!paused) frozen.current = rawLines;
  const source = paused ? frozen.current : rawLines;

  const levelFn = LOG_LEVELS.find((l) => l.id === level)?.match || (() => true);
  const q = query.trim().toLowerCase();
  const lines = source.filter((l) => levelFn(l) && (!q || l.toLowerCase().includes(q)));

  useEffect(() => {
    if (autoScroll && !paused && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines.length, autoScroll, paused]);

  const download = () => {
    const blob = new Blob([source.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name}-logs.txt`; a.click();
    URL.revokeObjectURL(url);
  };

  const lineClass = (line: string) =>
    /\[ERROR\]/i.test(line) ? "text-hq-danger" :
    /\[WARNING\]/i.test(line) ? "text-hq-warning" :
    /FloodWait/i.test(line) ? "text-hq-warning font-medium" :
    /sent to|Posted/i.test(line) ? "text-hq-success/80" :
    /\[INFO\]/i.test(line) ? "text-hq-sub" : "text-hq-muted";

  return (
    <HqCard className="p-5">
      <HqTitle
        sub={`${data?.total_lines || 0} total · showing ${lines.length}`}
        right={
          <div className="flex items-center gap-2">
            <select value={lineCount} onChange={(e) => setLineCount(Number(e.target.value))}
              className="rounded-[10px] border border-hq-border bg-hq-bg px-2.5 py-1.5 text-[12px] text-hq-sub outline-none focus:border-hq-accent/60">
              {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
            </select>
            <HqBtn tone={paused ? "primary" : "ghost"} onClick={() => setPaused((p) => !p)} icon={paused ? Play : Pause} className="!px-2.5 !text-[12px]">
              {paused ? "Resume" : "Pause"}
            </HqBtn>
            <HqBtn tone="ghost" onClick={() => setAutoScroll(!autoScroll)} className="!px-2.5 !text-[12px]">
              {autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
            </HqBtn>
            <HqBtn tone="ghost" onClick={download} icon={Download} iconOnly />
            <HqBtn tone="ghost" onClick={() => mutate()} icon={RotateCw} iconOnly />
          </div>
        }
      >Live Logs</HqTitle>

      {/* Search + level filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hq-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search logs…"
            className="w-full rounded-[10px] border border-hq-border bg-hq-bg pl-8 pr-3 py-1.5 text-[12px] text-hq-text placeholder:text-hq-muted outline-none focus:border-hq-accent/60" />
        </div>
        <div className="flex gap-1 p-1 rounded-[10px] border border-hq-border bg-hq-bg">
          {LOG_LEVELS.map((l) => (
            <button key={l.id} onClick={() => setLevel(l.id)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-[7px] transition-colors ${level === l.id ? "bg-hq-accent text-white" : "text-hq-sub hover:text-hq-text"}`}>
              {l.label}
            </button>
          ))}
        </div>
        {paused && <span className="text-[11px] text-hq-warning inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-hq-warning" /> Paused</span>}
      </div>

      <div ref={logRef} className="h-[560px] overflow-y-auto rounded-[14px] bg-hq-bg border border-hq-border p-4 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-hq-muted">{source.length === 0 ? "No logs yet — start the bot to see output" : "No lines match this filter"}</p>
        ) : (
          lines.map((line, i) => <div key={i} className={lineClass(line)}>{line}</div>)
        )}
      </div>
    </HqCard>
  );
}

/* ─── PLAN / BILLING ─── */
function PlanTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const { register, handleSubmit } = useForm({
    defaultValues: {
      plan_name: bot.plan_name || "",
      valid_till: ddmmyyyyToIso(bot.valid_till),
    },
  });
  const [saving, setSaving] = useState(false);

  const onSubmit = async (data: any) => {
    setSaving(true);
    try {
      await api.patch(`/api/bots/${name}`, { valid_till: isoToDdmmyyyy(data.valid_till) });
      toast.success("Plan updated");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
    setSaving(false);
  };

  const plan = bot.plan || {};

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HqCard className="p-5">
          <HqTitle>Current Plan</HqTitle>
          <div className="divide-y divide-hq-border/60">
            {([
              ["Plan Name", bot.plan_name || "—"],
              ["Mode", bot.mode],
              ["Sessions", plan.sessions || bot.sessions_count],
              ["Cycle", `${plan.cycle || bot.cycle}s`],
              ["Gap", `${plan.gap || bot.gap}s`],
              ["Valid Until", formatDate(bot.valid_till)],
            ] as [string, any][]).map(([k, v]) => <KV key={k} k={k} v={String(v)} />)}
          </div>
        </HqCard>

        <HqCard className="p-5">
          <HqTitle>Edit Plan / Dates</HqTitle>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <HqInput label="Plan Name" disabled value={bot.plan_name || "—"} />
            <HqInput label="Valid Until" type="date" {...register("valid_till")} />
            <HqBtn type="submit" loading={saving} icon={Save}>Update Validity</HqBtn>
          </form>
        </HqCard>
      </div>

      {bot.authorized?.length > 0 && (
        <HqCard className="p-5">
          <HqTitle>Authorized Users</HqTitle>
          <div className="flex flex-wrap gap-2">
            {bot.authorized.map((uid: number, i: number) => (
              <span key={i} className="rounded-[10px] bg-hq-accent/10 text-hq-accent px-3 py-1 text-[13px] font-mono border border-hq-accent/20">{uid}</span>
            ))}
          </div>
        </HqCard>
      )}
    </div>
  );
}

/* ─── CONFIG ─── */
function ConfigTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const { register, handleSubmit } = useForm<BotUpdatePayload>({
    defaultValues: {
      cycle: bot.cycle,
      gap: bot.gap,
      group_file: bot.group_file,
      valid_till: ddmmyyyyToIso(bot.valid_till),
    },
  });
  const [loading, setLoading] = useState(false);

  const onSubmit = async (data: BotUpdatePayload) => {
    setLoading(true);
    try {
      await api.patch(`/api/bots/${name}`, { ...data, valid_till: data.valid_till ? isoToDdmmyyyy(data.valid_till) : data.valid_till });
      toast.success("Config updated");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
    setLoading(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <HqCard className="p-5">
        <HqTitle>Edit Configuration</HqTitle>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <HqInput label="Cycle (seconds)" type="number" {...register("cycle", { valueAsNumber: true })} />
          <HqInput label="Gap (seconds)" type="number" {...register("gap", { valueAsNumber: true })} />
          <HqInput label="Group File" {...register("group_file")} />
          <HqInput label="Valid Until" type="date" {...register("valid_till")} />
          <HqBtn type="submit" loading={loading} icon={Save}>Save Changes</HqBtn>
        </form>
      </HqCard>

      <HqCard className="p-5">
        <HqTitle>Current Values</HqTitle>
        <div className="divide-y divide-hq-border/60">
          {([
            ["Cycle", `${bot.cycle}s`],
            ["Gap", `${bot.gap}s`],
            ["Group File", bot.group_file || "—"],
            ["Mode", bot.mode],
            ["Valid Until", formatDate(bot.valid_till)],
            ["Sessions", bot.sessions_count],
            ["State", bot.state],
          ] as [string, string][]).map(([k, v]) => <KV key={k} k={k} v={v} />)}
        </div>
      </HqCard>
    </div>
  );
}

/* ─── SETTINGS (wraps General/Plan/Stats/Logs/Repair) ─── */
const SETTINGS_SUBTABS = [
  { id: "general", label: "General", icon: Settings },
  { id: "plan", label: "Plan", icon: DollarSign },
  { id: "stats", label: "Stats", icon: TrendingUp },
];

function SettingsTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const [sub, setSub] = useState("general");
  return (
    <div className="space-y-5">
      {/* Secondary sub-navigation */}
      <div className="flex gap-1 p-1 rounded-[14px] border border-hq-border bg-hq-card overflow-x-auto no-scrollbar w-fit max-w-full">
        {SETTINGS_SUBTABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 text-[13px] font-medium rounded-[10px] transition-all whitespace-nowrap ${
              sub === t.id
                ? t.id === "repair"
                  ? "bg-hq-danger text-white shadow-[0_2px_10px_rgba(239,68,68,0.35)]"
                  : "bg-hq-accent text-white shadow-[0_2px_10px_rgba(124,92,255,0.35)]"
                : "text-hq-sub hover:text-hq-text hover:bg-hq-hover"
            }`}
          >
            <t.icon className="h-4 w-4" strokeWidth={1.75} />
            {t.label}
          </button>
        ))}
      </div>

      {sub === "general" && <ConfigTab name={name} bot={bot} onUpdate={onUpdate} />}
      {sub === "plan" && <PlanTab name={name} bot={bot} onUpdate={onUpdate} />}
      {sub === "stats" && <StatsTab name={name} />}
    </div>
  );
}

/* ─── REPAIR ─── */
function RepairTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const [loading, setLoading] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [tokenModal, setTokenModal] = useState(false);

  // Repair ops (may take a while, return a result message)
  const repair = async (path: string, label: string) => {
    setLoading(path);
    setResult(null);
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/repair/${path}`, {}, { timeout: 180000 });
      const text = data?.message || `${label} — done`;
      setResult({ ok: true, text });
      toast.success(`${label} — done`);
      onUpdate();
    } catch (e: any) {
      const text = e?.response?.data?.detail || `${label} failed`;
      setResult({ ok: false, text });
      toast.error(text);
    }
    setLoading("");
  };

  const repairActions = [
    { id: "config", label: "Fix Config", desc: "Validate & auto-repair the config file (paths, session index, missing fields)", icon: FileText, color: "text-hq-accent bg-hq-accent/10" },
    { id: "log-group", label: "Fix Log Group", desc: "Validate the log group and recreate it across sessions if broken", icon: MessageSquare, color: "text-hq-accent2 bg-hq-accent2/10" },
  ];

  const ActionCard = ({ a, onClick }: { a: any; onClick: () => void }) => (
    <button
      onClick={onClick}
      disabled={!!loading}
      className="flex items-start gap-3 rounded-[14px] border border-hq-border bg-hq-elev p-4 text-left hover:border-hq-accent/30 hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50"
    >
      <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 ${a.color}`}>
        {loading === a.id ? <Loader2 className="h-4.5 w-4.5 animate-spin" strokeWidth={1.75} /> : <a.icon className="h-4.5 w-4.5" strokeWidth={1.75} />}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-hq-text">{a.label}</p>
        <p className="text-[12px] text-hq-muted mt-0.5">{a.desc}</p>
      </div>
    </button>
  );

  return (
    <div className="space-y-5">
      {/* Result banner */}
      {result && (
        <div className={`rounded-[14px] border px-4 py-3 flex items-start gap-2.5 text-[13px] ${
          result.ok ? "border-hq-success/30 bg-hq-success/10 text-hq-success" : "border-hq-danger/30 bg-hq-danger/10 text-hq-danger"
        }`}>
          {result.ok ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{result.text}</p>
          <button onClick={() => setResult(null)} className="text-hq-muted hover:text-hq-sub"><XCircle className="h-4 w-4" /></button>
        </div>
      )}

      {/* Repair operations (parity with /fix) */}
      <HqCard className="p-5">
        <HqTitle sub="Same operations as the /fix command in the controller bot">Repair</HqTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {repairActions.map((a) => <ActionCard key={a.id} a={a} onClick={() => repair(a.id, a.label)} />)}
          <ActionCard a={{ id: "token", label: "Change Bot Token", desc: "Swap the controller bot: deactivate the old one, activate a new token", icon: Key, color: "text-hq-warning bg-hq-warning/10" }} onClick={() => setTokenModal(true)} />
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-[12px] bg-hq-elev border border-hq-border px-3 py-2">
          <HardDrive className="h-3.5 w-3.5 text-hq-muted shrink-0 mt-0.5" />
          <p className="text-[12px] text-hq-muted">To fix or replace sessions (SpamBot check, swap dead/frozen/limited accounts), use the <span className="text-hq-sub">Sessions</span> tab.</p>
        </div>
      </HqCard>

      <ChangeBotTokenModal
        open={tokenModal}
        name={name}
        currentUsername={bot?.bot_username || ""}
        onClose={() => setTokenModal(false)}
        onDone={(msg) => { setTokenModal(false); setResult({ ok: true, text: msg }); onUpdate(); }}
      />
    </div>
  );
}

function ChangeBotTokenModal({ open, name, currentUsername, onClose, onDone }: {
  open: boolean; name: string; currentUsername: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"custom" | "pool">("custom");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!open) { setMode("custom"); setToken(""); setBusy(false); setError(""); setConfirm(false); }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const payload = mode === "pool" ? { use_pool: true } : { bot_token: token.trim() };
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/repair/bot-token`, payload, { timeout: 180000 });
      onDone(data?.message || "Bot token changed");
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Bot token change failed");
    }
    setBusy(false);
    setConfirm(false);
  };

  const canSubmit = mode === "pool" || token.trim().length > 0;

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Change Bot Token" size="md">
      <div className="space-y-4">
        <div className="rounded-lg bg-hq-warning/10 border border-hq-warning/20 px-3 py-2.5 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-hq-warning shrink-0 mt-0.5" />
          <p className="text-xs text-hq-warning/90">
            This deactivates the current controller bot{currentUsername ? ` (@${currentUsername})` : ""} and activates a new one.
            Posting restarts on the new bot and it's re-added to the log group. The old pool token (if any) is freed.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { setMode("custom"); setError(""); }}
            className={`rounded-lg border p-3 text-left transition-all ${mode === "custom" ? "border-hq-accent bg-hq-accent/10 ring-1 ring-hq-accent/30" : "border-hq-border bg-hq-elev hover:border-hq-border"}`}>
            <span className={`block text-sm font-semibold ${mode === "custom" ? "text-hq-accent" : "text-hq-text"}`}>Custom token</span>
            <span className="block text-[11px] text-hq-muted mt-0.5">Paste a token from @BotFather</span>
          </button>
          <button type="button" onClick={() => { setMode("pool"); setError(""); }}
            className={`rounded-lg border p-3 text-left transition-all ${mode === "pool" ? "border-hq-accent bg-hq-accent/10 ring-1 ring-hq-accent/30" : "border-hq-border bg-hq-elev hover:border-hq-border"}`}>
            <span className={`block text-sm font-semibold ${mode === "pool" ? "text-hq-accent" : "text-hq-text"}`}>From pool</span>
            <span className="block text-[11px] text-hq-muted mt-0.5">Use the next available pooled token</span>
          </button>
        </div>

        {mode === "custom" && (
          <HqInput
            label="New Bot Token" id="fix-token" placeholder="123456:ABCdef..."
            value={token} onChange={(e) => { setToken(e.target.value); setError(""); }}
            autoFocus
          />
        )}

        {error && <p className="text-xs text-hq-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-hq-border">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          {confirm ? (
            <Button size="sm" onClick={submit} loading={busy} className="!bg-hq-warning/90 hover:!bg-hq-warning">Confirm change</Button>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)} disabled={!canSubmit}>Change token</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

