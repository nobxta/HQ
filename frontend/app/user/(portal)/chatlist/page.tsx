"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePortalBot } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  List, Plus, Trash2, FolderOpen, ExternalLink,
  AlertTriangle, CheckCircle2, XCircle, Loader2,
  RefreshCw, Zap, Search, Users, Download,
  MessageSquare, Sparkles, Globe, Hash,
  Edit3, Save, X, CheckSquare, Square, MinusSquare,
} from "lucide-react";
import toast from "react-hot-toast";

/* ───── Types ───── */

type StepId = "validate" | "join_first" | "scrape" | "join_rest" | "done";
type StepStatus = "waiting" | "active" | "done" | "error";

interface StepState { status: StepStatus; detail?: string }
interface ScrapeStats { current: number; total: number; forums: number; topics: number }
interface JoinStats { done: number; total: number }
interface FinalStats { groups: number; forums: number; joined: number; failed: number; file: string }

interface GroupEntry {
  id: string;
  topic: string;
  title: string;
  raw: string;
}

const STEP_META: Record<StepId, { label: string; desc: string; icon: React.ReactNode }> = {
  validate:   { label: "Validate",  desc: "Checking chatlist link",      icon: <Search className="h-4 w-4" /> },
  join_first: { label: "Join",      desc: "Joining chatlist on session",  icon: <Zap className="h-4 w-4" /> },
  scrape:     { label: "Scan",      desc: "Detecting forums & topics",    icon: <Download className="h-4 w-4" /> },
  join_rest:  { label: "Sync",      desc: "Syncing all sessions",         icon: <Users className="h-4 w-4" /> },
  done:       { label: "Done",      desc: "Setup complete",               icon: <CheckCircle2 className="h-4 w-4" /> },
};
const STEP_ORDER: StepId[] = ["validate", "join_first", "scrape", "join_rest", "done"];

/* ───── Helpers ───── */

function parseGroupLine(line: string): GroupEntry {
  const parts = line.split("|").map(s => s.trim());
  return {
    id: parts[0] || line.trim(),
    topic: parts[1] || "",
    title: parts[2] || "",
    raw: line.trim(),
  };
}

function buildGroupLine(g: GroupEntry): string {
  if (g.topic && g.title) return `${g.id} | ${g.topic} | ${g.title}`;
  if (g.topic) return `${g.id} | ${g.topic}`;
  if (g.title) return `${g.id} || ${g.title}`;
  return g.id;
}

function shortId(id: string): string {
  return id.replace(/^-100/, "");
}

/* ───── Component ───── */

export default function UserChatlistPage() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const session = getPortalSession();

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
  const [editMode, setEditMode] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => { if (bot) setChatlistLinks(bot.custom_chatlist?.links || []); }, [bot]);
  useEffect(() => { if (bot?.group_file) loadGroupFile(); }, [bot?.group_file]);
  useEffect(() => () => { wsRef.current?.close(); wsRef.current = null; }, []);

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const loadGroupFile = async () => {
    if (!bot?.name || !session) return;
    setLoadingGroups(true);
    try {
      const { data } = await portalApi.get(`/api/portal/bot/${encodeURIComponent(bot.name)}/groups?telegram_id=${session.telegram_id}`);
      if (data.groups && Array.isArray(data.groups)) {
        setGroups(data.groups.map((g: any, i: number) => ({
          id: g.id || "",
          topic: g.topic || "",
          title: g.title || "",
          raw: buildGroupLine(g),
        })));
      } else {
        const lines = (data.content || "").split("\n").filter(Boolean);
        setGroups(lines.map(parseGroupLine));
      }
    } catch { setGroups([]); }
    setLoadingGroups(false);
    setSelected(new Set());
    setEditMode(false);
  };

  const saveGroups = async (newGroups: GroupEntry[]) => {
    if (!bot?.name || !session) return;
    setSaving(true);
    try {
      const lines = newGroups.map(buildGroupLine);
      await portalApi.put(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/groups?telegram_id=${session.telegram_id}`,
        { lines }
      );
      setGroups(newGroups);
      setSelected(new Set());
      toast.success("Group list saved");
      mutate();
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

  // Filtered groups for search
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
    return new Promise((resolve, reject) => {
      wsRef.current?.close();
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
      const ws = new WebSocket(`${apiBase}/ws/chatlist/${encodeURIComponent(bot.name)}?token=${session?.access_token}`);
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
                mutate();
                loadGroupFile();
                setTimeout(() => { ws.close(); wsRef.current = null; }, 1000);
                break;
              }
            }
            return;
          }

          if (msg.status === "done") {
            setJoining(false); mutate(); loadGroupFile();
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
      await portalApi.put(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/chatlist?telegram_id=${session?.telegram_id}`,
        { links: chatlistLinks },
        { timeout: 600000 }
      );
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
      await portalApi.put(`/api/portal/bot/${encodeURIComponent(bot.name)}/chatlist?telegram_id=${session?.telegram_id}`, { links: [] }, { timeout: 30000 });
      setChatlistLinks([]);
      setGroups([]);
      toast.success("Chatlist cleared — using default groups");
      mutate();
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

  /* ─── Render ─── */

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
          <p className="text-xs text-dark-500 mt-1">Manage your Telegram chatlist folders &amp; groups</p>
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
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
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
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
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
