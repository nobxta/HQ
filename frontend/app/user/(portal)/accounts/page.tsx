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
  Clock, ChevronRight, ChevronLeft, ChevronDown, Zap, Send, Eye, Settings, Copy,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import CryptoPaymentModal from "@/components/portal/CryptoPaymentModal";

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   TYPES
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
  details?: string | null;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   STATUS THEME
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
    desc: "Connection is dead â€” the account was revoked or banned. Replace it.",
  },
  UNAUTHORIZED: {
    bg: "bg-rose-500/[0.06]", border: "border-rose-500/15", text: "text-rose-400",
    iconBg: "bg-rose-500/15", Icon: WifiOff, label: "Logged Out",
    desc: "Session is unauthorized â€” it can't log in (signed out elsewhere). Replace it.",
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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   HELPERS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

// Map a canonical cache health status â†’ the recommended action.
const _ACTION_FOR: Record<string, "replace" | "wait" | "ok" | "unknown"> = {
  FROZEN: "replace", DEAD: "replace", HARD_LIMITED: "replace", UNAUTHORIZED: "replace",
  TEMP_LIMITED: "wait", ACTIVE: "ok",
};

// Turn the persisted per-session health (session_meta cache, served by the bot endpoint) into
// the same DiagResult shape a live "Check health" produces â€” so the card renders the saved
// status on load and it survives refresh. A live in-session check always takes precedence.
function cacheDiag(health?: string, details?: string | null): DiagResult | null {
  if (!health || health === "UNKNOWN" || health === "BUSY") return null;
  const cfg = STATUS_CFG[health] || STATUS_CFG.UNKNOWN;
  const action = _ACTION_FOR[health] || "unknown";
  return {
    status: health,
    reason: health === "TEMP_LIMITED" && details
      ? `Temporarily limited by Telegram until ${details}.`
      : cfg.desc || "Saved from last check",
    details,
    action,
    source: "spambot",
    severity: action === "ok" ? "ok" : action === "wait" ? "warning" : "critical",
  };
}

const AVATAR_COLORS = [
  "from-violet-500 to-purple-700", "from-emerald-400 to-teal-700",
  "from-amber-400 to-orange-700", "from-sky-400 to-blue-700",
  "from-pink-400 to-rose-700", "from-cyan-400 to-cyan-700",
];

// Status â†’ tier (drives the summary counts, filter, and card accent).
const CRITICAL_STATUSES = new Set(["FROZEN", "DEAD", "HARD_LIMITED", "UNAUTHORIZED", "STATS_ONLY"]);
const WARNING_STATUSES = new Set(["TEMP_LIMITED", "STATS_FAILING"]);

// Compact numbered pagination window with ellipses (e.g. 1 â€¦ 4 5 6 â€¦ 12).
function pageWindow(current: number, total: number): (number | "â€¦")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "â€¦")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push("â€¦");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push("â€¦");
  out.push(total);
  return out;
}

