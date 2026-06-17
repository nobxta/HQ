"use client";
import { useState, useEffect, useCallback } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { TableSkeleton } from "@/components/ui/Skeleton";
import {
  HelpCircle, MessageSquare, CheckCircle, Clock, XCircle,
  RefreshCw, Send, AlertTriangle, User, Bot, ChevronDown, ChevronUp,
} from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";

interface Ticket {
  id: string;
  bot_name: string;
  telegram_id: number;
  session_file: string;
  session_name: string;
  issue_type: string;
  diag_status: string | null;
  fail_rate: number | null;
  message: string;
  status: string;
  created_at: number;
  admin_reply: string | null;
  replied_at?: number;
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  const [stats, setStats] = useState({ total: 0, open: 0 });

  const fetchTickets = useCallback(async () => {
    try {
      const r = await api.get("/api/portal/admin/support-tickets");
      setTickets(r.data?.tickets || []);
      setStats({ total: r.data?.total || 0, open: r.data?.open || 0 });
    } catch (err: any) {
      toast.error("Failed to load tickets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  const doReply = async (ticketId: string, newStatus: string) => {
    setReplyLoading(true);
    try {
      const params = new URLSearchParams();
      if (replyText.trim()) params.set("reply", replyText.trim());
      params.set("status", newStatus);
      await api.patch(`/api/portal/admin/support-tickets/${ticketId}?${params.toString()}`);
      toast.success(newStatus === "resolved" ? "Ticket resolved" : "Reply sent");
      setReplyingTo(null);
      setReplyText("");
      fetchTickets();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Failed to update ticket");
    } finally {
      setReplyLoading(false);
    }
  };

  const filtered = tickets.filter((t) => {
    if (filter === "open") return t.status === "open";
    if (filter === "resolved") return t.status === "resolved";
    return true;
  });

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  if (loading) return <TableSkeleton />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Support Tickets</h1>
          <p className="text-sm text-gray-400 mt-1">
            {stats.open > 0 ? `${stats.open} open ticket${stats.open !== 1 ? "s" : ""} need attention` : "No open tickets"}
          </p>
        </div>
        <button onClick={fetchTickets}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/10"><MessageSquare className="h-5 w-5 text-blue-400" /></div>
          <div>
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-gray-400">Total Tickets</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-500/10"><AlertTriangle className="h-5 w-5 text-amber-400" /></div>
          <div>
            <p className="text-2xl font-bold text-amber-400">{stats.open}</p>
            <p className="text-xs text-gray-400">Open</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10"><CheckCircle className="h-5 w-5 text-emerald-400" /></div>
          <div>
            <p className="text-2xl font-bold text-emerald-400">{stats.total - stats.open}</p>
            <p className="text-xs text-gray-400">Resolved</p>
          </div>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(["all", "open", "resolved"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === f ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700"
            }`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f === "open" && stats.open > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs">{stats.open}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tickets list */}
      {filtered.length === 0 ? (
        <Card className="p-12 flex flex-col items-center">
          <HelpCircle className="h-10 w-10 text-gray-600 mb-2" />
          <p className="text-sm text-gray-400">No {filter !== "all" ? filter : ""} tickets</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((t) => {
            const isExpanded = expandedTicket === t.id;
            return (
              <Card key={t.id} className="overflow-hidden">
                {/* Ticket header */}
                <button type="button" onClick={() => setExpandedTicket(isExpanded ? null : t.id)}
                  className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-gray-800/30 transition-colors cursor-pointer">
                  <div className={`p-2 rounded-lg shrink-0 ${t.status === "open" ? "bg-amber-500/10" : "bg-emerald-500/10"}`}>
                    {t.status === "open" ? <AlertTriangle className="h-4 w-4 text-amber-400" /> : <CheckCircle className="h-4 w-4 text-emerald-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-gray-100">{t.session_name}</span>
                      <Badge status={t.status} />
                      {t.issue_type === "healthy_but_failing" && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          Healthy but Failing
                        </span>
                      )}
                      {t.diag_status && (
                        <span className="text-xs text-gray-500">Diag: {t.diag_status}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><Bot className="h-3 w-3" /> {t.bot_name}</span>
                      <span className="flex items-center gap-1"><User className="h-3 w-3" /> {t.telegram_id}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(t.created_at)}</span>
                      {t.fail_rate != null && t.fail_rate > 0 && (
                        <span className="text-red-400">{Math.round(t.fail_rate * 100)}% fail rate</span>
                      )}
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-gray-800 pt-4 space-y-4">
                    {/* User message */}
                    <div className="rounded-lg bg-gray-800/50 border border-gray-700 p-4">
                      <p className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5" /> User Message
                      </p>
                      <p className="text-sm text-gray-200 whitespace-pre-wrap">{t.message}</p>
                    </div>

                    {/* Session details */}
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg bg-gray-800/30 border border-gray-700/50 p-3">
                        <span className="text-gray-500">Session File:</span>
                        <p className="font-mono text-gray-300 mt-0.5">{t.session_file}</p>
                      </div>
                      <div className="rounded-lg bg-gray-800/30 border border-gray-700/50 p-3">
                        <span className="text-gray-500">Issue Type:</span>
                        <p className="text-gray-300 mt-0.5 capitalize">{t.issue_type.replace(/_/g, " ")}</p>
                      </div>
                    </div>

                    {/* Admin reply */}
                    {t.admin_reply && (
                      <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/15 p-4">
                        <p className="text-xs font-semibold text-purple-400 mb-2 flex items-center gap-1.5">
                          <MessageSquare className="h-3.5 w-3.5" /> Admin Reply
                          {t.replied_at && <span className="text-gray-500 font-normal ml-2">{formatTime(t.replied_at)}</span>}
                        </p>
                        <p className="text-sm text-gray-200 whitespace-pre-wrap">{t.admin_reply}</p>
                      </div>
                    )}

                    {/* Reply input */}
                    {replyingTo === t.id ? (
                      <div className="space-y-3">
                        <textarea
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="Write a reply to the user..."
                          rows={3}
                          className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 resize-none focus:outline-none focus:border-purple-500/50"
                        />
                        <div className="flex items-center gap-2">
                          <button onClick={() => doReply(t.id, "resolved")} disabled={replyLoading}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                            {replyLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                            Reply & Resolve
                          </button>
                          <button onClick={() => doReply(t.id, "open")} disabled={replyLoading || !replyText.trim()}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-50">
                            <Send className="h-3.5 w-3.5" /> Reply Only
                          </button>
                          <button onClick={() => { setReplyingTo(null); setReplyText(""); }}
                            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-300">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button onClick={() => setReplyingTo(t.id)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700">
                          <MessageSquare className="h-3.5 w-3.5" /> Reply
                        </button>
                        {t.status === "open" && (
                          <button onClick={() => doReply(t.id, "resolved")}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600/20 border border-emerald-600/20">
                            <CheckCircle className="h-3.5 w-3.5" /> Mark Resolved
                          </button>
                        )}
                        {t.status === "resolved" && (
                          <button onClick={() => doReply(t.id, "open")}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-amber-600/10 text-amber-400 hover:bg-amber-600/20 border border-amber-600/20">
                            <AlertTriangle className="h-3.5 w-3.5" /> Reopen
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
