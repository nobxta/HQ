"use client";
import { usePortalBot, usePortalStats } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Users, AlertTriangle, CheckCircle, XCircle,
  Loader2, Pencil, Camera, RefreshCw, ArrowRightLeft,
  User, Zap, AlertOctagon, Search, Skull, Ban,
  Timer, HelpCircle, CircleDollarSign, Gift,
  CreditCard, WifiOff, Activity, ShieldCheck, Info,
  Clock, Package, ChevronRight,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════ */

type TimeFilter = "last_cycle" | "24h" | "overall";

interface AccountInfo {
  user_id: number;
  first_name: string;
  last_name: string;
  username: string;
  phone: string;
}

interface DiagResult {
  status: string;
  reason: string;
  action: "replace" | "wait" | "ok" | "unknown";
  source: "spambot" | "stats";
  validation?: "ok" | "failed";
  severity?: "ok" | "warning" | "critical" | "unknown";
}

/* ═══════════════════════════════════════════════════════
   STATUS THEME — maps SpamBot / stats status to UI
   ═══════════════════════════════════════════════════════ */

const STATUS_CFG: Record<string, {
  bg: string; border: string; text: string;
  iconBg: string; Icon: any; label: string; desc: string;
}> = {
  FROZEN: {
    bg: "bg-red-500/[0.08]", border: "border-red-500/25", text: "text-red-400",
    iconBg: "bg-red-500/20",
    Icon: Skull, label: "Frozen / Dead",
    desc: "Permanently frozen by Telegram. Replace immediately.",
  },
  DEAD: {
    bg: "bg-red-500/[0.08]", border: "border-red-500/25", text: "text-red-400",
    iconBg: "bg-red-500/20",
    Icon: Skull, label: "Dead Session",
    desc: "Session is no longer valid. It was logged out, revoked, or banned.",
  },
  HARD_LIMITED: {
    bg: "bg-red-500/[0.07]", border: "border-red-500/20", text: "text-red-400",
    iconBg: "bg-red-500/20",
    Icon: Ban, label: "Permanently Limited",
    desc: "Telegram permanently limited this account. Won't recover.",
  },
  TEMP_LIMITED: {
    bg: "bg-amber-500/[0.08]", border: "border-amber-500/20", text: "text-amber-400",
    iconBg: "bg-amber-500/20",
    Icon: Timer, label: "Temporarily Limited",
    desc: "May recover in 24-48h, or replace now.",
  },
  ACTIVE: {
    bg: "bg-emerald-500/[0.08]", border: "border-emerald-500/20", text: "text-emerald-400",
    iconBg: "bg-emerald-500/20",
    Icon: ShieldCheck, label: "Active & Healthy",
    desc: "SpamBot says this account is clean. Failures may be network issues.",
  },
  BUSY: {
    bg: "bg-sky-500/[0.08]", border: "border-sky-500/20", text: "text-sky-400",
    iconBg: "bg-sky-500/20",
    Icon: Activity, label: "In Use",
    desc: "Session is currently busy sending messages. Try again in a few minutes.",
  },
  STATS_FAILING: {
    bg: "bg-amber-500/[0.07]", border: "border-amber-500/20", text: "text-amber-400",
    iconBg: "bg-amber-500/20",
    Icon: Activity, label: "Failing (Stats)",
    desc: "Session is alive but has high failure rate. SpamBot check was inconclusive.",
  },
  UNKNOWN: {
    bg: "bg-dark-700/30", border: "border-white/[0.08]", text: "text-dark-400",
    iconBg: "bg-dark-700/40",
    Icon: HelpCircle, label: "Unknown",
    desc: "Could not determine status. Try again or replace.",
  },
  STATS_ONLY: {
    bg: "bg-red-500/[0.07]", border: "border-red-500/20", text: "text-red-400",
    iconBg: "bg-red-500/20",
    Icon: Activity, label: "High Failure Rate",
    desc: "Stats show 90%+ message failures. Replace recommended.",
  },
};

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */

function getFailInfo(ss: Record<string, any> | undefined, file: string) {
  if (!ss) return null;
  const s = ss[file];
  if (!s) return null;
  const attempted = Number(s.last_cycle_attempted || 0);
  const lcFailed = Number(s.last_cycle_failed || 0);
  const lcSuccess = Number(s.last_cycle_success || 0);
  const ltSent = Number(s.lifetime_sent || 0);
  const ltFailed = Number(s.lifetime_failed || 0);
  const ltTotal = ltSent + ltFailed;
  const lastBad = attempted > 0 && (lcFailed / attempted) >= 0.9 && lcSuccess <= 1;
  const lifeBad = ltTotal >= 10 && (ltFailed / ltTotal) >= 0.9;
  if (!lastBad && !lifeBad) return null;
  return {
    failRate: Math.max(
      attempted > 0 ? lcFailed / attempted : 0,
      ltTotal > 0 ? ltFailed / ltTotal : 0
    ),
    attempted, lcFailed, lcSuccess, ltSent, ltFailed, ltTotal,
  };
}

function mkStatsDiag(rate: number): DiagResult {
  return { status: "STATS_ONLY", reason: `${Math.round(rate * 100)}% failure rate detected from stats`, action: "replace", source: "stats" };
}

const COLORS = [
  "from-violet-500 to-purple-700", "from-emerald-400 to-teal-700",
  "from-amber-400 to-orange-700", "from-sky-400 to-blue-700",
  "from-pink-400 to-rose-700", "from-cyan-400 to-cyan-700",
];

/* ═══════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════ */

