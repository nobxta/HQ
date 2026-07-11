"use client";
import { useState, useRef, useCallback, useMemo } from "react";
import {
  UploadCloud, File as FileIcon, X, CheckCircle2, AlertTriangle, XCircle, Loader2, ArrowRightLeft,
} from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import type { SessionOverviewItem, BulkOpResult, SessionPool } from "@/lib/types";
import { uploadSessions, type UploadResult, bulkMove, moveSession, bulkDelete, deleteSession } from "@/lib/sessions";
import { POOL_META } from "./shared";
import toast from "react-hot-toast";

// ─────────────── Operation result ───────────────
export function OperationResultDialog({
  open, onClose, title, result, onViewAffected,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  result: BulkOpResult | null;
  onViewAffected?: (files: string[]) => void;
}) {
  if (!result) return null;
  const { summary, success, failed, skipped } = result;
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { l: "Requested", v: summary.requested, t: "text-dark-200" },
            { l: "Succeeded", v: summary.succeeded, t: "text-emerald-400" },
            { l: "Failed", v: summary.failed, t: "text-rose-400" },
            { l: "Skipped", v: summary.skipped, t: "text-amber-400" },
          ].map((c) => (
            <div key={c.l} className="rounded-lg border border-dark-700/60 bg-dark-850 p-2.5">
              <p className={`text-xl font-bold tabular-nums ${c.t}`}>{c.v}</p>
              <p className="text-[10px] text-dark-500">{c.l}</p>
            </div>
          ))}
        </div>

        {(failed.length > 0 || skipped.length > 0) && (
          <div className="max-h-56 overflow-y-auto space-y-1.5">
            {failed.map((f) => (
              <div key={`f-${f.filename}`} className="flex items-start gap-2 rounded-lg bg-rose-500/5 border border-rose-500/20 px-2.5 py-1.5">
                <XCircle className="h-3.5 w-3.5 text-rose-400 mt-0.5 shrink-0" />
                <div className="min-w-0"><p className="text-xs font-mono text-dark-300 truncate">{f.filename}</p><p className="text-[11px] text-rose-300">{f.message}</p></div>
              </div>
            ))}
            {skipped.map((f) => (
              <div key={`s-${f.filename}`} className="flex items-start gap-2 rounded-lg bg-amber-500/5 border border-amber-500/20 px-2.5 py-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                <div className="min-w-0"><p className="text-xs font-mono text-dark-300 truncate">{f.filename}</p><p className="text-[11px] text-amber-300">{f.message}</p></div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {onViewAffected && success.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => { onViewAffected(success); onClose(); }}>View affected</Button>
          )}
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────── Upload ───────────────
type UploadStep = "select" | "review" | "processing" | "result";

export function UploadSessionsDialog({
  open, onClose, knownFilenames, onDone,
}: {
  open: boolean;
  onClose: () => void;
  knownFilenames: Set<string>;
  onDone: (added: string[]) => void;
}) {
  const [step, setStep] = useState<UploadStep>("select");
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const reset = () => { setStep("select"); setFiles([]); setResult(null); };
  const close = () => { if (step !== "processing") { reset(); onClose(); } };

  const accept = (list: FileList | File[]) => {
    const arr = Array.from(list);
    const valid = arr.filter((f) => f.name.endsWith(".session") || f.name.endsWith(".zip"));
    const bad = arr.length - valid.length;
    if (bad > 0) toast.error(`${bad} unsupported file(s) ignored (need .session or .zip)`);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !names.has(f.name))];
    });
  };

  const preflight = useMemo(() => {
    const seen = new Set<string>();
    let dupInSel = 0, dupKnown = 0, zips = 0, sessions = 0;
    for (const f of files) {
      if (f.name.endsWith(".zip")) { zips++; continue; }
      sessions++;
      if (seen.has(f.name)) dupInSel++;
      seen.add(f.name);
      if (knownFilenames.has(f.name)) dupKnown++;
    }
    return { dupInSel, dupKnown, zips, sessions, ready: files.length };
  }, [files, knownFilenames]);

  const doUpload = async () => {
    setStep("processing");
    try {
      const res = await uploadSessions(files);
      setResult(res);
      setStep("result");
      if (res.total_added > 0) toast.success(`${res.total_added} session(s) added`);
      onDone(res.added);
    } catch (e) {
      toast.error(errMsg(e, "Upload failed"));
      setStep("review");
    }
  };

  return (
    <Modal open={open} onClose={close} title="Upload sessions" size="lg">
      {/* Steps header */}
      <div className="mb-4 flex items-center gap-2 text-[11px]">
        {(["select", "review", "processing", "result"] as UploadStep[]).map((st, i) => (
          <div key={st} className="flex items-center gap-2">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold
              ${step === st ? "bg-accent text-white" : "bg-dark-700 text-dark-400"}`}>{i + 1}</span>
            <span className={`capitalize ${step === st ? "text-dark-200" : "text-dark-500"}`}>{st}</span>
            {i < 3 && <span className="w-4 h-px bg-dark-700" />}
          </div>
        ))}
      </div>

      {step === "select" && (
        <div className="space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files) accept(e.dataTransfer.files); }}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${drag ? "border-accent bg-accent/5" : "border-dark-700"}`}
          >
            <UploadCloud className="h-9 w-9 mx-auto mb-2 text-dark-500" />
            <p className="text-sm font-medium text-dark-200">Drop <span className="font-mono">.session</span> files or ZIP archives here</p>
            <p className="text-xs text-dark-500 mt-0.5">or browse from your device</p>
            <button onClick={() => inputRef.current?.click()} className="mt-3 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white hover:bg-accent-600">Browse files</button>
            <input ref={inputRef} type="file" accept=".session,.zip" multiple className="hidden" onChange={(e) => e.target.files && accept(e.target.files)} />
            <p className="text-[11px] text-dark-600 mt-3">Accepted: .session, .zip · Duplicate filenames are detected before upload</p>
          </div>
          {files.length > 0 && (
            <>
              <div className="max-h-48 overflow-y-auto space-y-1.5">
                {files.map((f) => (
                  <div key={f.name} className="flex items-center gap-2 rounded-lg border border-dark-700/60 bg-dark-850 px-2.5 py-1.5">
                    <FileIcon className="h-3.5 w-3.5 text-dark-500 shrink-0" />
                    <span className="text-xs font-mono text-dark-300 truncate flex-1">{f.name}</span>
                    <span className="text-[10px] text-dark-500">{(f.size / 1024).toFixed(0)} KB</span>
                    <button onClick={() => setFiles((p) => p.filter((x) => x !== f))} aria-label="Remove" className="text-dark-500 hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setFiles([])}>Clear</Button>
                <Button size="sm" onClick={() => setStep("review")}>Review ({files.length})</Button>
              </div>
            </>
          )}
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              { l: "Selected", v: files.length, t: "text-dark-200" },
              { l: "Archives", v: preflight.zips, t: "text-dark-200" },
              { l: "Dup. filename", v: preflight.dupKnown + preflight.dupInSel, t: "text-amber-400" },
              { l: "Ready", v: preflight.ready, t: "text-emerald-400" },
            ].map((c) => (
              <div key={c.l} className="rounded-lg border border-dark-700/60 bg-dark-850 p-2.5">
                <p className={`text-lg font-bold tabular-nums ${c.t}`}>{c.v}</p>
                <p className="text-[10px] text-dark-500">{c.l}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-dark-500">
            Duplicate detection here is by filename only. Archive contents are extracted and de-duplicated on the server.
          </p>
          <div className="flex justify-between">
            <Button variant="secondary" size="sm" onClick={() => setStep("select")}>Back</Button>
            <Button size="sm" onClick={doUpload} disabled={files.length === 0}>Upload {files.length} file(s)</Button>
          </div>
        </div>
      )}

      {step === "processing" && (
        <div className="py-12 flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          <p className="text-sm text-dark-200">Uploading and processing sessions…</p>
          <p className="text-[11px] text-dark-500">Do not close this window.</p>
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="flex justify-center"><CheckCircle2 className="h-10 w-10 text-emerald-400" /></div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { l: "Uploaded", v: result.summary.uploaded },
              { l: "Extracted", v: result.summary.extracted },
              { l: "Added", v: result.summary.added },
              { l: "Duplicates", v: result.summary.duplicates },
              { l: "Invalid", v: result.summary.invalid },
              { l: "Failed", v: result.summary.failed },
            ].map((c) => (
              <div key={c.l} className="rounded-lg border border-dark-700/60 bg-dark-850 p-2.5">
                <p className="text-lg font-bold tabular-nums text-dark-100">{c.v}</p>
                <p className="text-[10px] text-dark-500">{c.l}</p>
              </div>
            ))}
          </div>
          {result.errors.length > 0 && (
            <div className="max-h-32 overflow-y-auto space-y-1">
              {result.errors.map((e) => (
                <p key={e.filename} className="text-[11px] text-rose-300"><span className="font-mono">{e.filename}</span> — {e.message}</p>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            {result.added.length > 0 && <Button variant="secondary" size="sm" onClick={() => { onDone(result.added); close(); }}>View added sessions</Button>}
            <Button size="sm" onClick={close}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─────────────── Move ───────────────
const MOVE_TARGETS: SessionPool[] = ["free", "dead", "frozen", "limited", "unauth"];

export function MoveSessionsDialog({
  open, onClose, sessions, onDone,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionOverviewItem[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState<SessionPool>("free");
  const [busy, setBusy] = useState(false);
  const unassigned = sessions.filter((s) => !s.bot_name);
  const assignedCount = sessions.length - unassigned.length;

  const run = async () => {
    if (unassigned.length === 0) { toast.error("No unassigned sessions to move"); return; }
    setBusy(true);
    try {
      if (unassigned.length === 1) {
        await moveSession(unassigned[0].filename, unassigned[0].pool, target);
        toast.success(`Moved to ${POOL_META[target].label}`);
      } else {
        const files = unassigned.map((s) => s.filename);
        const res = await bulkMove(files, "", target);
        toast.success(`Moved ${res.summary.succeeded} · ${res.summary.failed} failed`);
      }
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e, "Move failed"));
    }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={`Move session${sessions.length > 1 ? "s" : ""}`} size="md">
      <div className="space-y-4">
        <p className="text-sm text-dark-400">{unassigned.length} unassigned session(s) selected.</p>
        {assignedCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300">{assignedCount} assigned session(s) will be skipped. Unassign them before moving.</p>
          </div>
        )}
        <div>
          <p className="text-[11px] uppercase tracking-wider text-dark-500 mb-1.5">Destination pool</p>
          <div className="flex flex-wrap gap-2">
            {MOVE_TARGETS.map((b) => (
              <button
                key={b}
                onClick={() => setTarget(b)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${target === b ? "border-accent bg-accent/15 text-accent-200" : "border-dark-700 text-dark-400 hover:border-dark-500"}`}
              >
                {POOL_META[b].label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={run} loading={busy} disabled={unassigned.length === 0}>
            <ArrowRightLeft className="h-4 w-4" /> Move to {POOL_META[target].label}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────── Delete ───────────────
export function DeleteSessionsDialog({
  open, onClose, sessions, onDone,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionOverviewItem[];
  onDone: (result?: BulkOpResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const deletable = sessions.filter((s) => !s.bot_name);
  const assignedCount = sessions.length - deletable.length;
  const needsTyped = deletable.length > 10;
  const canConfirm = deletable.length > 0 && (!needsTyped || typed.trim().toUpperCase() === "DELETE");

  const run = async () => {
    setBusy(true);
    try {
      if (deletable.length === 1) {
        await deleteSession(deletable[0].filename);
        toast.success(`Deleted ${deletable[0].filename}`);
        onDone();
      } else {
        const res = await bulkDelete(deletable.map((s) => s.filename));
        toast.success(`Deleted ${res.summary.succeeded} · ${res.summary.skipped} skipped`);
        onDone(res);
      }
      onClose();
      setTyped("");
    } catch (e) {
      toast.error(errMsg(e, "Delete failed"));
    }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={deletable.length > 1 ? "Delete sessions" : "Delete session"} size="sm">
      <div className="space-y-4">
        {deletable.length === 1 ? (
          <p className="text-sm text-dark-300">Delete <span className="font-mono text-dark-100">{deletable[0].filename}</span>?</p>
        ) : (
          <p className="text-sm text-dark-300">Delete <span className="font-semibold text-dark-100">{deletable.length}</span> session files permanently?</p>
        )}
        <p className="text-xs text-dark-500">This removes the session files and their pool records. This action cannot be undone.</p>
        {assignedCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300">{assignedCount} assigned session(s) cannot be deleted and will be skipped. Unassign them first.</p>
          </div>
        )}
        {needsTyped && (
          <div>
            <p className="text-[11px] text-dark-500 mb-1">Type <span className="font-mono text-dark-300">DELETE</span> to confirm</p>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} className="w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-danger/40" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={run} loading={busy} disabled={!canConfirm}>Delete {deletable.length > 1 ? `(${deletable.length})` : ""}</Button>
        </div>
      </div>
    </Modal>
  );
}

export function errMsg(e: unknown, fallback: string): string {
  const anyE = e as { response?: { data?: { detail?: unknown } } };
  const d = anyE?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  return fallback;
}
