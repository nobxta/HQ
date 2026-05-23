"use client";
import { useDashboard, useAlerts } from "@/lib/hooks/useDashboard";
import StatCard from "@/components/StatCard";
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
  const posting = data?.posting || { total_sent: 0, total_failed: 0, today_sent: 0, today_failed: 0, hourly: [] };
  const renewals = data?.renewals_soon || [];
  const topFailing = data?.top_failing || [];
  const recentOrders = data?.recent_orders || [];
  const alerts = alertsData?.items || [];

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

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ────── Stat Cards ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          title="Total Users"
          value={b.total}
          subtitle={`${b.running} running · ${b.stopped} stopped`}
          icon={Users}
          color="text-accent"
          gradient="from-accent/15 via-accent/5 to-transparent"
        />
        <StatCard
          title="Posts Today"
          value={posting.today_sent.toLocaleString()}
          subtitle={`${posting.today_failed} failed · ${successRate}% success`}
          icon={Send}
          color="text-info"
          gradient="from-blue-500/15 via-blue-500/5 to-transparent"
        />
        <StatCard
          title="Total Revenue"
          value={`$${(o.revenue_usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle={`${o.completed} completed · ${o.pending} pending`}
          icon={DollarSign}
          color="text-success"
          gradient="from-emerald-500/15 via-emerald-500/5 to-transparent"
        />
        <StatCard
          title="CPU / RAM"
          value={`${sys.cpu_percent?.toFixed(0) || 0}%`}
          subtitle={`RAM ${sys.memory_percent?.toFixed(0) || 0}% · ${Math.round(sys.memory_used_mb)}MB`}
          icon={Cpu}
          color="text-warning"
          gradient="from-amber-500/15 via-amber-500/5 to-transparent"
        />
      </div>

      {/* ────── Posting Activity Chart ────── */}
      <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-800/50">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
              <Activity className="h-4 w-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Posting Activity (24h)</h3>
              <p className="text-[10px] text-dark-600">
                {posting.total_sent.toLocaleString()} lifetime sent · {posting.total_failed.toLocaleString()} lifetime failed
              </p>
            </div>
          </div>
          <div className="flex gap-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-dark-400">Sent</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              <span className="text-dark-400">Failed</span>
            </span>
          </div>
        </div>
        <div className="px-5 pt-4 pb-2">
          <div className="h-64">
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

      {/* ────── Top Failing Bots + Upcoming Renewals ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">

        {/* Top Failing Bots */}
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden flex flex-col max-h-[400px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center gap-3 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-red-500/10 flex items-center justify-center">
              <TrendingDown className="h-4 w-4 text-red-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Top Failing Bots (24h)</h3>
              <p className="text-[10px] text-dark-600">{topFailing.length} bots with failures</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {topFailing.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <CheckCircle2 className="h-10 w-10 text-emerald-500/30 mb-2" />
                <p className="text-sm text-dark-400">No failures in 24h</p>
              </div>
            ) : (
              <div className="divide-y divide-dark-800/30">
                {topFailing.map((bot, i) => {
                  const total = bot.today_sent + bot.today_failed;
                  const failRate = total > 0 ? ((bot.today_failed / total) * 100).toFixed(1) : "0";
                  return (
                    <div key={bot.name} className="flex items-center gap-3 px-5 py-3 hover:bg-dark-800/20 transition-colors">
                      <span className="text-xs font-bold text-dark-600 w-5">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-dark-200 font-medium truncate">{bot.name}</p>
                        <p className="text-[10px] text-dark-500">
                          {bot.today_sent} sent · {bot.today_failed} failed
                        </p>
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
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden flex flex-col max-h-[400px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center gap-3 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <CalendarClock className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Upcoming Renewals</h3>
              <p className="text-[10px] text-dark-600">{renewals.length} within 14 days</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {renewals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <CalendarClock className="h-10 w-10 text-dark-700 mb-2" />
                <p className="text-sm text-dark-400">No upcoming renewals</p>
              </div>
            ) : (
              <div className="divide-y divide-dark-800/30">
                {renewals.map((r) => (
                  <div key={r.name} className="flex items-center gap-3 px-5 py-3 hover:bg-dark-800/20 transition-colors">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                      r.expired ? "bg-red-500/10" : r.days_left <= 3 ? "bg-amber-500/10" : "bg-dark-700/50"
                    }`}>
                      <Clock className={`h-3.5 w-3.5 ${
                        r.expired ? "text-red-400" : r.days_left <= 3 ? "text-amber-400" : "text-dark-400"
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-dark-200 font-medium truncate">{r.name}</p>
                      <p className="text-[10px] text-dark-500">
                        {r.plan_name || "No plan"} · ${r.renewal_price || 0}
                      </p>
                    </div>
                    <span className={`text-xs font-bold ${
                      r.expired ? "text-red-400" : r.days_left <= 3 ? "text-amber-400" : "text-dark-300"
                    }`}>
                      {r.expired ? "EXPIRED" : `${r.days_left}d left`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ────── Recent Orders + Session Pool ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">

        {/* Recent Orders */}
        <div className="lg:col-span-2 rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden flex flex-col max-h-[420px]">
          <div className="px-5 py-4 border-b border-dark-800/50 flex items-center gap-3 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <ShoppingCart className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Recent Orders</h3>
              <p className="text-[10px] text-dark-600">{o.total} total orders</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {recentOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <ShoppingCart className="h-10 w-10 text-dark-700 mb-2" />
                <p className="text-sm text-dark-400">No orders yet</p>
              </div>
            ) : (
              <div className="divide-y divide-dark-800/30">
                {recentOrders.map((order) => (
                  <div key={order.order_id} className="flex items-center gap-3 px-5 py-3 hover:bg-dark-800/20 transition-colors">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                      order.status === "completed" ? "bg-emerald-500/10" :
                      order.status === "cancelled" ? "bg-red-500/10" : "bg-amber-500/10"
                    }`}>
                      {order.status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> :
                       order.status === "cancelled" ? <XCircle className="h-3.5 w-3.5 text-red-400" /> :
                       <Clock className="h-3.5 w-3.5 text-amber-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-dark-200 font-medium truncate">{order.plan_name || order.order_type}</p>
                        <Badge status={order.status} />
                      </div>
                      <p className="text-[10px] text-dark-500">
                        {order.order_type} · User {order.user_id || "?"} · {order.created_at ? new Date(order.created_at).toLocaleDateString() : "—"}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-white">${order.amount_usd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Session Pool */}
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden">
          <div className="px-5 py-4 border-b border-dark-800/50">
            <h3 className="text-sm font-semibold text-dark-100">Session Pool</h3>
            <p className="text-[10px] text-dark-600 mt-0.5">{s.total} total sessions</p>
          </div>
          <div className="divide-y divide-dark-800/30">
            {[
              { label: "Assigned", val: s.assigned, icon: Zap, color: "text-emerald-400", bg: "bg-emerald-500/10", bar: "bg-emerald-500" },
              { label: "Free", val: s.free, icon: Bot, color: "text-accent", bg: "bg-accent/10", bar: "bg-accent" },
              { label: "Dead", val: s.dead, icon: XCircle, color: "text-red-400", bg: "bg-red-500/10", bar: "bg-red-500" },
              { label: "Frozen", val: s.frozen, icon: Snowflake, color: "text-blue-400", bg: "bg-blue-500/10", bar: "bg-blue-500" },
              { label: "Limited", val: s.limited, icon: Shield, color: "text-amber-400", bg: "bg-amber-500/10", bar: "bg-amber-500" },
              { label: "Unauth", val: s.unauth, icon: Lock, color: "text-dark-400", bg: "bg-dark-700/50", bar: "bg-dark-600" },
            ].map((row) => {
              const pct = s.total > 0 ? (row.val / s.total) * 100 : 0;
              return (
                <div key={row.label} className="flex items-center gap-3 px-5 py-2.5 hover:bg-dark-800/20 transition-colors">
                  <div className={`h-7 w-7 rounded-lg ${row.bg} flex items-center justify-center shrink-0`}>
                    <row.icon className={`h-3.5 w-3.5 ${row.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
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

          {/* Worker health */}
          <div className="px-5 py-3 border-t border-dark-800/50">
            <p className="text-[10px] text-dark-600 font-medium uppercase tracking-wider mb-2">Workers</p>
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
      </div>

      {/* ────── Alerts ────── */}
      {alerts.length > 0 && (
        <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden flex flex-col max-h-[350px]">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-dark-800/50 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <AlertCircle className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">Recent Alerts</h3>
              <p className="text-[10px] text-dark-600 mt-0.5">{alerts.length} total</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {alerts.slice(0, 15).map((a: any, i: number) => (
              <div key={i} className="rounded-xl bg-dark-800/40 border border-dark-700/20 px-4 py-3 hover:bg-dark-800/60 transition-colors">
                <div className="flex items-center justify-between mb-1.5">
                  <Badge status={a.type} />
                  <span className="text-[10px] text-dark-600 font-mono">{formatDateTime(a.ts)}</span>
                </div>
                <p className="text-xs text-dark-300 break-words leading-relaxed">{a.msg}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