// Partially mask a phone for privacy: "919876543124" â†’ "+91 â€¢â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢3124".
function maskPhone(p?: string | null): string | null {
  if (!p) return null;
  const raw = String(p).replace(/[^\d]/g, "");
  if (!raw) return null;
  if (raw.length <= 4) return "+" + raw;
  const cc = raw.length > 10 ? raw.slice(0, raw.length - 10) : raw.slice(0, 2);
  return `+${cc} â€¢â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢${raw.slice(-4)}`;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   TOAST
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   MAIN PAGE
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "healthy" | "attention" | "critical">("all");
  const [openMenu, setOpenMenu] = useState<string | null>(null); // per-card "Manage" dropdown
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const copyPhone = useCallback((phone?: string | null) => {
    if (!phone) return;
    try { navigator.clipboard?.writeText(String(phone)); setToast({ msg: "Phone copied", type: "ok" }); } catch { /* ignore */ }
  }, []);
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
  const [replacementJobs, setReplacementJobs] = useState<any[]>([]);

  // Crypto payment
  const [payModal, setPayModal] = useState(false);
  const [payEntryId, setPayEntryId] = useState("");
  const [paySessionName, setPaySessionName] = useState("");
  const [payAmountUsd, setPayAmountUsd] = useState(0);
  const [payReplacementCount, setPayReplacementCount] = useState(1);

  // Support ticket modal
  const [supportModal, setSupportModal] = useState(false);
  const [supportFile, setSupportFile] = useState("");
  const [supportName, setSupportName] = useState("");
  const [supportDiag, setSupportDiag] = useState<DiagResult | null>(null);
  const [supportFailRate, setSupportFailRate] = useState(0);
  const [supportMsg, setSupportMsg] = useState("");
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportResult, setSupportResult] = useState<{ ok?: boolean; text?: string } | null>(null);

  // Health is now sourced from the unified session_meta cache (each session carries `health`
  // from the bot endpoint). The card resolves it via cacheDiag() at render time, so there is
  // no fragile stats-restore effect and a checked status persists across refresh automatically.

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

  /* â”€â”€â”€ Fetch replacement status â”€â”€â”€ */
  const fetchRepl = useCallback(async () => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;
    try {
      const [legacy, jobs] = await Promise.all([
        portalApi.get(`/api/portal/bot/${s.bot_name}/replacements?telegram_id=${s.telegram_id}`),
        portalApi.get(`/api/portal/bot/${s.bot_name}/replacement-jobs?telegram_id=${s.telegram_id}`),
      ]);
      setFreeRem(legacy.data?.free_remaining ?? 0);
      setPricePer(legacy.data?.price_per_session ?? 2.0);
      setPendingReplacements(legacy.data?.pending ?? []);
      setReplacementJobs(jobs.data?.jobs ?? []);
    } catch {
      // Keep the last known replacement state during a temporary API outage.
    }
  }, []);

  useEffect(() => {
    fetchRepl();
    const iv = setInterval(fetchRepl, pendingReplacements.length > 0 ? 3000 : 15000);
    return () => clearInterval(iv);
  }, [fetchRepl, pendingReplacements.length]);

  // Reset to the first page whenever the filters change.
  useEffect(() => { setPage(1); }, [search, statusFilter, filter]);

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DIAGNOSE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  const doCheckWhy = useCallback(async (file: string) => {
    const s = getPortalSession();
    console.log("[Accounts] Check Why â†’", file, "bot:", s?.bot_name);
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
        const diag: DiagResult = { status: d.spam_status || "UNKNOWN", reason: d.reason || "Check complete", action, source: "spambot", validation: d.validation || "ok", severity: d.severity || "unknown", details: d.details || null };
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
      if (status === 404) { showToast("Diagnose endpoint not found â€” restart backend", "err"); setDiagLoading((p) => ({ ...p, [file]: false })); return; }
    }
    const fi = getFailInfo(stats?.session_stats, file);
    if (fi) {
      setDiagResults((p) => ({ ...p, [file]: mkStatsDiag(fi.failRate) }));
      showToast(`${Math.round(fi.failRate * 100)}% failure â€” SpamBot unavailable`, "warn");
    } else {
      setDiagResults((p) => ({ ...p, [file]: { status: "UNKNOWN", reason: "Could not reach SpamBot. Try again.", action: "unknown", source: "stats" } }));
      showToast("Could not check session â€” try again", "err");
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
          nd[d.session_file] = { status: d.spam_status || "UNKNOWN", reason: d.reason || "Check complete", action, source: "spambot", validation: d.validation || "ok", severity: d.severity || "unknown", details: d.details || null };
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
    showToast(`SpamBot unavailable â€” showing stats for ${files.length} sessions`, "warn");
  }, [stats?.session_stats, showToast]);

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REPLACE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
  const openReplace = useCallback((targets: string[]) => {
    console.log("[Accounts] Replace modal â†’", targets);
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
        msg = `${q} queued â€” no fresh sessions in pool yet. Admin notified.`;
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
            setPayReplacementCount(needsPayment || 1);
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     EDIT
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
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

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RENDER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
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

  const sessions: Array<{
    file: string; real_name: string; user_id?: number;
    health?: string; spam_status?: string | null; spam_details?: string | null; last_checked?: number | null;
    full_name?: string | null; username?: string | null; phone?: string | null;
  }> = bot.sessions || [];
  const sessionStats = stats?.session_stats as Record<string, any> | undefined;

  const _BAD_DIAG_STATUSES = new Set(["FROZEN", "DEAD", "HARD_LIMITED", "UNAUTHORIZED", "STATS_FAILING", "STATS_ONLY"]);

  const failMap: Record<string, ReturnType<typeof getFailInfo>> = {};
  const failFiles: string[] = [];
  const diagBadFiles = new Set<string>(); // diagnosed-bad but not stats-failing
  sessions.forEach((s) => {
    const fi = getFailInfo(sessionStats, s.file);
    if (fi) { failMap[s.file] = fi; failFiles.push(s.file); }
    // Also count sessions the cache (or a live check) flags as bad, even with zero stats.
    else {
      const diag = diagResults[s.file] || cacheDiag(s.health, s.spam_details);
      if (diag && _BAD_DIAG_STATUSES.has(diag.status)) {
        failFiles.push(s.file);
        diagBadFiles.add(s.file);
      }
    }
  });

  const anyLoading = Object.values(diagLoading).some(Boolean);
  const pendingByFile = new Map<string, any>(
    pendingReplacements.map((p: any) => [p.session_file, p])
  );
  const pendingFiles = new Set(pendingByFile.keys());
  const unresolvedFailFiles = failFiles.filter(f => !pendingFiles.has(f));

  // Per-session tier (critical / attention / healthy / unknown) from the resolved health.
  const tierOf = (sess: typeof sessions[number]): "critical" | "attention" | "healthy" | "unknown" => {
    const st = (diagResults[sess.file] || cacheDiag(sess.health, sess.spam_details))?.status;
    if (st && CRITICAL_STATUSES.has(st)) return "critical";
    if ((st && WARNING_STATUSES.has(st)) || failMap[sess.file]) return "attention";
    if (st === "ACTIVE") return "healthy";
    const s = sessionStats?.[sess.file];
    const has = s && (Number(s.lifetime_sent || 0) + Number(s.lifetime_failed || 0)) > 0;
    return has ? "healthy" : "unknown";
  };
  const tierByFile: Record<string, "critical" | "attention" | "healthy" | "unknown"> = {};
  sessions.forEach((s) => { tierByFile[s.file] = tierOf(s); });

  const healthyCount = sessions.filter(s => tierByFile[s.file] === "healthy").length;
  const attentionCount = sessions.filter(s => tierByFile[s.file] === "attention").length;
  const criticalCount = sessions.filter(s => tierByFile[s.file] === "critical").length;

  // Search + status filter (client-side over existing data â€” no new fetch).
  const q = search.trim().toLowerCase();
  const visibleSessions = sessions.filter((s) => {
    if (statusFilter !== "all" && tierByFile[s.file] !== statusFilter) return false;
    if (!q) return true;
    const hay = [s.full_name, s.real_name, s.username, s.phone, String(s.user_id || "")].join(" ").toLowerCase();
    return hay.includes(q);
  });

  // Aggregate totals for the stats strip (from the bot's own stats â€” no extra fetch).
  const planLabel: string | null = (bot?.plan?.name || bot?.plan_name || (typeof bot?.plan === "string" ? bot.plan : null)) || null;
  const activeReplacementJobs = replacementJobs.filter(
    (job: any) => !["completed", "cancelled", "failed"].includes(job.status)
  );

  // Client-side pagination over the filtered list.
  const totalPages = Math.max(1, Math.ceil(visibleSessions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageSessions = visibleSessions.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="space-y-5 animate-fade-in" suppressHydrationWarning>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* Compact health overview: the counts also act as the status filter. */}
      <section className="rounded-2xl border border-white/[0.06] bg-[#15151f] p-3 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-bold text-white">Telegram accounts</h2>
            <p className="mt-0.5 text-[10px] text-dark-500">
              {sessions.length} connected Â· {freeRem} free replacement{freeRem === 1 ? "" : "s"}
            </p>
          </div>
          <button type="button" onClick={() => { mutateBot(); fetchRepl(); }} aria-label="Refresh accounts"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.025] text-dark-300 hover:bg-white/[0.06] hover:text-white active:scale-95 transition-all">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label="Filter by account health">
          {[
            { key: "all", label: "All", value: sessions.length, dot: "bg-accent", selected: "border-accent/40 bg-accent/10 text-white" },
            { key: "healthy", label: "Healthy", value: healthyCount, dot: "bg-emerald-400", selected: "border-emerald-500/35 bg-emerald-500/[0.08] text-emerald-300" },
            { key: "attention", label: "Review", value: attentionCount, dot: "bg-amber-400", selected: "border-amber-500/35 bg-amber-500/[0.08] text-amber-300" },
            { key: "critical", label: "Replace", value: criticalCount, dot: "bg-red-400", selected: "border-red-500/35 bg-red-500/[0.08] text-red-300" },
          ].map((item) => {
            const selected = statusFilter === item.key;
            return (
              <button key={item.key} type="button" onClick={() => setStatusFilter(item.key as typeof statusFilter)}
                aria-pressed={selected}
                className={`min-w-0 rounded-xl border px-2 py-2 text-left transition-colors ${
                  selected ? item.selected : "border-white/[0.05] bg-white/[0.018] text-dark-400 hover:bg-white/[0.04]"
                }`}>
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
                  <span className="text-[15px] font-bold tabular-nums">{item.value}</span>
                </span>
                <span className="mt-0.5 block truncate text-[9px] font-medium">{item.label}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dark-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" placeholder="Search accounts"
              className="h-10 w-full rounded-xl border border-white/[0.06] bg-[#101018] pl-9 pr-3 text-[12px] text-dark-200 outline-none placeholder:text-dark-600 focus:border-accent/40" />
          </div>
          <div className="relative w-[7.5rem] shrink-0">
            <select value={filter} onChange={(e) => setFilter(e.target.value as TimeFilter)} aria-label="Statistics period"
              className="h-10 w-full appearance-none rounded-xl border border-white/[0.06] bg-[#101018] pl-3 pr-7 text-[11px] font-medium text-dark-300 outline-none focus:border-accent/40">
              <option value="24h">Last 24h</option>
              <option value="overall">All time</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dark-500" />
          </div>
        </div>
      </section>

      {/* Only unfinished work belongs on the operational screen; completed history is
          intentionally omitted so it does not compete with current account health. */}
      {activeReplacementJobs.length > 0 && (
        <div className="space-y-2">
          {activeReplacementJobs.map((job: any) => {
            const awaitingPayment = job.status === "awaiting_payment";
            const needsAdmin = job.status === "needs_admin";
            const waitingInventory = Boolean(job.awaiting_inventory);
            const paidItems = (job.items || []).filter((item: any) => item.status === "pending_payment");
            const paymentTotal = paidItems.reduce((sum: number, item: any) => sum + Number(item.price_usd || 0), 0);
            const firstPaid = paidItems[0];
            const hasActiveInvoice = Boolean(firstPaid?.payment_id && firstPaid?.invoice_data?.pay_address);
            const names = (job.items || [])
              .map((item: any) => (item.real_name || item.session_file || "").replace(".session", ""))
              .filter(Boolean);
            const title = awaitingPayment
              ? "Payment required"
              : needsAdmin
                ? "Setup needs help"
                : waitingInventory
                  ? "Waiting for an available account"
                  : `Replacing ${job.total} account${job.total === 1 ? "" : "s"}`;
            const description = awaitingPayment
              ? hasActiveInvoice
                ? `${job.total} account${job.total === 1 ? "" : "s"} Â· invoice active Â· replacement starts after confirmation`
                : `${job.total} account${job.total === 1 ? "" : "s"} selected Â· replacement has not started`
              : `${job.completed}/${job.total} complete${waitingInventory ? ` Â· ${job.awaiting_inventory} waiting` : ""}${needsAdmin ? ` Â· ${job.needs_attention} needs review` : ""}`;
            const tone = awaitingPayment
              ? "border-amber-500/25 bg-amber-500/[0.045]"
              : needsAdmin
                ? "border-red-500/20 bg-red-500/[0.04]"
                : waitingInventory
                  ? "border-sky-500/20 bg-sky-500/[0.035]"
                  : "border-accent/20 bg-accent/[0.03]";
            const Icon = awaitingPayment ? CircleDollarSign : needsAdmin ? AlertTriangle : waitingInventory ? Clock : Loader2;
            const iconTone = awaitingPayment ? "text-amber-400" : needsAdmin ? "text-red-400" : waitingInventory ? "text-sky-400" : "text-accent";

            const openGroupedPayment = () => {
              if (!firstPaid) return;
              setPayEntryId(firstPaid.id);
              setPaySessionName(names.join(", "));
              setPayAmountUsd(Number(firstPaid.price_usd || pricePer));
              setPayReplacementCount(Math.max(1, paidItems.length));
              setPayModal(true);
            };

            return (
              <section key={job.job_id} className={`rounded-2xl border p-3 sm:p-4 ${tone}`}>
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/15 ${iconTone}`}>
                    <Icon className={`h-4 w-4 ${!awaitingPayment && !needsAdmin && !waitingInventory ? "animate-spin" : ""}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                      <div className="min-w-0">
                        <h3 className="text-[13px] font-bold text-dark-100">{title}</h3>
                        <p className="mt-0.5 text-[10px] text-dark-500">{description}</p>
                      </div>
                      {awaitingPayment && firstPaid ? (
                        <button type="button" onClick={openGroupedPayment}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-400 px-3 text-[11px] font-bold text-[#17120a] shadow-sm shadow-amber-950/30 transition-colors hover:bg-amber-300">
                          <CircleDollarSign className="h-3.5 w-3.5" />
                          {hasActiveInvoice ? "View payment" : "Choose payment"} Â· ${paymentTotal.toFixed(2)}
                        </button>
                      ) : (
                        <span className={`text-[11px] font-bold tabular-nums ${iconTone}`}>{Math.min(100, Number(job.progress || 0))}%</span>
                      )}
                    </div>

                    {awaitingPayment ? (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {names.map((name: string) => (
                          <span key={name} className="rounded-md border border-amber-500/15 bg-black/10 px-2 py-1 text-[9px] font-medium text-amber-100/75">{name}</span>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="mt-2.5 h-1 rounded-full bg-black/20 overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${needsAdmin ? "bg-red-400" : waitingInventory ? "bg-sky-400" : "bg-accent"}`}
                            style={{ width: `${Math.max(2, Math.min(100, Number(job.progress || 0)))}%` }} />
                        </div>
                        <details className="group mt-2">
                          <summary className="list-none cursor-pointer text-[10px] font-medium text-dark-400 hover:text-dark-200">
                            <span className="inline-flex items-center gap-1">View account progress <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" /></span>
                          </summary>
                          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                            {(job.items || []).map((item: any) => (
                              <div key={item.id} className="rounded-lg border border-white/[0.05] bg-black/10 px-2.5 py-2">
                                <p className="truncate text-[10px] font-semibold text-dark-200">{(item.real_name || item.session_file || "").replace(".session", "")}</p>
                                <p className="mt-0.5 truncate text-[9px] text-dark-500">{item.stage_message || item.status}</p>
                              </div>
                            ))}
                          </div>
                        </details>
                      </>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* â•â•â•â•â•â• ACTION BAR â€” compact alert + actions â•â•â•â•â•â• */}
      {unresolvedFailFiles.length > 0 && (
        <div className="rounded-2xl border border-amber-500/15 bg-amber-500/[0.035] overflow-hidden">
          {/* Failing sessions â€” compact bar */}
          {unresolvedFailFiles.length > 0 && (
            <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-1.5 rounded-lg bg-amber-500/10 shrink-0">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                </div>
                <p className="text-[12px] font-semibold text-dark-200">
                  <span className="text-amber-400">{unresolvedFailFiles.length}</span> session{unresolvedFailFiles.length !== 1 ? "s" : ""} need{unresolvedFailFiles.length === 1 ? "s" : ""} attention
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center shrink-0">
                <button type="button" onClick={() => doCheckAll(unresolvedFailFiles)} disabled={anyLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-dark-800 hover:bg-dark-700 text-dark-300 border border-white/[0.06] disabled:opacity-50 transition-all cursor-pointer">
                  {anyLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                  Check health
                </button>
                <button type="button" onClick={() => openReplace(unresolvedFailFiles)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-accent text-white hover:bg-accent/90 transition-all cursor-pointer">
                  <ArrowRightLeft className="h-3 w-3" /> Replace selected
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* â•â•â•â•â•â• SESSION CARDS â•â•â•â•â•â• */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {pageSessions.map((sess, idx) => {
          const file = sess.file;
          const s = sessionStats?.[file];
          const fi = failMap[file];
          const isChk = !!diagLoading[file];
          const liveDiag = diagResults[file];                 // in-session "Check health" result
          const diag = liveDiag || cacheDiag(sess.health, sess.spam_details);    // else the persisted cache status
          const diagCfg = diag ? STATUS_CFG[diag.status] || STATUS_CFG.UNKNOWN : null;
          const tier = tierByFile[file];
          const pendingEntry = pendingByFile.get(file);
          const isPendingRepl = Boolean(pendingEntry);
          const isAwaitingPayment = pendingEntry?.status === "pending_payment";
          const replaceAllowed = (tier === "critical" || tier === "attention") && !isPendingRepl;
          const menuOpen = openMenu === file;

          let sent = 0, failed = 0;
          if (filter === "24h") { sent = Number(s?.last24h_sent || 0); failed = Number(s?.last24h_failed || 0); }
          else { sent = Number(s?.lifetime_sent || 0); failed = Number(s?.lifetime_failed || 0); }
          const total = sent + failed;
          const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
          const hasData = total > 0;
          const name = (sess.full_name || sess.real_name)?.replace(".session", "") || file.replace(".session", "");
          const masked = maskPhone(sess.phone);
          const checkedAgo = sess.last_checked
            ? (() => { const m = Math.floor((Date.now() / 1000 - sess.last_checked!) / 60);
                       return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; })()
            : null;

          const dotTone = isAwaitingPayment ? "bg-amber-400" : isPendingRepl ? "bg-accent" : tier === "critical" ? "bg-red-500" : tier === "attention" ? "bg-amber-400" : tier === "healthy" ? "bg-emerald-400" : "bg-dark-600";
          const pctTone = pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400";

          let badgeLabel: string, badgeCls: string, BadgeIcon: any, badgeSpin = false;
          if (isAwaitingPayment) { badgeLabel = "Payment required"; badgeCls = "bg-amber-500/10 border-amber-500/20 text-amber-300"; BadgeIcon = CircleDollarSign; }
          else if (isPendingRepl) { badgeLabel = "Replacing"; badgeCls = "bg-accent/10 border-accent/20 text-accent"; BadgeIcon = Clock; }
          else if (isChk && !liveDiag) { badgeLabel = "Checking"; badgeCls = "bg-sky-500/10 border-sky-500/20 text-sky-400"; BadgeIcon = Loader2; badgeSpin = true; }
          else if (diagCfg) { badgeLabel = diagCfg.label; badgeCls = `${diagCfg.bg} ${diagCfg.border} ${diagCfg.text}`; BadgeIcon = diagCfg.Icon; }
          else if (tier === "attention") { badgeLabel = "Needs attention"; badgeCls = "bg-amber-500/10 border-amber-500/20 text-amber-400"; BadgeIcon = AlertTriangle; }
          else if (tier === "healthy") { badgeLabel = "Healthy"; badgeCls = "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"; BadgeIcon = CheckCircle; }
          else { badgeLabel = "Unchecked"; badgeCls = "bg-dark-700/30 border-white/[0.06] text-dark-400"; BadgeIcon = HelpCircle; }

          return (
            <div key={file} className="flex h-full flex-col rounded-2xl border border-white/[0.06] bg-[#171723] p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-colors hover:border-white/[0.12] sm:p-4">
              {/* Row 1 â€” avatar + identity + status */}
              <div className="flex items-start gap-3">
                <div className="relative shrink-0">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-[14px] font-bold text-white bg-gradient-to-br ${AVATAR_COLORS[idx % AVATAR_COLORS.length]}`}>
                    {name.charAt(0).toUpperCase()}
                  </div>
                  <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-[#171723] ${dotTone}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <span className="text-[14px] font-bold text-white truncate max-w-[9rem]">{name}</span>
                      {sess.username ? <span className="text-[12px] text-sky-400/80 truncate">@{sess.username}</span> : null}
                      {planLabel && <span className="text-[9px] font-semibold rounded-md px-1.5 py-0.5 bg-white/[0.06] border border-white/[0.06] text-dark-300 whitespace-nowrap">{planLabel}</span>}
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-2 py-0.5 whitespace-nowrap shrink-0 ${badgeCls}`}>
                      <BadgeIcon className={`h-2.5 w-2.5 ${badgeSpin ? "animate-spin" : ""}`} /> {badgeLabel}
                    </span>
                  </div>
                  {masked && (
                    <button type="button" onClick={() => copyPhone(sess.phone)} title="Copy phone"
                      className="group mt-1 inline-flex items-center gap-1.5 text-[12.5px] font-mono text-dark-300 hover:text-dark-100 transition-colors">
                      {masked}<Copy className="h-3 w-3 text-dark-600 group-hover:text-dark-400" />
                    </button>
                  )}
                  <p className="text-[10px] text-dark-500 mt-0.5 flex flex-wrap items-center gap-x-2">
                    {sess.user_id ? <span>ID: {sess.user_id}</span> : null}
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />{checkedAgo ? `Checked ${checkedAgo}` : "Not checked yet"}
                    </span>
                  </p>
                </div>
              </div>

              {/* Row 2 â€” metrics */}
              <div className="mt-3 grid grid-cols-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                <div className="flex items-center gap-2 px-3 py-2.5 min-w-0">
                  <Send className="h-4 w-4 text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-white tabular-nums leading-none truncate">{sent.toLocaleString()}</p>
                    <p className="text-[9px] text-dark-500 mt-1">Sent</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-2.5 border-x border-white/[0.05] min-w-0">
                  <XCircle className={`h-4 w-4 shrink-0 ${failed > 0 ? "text-red-400" : "text-dark-600"}`} />
                  <div className="min-w-0">
                    <p className={`text-[13px] font-bold tabular-nums leading-none truncate ${failed > 0 ? "text-white" : "text-dark-400"}`}>{failed.toLocaleString()}</p>
                    <p className="text-[9px] text-dark-500 mt-1">Failed</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-2.5 min-w-0">
                  <Activity className={`h-4 w-4 shrink-0 ${pctTone}`} />
                  <div className="min-w-0">
                    <p className={`text-[13px] font-bold tabular-nums leading-none ${pctTone}`}>{hasData ? `${pct}%` : "â€”"}</p>
                    <p className="text-[9px] text-dark-500 mt-1">Success</p>
                  </div>
                </div>
              </div>

              {/* Reason line for non-healthy states */}
              {diag && diagCfg && tier !== "healthy" && !isPendingRepl && (
                <p className="mt-2 text-[10.5px] text-dark-400 leading-snug line-clamp-2">{diag.reason}</p>
              )}
              {isAwaitingPayment && (
                <p className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-300">
                  <CircleDollarSign className="h-3 w-3" /> Not started â€” complete payment first
                </p>
              )}
              {isPendingRepl && !isAwaitingPayment && (
                <p className="mt-2 inline-flex items-center gap-1 text-[10.5px] text-accent font-medium"><Clock className="h-3 w-3" /> Replacement in progress</p>
              )}

              {/* Row 4 â€” actions (pinned to the bottom of the card) */}
              <div className="mt-auto flex items-center gap-2 pt-3">
                <button type="button" onClick={() => openEdit(file)}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] text-[11px] font-semibold text-dark-200 hover:bg-white/[0.05] active:scale-[0.98] transition-all">
                  <Eye className="h-3.5 w-3.5 text-accent" /> Details
                </button>
                <div className="relative">
                  <button type="button" onClick={() => setOpenMenu(menuOpen ? null : file)} aria-haspopup="menu" aria-expanded={menuOpen}
                    aria-label={`Manage ${name}`}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-dark-300 hover:bg-white/[0.05] hover:text-white active:scale-[0.98] transition-all">
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                  {menuOpen && (
                    <div className="absolute right-0 bottom-full mb-2 z-40 w-56 rounded-xl border border-white/[0.08] bg-[#1c1c2b] p-1 shadow-xl shadow-black/50">
                      <button type="button" onClick={() => { setOpenMenu(null); doCheckWhy(file); }} disabled={isChk}
                        className="w-full flex items-center gap-2.5 px-3 h-11 rounded-lg text-[12.5px] text-dark-100 hover:bg-white/[0.06] disabled:opacity-50 transition-colors">
                        <Search className="h-4 w-4 text-dark-400" /> Run health check
                      </button>
                      <button type="button" onClick={() => { setOpenMenu(null); openEdit(file); }}
                        className="w-full flex items-center gap-2.5 px-3 h-11 rounded-lg text-[12.5px] text-dark-100 hover:bg-white/[0.06] transition-colors">
                        <Pencil className="h-4 w-4 text-dark-400" /> Edit session name
                      </button>
                      {replaceAllowed && (
                        <button type="button" onClick={() => { setOpenMenu(null); openReplace([file]); }}
                          className="w-full flex items-center gap-2.5 px-3 h-11 rounded-lg text-[12.5px] text-accent hover:bg-accent/10 transition-colors">
                          <ArrowRightLeft className="h-4 w-4" /> Replace session
                        </button>
                      )}
                      <button type="button" onClick={() => { setOpenMenu(null); openSupportModal(file, name, diag, fi ? fi.failRate : 0); }}
                        className="w-full flex items-center gap-2.5 px-3 h-11 rounded-lg text-[12.5px] text-dark-100 hover:bg-white/[0.06] transition-colors">
                        <HelpCircle className="h-4 w-4 text-dark-400" /> Contact support
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* â•â•â•â•â•â• PAGINATION â•â•â•â•â•â• */}
      {visibleSessions.length > PAGE_SIZE && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-dark-500 order-2 sm:order-1">
            Showing {pageStart + 1}â€“{Math.min(pageStart + PAGE_SIZE, visibleSessions.length)} of {visibleSessions.length} accounts
          </p>
          <div className="flex items-center gap-1 order-1 sm:order-2">
            <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-[#171723] text-dark-300 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pageWindow(safePage, totalPages).map((p, i) => (
              p === "â€¦"
                ? <span key={`e${i}`} className="px-1 text-[12px] text-dark-600">â€¦</span>
                : <button key={p} type="button" onClick={() => setPage(p)}
                    className={`h-9 min-w-[2.25rem] px-2 rounded-lg text-[12px] font-semibold transition-colors ${
                      p === safePage ? "bg-accent text-white shadow-[0_2px_10px_rgba(108,92,231,0.35)]" : "border border-white/[0.08] bg-[#171723] text-dark-300 hover:bg-white/[0.05]"
                    }`}>{p}</button>
            ))}
            <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-[#171723] text-dark-300 hover:bg-white/[0.05] disabled:opacity-40 disabled:pointer-events-none transition-colors">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* click-away layer to dismiss any open Manage menu */}
      {openMenu && <div className="fixed inset-0 z-30" onClick={() => setOpenMenu(null)} />}

      {sessions.length === 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#171723] flex flex-col items-center justify-center py-16">
          <Users className="h-10 w-10 text-dark-600 mb-2" />
          <p className="text-sm font-medium text-dark-400">No sessions assigned</p>
        </div>
      )}
      {sessions.length > 0 && visibleSessions.length === 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#171723] flex flex-col items-center justify-center py-12">
          <Search className="h-8 w-8 text-dark-600 mb-2" />
          <p className="text-[13px] font-medium text-dark-400">No accounts match your filters</p>
          <button type="button" onClick={() => { setSearch(""); setStatusFilter("all"); }} className="mt-2 text-[11px] font-semibold text-accent">Clear filters</button>
        </div>
      )}

      {/* â•â•â•â•â•â• REPLACE MODAL â•â•â•â•â•â• */}
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

      {/* â•â•â•â•â•â• EDIT MODAL â•â•â•â•â•â• */}
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
                    {accountInfo.username ? `@${accountInfo.username}` : "No username"} Â· ID: {accountInfo.user_id}
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

      {/* â•â•â•â•â•â• CRYPTO PAYMENT MODAL â•â•â•â•â•â• */}
      <CryptoPaymentModal
        open={payModal}
        onClose={() => setPayModal(false)}
        entryId={payEntryId}
        sessionName={paySessionName}
        amountUsd={payAmountUsd}
        replacementCount={payReplacementCount}
        onPaymentConfirmed={() => {
          fetchRepl(); mutateBot();
          showToast("Payment confirmed! Replacement processing...", "ok");
        }}
      />

      {/* â•â•â•â•â•â• SUPPORT TICKET MODAL â•â•â•â•â•â• */}
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

          {/* Session Info â€” auto-filled */}
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

