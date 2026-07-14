"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, ExternalLink, Bot, ShieldCheck, Shield, Power, Repeat, Unlink, LinkIcon, Loader2, Activity,
} from "lucide-react";
import Link from "next/link";
import type { SessionOverviewItem } from "@/lib/types";
import type { AuditRow } from "@/lib/sessions";
import { timeAgo } from "@/lib/utils";
import { HealthBadge, LocationBadge, StatusPill, Avatar, Copyable, accountName, isAssigned } from "./shared";
import type { SessionActions } from "./SessionActionsMenu";
import ActivityTimeline from "./ActivityTimeline";

type Tab = "overview" | "health" | "assignment" | "runtime" | "activity";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "health", label: "Health" },
  { key: "assignment", label: "Assignment" },
  { key: "runtime", label: "Runtime" },
  { key: "activity", label: "Activity" },
];

function Field({ label, value, mono, copy }: { label: string; value: React.ReactNode; mono?: boolean; copy?: string }) {
  return (
    <div className="py-2 border-b border-dark-800/60">
      <p className="text-[10px] uppercase tracking-wider text-dark-500">{label}</p>
      {copy ? (
        <Copyable value={copy} className={`text-sm text-dark-200 ${mono ? "font-mono" : ""}`} />
      ) : (
        <p className={`text-sm text-dark-200 ${mono ? "font-mono" : ""}`}>{value}</p>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "text-dark-100" }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-dark-700/60 bg-dark-850 p-2.5">
      <p className={`text-lg font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] text-dark-500">{label}</p>
    </div>
  );
}

export default function SessionDetailsDrawer({
  session, actions, audit, validating, busy, onClose,
}: {
  session: SessionOverviewItem | null;
  actions: SessionActions;
  audit: AuditRow[];
  validating: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => { if (session) setTab("overview"); }, [session?.filename]);

  const s = session;
  const now = Date.now() / 1000;

  return (
    <AnimatePresence>
      {s && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose}
          />
          <motion.aside
            initial={{ x: "100%", opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "100%", opacity: 0.6 }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full sm:w-[70vw] lg:w-[460px] flex-col border-l border-dark-700 bg-dark-900 shadow-2xl"
            role="dialog" aria-label={`Session ${s.filename}`}
          >
            {/* Header */}
            <div className="border-b border-dark-700 px-4 py-3">
              <div className="flex items-start gap-3">
                <Avatar name={accountName(s)} id={s.user_id} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-dark-50 truncate">{accountName(s)}</p>
                  <p className="text-[11px] text-dark-500 font-mono truncate">{s.user_id ? `ID ${s.user_id}` : s.filename}</p>
                </div>
                <button onClick={onClose} aria-label="Close details" className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <HealthBadge health={s.health} validating={validating} />
                <LocationBadge pool={s.pool} />
                {isAssigned(s) && <StatusPill status={s.derived_status} />}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-dark-700 px-2">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors
                    ${tab === t.key ? "border-accent text-accent" : "border-transparent text-dark-500 hover:text-dark-300"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {tab === "overview" && (
                <div className="space-y-0.5">
                  <Field label="Session file" value={s.filename} mono copy={s.filename} />
                  <Field label="Account name" value={s.real_name || "—"} />
                  <Field label="Telegram user ID" value={s.user_id ?? "—"} mono copy={s.user_id ? String(s.user_id) : undefined} />
                  <Field
                    label="Phone (from filename · unverified)"
                    value={s.phone_from_file ? `${s.phone_from_file}` : "—"}
                    mono
                  />
                  <Field label="Location" value={<LocationBadge pool={s.pool} />} />
                  <Field label="Starred" value={s.starred ? "Yes" : "No"} />
                  <Field label="Assigned bot" value={s.bot_name || "Not assigned"} />
                  {isAssigned(s) && <Field label="Enabled" value={s.disabled ? "Disabled (parked)" : "Enabled"} />}
                  <div className="pt-3 flex gap-2">
                    <button onClick={() => actions.onOpenClient(s)} className="inline-flex items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700">
                      <ExternalLink className="h-3.5 w-3.5" /> Open Telegram client
                    </button>
                    {s.starred
                      ? <button onClick={() => actions.onStar(s)} className="rounded-lg border border-dark-700 bg-dark-800 px-3 py-1.5 text-xs text-amber-400 hover:bg-dark-700">Unstar</button>
                      : <button onClick={() => actions.onStar(s)} className="rounded-lg border border-dark-700 bg-dark-800 px-3 py-1.5 text-xs text-dark-300 hover:bg-dark-700">Star</button>}
                  </div>
                </div>
              )}

              {tab === "health" && (
                <div className="space-y-0.5">
                  <Field label="Validation status" value={s.validation_status || "Unchecked"} />
                  <Field label="Validation reason" value={s.validation_reason || "—"} />
                  <Field label="Last validated" value={s.last_validated_at ? timeAgo(now - s.last_validated_at) : "Never"} />
                  {isAssigned(s) && (
                    <>
                      <Field label="SpamBot flag" value={s.spam_status ? s.spam_status[0].toUpperCase() + s.spam_status.slice(1) : "None"} />
                      <Field label="Last SpamBot check" value={s.last_spambot_check_at ? timeAgo(now - s.last_spambot_check_at) : "Never"} />
                    </>
                  )}
                  <Field label="Current pool" value={<LocationBadge pool={s.pool} />} />
                  <Field label="Last error" value={s.last_error || "—"} />
                  <Field label="Last error time" value={s.last_error_at ? timeAgo(now - s.last_error_at) : "—"} />
                  {s.pause_remaining_sec != null && (
                    <Field label="Pause / FloodWait remaining" value={`${Math.ceil(s.pause_remaining_sec / 60)} min`} />
                  )}
                  <div className="pt-3 flex gap-2">
                    <button
                      onClick={() => actions.onValidate(s)}
                      disabled={validating}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-600 disabled:opacity-60"
                    >
                      {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      {validating ? "Validating…" : "Validate"}
                    </button>
                    {!isAssigned(s) && (s.pool === "free" || s.pool === "limited" || s.pool === "frozen") && (
                      <button onClick={() => actions.onSpambot(s)} className="inline-flex items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700">
                        <Shield className="h-3.5 w-3.5" /> SpamBot check
                      </button>
                    )}
                    {isAssigned(s) && (
                      <button onClick={() => actions.onSetStatus(s)} className="inline-flex items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700">
                        <Activity className="h-3.5 w-3.5" /> Change health status
                      </button>
                    )}
                  </div>
                  {busy && <p className="mt-2 text-[11px] text-amber-400">This session is currently in use by a worker — validation was skipped to avoid corrupting it.</p>}
                </div>
              )}

              {tab === "assignment" && (
                <div className="space-y-0.5">
                  {isAssigned(s) ? (
                    <>
                      <Field label="Assigned bot" value={s.bot_name} />
                      <Field label="Bot state" value={s.bot_state || "—"} />
                      <Field label="Plan" value={s.bot_plan || "—"} />
                      <Field label="Enabled" value={s.disabled ? "Disabled (parked)" : "Enabled"} />
                      <div className="pt-3 grid grid-cols-2 gap-2">
                        <Link href={`/admin/adbots/${encodeURIComponent(s.bot_name!)}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-xs text-dark-200 hover:bg-dark-700">
                          <Bot className="h-3.5 w-3.5" /> Open bot
                        </Link>
                        <button onClick={() => actions.onToggleEnabled(s)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-xs text-dark-200 hover:bg-dark-700">
                          <Power className="h-3.5 w-3.5" /> {s.disabled ? "Enable" : "Disable"}
                        </button>
                        <button onClick={() => actions.onReplace(s)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-xs text-dark-200 hover:bg-dark-700">
                          <Repeat className="h-3.5 w-3.5" /> Replace
                        </button>
                        <button onClick={() => actions.onUnassign(s)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger hover:bg-danger/20">
                          <Unlink className="h-3.5 w-3.5" /> Unassign
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="py-6 text-center">
                      <p className="text-sm text-dark-300">Not assigned</p>
                      <p className="text-[11px] text-dark-500 mt-1 mb-4">This session is in the {s.pool} pool.</p>
                      {s.pool === "free" && (
                        <button onClick={() => actions.onAssign(s)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-600">
                          <LinkIcon className="h-3.5 w-3.5" /> Assign to AdBot
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "runtime" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Sent" value={s.sent} tone="text-emerald-400" />
                    <Stat label="Failed" value={s.failed} tone="text-rose-400" />
                    <Stat label="Flood" value={s.flood} tone="text-amber-400" />
                  </div>
                  <div className="space-y-0.5">
                    <Field label="Runtime status" value={isAssigned(s) ? <StatusPill status={s.derived_status} /> : "Not assigned"} />
                    <Field label="Success rate" value={s.success_rate != null ? `${s.success_rate}%` : "—"} />
                    <Field label="Last cycle" value={s.last_cycle_ts ? timeAgo(now - s.last_cycle_ts) : "—"} />
                    <Field label="Last activity" value={s.last_active_at ? timeAgo(now - s.last_active_at) : "Never used"} />
                    {s.pause_remaining_sec != null && (
                      <Field label="Pause remaining" value={`${Math.ceil(s.pause_remaining_sec / 60)} min`} />
                    )}
                  </div>
                </div>
              )}

              {tab === "activity" && <ActivityTimeline session={s} entries={audit} />}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
