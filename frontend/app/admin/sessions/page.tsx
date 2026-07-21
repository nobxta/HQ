"use client";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { AlertCircle } from "lucide-react";

import { useSessionsOverview, useAuditLog } from "@/lib/sessions";
import {
  validateSessions, validateAssignedSession, spambotCheck, starSession, setSessionEnabled,
  unassignSession, getSessionsInfo,
} from "@/lib/sessions";
import type { SessionOverviewItem, BulkOpResult } from "@/lib/types";

import SessionsHeader from "@/components/admin/sessions/SessionsHeader";
import AttentionBanner from "@/components/admin/sessions/AttentionBanner";
import SummaryCards from "@/components/admin/sessions/SummaryCards";
import HealthStrip from "@/components/admin/sessions/HealthStrip";
import Toolbar from "@/components/admin/sessions/Toolbar";
import FiltersPanel from "@/components/admin/sessions/FiltersPanel";
import SessionsTable from "@/components/admin/sessions/SessionsTable";
import BulkActionBar, { type BulkHandlers } from "@/components/admin/sessions/BulkActionBar";
import SessionDetailsDrawer from "@/components/admin/sessions/SessionDetailsDrawer";
import type { SessionActions } from "@/components/admin/sessions/SessionActionsMenu";
import { OperationResultDialog, UploadSessionsDialog, MoveSessionsDialog, DeleteSessionsDialog, errMsg } from "@/components/admin/sessions/dialogs";
import { AssignSessionDialog, UnassignSessionDialog, ReplaceSessionDialog, SetStatusDialog } from "@/components/admin/sessions/assignmentDialogs";
import {
  EMPTY_FILTERS, type SessionFilters, type SessionView,
  matchesView, matchesFilters, matchesSearch, viewCount,
} from "@/components/admin/sessions/views";
import {
  loadVisible, saveVisible, loadDensity, saveDensity, type ColumnKey, type Density,
} from "@/components/admin/sessions/columns";
import type { SessionHealth } from "@/lib/types";

function readUrl(): { view: SessionView; session: string | null; q: string } {
  if (typeof window === "undefined") return { view: "all", session: null, q: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    view: (p.get("view") as SessionView) || "all",
    session: p.get("session"),
    q: p.get("q") || "",
  };
}

