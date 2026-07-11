"use client";
import { useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import useSWR from "swr";
import { usePortalBot } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  MessageSquare, Save, Inbox, ExternalLink, Pencil, Power, Eye, X, Search,
  Check, CheckCheck, Copy, RotateCcw, FileText, Image as ImageIcon, Lock, Filter,
} from "lucide-react";
import toast from "react-hot-toast";

/* ── types ────────────────────────────────────────────────────────────── */
interface DmMsg {
  id: string; ts: number;
  session_file?: string; account_username?: string; account_name?: string; account_user_id?: number;
  sender_id?: number; sender_name?: string; sender_username?: string;
  text?: string; media_type?: string; caption?: string;
  reply_status?: string; reply_text?: string; read?: boolean;
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fullTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function initials(name?: string): string {
  const n = (name || "").trim();
  if (!n) return "?";
  const parts = n.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}
function mediaPhrase(mt: string): string {
  const m = mt.toLowerCase();
  if (m.includes("voice")) return "Voice message received";
  if (m.includes("video note")) return "Video note received";
  if (m === "gif") return "GIF received";
  if (m) return `${mt} received`;
  return "";
}
function messageSummary(m: DmMsg): { text: string; muted: boolean } {
  if (m.media_type) {
    const p = mediaPhrase(m.media_type);
    return { text: m.caption ? `${p} — ${m.caption}` : p, muted: !m.caption };
  }
  const t = (m.text || "").trim();
  if (!t) return { text: "Message contains no text", muted: true };
  return { text: t, muted: false };
}
const STATUS_META: Record<string, { label: string; cls: string }> = {
  sent: { label: "Reply Sent", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25" },
  failed: { label: "Reply Failed", cls: "bg-red-500/15 text-red-300 border-red-500/25" },
  disabled: { label: "Auto Reply Disabled", cls: "bg-dark-700 text-dark-400 border-dark-600" },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-300 border-amber-500/25" },
  skipped: { label: "Skipped", cls: "bg-dark-700 text-dark-400 border-dark-600" },
};
function StatusBadge({ status }: { status?: string }) {
  const meta = STATUS_META[(status || "").toLowerCase()];
  if (!meta) return null;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>;
}
const avatarColors = ["bg-violet-500/20 text-violet-300", "bg-sky-500/20 text-sky-300", "bg-emerald-500/20 text-emerald-300", "bg-amber-500/20 text-amber-300", "bg-pink-500/20 text-pink-300", "bg-cyan-500/20 text-cyan-300"];
function avatarColor(id?: number): string { return avatarColors[Math.abs(id || 0) % avatarColors.length]; }

/* ── page ─────────────────────────────────────────────────────────────── */
export default function UserAutoReplyPage() {
  const { data: bot, isLoading, mutate: mutateBot } = usePortalBot();
  const session = getPortalSession();
  const botName = bot?.name ? encodeURIComponent(bot.name) : "";

  const inboxUrl = bot ? `/api/portal/bot/${botName}/dm-inbox?telegram_id=${session?.telegram_id}` : null;
  const { data: inbox, isValidating, mutate: mutateInbox } = useSWR<{ messages: DmMsg[]; accounts: string[]; unread_count: number }>(
    inboxUrl,
    (url: string) => portalApi.get(url).then((r) => r.data),
    { refreshInterval: 12000 }
  );

  const [selected, setSelected] = useState<DmMsg | null>(null);

  // Deep-link: open a specific message when arriving from a notification (?msg=<id>).
  useEffect(() => {
    if (!inbox?.messages) return;
    const id = new URLSearchParams(window.location.search).get("msg");
    if (id) {
      const m = inbox.messages.find((x) => x.id === id);
      if (m) setSelected(m);
    }
  }, [inbox?.messages]);

  const markRead = useCallback(async (id: string) => {
    if (!bot) return;
    try {
      await portalApi.post(`/api/portal/bot/${botName}/dm-inbox/${id}/read?telegram_id=${session?.telegram_id}`);
      mutateInbox();
    } catch { /* silent */ }
  }, [bot, botName, session?.telegram_id, mutateInbox]);

  const markAllRead = useCallback(async () => {
    if (!bot) return;
    try {
      await portalApi.post(`/api/portal/bot/${botName}/dm-inbox/read?telegram_id=${session?.telegram_id}`);
      toast.success("All messages marked read");
      mutateInbox();
    } catch { toast.error("Failed"); }
  }, [bot, botName, session?.telegram_id, mutateInbox]);

  const openMessage = (m: DmMsg) => { setSelected(m); if (!m.read) markRead(m.id); };

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const messages = inbox?.messages || [];
  const lastTs = messages[0]?.ts;
  const enabled = bot.dm_autoreply?.enabled ?? true;

  return (
    <div className="max-w-[1200px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Auto Reply</h1>
          <p className="text-sm text-dark-400 mt-0.5 max-w-lg">Automatically reply when someone messages one of your connected advertising accounts.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${enabled ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25" : "bg-dark-700 text-dark-400 border-dark-600"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-emerald-400" : "bg-dark-500"}`} />
            {enabled ? "Active" : "Disabled"}
          </span>
          {lastTs && <span className="hidden sm:inline text-xs text-dark-500">Last activity {timeAgo(lastTs)}</span>}
          <Button variant="secondary" size="sm" onClick={() => { mutateBot(); mutateInbox(); }} loading={isValidating}>
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <ConfigCard bot={bot} botName={botName} telegramId={session?.telegram_id} onSaved={mutateBot} />

      <DirectMessages
        messages={messages}
        accounts={inbox?.accounts || []}
        unread={inbox?.unread_count || 0}
        onOpen={openMessage}
        onMarkRead={markRead}
        onMarkAll={markAllRead}
      />

      {selected && (
        <DetailsDrawer msg={selected} botUsername={bot.bot_username} onClose={() => setSelected(null)} onMarkRead={markRead} />
      )}
    </div>
  );
}

/* ── config card ──────────────────────────────────────────────────────── */
function ConfigCard({ bot, botName, telegramId, onSaved }: { bot: any; botName: string; telegramId?: number; onSaved: () => void }) {
  const enabled = bot.dm_autoreply?.enabled ?? true;
  const savedMsg = bot.dm_autoreply?.message || "";
  const updatedAt = bot.dm_autoreply?.updated_at || "";
  const defaultMsg = bot.dm_autoreply_default || "";
  const footer = bot.dm_autoreply_footer || "";

  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(savedMsg);
  const [saving, setSaving] = useState(false);
  const [togglingBusy, setTogglingBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => { setMsg(savedMsg); }, [savedMsg]);

  const body = (msg.trim() || defaultMsg);
  const finalPreview = footer && !body.includes(footer) ? `${body}\n\n${footer}` : body;
  const currentBody = (savedMsg.trim() || defaultMsg);
  const currentPreview = footer && !currentBody.includes(footer) ? `${currentBody}\n\n${footer}` : currentBody;

  const put = async (payload: any, okMsg: string) => {
    await portalApi.put(`/api/portal/bot/${botName}/autoreply?telegram_id=${telegramId}`, payload);
    toast.success(okMsg);
    onSaved();
  };

  const save = async () => {
    setSaving(true);
    try { await put({ enabled, message: msg }, "Auto-reply saved"); setEditing(false); }
    catch (e: any) { toast.error(e?.response?.data?.detail || "Failed to save"); }
    setSaving(false);
  };
  const toggle = async () => {
    setTogglingBusy(true);
    try { await put({ enabled: !enabled }, !enabled ? "Auto-reply enabled" : "Auto-reply turned off"); }
    catch (e: any) { toast.error(e?.response?.data?.detail || "Failed"); }
    setTogglingBusy(false);
  };

  return (
    <Card className="!p-0 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-dark-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${enabled ? "bg-accent/15 text-accent" : "bg-dark-800 text-dark-500"}`}>
            <MessageSquare className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-dark-100">Auto Reply Message</p>
            <p className="text-xs">
              Status <span className={enabled ? "text-emerald-400 font-medium" : "text-dark-400 font-medium"}>{enabled ? "Active" : "Disabled"}</span>
              {updatedAt && <span className="text-dark-500"> · updated {timeAgo(new Date(updatedAt).getTime() / 1000)}</span>}
            </p>
          </div>
        </div>
        <button
          onClick={toggle} disabled={togglingBusy}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-accent" : "bg-dark-600"}`}
          role="switch" aria-checked={enabled}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>

      {/* Body */}
      {!enabled && !editing ? (
        <div className="px-4 sm:px-5 py-5 text-center">
          <p className="text-sm text-dark-400">Auto-reply is off — no messages are being sent.</p>
          <p className="text-xs text-dark-500 mt-1">Your saved message is kept for when you turn it back on.</p>
          <Button size="sm" className="mt-3" onClick={toggle} loading={togglingBusy}><Power className="h-4 w-4" /> Enable Auto Reply</Button>
        </div>
      ) : !editing ? (
        <div className="px-4 sm:px-5 py-4 space-y-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-dark-500 mb-1">Current message</p>
            <p className="text-sm text-dark-200">{savedMsg.trim() || <span className="text-dark-400 italic">Default: {defaultMsg}</span>}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-dark-500 mb-1 inline-flex items-center gap-1"><Lock className="h-3 w-3" /> Fixed footer</p>
            <p className="text-xs text-dark-400 whitespace-pre-wrap">{footer}</p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={() => { setMsg(savedMsg); setEditing(true); }}><Pencil className="h-3.5 w-3.5" /> Edit Message</Button>
            <Button size="sm" variant="secondary" onClick={() => setPreviewOpen(true)}><Eye className="h-3.5 w-3.5" /> Preview Reply</Button>
            <Button size="sm" variant="ghost" onClick={toggle} loading={togglingBusy}><Power className="h-3.5 w-3.5" /> Turn Off</Button>
          </div>
        </div>
      ) : (
        <div className="px-4 sm:px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-dark-300 mb-1.5">Your message</label>
            <textarea
              className="w-full h-28 rounded-xl border border-dark-600 bg-dark-950 px-3 py-2.5 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
              value={msg} onChange={(e) => setMsg(e.target.value.slice(0, 500))} placeholder={defaultMsg} maxLength={500}
            />
            <div className="flex items-center justify-between mt-1.5">
              <div className="flex gap-2">
                <button onClick={() => setMsg("")} className="text-[11px] text-dark-400 hover:text-dark-200">Use default message</button>
                <span className="text-dark-700">·</span>
                <button onClick={() => setMsg(savedMsg)} className="text-[11px] text-dark-400 hover:text-dark-200">Reset changes</button>
              </div>
              <span className="text-[11px] text-dark-500">{msg.length}/500</span>
            </div>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-dark-500 mb-1">Final reply preview</p>
            <div className="rounded-xl border border-dark-800 bg-dark-900 px-3 py-3 text-[13px] text-dark-200 whitespace-pre-wrap">{finalPreview}</div>
            <p className="text-[10px] text-dark-500 mt-1 inline-flex items-center gap-1"><Lock className="h-2.5 w-2.5" /> The HQAdz footer is added automatically and can&apos;t be removed.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setMsg(savedMsg); }}>Cancel</Button>
            <Button size="sm" onClick={save} loading={saving}><Save className="h-4 w-4" /> Save Changes</Button>
          </div>
        </div>
      )}

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Reply preview" size="sm">
        <p className="text-xs text-dark-400 mb-2">This is exactly what a sender receives:</p>
        <div className="rounded-xl border border-dark-700 bg-dark-950 px-3.5 py-3 text-sm text-dark-200 whitespace-pre-wrap">{currentPreview}</div>
      </Modal>
    </Card>
  );
}

