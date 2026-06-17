"use client";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  color?: string;
  gradient?: string;
  trend?: { value: number; label: string };
  live?: boolean;
}

export default function StatCard({
  title, value, subtitle, icon: Icon, color = "text-accent",
  gradient = "from-accent/20 via-accent/5 to-transparent",
  trend, live,
}: StatCardProps) {
  return (
    <div className={cn(
      "group relative overflow-hidden rounded-2xl border border-dark-700/30 bg-dark-850 p-5",
      "hover:border-dark-600/50 hover:-translate-y-0.5 transition-all duration-300",
      "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
    )}>
      {/* Base gradient (always visible) */}
      <div className={cn("absolute inset-0 bg-gradient-to-br opacity-60", gradient)} />
      {/* Hover gradient overlay */}
      <div className={cn(
        "absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300",
        gradient.replace(/\/\d+/g, '/10')
      )} />

      <div className="relative">
        <div className="flex items-center justify-between mb-4">
          <div className={cn(
            "flex h-11 w-11 items-center justify-center rounded-xl shadow-lg transition-transform duration-300 group-hover:scale-105",
            color === "text-success" ? "bg-emerald-500/20 text-emerald-400 shadow-emerald-500/10" :
            color === "text-warning" ? "bg-amber-500/20 text-amber-400 shadow-amber-500/10" :
            color === "text-info" ? "bg-blue-500/20 text-blue-400 shadow-blue-500/10" :
            color === "text-danger" ? "bg-red-500/20 text-red-400 shadow-red-500/10" :
            "bg-accent/20 text-accent shadow-accent/10"
          )}>
            <Icon className="h-5 w-5" />
          </div>
          {trend && (
            <span className={cn(
              "text-xs font-bold px-2.5 py-1 rounded-lg",
              trend.value >= 0
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            )}>
              {trend.value >= 0 ? "+" : ""}{trend.label || `${Math.abs(trend.value)}%`}
            </span>
          )}
          {live && (
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-400 text-xs font-bold">Live</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
          )}
        </div>

        <p className="text-[10px] font-bold text-dark-500 uppercase tracking-widest mb-1">{title}</p>
        <p className="text-2xl sm:text-[30px] font-bold text-white tracking-tight leading-none">{value}</p>
        {subtitle && (
          <p className="text-[11px] text-dark-500 mt-2">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