export default function SessionsPage() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSessionsOverview("24h");
  const { data: auditData } = useAuditLog(300);
  const audit = auditData?.entries || [];

  const sessions = useMemo(() => data?.sessions || [], [data]);
  const byName = useMemo(() => {
    const m = new Map<string, SessionOverviewItem>();
    sessions.forEach((s) => m.set(s.filename, s));
    return m;
  }, [sessions]);

  // ── URL-backed view + open drawer ──
  const [view, setViewState] = useState<SessionView>("all");
  const [openFilename, setOpenFilename] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const u = readUrl();
    setViewState(u.view); setOpenFilename(u.session); setSearch(u.q); setDebounced(u.q);
    const onPop = () => { const n = readUrl(); setViewState(n.view); setOpenFilename(n.session); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const writeUrl = useCallback((next: { view?: SessionView; session?: string | null; q?: string }, push = false) => {
    if (typeof window === "undefined") return;
    const cur = readUrl();
    const p = new URLSearchParams();
    const v = next.view ?? cur.view;
    const s = next.session === undefined ? cur.session : next.session;
    const q = next.q ?? cur.q;
    if (v && v !== "all") p.set("view", v);
    if (q) p.set("q", q);
    if (s) p.set("session", s);
    const url = `${window.location.pathname}${p.toString() ? `?${p}` : ""}`;
    if (push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
  }, []);

  const setView = useCallback((v: SessionView) => { setViewState(v); writeUrl({ view: v }); }, [writeUrl]);
  const openSession = useCallback((fn: string) => { setOpenFilename(fn); writeUrl({ session: fn }, true); }, [writeUrl]);
  const closeDrawer = useCallback(() => { setOpenFilename(null); writeUrl({ session: null }); }, [writeUrl]);

  // debounce search → URL + applied
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); writeUrl({ q: search }); }, 250);
    return () => clearTimeout(t);
  }, [search, writeUrl]);

  // ── filters, columns, density ──
  const [filters, setFilters] = useState<SessionFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visible, setVisible] = useState<Record<ColumnKey, boolean>>(loadVisible());
  const [density, setDensity] = useState<Density>("comfortable");
  useEffect(() => { setVisible(loadVisible()); setDensity(loadDensity()); }, []);
  const toggleColumn = (k: ColumnKey) => setVisible((v) => { const n = { ...v, [k]: !v[k] }; saveVisible(n); return n; });
  const changeDensity = (d: Density) => { setDensity(d); saveDensity(d); };

  // ── selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastIndexRef = useRef<number | null>(null);
  const [validating, setValidating] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [updated, setUpdated] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  // ── dialogs ──
  const [uploadOpen, setUploadOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<SessionOverviewItem[] | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<SessionOverviewItem[] | null>(null);
  const [assignTargets, setAssignTargets] = useState<SessionOverviewItem[] | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<SessionOverviewItem | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<SessionOverviewItem | null>(null);
  const [statusTarget, setStatusTarget] = useState<SessionOverviewItem | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<SessionOverviewItem | null>(null);
  const [opResult, setOpResult] = useState<{ title: string; result: BulkOpResult } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // ── derived lists ──
  const filtered = useMemo(() => sessions.filter(
    (s) => matchesView(s, view) && matchesFilters(s, filters) && matchesSearch(s, debounced),
  ), [sessions, view, filters, debounced]);

  const viewCounts = useMemo(() => ({
    all: sessions.length,
    ready: viewCount(sessions, "ready"),
    assigned: viewCount(sessions, "assigned"),
    needs_action: viewCount(sessions, "needs_action"),
    unchecked: viewCount(sessions, "unchecked"),
    starred: viewCount(sessions, "starred"),
  }), [sessions]) as Record<SessionView, number>;

  const selectedSessions = useMemo(() => filtered.filter((s) => selected.has(s.filename)), [filtered, selected]);
  const openSessionObj = openFilename ? byName.get(openFilename) || null : null;
  const knownFilenames = useMemo(() => new Set(sessions.map((s) => s.filename)), [sessions]);
  const freeSessions = useMemo(() => sessions.filter((s) => s.pool === "free"), [sessions]);
  const botNames = useMemo(() => Array.from(new Set(sessions.map((s) => s.bot_name).filter(Boolean))) as string[], [sessions]);

  // keep selection valid as data changes
  useEffect(() => {
    setSelected((prev) => { const n = new Set(Array.from(prev).filter((f) => byName.has(f))); return n.size === prev.size ? prev : n; });
  }, [byName]);

  const highlight = useCallback((fn: string) => {
    setUpdated((prev) => new Set(prev).add(fn));
    setTimeout(() => setUpdated((prev) => { const n = new Set(prev); n.delete(fn); return n; }), 900);
  }, []);

  const lastSyncedSec = useMemo(() => {
    if (!data?.generated_at) return null;
    return (Date.now() - new Date(data.generated_at).getTime()) / 1000;
  }, [data]);

  // ── actions ──
  const doRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await mutate(); } catch { toast.error("Refresh failed"); }
    setRefreshing(false);
  }, [mutate, refreshing]);

  const toastForStatus = (st: string) => {
    if (st === "active" || st === "valid") toast.success("Session is healthy");
    else if (st === "busy" || st === "skipped")
      toast("Validation skipped because this session is currently being used by a running AdBot", { icon: "⏳" });
    else if (st === "dead" || st === "invalid") toast.error("Session is dead — moved to dead pool");
    else toast(`Result: ${st}`);
  };

  const validateOne = useCallback(async (s: SessionOverviewItem) => {
    setValidating((p) => new Set(p).add(s.filename));
    try {
      if (s.bot_name) {
        const r = await validateAssignedSession(s.bot_name, s.filename);
        toastForStatus(r.status);
        // "skipped" means the session is held by a live worker — surface the in-use
        // note in the drawer and leave the row's health/validation untouched.
        if (r.status === "skipped") setBusy((p) => new Set(p).add(s.filename));
      } else {
        const r = await validateSessions([s.filename]);
        if (r.skipped[0]) toast.error(r.skipped[0].message);
        else {
          const item = r.sessions[0];
          toastForStatus(item?.status || "unknown");
          if (item?.status === "busy") setBusy((p) => new Set(p).add(s.filename));
        }
      }
      highlight(s.filename);
      await mutate();
    } catch (e) { toast.error(errMsg(e, "Validation failed")); }
    setValidating((p) => { const n = new Set(p); n.delete(s.filename); return n; });
  }, [mutate, highlight]);

  const spambotOne = useCallback(async (s: SessionOverviewItem) => {
    setValidating((p) => new Set(p).add(s.filename));
    try {
      const r = await spambotCheck([s.filename]);
      if (r.skipped[0]) toast.error(r.skipped[0].message);
      else toast.success(`SpamBot: ${r.sessions[0]?.spambot_status || "checked"}`);
      highlight(s.filename);
      await mutate();
    } catch (e) { toast.error(errMsg(e, "SpamBot check failed")); }
    setValidating((p) => { const n = new Set(p); n.delete(s.filename); return n; });
  }, [mutate, highlight]);

  const refreshInfoOne = useCallback(async (s: SessionOverviewItem) => {
    // Live "Refresh identity": opens the session once (via /info), persists the fresh
    // identity into the per-session cache, then re-reads the overview from cache.
    setValidating((p) => new Set(p).add(s.filename));
    try {
      const [info] = await getSessionsInfo([s.filename]);
      const st = String(info?.status || "unknown");
      if (st === "busy") toast.error("Session is in use by a worker — try again shortly.");
      else if (st === "active") toast.success(`Identity refreshed: ${info?.full_name || info?.real_name || s.filename}`);
      else toast.error(`Could not read identity (${st})`);
      highlight(s.filename);
      await mutate();
    } catch (e) { toast.error(errMsg(e, "Refresh failed")); }
    setValidating((p) => { const n = new Set(p); n.delete(s.filename); return n; });
  }, [mutate, highlight]);

  const toggleStar = useCallback(async (s: SessionOverviewItem) => {
    const on = !s.starred;
    // optimistic
    mutate((cur) => cur ? { ...cur, sessions: cur.sessions.map((x) => x.filename === s.filename ? { ...x, starred: on } : x) } : cur, { revalidate: false });
    try { await starSession(s.filename, on); } catch { toast.error("Failed to update star"); await mutate(); }
  }, [mutate]);

  const applyEnabled = useCallback(async (s: SessionOverviewItem, enabled: boolean) => {
    try {
      await setSessionEnabled(s.bot_name!, s.filename, enabled);
      toast.success(enabled ? "Session enabled" : "Session disabled");
      highlight(s.filename);
      await mutate();
    } catch (e) { toast.error(errMsg(e, "Failed")); }
  }, [mutate, highlight]);

  const toggleEnabled = useCallback((s: SessionOverviewItem) => {
    if (!s.bot_name) return;
    if (s.disabled) applyEnabled(s, true);
    else setConfirmDisable(s);
  }, [applyEnabled]);

  const actions: SessionActions = {
    onDetails: (s) => openSession(s.filename),
    onOpenClient: (s) => window.open(`/admin/sessions/${encodeURIComponent(s.filename)}`, "_blank"),
    onOpenBot: (s) => s.bot_name && router.push(`/admin/adbots/${encodeURIComponent(s.bot_name)}`),
    onValidate: validateOne,
    onRefreshInfo: refreshInfoOne,
    onSpambot: spambotOne,
    onAssign: (s) => setAssignTargets([s]),
    onMove: (s) => setMoveTargets([s]),
    onSetStatus: (s) => setStatusTarget(s),
    onStar: toggleStar,
    onDelete: (s) => setDeleteTargets([s]),
    onUnassign: (s) => setUnassignTarget(s),
    onToggleEnabled: toggleEnabled,
    onReplace: (s) => setReplaceTarget(s),
  };

  // ── selection helpers ──
  const toggleSelect = (filename: string, shift: boolean) => {
    const idx = filtered.findIndex((s) => s.filename === filename);
    setSelected((prev) => {
      const n = new Set(prev);
      if (shift && lastIndexRef.current != null && idx >= 0) {
        const [a, b] = [lastIndexRef.current, idx].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) n.add(filtered[i].filename);
      } else {
        if (n.has(filename)) n.delete(filename); else n.add(filename);
      }
      return n;
    });
    lastIndexRef.current = idx;
  };
  const selectAll = () => {
    setSelected((prev) => prev.size === filtered.length ? new Set() : new Set(filtered.map((s) => s.filename)));
  };
  const clearSelection = () => setSelected(new Set());

  // ── bulk handlers ──
  const bulkValidate = async () => {
    const free = selectedSessions.filter((s) => !s.bot_name).map((s) => s.filename);
    const assigned = selectedSessions.filter((s) => s.bot_name);
    setValidating((p) => { const n = new Set(p); selectedSessions.forEach((s) => n.add(s.filename)); return n; });
    try {
      if (free.length) await validateSessions(free);
      for (const s of assigned) { try { await validateAssignedSession(s.bot_name!, s.filename); } catch { /* per-session */ } }
      toast.success(`Validated ${selectedSessions.length} session(s)`);
      await mutate();
    } catch (e) { toast.error(errMsg(e, "Bulk validate failed")); }
    setValidating(new Set());
  };
  const bulkSpambot = async () => {
    const free = selectedSessions.filter((s) => s.pool === "free").map((s) => s.filename);
    if (!free.length) { toast.error("SpamBot check only runs on ready sessions"); return; }
    try { const r = await spambotCheck(free); toast.success(`Checked ${r.total} · ${r.summary.moved} moved`); await mutate(); }
    catch (e) { toast.error(errMsg(e, "SpamBot failed")); }
  };
  const bulkStar = async () => {
    const allStarred = selectedSessions.every((s) => s.starred);
    await Promise.all(selectedSessions.map((s) => starSession(s.filename, !allStarred).catch(() => {})));
    await mutate();
  };
  const bulkEnable = async (enabled: boolean) => {
    const assigned = selectedSessions.filter((s) => s.bot_name);
    let ok = 0;
    for (const s of assigned) { try { await setSessionEnabled(s.bot_name!, s.filename, enabled); ok++; } catch { /* skip */ } }
    toast.success(`${enabled ? "Enabled" : "Disabled"} ${ok} session(s)`);
    await mutate();
  };
  const bulkUnassign = async () => {
    const assigned = selectedSessions.filter((s) => s.bot_name);
    let ok = 0;
    for (const s of assigned) { try { await unassignSession(s.bot_name!, s.filename); ok++; } catch { /* skip */ } }
    toast.success(`Unassigned ${ok} session(s)`);
    clearSelection();
    await mutate();
  };

  const bulkHandlers: BulkHandlers = {
    onValidate: bulkValidate,
    onSpambot: bulkSpambot,
    onAssign: () => setAssignTargets(selectedSessions.filter((s) => s.pool === "free")),
    onMove: () => setMoveTargets(selectedSessions),
    onStar: bulkStar,
    onDelete: () => setDeleteTargets(selectedSessions),
    onEnable: () => bulkEnable(true),
    onDisable: () => bulkEnable(false),
    onUnassign: bulkUnassign,
    onClear: clearSelection,
  };

  // header more-menu
  const reviewAttention = () => {
    setFilters(EMPTY_FILTERS);
    setSearch("");
    setView("needs_action");
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  const validateAllReady = async () => {
    const ready = sessions.filter((s) => s.pool === "free").map((s) => s.filename);
    if (!ready.length) { toast.error("No ready sessions"); return; }
    toast.loading("Validating ready sessions…", { id: "vall" });
    try { const r = await validateSessions(ready); toast.success(`${r.active} active · ${r.dead} dead`, { id: "vall" }); await mutate(); }
    catch (e) { toast.error(errMsg(e, "Validate failed"), { id: "vall" }); }
  };
  const spambotReady = async () => {
    const ready = sessions.filter((s) => s.pool === "free").map((s) => s.filename);
    if (!ready.length) { toast.error("No ready sessions"); return; }
    toast.loading("Running SpamBot check…", { id: "sall" });
    try { const r = await spambotCheck(ready); toast.success(`${r.active} clean · ${r.summary.moved} moved`, { id: "sall" }); await mutate(); }
    catch (e) { toast.error(errMsg(e, "SpamBot failed"), { id: "sall" }); }
  };
  const viewActivity = () => { if (sessions[0]) openSession(sessions[0].filename); };

  // ── render ──
  return (
    <div className="space-y-5 animate-fade-in pb-24">
      <SessionsHeader
        lastSyncedSec={lastSyncedSec}
        refreshing={refreshing || isLoading}
        onRefresh={doRefresh}
        onUpload={() => setUploadOpen(true)}
        onValidateAllReady={validateAllReady}
        onSpambotReady={spambotReady}
        onViewActivity={viewActivity}
      />

      <AttentionBanner overview={data} onReview={reviewAttention} />

      {data && (
        <SummaryCards summary={data.summary} activeView={view} onPick={setView} />
      )}
      {data && (
        <HealthStrip
          summary={data.summary}
          activeHealth={filters.health}
          onPick={(h: SessionHealth) => setFilters((f) => ({ ...f, health: f.health === h ? "" : h }))}
        />
      )}

      <Toolbar
        view={view} viewCounts={viewCounts} onView={setView}
        search={search} onSearch={setSearch}
        filters={filters}
        onOpenFilters={() => setFiltersOpen(true)}
        onRemoveFilter={(k) => setFilters((f) => ({ ...f, [k]: typeof f[k] === "boolean" ? false : "" }))}
        onClearFilters={() => setFilters(EMPTY_FILTERS)}
        visible={visible} onToggleColumn={toggleColumn}
        density={density} onDensity={changeDensity}
      />

      <div ref={tableRef}>
        {error && !data ? (
          <div className="rounded-xl border border-danger/25 bg-danger/5 p-8 text-center">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-danger" />
            <p className="text-sm text-dark-200">Failed to load sessions</p>
            <button onClick={doRefresh} className="mt-3 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white hover:bg-accent-600">Retry</button>
          </div>
        ) : isLoading && !data ? (
          <TableSkeleton rows={8} cols={6} />
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dark-700/60 bg-dark-850 p-12 text-center">
            {sessions.length === 0 ? (
              <>
                <p className="text-base font-semibold text-dark-100">No sessions uploaded</p>
                <p className="text-sm text-dark-500 mt-1 mb-4">Upload session files to create your ready pool.</p>
                <button onClick={() => setUploadOpen(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-600">Upload sessions</button>
              </>
            ) : (
              <>
                <p className="text-base font-semibold text-dark-100">No sessions match these filters</p>
                <button onClick={() => { setFilters(EMPTY_FILTERS); setSearch(""); setView("all"); }} className="mt-3 rounded-lg border border-dark-700 bg-dark-800 px-3.5 py-1.5 text-xs text-dark-200 hover:bg-dark-700">Clear filters</button>
              </>
            )}
          </div>
        ) : (
          <SessionsTable
            sessions={filtered}
            visible={visible}
            density={density}
            selected={selected}
            validating={validating}
            recentlyUpdated={updated}
            openFilename={openFilename}
            actions={actions}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onRowClick={(s) => openSession(s.filename)}
          />
        )}
      </div>

      <BulkActionBar selected={selectedSessions} handlers={bulkHandlers} />

      {/* Drawer */}
      <SessionDetailsDrawer
        session={openSessionObj}
        actions={actions}
        audit={audit}
        validating={openFilename ? validating.has(openFilename) : false}
        busy={openFilename ? busy.has(openFilename) : false}
        onClose={closeDrawer}
      />

      {/* Filters */}
      <FiltersPanel open={filtersOpen} onClose={() => setFiltersOpen(false)} value={filters} onApply={setFilters} bots={botNames} />

      {/* Dialogs */}
      <UploadSessionsDialog open={uploadOpen} onClose={() => setUploadOpen(false)} knownFilenames={knownFilenames} onDone={(added) => { mutate(); if (added.length) { setSearch(added[0].replace(/\.session$/, "")); added.forEach(highlight); } }} />
      <MoveSessionsDialog open={!!moveTargets} onClose={() => setMoveTargets(null)} sessions={moveTargets || []} onDone={() => { mutate(); clearSelection(); }} />
      <DeleteSessionsDialog open={!!deleteTargets} onClose={() => setDeleteTargets(null)} sessions={deleteTargets || []} onDone={(r) => { mutate(); clearSelection(); if (r && (r.summary.failed || r.summary.skipped)) setOpResult({ title: "Delete result", result: r }); }} />
      <AssignSessionDialog open={!!assignTargets} onClose={() => setAssignTargets(null)} sessions={assignTargets || []} onDone={() => { mutate(); clearSelection(); }} />
      <UnassignSessionDialog open={!!unassignTarget} onClose={() => setUnassignTarget(null)} session={unassignTarget} onDone={() => mutate()} />
      <ReplaceSessionDialog open={!!replaceTarget} onClose={() => setReplaceTarget(null)} session={replaceTarget} freeSessions={freeSessions} onDone={() => mutate()} />
      <SetStatusDialog open={!!statusTarget} onClose={() => setStatusTarget(null)} session={statusTarget} onDone={() => mutate()} />

      <OperationResultDialog
        open={!!opResult} onClose={() => setOpResult(null)}
        title={opResult?.title || "Result"} result={opResult?.result || null}
      />

      <ConfirmModal
        open={!!confirmDisable}
        onClose={() => setConfirmDisable(null)}
        onConfirm={() => { if (confirmDisable) applyEnabled(confirmDisable, false); setConfirmDisable(null); }}
        title="Disable session"
        message={confirmDisable ? `Disable ${confirmDisable.filename} in ${confirmDisable.bot_name}? It stops being used in ads until re-enabled; the other accounts keep running.` : ""}
        confirmText="Disable"
        variant="primary"
      />
    </div>
  );
}