/* ── direct messages ──────────────────────────────────────────────────── */
function DirectMessages({ messages, accounts, unread, onOpen, onMarkRead, onMarkAll }: {
  messages: DmMsg[]; accounts: string[]; unread: number;
  onOpen: (m: DmMsg) => void; onMarkRead: (id: string) => void; onMarkAll: () => void;
}) {
  const [search, setSearch] = useState("");
  const [acct, setAcct] = useState("");
  const [readF, setReadF] = useState("");
  const [typeF, setTypeF] = useState("");
  const [fromD, setFromD] = useState("");
  const [toD, setToD] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const types = useMemo(() => Array.from(new Set(messages.map((m) => m.media_type || "Text"))).sort(), [messages]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = fromD ? new Date(fromD + "T00:00:00").getTime() / 1000 : 0;
    const toTs = toD ? new Date(toD + "T23:59:59").getTime() / 1000 : Infinity;
    return messages.filter((m) => {
      if (acct && m.session_file !== acct) return false;
      if (readF === "unread" && m.read) return false;
      if (readF === "read" && !m.read) return false;
      if (typeF && (m.media_type || "Text") !== typeF) return false;
      if (m.ts < fromTs || m.ts > toTs) return false;
      if (q) {
        const hay = [m.sender_name, m.sender_username, String(m.sender_id || ""), m.account_name, m.account_username, m.session_file, m.text, m.caption].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [messages, search, acct, readF, typeF, fromD, toD]);

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Inbox className="h-4.5 w-4.5 text-dark-300" />
          <h2 className="text-base font-bold text-dark-100">Direct Messages</h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${unread > 0 ? "bg-accent/20 text-accent" : "bg-dark-800 text-dark-400"}`}>
            {unread > 0 ? `${unread} unread` : `${messages.length} message${messages.length !== 1 ? "s" : ""}`}
          </span>
        </div>
        {unread > 0 && (
          <button onClick={onMarkAll} className="text-xs text-dark-400 hover:text-accent inline-flex items-center gap-1"><CheckCheck className="h-3.5 w-3.5" /> Mark all read</button>
        )}
      </div>

      {/* Toolbar */}
      <div className="mb-3 space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages, senders, accounts…"
              className="w-full rounded-xl border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <button onClick={() => setShowFilters((v) => !v)} className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors ${showFilters ? "border-accent/40 text-accent bg-accent/10" : "border-dark-600 text-dark-300 hover:text-dark-100"}`}>
            <Filter className="h-4 w-4" /> <span className="hidden sm:inline">Filters</span>
          </button>
        </div>
        {showFilters && (
          <div className="flex flex-wrap gap-2 rounded-xl border border-dark-700/60 bg-dark-900/50 p-2.5">
            <Sel value={acct} onChange={setAcct} all="All accounts" opts={accounts} />
            <Sel value={readF} onChange={setReadF} all="All" opts={["unread", "read"]} labelMap={{ unread: "Unread", read: "Read" }} />
            <Sel value={typeF} onChange={setTypeF} all="All types" opts={types} />
            <div className="flex items-center gap-1">
              <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
              <span className="text-dark-600 text-xs">→</span>
              <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
          </div>
        )}
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <Card className="text-center py-12">
          <MessageSquare className="h-9 w-9 text-dark-600 mx-auto mb-2.5" />
          <p className="text-sm text-dark-300 font-medium">{messages.length === 0 ? "No messages yet" : "No messages match your filters"}</p>
          <p className="text-xs text-dark-500 mt-1">{messages.length === 0 ? "DMs to your advertising accounts will appear here." : "Try adjusting the search or filters."}</p>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {rows.map((m) => <MessageCard key={m.id} m={m} onOpen={onOpen} onMarkRead={onMarkRead} />)}
        </div>
      )}
    </div>
  );
}