function Toast({ msg, type, onClose }: { msg: string; type: "ok" | "err" | "warn"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 6000); return () => clearTimeout(t); }, [onClose]);
  const colors = type === "ok"
    ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-300"
    : type === "warn"
    ? "bg-amber-500/20 border-amber-500/30 text-amber-300"
    : "bg-red-500/20 border-red-500/30 text-red-300";
  return (
    <div className={`fixed top-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-sm z-[100] animate-slide-down rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-md ${colors}`}>
      <div className="flex items-start gap-2">
        {type === "ok" ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" /> : type === "warn" ? <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
        <p className="text-[12px] font-semibold leading-snug flex-1">{msg}</p>
        <button type="button" onClick={onClose} className="ml-1 text-white/40 hover:text-white/70 shrink-0 cursor-pointer">
          <XCircle className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════ */

export default function AccountsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data: bot, isLoading, mutate: mutateBot } = usePortalBot();
  const { data: stats } = usePortalStats();

  const [filter, setFilter] = useState<TimeFilter>("overall");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);
  const showToast = useCallback((msg: string, type: "ok" | "err" | "warn" = "ok") => setToast({ msg, type }), []);

  // Diagnose
  const [diagLoading, setDiagLoading] = useState<Record<string, boolean>>({});
  const [diagResults, setDiagResults] = useState<Record<string, DiagResult>>({});

  // Edit modal
  const [editFile, setEditFile] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editPhoto, setEditPhoto] = useState<File | null>(null);
  const [editMsg, setEditMsg] = useState<{ ok?: boolean; error?: string } | null>(null);

  // Replace modal
  const [replModal, setReplModal] = useState(false);
  const [replTargets, setReplTargets] = useState<string[]>([]);
  const [replLoading, setReplLoading] = useState(false);
  const [replMsg, setReplMsg] = useState<{ ok?: boolean; error?: string; text?: string } | null>(null);
  const [freeRem, setFreeRem] = useState(0);
  const [pricePer, setPricePer] = useState(2.0);
  const [pendingReplacements, setPendingReplacements] = useState<any[]>([]);

  /* ─── Fetch replacement status (free count, pending queue) ─── */
  const fetchRepl = useCallback(() => {
    const s = getPortalSession();
    if (!s?.bot_name || !s?.telegram_id) return;
    portalApi
      .get(`/api/portal/bot/${s.bot_name}/replacements?telegram_id=${s.telegram_id}`)
      .then((r) => {
        setFreeRem(r.data?.free_remaining ?? 0);
        setPricePer(r.data?.price_per_session ?? 2.0);
        setPendingReplacements(r.data?.pending ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchRepl(); const iv = setInterval(fetchRepl, 15000); return () => clearInterval(iv); }, [fetchRepl]);

  /* ══════════════════════════════════════════════════════
     DIAGNOSE — Check Why (single session)
     ══════════════════════════════════════════════════════ */
  const doCheckWhy = useCallback(async (file: string) => {
    const s = getPortalSession();
    console.log("[Accounts] Check Why →", file, "bot:", s?.bot_name);
    if (!s?.bot_name || !s?.telegram_id) {
      showToast("Please log in again to check sessions", "err");
      return;
    }
    setDiagLoading((p) => ({ ...p, [file]: true }));
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/diagnose?telegram_id=${s.telegram_id}`,
        { session_files: [file] },
        { timeout: 35000 }
      );
      console.log("[Accounts] Diagnose OK:", JSON.stringify(r.data));
      const res = r.data?.results;
      if (res && res.length > 0) {
        const d = res[0];
        const action = d.action === "replace" ? "replace" as const
          : d.action === "wait_or_replace" ? "wait" as const
          : d.action === "none" ? "ok" as const
          : "unknown" as const;
        const diag: DiagResult = {
          status: d.spam_status || "UNKNOWN",
          reason: d.reason || "Check complete",
          action,
          source: "spambot",
          validation: d.validation || "ok",
          severity: d.severity || "unknown",
        };
        setDiagResults((p) => ({ ...p, [file]: diag }));
        const cfg = STATUS_CFG[diag.status] || STATUS_CFG.UNKNOWN;
        const toastType = diag.severity === "ok" ? "ok" as const
          : diag.severity === "warning" ? "warn" as const
          : diag.severity === "critical" ? "err" as const
          : "warn" as const;
        showToast(`${cfg.label}: ${diag.reason}`, toastType);
        setDiagLoading((p) => ({ ...p, [file]: false }));
        return;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err?.message || "Unknown error";
      console.error("[Accounts] Diagnose error:", status, detail);
      // Don't return — fall through to stats fallback
    }
    // Stats fallback
    const fi = getFailInfo(stats?.session_stats, file);
    if (fi) {
      setDiagResults((p) => ({ ...p, [file]: mkStatsDiag(fi.failRate) }));
      showToast(`High failure rate: ${Math.round(fi.failRate * 100)}% — SpamBot unavailable, showing stats`, "warn");
    } else {
      setDiagResults((p) => ({ ...p, [file]: { status: "UNKNOWN", reason: "Could not reach SpamBot. Try again.", action: "unknown", source: "stats" } }));
      showToast("Could not check session — try again", "err");
    }
    setDiagLoading((p) => ({ ...p, [file]: false }));
  }, [stats?.session_stats, showToast]);

  /* ══════════════════════════════════════════════════════
     DIAGNOSE ALL — batch check
     ══════════════════════════════════════════════════════ */
  const doCheckAll = useCallback(async (files: string[]) => {
    const s = getPortalSession();
    console.log("[Accounts] Check All →", files.length, "bot:", s?.bot_name);
    if (!s?.bot_name || !s?.telegram_id) {
      showToast("Please log in again", "err");
      return;
    }
    const batch: Record<string, boolean> = {};
    files.forEach((f) => { batch[f] = true; });
    setDiagLoading((p) => ({ ...p, ...batch }));
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/diagnose?telegram_id=${s.telegram_id}`,
        { session_files: files },
        { timeout: 60000 }
      );
      const res = r.data?.results;
      if (res && res.length > 0) {
        const nd: Record<string, DiagResult> = {};
        let critCount = 0, warnCount = 0, okCount = 0;
        for (const d of res) {
          const action = d.action === "replace" ? "replace" as const
            : d.action === "wait_or_replace" ? "wait" as const
            : d.action === "none" ? "ok" as const
            : "unknown" as const;
          nd[d.session_file] = {
            status: d.spam_status || "UNKNOWN",
            reason: d.reason || "Check complete",
            action,
            source: "spambot",
            validation: d.validation || "ok",
            severity: d.severity || "unknown",
          };
          if (d.severity === "critical") critCount++;
          else if (d.severity === "warning") warnCount++;
          else if (d.severity === "ok") okCount++;
        }
        setDiagResults((p) => ({ ...p, ...nd }));
        const done: Record<string, boolean> = {};
        files.forEach((f) => { done[f] = false; });
        setDiagLoading((p) => ({ ...p, ...done }));
        const summary = [
          critCount > 0 ? `${critCount} critical` : "",
          warnCount > 0 ? `${warnCount} warning` : "",
          okCount > 0 ? `${okCount} healthy` : "",
        ].filter(Boolean).join(", ");
        showToast(`Checked ${res.length} session${res.length !== 1 ? "s" : ""}: ${summary || "done"}`,
          critCount > 0 ? "err" : warnCount > 0 ? "warn" : "ok");
        return;
      }
    } catch (err: any) {
      console.error("[Accounts] Batch diagnose error:", err?.response?.status, err?.response?.data?.detail || err?.message);
    }
    // Fallback to stats
    const nd: Record<string, DiagResult> = {};
    for (const f of files) {
      const fi = getFailInfo(stats?.session_stats, f);
      nd[f] = fi ? mkStatsDiag(fi.failRate) : { status: "UNKNOWN", reason: "Could not reach SpamBot", action: "unknown", source: "stats" };
    }
    setDiagResults((p) => ({ ...p, ...nd }));
    const done: Record<string, boolean> = {};
    files.forEach((f) => { done[f] = false; });
    setDiagLoading((p) => ({ ...p, ...done }));
    showToast(`SpamBot unavailable — showing stats for ${files.length} sessions`, "warn");
  }, [stats?.session_stats, showToast]);

  /* ══════════════════════════════════════════════════════
     REPLACE — open modal + confirm
     ══════════════════════════════════════════════════════ */
  const openReplace = useCallback((targets: string[]) => {
    console.log("[Accounts] Replace modal →", targets);
    setReplTargets(targets);
    setReplMsg(null);
    setReplModal(true);
    fetchRepl(); // refresh free count before showing cost
  }, [fetchRepl]);

  const confirmReplace = useCallback(async () => {
    const s = getPortalSession();
    if (!s?.bot_name || !s?.telegram_id || replTargets.length === 0) {
      showToast("Please log in again", "err");
      return;
    }
    console.log("[Accounts] Confirming replace:", replTargets);
    setReplLoading(true);
    setReplMsg(null);
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/replace?telegram_id=${s.telegram_id}`,
        { session_files: replTargets },
        { timeout: 90000 } // replacement can take time (swapping session files)
      );
      const d = r.data;
      console.log("[Accounts] Replace response:", JSON.stringify(d));

      // Already queued (duplicate click)
      if (d.already_queued && d.queued === 0) {
        setReplMsg({ ok: true, text: d.message || "Already queued for replacement." });
        showToast(d.message || "Already queued", "warn");
        fetchRepl(); mutateBot();
        return;
      }

      const processed = d.processed || 0;
      const awaitingPool = d.awaiting_pool || 0;
      const q = d.queued || 0;
      const freeCount = d.entries?.filter((e: any) => e.free_replacement).length || 0;
      const paidCount = q - freeCount;

      let msg = "";
      if (processed > 0) {
        // Sessions actually swapped right now
        msg = `${processed} session${processed !== 1 ? "s" : ""} replaced successfully!`;
        if (d.completed?.length > 0) {
          const names = d.completed.map((c: any) => c.real_name || "new session").join(", ");
          msg += ` New: ${names}.`;
        }
        if (paidCount > 0) {
          msg += ` ${paidCount} paid ($${d.price_per_session}/ea) — pay via Telegram bot.`;
        }
      } else if (awaitingPool > 0) {
        // No sessions available in pool
        msg = `${q} replacement${q !== 1 ? "s" : ""} queued, but no fresh sessions available in pool. Admin has been notified — your sessions will be replaced as soon as new ones are added.`;
      } else if (paidCount > 0 && freeCount === 0) {
        // All paid, none free
        msg = `${paidCount} session${paidCount !== 1 ? "s" : ""} need payment ($${d.price_per_session}/ea). Use your Telegram bot to complete payment.`;
      } else if (freeCount > 0 && paidCount > 0) {
        // Mixed: some free, some paid
        msg = `${freeCount} free replacement${freeCount !== 1 ? "s" : ""} queued. ${paidCount} more need payment ($${d.price_per_session}/ea) via Telegram bot.`;
      } else if (q > 0) {
        msg = `${q} replacement${q !== 1 ? "s" : ""} queued for processing.`;
      }

      setReplMsg({ ok: true, text: msg || "Replacement requested." });
      showToast(msg || "Replacement requested", processed > 0 ? "ok" : paidCount > 0 ? "warn" : "ok");
      fetchRepl();
      mutateBot();
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err?.message || "Failed to request replacement";
      console.error("[Accounts] Replace error:", status, detail);
      const errMsg = status === 400 ? detail
        : status === 404 ? "Replace endpoint not available. Backend may need restart."
        : status === 500 ? `Server error: ${detail}`
        : detail;
      setReplMsg({ error: errMsg });
      showToast(errMsg, "err");
    } finally {
      setReplLoading(false);
    }
  }, [replTargets, fetchRepl, mutateBot, showToast]);

  /* ══════════════════════════════════════════════════════
     EDIT — profile editing
     ══════════════════════════════════════════════════════ */
  const openEdit = useCallback(async (file: string) => {
    const s = getPortalSession();
    setEditFile(file); setEditMsg(null); setEditPhoto(null);
    setAccountInfo(null); setInfoLoading(true);
    try {
      const r = await portalApi.get(
        `/api/portal/bot/${s?.bot_name}/account/${encodeURIComponent(file)}/info?telegram_id=${s?.telegram_id}`
      );
      const info = r.data as AccountInfo;
      setAccountInfo(info);
      setEditFirstName(info.first_name || "");
      setEditLastName(info.last_name || "");
      setEditBio(""); setEditUsername(info.username || "");
    } catch (e: any) {
      setEditMsg({ error: e?.response?.data?.detail || "Failed to load account info" });
    } finally { setInfoLoading(false); }
  }, []);

  const submitEdit = useCallback(async () => {
    const s = getPortalSession();
    if (!editFile || !s) return;
    setEditLoading(true); setEditMsg(null);
    try {
      const fd = new FormData();
      if (editFirstName) fd.append("first_name", editFirstName);
      if (editLastName) fd.append("last_name", editLastName);
      if (editBio) fd.append("bio", editBio);
      if (editUsername) fd.append("username", editUsername);
      if (editPhoto) fd.append("photo", editPhoto);
      await portalApi.post(
        `/api/portal/bot/${s.bot_name}/account/${encodeURIComponent(editFile)}/profile?telegram_id=${s.telegram_id}`,
        fd, { headers: { "Content-Type": "multipart/form-data" } }
      );
      setEditMsg({ ok: true });
      showToast("Profile updated!", "ok");
      mutateBot();
    } catch (e: any) {
      setEditMsg({ error: e?.response?.data?.detail || "Update failed" });
    } finally { setEditLoading(false); }
  }, [editFile, editFirstName, editLastName, editBio, editUsername, editPhoto, mutateBot, showToast]);

  /* ══════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════ */
  if (!mounted || isLoading) return <PageSkeleton />;
  if (!bot) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-dark-400">
      <Users className="h-12 w-12 mb-3 opacity-30" />
      <p className="text-lg font-medium">No bot found</p>
    </div>
  );

  const sessions: Array<{ file: string; real_name: string; user_id?: number }> = bot.sessions || [];
  const sessionStats = stats?.session_stats as Record<string, any> | undefined;

  // Build fail map
  const failMap: Record<string, ReturnType<typeof getFailInfo>> = {};
  const failFiles: string[] = [];
  sessions.forEach((s) => {
    const fi = getFailInfo(sessionStats, s.file);
    if (fi) { failMap[s.file] = fi; failFiles.push(s.file); }
  });

  const anyLoading = Object.values(diagLoading).some(Boolean);

  // Pending replacement files (to show "replacement in progress" badge)
  const pendingFiles = new Set(pendingReplacements.map((p: any) => p.session_file));

  return (
    <div className="space-y-4 animate-fade-in" suppressHydrationWarning>
      {/* Toast */}
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* ══════ HEADER ══════ */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 rounded-xl bg-accent/10 border border-accent/15 shrink-0">
            <Users className="h-5 w-5 text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-dark-50 truncate">Accounts</h1>
            <p className="text-[11px] sm:text-[12px] text-dark-400">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
              {failFiles.length > 0 && <span className="text-red-400 font-bold"> · {failFiles.length} failing</span>}
              {pendingReplacements.length > 0 && <span className="text-amber-400 font-bold"> · {pendingReplacements.length} replacing</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="hidden sm:flex gap-0.5 rounded-lg bg-dark-800/70 border border-white/[0.05] p-0.5">
            {([
              { k: "last_cycle" as TimeFilter, l: "Cycle" },
              { k: "24h" as TimeFilter, l: "24h" },
              { k: "overall" as TimeFilter, l: "All" },
            ]).map((f) => (
              <button key={f.k} type="button" onClick={() => setFilter(f.k)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all cursor-pointer ${
                  filter === f.k ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
                }`}>{f.l}</button>
            ))}
          </div>
          <button type="button" onClick={() => { mutateBot(); fetchRepl(); }}
            className="p-2 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800/60 border border-white/[0.04] transition-all cursor-pointer"
            title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Mobile filter */}
      <div className="flex sm:hidden gap-0.5 rounded-lg bg-dark-800/70 border border-white/[0.05] p-0.5">
        {([
          { k: "last_cycle" as TimeFilter, l: "Last Cycle" },
          { k: "24h" as TimeFilter, l: "24h" },
          { k: "overall" as TimeFilter, l: "Overall" },
        ]).map((f) => (
          <button key={f.k} type="button" onClick={() => setFilter(f.k)}
            className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-semibold text-center transition-all cursor-pointer ${
              filter === f.k ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
            }`}>{f.l}</button>
        ))}
      </div>

      {/* ══════ FAILING SESSIONS ALERT ══════ */}
      {failFiles.length > 0 && (
        <div className="rounded-xl border border-red-500/25 bg-gradient-to-br from-red-500/[0.08] to-red-900/[0.04] overflow-hidden">
          <div className="h-0.5 bg-gradient-to-r from-red-500 via-red-400/50 to-transparent" />
          <div className="p-3 sm:p-4">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="p-2 rounded-lg bg-red-500/20 shrink-0">
                <AlertOctagon className="h-4 w-4 text-red-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-red-400">
                  {failFiles.length} session{failFiles.length !== 1 ? "s" : ""} failing
                </p>
                <p className="text-[10px] text-dark-500 mt-0.5">
                  90%+ failure rate detected. Click &quot;Check Why&quot; to diagnose or &quot;Replace&quot; to swap with fresh accounts.
                </p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button"
                onClick={() => doCheckAll(failFiles)}
                disabled={anyLoading}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-[12px] font-bold bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 disabled:opacity-50 transition-all cursor-pointer"
              >
                {anyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {anyLoading ? "Checking..." : `Check Why (${failFiles.length})`}
              </button>
              <button type="button"
                onClick={() => openReplace(failFiles)}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-[12px] font-bold bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/25 transition-all cursor-pointer"
              >
                <ArrowRightLeft className="h-4 w-4" />
                Replace All ({failFiles.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ PENDING REPLACEMENTS BANNER ══════ */}
      {pendingReplacements.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.06] to-amber-900/[0.03] overflow-hidden">
          <div className="h-0.5 bg-gradient-to-r from-amber-500 via-amber-400/40 to-transparent" />
          <div className="p-3 sm:p-4">
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="p-2 rounded-lg bg-amber-500/20 shrink-0">
                <Package className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <p className="text-[13px] font-bold text-amber-400">
                  {pendingReplacements.length} replacement{pendingReplacements.length !== 1 ? "s" : ""} in queue
                </p>
                <p className="text-[10px] text-dark-500">Sessions being swapped with fresh ones.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              {pendingReplacements.map((p: any) => {
                const statusText =
                  p.status === "ready" ? "Processing now..." :
                  p.status === "awaiting_session" ? "Waiting for admin to add sessions to pool" :
                  p.status === "pending_payment" ? "Payment required — use Telegram bot to pay" :
                  p.status;
                const statusColor =
                  p.status === "ready" ? "text-accent" :
                  p.status === "awaiting_session" ? "text-amber-400" :
                  p.status === "pending_payment" ? "text-red-400" :
                  "text-dark-400";
                return (
                  <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-dark-800/40 border border-white/[0.04] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="text-[11px] font-semibold text-dark-200 truncate block">
                        {(p.real_name || p.session_file || "").replace(".session", "")}
                      </span>
                      <span className={`text-[9px] ${statusColor}`}>{statusText}</span>
                    </div>
                    <span className={`text-[9px] font-bold rounded-full px-2 py-0.5 shrink-0 ${
                      p.free_replacement ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/15 text-red-400"
                    }`}>
                      {p.free_replacement ? "FREE" : `$${Number(p.price_usd || 0).toFixed(2)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══════ SESSION CARDS ══════ */}
      <div className="space-y-3">
        {sessions.map((sess, idx) => {
          const file = sess.file;
          const s = sessionStats?.[file];
          const fi = failMap[file];
          const isFail = !!fi;
          const isChk = !!diagLoading[file];
          const diag = diagResults[file];
          const diagCfg = diag ? STATUS_CFG[diag.status] || STATUS_CFG.UNKNOWN : null;
          const isPendingRepl = pendingFiles.has(file);

          let sent = 0, failed = 0, lbl = "";
          if (filter === "last_cycle") { sent = Number(s?.last_cycle_success || 0); failed = Number(s?.last_cycle_failed || 0); lbl = "Last Cycle"; }
          else if (filter === "24h") { sent = Number(s?.last24h_sent || 0); failed = Number(s?.last24h_failed || 0); lbl = "24h"; }
          else { sent = Number(s?.lifetime_sent || 0); failed = Number(s?.lifetime_failed || 0); lbl = "Overall"; }
          const total = sent + failed;
          const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
          const cycles = Number(s?.cycles || 0);
          const hasData = total > 0;
          const name = sess.real_name?.replace(".session", "") || file.replace(".session", "");

          return (
            <div key={file} className={`rounded-xl border overflow-hidden transition-all duration-300 ${
              isFail
                ? "border-red-500/25 bg-gradient-to-br from-dark-850 to-dark-900 shadow-sm shadow-red-500/5"
                : isPendingRepl
                ? "border-amber-500/20 bg-gradient-to-br from-dark-850 to-dark-900"
                : "border-white/[0.06] bg-dark-850"
            }`}>
              {isFail && <div className="h-0.5 bg-gradient-to-r from-red-500 via-red-400/40 to-transparent" />}
              {isPendingRepl && !isFail && <div className="h-0.5 bg-gradient-to-r from-amber-500 via-amber-400/40 to-transparent" />}

              <div className="p-3 sm:p-4">
                {/* Row 1: Avatar + Name + Badges */}
                <div className="flex items-center gap-2.5">
                  <div className={`flex items-center justify-center h-10 w-10 rounded-xl text-sm font-bold shrink-0 shadow-md ${
                    isFail
                      ? "bg-gradient-to-br from-red-500 to-red-700 text-white shadow-red-500/20"
                      : isPendingRepl
                      ? "bg-gradient-to-br from-amber-500 to-amber-700 text-white shadow-amber-500/20"
                      : `bg-gradient-to-br ${COLORS[idx % COLORS.length]} text-white`
                  }`}>
                    {name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-bold text-dark-50 truncate">{name}</span>
                      {/* Status badges */}
                      {isPendingRepl && (
                        <span className="text-[8px] font-bold rounded-full bg-amber-500/20 border border-amber-500/25 px-1.5 py-0.5 text-amber-400 whitespace-nowrap inline-flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" /> REPLACING
                        </span>
                      )}
                      {isFail && !diag && !isPendingRepl && (
                        <span className="text-[8px] font-bold rounded-full bg-red-500/20 border border-red-500/30 px-1.5 py-0.5 text-red-400 animate-pulse whitespace-nowrap">
                          FAILING {fi ? Math.round(fi.failRate * 100) : 0}%
                        </span>
                      )}
                      {diag && diagCfg && (
                        <span className={`text-[8px] font-bold rounded-full ${diagCfg.bg} border ${diagCfg.border} px-1.5 py-0.5 ${diagCfg.text} whitespace-nowrap inline-flex items-center gap-0.5`}>
                          <diagCfg.Icon className="h-2.5 w-2.5" /> {diagCfg.label.toUpperCase()}
                        </span>
                      )}
                      {!isFail && !isPendingRepl && hasData && !diag && (
                        <span className="text-[8px] font-bold rounded-full bg-emerald-500/15 border border-emerald-500/25 px-1.5 py-0.5 text-emerald-400 whitespace-nowrap">
                          OK
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-dark-600 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      {sess.user_id ? <span>ID: {sess.user_id}</span> : null}
                      {cycles > 0 && <span>{cycles} cyc</span>}
                      <span className="font-mono">{file.replace(".session", "").slice(-8)}</span>
                    </div>
                  </div>
                </div>

                {/* Row 2: Action buttons */}
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  <button type="button" onClick={() => openEdit(file)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-dark-800/80 hover:bg-dark-700 text-dark-300 hover:text-dark-100 border border-white/[0.06] transition-all cursor-pointer">
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  {/* Show Check Why for failing OR healthy sessions (user might want to verify) */}
                  {(isFail || hasData) && (
                    <button type="button"
                      onClick={() => doCheckWhy(file)}
                      disabled={isChk}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all cursor-pointer disabled:opacity-50 ${
                        isFail
                          ? "bg-accent/20 text-accent border-accent/30 hover:bg-accent/35"
                          : "bg-dark-800/60 text-dark-300 border-white/[0.06] hover:bg-dark-700"
                      }`}>
                      {isChk ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                      {isChk ? "Checking..." : "Check Why"}
                    </button>
                  )}
                  {isFail && !isPendingRepl && (
                    <button type="button"
                      onClick={() => openReplace([file])}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20 transition-all cursor-pointer">
                      <ArrowRightLeft className="h-3 w-3" /> Replace
                    </button>
                  )}
                </div>

                {/* Row 3: Stats grid */}
                {hasData ? (
                  <div className="mt-3">
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { v: sent, l: "Sent", c: "text-emerald-400" },
                        { v: failed, l: "Failed", c: "text-red-400" },
                        { v: `${pct}%`, l: "Success", c: pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400" },
                        { v: cycles, l: "Cycles", c: "text-dark-200" },
                      ].map((col) => (
                        <div key={col.l} className="rounded-lg bg-white/[0.02] border border-white/[0.04] px-1.5 py-1.5 text-center">
                          <div className={`text-[13px] font-bold ${col.c} tabular-nums`}>
                            {typeof col.v === "number" ? col.v.toLocaleString() : col.v}
                          </div>
                          <div className="text-[8px] text-dark-500 font-medium uppercase tracking-wider">{col.l}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-1000 ${
                        isFail ? "bg-gradient-to-r from-red-500 to-red-400"
                        : pct >= 70 ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                        : pct >= 40 ? "bg-gradient-to-r from-amber-500 to-amber-400"
                        : "bg-gradient-to-r from-red-500 to-red-400"
                      }`} style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                    <div className="flex justify-between mt-0.5 text-[8px] text-dark-600">
                      <span>{lbl}</span>
                      <span>{total.toLocaleString()} total</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center justify-center gap-2 py-3 text-[11px] text-dark-500 rounded-lg bg-white/[0.01] border border-white/[0.03]">
                    <WifiOff className="h-3.5 w-3.5 opacity-40" /> No activity yet
                  </div>
                )}

                {/* Loading: health check in progress */}
                {isChk && !diag && (
                  <div className="mt-3 rounded-lg bg-accent/[0.06] border border-accent/20 p-3">
                    <div className="flex items-center gap-2.5">
                      <Loader2 className="h-5 w-5 text-accent animate-spin shrink-0" />
                      <div>
                        <p className="text-[12px] font-semibold text-accent">Running health check...</p>
                        <p className="text-[9px] text-dark-500">Step 1: Validating session is alive...</p>
                        <p className="text-[9px] text-dark-500">Step 2: Checking SpamBot status...</p>
                        <p className="text-[9px] text-dark-600 mt-0.5">This takes 10-30 seconds.</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Diagnosis result card */}
                {diag && diagCfg && (
                  <div className={`mt-3 rounded-lg border ${diagCfg.border} ${diagCfg.bg} p-3`}>
                    <div className="flex items-start gap-2.5">
                      <div className={`p-2 rounded-lg ${diagCfg.iconBg} shrink-0`}>
                        <diagCfg.Icon className={`h-4 w-4 ${diagCfg.text}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`text-[12px] font-bold ${diagCfg.text}`}>{diagCfg.label}</p>
                          {diag.validation === "failed" && (
                            <span className="text-[8px] font-bold rounded-full bg-red-500/20 border border-red-500/30 px-1.5 py-0.5 text-red-400">SESSION DEAD</span>
                          )}
                          {diag.validation === "ok" && diag.source === "spambot" && (
                            <span className="text-[8px] font-bold rounded-full bg-emerald-500/15 border border-emerald-500/25 px-1.5 py-0.5 text-emerald-400">SESSION ALIVE</span>
                          )}
                        </div>
                        <p className="text-[10px] text-dark-400 mt-0.5">{diag.reason}</p>
                        <p className="text-[9px] text-dark-500 mt-0.5">{diagCfg.desc}</p>
                        {diag.source === "stats" && (
                          <p className="text-[8px] text-dark-600 mt-1 flex items-center gap-1">
                            <Info className="h-2.5 w-2.5" /> Based on message stats. SpamBot check was unavailable.
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {(diag.action === "replace" || diag.action === "wait") && !isPendingRepl && (
                            <button type="button" onClick={() => openReplace([file])}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20 transition-all cursor-pointer">
                              <ArrowRightLeft className="h-3 w-3" /> Replace Now
                            </button>
                          )}
                          {diag.action === "wait" && <span className="text-[9px] text-dark-500 italic">or wait 24-48h to see if it recovers</span>}
                          {diag.action === "ok" && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-semibold">
                              <CheckCircle className="h-3 w-3" /> No action needed
                            </span>
                          )}
                          {diag.action === "unknown" && (
                            <>
                              <button type="button" onClick={() => doCheckWhy(file)} disabled={isChk}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[9px] font-semibold bg-dark-700/50 text-dark-300 border border-white/[0.06] hover:bg-dark-700/80 transition-all cursor-pointer">
                                <RefreshCw className="h-2.5 w-2.5" /> Retry
                              </button>
                              {!isPendingRepl && (
                                <button type="button" onClick={() => openReplace([file])}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[9px] font-bold bg-red-500/80 text-white hover:bg-red-500 transition-all cursor-pointer">
                                  <ArrowRightLeft className="h-2.5 w-2.5" /> Replace Anyway
                                </button>
                              )}
                            </>
                          )}
                          {isPendingRepl && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 font-semibold">
                              <Clock className="h-3 w-3" /> Replacement in progress
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Failing alert (no diagnosis yet, not loading) */}
                {isFail && !diag && !isChk && fi && !isPendingRepl && (
                  <div className="mt-3 rounded-lg bg-red-500/[0.06] border border-red-500/20 p-3">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-[11px] font-bold text-red-400">
                          This session is failing at {Math.round(fi.failRate * 100)}% rate
                        </p>
                        <p className="text-[9px] text-dark-500 mt-0.5">
                          Last cycle: {fi.lcFailed}/{fi.attempted} messages failed
                          {fi.ltTotal > 0 && ` · Lifetime: ${fi.ltFailed}/${fi.ltTotal} failed`}
                        </p>
                        <p className="text-[9px] text-dark-500 mt-1">
                          Click &quot;Check Why&quot; to see if it&apos;s limited/frozen, or replace it directly.
                        </p>
                        <div className="flex gap-1.5 mt-2">
                          <button type="button" onClick={() => doCheckWhy(file)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-accent text-white hover:bg-accent/90 transition-all cursor-pointer active:scale-95">
                            <Search className="h-3 w-3" /> Check Why
                          </button>
                          <button type="button" onClick={() => openReplace([file])}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/25 hover:bg-red-500/30 transition-all cursor-pointer active:scale-95">
                            <ArrowRightLeft className="h-3 w-3" /> Replace
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sessions.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-dark-850 flex flex-col items-center justify-center py-16">
          <Users className="h-10 w-10 text-dark-600 mb-2" />
          <p className="text-sm font-medium text-dark-400">No sessions assigned</p>
        </div>
      )}

      {/* ══════ REPLACE MODAL ══════ */}
      <Modal open={replModal} onClose={() => { setReplModal(false); setReplMsg(null); }} size="md">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-red-500/20 border border-red-500/25 shrink-0">
              <ArrowRightLeft className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-dark-50">
                Replace {replTargets.length} Session{replTargets.length !== 1 ? "s" : ""}
              </h2>
              <p className="text-[11px] sm:text-[12px] text-dark-400 mt-0.5">
                Dead sessions will be swapped with fresh accounts from the pool.
              </p>
            </div>
          </div>

          {/* Session list in modal */}
          <div className="space-y-2 max-h-[200px] overflow-y-auto">
            {replTargets.map((sf) => {
              const fi2 = failMap[sf];
              const dg = diagResults[sf];
              const th = dg ? STATUS_CFG[dg.status] || STATUS_CFG.UNKNOWN : null;
              const si = sessions.find((sx) => sx.file === sf);
              const nm = si?.real_name?.replace(".session", "") || sf.replace(".session", "");
              const rt = fi2 ? Math.round(fi2.failRate * 100) : 0;
              return (
                <div key={sf} className={`rounded-lg border px-3 py-2.5 ${
                  th ? `${th.bg} ${th.border}` : "bg-red-500/[0.05] border-red-500/20"
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12px] font-semibold text-dark-200 truncate">{nm}</span>
                        {dg && th && (
                          <span className={`text-[8px] font-bold rounded-full ${th.bg} border ${th.border} px-1.5 py-0.5 ${th.text} inline-flex items-center gap-0.5`}>
                            <th.Icon className="h-2 w-2" /> {th.label}
                          </span>
                        )}
                      </div>
                      <p className="text-[9px] text-dark-500 mt-0.5 truncate">
                        {dg ? dg.reason : rt > 0 ? `${rt}% failure rate` : "Failing session"}
                      </p>
                    </div>
                    {rt > 0 && <span className="text-lg font-bold text-red-400 shrink-0 tabular-nums">{rt}%</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Cost breakdown */}
          <div className="rounded-lg bg-dark-800/50 border border-white/[0.06] p-3">
            <p className="text-[11px] font-bold text-dark-200 mb-2 flex items-center gap-1.5">
              <CircleDollarSign className="h-3.5 w-3.5 text-accent" /> Cost Breakdown
            </p>
            {(() => {
              const n = replTargets.length;
              const fu = Math.min(freeRem, n);
              const pd = Math.max(0, n - fu);
              const tc = pd * pricePer;
              return (
                <div className="space-y-2">
                  {fu > 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1.5 text-emerald-400">
                        <Gift className="h-3 w-3" /> {fu} free replacement{fu !== 1 ? "s" : ""}
                      </span>
                      <span className="font-bold text-emerald-400">$0.00</span>
                    </div>
                  )}
                  {pd > 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1.5 text-amber-400">
                        <CreditCard className="h-3 w-3" /> {pd} paid x ${pricePer.toFixed(2)}
                      </span>
                      <span className="font-bold text-amber-400">${tc.toFixed(2)}</span>
                    </div>
                  )}
                  {pd > 0 && (
                    <p className="text-[9px] text-dark-500 flex items-center gap-1">
                      <Info className="h-2.5 w-2.5" /> Paid replacements: payment via Telegram bot after confirming.
                    </p>
                  )}
                  <div className="border-t border-white/[0.06] pt-2 flex items-center justify-between">
                    <span className="text-[12px] font-bold text-dark-100">Total</span>
                    <span className={`text-base font-bold ${tc === 0 ? "text-emerald-400" : "text-dark-50"}`}>
                      {tc === 0 ? "FREE" : `$${tc.toFixed(2)}`}
                    </span>
                  </div>
                  {freeRem > 0 && (
                    <p className="text-[9px] text-dark-500">
                      You have {freeRem} free replacement{freeRem !== 1 ? "s" : ""} remaining on your plan.
                    </p>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Result message */}
          {replMsg && (
            <div className={`rounded-lg px-3 py-3 ${
              replMsg.ok ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"
            }`}>
              <div className="flex items-start gap-2">
                {replMsg.ok ? <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />}
                <p className={`text-[11px] font-semibold leading-relaxed ${replMsg.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {replMsg.ok ? replMsg.text : replMsg.error}
                </p>
              </div>
            </div>
          )}

          {/* Modal buttons */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setReplModal(false); setReplMsg(null); }}
              className="px-4 py-2 rounded-lg text-[12px] text-dark-400 hover:text-dark-200 transition-colors cursor-pointer">
              {replMsg?.ok ? "Done" : "Cancel"}
            </button>
            {!replMsg?.ok && (
              <button type="button" onClick={confirmReplace} disabled={replLoading}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-bold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 shadow-lg shadow-red-500/25 transition-all cursor-pointer">
                {replLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                {replLoading ? "Replacing..." : "Confirm Replace"}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* ══════ EDIT MODAL ══════ */}
      <Modal open={!!editFile} onClose={() => { setEditFile(null); setEditMsg(null); }} title="Edit Profile" size="md">
        {infoLoading ? (
          <div className="flex flex-col items-center py-10">
            <Loader2 className="h-8 w-8 text-accent animate-spin" />
            <p className="text-sm text-dark-400 mt-3">Loading account info...</p>
          </div>
        ) : editMsg?.error && !accountInfo ? (
          <div className="text-center py-8">
            <XCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
            <p className="text-sm text-red-400">{editMsg.error}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {accountInfo && (
              <div className="flex items-center gap-3 rounded-lg bg-dark-800/40 p-3 border border-white/[0.04]">
                <div className="h-9 w-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
                  <User className="h-4 w-4 text-accent" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-dark-100">{accountInfo.first_name} {accountInfo.last_name}</p>
                  <p className="text-[10px] text-dark-500">
                    {accountInfo.username ? `@${accountInfo.username}` : "No username"} · ID: {accountInfo.user_id}
                  </p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-dark-400 mb-1">First Name</label>
                <input type="text" value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.06] bg-dark-800/60 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="First" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-dark-400 mb-1">Last Name</label>
                <input type="text" value={editLastName} onChange={(e) => setEditLastName(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.06] bg-dark-800/60 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="Last" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Bio</label>
              <textarea value={editBio} onChange={(e) => setEditBio(e.target.value)} rows={2} maxLength={70}
                className="w-full rounded-lg border border-white/[0.06] bg-dark-800/60 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none resize-none" placeholder="Bio (70 chars max)" />
              <div className="text-[9px] text-dark-600 text-right">{editBio.length}/70</div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Username</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-dark-500">@</span>
                <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                  className="flex-1 rounded-lg border border-white/[0.06] bg-dark-800/60 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="username" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Photo</label>
              <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-dashed border-dark-600/50 bg-dark-800/30 hover:bg-dark-800/60 px-3 py-3 transition-colors">
                <Camera className="h-4 w-4 text-dark-400" />
                <span className="text-[11px] text-dark-400">{editPhoto ? editPhoto.name : "Choose photo..."}</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => setEditPhoto(e.target.files?.[0] || null)} />
              </label>
            </div>
            {editMsg?.ok && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[11px] text-emerald-400 font-semibold">
                <CheckCircle className="h-3.5 w-3.5" /> Updated!
              </div>
            )}
            {editMsg?.error && accountInfo && (
              <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-[11px] text-red-400 font-semibold">
                <XCircle className="h-3.5 w-3.5" /> {editMsg.error}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setEditFile(null); setEditMsg(null); }}
                className="px-4 py-2 rounded-lg text-[12px] text-dark-400 hover:text-dark-200 cursor-pointer">Cancel</button>
              <button type="button" onClick={submitEdit} disabled={editLoading}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-[12px] font-bold bg-accent text-white hover:bg-accent/90 disabled:opacity-50 shadow-lg shadow-accent/20 transition-all cursor-pointer">
                {editLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
