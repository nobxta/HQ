"use client";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import useSWR from "swr";
import api from "@/lib/api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { TableSkeleton } from "@/components/ui/Skeleton";
import {
  MessageSquare, RefreshCw, ExternalLink, Lock, Save, RotateCcw, Pencil, X,
  Search, ChevronRight, User, Bot, AtSign, FileText, CheckCircle2, XCircle,
  MinusCircle, Clock, Image as ImageIcon,
} from "lucide-react";
import { formatDateTime, telegramProfileUrl } from "@/lib/utils";
import toast from "react-hot-toast";

interface DmRow {
  id: string;
  ts: number;
  session_file?: string;
  account_username?: string;
  account_name?: string;
  account_user_id?: number;
  sender_id?: number;
  sender_name?: string;
  sender_username?: string;
  text?: string;
  media_type?: string;
  caption?: string;
  reply_status?: string;
  reply_text?: string;
  bot_name?: string;
  bot_username?: string;
  owner_id?: number;
  owner_name?: string;
  owner_email?: string;
}

const fetcher = (url: string) => api.get(url).then((r) => r.data);

/* ── presentation helpers ─────────────────────────────────────────────── */
function mediaPhrase(mt: string): string {
  const m = mt.toLowerCase();
  if (m.includes("voice")) return "Voice message received";
  if (m.includes("video note")) return "Video note received";
  if (m === "gif") return "GIF received";
  if (m) return `${mt} received`;
  return "";
}
function messageSummary(r: DmRow): { text: string; muted: boolean } {
  if (r.media_type) {
    const p = mediaPhrase(r.media_type);
    return { text: r.caption ? `${p} — ${r.caption}` : p, muted: !r.caption };
  }
  const t = (r.text || "").trim();
  if (!t) return { text: "No text message", muted: true };
  return { text: t, muted: false };
}
function ownerLabel(r: DmRow): string {
  return r.owner_name || r.owner_email || (r.owner_id ? `ID ${r.owner_id}` : "—");
}

