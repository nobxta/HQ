"use client";
import { useState, useEffect } from "react";
import { LinkIcon, Unlink, Repeat, AlertTriangle, Search } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import type { SessionOverviewItem } from "@/lib/types";
import {
  assignSession, unassignSession, replaceAssignedSession, listBotOptions, type BotOption,
} from "@/lib/sessions";
import { HealthBadge, Avatar, accountName } from "./shared";
import { errMsg } from "./dialogs";
import toast from "react-hot-toast";

// ─────────────── Assign (single or bulk) ───────────────
export function AssignSessionDialog({
  open, onClose, sessions, onDone,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionOverviewItem[];
  onDone: () => void;
}) {
  const [bots, setBots] = useState<BotOption[]>([]);
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (open) {
      setPick(""); setQ("");
      listBotOptions().then(setBots).catch(() => setBots([]));
    }
  }, [open]);

  if (sessions.length === 0) return null;
  const single = sessions.length === 1 ? sessions[0] : null;
  const neverValidated = sessions.some((s) => !s.validation_status && !s.last_validated_at);
  const filtered = bots.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()));

  const run = async () => {
    if (!pick) { toast.error("Select an AdBot"); return; }
    setBusy(true);
    try {
      let ok = 0, fail = 0;
      for (const s of sessions) {
        try { await assignSession(pick, s.filename); ok++; } catch { fail++; }
      }
      if (fail === 0) toast.success(`Assigned ${ok} session(s) to ${pick}`);
      else toast.error(`${ok} assigned · ${fail} failed`);
      onDone(); onClose();
    } catch (e) { toast.error(errMsg(e, "Assign failed")); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Assign to AdBot" size="md">
      <div className="space-y-4">
        {single ? (
          <div className="flex items-center gap-3 rounded-lg border border-dark-700/60 bg-dark-850 p-3">
            <Avatar name={accountName(single)} id={single.user_id} size={36} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-dark-100 truncate">{accountName(single)}</p>
              <p className="text-[11px] text-dark-500 font-mono truncate">{single.filename}</p>
            </div>
            <HealthBadge health={single.health} />
          </div>
        ) : (
          <p className="text-sm text-dark-400">{sessions.length} ready session(s) selected.</p>
        )}
        {neverValidated && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300">This session has never been validated. Consider validating it before assigning.</p>
          </div>
        )}
        <div>
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search AdBots…" className="w-full rounded-lg border border-dark-700 bg-dark-800 pl-8 pr-3 py-1.5 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {filtered.length === 0 ? <p className="text-xs text-dark-500 py-4 text-center">No bots</p> : filtered.map((b) => (
              <button
                key={b.name}
                onClick={() => setPick(b.name)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${pick === b.name ? "border-accent bg-accent/10" : "border-dark-700/60 hover:border-dark-600"}`}
              >
                <div>
                  <p className="text-sm text-dark-100">{b.name}</p>
                  <p className="text-[11px] text-dark-500">{b.plan_name || b.state} · {b.sessions_count} session(s)</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.running ? "bg-emerald-500/15 text-emerald-400" : "bg-dark-700 text-dark-400"}`}>{b.running ? "running" : "stopped"}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={run} loading={busy} disabled={!pick}><LinkIcon className="h-4 w-4" /> Assign</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────── Unassign ───────────────
export function UnassignSessionDialog({
  open, onClose, session, onDone,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionOverviewItem | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!session || !session.bot_name) return null;

  const run = async () => {
    setBusy(true);
    try {
      await unassignSession(session.bot_name!, session.filename);
      toast.success("Returned to ready pool");
      onDone(); onClose();
    } catch (e) { toast.error(errMsg(e, "Unassign failed")); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Unassign session" size="sm">
      <div className="space-y-4">
        <div className="space-y-0.5 text-sm">
          <p className="text-dark-300">Session <span className="font-mono text-dark-100">{session.filename}</span></p>
          <p className="text-dark-500 text-xs">Assigned bot: {session.bot_name} ({session.bot_state})</p>
        </div>
        <div className="rounded-lg border border-dark-700/60 bg-dark-850 px-3 py-2">
          <p className="text-xs text-dark-400">This session will be removed from <span className="text-dark-200">{session.bot_name}</span> and returned to the ready pool. The bot keeps running with its remaining accounts.</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={run} loading={busy}><Unlink className="h-4 w-4" /> Unassign</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────── Replace ───────────────
export function ReplaceSessionDialog({
  open, onClose, session, freeSessions, onDone,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionOverviewItem | null;
  freeSessions: SessionOverviewItem[];
  onDone: () => void;
}) {
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { if (open) { setPick(""); setQ(""); } }, [open]);

  if (!session || !session.bot_name) return null;
  const candidates = freeSessions.filter((s) => !q || s.filename.toLowerCase().includes(q.toLowerCase()) || (s.real_name || "").toLowerCase().includes(q.toLowerCase()));

  const run = async () => {
    if (!pick) { toast.error("Select a replacement"); return; }
    setBusy(true);
    try {
      await replaceAssignedSession(session.bot_name!, session.filename, pick);
      toast.success("Session replaced");
      onDone(); onClose();
    } catch (e) { toast.error(errMsg(e, "Replace failed")); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Replace session" size="lg">
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Current */}
        <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.04] p-3">
          <p className="text-[10px] uppercase tracking-wider text-dark-500 mb-2">Current session</p>
          <div className="flex items-center gap-2.5">
            <Avatar name={accountName(session)} id={session.user_id} size={34} />
            <div className="min-w-0">
              <p className="text-sm text-dark-100 truncate">{accountName(session)}</p>
              <p className="text-[11px] text-dark-500 font-mono truncate">{session.filename}</p>
            </div>
          </div>
          <div className="mt-2 space-y-1 text-[11px] text-dark-400">
            <p>Bot: <span className="text-dark-200">{session.bot_name}</span></p>
            <p>Validation: {session.validation_status || "unchecked"}</p>
            {session.last_error && <p className="text-rose-300 truncate">Last error: {session.last_error}</p>}
          </div>
        </div>

        {/* Replacement */}
        <div className="rounded-xl border border-dark-700/60 bg-dark-850 p-3">
          <p className="text-[10px] uppercase tracking-wider text-dark-500 mb-2">Replacement (from ready pool)</p>
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ready sessions…" className="w-full rounded-lg border border-dark-700 bg-dark-800 pl-8 pr-3 py-1.5 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {candidates.length === 0 ? <p className="text-xs text-dark-500 py-4 text-center">No ready sessions available</p> : candidates.map((c) => (
              <button
                key={c.filename}
                onClick={() => setPick(c.filename)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${pick === c.filename ? "border-accent bg-accent/10" : "border-dark-700/60 hover:border-dark-600"}`}
              >
                <Avatar name={accountName(c)} id={c.user_id} size={26} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-dark-100 truncate">{accountName(c)}</p>
                  <p className="text-[10px] text-dark-500 font-mono truncate">{c.filename}</p>
                </div>
                <HealthBadge health={c.health} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-dark-500">
          {pick ? <>Replace <span className="font-mono text-dark-300">{session.filename}</span> in <span className="text-dark-300">{session.bot_name}</span></> : "Select a replacement session"}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={run} loading={busy} disabled={!pick}><Repeat className="h-4 w-4" /> Replace session</Button>
        </div>
      </div>
    </Modal>
  );
}