function MessageCard({ m, onOpen, onMarkRead }: { m: DmMsg; onOpen: (m: DmMsg) => void; onMarkRead: (id: string) => void }) {
  const sum = messageSummary(m);
  const unread = !m.read;
  return (
    <div
      onClick={() => onOpen(m)}
      className={`group relative rounded-2xl border bg-dark-900 p-3.5 sm:p-4 cursor-pointer transition-all hover:border-dark-600 ${unread ? "border-accent/30 bg-accent/[0.03]" : "border-dark-700/60"}`}
    >
      {unread && <span className="absolute left-0 top-4 bottom-4 w-0.5 rounded-full bg-accent" />}
      <div className="flex gap-3">
        <div className={`shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-bold ${avatarColor(m.sender_id)}`}>{initials(m.sender_name)}</div>
        <div className="flex-1 min-w-0">
          {/* top row */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-dark-100 truncate">{m.sender_name || "Unknown sender"}</span>
            {m.sender_username && <span className="text-xs text-dark-500 truncate">@{m.sender_username}</span>}
            {unread && <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />}
            <span className="ml-auto text-[11px] text-dark-500 shrink-0">{timeAgo(m.ts)}</span>
          </div>
          {/* preview */}
          <p className={`text-[13px] mt-1 line-clamp-2 ${sum.muted ? "text-dark-500 italic" : "text-dark-200"}`}>
            {m.media_type && <ImageIcon className="inline h-3.5 w-3.5 mr-1 -mt-0.5 text-dark-400" />}
            {sum.text}
          </p>
          {/* metadata */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-[11px] text-dark-500">
            <span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" /> {m.session_file || m.account_username || "account"}</span>
            <StatusBadge status={m.reply_status} />
          </div>
        </div>
        {/* actions */}
        <div className="shrink-0 flex flex-col items-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {m.sender_id ? (
            <a href={`tg://user?id=${m.sender_id}`} onClick={(e) => e.stopPropagation()} className="p-1.5 rounded-lg text-dark-400 hover:text-accent hover:bg-dark-800" title="Open sender"><ExternalLink className="h-3.5 w-3.5" /></a>
          ) : null}
          {unread && (
            <button onClick={(e) => { e.stopPropagation(); onMarkRead(m.id); }} className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800" title="Mark read"><Check className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── details drawer ───────────────────────────────────────────────────── */
function DetailsDrawer({ msg, botUsername, onClose, onMarkRead }: { msg: DmMsg; botUsername?: string; onClose: () => void; onMarkRead: (id: string) => void }) {
  const sum = messageSummary(msg);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const copy = (v: string, label: string) => { navigator.clipboard.writeText(v); toast.success(`${label} copied`); };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-md h-full bg-dark-950 sm:border-l border-dark-700 overflow-y-auto animate-in slide-in-from-right duration-200">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-dark-700 bg-dark-950">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-bold ${avatarColor(msg.sender_id)}`}>{initials(msg.sender_name)}</div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-dark-100 truncate">{msg.sender_name || "Unknown sender"}</h3>
              <p className="text-[11px] text-dark-500">{fullTime(msg.ts)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge status={msg.reply_status} />
            {!msg.read && <span className="text-[11px] text-accent">● Unread</span>}
          </div>

          <Section title="Sender">
            <Field label="Name" value={msg.sender_name || "Unknown"} />
            <Field label="Username" value={msg.sender_username ? `@${msg.sender_username}` : undefined} />
            <Field label="Telegram ID" value={msg.sender_id ? <Tg id={msg.sender_id}>{msg.sender_id}</Tg> : undefined} mono />
          </Section>

          <Section title="Receiving account">
            <Field label="Name" value={msg.account_name || undefined} />
            <Field label="Username" value={msg.account_username ? `@${msg.account_username}` : undefined} />
            <Field label="Session file" value={<Tg id={msg.account_user_id}>{msg.session_file}</Tg>} mono />
            <Field label="Telegram ID" value={msg.account_user_id ? <Tg id={msg.account_user_id}>{msg.account_user_id}</Tg> : undefined} mono />
            <Field label="AdBot" value={botUsername ? `@${botUsername}` : undefined} />
          </Section>

          <Section title="Message">
            {msg.media_type && <Field label="Media" value={msg.media_type} />}
            {msg.media_type && msg.caption && <Field label="Caption" value={msg.caption} />}
            {!msg.media_type && <div className="py-2"><p className={`text-[13px] whitespace-pre-wrap break-words ${sum.muted ? "text-dark-500 italic" : "text-dark-200"}`}>{sum.text}</p></div>}
            <Field label="Received" value={fullTime(msg.ts)} />
          </Section>

          <Section title="Automatic reply">
            <Field label="Status" value={msg.reply_status ? <StatusBadge status={msg.reply_status} /> : "—"} />
            {msg.reply_text ? (
              <div className="py-2"><p className="text-[11px] text-dark-500 mb-1">Reply sent</p><p className="text-[13px] text-dark-200 whitespace-pre-wrap break-words">{msg.reply_text}</p></div>
            ) : (
              <Field label="Reply" value={msg.reply_status === "disabled" ? "Auto-reply was off" : msg.reply_status === "pending" ? "Skipped (recent cooldown)" : msg.reply_status === "failed" ? "Reply could not be delivered" : "—"} />
            )}
          </Section>

          <div className="grid grid-cols-2 gap-2 pt-1">
            {msg.sender_id ? <a href={`tg://user?id=${msg.sender_id}`} className="col-span-2"><Button size="sm" className="w-full"><ExternalLink className="h-4 w-4" /> Open Sender Profile</Button></a> : null}
            {msg.sender_id ? <Button size="sm" variant="secondary" onClick={() => copy(String(msg.sender_id), "Sender ID")}><Copy className="h-3.5 w-3.5" /> Copy ID</Button> : null}
            <Button size="sm" variant="secondary" onClick={() => copy(msg.text || msg.caption || "", "Message")}><Copy className="h-3.5 w-3.5" /> Copy Message</Button>
            {!msg.read && <Button size="sm" variant="ghost" className="col-span-2" onClick={() => onMarkRead(msg.id)}><Check className="h-4 w-4" /> Mark as Read</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── small shared ─────────────────────────────────────────────────────── */
function Sel({ value, onChange, all, opts, labelMap }: { value: string; onChange: (v: string) => void; all: string; opts: string[]; labelMap?: Record<string, string> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2.5 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
      <option value="">{all}</option>
      {opts.map((o) => <option key={o} value={o}>{labelMap?.[o] || o}</option>)}
    </select>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-dark-400 mb-1">{title}</p>
      <div className="rounded-xl border border-dark-800 bg-dark-900/50 px-3">{children}</div>
    </div>
  );
}
function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-dark-800/50 last:border-0">
      <span className="text-[12px] text-dark-500 shrink-0">{label}</span>
      <span className={`text-[12px] text-dark-100 text-right break-words ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
function Tg({ id, children }: { id?: number; children: ReactNode }) {
  if (!id) return <>{children}</>;
  return <a href={`tg://user?id=${id}`} className="inline-flex items-center gap-1 text-accent hover:underline" title="Open Telegram profile">{children} <ExternalLink className="h-3 w-3" /></a>;
}