const STATUS_META: Record<string, { label: string; cls: string; Icon: any }> = {
  sent: { label: "Sent", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-300 border-red-500/30", Icon: XCircle },
  disabled: { label: "Disabled", cls: "bg-dark-700 text-dark-400 border-dark-600", Icon: MinusCircle },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", Icon: Clock },
};
function StatusBadge({ status }: { status?: string }) {
  const meta = STATUS_META[(status || "").toLowerCase()];
  if (!meta) return <span className="text-dark-500 text-xs">—</span>;
  const { label, cls, Icon } = meta;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */
export default function AdminDmInboxPage() {
  const { data, isValidating, mutate } = useSWR<{ messages: DmRow[]; bots: string[]; accounts: string[] }>(
    "/api/system/dm-inbox",
    fetcher,
    { refreshInterval: 15000 }
  );

  const [search, setSearch] = useState("");
  const [botF, setBotF] = useState("");
  const [ownerF, setOwnerF] = useState("");
  const [acctF, setAcctF] = useState("");
  const [typeF, setTypeF] = useState("");
  const [statusF, setStatusF] = useState("");
  const [fromD, setFromD] = useState("");
  const [toD, setToD] = useState("");
  const [selected, setSelected] = useState<DmRow | null>(null);

  const allRows = data?.messages || [];

  const owners = useMemo(
    () => Array.from(new Set(allRows.map(ownerLabel).filter((o) => o && o !== "—"))).sort(),
    [allRows]
  );
  const types = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.media_type || "Text"))).sort(),
    [allRows]
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = fromD ? new Date(fromD + "T00:00:00").getTime() / 1000 : 0;
    const toTs = toD ? new Date(toD + "T23:59:59").getTime() / 1000 : Infinity;
    return allRows.filter((r) => {
      if (botF && r.bot_name !== botF) return false;
      if (ownerF && ownerLabel(r) !== ownerF) return false;
      if (acctF && r.session_file !== acctF) return false;
      if (typeF && (r.media_type || "Text") !== typeF) return false;
      if (statusF && (r.reply_status || "").toLowerCase() !== statusF) return false;
      if (r.ts < fromTs || r.ts > toTs) return false;
      if (q) {
        const hay = [
          r.bot_name, r.bot_username, ownerLabel(r), r.session_file, r.account_name,
          r.account_username, r.sender_name, r.sender_username, String(r.sender_id || ""),
          r.text, r.caption,
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRows, search, botF, ownerF, acctF, typeF, statusF, fromD, toD]);

  const anyFilter = search || botF || ownerF || acctF || typeF || statusF || fromD || toD;
  const clearFilters = () => {
    setSearch(""); setBotF(""); setOwnerF(""); setAcctF(""); setTypeF(""); setStatusF(""); setFromD(""); setToD("");
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-dark-100">Auto Reply</h2>
          <p className="text-sm text-dark-400 mt-1">
            {rows.length}{rows.length !== allRows.length ? ` of ${allRows.length}` : ""} DM{allRows.length !== 1 ? "s" : ""} across all AdBots
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => mutate()} loading={isValidating}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <FooterCard />

      {/* Filters */}
      <Card className="!p-4">
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bot, owner, session, account, sender, ID, or message…"
              className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Sel value={botF} onChange={setBotF} all="All AdBots" opts={data?.bots || []} />
            <Sel value={ownerF} onChange={setOwnerF} all="All owners" opts={owners} />
            <Sel value={acctF} onChange={setAcctF} all="All accounts" opts={data?.accounts || []} />
            <Sel value={typeF} onChange={setTypeF} all="All types" opts={types} />
            <Sel value={statusF} onChange={setStatusF} all="All statuses" opts={["sent", "failed", "disabled", "pending"]} labelMap={{ sent: "Sent", failed: "Failed", disabled: "Disabled", pending: "Pending" }} />
            <div className="flex items-center gap-1">
              <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
              <span className="text-dark-600 text-xs">→</span>
              <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
            {anyFilter && (
              <button onClick={clearFilters} className="inline-flex items-center gap-1 rounded-lg border border-dark-600 px-2.5 py-1.5 text-xs text-dark-400 hover:text-dark-200 hover:border-dark-500 transition-colors">
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* List */}
      {!data ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <Card className="text-center py-14">
          <MessageSquare className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-300 font-medium">{anyFilter ? "No DMs match your filters" : "No DMs received yet"}</p>
          <p className="text-xs text-dark-500 mt-1">{anyFilter ? "Try clearing some filters." : "Incoming DMs to your posting accounts will appear here."}</p>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-dark-700/50">
            <table className="w-full text-sm">
              <thead className="bg-dark-850 border-b border-dark-700">
                <tr className="text-left text-xs uppercase tracking-wider text-dark-400">
                  <th className="px-4 py-3 font-medium">Received</th>
                  <th className="px-4 py-3 font-medium">AdBot / Owner</th>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium">Sender</th>
                  <th className="px-4 py-3 font-medium">Message</th>
                  <th className="px-4 py-3 font-medium">Reply</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-800/60">
                {rows.map((r) => {
                  const sum = messageSummary(r);
                  return (
                    <tr key={r.id} onClick={() => setSelected(r)} className="bg-dark-900 hover:bg-dark-800/50 transition-colors cursor-pointer">
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-dark-400 align-top">{formatDateTime(r.ts)}</td>
                      <td className="px-4 py-3 align-top">
                        <div className="text-dark-100 text-[13px]">{r.bot_username ? `@${r.bot_username}` : r.bot_name}</div>
                        <div className="text-[11px] text-dark-500">{ownerLabel(r)}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="text-[13px] text-dark-200">{r.account_name || "—"}</div>
                        <div className="text-[11px] text-dark-500">{r.account_username ? `@${r.account_username}` : (r.session_file || "")}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="text-[13px] text-dark-100">{r.sender_name || "Unknown"}</div>
                        <div className="text-[11px] text-dark-500">{r.sender_username ? `@${r.sender_username}` : (r.sender_id ? `ID ${r.sender_id}` : "")}</div>
                      </td>
                      <td className="px-4 py-3 align-top max-w-[280px]">
                        <p className={`text-[13px] truncate ${sum.muted ? "text-dark-500 italic" : "text-dark-200"}`}>{sum.text}</p>
                      </td>
                      <td className="px-4 py-3 align-top"><StatusBadge status={r.reply_status} /></td>
                      <td className="px-4 py-3 align-top text-dark-600"><ChevronRight className="h-4 w-4" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {rows.map((r) => {
              const sum = messageSummary(r);
              return (
                <button key={r.id} onClick={() => setSelected(r)} className="w-full text-left rounded-xl border border-dark-700/50 bg-dark-900 p-4 hover:border-dark-600 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[13px] font-semibold text-dark-100">{r.bot_username ? `@${r.bot_username}` : r.bot_name}</span>
                    <StatusBadge status={r.reply_status} />
                  </div>
                  <div className="text-[11px] text-dark-500 mb-2">{formatDateTime(r.ts)} · owner {ownerLabel(r)}</div>
                  <div className="text-[12px] text-dark-300"><span className="text-dark-500">From</span> {r.sender_name || "Unknown"}{r.sender_username ? ` @${r.sender_username}` : ""}</div>
                  <div className="text-[12px] text-dark-400"><span className="text-dark-500">To</span> {r.account_name || r.account_username || r.session_file}</div>
                  <p className={`text-[13px] mt-2 line-clamp-2 ${sum.muted ? "text-dark-500 italic" : "text-dark-200"}`}>{sum.text}</p>
                </button>
              );
            })}
          </div>
        </>
      )}

      {selected && <DetailDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Sel({ value, onChange, all, opts, labelMap }: { value: string; onChange: (v: string) => void; all: string; opts: string[]; labelMap?: Record<string, string> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2.5 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
      <option value="">{all}</option>
      {opts.map((o) => <option key={o} value={o}>{labelMap?.[o] || o}</option>)}
    </select>
  );
}

/* ── side drawer ──────────────────────────────────────────────────────── */
function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === "" ) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-dark-800/50 last:border-0">
      <span className="text-[12px] text-dark-500 shrink-0">{label}</span>
      <span className={`text-[12px] text-dark-100 text-right break-words ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
// Only a public @username can be opened from a browser (https://t.me/<username>).
// A bare numeric ID has no working web link, so it renders as plain text instead of
// a dead "profile" button.
function TgLink({ id, username, children }: { id?: number; username?: string; children: ReactNode }) {
  if (!id) return <>{children}</>;
  const url = telegramProfileUrl(username);
  if (!url) return <span className="text-dark-100">{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline" title="Open Telegram profile">
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  );
}
function Section({ icon: Icon, title, children }: { icon: any; title: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-dark-300"><Icon className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold uppercase tracking-wider">{title}</span></div>
      <div className="rounded-lg border border-dark-800 bg-dark-900/50 px-3">{children}</div>
    </div>
  );
}

function DetailDrawer({ row, onClose }: { row: DmRow; onClose: () => void }) {
  const sum = messageSummary(row);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-dark-950 border-l border-dark-700 overflow-y-auto animate-in slide-in-from-right duration-200">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-dark-700 bg-dark-950">
          <div>
            <h3 className="text-base font-bold text-dark-100">DM Detail</h3>
            <p className="text-[11px] text-dark-500">{formatDateTime(row.ts)}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={row.reply_status} />
            <button onClick={onClose} className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <Section icon={Bot} title="AdBot">
            <Field label="Bot" value={row.bot_username ? `@${row.bot_username}` : row.bot_name} />
            <Field label="Owner" value={row.owner_name || row.owner_email || undefined} />
            <Field label="Owner ID" value={row.owner_id ? <TgLink id={row.owner_id}>{row.owner_id}</TgLink> : undefined} mono />
          </Section>

          <Section icon={User} title="Receiving Account">
            <Field label="Name" value={row.account_name || undefined} />
            <Field label="Username" value={row.account_username ? `@${row.account_username}` : undefined} />
            <Field label="Session file" value={<TgLink id={row.account_user_id} username={row.account_username}>{row.session_file}</TgLink>} mono />
            <Field label="Telegram ID" value={row.account_user_id ? <TgLink id={row.account_user_id} username={row.account_username}>{row.account_user_id}</TgLink> : undefined} mono />
          </Section>

          <Section icon={AtSign} title="Sender">
            <Field label="Name" value={row.sender_name || "Unknown"} />
            <Field label="Username" value={row.sender_username ? `@${row.sender_username}` : undefined} />
            <Field label="Telegram ID" value={row.sender_id ? <TgLink id={row.sender_id} username={row.sender_username}>{row.sender_id}</TgLink> : undefined} mono />
          </Section>

          <Section icon={row.media_type ? ImageIcon : FileText} title="Message">
            {row.media_type && <Field label="Media" value={row.media_type} />}
            {row.media_type && row.caption && <Field label="Caption" value={row.caption} />}
            {!row.media_type && (
              <div className="py-2">
                <p className={`text-[13px] whitespace-pre-wrap break-words ${sum.muted ? "text-dark-500 italic" : "text-dark-200"}`}>{sum.text}</p>
              </div>
            )}
          </Section>

          <Section icon={MessageSquare} title="Auto-Reply">
            <Field label="Status" value={<StatusBadge status={row.reply_status} />} />
            {row.reply_text ? (
              <div className="py-2">
                <p className="text-[11px] text-dark-500 mb-1">Reply sent</p>
                <p className="text-[13px] text-dark-200 whitespace-pre-wrap break-words">{row.reply_text}</p>
              </div>
            ) : (
              <Field label="Reply" value={row.reply_status === "disabled" ? "Auto-reply is off" : row.reply_status === "pending" ? "Skipped (recent cooldown)" : "—"} />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ── footer card (collapsible) ────────────────────────────────────────── */
function FooterCard() {
  const { data, mutate } = useSWR<{ footer: string; updated_at?: string; default: string }>(
    "/api/system/dm-inbox/footer",
    fetcher
  );
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data?.footer !== undefined) setVal(data.footer); }, [data?.footer]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/api/system/dm-inbox/footer", { footer: val });
      toast.success("Footer saved");
      await mutate();
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save footer");
    }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><Lock className="h-4 w-4 inline mr-2" />Auto-Reply Footer</CardTitle>
        {!editing ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit Footer</Button>
        ) : (
          data?.default !== undefined && val !== data.default && (
            <button onClick={() => setVal(data.default)} className="text-xs text-dark-500 hover:text-dark-200 inline-flex items-center gap-1"><RotateCcw className="h-3 w-3" /> Reset to default</button>
          )
        )}
      </CardHeader>

      {!editing ? (
        <div>
          <div className="rounded-lg border border-dark-800 bg-dark-950 px-3 py-2.5 text-sm text-dark-300 whitespace-pre-wrap">{data?.footer ?? "…"}</div>
          <p className="text-[11px] text-dark-500 mt-2">
            Added after every auto-reply (two lines below the user&apos;s message). Only admins can change it.
            {data?.updated_at ? ` · Last updated ${formatDateTime(new Date(data.updated_at).getTime() / 1000)}` : ""}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            className="w-full h-24 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2.5 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={data?.default}
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-dark-500">{val.length} chars</span>
          </div>
          <div>
            <p className="text-[11px] text-dark-500 mb-1">Preview (as appended to a reply)</p>
            <div className="rounded-lg border border-dark-800 bg-dark-900 px-3 py-2.5 text-[13px] text-dark-300 whitespace-pre-wrap">
              {"[user's message]\n\n" + (val || data?.default || "")}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setVal(data?.footer || ""); }}>Cancel</Button>
            <Button size="sm" onClick={save} loading={saving}><Save className="h-4 w-4" /> Save Changes</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
