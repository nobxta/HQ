"use client";

import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { KeyRound, Plus, Trash2, RefreshCw, RotateCw, Loader2, Check, X } from "lucide-react";

interface TokenEntry {
  id: string;
  token: string;          // masked
  username: string;
  status: "available" | "reserved" | "assigned" | string;
  order_id: string;
  added_at: string;
  assigned_at: string;
}
interface Counts { available: number; reserved: number; assigned: number; total: number }

const STATUS_STYLE: Record<string, string> = {
  available: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  reserved: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  assigned: "bg-accent/10 text-accent border-accent/20",
};

export default function BotTokensPage() {
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [counts, setCounts] = useState<Counts>({ available: 0, reserved: 0, assigned: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [raw, setRaw] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/api/portal/admin/bot-tokens");
      setTokens(r.data?.tokens || []);
      setCounts(r.data?.counts || { available: 0, reserved: 0, assigned: 0, total: 0 });
    } catch {
      toast.error("Could not load the token pool");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const addTokens = useCallback(async () => {
    const list = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    if (!list.length) { toast.error("Paste at least one token"); return; }
    setAdding(true);
    try {
      const r = await api.post("/api/portal/admin/bot-tokens", { tokens: list });
      const results = r.data?.results || [];
      const ok = results.filter((x: any) => x.added).length;
      const failed = results.filter((x: any) => !x.added);
      if (ok) toast.success(`Added ${ok} token${ok !== 1 ? "s" : ""}`);
      if (failed.length) toast.error(`${failed.length} failed: ${failed.map((f: any) => f.error).filter(Boolean).slice(0, 2).join(", ")}`);
      setRaw("");
      await load();
    } catch {
      toast.error("Could not add tokens");
    }
    setAdding(false);
  }, [raw, load]);

  const reconcile = useCallback(async () => {
    setReconciling(true);
    try {
      const r = await api.post("/api/portal/admin/bot-tokens/reconcile");
      const released = r.data?.released ?? 0;
      const promoted = r.data?.promoted ?? 0;
      if (released || promoted) {
        toast.success(`Synced pool — freed ${released}, fixed ${promoted}`);
      } else {
        toast.success("Pool already in sync");
      }
      await load();
    } catch {
      toast.error("Could not sync the pool");
    }
    setReconciling(false);
  }, [load]);

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

  const stat = (label: string, value: number, color: string) => (
    <div className="rounded-xl border border-white/[0.06] bg-dark-850 p-4">
      <p className="text-[11px] text-dark-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-dark-100">Bot Token Pool</h1>
            <p className="text-[12px] text-dark-500">Pre-created @BotFather tokens. One is assigned per purchase, released on failure or deletion.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reconcile} disabled={reconciling} className="flex items-center gap-1.5 text-[12px] text-dark-400 hover:text-dark-100 border border-white/[0.06] rounded-lg px-3 py-2 transition-colors disabled:opacity-50" title="Release tokens whose bot was deleted or order was cleared, and fix stale statuses">
            {reconciling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />} Sync pool
          </button>
          <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-dark-400 hover:text-dark-100 border border-white/[0.06] rounded-lg px-3 py-2 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stat("Available", counts.available, "text-emerald-400")}
        {stat("Reserved", counts.reserved, "text-amber-400")}
        {stat("Assigned", counts.assigned, "text-accent")}
        {stat("Total", counts.total, "text-dark-100")}
      </div>

      {counts.available === 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[13px] text-amber-400">
          No available tokens — every purchase will queue until you add stock below.
        </div>
      )}

      {/* add */}
      <div className="rounded-xl border border-white/[0.06] bg-dark-850 p-5">
        <p className="text-[13px] font-semibold text-dark-100 mb-1">Add tokens</p>
        <p className="text-[12px] text-dark-500 mb-3">Paste one or more @BotFather tokens (one per line, or comma/space separated). Each is validated before it's added.</p>
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          rows={4}
          placeholder={"1234567:AAE...\n7654321:BBF..."}
          className="w-full rounded-lg border border-white/[0.06] bg-dark-900 px-3 py-2.5 text-[13px] font-mono text-dark-100 placeholder-dark-600 outline-none focus:border-accent/40 transition-colors resize-y"
        />
        <div className="mt-3 flex justify-end">
          <button
            onClick={addTokens}
            disabled={adding || !raw.trim()}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-white bg-accent hover:bg-accent-600 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add to pool
          </button>
        </div>
      </div>

      {/* list */}
      <div className="rounded-xl border border-white/[0.06] bg-dark-850 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between">
          <p className="text-[13px] font-semibold text-dark-100">Tokens ({tokens.length})</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-center py-12 text-[13px] text-dark-500">No tokens in the pool yet.</div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-mono text-dark-200 truncate">{t.token}</p>
                  <p className="text-[11px] text-dark-500">{t.username ? `@${t.username}` : "—"} · added {(t.added_at || "").slice(0, 10)}</p>
                </div>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${STATUS_STYLE[t.status] || "bg-dark-800 text-dark-400 border-white/[0.06]"}`}>
                  {t.status}
                </span>
                {confirmId === t.id ? (
                  <div className="flex items-center gap-1.5">
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
                    disabled={t.status === "assigned"}
                    title={t.status === "assigned" ? "In use by a live bot" : "Remove"}
                    className="p-1.5 rounded-lg text-dark-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dark-500"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
