"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { useSessions, usePool } from "@/lib/hooks/useSessions";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import {
  Upload, Trash2, Search, ShieldCheck, Shield, Eye,
  CheckSquare, Square, Loader2, AlertCircle, CheckCircle, XCircle,
  Crown, Ban, AtSign, Phone, Hash, FileText, ChevronDown, ChevronRight,
  Star, ArrowRightLeft, MoveRight, ExternalLink,
} from "lucide-react";
import Link from "next/link";
import api from "@/lib/api";
import toast from "react-hot-toast";

type SessionInfo = {
  file: string;
  real_name?: string;
  user_id?: number;
  username?: string;
  phone?: string;
  bio?: string;
  premium?: boolean;
  restricted?: boolean;
  status?: string;
  reason?: string;
  error?: string;
  spambot_status?: string;
};

const BUCKETS = ["free", "dead", "frozen", "limited", "unauth"] as const;
type Bucket = typeof BUCKETS[number];

export default function SessionsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const { data, isLoading, mutate } = useSessions(statusFilter);
  const { data: pool, mutate: mutatePool } = usePool();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Starred
  const [starred, setStarred] = useState<Set<string>>(new Set());

  // Move modal
  const [moveTarget, setMoveTarget] = useState<{ files: string[]; fromBucket: string } | null>(null);
  const [moveToBucket, setMoveToBucket] = useState<Bucket>("free");
  const [moving, setMoving] = useState(false);

  // Bulk action state
  const [bulkAction, setBulkAction] = useState<"" | "validating" | "spambot" | "info" | "deleting">("");
  const [sessionInfoMap, setSessionInfoMap] = useState<Record<string, SessionInfo>>({});
  const [bulkResult, setBulkResult] = useState<any>(null);
  const [expandedInfo, setExpandedInfo] = useState<Set<string>>(new Set());

  // Load starred sessions
  useEffect(() => {
    api.get("/api/sessions/starred").then(({ data }) => {
      setStarred(new Set(data.starred || []));
    }).catch(() => {});
  }, []);

  const sessions = (data?.sessions || []).filter(
    (s: any) => !search || s.filename.toLowerCase().includes(search.toLowerCase())
  );

  // Sort: starred first
  const sortedSessions = [...sessions].sort((a: any, b: any) => {
    const aStarred = starred.has(a.filename) ? 0 : 1;
    const bStarred = starred.has(b.filename) ? 0 : 1;
    return aStarred - bStarred;
  });

  // Toggle selection
  const toggleSelect = (filename: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === sortedSessions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedSessions.map((s: any) => s.filename)));
    }
  };

  const selectedFiles = () => Array.from(selected);

  // Star/unstar
  const toggleStar = async (filename: string) => {
    const isStarred = starred.has(filename);
    try {
      if (isStarred) {
        await api.delete(`/api/sessions/${filename}/star`);
        setStarred((prev) => { const n = new Set(prev); n.delete(filename); return n; });
      } else {
        await api.post(`/api/sessions/${filename}/star`);
        setStarred((prev) => { const n = new Set(prev); n.add(filename); return n; });
      }
    } catch {
      toast.error("Failed to update star");
    }
  };

  // Move session(s)
  const openMoveModal = (files: string[], fromBucket: string) => {
    setMoveTarget({ files, fromBucket });
    const defaultTo = fromBucket === "free" ? "dead" : "free";
    setMoveToBucket(defaultTo as Bucket);
  };

  const handleMove = async () => {
    if (!moveTarget) return;
    setMoving(true);
    try {
      if (moveTarget.files.length === 1) {
        await api.post(`/api/sessions/${moveTarget.files[0]}/move`, {
          from_bucket: moveTarget.fromBucket,
          to_bucket: moveToBucket,
        });
        toast.success(`Moved ${moveTarget.files[0]} to ${moveToBucket}`);
      } else {
        const { data } = await api.post("/api/sessions/bulk-move", {
          filenames: moveTarget.files,
          from_bucket: moveTarget.fromBucket,
          to_bucket: moveToBucket,
        });
        toast.success(`Moved ${data.moved} session(s) to ${moveToBucket}`);
        if (data.failed > 0) toast.error(`${data.failed} failed to move`);
      }
      mutate();
      mutatePool();
      setSelected(new Set());
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Move failed");
    }
    setMoving(false);
    setMoveTarget(null);
  };

  // Upload
  const handleUpload = async (files: FileList | File[]) => {
    if (!files?.length) return;
    setUploading(true);
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    try {
      const { data } = await api.post("/api/sessions/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success(`Uploaded: ${data.total_added} added, ${data.duplicates} duplicates`);
      mutate();
      mutatePool();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Upload failed");
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleUpload(e.target.files);
  };

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (files?.length) {
      const validFiles = Array.from(files).filter(
        (f) => f.name.endsWith(".session") || f.name.endsWith(".zip")
      );
      if (validFiles.length) handleUpload(validFiles);
      else toast.error("Only .session and .zip files are accepted");
    }
  }, []);

  // Delete single
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/api/sessions/${deleteTarget}`);
      toast.success(`Deleted ${deleteTarget}`);
      selected.delete(deleteTarget);
      setSelected(new Set(selected));
      mutate();
      mutatePool();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
    setDeleteTarget(null);
  };

  // Bulk delete
  const handleBulkDelete = async () => {
    const files = selectedFiles();
    if (!files.length) return;
    setBulkAction("deleting");
    try {
      const { data } = await api.post("/api/sessions/bulk-delete", { filenames: files });
      toast.success(`Deleted ${data.total_deleted} session(s)`);
      setSelected(new Set());
      mutate();
      mutatePool();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Bulk delete failed");
    }
    setBulkAction("");
  };

  // Bulk validate
  const runValidate = async () => {
    const files = selectedFiles();
    if (!files.length) { toast.error("Select sessions first"); return; }
    setBulkAction("validating");
    setBulkResult(null);
    try {
      const { data } = await api.post("/api/sessions/validate", { filenames: files });
      const map: Record<string, SessionInfo> = { ...sessionInfoMap };
      for (const s of data.sessions) map[s.file] = s;
      setSessionInfoMap(map);
      setExpandedInfo(new Set(files));
      setBulkResult({ type: "validate", active: data.active, dead: data.dead, dead_moved: data.dead_moved });
      if (data.dead > 0) {
        toast.error(`${data.dead} dead session(s) moved to dead pool`);
        const alive = new Set(selected);
        for (const fn of data.dead_moved || []) alive.delete(fn);
        setSelected(alive);
        mutate();
        mutatePool();
      } else {
        toast.success(`All ${data.active} session(s) are valid`);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Validation failed");
    }
    setBulkAction("");
  };

  // Bulk spambot
  const runSpambot = async () => {
    const files = selectedFiles();
    if (!files.length) { toast.error("Select sessions first"); return; }
    setBulkAction("spambot");
    setBulkResult(null);
    try {
      const { data } = await api.post("/api/sessions/spambot-check", { filenames: files });
      const map: Record<string, SessionInfo> = { ...sessionInfoMap };
      for (const s of data.sessions) {
        map[s.file] = { ...map[s.file], ...s };
      }
      setSessionInfoMap(map);
      const movedCount = (data.moved_limited?.length || 0) + (data.moved_frozen?.length || 0);
      setBulkResult({
        type: "spambot", active: data.active, limited: data.limited,
        frozen: data.frozen || 0, total: data.total,
        moved_limited: data.moved_limited || [], moved_frozen: data.moved_frozen || [],
      });
      if (movedCount > 0) {
        toast.error(`${movedCount} session(s) moved to limited/frozen pool`);
        const alive = new Set(selected);
        for (const fn of [...(data.moved_limited || []), ...(data.moved_frozen || [])]) alive.delete(fn);
        setSelected(alive);
        mutate();
        mutatePool();
      } else if (data.limited > 0 || (data.frozen || 0) > 0) {
        toast.error(`${data.limited + (data.frozen || 0)} session(s) are spam-limited/frozen`);
      } else {
        toast.success(`All ${data.active} session(s) clean`);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "SpamBot check failed");
    }
    setBulkAction("");
  };

  // Bulk info
  const runInfo = async () => {
    const files = selectedFiles();
    if (!files.length) { toast.error("Select sessions first"); return; }
    setBulkAction("info");
    setBulkResult(null);
    try {
      const { data } = await api.get("/api/sessions/info", {
        params: { filenames: files.join(",") },
      });
      const map: Record<string, SessionInfo> = { ...sessionInfoMap };
      for (const s of data.sessions) map[s.file] = s;
      setSessionInfoMap(map);
      setExpandedInfo(new Set(files));
      setBulkResult({ type: "info" });
      toast.success("Session info loaded");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Info check failed");
    }
    setBulkAction("");
  };

  const toggleExpand = (fn: string) => {
    setExpandedInfo((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
  };

  // Spambot badge
  const spambotBadge = (status: string) => {
    switch (status) {
      case "ACTIVE": return <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"><CheckCircle className="h-3 w-3" />Clean</span>;
      case "TEMP_LIMITED": return <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"><AlertCircle className="h-3 w-3" />Temp Limited</span>;
      case "HARD_LIMITED": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"><XCircle className="h-3 w-3" />Hard Limited</span>;
      case "FROZEN": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"><XCircle className="h-3 w-3" />Frozen</span>;
      default: return <span className="inline-flex items-center gap-1 rounded bg-dark-700 px-1.5 py-0.5 text-[10px] font-medium text-dark-400">Unknown</span>;
    }
  };

  const validationBadge = (status: string) => {
    switch (status) {
      case "active": return <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"><CheckCircle className="h-3 w-3" />Valid</span>;
      case "dead": return <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"><XCircle className="h-3 w-3" />Dead</span>;
      case "error": return <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"><AlertCircle className="h-3 w-3" />Error</span>;
      default: return null;
    }
  };

  // Determine bucket for a session
  const getBucket = (s: any): string => s.status || s.bucket || "free";

  return (
    <div
      ref={dropRef}
      className={`space-y-6 animate-fade-in min-h-[60vh] ${dragging ? "ring-2 ring-accent ring-offset-2 ring-offset-dark-950 rounded-xl" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950/60 backdrop-blur-sm pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-dark-900/90 px-12 py-10 text-center">
            <Upload className="h-10 w-10 text-accent mx-auto mb-3" />
            <p className="text-lg font-bold text-dark-100">Drop .session or .zip files here</p>
            <p className="text-sm text-dark-400 mt-1">Files will be added to the free pool</p>
          </div>
        </div>
      )}

      {/* Pool overview */}
      {pool && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {[
            { label: "Free", val: pool.free, color: "text-success" },
            { label: "Dead", val: pool.dead, color: "text-danger" },
            { label: "Frozen", val: pool.frozen, color: "text-info" },
            { label: "Limited", val: pool.limited, color: "text-warning" },
            { label: "Unauth", val: pool.unauth, color: "text-dark-400" },
          ].map((item) => (
            <Card key={item.label} className="text-center !p-4">
              <p className={`text-xl font-bold ${item.color}`}>{item.val}</p>
              <p className="text-xs text-dark-500">{item.label}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input
              className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="Search sessions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="shrink-0">
            <input ref={fileRef} type="file" accept=".session,.zip" multiple className="hidden" onChange={handleFileInput} />
            <Button size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
              <Upload className="h-4 w-4" /> <span className="hidden sm:inline">Upload</span>
            </Button>
          </div>
        </div>

        {/* Status filters */}
        <div className="flex gap-1 rounded-lg bg-dark-800 p-0.5 overflow-x-auto">
          {["", "active", "free", "dead", "frozen", "limited", "unauth"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all whitespace-nowrap ${
                statusFilter === s ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
              }`}
            >
              {s || "All"}
            </button>
          ))}
        </div>

        {/* Bulk actions bar */}
        <div className="flex flex-wrap items-center gap-2 py-2 border-t border-dark-800">
          <span className="text-xs text-dark-500 mr-1">
            {selected.size > 0 ? `${selected.size} selected` : "Select sessions to run actions"}
          </span>
          <Button variant="secondary" size="sm" onClick={runInfo}
            loading={bulkAction === "info"} disabled={!!bulkAction || !selected.size}>
            <Eye className="h-3.5 w-3.5" /> Info
          </Button>
          <Button variant="secondary" size="sm" onClick={runValidate}
            loading={bulkAction === "validating"} disabled={!!bulkAction || !selected.size}>
            <ShieldCheck className="h-3.5 w-3.5" /> Validate
          </Button>
          <Button variant="secondary" size="sm" onClick={runSpambot}
            loading={bulkAction === "spambot"} disabled={!!bulkAction || !selected.size}>
            <Shield className="h-3.5 w-3.5" /> SpamBot
          </Button>
          <Button variant="secondary" size="sm"
            onClick={() => {
              const files = selectedFiles();
              if (!files.length) { toast.error("Select sessions first"); return; }
              const firstSession = sortedSessions.find((s: any) => selected.has(s.filename));
              const fromBucket = firstSession ? getBucket(firstSession) : "free";
              openMoveModal(files, fromBucket);
            }}
            disabled={!!bulkAction || !selected.size}>
            <ArrowRightLeft className="h-3.5 w-3.5" /> Move
          </Button>
          <Button variant="danger" size="sm" onClick={handleBulkDelete}
            loading={bulkAction === "deleting"} disabled={!!bulkAction || !selected.size}>
            <Trash2 className="h-3.5 w-3.5" /> Delete ({selected.size})
          </Button>
        </div>
      </div>

      {/* Bulk result summary */}
      {bulkResult && (
        <div className={`rounded-lg border p-3 text-sm flex items-center gap-3 flex-wrap ${
          bulkResult.type === "validate" && bulkResult.dead > 0
            ? "border-danger/30 bg-danger/5"
            : bulkResult.type === "spambot" && bulkResult.limited > 0
            ? "border-warning/30 bg-warning/5"
            : "border-success/30 bg-success/5"
        }`}>
          {bulkResult.type === "validate" && (
            <>
              <span className="font-medium text-dark-200">Validation Complete</span>
              <span className="text-success text-xs">{bulkResult.active} active</span>
              {bulkResult.dead > 0 && (
                <span className="text-danger text-xs">{bulkResult.dead} dead (moved to dead pool)</span>
              )}
            </>
          )}
          {bulkResult.type === "spambot" && (
            <>
              <span className="font-medium text-dark-200">SpamBot Check</span>
              <span className="text-success text-xs">{bulkResult.active} clean</span>
              {bulkResult.limited > 0 && <span className="text-warning text-xs">{bulkResult.limited} limited</span>}
              {bulkResult.frozen > 0 && <span className="text-danger text-xs">{bulkResult.frozen} frozen</span>}
              {((bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)) > 0 && (
                <span className="text-dark-400 text-xs">
                  ({(bulkResult.moved_limited?.length || 0) + (bulkResult.moved_frozen?.length || 0)} moved to pool)
                </span>
              )}
            </>
          )}
          {bulkResult.type === "info" && <span className="font-medium text-dark-200">Info loaded</span>}
          <button onClick={() => setBulkResult(null)} className="ml-auto text-dark-500 hover:text-dark-300 text-xs">dismiss</button>
        </div>
      )}

      {/* Sessions table */}
      {isLoading ? (
        <TableSkeleton rows={10} cols={5} />
      ) : (
        <div className="rounded-xl border border-dark-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-700 bg-dark-800/50">
                <th className="w-10 px-3 py-2.5">
                  <button onClick={selectAll} className="text-dark-400 hover:text-dark-200">
                    {selected.size === sortedSessions.length && sortedSessions.length > 0
                      ? <CheckSquare className="h-4 w-4 text-accent" />
                      : <Square className="h-4 w-4" />
                    }
                  </button>
                </th>
                <th className="w-8 px-1 py-2.5"></th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-dark-400 uppercase tracking-wider">Session</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-dark-400 uppercase tracking-wider">Status</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-dark-400 uppercase tracking-wider hidden sm:table-cell">Assigned To</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-dark-400 uppercase tracking-wider hidden md:table-cell">Info</th>
                <th className="text-right px-3 py-2.5 text-xs font-medium text-dark-400 uppercase tracking-wider w-24"></th>
              </tr>
            </thead>
            <tbody>
              {sortedSessions.length === 0 ? (
                <tr><td className="text-center py-12 text-dark-500" colSpan={7}>No sessions found</td></tr>
              ) : (
                sortedSessions.map((s: any) => {
                  const info = sessionInfoMap[s.filename];
                  const isExpanded = expandedInfo.has(s.filename);
                  const isSelected = selected.has(s.filename);
                  const isStarred = starred.has(s.filename);

                  return (
                    <tr key={s.filename} className={`border-b border-dark-800/50 transition-colors ${
                      isSelected ? "bg-accent/5" : isStarred ? "bg-amber-500/[0.03]" : "hover:bg-dark-800/30"
                    }`}>
                      {/* Checkbox */}
                      <td className="px-3 py-2.5 align-top">
                        <button onClick={() => toggleSelect(s.filename)} className="text-dark-400 hover:text-dark-200">
                          {isSelected
                            ? <CheckSquare className="h-4 w-4 text-accent" />
                            : <Square className="h-4 w-4" />
                          }
                        </button>
                      </td>

                      {/* Star */}
                      <td className="px-1 py-2.5 align-top">
                        <button
                          onClick={() => toggleStar(s.filename)}
                          className={`p-0.5 rounded transition-colors ${
                            isStarred ? "text-amber-400 hover:text-amber-300" : "text-dark-700 hover:text-dark-400"
                          }`}
                          title={isStarred ? "Unstar session" : "Star session"}
                        >
                          <Star className={`h-3.5 w-3.5 ${isStarred ? "fill-current" : ""}`} />
                        </button>
                      </td>

                      {/* Filename + expand */}
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex items-center gap-2">
                          {info && (
                            <button onClick={() => toggleExpand(s.filename)} className="text-dark-500 hover:text-dark-300 shrink-0">
                              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          )}
                          <span className="font-mono text-xs text-dark-200 truncate">{s.filename}</span>
                        </div>
                        {/* Expanded info */}
                        {info && isExpanded && (
                          <div className="mt-2 ml-5 rounded-lg bg-dark-800/60 border border-dark-700/50 p-3 space-y-2">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              {info.real_name && (
                                <div className="flex items-center gap-1.5">
                                  <span className="text-dark-500">Name:</span>
                                  <span className="text-dark-200 font-medium">{info.real_name}</span>
                                  {info.premium && <span title="Premium"><Crown className="h-3 w-3 text-warning" /></span>}
                                  {info.restricted && <span title="Restricted"><Ban className="h-3 w-3 text-danger" /></span>}
                                </div>
                              )}
                              {info.user_id && (
                                <div className="flex items-center gap-1.5">
                                  <Hash className="h-3 w-3 text-dark-600" />
                                  <span className="font-mono text-dark-300">{info.user_id}</span>
                                </div>
                              )}
                              {info.username && (
                                <div className="flex items-center gap-1.5">
                                  <AtSign className="h-3 w-3 text-dark-600" />
                                  <span className="text-accent">@{info.username}</span>
                                </div>
                              )}
                              {info.phone && (
                                <div className="flex items-center gap-1.5">
                                  <Phone className="h-3 w-3 text-dark-600" />
                                  <span className="font-mono text-dark-400">{info.phone}</span>
                                </div>
                              )}
                            </div>
                            {info.bio && (
                              <div className="flex items-center gap-1.5 text-xs">
                                <FileText className="h-3 w-3 text-dark-600 shrink-0" />
                                <span className="text-dark-400">{info.bio}</span>
                              </div>
                            )}
                            {(info.reason || info.error) && (
                              <div className="rounded bg-danger/10 px-2 py-1 text-xs text-danger">
                                {info.reason || info.error}
                              </div>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Status badges */}
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-wrap gap-1">
                          <Badge status={s.status || s.bucket || "unknown"} />
                          {info?.status && validationBadge(info.status)}
                          {info?.spambot_status && spambotBadge(info.spambot_status)}
                        </div>
                      </td>

                      {/* Assigned to */}
                      <td className="px-3 py-2.5 align-top hidden sm:table-cell">
                        {s.bot_name ? (
                          <span className="text-xs text-dark-200">{s.bot_name}</span>
                        ) : (
                          <span className="text-xs text-dark-600">—</span>
                        )}
                      </td>

                      {/* Quick info */}
                      <td className="px-3 py-2.5 align-top hidden md:table-cell">
                        {info?.real_name ? (
                          <span className="text-xs text-dark-300">{info.real_name}</span>
                        ) : info?.user_id ? (
                          <span className="text-xs text-dark-400 font-mono">{info.user_id}</span>
                        ) : (
                          <span className="text-xs text-dark-600">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5 align-top text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/admin/sessions/${encodeURIComponent(s.filename)}`}
                            target="_blank"
                            className="text-dark-500 hover:text-emerald-400 transition-colors p-1"
                            title="Open as Telegram client"
                            onMouseEnter={() => {
                              // Pre-warm: connects + caches profile+chats on hover
                              api.get(`/api/session-client/${encodeURIComponent(s.filename)}/init`).catch(() => {});
                            }}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            onClick={() => openMoveModal([s.filename], getBucket(s))}
                            className="text-dark-500 hover:text-accent transition-colors p-1"
                            title="Move to another pool"
                          >
                            <MoveRight className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(s.filename)}
                            className="text-dark-500 hover:text-danger transition-colors p-1"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Session"
        message={`Delete session file "${deleteTarget}"? This cannot be undone.`}
        confirmText="Delete"
      />

      {/* Move modal */}
      {moveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-dark-700 bg-dark-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-dark-100 mb-1">Move Session{moveTarget.files.length > 1 ? "s" : ""}</h3>
            <p className="text-sm text-dark-400 mb-5">
              {moveTarget.files.length === 1
                ? <span className="font-mono text-xs">{moveTarget.files[0]}</span>
                : `${moveTarget.files.length} sessions selected`
              }
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-dark-400 uppercase tracking-wider">From</label>
                <div className="mt-1.5 flex gap-2 flex-wrap">
                  {BUCKETS.map((b) => (
                    <button
                      key={b}
                      onClick={() => setMoveTarget({ ...moveTarget, fromBucket: b })}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        moveTarget.fromBucket === b
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-dark-700 text-dark-400 hover:border-dark-500"
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                  <button
                    onClick={() => setMoveTarget({ ...moveTarget, fromBucket: "assigned" })}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                      moveTarget.fromBucket === "assigned"
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-dark-700 text-dark-400 hover:border-dark-500"
                    }`}
                  >
                    assigned
                  </button>
                </div>
              </div>

              <div className="flex justify-center">
                <MoveRight className="h-5 w-5 text-dark-600" />
              </div>

              <div>
                <label className="text-xs font-medium text-dark-400 uppercase tracking-wider">To</label>
                <div className="mt-1.5 flex gap-2 flex-wrap">
                  {BUCKETS.map((b) => (
                    <button
                      key={b}
                      onClick={() => setMoveToBucket(b)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        moveToBucket === b
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                          : "border-dark-700 text-dark-400 hover:border-dark-500"
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <Button variant="secondary" size="sm" onClick={() => setMoveTarget(null)}>Cancel</Button>
              <Button size="sm" onClick={handleMove} loading={moving}
                disabled={moveTarget.fromBucket === moveToBucket}>
                <MoveRight className="h-4 w-4" /> Move to {moveToBucket}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
