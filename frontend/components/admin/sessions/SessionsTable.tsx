"use client";
import { CheckSquare, Square, Star } from "lucide-react";
import Link from "next/link";
import type { SessionOverviewItem } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { HealthBadge, LocationBadge, StatusPill, Avatar, Copyable, accountName, HEALTH_META } from "./shared";
import SessionActionsMenu, { type SessionActions } from "./SessionActionsMenu";
import { COLUMNS, type ColumnKey, type Density } from "./columns";

interface Props {
  sessions: SessionOverviewItem[];
  visible: Record<ColumnKey, boolean>;
  density: Density;
  selected: Set<string>;
  validating: Set<string>;
  recentlyUpdated: Set<string>;
  openFilename: string | null;
  actions: SessionActions;
  onToggleSelect: (filename: string, shiftKey: boolean) => void;
  onSelectAll: () => void;
  onRowClick: (s: SessionOverviewItem) => void;
}

function lastChecked(s: SessionOverviewItem, now: number): { text: string; sub: string; tone: string } {
  if (!s.last_validated_at) return { text: "Never checked", sub: "", tone: "text-dark-500" };
  const ago = timeAgo(now - s.last_validated_at);
  const valid = s.validation_status === "valid";
  return {
    text: ago,
    sub: valid ? "Healthy" : (s.validation_status || "checked"),
    tone: valid ? "text-emerald-400" : "text-amber-400",
  };
}

function activityText(s: SessionOverviewItem, now: number): { primary: string; sub: string } {
  if (!s.last_active_at && !s.sent && !s.failed) return { primary: "Never used", sub: "" };
  const primary = s.last_active_at ? timeAgo(now - s.last_active_at) : "—";
  const sub = s.success_rate != null ? `${s.success_rate}% · ${s.sent}/${s.sent + s.failed}` : `${s.sent} sent`;
  return { primary, sub };
}

