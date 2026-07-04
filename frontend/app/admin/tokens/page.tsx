"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import {
  KeyRound, Plus, Trash2, RefreshCw, RotateCw, Loader2, Check, X,
  Search, CheckSquare, Square, Bot, Clock, AlertCircle, CheckCircle2,
} from "lucide-react";

interface TokenEntry {
  id: string;
  token: string;          // masked
  username: string;
  status: "available" | "reserved" | "assigned" | string;
  order_id: string;
  added_at: string;
  assigned_at: string;
  reserved_at?: string;
  bot_name?: string;
}
interface Counts { available: number; reserved: number; assigned: number; total: number }
interface AddResult { token: string; username?: string; added: boolean; error?: string | null }

type StatusFilter = "all" | "available" | "reserved" | "assigned";
type SortKey = "added_desc" | "added_asc" | "username" | "status";

const STATUS_STYLE: Record<string, string> = {
  available: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  reserved: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  assigned: "bg-accent/10 text-accent border-accent/20",
};

const STATUS_ORDER: Record<string, number> = { available: 0, reserved: 1, assigned: 2 };

function fmtDate(v?: string) {
  if (!v) return "—";
  return (v || "").slice(0, 10);
}

export default function BotTokensPage() {
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [counts, setCounts] = useState<Counts>({ available: 0, reserved: 0, assigned: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [raw, setRaw] = useState("");
  const [addResults, setAddResults] = useState<AddResult[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // list controls
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("added_desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/api/portal/admin/bot-tokens");
      setTokens(r.data?.tokens || []);
      setCounts(r.data?.counts || { available: 0, reserved: 0, assigned: 0, total: 0 });
      setSelected(new Set());
    } catch {
      toast.error("Could not load the token pool");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Add tokens ──
  const detected = useMemo(() => {
    const list = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    const seen = new Set<string>();
    let dupes = 0;
    const unique: string[] = [];
    for (const t of list) {
      if (seen.has(t)) { dupes++; continue; }
      seen.add(t); unique.push(t);
    }
    return { unique, count: unique.length, dupes };
  }, [raw]);

  const addTokens = useCallback(async () => {
    if (!detected.count) { toast.error("Paste at least one token"); return; }
    setAdding(true);
    setAddResults(null);
    try {
      const r = await api.post("/api/portal/admin/bot-tokens", { tokens: detected.unique });
      const results: AddResult[] = r.data?.results || [];
      setAddResults(results);
      const ok = results.filter((x) => x.added).length;
      if (ok) toast.success(`Added ${ok} token${ok !== 1 ? "s" : ""}`);
      const failed = results.filter((x) => !x.added).length;
      if (failed) toast.error(`${failed} token${failed !== 1 ? "s" : ""} rejected`);
      setRaw("");
      await load();
    } catch {
      toast.error("Could not add tokens");
    }
    setAdding(false);
  }, [detected, load]);

  // ── Reconcile ──
  const reconcile = useCallback(async () => {
    setReconciling(true);
    try {
      const r = await api.post("/api/portal/admin/bot-tokens/reconcile");
      const released = r.data?.released ?? 0;
      const promoted = r.data?.promoted ?? 0;
      if (released || promoted) toast.success(`Synced — freed ${released}, fixed ${promoted}`);
      else toast.success("Pool already in sync");
      await load();
    } catch {
      toast.error("Could not sync the pool");
    }
    setReconciling(false);
  }, [load]);

  // ── Remove ──
  const remove = useCallback(async (id: string) => {
    try {
      await api.delete("/api/portal/admin/bot-tokens", { params: { id } });
      toast.success("Token removed");
      setConfirmId(null);
      await load();
    } catch {
      toast.error("Could not remove token");
    }
  }, [load]);

  const removeSelected = useCallback(async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkBusy(true);
    let ok = 0, fail = 0;
    await Promise.all(ids.map(async (id) => {
      try { await api.delete("/api/portal/admin/bot-tokens", { params: { id } }); ok++; }
      catch { fail++; }
    }));
    if (ok) toast.success(`Removed ${ok} token${ok !== 1 ? "s" : ""}`);
    if (fail) toast.error(`${fail} could not be removed`);
    setBulkBusy(false);
    setBulkConfirm(false);
    await load();
  }, [selected, load]);

  // ── Derived list ──
  const visible = useMemo(() => {
    let rows = tokens;
    if (filter !== "all") rows = rows.filter((t) => t.status === filter);
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((t) =>
        t.token.toLowerCase().includes(q) ||
        (t.username || "").toLowerCase().includes(q) ||
        (t.bot_name || "").toLowerCase().includes(q) ||
        (t.order_id || "").toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q)
      );
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sort) {
        case "added_asc": return (a.added_at || "").localeCompare(b.added_at || "");
        case "username": return (a.username || "").localeCompare(b.username || "");
        case "status": return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        default: return (b.added_at || "").localeCompare(a.added_at || "");
      }
    });
    return sorted;
  }, [tokens, filter, query, sort]);

  const removableVisible = useMemo(() => visible.filter((t) => t.status !== "assigned"), [visible]);
  const allRemovableSelected = removableVisible.length > 0 && removableVisible.every((t) => selected.has(t.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allRemovableSelected) return new Set();
      return new Set(removableVisible.map((t) => t.id));
    });
  };

  // ── Stat / filter card ──
  const StatCard = ({ label, value, color, target }: { label: string; value: number; color: string; target: StatusFilter }) => {
    const active = filter === target;
    return (
      <button
        onClick={() => setFilter(active ? "all" : target)}
        aria-pressed={active}
        className={`rounded-xl border p-4 text-left transition-all ${
          active ? "border-accent/40 bg-accent/[0.06] ring-1 ring-accent/30" : "border-white/[0.06] bg-dark-850 hover:border-white/[0.12]"
        }`}
      >
        <p className="text-[11px] text-dark-500 uppercase tracking-wider">{label}</p>
        <p className={`text-2xl font-bold mt-1 tabular-nums ${color}`}>{value}</p>
      </button>
    );
  };

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-dark-100">Bot Token Pool</h1>
            <p className="text-[12px] text-dark-500">Pre-created @BotFather tokens. One is assigned per bot, released on failure or deletion.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reconcile} disabled={reconciling} className="flex items-center gap-1.5 text-[12px] text-dark-300 hover:text-dark-100 border border-white/[0.06] rounded-lg px-3 py-2 transition-colors disabled:opacity-50" title="Release tokens whose bot was deleted or order was cleared, and fix stale statuses">
            {reconciling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />} Sync pool
          </button>
          <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-dark-400 hover:text-dark-100 border border-white/[0.06] rounded-lg px-3 py-2 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* counts (click to filter) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Available" value={counts.available} color="text-emerald-400" target="available" />
        <StatCard label="Reserved" value={counts.reserved} color="text-amber-400" target="reserved" />
        <StatCard label="Assigned" value={counts.assigned} color="text-accent" target="assigned" />
        <StatCard label="Total" value={counts.total} color="text-dark-100" target="all" />
      </div>

      {counts.available === 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[13px] text-amber-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          No available tokens — new bots will queue until you add stock or free one with Sync pool.
        </div>
      )}

      {/* add */}
      <div className="rounded-xl border border-white/[0.06] bg-dark-850 p-5">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[13px] font-semibold text-dark-100">Add tokens</p>
          {detected.count > 0 && (
            <span className="text-[11px] text-dark-400">
              <span className="text-emerald-400 font-medium">{detected.count}</span> detected
              {detected.dupes > 0 && <span className="text-dark-500"> · {detected.dupes} duplicate{detected.dupes !== 1 ? "s" : ""} skipped</span>}
            </span>
          )}
        </div>
        <p className="text-[12px] text-dark-500 mb-3">Paste one or more @BotFather tokens (one per line, or comma/space separated). Each is validated before it's added.</p>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={"1234567:AAE...\n7654321:BBF..."}
          className="w-full rounded-lg border border-white/[0.06] bg-dark-900 px-3 py-2.5 text-[13px] font-mono text-dark-100 placeholder-dark-600 outline-none focus:border-accent/40 transition-colors resize-y"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          {raw.trim() ? (
            <button onClick={() => { setRaw(""); setAddResults(null); }} className="text-[12px] text-dark-500 hover:text-dark-300 transition-colors">Clear</button>
          ) : <span />}
          <button
            onClick={addTokens}
            disabled={adding || !detected.count}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-white bg-accent hover:bg-accent-600 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {detected.count > 1 ? `Add ${detected.count} to pool` : "Add to pool"}
          </button>
        </div>

        {/* per-token results */}
        {addResults && addResults.length > 0 && (
          <div className="mt-4 rounded-lg border border-white/[0.06] bg-dark-900 divide-y divide-white/[0.04]">
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-dark-400 uppercase tracking-wider">Results</span>
              <button onClick={() => setAddResults(null)} className="text-dark-500 hover:text-dark-200" aria-label="Dismiss results"><X className="w-3.5 h-3.5" /></button>
            </div>
            {addResults.map((r, i) => (
              <div key={i} className="px-3 py-2 flex items-center gap-2.5 text-[12px]">
                {r.added
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  : <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                <span className="font-mono text-dark-300">{r.token}</span>
                {r.added
                  ? <span className="text-emerald-400/80">{r.username ? `@${r.username}` : "added"}</span>
                  : <span className="text-red-400/80 truncate">{r.error || "rejected"}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* list */}
      <div className="rounded-xl border border-white/[0.06] bg-dark-850 overflow-hidden">
        {/* toolbar */}
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-3 flex-wrap">
          <p className="text-[13px] font-semibold text-dark-100">
            Tokens <span className="text-dark-500 font-normal">({visible.length})</span>
          </p>
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search token, bot, order…"
              className="w-full rounded-lg border border-white/[0.06] bg-dark-900 pl-8 pr-3 py-1.5 text-[12px] text-dark-100 placeholder-dark-600 outline-none focus:border-accent/40 transition-colors"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-white/[0.06] bg-dark-900 px-2.5 py-1.5 text-[12px] text-dark-200 outline-none focus:border-accent/40 transition-colors"
            aria-label="Sort tokens"
          >
            <option value="added_desc">Newest first</option>
            <option value="added_asc">Oldest first</option>
            <option value="username">Username A–Z</option>
            <option value="status">Status</option>
          </select>
          {filter !== "all" && (
            <button onClick={() => setFilter("all")} className="inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-400 border border-accent/20 bg-accent/[0.06] rounded-lg px-2 py-1 transition-colors">
              {filter} <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* bulk bar */}
        {selected.size > 0 && (
          <div className="px-4 py-2.5 border-b border-white/[0.06] bg-accent/[0.04] flex items-center justify-between gap-3">
            <span className="text-[12px] text-dark-200">{selected.size} selected</span>
            {bulkConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-dark-400">Remove {selected.size}?</span>
                <button onClick={removeSelected} disabled={bulkBusy} className="inline-flex items-center gap-1.5 text-[12px] text-white bg-red-500/90 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                  {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Confirm
                </button>
                <button onClick={() => setBulkConfirm(false)} className="text-[12px] text-dark-400 hover:text-dark-100 px-2 py-1.5">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={() => setSelected(new Set())} className="text-[12px] text-dark-400 hover:text-dark-100 px-2 py-1.5">Clear</button>
                <button onClick={() => setBulkConfirm(true)} className="inline-flex items-center gap-1.5 text-[12px] text-red-400 hover:text-red-300 border border-red-500/20 hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              </div>
            )}
          </div>
        )}

        {/* select-all row */}
        {!loading && removableVisible.length > 0 && (
          <div className="px-4 py-2 border-b border-white/[0.04] flex items-center gap-2">
            <button onClick={toggleSelectAll} className="text-dark-400 hover:text-dark-100" aria-label="Select all removable">
              {allRemovableSelected ? <CheckSquare className="w-4 h-4 text-accent" /> : <Square className="w-4 h-4" />}
            </button>
            <span className="text-[11px] text-dark-500">Select all removable ({removableVisible.length})</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12 text-[13px] text-dark-500">
            {tokens.length === 0 ? "No tokens in the pool yet." : query || filter !== "all" ? "No tokens match this filter." : "No tokens."}
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {visible.map((t) => {
              const removable = t.status !== "assigned";
              const isSelected = selected.has(t.id);
              return (
                <div key={t.id} className={`flex items-center gap-3 px-4 py-3 transition-colors ${isSelected ? "bg-accent/[0.04]" : ""}`}>
                  {/* checkbox */}
                  <button
                    onClick={() => removable && toggleSelect(t.id)}
                    disabled={!removable}
                    aria-label={removable ? "Select token" : "In use — cannot select"}
                    className={`shrink-0 ${removable ? "text-dark-500 hover:text-dark-200" : "text-dark-700 cursor-not-allowed"}`}
                  >
                    {isSelected ? <CheckSquare className="w-4 h-4 text-accent" /> : <Square className="w-4 h-4" />}
                  </button>

                  {/* main */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-mono text-dark-200 truncate">{t.token}</p>
                    <div className="flex items-center gap-2 flex-wrap text-[11px] text-dark-500 mt-0.5">
                      <span>{t.username ? `@${t.username}` : "—"}</span>
                      <span className="text-dark-700">·</span>
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> added {fmtDate(t.added_at)}</span>
                      {t.status === "assigned" && t.bot_name && (
                        <>
                          <span className="text-dark-700">·</span>
                          <span className="inline-flex items-center gap-1 text-accent/80"><Bot className="w-3 h-3" /> {t.bot_name}</span>
                        </>
                      )}
                      {t.status === "assigned" && t.assigned_at && (
                        <>
                          <span className="text-dark-700">·</span>
                          <span>assigned {fmtDate(t.assigned_at)}</span>
                        </>
                      )}
                      {t.status === "reserved" && t.order_id && (
                        <>
                          <span className="text-dark-700">·</span>
                          <span className="font-mono truncate">order {t.order_id}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* status */}
                  <span className={`text-[11px] font-medium px-2 py-0.5 rounded border shrink-0 ${STATUS_STYLE[t.status] || "bg-dark-800 text-dark-400 border-white/[0.06]"}`}>
                    {t.status}
                  </span>

                  {/* delete */}
                  {confirmId === t.id ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => remove(t.id)} className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20" title="Confirm remove">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setConfirmId(null)} className="p-1.5 rounded-lg bg-dark-800 text-dark-400 hover:text-dark-100" title="Cancel">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmId(t.id)}
                      disabled={!removable}
                      title={!removable ? "In use by a live bot — delete the bot or Sync pool first" : "Remove"}
                      className="shrink-0 p-1.5 rounded-lg text-dark-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dark-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
