"use client";
import { useState, useCallback } from "react";
import {
  CheckCircle2, AlertTriangle, Snowflake, ShieldX, Skull, HelpCircle,
  Loader2, Copy, Check, Play, Square, PauseCircle, Timer, PowerOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import toast from "react-hot-toast";
import type { SessionHealth, SessionDerivedStatus, SessionPool, SessionOverviewItem } from "@/lib/types";

// ── Health metadata (semantic color + text + icon — never color alone) ──
export const HEALTH_META: Record<SessionHealth | "validating", { label: string; icon: LucideIcon; dot: string; text: string; bg: string; border: string }> = {
  healthy:      { label: "Healthy",      icon: CheckCircle2,  dot: "bg-emerald-400", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/25" },
  limited:      { label: "Limited",      icon: AlertTriangle, dot: "bg-amber-400",   text: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/25" },
  frozen:       { label: "Frozen",       icon: Snowflake,     dot: "bg-cyan-400",    text: "text-cyan-400",    bg: "bg-cyan-500/10",    border: "border-cyan-500/25" },
  unauthorized: { label: "Unauthorized", icon: ShieldX,       dot: "bg-red-400",     text: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/25" },
  dead:         { label: "Dead",         icon: Skull,         dot: "bg-rose-500",    text: "text-rose-500",    bg: "bg-rose-600/10",    border: "border-rose-600/25" },
  unknown:      { label: "Unknown",      icon: HelpCircle,    dot: "bg-dark-500",    text: "text-dark-400",    bg: "bg-dark-700/40",    border: "border-dark-600/40" },
  validating:   { label: "Validating",   icon: Loader2,       dot: "bg-accent-400",  text: "text-accent-300",  bg: "bg-accent/10",      border: "border-accent/25" },
};

export const POOL_META: Record<SessionPool, { label: string }> = {
  free:    { label: "Ready pool" },
  assigned:{ label: "Assigned" },
  dead:    { label: "Dead pool" },
  frozen:  { label: "Frozen pool" },
  limited: { label: "Limited pool" },
  unauth:  { label: "Unauthorized pool" },
};

export const STATUS_META: Record<SessionDerivedStatus, { label: string; icon: LucideIcon; text: string }> = {
  ready:        { label: "Ready",        icon: CheckCircle2, text: "text-dark-300" },
  running:      { label: "Running",      icon: Play,         text: "text-emerald-400" },
  stopped:      { label: "Stopped",      icon: Square,       text: "text-dark-400" },
  disabled:     { label: "Disabled",     icon: PowerOff,     text: "text-amber-400" },
  floodwait:    { label: "FloodWait",    icon: Timer,        text: "text-amber-400" },
  paused:       { label: "Paused",       icon: PauseCircle,  text: "text-amber-400" },
  dead:         { label: "Dead",         icon: Skull,        text: "text-rose-500" },
  limited:      { label: "Limited",      icon: AlertTriangle,text: "text-amber-400" },
  frozen:       { label: "Frozen",       icon: Snowflake,    text: "text-cyan-400" },
  unauthorized: { label: "Unauthorized", icon: ShieldX,      text: "text-red-400" },
  unknown:      { label: "Unknown",      icon: HelpCircle,   text: "text-dark-500" },
};

// ── Badges ──
export function HealthBadge({ health, validating }: { health: SessionHealth; validating?: boolean }) {
  const m = HEALTH_META[validating ? "validating" : health];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border ${m.border} ${m.bg} px-2 py-0.5 text-[11px] font-medium ${m.text}`}>
      <Icon className={`h-3 w-3 ${validating ? "animate-spin" : ""}`} aria-hidden />
      {m.label}
    </span>
  );
}

export function LocationBadge({ pool }: { pool: SessionPool }) {
  return (
    <span className="inline-flex items-center rounded-md border border-dark-700 bg-dark-800/60 px-2 py-0.5 text-[11px] font-medium text-dark-300">
      {POOL_META[pool].label}
    </span>
  );
}

export function StatusPill({ status }: { status: SessionDerivedStatus }) {
  const m = STATUS_META[status] || STATUS_META.unknown;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.text}`}>
      <Icon className={`h-3.5 w-3.5 ${status === "running" ? "animate-pulse" : ""}`} aria-hidden />
      {m.label}
    </span>
  );
}

// ── Avatar (initials only — never invent a photo) ──
const AV_COLORS = [
  "from-violet-500/80 to-purple-600/80", "from-cyan-500/80 to-teal-600/80",
  "from-emerald-500/80 to-green-600/80", "from-amber-500/80 to-orange-600/80",
  "from-blue-500/80 to-indigo-600/80", "from-pink-500/80 to-fuchsia-600/80",
];
export function Avatar({ name, id, size = 34 }: { name: string; id?: number | null; size?: number }) {
  const seed = id != null ? Math.abs(id) : name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const color = AV_COLORS[seed % AV_COLORS.length];
  const letter = (name.trim()[0] || "?").toUpperCase();
  return (
    <div
      className={`flex items-center justify-center rounded-full bg-gradient-to-br ${color} font-semibold text-white shrink-0`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {letter}
    </div>
  );
}

// ── Copyable monospace value ──
export function Copyable({ value, className = "", label }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Copy failed");
    }
  }, [value]);
  return (
    <span className={`group/copy inline-flex items-center gap-1.5 ${className}`}>
      <span className="font-mono truncate" title={value}>{value}</span>
      <button
        onClick={copy}
        aria-label={`Copy ${label || value}`}
        className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 text-dark-500 hover:text-dark-200 transition-opacity shrink-0"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

// ── helpers ──
export function accountName(s: SessionOverviewItem): string {
  return s.real_name || s.filename.replace(/\.session$/, "");
}

export function isAssigned(s: SessionOverviewItem): boolean {
  return !!s.bot_name;
}

export function healthOf(s: SessionOverviewItem): SessionHealth {
  return s.health;
}
