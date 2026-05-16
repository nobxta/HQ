"use client";
import { usePortalBot, usePortalStats, usePortalLogs } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  CheckCircle, XCircle, Play, Square, Loader2, Radio,
  Send, ShieldAlert, TrendingUp, Clock, CalendarClock,
  ChevronRight, AlertTriangle, Zap,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ────────────────────── Types ────────────────────── */

type ControlStep = {
  message: string;
  status: "progress" | "done" | "failed";
  time: number;
};

type MiniLog = {
  type: "success" | "failure" | "flood" | "other";
  group: string;
  account: string;
  error?: string;
  time?: string;
};

/* ────────────────────── Mini log parser ────────────────────── */

function parseMiniLog(line: string): MiniLog | null {
  const t = line.trim();
  if (!t) return null;

  // Strip HTML
  const stripped = t.replace(/<[^>]+>/g, "");

  // Extract timestamp if present
  let rest = stripped;
  let time: string | undefined;
  const tsMatch = stripped.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/);
  if (tsMatch) {
    try {
      const normalized = tsMatch[1].replace(" ", "T") + "Z";
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) {
        time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
      }
    } catch {}
    rest = tsMatch[2];
  }

  // Structured: [POST_SUCCESS]
  if (rest.startsWith("[POST_SUCCESS]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || rest.match(/group_name=(\S+)/)?.[1] || "";
    const acct = rest.match(/account=(\S+)/)?.[1] || "";
    return { type: "success", group: gn.replace(/^['"]|['"]$/g, ""), account: shortAcct(acct), time };
  }

  // Structured: [POST_FAILURE]
  if (rest.startsWith("[POST_FAILURE]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || rest.match(/group_name=(\S+)/)?.[1] || "";
    const acct = rest.match(/account=(\S+)/)?.[1] || "";
    let err = rest.match(/error='?([^']+)/)?.[1] || "";
    if (err.includes("can't write")) err = "No permission";
    else if (err.includes("CHANNEL_PRIVATE")) err = "Private channel";
    else if (err.includes("BANNED")) err = "Banned";
    else if (err.length > 30) err = err.slice(0, 27) + "...";
    return { type: "failure", group: gn.replace(/^['"]|['"]$/g, ""), account: shortAcct(acct), error: err, time };
  }

  // Structured: [FLOOD_WAIT]
  if (rest.startsWith("[FLOOD_WAIT]")) {
    const gn = rest.match(/group_name='?([^']+?)'?\s+group_id/)?.[1] || rest.match(/group_name=(\S+)/)?.[1] || "";
    const acct = rest.match(/account=(\S+)/)?.[1] || "";
    const wait = rest.match(/wait=(\d+)s/)?.[1] || "";
    return { type: "flood", group: gn.replace(/^['"]|['"]$/g, ""), account: shortAcct(acct), error: wait ? `Wait ${wait}s` : "Rate limited", time };
  }

  // Human: "Account N - Posted in GROUP"
  const successMatch = rest.match(/^Account\s+(\d+)\s*-\s*(?:Posted in|Sent to|Success in)\s+(.+)$/);
  if (successMatch) return { type: "success", group: successMatch[2], account: `Acc ${successMatch[1]}`, time };

  // Human: "Account N - Failed in GROUP: error"
  const failMatch = rest.match(/^Account\s+(\d+)\s*-\s*Failed in\s+(.+?):\s*(.+)$/);
  if (failMatch) return { type: "failure", group: failMatch[2], account: `Acc ${failMatch[1]}`, error: failMatch[3]?.slice(0, 30), time };

  return null;
}

function shortAcct(s: string): string {
  if (!s) return "";
  const clean = s.replace(".session", "");
  if (clean.length > 6) return "..." + clean.slice(-4);
  return clean;
}

/* ────────────────────── Component ────────────────────── */

export default function UserDashboard() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const { data: stats } = usePortalStats();
  const { data: logData } = usePortalLogs(50);
  const session = getPortalSession();
  const [actionLoading, setActionLoading] = useState("");
  const [controlSteps, setControlSteps] = useState<ControlStep[]>([]);
  const [controlAction, setControlAction] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);

  // Cleanup WS on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    };
  }, []);

  // Parse mini logs
  const miniLogs = useMemo(() => {
    const lines: string[] = logData?.lines || [];
    const parsed: MiniLog[] = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < 8; i--) {
      const m = parseMiniLog(lines[i]);
      if (m) parsed.push(m);
    }
    return parsed;
  }, [logData]);

  if (isLoading) return <PageSkeleton />;
  if (!bot) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-dark-400">
      <ShieldAlert className="h-12 w-12 mb-3 opacity-30" />
      <p className="text-lg font-medium">Bot not found</p>
      <p className="text-sm mt-1">Your session may have expired. Try logging in again.</p>
    </div>
  );

  /* ─── WS + actions ─── */

  const connectControlWs = (): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
      const url = `${apiBase}/ws/control/${encodeURIComponent(bot.name)}?token=${session?.access_token}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("Connection failed"));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "bot_control") {
            setControlSteps((prev) => [...prev, { message: msg.message, status: msg.status, time: Date.now() }]);
            if (msg.status === "done" || msg.status === "failed") {
              setActionLoading("");
              mutate();
              if (msg.status === "done") setTimeout(() => { setControlSteps([]); setControlAction(""); }, 3000);
              setTimeout(() => { ws.close(); wsRef.current = null; }, 500);
            }
          }
        } catch {}
      };
      ws.onclose = () => { wsRef.current = null; };
    });
  };

  const doAction = async (act: string) => {
    setActionLoading(act);
    setControlAction(act);
    setControlSteps([]);
    try {
      await connectControlWs();
      await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/${act}?telegram_id=${session?.telegram_id}`,
        null, { timeout: 120000 }
      );
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || `Failed: ${act}`;
      setControlSteps((prev) => [...prev, { message: detail, status: "failed", time: Date.now() }]);
      setActionLoading("");
    }
  };

  /* ─── Derived ─── */

  const status = bot.running ? "running" : bot.frozen ? "frozen" : bot.suspended ? "suspended" : "stopped";
  const totalSent = stats?.lifetime_sent || 0;
  const totalFailed = stats?.lifetime_failed || 0;
  const total = totalSent + totalFailed;
  const successRate = total > 0 ? Math.round((totalSent / total) * 100) : 0;

  // Validity
  const validTill = bot.valid_till ? (typeof bot.valid_till === "number" ? new Date(bot.valid_till * 1000) : new Date(bot.valid_till)) : null;
  const daysLeft = validTill ? Math.ceil((validTill.getTime() - Date.now()) / 86400000) : null;
  const expiringsSoon = daysLeft !== null && daysLeft <= 3 && daysLeft >= 0;
  const expired = daysLeft !== null && daysLeft < 0;

  const lastStep = controlSteps[controlSteps.length - 1];
  const controlDone = lastStep?.status === "done";
  const controlFailed = lastStep?.status === "failed";
  const controlInProgress = controlSteps.length > 0 && !controlDone && !controlFailed;

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in max-w-3xl mx-auto">

      {/* ════════════ Hero Status Card ════════════ */}
      <div className={`relative overflow-hidden rounded-2xl border p-5 sm:p-7 transition-all duration-500 ${
        status === "running"
          ? "border-success/20 bg-gradient-to-br from-success/[0.06] to-dark-900"
          : status === "frozen" || status === "suspended"
            ? "border-warning/20 bg-gradient-to-br from-warning/[0.04] to-dark-900"
            : "border-dark-700/50 bg-dark-850"
      }`}>
        {/* Animated background glow when running */}
        {status === "running" && (
          <div className="absolute top-0 right-0 w-40 h-40 bg-success/5 rounded-full blur-3xl animate-pulse-slow" />
        )}

        <div className="relative flex items-center justify-between gap-4">
          <div className="min-w-0">
            {/* Status indicator */}
            <div className="flex items-center gap-2.5 mb-3">
              {status === "running" ? (
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-success" />
                </span>
              ) : (
                <span className="h-3 w-3 rounded-full bg-dark-600" />
              )}
              <span className={`text-sm font-semibold uppercase tracking-wide ${
                status === "running" ? "text-success" :
                status === "frozen" ? "text-warning" :
                status === "suspended" ? "text-warning" : "text-dark-500"
              }`}>
                {status === "running" ? "Running" :
                 status === "frozen" ? "Frozen" :
                 status === "suspended" ? "Suspended" : "Stopped"}
              </span>
            </div>

            {/* Bot name */}
            <h1 className="text-2xl sm:text-3xl font-bold text-dark-100 truncate">{bot.name}</h1>

            {/* Plan + validity */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
              {bot.plan_name && (
                <span className="text-xs text-dark-400 flex items-center gap-1">
                  <Zap className="h-3 w-3 text-accent" />
                  {bot.plan_name} plan
                </span>
              )}
              {validTill && (
                <span className={`text-xs flex items-center gap-1 ${
                  expired ? "text-danger" : expiringsSoon ? "text-warning" : "text-dark-400"
                }`}>
                  <CalendarClock className="h-3 w-3" />
                  {expired
                    ? "Expired"
                    : expiringsSoon
                      ? `Expires in ${daysLeft}d`
                      : `Valid till ${formatDate(bot.valid_till)}`}
                </span>
              )}
              {bot.sessions_count > 0 && (
                <span className="text-xs text-dark-400 flex items-center gap-1">
                  <Send className="h-3 w-3" />
                  {bot.sessions_count} account{bot.sessions_count > 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>

          {/* Big Start / Stop button */}
          <div className="shrink-0">
            {bot.running ? (
              <button
                onClick={() => doAction("stop")}
                disabled={!!actionLoading}
                className="group relative flex items-center justify-center h-16 w-16 sm:h-20 sm:w-20 rounded-2xl bg-danger/10 border border-danger/20 hover:bg-danger/20 hover:border-danger/40 transition-all duration-300 disabled:opacity-50"
              >
                {actionLoading === "stop" ? (
                  <Loader2 className="h-6 w-6 sm:h-7 sm:w-7 text-danger animate-spin" />
                ) : (
                  <Square className="h-6 w-6 sm:h-7 sm:w-7 text-danger group-hover:scale-110 transition-transform" />
                )}
                <span className="absolute -bottom-5 text-[10px] text-danger font-medium">Stop</span>
              </button>
            ) : (
              <button
                onClick={() => doAction("start")}
                disabled={!!actionLoading}
                className="group relative flex items-center justify-center h-16 w-16 sm:h-20 sm:w-20 rounded-2xl bg-success/10 border border-success/20 hover:bg-success/20 hover:border-success/40 transition-all duration-300 disabled:opacity-50"
              >
                {actionLoading === "start" ? (
                  <Loader2 className="h-6 w-6 sm:h-7 sm:w-7 text-success animate-spin" />
                ) : (
                  <Play className="h-6 w-6 sm:h-7 sm:w-7 text-success group-hover:scale-110 transition-transform ml-0.5" />
                )}
                <span className="absolute -bottom-5 text-[10px] text-success font-medium">Start</span>
              </button>
            )}
          </div>
        </div>

        {/* Expiry warning banner */}
        {(expired || expiringsSoon) && (
          <div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
            expired ? "bg-danger/10 text-danger border border-danger/20" : "bg-warning/10 text-warning border border-warning/20"
          }`}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {expired
              ? "Your plan has expired. Renew to continue posting."
              : `Your plan expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. Renew soon to avoid interruption.`}
          </div>
        )}
      </div>

      {/* ════════════ Control Progress ════════════ */}
      {controlSteps.length > 0 && (
        <Card className={`!p-4 border ${
          controlDone ? "border-success/30 bg-success/5" :
          controlFailed ? "border-danger/30 bg-danger/5" :
          "border-accent/30 bg-accent/5"
        } animate-slide-up`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {controlInProgress && <Loader2 className="h-4 w-4 text-accent animate-spin" />}
              {controlDone && <CheckCircle className="h-4 w-4 text-success" />}
              {controlFailed && <XCircle className="h-4 w-4 text-danger" />}
              <span className={`text-sm font-semibold ${
                controlDone ? "text-success" : controlFailed ? "text-danger" : "text-accent"
              }`}>
                {controlInProgress
                  ? controlAction === "start" ? "Starting..." : "Stopping..."
                  : controlDone
                    ? controlAction === "start" ? "Bot is now running!" : "Bot stopped"
                    : "Something went wrong"}
              </span>
            </div>
            {(controlDone || controlFailed) && (
              <button onClick={() => { setControlSteps([]); setControlAction(""); }} className="text-[10px] text-dark-500 hover:text-dark-300">
                Dismiss
              </button>
            )}
          </div>
          <div className="space-y-1">
            {controlSteps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                {step.status === "done" ? <CheckCircle className="h-3 w-3 text-success shrink-0 mt-0.5" /> :
                 step.status === "failed" ? <XCircle className="h-3 w-3 text-danger shrink-0 mt-0.5" /> :
                 <Radio className="h-3 w-3 text-accent animate-pulse shrink-0 mt-0.5" />}
                <span className={`text-xs ${
                  step.status === "done" ? "text-success/80" : step.status === "failed" ? "text-danger/80" : "text-dark-300"
                }`}>{step.message}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ════════════ Stats Cards ════════════ */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Messages Sent"
          value={totalSent}
          icon={<Send className="h-5 w-5" />}
          color="success"
          animate={bot.running}
        />
        <StatCard
          label="Failed"
          value={totalFailed}
          icon={<XCircle className="h-5 w-5" />}
          color="danger"
        />
        <StatCard
          label="Success Rate"
          value={`${successRate}%`}
          icon={<TrendingUp className="h-5 w-5" />}
          color={successRate >= 70 ? "success" : successRate >= 40 ? "warning" : "danger"}
          bar={successRate}
        />
      </div>

      {/* ════════════ Live Activity ════════════ */}
      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-dark-200">Recent Activity</h2>
            {bot.running && (
              <span className="flex items-center gap-1 text-[10px] text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                Live
              </span>
            )}
          </div>
          <a href="/user/logs" className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-300 transition-colors">
            View all <ChevronRight className="h-3 w-3" />
          </a>
        </div>

        {miniLogs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-dark-500">
              {bot.running ? "Waiting for activity..." : "Start the bot to see live activity"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-dark-800/30">
            {miniLogs.map((log, i) => (
              <div
                key={i}
                className={`flex items-center gap-2.5 px-4 py-2.5 transition-colors ${
                  i === 0 ? "animate-slide-up" : ""
                } ${
                  log.type === "failure" ? "bg-danger/[0.02]" :
                  log.type === "flood" ? "bg-warning/[0.02]" : ""
                }`}
              >
                {log.type === "success" ? (
                  <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />
                ) : log.type === "flood" ? (
                  <Clock className="h-3.5 w-3.5 text-warning shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-danger shrink-0" />
                )}

                {log.time && (
                  <span className="text-[10px] font-mono text-dark-600 shrink-0 hidden sm:inline">{log.time}</span>
                )}

                <span className={`flex-1 min-w-0 text-xs truncate ${
                  log.type === "success" ? "text-dark-200" : "text-dark-400"
                }`}>
                  {log.type === "success" ? "Sent to " : log.type === "flood" ? "Rate limited in " : "Failed in "}
                  <span className="font-medium text-dark-100">{log.group}</span>
                </span>

                {log.error && log.type !== "success" && (
                  <span className={`shrink-0 text-[10px] hidden sm:inline ${
                    log.type === "flood" ? "text-warning/60" : "text-danger/60"
                  }`}>
                    {log.error}
                  </span>
                )}

                {log.type === "success" ? (
                  <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[9px] font-medium text-success">Sent</span>
                ) : log.type === "flood" ? (
                  <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[9px] font-medium text-warning">Wait</span>
                ) : (
                  <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[9px] font-medium text-danger">Failed</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ════════════ Account Performance ════════════ */}
      {bot.sessions && bot.sessions.length > 0 && (
        <Card className="!p-4">
          <h2 className="text-sm font-semibold text-dark-200 mb-3">
            Account Performance
            <span className="text-[10px] text-dark-500 font-normal ml-2">{bot.sessions.length} accounts</span>
          </h2>
          <div className="space-y-3">
            {bot.sessions.map((sess: any, idx: number) => {
              const sessFile = sess.file || sess;
              const sessKey = typeof sessFile === "string" ? sessFile : String(sessFile);
              const s = stats?.session_stats?.[sessKey] || null;
              const sent = s?.lifetime_sent || 0;
              const failed = s?.lifetime_failed || 0;
              const t = sent + failed;
              const pct = t > 0 ? Math.round((sent / t) * 100) : 0;
              const isActive = t > 0;
              const num = idx + 1;
              return (
                <div key={sessKey} className={!isActive ? "opacity-50" : ""}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-dark-200">Account {num}</span>
                      {!isActive && (
                        <span className="text-[9px] rounded bg-dark-800 px-1.5 py-0.5 text-dark-500">No activity</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="text-success">{sent} sent</span>
                      <span className="text-danger">{failed} failed</span>
                      {isActive && <span className="text-dark-500">{pct}%</span>}
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-dark-800 overflow-hidden">
                    {isActive ? (
                      <div
                        className={`h-full rounded-full transition-all duration-700 ease-out ${
                          pct >= 70 ? "bg-success" : pct >= 40 ? "bg-warning" : "bg-danger"
                        }`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    ) : (
                      <div className="h-full rounded-full bg-dark-700" style={{ width: "100%" }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ────────────────────── Stat Card ────────────────────── */

function StatCard({
  label, value, icon, color, animate, bar,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  color: "success" | "danger" | "warning" | "accent";
  animate?: boolean;
  bar?: number;
}) {
  const colorMap = {
    success: { text: "text-success", bg: "bg-success", bgLight: "bg-success/10", border: "border-success/20" },
    danger: { text: "text-danger", bg: "bg-danger", bgLight: "bg-danger/10", border: "border-danger/20" },
    warning: { text: "text-warning", bg: "bg-warning", bgLight: "bg-warning/10", border: "border-warning/20" },
    accent: { text: "text-accent", bg: "bg-accent", bgLight: "bg-accent/10", border: "border-accent/20" },
  };
  const c = colorMap[color];

  return (
    <div className={`rounded-xl border ${c.border} ${c.bgLight} p-3 sm:p-4 text-center relative overflow-hidden`}>
      {animate && (
        <div className={`absolute inset-0 ${c.bgLight} animate-pulse-slow opacity-50`} />
      )}
      <div className="relative">
        <div className={`${c.text} mx-auto mb-1.5 flex justify-center opacity-60`}>{icon}</div>
        <p className={`text-xl sm:text-2xl font-bold ${c.text}`}>{value}</p>
        <p className="text-[10px] sm:text-xs text-dark-500 mt-0.5">{label}</p>
        {bar !== undefined && (
          <div className="mt-2 h-1.5 rounded-full bg-dark-800 overflow-hidden mx-auto max-w-[80%]">
            <div
              className={`h-full rounded-full ${c.bg} transition-all duration-1000 ease-out`}
              style={{ width: `${Math.max(bar, 2)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
