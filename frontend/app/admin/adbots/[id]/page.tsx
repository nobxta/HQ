"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSession } from "next-auth/react";
import { useAdbot, useAdbotStats, useAdbotLogs } from "@/lib/hooks/useAdbots";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { useForm } from "react-hook-form";
import {
  Play, Square, RotateCw, Trash2, ArrowLeft, Settings, Terminal,
  BarChart3, FolderOpen, HardDrive, Wrench, Pause, PlayCircle,
  MessageSquare, Clock, Users, Zap, Eye, Edit, Save, Copy,
  TrendingUp, TrendingDown, AlertCircle, CheckCircle, XCircle,
  Calendar, DollarSign, Hash, Globe, Shield, User, Plus, RefreshCw,
  Loader2, Phone, AtSign, Crown, Ban, ShieldCheck, ArrowRightLeft,
  Minus, FileText, Search, Key, EyeOff, ChevronDown, ChevronRight,
  ExternalLink, CheckCircle2, Download, Sparkles, List,
  CheckSquare, MinusSquare,
} from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDate, formatDateTime, timeAgo, formatUSD } from "@/lib/utils";
import type { BotUpdatePayload } from "@/lib/types";

const tabs = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "posting", label: "Post / Message", icon: MessageSquare },
  { id: "stats", label: "Stats", icon: TrendingUp },
  { id: "sessions", label: "Sessions", icon: HardDrive },
  { id: "groups", label: "Groups", icon: FolderOpen },
  { id: "logs", label: "Live Logs", icon: Terminal },
  { id: "plan", label: "Plan / Billing", icon: DollarSign },
  { id: "config", label: "Config", icon: Settings },
  { id: "repair", label: "Fix / Repair", icon: Wrench },
];

