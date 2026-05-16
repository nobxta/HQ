"use client";
import { useDashboard, useAlerts } from "@/lib/hooks/useDashboard";
import StatCard from "@/components/StatCard";
import RevenueChart from "@/components/RevenueChart";
import Badge from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Bot, HardDrive, DollarSign, Cpu, AlertCircle,
  Zap, Shield, CheckCircle2, XCircle, Snowflake,
  Users, Lock, Activity,
} from "lucide-react";
import { formatDateTime, timeAgo } from "@/lib/utils";

export default function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const { data: alertsData } = useAlerts();

  if (isLoading) return <PageSkeleton />;

  const b = data?.bots || { total: 0, running: 0, stopped: 0, expired: 0, dead: 0 };
  const s = data?.sessions || { total: 0, assigned: 0, free: 0, dead: 0, frozen: 0, limited: 0, unauth: 0 };
  const o = data?.orders || { total: 0, completed: 0, pending: 0, revenue_usd: 0 };
  const sys = data?.system || { cpu_percent: 0, memory_percent: 0, memory_used_mb: 0, memory_total_mb: 0, uptime_seconds: 0 };
  const workers = data?.workers || { create_worker_ok: false, payment_worker_ok: false };
  const alerts = alertsData?.items || [];

  const uptimeStr = sys.uptime_seconds > 0 ? timeAgo(sys.uptime_seconds).replace(" ago", "") : "—";

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ────── Stat Cards ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          title="Total Revenue"
          value={`$${(o.revenue_usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle={`${o.completed} completed · ${o.pending} pending`}
          icon={DollarSign}
          color="text-success"
          gradient="from-emerald-500/15 via-emerald-500/5 to-transparent"
        />
        <StatCard
          title="Bots Running"
          value={`${b.running}/${b.total}`}
          subtitle={`${b.stopped} stopped · ${b.expired} expired`}
          icon={Bot}
          color="text-accent"
          gradient="from-accent/15 via-accent/5 to-transparent"
        />
        <StatCard
          title="Sessions"
          value={s.total}
          subtitle={`${s.assigned} assigned · ${s.free} free`}
          icon={HardDrive}
          color="text-info"
          gradient="from-blue-500/15 via-blue-500/5 to-transparent"
        />
        <StatCard
          title="CPU / RAM"
          value={`${sys.cpu_percent?.toFixed(0) || 0}%`}
          subtitle={`RAM ${sys.memory_percent?.toFixed(0) || 0}% · Up ${uptimeStr}`}
          icon={Cpu}
          color="text-warning"
          gradient="from-amber-500/15 via-amber-500/5 to-transparent"
        />
      </div>

      {/* ────── Chart + Session Pool ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">

        {/* Revenue Chart */}
        <div className="lg:col-span-2">
          <RevenueChart />
        </div>

        {/* Session Pool breakdown */}
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Session Pool</h3>
              <p className="text-[10px] text-dark-600 mt-0.5">{s.total} total sessions</p>
            </div>
          </div>

          <div className="divide-y divide-dark-800/30">
            {[
              { label: "Assigned", val: s.assigned, icon: Zap, color: "text-emerald-400", bg: "bg-emerald-500/10", bar: "bg-emerald-500" },
              { label: "Free", val: s.free, icon: HardDrive, color: "text-accent", bg: "bg-accent/10", bar: "bg-accent" },
              { label: "Dead", val: s.dead, icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", bar: "bg-red-500" },
              { label: "Frozen", val: s.frozen, icon: Snowflake, color: "text-blue-400", bg: "bg-blue-500/10", bar: "bg-blue-500" },
              { label: "Limited", val: s.limited, icon: Shield, color: "text-amber-400", bg: "bg-amber-500/10", bar: "bg-amber-500" },
              { label: "Unauth", val: s.unauth, icon: Lock, color: "text-dark-400", bg: "bg-dark-700/50", bar: "bg-dark-600" },
            ].map((row) => {
              const pct = s.total > 0 ? (row.val / s.total) * 100 : 0;
              return (
                <div key={row.label} className="flex items-center gap-3 px-5 py-3 hover:bg-dark-800/20 transition-colors">
                  <div className={`h-8 w-8 rounded-lg ${row.bg} flex items-center justify-center shrink-0`}>
                    <row.icon className={`h-3.5 w-3.5 ${row.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-dark-400">{row.label}</span>
                      <span className="text-sm font-bold text-white">{row.val}</span>
                    </div>
                    <div className="h-1 rounded-full bg-dark-800 overflow-hidden">
                      <div className={`h-full rounded-full ${row.bar} transition-all duration-700`}
                        style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ────── Bot Fleet + Workers + Alerts ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">

        {/* Bot Fleet */}
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden">
          <div className="px-5 py-4 border-b border-dark-800/50">
            <h3 className="text-sm font-semibold text-dark-100">Bot Fleet</h3>
            <p className="text-[10px] text-dark-600 mt-0.5">{b.total} registered</p>
          </div>
          <div className="p-4 space-y-2.5">
            {[
              { label: "Running", val: b.running, icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
              { label: "Stopped", val: b.stopped, icon: XCircle, color: "text-red-400", bg: "bg-red-500/10" },
              { label: "Expired", val: b.expired, icon: AlertCircle, color: "text-amber-400", bg: "bg-amber-500/10" },
              { label: "Dead", val: b.dead, icon: Snowflake, color: "text-dark-400", bg: "bg-dark-700/50" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3 rounded-xl bg-dark-800/40 border border-dark-700/20 px-4 py-3">
                <div className={`h-9 w-9 rounded-lg ${item.bg} flex items-center justify-center shrink-0`}>
                  <item.icon className={`h-4 w-4 ${item.color}`} />
                </div>
                <span className="flex-1 text-sm text-dark-300">{item.label}</span>
                <span className="text-lg font-bold text-white">{item.val}</span>
              </div>
            ))}
          </div>

          {/* Worker health */}
          <div className="px-5 py-3 border-t border-dark-800/50">
            <p className="text-[10px] text-dark-600 font-medium uppercase tracking-wider mb-2">Background Workers</p>
            <div className="flex gap-3">
              {[
                { label: "Create", ok: workers.create_worker_ok },
                { label: "Payment", ok: workers.payment_worker_ok },
              ].map(w => (
                <div key={w.label} className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${w.ok ? "bg-emerald-400" : "bg-red-400"}`} />
                  <span className="text-xs text-dark-400">{w.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Alerts */}
        <div className="lg:col-span-2 rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden flex flex-col max-h-[460px]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-dark-800/50 shrink-0">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <AlertCircle className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-dark-100">Recent Alerts</h3>
                <p className="text-[10px] text-dark-600 mt-0.5">{alerts.length} total</p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="h-12 w-12 rounded-xl bg-dark-800 flex items-center justify-center mb-3">
                  <CheckCircle2 className="h-6 w-6 text-dark-700" />
                </div>
                <p className="text-sm font-medium text-dark-500">All clear</p>
                <p className="text-xs text-dark-600 mt-1">No active alerts</p>
              </div>
            ) : (
              alerts.slice(0, 20).map((a: any, i: number) => (
                <div key={i} className="rounded-xl bg-dark-800/40 border border-dark-700/20 px-4 py-3 hover:bg-dark-800/60 transition-colors">
                  <div className="flex items-center justify-between mb-1.5">
                    <Badge status={a.type} />
                    <span className="text-[10px] text-dark-600 font-mono">{formatDateTime(a.ts)}</span>
                  </div>
                  <p className="text-xs text-dark-300 break-words leading-relaxed">{a.msg}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