export default function SessionsTable(p: Props) {
  const { sessions, visible, density, selected } = p;
  const now = Date.now() / 1000;
  const pad = density === "compact" ? "py-2" : "py-3";
  const allChecked = sessions.length > 0 && sessions.every((s) => selected.has(s.filename));

  return (
    <>
      {/* Desktop / tablet table */}
      <div className="hidden md:block rounded-xl border border-dark-700/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-dark-850">
              <tr className="border-b border-dark-700 text-left">
                <th className="w-10 px-3 py-2.5">
                  <button onClick={p.onSelectAll} aria-label="Select all" className="text-dark-400 hover:text-dark-200">
                    {allChecked ? <CheckSquare className="h-4 w-4 text-accent" /> : <Square className="h-4 w-4" />}
                  </button>
                </th>
                <th className="w-8 px-1 py-2.5" />
                {COLUMNS.filter((c) => visible[c.key]).map((c) => (
                  <th key={c.key} className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-dark-500 whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-2.5 w-24 text-right text-[11px] font-semibold uppercase tracking-wider text-dark-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={12} className="text-center py-14 text-dark-500">No sessions</td></tr>
              ) : sessions.map((s) => {
                const sel = selected.has(s.filename);
                const open = p.openFilename === s.filename;
                const updated = p.recentlyUpdated.has(s.filename);
                const chk = lastChecked(s, now);
                const act = activityText(s, now);
                return (
                  <tr
                    key={s.filename}
                    onClick={() => p.onRowClick(s)}
                    className={`border-b border-dark-800/60 cursor-pointer transition-colors
                      ${open ? "bg-accent/10" : sel ? "bg-accent/5" : "hover:bg-dark-800/40"}
                      ${updated ? "animate-[fadeIn_0.8s_ease-out] bg-accent/5" : ""}`}
                  >
                    <td className={`px-3 ${pad} align-middle`} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => p.onToggleSelect(s.filename, (e as React.MouseEvent).shiftKey)}
                        aria-label={`Select ${s.filename}`}
                        className="text-dark-400 hover:text-dark-200"
                      >
                        {sel ? <CheckSquare className="h-4 w-4 text-accent" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className={`px-1 ${pad} align-middle`} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => p.actions.onStar(s)}
                        aria-label={s.starred ? "Unstar" : "Star"}
                        className={`p-0.5 rounded transition-colors ${s.starred ? "text-amber-400" : "text-dark-700 hover:text-dark-400"}`}
                      >
                        <Star className={`h-3.5 w-3.5 ${s.starred ? "fill-current" : ""}`} />
                      </button>
                    </td>

                    {visible.account && (
                      <td className={`px-3 ${pad} align-middle`}>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={accountName(s)} id={s.user_id} size={density === "compact" ? 28 : 34} />
                          <div className="min-w-0">
                            <p className="text-dark-100 font-medium truncate max-w-[160px]">{accountName(s)}</p>
                            <p className="text-[11px] text-dark-500 font-mono truncate">
                              {s.user_id ? `ID ${s.user_id}` : (s.username ? `@${s.username}` : "—")}
                            </p>
                          </div>
                        </div>
                      </td>
                    )}
                    {visible.file && (
                      <td className={`px-3 ${pad} align-middle`} onClick={(e) => e.stopPropagation()}>
                        <Copyable value={s.filename} className="text-[12px] text-dark-300 max-w-[170px]" label="session file" />
                      </td>
                    )}
                    {visible.health && (
                      <td className={`px-3 ${pad} align-middle`}>
                        <HealthBadge health={s.health} validating={p.validating.has(s.filename)} />
                      </td>
                    )}
                    {visible.location && (
                      <td className={`px-3 ${pad} align-middle`}><LocationBadge pool={s.pool} /></td>
                    )}
                    {visible.assigned && (
                      <td className={`px-3 ${pad} align-middle`} onClick={(e) => e.stopPropagation()}>
                        {s.bot_name ? (
                          <Link href={`/admin/adbots/${encodeURIComponent(s.bot_name)}`} className="group inline-flex flex-col">
                            <span className="text-dark-100 group-hover:text-accent transition-colors truncate max-w-[130px]">{s.bot_name}</span>
                            <span className="text-[11px] text-dark-500">{s.bot_plan || s.bot_state || ""}</span>
                          </Link>
                        ) : <span className="text-dark-600">—</span>}
                      </td>
                    )}
                    {visible.runtime && (
                      <td className={`px-3 ${pad} align-middle`}>
                        {s.bot_name ? <StatusPill status={s.derived_status} /> : <span className="text-xs text-dark-600">Not assigned</span>}
                        {s.pause_remaining_sec != null && (
                          <span className="ml-1 text-[10px] text-amber-400">{Math.ceil(s.pause_remaining_sec / 60)}m</span>
                        )}
                      </td>
                    )}
                    {visible.last_checked && (
                      <td className={`px-3 ${pad} align-middle`}>
                        <div className="leading-tight">
                          <p className="text-xs text-dark-300">{chk.text}</p>
                          {chk.sub && <p className={`text-[11px] ${chk.tone}`}>{chk.sub}</p>}
                        </div>
                      </td>
                    )}
                    {visible.activity && (
                      <td className={`px-3 ${pad} align-middle`}>
                        <div className="leading-tight">
                          <p className="text-xs text-dark-300 tabular-nums">{act.primary}</p>
                          {act.sub && <p className="text-[11px] text-dark-500 tabular-nums">{act.sub}</p>}
                        </div>
                      </td>
                    )}
                    <td className={`px-3 ${pad} align-middle text-right`} onClick={(e) => e.stopPropagation()}>
                      <SessionActionsMenu session={s} actions={p.actions} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {sessions.length === 0 ? (
          <p className="text-center py-12 text-dark-500 text-sm">No sessions</p>
        ) : sessions.map((s) => {
          const sel = selected.has(s.filename);
          const chk = lastChecked(s, now);
          return (
            <div
              key={s.filename}
              onClick={() => p.onRowClick(s)}
              className={`rounded-xl border p-3 ${sel ? "border-accent/50 bg-accent/5" : "border-dark-700/60 bg-dark-850"}`}
            >
              <div className="flex items-start gap-2.5">
                <button onClick={(e) => { e.stopPropagation(); p.onToggleSelect(s.filename, false); }} aria-label="Select" className="mt-0.5 text-dark-400">
                  {sel ? <CheckSquare className="h-4 w-4 text-accent" /> : <Square className="h-4 w-4" />}
                </button>
                <Avatar name={accountName(s)} id={s.user_id} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-dark-100 font-medium truncate">{accountName(s)}</p>
                    {s.starred && <Star className="h-3 w-3 fill-current text-amber-400 shrink-0" />}
                  </div>
                  <p className="text-[11px] text-dark-500 font-mono truncate">{s.filename}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${HEALTH_META[s.health].dot}`} />
                    <HealthBadge health={s.health} validating={p.validating.has(s.filename)} />
                    <LocationBadge pool={s.pool} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-dark-500">
                    <span>{s.bot_name || "Unassigned"}</span>
                    <span>{chk.text}</span>
                  </div>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <SessionActionsMenu session={s} actions={p.actions} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
