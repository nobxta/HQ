"use client";
import { usePortalBot, usePortalStats } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Users, AlertTriangle, CheckCircle, XCircle,
  Loader2, Pencil, Camera, RefreshCw, ArrowRightLeft,
  User, AlertOctagon, Search, Skull, Ban,
  Timer, HelpCircle, CircleDollarSign, Gift,
  CreditCard, WifiOff, Activity, ShieldCheck, Info,
  Clock, ChevronRight, ChevronDown, Zap, Send,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import CryptoPaymentModal from "@/components/portal/CryptoPaymentModal";

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
   STATUS THEME
   ═══════════════════════════════════════════════════════ */

const STATUS_CFG: Record<string, {
  bg: string; border: string; text: string;
  iconBg: string; Icon: any; label: string; desc: string;
}> = {
  FROZEN: {
    bg: "bg-red-500/[0.06]", border: "border-red-500/15", text: "text-red-400",
    iconBg: "bg-red-500/15", Icon: Skull, label: "Frozen / Dead",
    desc: "Permanently frozen by Telegram. Replace immediately.",
  },
  DEAD: {
    bg: "bg-red-500/[0.06]", border: "border-red-500/15", text: "text-red-400",
    iconBg: "bg-red-500/15", Icon: Skull, label: "Dead Session",
    desc: "Session is no longer valid. It was logged out, revoked, or banned.",
  },
  HARD_LIMITED: {
    bg: "bg-red-500/[0.06]", border: "border-red-500/15", text: "text-red-400",
    iconBg: "bg-red-500/15", Icon: Ban, label: "Permanently Limited",
    desc: "Telegram permanently limited this account. Won't recover.",
  },
  TEMP_LIMITED: {
    bg: "bg-amber-500/[0.06]", border: "border-amber-500/15", text: "text-amber-400",
    iconBg: "bg-amber-500/15", Icon: Timer, label: "Temporarily Limited",
    desc: "May recover in 24-48h, or replace now.",
  },
  ACTIVE: {
    bg: "bg-emerald-500/[0.06]", border: "border-emerald-500/15", text: "text-emerald-400",
    iconBg: "bg-emerald-500/15", Icon: ShieldCheck, label: "Active & Healthy",
    desc: "SpamBot says this account is clean.",
  },
  BUSY: {
    bg: "bg-sky-500/[0.06]", border: "border-sky-500/15", text: "text-sky-400",
    iconBg: "bg-sky-500/15", Icon: Activity, label: "In Use",
    desc: "Session is currently busy. Try again in a few minutes.",
  },
  STATS_FAILING: {
    bg: "bg-amber-500/[0.06]", border: "border-amber-500/15", text: "text-amber-400",
    iconBg: "bg-amber-500/15", Icon: Activity, label: "Failing (Stats)",
    desc: "Session is alive but has high failure rate.",
  },
  UNKNOWN: {
    bg: "bg-dark-700/20", border: "border-white/[0.06]", text: "text-dark-400",
    iconBg: "bg-dark-700/30", Icon: HelpCircle, label: "Unknown",
    desc: "Could not determine status. Try again or replace.",
  },
  STATS_ONLY: {
    bg: "bg-red-500/[0.06]", border: "border-red-500/15", text: "text-red-400",
    iconBg: "bg-red-500/15", Icon: Activity, label: "High Failure Rate",
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

const AVATAR_COLORS = [
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
    ? "bg-emerald-500/15 border-emerald-500/25 text-emerald-300"
    : type === "warn"
    ? "bg-amber-500/15 border-amber-500/25 text-amber-300"
    : "bg-red-500/15 border-red-500/25 text-red-300";
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

  useEffect(() => {
    if (!mounted) return;
    const s = getPortalSession();
    console.log("[Accounts] PAGE MOUNTED. Session:", s ? { bot_name: s.bot_name, telegram_id: s.telegram_id } : "NULL");
    console.log("[Accounts] API URL:", process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000");
  }, [mounted]);

  const { data: bot, isLoading, error: botError, mutate: mutateBot } = usePortalBot();
  const { data: stats } = usePortalStats();

  const [filter, setFilter] = useState<TimeFilter>("overall");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" | "warn" } | null>(null);
  const showToast = useCallback((msg: string, type: "ok" | "err" | "warn" = "ok") => setToast({ msg, type }), []);

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

  // Crypto payment
  const [payModal, setPayModal] = useState(false);
  const [payEntryId, setPayEntryId] = useState("");
  const [paySessionName, setPaySessionName] = useState("");
  const [payAmountUsd, setPayAmountUsd] = useState(0);

  // Support ticket modal
  const [supportModal, setSupportModal] = useState(false);
  const [supportFile, setSupportFile] = useState("");
  const [supportName, setSupportName] = useState("");
  const [supportDiag, setSupportDiag] = useState<DiagResult | null>(null);
  const [supportFailRate, setSupportFailRate] = useState(0);
  const [supportMsg, setSupportMsg] = useState("");
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportResult, setSupportResult] = useState<{ ok?: boolean; text?: string } | null>(null);

  // Collapsible queue
  const [queueExpanded, setQueueExpanded] = useState(false);

  /* ─── Restore saved diagnosis from stats._last_spam_status on load ─── */
  useEffect(() => {
    const ss = stats?.session_stats as Record<string, any> | undefined;
    if (!ss) return;
    const restored: Record<string, DiagResult> = {};
    const _BAD: Record<string, { action: "replace" | "wait" | "ok"; severity: "ok" | "warning" | "critical" | "unknown" }> = {
      FROZEN: { action: "replace", severity: "critical" },
      DEAD: { action: "replace", severity: "critical" },
      HARD_LIMITED: { action: "replace", severity: "critical" },
      TEMP_LIMITED: { action: "wait", severity: "warning" },
      ACTIVE: { action: "ok", severity: "ok" },
    };
    for (const [file, data] of Object.entries(ss)) {
      const saved = data?._last_spam_status;
      if (!saved) continue;
      // Don't overwrite a fresher result from an in-session diagnose call
      if (diagResults[file]) continue;
      const cfg = STATUS_CFG[saved] || STATUS_CFG.UNKNOWN;
      const info = _BAD[saved];
      restored[file] = {
        status: saved,
        reason: cfg.desc || "Saved from previous check",
        action: info?.action || "unknown",
        source: "spambot",
        severity: info?.severity || "unknown" as const,
      };
    }
    if (Object.keys(restored).length > 0) {
      setDiagResults((p) => ({ ...restored, ...p }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats?.session_stats]);

  const openSupportModal = useCallback((file: string, name: string, diag: DiagResult | null, failRate: number) => {
    setSupportFile(file);
    setSupportName(name);
    setSupportDiag(diag);
    setSupportFailRate(failRate);
    setSupportMsg("");
    setSupportResult(null);
    setSupportModal(true);
  }, []);

  const submitSupportTicket = useCallback(async () => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) { showToast("Please log in again", "err"); return; }
    if (!supportMsg.trim()) { showToast("Please describe the issue", "warn"); return; }
    setSupportLoading(true);
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/support-ticket?telegram_id=${s.telegram_id}`,
        {
          session_file: supportFile,
          session_name: supportName,
          issue_type: supportDiag?.action === "ok" ? "healthy_but_failing" : "other",
          message: supportMsg.trim(),
          diag_status: supportDiag?.status || null,
          fail_rate: supportFailRate,
        }
      );
      setSupportResult({ ok: true, text: r.data?.message || "Ticket submitted!" });
      showToast("Support ticket sent!", "ok");
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || "Failed to submit";
      setSupportResult({ ok: false, text: detail });
      showToast(detail, "err");
    } finally {
      setSupportLoading(false);
    }
  }, [supportFile, supportName, supportDiag, supportFailRate, supportMsg, showToast]);

  /* ─── Fetch replacement status ─── */
  const fetchRepl = useCallback(() => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;
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
     DIAGNOSE
     ══════════════════════════════════════════════════════ */
  const doCheckWhy = useCallback(async (file: string) => {
    const s = getPortalSession();
    console.log("[Accounts] Check Why →", file, "bot:", s?.bot_name);
    if (!s?.bot_name || s?.telegram_id == null) { showToast("Please log in again", "err"); return; }
    setDiagLoading((p) => ({ ...p, [file]: true }));
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/diagnose?telegram_id=${s.telegram_id}`,
        { session_files: [file] }, { timeout: 35000 }
      );
      console.log("[Accounts] Diagnose OK:", JSON.stringify(r.data));
      const res = r.data?.results;
      if (res?.length > 0) {
        const d = res[0];
        const action = d.action === "replace" ? "replace" as const : d.action === "wait_or_replace" ? "wait" as const : d.action === "none" ? "ok" as const : "unknown" as const;
        const diag: DiagResult = { status: d.spam_status || "UNKNOWN", reason: d.reason || "Check complete", action, source: "spambot", validation: d.validation || "ok", severity: d.severity || "unknown" };
        setDiagResults((p) => ({ ...p, [file]: diag }));
        const cfg = STATUS_CFG[diag.status] || STATUS_CFG.UNKNOWN;
        showToast(`${cfg.label}: ${diag.reason}`, diag.severity === "ok" ? "ok" : diag.severity === "critical" ? "err" : "warn");
        setDiagLoading((p) => ({ ...p, [file]: false }));
        return;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err?.message || "Unknown error";
      console.error("[Accounts] Diagnose error:", status, detail);
      if (status === 403) { showToast(`Access denied: ${detail}`, "err"); setDiagLoading((p) => ({ ...p, [file]: false })); return; }
      if (status === 404) { showToast("Diagnose endpoint not found — restart backend", "err"); setDiagLoading((p) => ({ ...p, [file]: false })); return; }
    }
    const fi = getFailInfo(stats?.session_stats, file);
    if (fi) {
      setDiagResults((p) => ({ ...p, [file]: mkStatsDiag(fi.failRate) }));
      showToast(`${Math.round(fi.failRate * 100)}% failure — SpamBot unavailable`, "warn");
    } else {
      setDiagResults((p) => ({ ...p, [file]: { status: "UNKNOWN", reason: "Could not reach SpamBot. Try again.", action: "unknown", source: "stats" } }));
      showToast("Could not check session — try again", "err");
    }
    setDiagLoading((p) => ({ ...p, [file]: false }));
  }, [stats?.session_stats, showToast]);

  const doCheckAll = useCallback(async (files: string[]) => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) { showToast("Please log in again", "err"); return; }
    const batch: Record<string, boolean> = {};
    files.forEach((f) => { batch[f] = true; });
    setDiagLoading((p) => ({ ...p, ...batch }));
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/diagnose?telegram_id=${s.telegram_id}`,
        { session_files: files }, { timeout: 60000 }
      );
      const res = r.data?.results;
      if (res?.length > 0) {
        const nd: Record<string, DiagResult> = {};
        let critCount = 0, warnCount = 0, okCount = 0;
        for (const d of res) {
          const action = d.action === "replace" ? "replace" as const : d.action === "wait_or_replace" ? "wait" as const : d.action === "none" ? "ok" as const : "unknown" as const;
          nd[d.session_file] = { status: d.spam_status || "UNKNOWN", reason: d.reason || "Check complete", action, source: "spambot", validation: d.validation || "ok", severity: d.severity || "unknown" };
          if (d.severity === "critical") critCount++;
          else if (d.severity === "warning") warnCount++;
          else if (d.severity === "ok") okCount++;
        }
        setDiagResults((p) => ({ ...p, ...nd }));
        const done: Record<string, boolean> = {};
        files.forEach((f) => { done[f] = false; });
        setDiagLoading((p) => ({ ...p, ...done }));
        const summary = [critCount > 0 ? `${critCount} critical` : "", warnCount > 0 ? `${warnCount} warning` : "", okCount > 0 ? `${okCount} healthy` : ""].filter(Boolean).join(", ");
        showToast(`Checked ${res.length}: ${summary || "done"}`, critCount > 0 ? "err" : warnCount > 0 ? "warn" : "ok");
        return;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail || err?.message || "Unknown error";
      if (status === 403 || status === 404) {
        showToast(status === 403 ? `Access denied: ${detail}` : "Diagnose endpoint not found", "err");
        const done: Record<string, boolean> = {};
        files.forEach((f) => { done[f] = false; });
        setDiagLoading((p) => ({ ...p, ...done }));
        return;
      }
    }
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
     REPLACE
     ══════════════════════════════════════════════════════ */
  const openReplace = useCallback((targets: string[]) => {
    console.log("[Accounts] Replace modal →", targets);
    setReplTargets(targets); setReplMsg(null); setReplModal(true); fetchRepl();
  }, [fetchRepl]);

  const confirmReplace = useCallback(async () => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null || replTargets.length === 0) { showToast("Please log in again", "err"); return; }
    console.log("[Accounts] Confirming replace:", replTargets);
    setReplLoading(true); setReplMsg(null);
    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/replace?telegram_id=${s.telegram_id}`,
        { session_files: replTargets }, { timeout: 90000 }
      );
      const d = r.data;
      console.log("[Accounts] Replace response:", JSON.stringify(d));

      if (d.already_queued && d.queued === 0) {
        setReplMsg({ ok: true, text: d.message || "Already queued for replacement." });
        showToast(d.message || "Already queued", "warn");
        fetchRepl(); mutateBot(); return;
      }

      const processed = d.processed || 0;
      const awaitingPool = d.awaiting_pool || 0;
      const q = d.queued || 0;
      const freeCount = d.entries?.filter((e: any) => e.free_replacement).length || 0;
      const needsPayment = d.entries?.filter((e: any) => e.status === "pending_payment").length || 0;

      let msg = "";
      if (processed > 0) {
        msg = `${processed} session${processed !== 1 ? "s" : ""} replaced successfully!`;
        if (d.completed?.length > 0) msg += ` New: ${d.completed.map((c: any) => c.real_name || "new session").join(", ")}.`;
      } else if (awaitingPool > 0) {
        msg = `${q} queued — no fresh sessions in pool yet. Admin notified.`;
      } else if (needsPayment > 0) {
        msg = `${needsPayment} session${needsPayment !== 1 ? "s" : ""} need payment ($${d.price_per_session}/ea).`;
      } else if (q > 0) {
        msg = `${q} replacement${q !== 1 ? "s" : ""} queued for processing.`;
      }

      setReplMsg({ ok: true, text: msg || "Replacement requested." });
      showToast(msg || "Replacement requested", processed > 0 ? "ok" : needsPayment > 0 ? "warn" : "ok");
      fetchRepl(); mutateBot();

      if (needsPayment > 0 && d.entries?.length) {
        const firstPaid = d.entries.find((e: any) => e.status === "pending_payment");
        if (firstPaid) {
          setTimeout(() => {
            setPayEntryId(firstPaid.id);
            setPaySessionName((firstPaid.real_name || firstPaid.session_file || "").replace(".session", ""));
            setPayAmountUsd(Number(firstPaid.price_usd || d.price_per_session || 2));
            setPayModal(true); setReplModal(false);
          }, 800);
        }
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || "Failed to request replacement";
      console.error("[Accounts] Replace error:", err?.response?.status, detail);
      setReplMsg({ error: detail }); showToast(detail, "err");
    } finally { setReplLoading(false); }
  }, [replTargets, fetchRepl, mutateBot, showToast]);

  /* ══════════════════════════════════════════════════════
     EDIT
     ══════════════════════════════════════════════════════ */
  const openEdit = useCallback(async (file: string) => {
    const s = getPortalSession();
    setEditFile(file); setEditMsg(null); setEditPhoto(null); setAccountInfo(null); setInfoLoading(true);
    try {
      const r = await portalApi.get(`/api/portal/bot/${s?.bot_name}/account/${encodeURIComponent(file)}/info?telegram_id=${s?.telegram_id}`);
      const info = r.data as AccountInfo;
      setAccountInfo(info);
      setEditFirstName(info.first_name || ""); setEditLastName(info.last_name || "");
      setEditBio(""); setEditUsername(info.username || "");
    } catch (e: any) { setEditMsg({ error: e?.response?.data?.detail || "Failed to load account info" }); }
    finally { setInfoLoading(false); }
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
      setEditMsg({ ok: true }); showToast("Profile updated!", "ok"); mutateBot();
    } catch (e: any) { setEditMsg({ error: e?.response?.data?.detail || "Update failed" }); }
    finally { setEditLoading(false); }
  }, [editFile, editFirstName, editLastName, editBio, editUsername, editPhoto, mutateBot, showToast]);

  /* ══════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════ */
  if (!mounted || isLoading) return <PageSkeleton />;

  const currentSession = mounted ? getPortalSession() : null;
  if (!bot) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-dark-400 space-y-3">
      <Users className="h-12 w-12 mb-3 opacity-30" />
      <p className="text-lg font-medium">No bot found</p>
      {!currentSession && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 max-w-sm text-center">
          <p className="text-[12px] text-amber-400 font-semibold mb-2">Not logged in</p>
          <p className="text-[10px] text-dark-500 mb-3">No portal session found.</p>
          <a href="/login" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-bold bg-accent text-white hover:bg-accent/90">Go to Login</a>
        </div>
      )}
      {currentSession && (
        <div className="rounded-xl border border-red-500/15 bg-red-500/[0.04] p-4 max-w-sm text-center">
          <p className="text-[12px] text-red-400 font-semibold mb-1">Session error</p>
          <p className="text-[10px] text-dark-500">Bot: <span className="font-mono text-dark-300">{currentSession.bot_name}</span></p>
          {botError && <p className="text-[9px] text-red-400 mt-1">Error: {botError?.message || "Unknown"}</p>}
        </div>
      )}
    </div>
  );

  const sessions: Array<{ file: string; real_name: string; user_id?: number }> = bot.sessions || [];
  const sessionStats = stats?.session_stats as Record<string, any> | undefined;

  const _BAD_DIAG_STATUSES = new Set(["FROZEN", "DEAD", "HARD_LIMITED", "STATS_FAILING", "STATS_ONLY"]);

  const failMap: Record<string, ReturnType<typeof getFailInfo>> = {};
  const failFiles: string[] = [];
  const diagBadFiles = new Set<string>(); // diagnosed-bad but not stats-failing
  sessions.forEach((s) => {
    const fi = getFailInfo(sessionStats, s.file);
    if (fi) { failMap[s.file] = fi; failFiles.push(s.file); }
    // Also count sessions with saved bad diagnosis (even if stats are 0)
    else {
      const diag = diagResults[s.file];
      if (diag && _BAD_DIAG_STATUSES.has(diag.status)) {
        failFiles.push(s.file);
        diagBadFiles.add(s.file);
      }
    }
  });

  const anyLoading = Object.values(diagLoading).some(Boolean);
  const pendingFiles = new Set(pendingReplacements.map((p: any) => p.session_file));
  const unresolvedFailFiles = failFiles.filter(f => !pendingFiles.has(f));

  // Summary counts for header
  const healthyCount = sessions.filter(s => !failMap[s.file] && !diagBadFiles.has(s.file) && !pendingFiles.has(s.file)).length;
  const failingCount = unresolvedFailFiles.length;
  const replacingCount = pendingReplacements.length;

  return (
    <div className="space-y-5 animate-fade-in" suppressHydrationWarning>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* ══════ HEADER ══════ */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 rounded-2xl bg-accent/10 shrink-0">
            <Users className="h-5 w-5 text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-dark-50">Accounts</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-dark-500">{sessions.length} sessions</span>
              {healthyCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{healthyCount} healthy
                </span>
              )}
              {failingCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />{failingCount} needs attention
                </span>
              )}
              {replacingCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-accent font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />{replacingCount} replacing
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="hidden sm:flex gap-0.5 rounded-lg bg-dark-800/60 border border-white/[0.04] p-0.5">
            {([
              { k: "last_cycle" as TimeFilter, l: "Cycle" },
              { k: "24h" as TimeFilter, l: "24h" },
              { k: "overall" as TimeFilter, l: "All" },
            ]).map((f) => (
              <button key={f.k} type="button" onClick={() => setFilter(f.k)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all cursor-pointer ${
                  filter === f.k ? "bg-accent text-white" : "text-dark-500 hover:text-dark-300"
                }`}>{f.l}</button>
            ))}
          </div>
          <button type="button" onClick={() => { mutateBot(); fetchRepl(); }}
            className="p-2 rounded-lg text-dark-500 hover:text-dark-300 hover:bg-dark-800/50 transition-all cursor-pointer" title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Mobile filter */}
      <div className="flex sm:hidden gap-0.5 rounded-lg bg-dark-800/60 border border-white/[0.04] p-0.5">
        {([
          { k: "last_cycle" as TimeFilter, l: "Last Cycle" },
          { k: "24h" as TimeFilter, l: "24h" },
          { k: "overall" as TimeFilter, l: "Overall" },
        ]).map((f) => (
          <button key={f.k} type="button" onClick={() => setFilter(f.k)}
            className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-semibold text-center transition-all cursor-pointer ${
              filter === f.k ? "bg-accent text-white" : "text-dark-500 hover:text-dark-300"
            }`}>{f.l}</button>
        ))}
      </div>

      {/* ══════ REPLACEMENT PLAN INFO ══════ */}
      <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/[0.06] bg-dark-850 p-3">
        <div className="flex flex-col items-center gap-1 py-1">
          <Gift className="h-4 w-4 text-emerald-400" />
          <span className="text-[16px] font-bold text-emerald-400 tabular-nums">{freeRem}</span>
          <span className="text-[9px] font-medium text-dark-500 text-center leading-tight">Free Left</span>
        </div>
        <div className="flex flex-col items-center gap-1 py-1 border-x border-white/[0.06]">
          <CreditCard className="h-4 w-4 text-accent" />
          <span className="text-[16px] font-bold text-dark-100 tabular-nums">${pricePer.toFixed(2)}</span>
          <span className="text-[9px] font-medium text-dark-500 text-center leading-tight">Per Session</span>
        </div>
        <div className="flex flex-col items-center gap-1 py-1">
          <ArrowRightLeft className="h-4 w-4 text-amber-400" />
          <span className="text-[16px] font-bold text-amber-400 tabular-nums">{pendingReplacements.length}</span>
          <span className="text-[9px] font-medium text-dark-500 text-center leading-tight">In Queue</span>
        </div>
      </div>

      {/* ══════ ACTION BAR — compact alert + actions ══════ */}
      {(unresolvedFailFiles.length > 0 || pendingReplacements.length > 0) && (
        <div className="rounded-2xl border border-white/[0.06] bg-dark-850 overflow-hidden">
          {/* Failing sessions — compact bar */}
          {unresolvedFailFiles.length > 0 && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.04]">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-amber-500/10 shrink-0">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                </div>
                <p className="text-[12px] font-semibold text-dark-200">
                  <span className="text-amber-400">{unresolvedFailFiles.length}</span> session{unresolvedFailFiles.length !== 1 ? "s" : ""} need{unresolvedFailFiles.length === 1 ? "s" : ""} attention
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => doCheckAll(unresolvedFailFiles)} disabled={anyLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-dark-800 hover:bg-dark-700 text-dark-300 border border-white/[0.06] disabled:opacity-50 transition-all cursor-pointer">
                  {anyLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                  Check Why
                </button>
                <button type="button" onClick={() => openReplace(unresolvedFailFiles)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-accent text-white hover:bg-accent/90 transition-all cursor-pointer">
                  <ArrowRightLeft className="h-3 w-3" /> Replace
                </button>
              </div>
            </div>
          )}

          {/* Replacement queue — collapsible */}
          {pendingReplacements.length > 0 && (
            <div>
              <button type="button" onClick={() => setQueueExpanded(!queueExpanded)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3 w-3 text-accent animate-spin" />
                  <span className="text-[11px] font-medium text-dark-300">
                    {pendingReplacements.length} replacement{pendingReplacements.length !== 1 ? "s" : ""} in queue
                  </span>
                </div>
                <ChevronDown className={`h-3.5 w-3.5 text-dark-500 transition-transform ${queueExpanded ? "rotate-180" : ""}`} />
              </button>
              {queueExpanded && (
                <div className="px-4 pb-3 space-y-1">
                  {pendingReplacements.map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-dark-800/30 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <span className="text-[11px] font-medium text-dark-300 truncate block">
                          {(p.real_name || p.session_file || "").replace(".session", "")}
                        </span>
                        <span className={`text-[9px] ${
                          p.status === "ready" ? "text-accent" : p.status === "pending_payment" ? "text-amber-400" : "text-dark-500"
                        }`}>
                          {p.status === "ready" ? "Processing..." : p.status === "awaiting_session" ? "Waiting for pool" : p.status === "pending_payment" ? "Payment needed" : p.status}
                        </span>
                      </div>
                      {p.status === "pending_payment" && (
                        <button onClick={() => { setPayEntryId(p.id); setPaySessionName((p.real_name || "").replace(".session", "")); setPayAmountUsd(Number(p.price_usd || 2)); setPayModal(true); }}
                          className="text-[9px] font-bold rounded-md px-2 py-1 bg-accent/15 text-accent hover:bg-accent/25 transition-colors cursor-pointer">
                          Pay ${Number(p.price_usd || 0).toFixed(2)}
                        </button>
                      )}
                      {p.status !== "pending_payment" && (
                        <span className={`text-[9px] font-medium rounded-md px-2 py-0.5 ${
                          p.free_replacement ? "bg-emerald-500/10 text-emerald-400" : "bg-dark-700/30 text-dark-500"
                        }`}>
                          {p.free_replacement ? "Free" : `$${Number(p.price_usd || 0).toFixed(2)}`}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════ SESSION CARDS ══════ */}
      <div className="space-y-2.5">
        {sessions.map((sess, idx) => {
          const file = sess.file;
          const s = sessionStats?.[file];
          const fi = failMap[file];
          const isFail = !!fi || diagBadFiles.has(file);
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
          const hasData = total > 0;
          const name = sess.real_name?.replace(".session", "") || file.replace(".session", "");

          // Determine card accent
          const cardState = isPendingRepl ? "replacing" : isFail ? "failing" : "normal";

          return (
            <div key={file} className="rounded-2xl border border-white/[0.06] bg-dark-850 overflow-hidden transition-all hover:border-white/[0.1]">
              <div className="p-4">
                {/* ─── Top row: avatar + name + status + actions ─── */}
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className={`flex items-center justify-center h-10 w-10 rounded-xl text-sm font-bold shrink-0 ${
                    cardState === "failing"
                      ? "bg-gradient-to-br from-amber-500 to-amber-700 text-white"
                      : cardState === "replacing"
                      ? "bg-gradient-to-br from-accent to-accent/70 text-white"
                      : `bg-gradient-to-br ${AVATAR_COLORS[idx % AVATAR_COLORS.length]} text-white`
                  }`}>
                    {name.charAt(0).toUpperCase()}
                  </div>

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-bold text-dark-50 truncate">{name}</span>
                      {/* Inline status pill */}
                      {isPendingRepl && (
                        <span className="text-[8px] font-semibold rounded-full bg-accent/10 border border-accent/20 px-1.5 py-0.5 text-accent whitespace-nowrap">
                          Replacing
                        </span>
                      )}
                      {diag && diagCfg && !isPendingRepl && (
                        <span className={`text-[8px] font-semibold rounded-full ${diagCfg.bg} border ${diagCfg.border} px-1.5 py-0.5 ${diagCfg.text} whitespace-nowrap`}>
                          {diagCfg.label}
                        </span>
                      )}
                      {isFail && !diag && !isPendingRepl && (
                        <span className="text-[8px] font-semibold rounded-full bg-amber-500/10 border border-amber-500/15 px-1.5 py-0.5 text-amber-400 whitespace-nowrap">
                          {fi ? Math.round(fi.failRate * 100) : 0}% failing
                        </span>
                      )}
                      {!isFail && !isPendingRepl && hasData && !diag && (
                        <span className="text-[8px] font-semibold rounded-full bg-emerald-500/10 border border-emerald-500/15 px-1.5 py-0.5 text-emerald-400 whitespace-nowrap">
                          Healthy
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-dark-600 mt-0.5 flex items-center gap-2">
                      {sess.user_id ? <span>ID: {sess.user_id}</span> : null}
                      <span className="font-mono">{file.replace(".session", "").slice(-8)}</span>
                    </div>
                  </div>

                  {/* Right side: actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button type="button" onClick={() => openEdit(file)}
                      className="p-2 rounded-lg text-dark-500 hover:text-dark-300 hover:bg-dark-800/60 transition-all cursor-pointer" title="Edit profile">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {!isPendingRepl && (
                      <button type="button" onClick={() => doCheckWhy(file)} disabled={isChk}
                        className="p-2 rounded-lg text-dark-500 hover:text-dark-300 hover:bg-dark-800/60 disabled:opacity-50 transition-all cursor-pointer" title="Check health">
                        {isChk ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <Search className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    {isFail && !isPendingRepl && (
                      <button type="button" onClick={() => openReplace([file])}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-accent/10 text-accent border border-accent/15 hover:bg-accent/20 transition-all cursor-pointer">
                        <ArrowRightLeft className="h-3 w-3" /> Replace
                      </button>
                    )}
                  </div>
                </div>

                {/* ─── Stats row ─── */}
                {hasData ? (
                  <div className="mt-3 flex items-center gap-3">
                    {/* Stats chips */}
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex items-center gap-4 text-[11px]">
                        <span className="text-dark-400">
                          <span className="font-bold text-emerald-400 tabular-nums">{sent.toLocaleString()}</span> sent
                        </span>
                        <span className="text-dark-400">
                          <span className={`font-bold tabular-nums ${failed > 0 ? "text-red-400" : "text-dark-500"}`}>{failed.toLocaleString()}</span> failed
                        </span>
                        <span className={`font-bold tabular-nums ${pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400"}`}>
                          {pct}%
                        </span>
                      </div>
                    </div>
                    {/* Mini progress bar */}
                    <div className="w-20 h-1 rounded-full bg-white/[0.04] overflow-hidden shrink-0">
                      <div className={`h-full rounded-full transition-all duration-700 ${
                        pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500"
                      }`} style={{ width: `${Math.max(pct, 3)}%` }} />
                    </div>
                    <span className="text-[9px] text-dark-600 shrink-0">{lbl}</span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 text-[10px] text-dark-600">
                    <WifiOff className="h-3 w-3 opacity-40" /> No activity yet
                  </div>
                )}

                {/* ─── Diagnosis check loading ─── */}
                {isChk && !diag && (
                  <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-accent/[0.04] border border-accent/10 px-3 py-2.5">
                    <Loader2 className="h-4 w-4 text-accent animate-spin shrink-0" />
                    <div>
                      <p className="text-[11px] font-medium text-accent">Checking session health...</p>
                      <p className="text-[9px] text-dark-500">Validating + SpamBot check (10-30s)</p>
                    </div>
                  </div>
                )}

                {/* ─── Diagnosis result ─── */}
                {diag && diagCfg && (() => {
                  const healthyButFailing = diag.action === "ok" && isFail;
                  const displayLabel = healthyButFailing ? "Session OK — But Failing in Stats" : diagCfg.label;
                  const displayReason = healthyButFailing
                    ? `SpamBot says account is healthy, but stats show ${fi ? Math.round(fi.failRate * 100) : 0}% failure. This may be a group/permission issue — contact support.`
                    : diag.reason;
                  const displayBorder = healthyButFailing ? "border-amber-500/15" : diagCfg.border;
                  const displayBg = healthyButFailing ? "bg-amber-500/[0.06]" : diagCfg.bg;
                  const displayText = healthyButFailing ? "text-amber-400" : diagCfg.text;
                  const displayIconBg = healthyButFailing ? "bg-amber-500/15" : diagCfg.iconBg;
                  const DisplayIcon = healthyButFailing ? AlertTriangle : diagCfg.Icon;
                  return (
                  <div className={`mt-3 rounded-xl border ${displayBorder} ${displayBg} p-3`}>
                    <div className="flex items-start gap-2.5">
                      <div className={`p-1.5 rounded-lg ${displayIconBg} shrink-0 mt-0.5`}>
                        <DisplayIcon className={`h-3.5 w-3.5 ${displayText}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] font-bold ${displayText}`}>{displayLabel}</p>
                        <p className="text-[10px] text-dark-400 mt-0.5">{displayReason}</p>
                        <div className="flex items-center gap-2 mt-2">
                          {(diag.action === "replace" || diag.action === "wait") && !isPendingRepl && (
                            <button type="button" onClick={() => openReplace([file])}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-accent text-white hover:bg-accent/90 transition-all cursor-pointer">
                              <ArrowRightLeft className="h-3 w-3" /> Replace
                            </button>
                          )}
                          {diag.action === "wait" && <span className="text-[9px] text-dark-500">or wait 24-48h</span>}
                          {diag.action === "ok" && !isFail && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                              <CheckCircle className="h-3 w-3" /> No action needed
                            </span>
                          )}
                          {diag.action === "ok" && isFail && (
                            <button type="button"
                              onClick={() => openSupportModal(file, name, diag, fi ? fi.failRate : 0)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/15 hover:bg-amber-500/20 transition-all cursor-pointer">
                              <HelpCircle className="h-3 w-3" /> Contact Support
                            </button>
                          )}
                          {diag.action === "unknown" && !isPendingRepl && (
                            <>
                              <button type="button" onClick={() => doCheckWhy(file)} disabled={isChk}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[9px] font-medium bg-dark-800 text-dark-300 border border-white/[0.06] hover:bg-dark-700 cursor-pointer">
                                <RefreshCw className="h-2.5 w-2.5" /> Retry
                              </button>
                              <button type="button" onClick={() => openReplace([file])}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[9px] font-semibold bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer">
                                <ArrowRightLeft className="h-2.5 w-2.5" /> Replace
                              </button>
                            </>
                          )}
                          {isPendingRepl && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-accent font-medium">
                              <Clock className="h-3 w-3" /> Replacement in progress
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  ); })()}

                {/* ─── Failing hint (no diagnosis yet) ─── */}
                {isFail && !diag && !isChk && fi && !isPendingRepl && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-amber-500/[0.04] border border-amber-500/10 px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <p className="text-[10px] text-dark-400">
                        <span className="text-amber-400 font-semibold">{Math.round(fi.failRate * 100)}%</span> failure rate — last cycle {fi.lcFailed}/{fi.attempted} failed
                      </p>
                    </div>
                    <button type="button" onClick={() => doCheckWhy(file)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[9px] font-semibold bg-dark-800 text-dark-300 border border-white/[0.06] hover:bg-dark-700 transition-all cursor-pointer shrink-0">
                      <Search className="h-3 w-3" /> Check
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sessions.length === 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-dark-850 flex flex-col items-center justify-center py-16">
          <Users className="h-10 w-10 text-dark-600 mb-2" />
          <p className="text-sm font-medium text-dark-400">No sessions assigned</p>
        </div>
      )}

      {/* ══════ REPLACE MODAL ══════ */}
      <Modal open={replModal} onClose={() => { setReplModal(false); setReplMsg(null); }} size="md">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-accent/10 shrink-0">
              <ArrowRightLeft className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h2 className="text-base font-bold text-dark-50">
                Replace {replTargets.length} Session{replTargets.length !== 1 ? "s" : ""}
              </h2>
              <p className="text-[11px] text-dark-400 mt-0.5">
                Dead sessions will be swapped with fresh accounts from the pool.
              </p>
            </div>
          </div>

          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
            {replTargets.map((sf) => {
              const fi2 = failMap[sf];
              const dg = diagResults[sf];
              const th = dg ? STATUS_CFG[dg.status] || STATUS_CFG.UNKNOWN : null;
              const si = sessions.find((sx) => sx.file === sf);
              const nm = si?.real_name?.replace(".session", "") || sf.replace(".session", "");
              return (
                <div key={sf} className="flex items-center justify-between gap-2 rounded-xl bg-dark-800/30 border border-white/[0.04] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="text-[12px] font-semibold text-dark-200 truncate block">{nm}</span>
                    <span className="text-[9px] text-dark-500">{dg ? dg.reason : fi2 ? `${Math.round(fi2.failRate * 100)}% failure rate` : "Session marked for replacement"}</span>
                  </div>
                  {dg && th && (
                    <span className={`text-[8px] font-semibold rounded-full ${th.bg} border ${th.border} px-1.5 py-0.5 ${th.text}`}>
                      {th.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Cost */}
          <div className="rounded-xl bg-dark-800/30 border border-white/[0.04] p-3">
            <p className="text-[11px] font-semibold text-dark-300 mb-2 flex items-center gap-1.5">
              <CircleDollarSign className="h-3.5 w-3.5 text-accent" /> Cost
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
                      <span className="text-emerald-400 flex items-center gap-1"><Gift className="h-3 w-3" /> {fu} free</span>
                      <span className="font-semibold text-emerald-400">$0.00</span>
                    </div>
                  )}
                  {pd > 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-dark-400 flex items-center gap-1"><CreditCard className="h-3 w-3" /> {pd} paid</span>
                      <span className="font-semibold text-dark-300">${tc.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="border-t border-white/[0.04] pt-2 flex items-center justify-between">
                    <span className="text-[12px] font-bold text-dark-200">Total</span>
                    <span className={`text-base font-bold ${tc === 0 ? "text-emerald-400" : "text-dark-50"}`}>
                      {tc === 0 ? "FREE" : `$${tc.toFixed(2)}`}
                    </span>
                  </div>
                  {pd > 0 && <p className="text-[9px] text-dark-500">Pay with crypto after confirming.</p>}
                  {freeRem > 0 && <p className="text-[9px] text-dark-500">{freeRem} free replacement{freeRem !== 1 ? "s" : ""} remaining on your plan.</p>}
                </div>
              );
            })()}
          </div>

          {replMsg && (
            <div className={`rounded-xl px-3 py-3 ${replMsg.ok ? "bg-emerald-500/[0.06] border border-emerald-500/15" : "bg-red-500/[0.06] border border-red-500/15"}`}>
              <div className="flex items-start gap-2">
                {replMsg.ok ? <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />}
                <p className={`text-[11px] font-medium leading-relaxed ${replMsg.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {replMsg.ok ? replMsg.text : replMsg.error}
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setReplModal(false); setReplMsg(null); }}
              className="px-4 py-2 rounded-lg text-[12px] text-dark-400 hover:text-dark-200 cursor-pointer">
              {replMsg?.ok ? "Done" : "Cancel"}
            </button>
            {!replMsg?.ok && (
              <button type="button" onClick={confirmReplace} disabled={replLoading}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-bold bg-accent text-white hover:bg-accent/90 disabled:opacity-50 shadow-lg shadow-accent/20 transition-all cursor-pointer">
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
              <div className="flex items-center gap-3 rounded-xl bg-dark-800/30 p-3 border border-white/[0.04]">
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
                  className="w-full rounded-lg border border-white/[0.06] bg-dark-800/50 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="First" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-dark-400 mb-1">Last Name</label>
                <input type="text" value={editLastName} onChange={(e) => setEditLastName(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.06] bg-dark-800/50 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="Last" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Bio</label>
              <textarea value={editBio} onChange={(e) => setEditBio(e.target.value)} rows={2} maxLength={70}
                className="w-full rounded-lg border border-white/[0.06] bg-dark-800/50 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none resize-none" placeholder="Bio (70 chars max)" />
              <div className="text-[9px] text-dark-600 text-right">{editBio.length}/70</div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Username</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-dark-500">@</span>
                <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                  className="flex-1 rounded-lg border border-white/[0.06] bg-dark-800/50 px-3 py-2 text-sm text-dark-100 focus:border-accent outline-none" placeholder="username" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-dark-400 mb-1">Photo</label>
              <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-dashed border-dark-600/30 bg-dark-800/20 hover:bg-dark-800/40 px-3 py-3 transition-colors">
                <Camera className="h-4 w-4 text-dark-400" />
                <span className="text-[11px] text-dark-400">{editPhoto ? editPhoto.name : "Choose photo..."}</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => setEditPhoto(e.target.files?.[0] || null)} />
              </label>
            </div>
            {editMsg?.ok && (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/15 px-3 py-2 text-[11px] text-emerald-400 font-medium">
                <CheckCircle className="h-3.5 w-3.5" /> Updated!
              </div>
            )}
            {editMsg?.error && accountInfo && (
              <div className="flex items-center gap-2 rounded-xl bg-red-500/[0.06] border border-red-500/15 px-3 py-2 text-[11px] text-red-400 font-medium">
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

      {/* ══════ CRYPTO PAYMENT MODAL ══════ */}
      <CryptoPaymentModal
        open={payModal}
        onClose={() => setPayModal(false)}
        entryId={payEntryId}
        sessionName={paySessionName}
        amountUsd={payAmountUsd}
        onPaymentConfirmed={() => {
          fetchRepl(); mutateBot();
          showToast("Payment confirmed! Replacement processing...", "ok");
        }}
      />

      {/* ══════ SUPPORT TICKET MODAL ══════ */}
      <Modal open={supportModal} onClose={() => { setSupportModal(false); setSupportResult(null); }} size="md">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-2xl bg-amber-500/10 shrink-0">
              <HelpCircle className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-dark-50">Contact Support</h3>
              <p className="text-[11px] text-dark-500 mt-0.5">Report an issue with your session</p>
            </div>
          </div>

          {/* Session Info — auto-filled */}
          <div className="rounded-xl bg-dark-800/30 border border-white/[0.04] p-3 space-y-2">
            <p className="text-[10px] font-semibold text-dark-400 uppercase tracking-wider">Session Details</p>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="text-dark-500">Session:</span>
                <span className="ml-1.5 font-semibold text-dark-200">{supportName}</span>
              </div>
              <div>
                <span className="text-dark-500">File:</span>
                <span className="ml-1.5 font-mono text-dark-300 text-[10px]">{supportFile.replace(".session", "").slice(-10)}</span>
              </div>
              {supportDiag && (
                <div>
                  <span className="text-dark-500">Diagnosis:</span>
                  <span className={`ml-1.5 font-semibold ${
                    supportDiag.severity === "ok" ? "text-emerald-400" : supportDiag.severity === "critical" ? "text-red-400" : "text-amber-400"
                  }`}>{supportDiag.status}</span>
                </div>
              )}
              {supportFailRate > 0 && (
                <div>
                  <span className="text-dark-500">Fail Rate:</span>
                  <span className="ml-1.5 font-semibold text-red-400">{Math.round(supportFailRate * 100)}%</span>
                </div>
              )}
            </div>
            {supportDiag?.action === "ok" && supportFailRate > 0 && (
              <div className="mt-1.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/10 px-2.5 py-2">
                <p className="text-[10px] text-amber-400">
                  SpamBot says this session is healthy, but stats show high failure. This may be caused by group permissions, invalid groups, or other configuration issues.
                </p>
              </div>
            )}
          </div>

          {/* Message input */}
          {!supportResult?.ok && (
            <div>
              <label className="text-[11px] font-semibold text-dark-300 block mb-1.5">Describe the issue</label>
              <textarea
                value={supportMsg}
                onChange={(e) => setSupportMsg(e.target.value)}
                placeholder="What's going wrong? Any details that might help..."
                maxLength={1000}
                rows={4}
                className="w-full rounded-xl bg-dark-800/50 border border-white/[0.06] px-3 py-2.5 text-[12px] text-dark-100 placeholder:text-dark-600 resize-none focus:outline-none focus:border-accent/30 transition-colors"
              />
              <p className="text-[9px] text-dark-600 mt-1 text-right">{supportMsg.length}/1000</p>
            </div>
          )}

          {/* Result */}
          {supportResult && (
            <div className={`rounded-xl px-3 py-3 ${supportResult.ok ? "bg-emerald-500/[0.06] border border-emerald-500/15" : "bg-red-500/[0.06] border border-red-500/15"}`}>
              <div className="flex items-start gap-2">
                {supportResult.ok ? <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />}
                <p className={`text-[11px] font-medium leading-relaxed ${supportResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {supportResult.text}
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setSupportModal(false); setSupportResult(null); }}
              className="px-4 py-2 rounded-lg text-[12px] text-dark-400 hover:text-dark-200 cursor-pointer">
              {supportResult?.ok ? "Done" : "Cancel"}
            </button>
            {!supportResult?.ok && (
              <button type="button" onClick={submitSupportTicket} disabled={supportLoading || !supportMsg.trim()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-bold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 shadow-lg shadow-amber-500/20 transition-all cursor-pointer">
                {supportLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {supportLoading ? "Sending..." : "Send Report"}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