export default function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const name = decodeURIComponent(id);
  const { data: bot, isLoading, mutate, is404 } = useAdbot(name);
  const [activeTab, setActiveTab] = useState("overview");
  const [actionLoading, setActionLoading] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  if (isLoading) return <PageSkeleton />;
  if (is404 || !bot) return (
    <div className="flex flex-col items-center justify-center py-20 space-y-4 animate-fade-in">
      <div className="w-16 h-16 rounded-full bg-danger/10 flex items-center justify-center">
        <AlertCircle className="h-8 w-8 text-danger" />
      </div>
      <h2 className="text-xl font-bold text-dark-200">Bot Not Found</h2>
      <p className="text-dark-400 text-sm text-center max-w-md">
        &quot;{name}&quot; has been deleted or expired. Sessions have been returned to the free pool.
      </p>
      <Button variant="secondary" onClick={() => router.push("/admin/adbots")}>
        <ArrowLeft className="h-4 w-4" /> Back to Bots
      </Button>
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

  const status = bot.running ? "running" : bot.frozen ? "frozen" : bot.suspended ? "suspended" : "stopped";

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="space-y-3 sm:space-y-0 sm:flex sm:items-center sm:justify-between sm:flex-wrap sm:gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/admin/adbots")} className="text-dark-400 hover:text-dark-200 shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold text-dark-100 truncate">{bot.name}</h2>
              <Badge status={status} />
            </div>
            <p className="text-xs sm:text-sm text-dark-400 truncate">
              {bot.bot_username ? `@${bot.bot_username}` : ""} · {bot.mode} · Owner: {String(bot.owner_id || "admin")}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap pl-8 sm:pl-0">
          {bot.running ? (
            <Button variant="danger" size="sm" onClick={() => doAction("stop")} loading={actionLoading === "stop"}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button variant="success" size="sm" onClick={() => doAction("start")} loading={actionLoading === "start"}>
              <Play className="h-4 w-4" /> Start
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => doAction("restart")} loading={actionLoading === "restart"}>
            <RotateCw className="h-4 w-4" /> <span className="hidden sm:inline">Restart</span>
          </Button>
          {bot.suspended ? (
            <Button variant="secondary" size="sm" onClick={() => doAction("resume")} loading={actionLoading === "resume"}>
              <PlayCircle className="h-4 w-4" /> <span className="hidden sm:inline">Resume</span>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => doAction("suspend")} loading={actionLoading === "suspend"}>
              <Pause className="h-4 w-4" /> <span className="hidden sm:inline">Suspend</span>
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={() => setDeleteConfirm(true)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-dark-700/50 overflow-x-auto pb-px -mx-4 px-4 sm:mx-0 sm:px-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-dark-400 hover:text-dark-200"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && <OverviewTab name={name} bot={bot} onUpdate={() => mutate()} />}
      {activeTab === "posting" && <PostingTab name={name} bot={bot} onUpdate={() => mutate()} />}
      {activeTab === "stats" && <StatsTab name={name} />}
      {activeTab === "sessions" && <SessionsTab bot={bot} name={name} onUpdate={() => mutate()} />}
      {activeTab === "groups" && <GroupsTab bot={bot} name={name} onUpdate={() => mutate()} />}
      {activeTab === "logs" && <LogsTab name={name} />}
      {activeTab === "plan" && <PlanTab name={name} bot={bot} onUpdate={() => mutate()} />}
      {activeTab === "config" && <ConfigTab name={name} bot={bot} onUpdate={() => mutate()} />}
      {activeTab === "repair" && <RepairTab name={name} />}

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
function OverviewTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const { data: stats } = useAdbotStats(name);
  const [showToken, setShowToken] = useState(false);
  const [customToken, setCustomToken] = useState("");
  const [editToken, setEditToken] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const lastLogin = bot.last_web_login;
  const loginHistory: any[] = bot.web_login_history || [];

  const resetToken = async (custom?: string) => {
    setTokenLoading(true);
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/web-access/set-token`, {
        web_token: custom || null,
      });
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

  const timeSince = (ts: number) => {
    if (!ts) return "";
    const secs = Math.floor(Date.now() / 1000 - ts);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  };

  return (
    <div className="space-y-6">
      {/* Quick stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4">
        <QuickStat icon={Zap} label="Sent" value={stats?.lifetime_sent || 0} color="text-success" />
        <QuickStat icon={XCircle} label="Failed" value={stats?.lifetime_failed || 0} color="text-danger" />
        <QuickStat icon={HardDrive} label="Sessions" value={bot.sessions_count || 0} color="text-info" />
        <QuickStat icon={Hash} label="Cycles" value={stats?.cycles || 0} color="text-accent" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Bot Details</CardTitle></CardHeader>
          <div className="space-y-2.5 text-sm">
            {([
              ["Name", bot.name],
              ["Username", bot.bot_username ? `@${bot.bot_username}` : "—"],
              ["Mode", bot.mode],
              ["Plan", bot.plan_name || "—"],
              ["Owner ID", bot.owner_id || "Admin"],
              ["Group File", bot.group_file || "—"],
              ["Cycle", `${bot.cycle}s`],
              ["Gap", `${bot.gap}s`],
              ["Valid Until", formatDate(bot.valid_till)],
              ["Created", formatDate(bot.created_at)],
              ["Log Group", bot.log_group || "—"],
            ] as [string, any][]).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 border-b border-dark-800 last:border-0">
                <span className="text-dark-400">{k}</span>
                <span className="text-dark-200 font-medium text-right max-w-[200px] truncate">{String(v)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>Status</CardTitle></CardHeader>
          <div className="space-y-2.5 text-sm">
            <StatusRow label="Posting" ok={bot.running} />
            <StatusRow label="Frozen" ok={!bot.frozen} okText="No" failText="Frozen" />
            <StatusRow label="Suspended" ok={!bot.suspended} okText="No" failText="Suspended" />
            {bot.plan && (
              <>
                <div className="border-t border-dark-800 pt-2 mt-2">
                  <p className="text-xs text-dark-500 mb-2">Plan Details</p>
                </div>
                {([
                  ["Plan Sessions", bot.plan.sessions],
                  ["Plan Cycle", `${bot.plan.cycle}s`],
                  ["Plan Gap", `${bot.plan.gap}s`],
                ] as [string, any][]).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1">
                    <span className="text-dark-400">{k}</span>
                    <span className="text-dark-200">{String(v)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Web Access & Login Info */}
      <Card>
        <CardHeader><CardTitle><Key className="h-4 w-4 inline mr-2" />Web Access</CardTitle></CardHeader>
        <div className="space-y-4">
          {/* Access Code */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-dark-400 w-24 shrink-0">Access Code</span>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <code className="rounded bg-dark-800 px-3 py-1.5 text-sm font-mono text-accent select-all">
                {showToken ? (bot.web_token || "not set") : "••••••••"}
              </code>
              <button onClick={() => setShowToken(!showToken)} className="text-dark-500 hover:text-dark-300 p-1">
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => { navigator.clipboard.writeText(bot.web_token || ""); toast.success("Copied"); }}
                className="text-dark-500 hover:text-dark-300 p-1">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Token Actions */}
          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="secondary" size="sm" onClick={() => resetToken()} loading={tokenLoading && !editToken}>
              <RefreshCw className="h-3 w-3" /> Regenerate
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditToken(!editToken)}>
              <Edit className="h-3 w-3" /> Set Custom
            </Button>
          </div>

          {editToken && (
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 font-mono focus:outline-none focus:ring-2 focus:ring-accent/40"
                placeholder="Enter custom code (4-32 chars)"
                value={customToken}
                onChange={(e) => setCustomToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && customToken.trim() && resetToken(customToken.trim())}
              />
              <Button size="sm" onClick={() => resetToken(customToken.trim())} loading={tokenLoading}
                disabled={!customToken.trim()}>
                <Save className="h-3 w-3" /> Set
              </Button>
            </div>
          )}

          {/* Last Login */}
          <div className="border-t border-dark-800 pt-3 space-y-2">
            <p className="text-xs text-dark-500 font-medium uppercase tracking-wider">Last Web Login</p>
            {lastLogin ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-dark-500" />
                  <span className="text-dark-300">{formatTs(lastLogin.ts || lastLogin.time)}</span>
                  <span className="text-[10px] text-dark-600">({timeSince(lastLogin.time)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-dark-500" />
                  <span className="font-mono text-dark-300 text-xs">{lastLogin.ip}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-dark-600">Never logged in</p>
            )}
          </div>

          {/* Login History */}
          {loginHistory.length > 0 && (
            <div>
              <button onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1.5 text-xs text-dark-500 hover:text-dark-300 transition-colors">
                {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Login History ({loginHistory.length})
              </button>
              {showHistory && (
                <div className="mt-2 rounded-lg bg-dark-950 border border-dark-800 p-3 max-h-48 overflow-y-auto space-y-1">
                  {[...loginHistory].reverse().map((h: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 text-xs py-1 border-b border-dark-800/30 last:border-0">
                      <span className="text-dark-500 w-36 shrink-0">{formatTs(h.ts || h.time)}</span>
                      <span className="font-mono text-dark-400">{h.ip}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* History */}
      {bot.history?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>History ({bot.history.length} events)</CardTitle></CardHeader>
          <div className="max-h-60 overflow-y-auto space-y-1">
            {bot.history.slice(-20).reverse().map((h: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-dark-800/50">
                <span className="text-dark-500 w-28 shrink-0">{formatDateTime(h.ts)}</span>
                <Badge status={h.action} />
                <span className="text-dark-400 truncate">{h.detail || ""}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ─── POSTING / MESSAGE ─── */
function PostingTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const [message, setMessage] = useState(bot.message || "");
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Post Message / Link</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-xs text-dark-500">
            This is the message that gets posted to all groups every cycle. Supports Telegram HTML formatting.
          </p>
          <textarea
            className="w-full h-48 rounded-lg border border-dark-600 bg-dark-950 px-4 py-3 text-sm text-dark-200 font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter post message or link…"
          />
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} loading={saving}>
              <Save className="h-4 w-4" /> Save Message
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(message); toast.success("Copied"); }}>
              <Copy className="h-4 w-4" /> Copy
            </Button>
          </div>
        </div>
      </Card>

      {/* Preview */}
      <Card>
        <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
        <div className="rounded-lg bg-dark-950 border border-dark-700 p-4 text-sm text-dark-200 whitespace-pre-wrap break-words min-h-[80px]">
          {message || <span className="text-dark-500 italic">No message set</span>}
        </div>
      </Card>
    </div>
  );
}

/* ─── STATS ─── */
function StatsTab({ name }: { name: string }) {
  const { data: stats, isLoading } = useAdbotStats(name);

  if (isLoading) return <PageSkeleton />;
  if (!stats) return <Card><p className="text-dark-500">No stats available</p></Card>;

  const sessions = stats.session_stats || {};

  return (
    <div className="space-y-6">
      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4">
        <QuickStat icon={CheckCircle} label="Total Sent" value={stats.lifetime_sent || 0} color="text-success" />
        <QuickStat icon={XCircle} label="Total Failed" value={stats.lifetime_failed || 0} color="text-danger" />
        <QuickStat icon={RotateCw} label="Cycles" value={stats.cycles || 0} color="text-accent" />
        <QuickStat icon={HardDrive} label="Active Sessions" value={Object.keys(sessions).length} color="text-info" />
      </div>

      {/* Per-session stats */}
      <Card>
        <CardHeader><CardTitle>Per-Session Stats</CardTitle></CardHeader>
        {Object.keys(sessions).length === 0 ? (
          <p className="text-sm text-dark-500">No session stats recorded yet</p>
        ) : (
          <div className="overflow-x-auto">
          <Table>
            <Thead>
              <tr>
                <Th>Session</Th>
                <Th>Sent</Th>
                <Th>Failed</Th>
                <Th>Rate</Th>
                <Th>Cycles</Th>
                <Th>Avg Duration</Th>
                <Th>Last Cycle</Th>
                <Th>Best Cycle</Th>
              </tr>
            </Thead>
            <Tbody>
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
                  <Tr key={sess}>
                    <Td className="font-mono text-xs">{sess.replace(".session", "")}</Td>
                    <Td className="text-success font-medium">{sent}</Td>
                    <Td className="text-danger font-medium">{failed}</Td>
                    <Td>
                      <span className={Number(rate) > 80 ? "text-success" : Number(rate) > 50 ? "text-warning" : "text-danger"}>
                        {rate}{rate !== "—" ? "%" : ""}
                      </span>
                    </Td>
                    <Td className="text-accent font-medium">{cycles}</Td>
                    <Td className="text-xs text-dark-300">{avgDur > 0 ? `${Math.round(avgDur)}s` : "—"}</Td>
                    <Td className="text-xs">
                      {lastTs > 0 ? (
                        <span className="text-dark-300" title={new Date(lastTs * 1000).toLocaleString()}>
                          {lastSuccess}/{lastAttempted} in {Math.round(lastDur)}s
                        </span>
                      ) : <span className="text-dark-500">—</span>}
                    </Td>
                    <Td className="text-xs text-accent">{bestSuccess > 0 ? `${bestSuccess} sent` : "—"}</Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─── SESSIONS (deep) ─── */
function SessionsTab({ bot, name, onUpdate }: { bot: any; name: string; onUpdate: () => void }) {
  const [details, setDetails] = useState<any[] | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
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

  const sessions: any[] = bot.sessions || [];

  const fetchDetails = async () => {
    setLoadingDetails(true);
    try {
      const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/sessions/detail`);
      setDetails(data.sessions);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to load session details");
    }
    setLoadingDetails(false);
  };

  const runValidateAll = async () => {
    setBulkAction("validating");
    setBulkResult(null);
    setSpambotResults({});
    try {
      const { data } = await api.post(`/api/bots/${encodeURIComponent(name)}/sessions/validate-all`);
      setDetails(data.sessions);
      setBulkResult({ type: "validate", active: data.active, dead: data.dead, dead_removed: data.dead_removed });
      if (data.dead > 0) {
        toast.error(`${data.dead} dead session(s) removed`);
        onUpdate();
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

  const runInfoCheck = async () => {
    setBulkAction("info");
    setBulkResult(null);
    setSpambotResults({});
    try {
      const { data } = await api.get(`/api/bots/${encodeURIComponent(name)}/sessions/info`);
      setDetails(data.sessions);
      setBulkResult({ type: "info" });
      toast.success("Session info loaded");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Info check failed");
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
    const parts = (s.real_name || "").split(" ");
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

  const displaySessions = details || sessions.map((s: any) => ({ ...s, status: "unknown" }));

  const statusBadge = (status: string) => {
    switch (status) {
      case "active": return <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"><CheckCircle className="h-3 w-3" />Active</span>;
      case "dead": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"><XCircle className="h-3 w-3" />Dead</span>;
      case "error": return <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"><AlertCircle className="h-3 w-3" />Error</span>;
      default: return <span className="inline-flex items-center gap-1 rounded bg-dark-700 px-1.5 py-0.5 text-[10px] font-medium text-dark-400">Unknown</span>;
    }
  };

  const spambotBadge = (status: string) => {
    switch (status) {
      case "ACTIVE": return <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">Clean</span>;
      case "TEMP_LIMITED": return <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">Temp Limited</span>;
      case "HARD_LIMITED": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Hard Limited</span>;
      case "FROZEN": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Frozen</span>;
      default: return <span className="inline-flex items-center gap-1 rounded bg-dark-700 px-1.5 py-0.5 text-[10px] font-medium text-dark-400">Unknown</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Actions bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={runInfoCheck}
          loading={bulkAction === "info"} disabled={!!bulkAction}>
          <Eye className="h-3.5 w-3.5" /> Check Info
        </Button>
        <Button variant="secondary" size="sm" onClick={runValidateAll}
          loading={bulkAction === "validating"} disabled={!!bulkAction}>
          <ShieldCheck className="h-3.5 w-3.5" /> Validate All
        </Button>
        <Button variant="secondary" size="sm" onClick={runSpambotCheck}
          loading={bulkAction === "spambot"} disabled={!!bulkAction}>
          <Shield className="h-3.5 w-3.5" /> SpamBot Check
        </Button>
        <Button variant="secondary" size="sm" onClick={() => { fetchFreeSessions(); setShowAdd(true); }}>
          <Plus className="h-3.5 w-3.5" /> Add Session
        </Button>
        <span className="text-xs text-dark-500 ml-auto">{sessions.length} session(s) assigned</span>
      </div>

      {/* Bulk result summary */}
      {bulkResult && (
        <div className={`rounded-lg border p-3 text-sm ${
          bulkResult.type === "validate" && bulkResult.dead > 0
            ? "border-danger/30 bg-danger/5"
            : bulkResult.type === "spambot" && bulkResult.limited > 0
            ? "border-warning/30 bg-warning/5"
            : "border-success/30 bg-success/5"
        }`}>
          {bulkResult.type === "validate" && (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-medium text-dark-200">Validation Complete</span>
              <span className="text-success text-xs">{bulkResult.active} active</span>
              {bulkResult.dead > 0 && (
                <span className="text-danger text-xs">{bulkResult.dead} dead (removed: {bulkResult.dead_removed?.join(", ")})</span>
              )}
            </div>
          )}
          {bulkResult.type === "spambot" && (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-medium text-dark-200">SpamBot Check Complete</span>
              <span className="text-success text-xs">{bulkResult.active} clean</span>
              {bulkResult.limited > 0 && (
                <span className="text-warning text-xs">{bulkResult.limited} limited</span>
              )}
              {bulkResult.frozen > 0 && (
                <span className="text-danger text-xs">{bulkResult.frozen} frozen</span>
              )}
              {((bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)) > 0 && (
                <span className="text-dark-400 text-xs">
                  ({(bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)} moved to pool)
                </span>
              )}
              <span className="text-dark-500 text-xs">{bulkResult.total} total</span>
            </div>
          )}
          {bulkResult.type === "info" && (
            <span className="font-medium text-dark-200">Session info loaded</span>
          )}
          <button onClick={() => setBulkResult(null)} className="ml-auto text-dark-500 hover:text-dark-300 text-xs">✕ dismiss</button>
        </div>
      )}

      {/* Sessions table */}
      <Card>
        <CardHeader>
          <CardTitle>Assigned Sessions</CardTitle>
        </CardHeader>
        {displaySessions.length === 0 ? (
          <p className="text-sm text-dark-500">No sessions assigned to this bot</p>
        ) : (
          <div className="space-y-3">
            {displaySessions.map((s: any, i: number) => (
              <div key={s.file || i} className={`rounded-lg border p-3 sm:p-4 transition-all ${
                s.status === "dead" ? "border-danger/30 bg-danger/[0.03]" :
                s.status === "active" ? "border-dark-700/50 bg-dark-900/30" :
                "border-dark-700/50"
              }`}>
                {/* Session header row */}
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
                  <span className="text-dark-500 text-sm font-medium w-5">#{s.index ?? i + 1}</span>
                  {statusBadge(s.status)}
                  <span className="text-sm font-medium text-dark-200 truncate">{s.real_name || "Unknown"}</span>
                  {s.premium && <span title="Premium"><Crown className="h-3.5 w-3.5 text-warning" /></span>}
                  {s.restricted && <span title="Restricted"><Ban className="h-3.5 w-3.5 text-danger" /></span>}
                  {spambotResults[s.file] && spambotBadge(spambotResults[s.file])}
                  <span className="flex-1" />
                  <span className="text-[10px] font-mono text-dark-600 hidden sm:inline">{s.file}</span>
                </div>

                {/* Info grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 ml-7 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Hash className="h-3 w-3 text-dark-600" />
                    <span className="text-dark-500">ID:</span>
                    <span className="font-mono text-dark-300">{s.user_id || "—"}</span>
                  </div>
                  {s.username && (
                    <div className="flex items-center gap-1.5">
                      <AtSign className="h-3 w-3 text-dark-600" />
                      <span className="text-accent">@{s.username}</span>
                    </div>
                  )}
                  {s.phone && (
                    <div className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3 text-dark-600" />
                      <span className="font-mono text-dark-400">{s.phone}</span>
                    </div>
                  )}
                  {s.bio && (
                    <div className="flex items-center gap-1.5 col-span-2 sm:col-span-1">
                      <FileText className="h-3 w-3 text-dark-600 shrink-0" />
                      <span className="text-dark-400 truncate" title={s.bio}>{s.bio}</span>
                    </div>
                  )}
                </div>

                {/* Error / reason display */}
                {(s.error || s.reason) && (
                  <div className="ml-7 mt-2 rounded bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                    {s.error || s.reason}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-1.5 ml-7 mt-3">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(s)} className="text-xs">
                    <Edit className="h-3 w-3" /> Edit Profile
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => validateSession(s.file)} className="text-xs"
                    loading={validating === s.file}>
                    <ShieldCheck className="h-3 w-3" /> Validate
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { fetchFreeSessions(); setShowReplace(s.file); }} className="text-xs">
                    <ArrowRightLeft className="h-3 w-3" /> Replace
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeSession(s.file)} className="text-xs text-danger hover:text-danger"
                    loading={actionLoading === s.file}>
                    <Minus className="h-3 w-3" /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Excluded sessions */}
      {bot.excluded_sessions?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Excluded Sessions ({bot.excluded_sessions.length})</CardTitle></CardHeader>
          <div className="flex flex-wrap gap-2">
            {bot.excluded_sessions.map((s: string, i: number) => (
              <span key={i} className="rounded bg-danger/10 text-danger px-2 py-1 text-xs font-mono">{s}</span>
            ))}
          </div>
        </Card>
      )}

      {/* Edit Profile Modal */}
      {editMode && selected && (
        <Modal open onClose={() => { setEditMode(false); setSelected(null); }} title={`Edit Profile: ${selected.file}`} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="First Name" value={editData.first_name}
                onChange={(e: any) => setEditData({ ...editData, first_name: e.target.value })} />
              <Input label="Last Name" value={editData.last_name}
                onChange={(e: any) => setEditData({ ...editData, last_name: e.target.value })} />
            </div>
            <Input label="Username (without @)" value={editData.username}
              onChange={(e: any) => setEditData({ ...editData, username: e.target.value })}
              placeholder="username123" />
            <div>
              <label className="block text-xs font-medium text-dark-400 mb-1.5">Bio</label>
              <textarea
                className="w-full rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none h-24"
                value={editData.bio}
                onChange={(e) => setEditData({ ...editData, bio: e.target.value })}
                placeholder="Session bio..."
                maxLength={70}
              />
              <p className="text-[10px] text-dark-600 mt-1">{editData.bio.length}/70 characters</p>
            </div>
            <div className="flex items-center gap-3 pt-2 border-t border-dark-700">
              <Button onClick={saveProfile} loading={saving}>
                <Save className="h-4 w-4" /> Save Changes
              </Button>
              <Button variant="ghost" onClick={() => { setEditMode(false); setSelected(null); }}>Cancel</Button>
            </div>
            <p className="text-[10px] text-dark-600">
              Changes are applied immediately via Telegram API. Name/bio/username updates are rate-limited by Telegram.
            </p>
          </div>
        </Modal>
      )}

      {/* Add Session Modal */}
      {showAdd && (
        <Modal open onClose={() => setShowAdd(false)} title="Add Session from Free Pool" size="lg">
          <div className="space-y-3">
            {loadingFree ? (
              <div className="flex items-center gap-2 py-8 justify-center text-dark-500">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading free sessions...
              </div>
            ) : freeSessions.length === 0 ? (
              <p className="text-sm text-dark-500 text-center py-8">No sessions available in the free pool</p>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
                  <input className="w-full rounded-lg border border-dark-600 bg-dark-950 pl-9 pr-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40"
                    placeholder="Filter sessions..." value={freeFilter} onChange={(e) => setFreeFilter(e.target.value)} />
                </div>
                <p className="text-xs text-dark-500">{freeSessions.length} sessions available</p>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {freeSessions.filter(f => !freeFilter || f.includes(freeFilter)).map((f) => (
                    <div key={f} className="flex items-center justify-between rounded-lg bg-dark-800 px-3 py-2">
                      <span className="text-xs font-mono text-dark-300">{f}</span>
                      <Button variant="secondary" size="sm" onClick={() => addSession(f)}
                        loading={actionLoading === f} className="text-xs">
                        <Plus className="h-3 w-3" /> Add
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* Replace Session Modal */}
      {showReplace && (
        <Modal open onClose={() => setShowReplace("")} title={`Replace: ${showReplace}`} size="lg">
          <div className="space-y-3">
            <p className="text-xs text-dark-500">
              Select a session from the free pool to replace <span className="font-mono text-dark-300">{showReplace}</span>.
              The old session will return to the free pool.
            </p>
            {loadingFree ? (
              <div className="flex items-center gap-2 py-8 justify-center text-dark-500">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading...
              </div>
            ) : freeSessions.length === 0 ? (
              <p className="text-sm text-dark-500 text-center py-8">No sessions available in the free pool</p>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
                  <input className="w-full rounded-lg border border-dark-600 bg-dark-950 pl-9 pr-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40"
                    placeholder="Filter sessions..." value={freeFilter} onChange={(e) => setFreeFilter(e.target.value)} />
                </div>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {freeSessions.filter(f => !freeFilter || f.includes(freeFilter)).map((f) => (
                    <div key={f} className="flex items-center justify-between rounded-lg bg-dark-800 px-3 py-2">
                      <span className="text-xs font-mono text-dark-300">{f}</span>
                      <Button variant="secondary" size="sm" onClick={() => replaceSession(showReplace, f)}
                        loading={actionLoading === f} className="text-xs">
                        <ArrowRightLeft className="h-3 w-3" /> Replace
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
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
          <h1 className="text-xl sm:text-2xl font-bold text-dark-100 flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-violet-500/20 to-blue-500/20 flex items-center justify-center">
              <List className="h-4.5 w-4.5 text-violet-400" />
            </div>
            Chat List
          </h1>
          <p className="text-xs text-dark-500 mt-1">Manage chatlist folders &amp; groups for {name}</p>
        </div>
        {groups.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-dark-800/80 border border-dark-700/60">
              <Globe className="h-3 w-3 text-dark-400" />
              <span className="font-semibold text-dark-200">{groups.length}</span>
              <span className="text-dark-500">total</span>
            </div>
            {forumCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20">
                <MessageSquare className="h-3 w-3 text-violet-400" />
                <span className="font-semibold text-violet-300">{forumCount}</span>
                <span className="text-violet-400/60">forums</span>
              </div>
            )}
            {plainCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <Users className="h-3 w-3 text-blue-400" />
                <span className="font-semibold text-blue-300">{plainCount}</span>
                <span className="text-blue-400/60">groups</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ────── Active Chatlist Status ────── */}
      {hasExistingChatlist && (
        <div className="rounded-xl bg-gradient-to-r from-violet-500/5 via-dark-900 to-blue-500/5 border border-violet-500/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Active Chatlist</span>
          </div>
          <div className="space-y-1.5">
            {(bot.custom_chatlist?.links || []).map((link: string, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-dark-800/50 px-3 py-2">
                <ExternalLink className="h-3 w-3 text-violet-400 shrink-0" />
                <span className="text-xs font-mono text-violet-300/80 truncate">{link}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-dark-500">
            <FolderOpen className="h-3 w-3" />
            <span className="font-mono">{bot.group_file}</span>
          </div>
        </div>
      )}

      {/* ────── Chatlist Links Editor ────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            <Sparkles className="h-4 w-4 inline mr-2 text-violet-400" />
            {hasExistingChatlist ? "Update Chatlist" : "Setup Chatlist"}
          </CardTitle>
        </CardHeader>
        <div className="space-y-4">
          {hasExistingChatlist && linksChanged && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300/80">Saving will replace existing groups and re-join all sessions.</p>
            </div>
          )}

          {chatlistLinks.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-dark-700 p-8 text-center">
              <div className="h-12 w-12 mx-auto rounded-xl bg-dark-800 flex items-center justify-center mb-3">
                <List className="h-6 w-6 text-dark-500" />
              </div>
              <p className="text-sm text-dark-400 font-medium">No chatlist configured</p>
              <p className="text-xs text-dark-600 mt-1">Add a t.me/addlist/ link below to get started</p>
            </div>
          ) : (
            <div className="space-y-2">
              {chatlistLinks.map((link, i) => (
                <div key={i} className="group flex items-center gap-2 rounded-xl bg-dark-800/60 border border-dark-700 px-4 py-3 transition-all hover:border-violet-500/30">
                  <div className="h-7 w-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                    <Hash className="h-3.5 w-3.5 text-violet-400" />
                  </div>
                  <span className="flex-1 text-sm text-violet-300 font-mono truncate">{link}</span>
                  <button onClick={() => removeLink(i)} disabled={joining}
                    className="opacity-0 group-hover:opacity-100 text-dark-500 hover:text-red-400 transition-all p-1.5 rounded-lg hover:bg-red-500/10 disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                className="w-full rounded-xl border border-dark-600 bg-dark-950 pl-4 pr-3 py-2.5 text-sm text-dark-200 placeholder:text-dark-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 disabled:opacity-50 transition-all"
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
              <Button variant="ghost" size="sm" onClick={clearChatlist} disabled={joining} className="text-dark-500 hover:text-red-400 hover:bg-red-500/10">
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            <div className="flex-1" />
            {!showConfirm ? (
              <Button
                onClick={() => { if (hasExistingChatlist && linksChanged) setShowConfirm(true); else startJoin(); }}
                disabled={joining || chatlistLinks.length === 0}
                loading={joining}
                className="rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 border-0 shadow-lg shadow-violet-500/20"
              >
                <Zap className="h-4 w-4" />
                {joining ? "Processing..." : "Join & Scan Groups"}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-amber-400">Replace existing?</span>
                <Button variant="ghost" size="sm" onClick={() => setShowConfirm(false)}>Cancel</Button>
                <Button size="sm" onClick={startJoin} className="bg-amber-600 hover:bg-amber-500 border-0">
                  <RefreshCw className="h-3.5 w-3.5" /> Replace
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ────── Pipeline Progress ────── */}
      {pipelineVisible && (
        <div className="rounded-2xl bg-dark-900 border border-dark-700 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-dark-800 flex items-center gap-3">
            {joining ? (
              <div className="h-5 w-5 relative">
                <div className="absolute inset-0 rounded-full border-2 border-violet-500/30" />
                <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-violet-400 animate-spin" />
              </div>
            ) : hasError ? (
              <XCircle className="h-5 w-5 text-red-400" />
            ) : allDone ? (
              <div className="h-5 w-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              </div>
            ) : null}
            <span className="text-sm font-semibold text-dark-200">
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
                  isActive ? "bg-violet-500/8 ring-1 ring-violet-500/25 shadow-lg shadow-violet-500/5" :
                  isDone ? "bg-emerald-500/5 ring-1 ring-emerald-500/15" :
                  isError ? "bg-red-500/5 ring-1 ring-red-500/20" :
                  "bg-transparent opacity-40"
                }`}>
                  <div className="flex items-center gap-3">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 ${
                      isActive ? "bg-violet-500/15 text-violet-400" :
                      isDone ? "bg-emerald-500/15 text-emerald-400" :
                      isError ? "bg-red-500/15 text-red-400" :
                      "bg-dark-800 text-dark-600"
                    }`}>
                      {isActive ? <Loader2 className="h-4 w-4 animate-spin" /> :
                       isDone ? <CheckCircle2 className="h-4 w-4" /> :
                       isError ? <XCircle className="h-4 w-4" /> :
                       meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium transition-colors ${
                        isActive ? "text-violet-200" : isDone ? "text-emerald-300" : isError ? "text-red-300" : "text-dark-500"
                      }`}>{meta.label}</div>
                      {step.detail && (
                        <div className={`text-[11px] mt-0.5 truncate ${
                          isActive ? "text-violet-400/60" : isDone ? "text-emerald-400/50" : isError ? "text-red-400/60" : "text-dark-600"
                        }`}>{step.detail}</div>
                      )}
                    </div>
                    <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md ${
                      isActive ? "bg-violet-500/20 text-violet-400" :
                      isDone ? "bg-emerald-500/15 text-emerald-500" :
                      isError ? "bg-red-500/15 text-red-400" :
                      "bg-dark-800 text-dark-600"
                    }`}>
                      {isActive ? "Running" : isDone ? "Done" : isError ? "Failed" : `Step ${i + 1}`}
                    </span>
                  </div>

                  {id === "scrape" && isActive && scrapeStats.total > 0 && (
                    <div className="mt-3 space-y-2.5">
                      <div className="h-1 rounded-full bg-dark-800 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-700 ease-out"
                          style={{ width: `${Math.min(100, (scrapeStats.current / scrapeStats.total) * 100)}%` }} />
                      </div>
                      <div className="flex gap-2">
                        {[
                          { v: `${scrapeStats.current}/${scrapeStats.total}`, l: "Scanned", c: "text-dark-300" },
                          { v: scrapeStats.forums, l: "Forums", c: "text-blue-400" },
                          { v: scrapeStats.topics, l: "Topics", c: "text-emerald-400" },
                        ].map((s, si) => (
                          <div key={si} className="flex-1 rounded-lg bg-dark-800/60 px-2.5 py-2 text-center">
                            <div className={`text-base font-bold ${s.c}`}>{s.v}</div>
                            <div className="text-[9px] text-dark-600 uppercase tracking-wider">{s.l}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {id === "join_rest" && isActive && joinStats.total > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-violet-400/60">Sessions</span>
                        <span className="text-violet-300 font-medium">{joinStats.done}/{joinStats.total}</span>
                      </div>
                      <div className="h-1 rounded-full bg-dark-800 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-500"
                          style={{ width: `${(joinStats.done / joinStats.total) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {allDone && finalStats && (
            <div className="mx-4 mb-4 rounded-xl bg-gradient-to-br from-emerald-500/10 via-violet-500/5 to-blue-500/10 border border-emerald-500/20 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="h-4 w-4 text-emerald-400" />
                <span className="text-sm font-semibold text-emerald-300">Chatlist Ready</span>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {[
                  { v: finalStats.groups, l: "Groups", c: "text-white", bg: "from-dark-700 to-dark-800" },
                  { v: finalStats.forums, l: "Forums", c: "text-blue-400", bg: "from-blue-500/10 to-blue-500/5" },
                  { v: finalStats.joined, l: "Sessions", c: "text-emerald-400", bg: "from-emerald-500/10 to-emerald-500/5" },
                  { v: finalStats.failed, l: "Failed", c: finalStats.failed > 0 ? "text-red-400" : "text-dark-500", bg: finalStats.failed > 0 ? "from-red-500/10 to-red-500/5" : "from-dark-800 to-dark-800" },
                ].map((s, si) => (
                  <div key={si} className={`rounded-xl bg-gradient-to-b ${s.bg} p-3 text-center`}>
                    <div className={`text-2xl font-bold ${s.c}`}>{s.v}</div>
                    <div className="text-[9px] text-dark-500 uppercase tracking-wider mt-1">{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="mx-4 mb-4 rounded-xl bg-red-500/8 border border-red-500/20 px-4 py-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/80">{errorMsg}</p>
            </div>
          )}
        </div>
      )}

      {/* ────── Group List Manager ────── */}
      {!pipelineVisible && groups.length > 0 && (
        <div className="rounded-2xl bg-dark-900 border border-dark-700 overflow-hidden">

          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-dark-800 flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <FolderOpen className="h-4 w-4 text-violet-400 shrink-0" />
              <span className="text-sm font-semibold text-dark-200 truncate">Groups</span>
              <span className="text-[10px] text-dark-500 font-mono truncate hidden sm:inline">{bot.group_file}</span>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-dark-500" />
              <input
                className="w-40 sm:w-52 rounded-lg border border-dark-700 bg-dark-950 pl-7 pr-3 py-1.5 text-xs text-dark-300 placeholder:text-dark-600 focus:outline-none focus:ring-1 focus:ring-violet-500/40 transition-all"
                placeholder="Search groups..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-1.5">
              <button onClick={() => setAddModalOpen(true)} title="Add groups manually"
                className="p-1.5 rounded-lg text-dark-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
                <Plus className="h-4 w-4" />
              </button>
              <button onClick={loadGroupFile} title="Refresh"
                className="p-1.5 rounded-lg text-dark-400 hover:text-blue-400 hover:bg-blue-500/10 transition-all">
                <RefreshCw className={`h-4 w-4 ${loadingGroups ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="px-4 py-2.5 bg-violet-500/8 border-b border-violet-500/20 flex items-center gap-3">
              <button onClick={toggleSelectAll} className="text-violet-400 hover:text-violet-300 transition-colors">
                {selected.size === filteredGroups.length
                  ? <CheckSquare className="h-4 w-4" />
                  : <MinusSquare className="h-4 w-4" />
                }
              </button>
              <span className="text-xs text-violet-300 font-medium">{selected.size} selected</span>
              <div className="flex-1" />
              <button onClick={() => setSelected(new Set())}
                className="text-xs text-dark-400 hover:text-dark-200 px-2 py-1 rounded-lg hover:bg-dark-800 transition-all">
                Deselect
              </button>
              <button onClick={deleteSelected} disabled={saving}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 transition-all disabled:opacity-50">
                <Trash2 className="h-3 w-3" />
                Delete {selected.size}
              </button>
            </div>
          )}

          {/* Group rows */}
          <div className="max-h-[500px] overflow-y-auto">
            {filteredGroups.length === 0 && searchQuery && (
              <div className="px-4 py-8 text-center text-dark-500 text-xs">
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
                  className={`group flex items-center gap-3 px-4 py-2.5 border-b border-dark-800/50 transition-all cursor-pointer hover:bg-dark-800/40 ${
                    isSelected ? "bg-violet-500/5" : ""
                  }`}
                  onClick={() => toggleSelect(realIdx)}
                >
                  {/* Checkbox */}
                  <div className={`h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                    isSelected
                      ? "bg-violet-500 border-violet-500 text-white"
                      : "border-dark-600 text-transparent group-hover:border-dark-500"
                  }`}>
                    {isSelected && <CheckCircle2 className="h-3 w-3" />}
                  </div>

                  {/* Index */}
                  <span className="text-[10px] text-dark-600 font-mono w-6 text-right shrink-0 select-none">
                    {realIdx + 1}
                  </span>

                  {/* Type badge */}
                  {hasTopic ? (
                    <div className="h-6 w-6 rounded-md bg-violet-500/15 flex items-center justify-center shrink-0" title="Forum with topic">
                      <MessageSquare className="h-3 w-3 text-violet-400" />
                    </div>
                  ) : (
                    <div className="h-6 w-6 rounded-md bg-dark-800 flex items-center justify-center shrink-0" title="Group">
                      <Users className="h-3 w-3 text-dark-500" />
                    </div>
                  )}

                  {/* Name + ID */}
                  <div className="flex-1 min-w-0">
                    {g.title ? (
                      <>
                        <div className="text-sm text-dark-200 truncate leading-tight">{g.title}</div>
                        <div className="text-[10px] text-dark-600 font-mono leading-tight mt-0.5">{g.id}</div>
                      </>
                    ) : (
                      <div className="text-sm text-dark-300 font-mono truncate">{g.id}</div>
                    )}
                  </div>

                  {/* Topic badge */}
                  {hasTopic && (
                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 shrink-0">
                      <Hash className="h-2.5 w-2.5 text-blue-400" />
                      <span className="text-[10px] font-mono text-blue-300 font-medium">{g.topic}</span>
                    </div>
                  )}

                  {/* Short ID */}
                  <span className="text-[10px] text-dark-700 font-mono shrink-0 hidden sm:block">
                    {shortId(g.id)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-dark-800 flex items-center justify-between text-[10px] text-dark-500">
            <span>{groups.length} groups · {forumCount} forums · {plainCount} regular</span>
            {saving && (
              <span className="flex items-center gap-1 text-violet-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving...
              </span>
            )}
          </div>
        </div>
      )}

      {/* Empty state when no groups */}
      {!pipelineVisible && groups.length === 0 && !loadingGroups && hasExistingChatlist && (
        <div className="rounded-xl border-2 border-dashed border-dark-700 p-8 text-center">
          <div className="h-12 w-12 mx-auto rounded-xl bg-dark-800 flex items-center justify-center mb-3">
            <FolderOpen className="h-6 w-6 text-dark-500" />
          </div>
          <p className="text-sm text-dark-400">No groups loaded</p>
          <p className="text-xs text-dark-600 mt-1">Click &ldquo;Join &amp; Scan Groups&rdquo; to populate</p>
        </div>
      )}

      {/* ────── Add Groups Modal ────── */}
      <Modal open={addModalOpen} onClose={() => { setAddModalOpen(false); setAddInput(""); }} title="Add Groups Manually" size="md">
        <div className="space-y-4">
          <p className="text-xs text-dark-400">
            Paste group IDs (one per line). Optionally include topic ID and title separated by <code className="text-violet-400">|</code>.
          </p>
          <div className="space-y-1.5">
            <div className="flex gap-2 text-[10px] text-dark-500 font-mono px-1">
              <span>Format:</span>
              <span className="text-dark-400">-100xxx</span>
              <span>or</span>
              <span className="text-dark-400">-100xxx | topic_id | Title</span>
            </div>
            <textarea
              className="w-full rounded-xl border border-dark-600 bg-dark-950 p-3 text-sm text-dark-200 placeholder:text-dark-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 font-mono resize-none h-40"
              placeholder={"-1001234567890\n-1009876543210 | 123 | My Forum Group"}
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setAddModalOpen(false); setAddInput(""); }}>Cancel</Button>
            <Button size="sm" onClick={addManualGroups} disabled={!addInput.trim()}
              className="bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 border-0">
              <Plus className="h-3.5 w-3.5" /> Add Groups
            </Button>
          </div>
        </div>
      </Modal>

      {/* ────── Excluded groups ────── */}
      {bot.excluded_groups?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Excluded Groups ({bot.excluded_groups.length})</CardTitle></CardHeader>
          <div className="flex flex-wrap gap-1.5">
            {bot.excluded_groups.map((g: number) => (
              <span key={g} className="rounded-lg bg-dark-800 px-2 py-1 text-[10px] font-mono text-dark-500">{g}</span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ─── LOGS ─── */
function LogsTab({ name }: { name: string }) {
  const [lineCount, setLineCount] = useState(200);
  const { data, mutate } = useAdbotLogs(name, lineCount);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data, autoScroll]);

  const lines = data?.lines || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Logs ({data?.total_lines || 0} total)</CardTitle>
        <div className="flex items-center gap-2">
          <select
            value={lineCount}
            onChange={(e) => setLineCount(Number(e.target.value))}
            className="rounded border border-dark-600 bg-dark-800 px-2 py-1 text-xs text-dark-200"
          >
            <option value={100}>100 lines</option>
            <option value={200}>200 lines</option>
            <option value={500}>500 lines</option>
            <option value={1000}>1000 lines</option>
          </select>
          <Button variant="ghost" size="sm" onClick={() => setAutoScroll(!autoScroll)}>
            {autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => mutate()}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <div
        ref={logRef}
        className="h-[600px] overflow-y-auto rounded-lg bg-dark-950 border border-dark-700/50 p-4 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-dark-500">No logs yet — start the bot to see output</p>
        ) : (
          lines.map((line: string, i: number) => (
            <div
              key={i}
              className={`${
                line.includes("[ERROR]") ? "text-danger" :
                line.includes("[WARNING]") ? "text-warning" :
                line.includes("FloodWait") ? "text-warning font-medium" :
                line.includes("sent to") || line.includes("Posted") ? "text-success/70" :
                line.includes("[INFO]") ? "text-dark-300" : "text-dark-400"
              }`}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/* ─── PLAN / BILLING ─── */
function PlanTab({ name, bot, onUpdate }: { name: string; bot: any; onUpdate: () => void }) {
  const { register, handleSubmit } = useForm({
    defaultValues: {
      plan_name: bot.plan_name || "",
      valid_till: bot.valid_till?.split("T")[0] || "",
    },
  });
  const [saving, setSaving] = useState(false);

  const onSubmit = async (data: any) => {
    setSaving(true);
    try {
      await api.patch(`/api/bots/${name}`, { valid_till: data.valid_till });
      toast.success("Plan updated");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
    setSaving(false);
  };

  const plan = bot.plan || {};

  return (
    <div className="space-y-6">
      {/* Current plan info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Current Plan</CardTitle></CardHeader>
          <div className="space-y-2.5 text-sm">
            {([
              ["Plan Name", bot.plan_name || "—"],
              ["Mode", bot.mode],
              ["Sessions", plan.sessions || bot.sessions_count],
              ["Cycle", `${plan.cycle || bot.cycle}s`],
              ["Gap", `${plan.gap || bot.gap}s`],
              ["Valid Until", formatDate(bot.valid_till)],
            ] as [string, any][]).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 border-b border-dark-800 last:border-0">
                <span className="text-dark-400">{k}</span>
                <span className="text-dark-200 font-medium">{String(v)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>Edit Plan / Dates</CardTitle></CardHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input label="Plan Name" disabled value={bot.plan_name || "—"} />
            <Input label="Valid Until" type="date" {...register("valid_till")} />
            <Button type="submit" loading={saving}>
              <Save className="h-4 w-4" /> Update Validity
            </Button>
          </form>
        </Card>
      </div>

      {/* Authorized users */}
      {bot.authorized?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Authorized Users</CardTitle></CardHeader>
          <div className="flex flex-wrap gap-2">
            {bot.authorized.map((uid: number, i: number) => (
              <span key={i} className="rounded bg-accent/10 text-accent px-3 py-1 text-sm font-mono">{uid}</span>
            ))}
          </div>
        </Card>
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
      valid_till: bot.valid_till?.split("T")[0],
    },
  });
  const [loading, setLoading] = useState(false);

  const onSubmit = async (data: BotUpdatePayload) => {
    setLoading(true);
    try {
      await api.patch(`/api/bots/${name}`, data);
      toast.success("Config updated");
      onUpdate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
    setLoading(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader><CardTitle>Edit Configuration</CardTitle></CardHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input label="Cycle (seconds)" type="number" {...register("cycle", { valueAsNumber: true })} />
          <Input label="Gap (seconds)" type="number" {...register("gap", { valueAsNumber: true })} />
          <Input label="Group File" {...register("group_file")} />
          <Input label="Valid Until" type="date" {...register("valid_till")} />
          <Button type="submit" loading={loading}>
            <Save className="h-4 w-4" /> Save Changes
          </Button>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>Current Values</CardTitle></CardHeader>
        <div className="space-y-2 text-sm">
          {([
            ["Cycle", `${bot.cycle}s`],
            ["Gap", `${bot.gap}s`],
            ["Group File", bot.group_file || "—"],
            ["Mode", bot.mode],
            ["Valid Until", formatDate(bot.valid_till)],
            ["Sessions", bot.sessions_count],
            ["State", bot.state],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex justify-between py-1 border-b border-dark-800 last:border-0">
              <span className="text-dark-400">{k}</span>
              <span className="text-dark-200">{v}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ─── REPAIR ─── */
function RepairTab({ name }: { name: string }) {
  const [loading, setLoading] = useState("");

  const repair = async (action: string, label: string) => {
    setLoading(action);
    try {
      await api.post(`/api/bots/${name}/${action}`);
      toast.success(`${label} — done`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `${label} failed`);
    }
    setLoading("");
  };

  const actions = [
    { id: "restart", label: "Force Restart", desc: "Kill workers and restart fresh", icon: RotateCw, color: "text-info" },
    { id: "stop", label: "Force Stop", desc: "Immediately stop all posting", icon: Square, color: "text-danger" },
    { id: "resume", label: "Resume (Unsuspend)", desc: "Clear suspended flag and resume", icon: PlayCircle, color: "text-success" },
  ];

  return (
    <Card>
      <CardHeader><CardTitle>Fix & Repair Actions</CardTitle></CardHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {actions.map((a) => (
          <button
            key={a.id}
            onClick={() => repair(a.id, a.label)}
            disabled={loading === a.id}
            className="flex items-center gap-3 rounded-lg border border-dark-700 bg-dark-800 p-4 text-left hover:border-accent/30 transition-all disabled:opacity-50"
          >
            <a.icon className={`h-5 w-5 ${a.color}`} />
            <div>
              <p className="text-sm font-medium text-dark-200">{a.label}</p>
              <p className="text-xs text-dark-500">{a.desc}</p>
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ─── Helpers ─── */
function QuickStat({ icon: Icon, label, value, color }: { icon: any; label: string; value: number | string; color: string }) {
  return (
    <Card className="text-center !p-4">
      <Icon className={`h-5 w-5 mx-auto mb-1 ${color}`} />
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-dark-500">{label}</p>
    </Card>
  );
}

function StatusRow({ label, ok, okText = "Active", failText = "Inactive" }: { label: string; ok: boolean; okText?: string; failText?: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-dark-800 last:border-0">
      <span className="text-dark-400">{label}</span>
      <span className={`flex items-center gap-1.5 text-sm font-medium ${ok ? "text-success" : "text-danger"}`}>
        {ok ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {ok ? okText : failText}
      </span>
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: any; label: string; value: any }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Icon className="h-3.5 w-3.5 text-dark-500" />
      <span className="text-dark-400 w-20">{label}</span>
      <span className="text-dark-200 font-medium font-mono text-xs">{String(value)}</span>
    </div>
  );
}
