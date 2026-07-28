"use client";
import { Smartphone } from "lucide-react";
import ChartEmptyState from "./ChartEmptyState";

const STATUS_DOT: Record<string, string> = {
  running: "#22C55E",
  active: "#22C55E",
  paused: "#F59E0B",
  warning: "#F59E0B",
  floodwait: "#F59E0B",
  disabled: "#667085",
  stopped: "#667085",
  dead: "#EF4444",
};

export interface SessionPerfRow {
  file: string;
  displayName: string;
  maskedId: string;
  status: string;
  sent: number;
  failed: number;
  successRate: number | null;
  lastUsed?: number | null;
}

export function maskAccount(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return `•••${digits.slice(-4)}`;
  return value;
}

function relativeTime(timestamp?: number | null): string {
  if (!timestamp) return "Not tracked";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SessionPerformanceChart({ rows, loading, onViewAll, totalCount }: {
  rows: SessionPerfRow[];
  loading: boolean;
  onViewAll: () => void;
  totalCount: number;
}) {
  if (loading && rows.length === 0) {
    return <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded-[10px] bg-white/[0.04]" />)}</div>;
  }
  if (rows.length === 0) {
    return <ChartEmptyState icon={Smartphone} title="No sessions assigned" hint="Assign accounts from the Sessions tab." height={180} />;
  }

  const top = rows.slice(0, 6);
  return (
    <div>
      <div className="hidden min-w-[520px] sm:block">
        <div className="grid grid-cols-[minmax(130px,1.4fr)_72px_64px_106px_82px_76px] gap-2 border-b border-hq-border pb-2 text-[10px] font-semibold uppercase tracking-wide text-hq-muted">
          <span>Session</span><span className="text-right">Delivered</span><span className="text-right">Failed</span><span>Rate</span><span>Status</span><span className="text-right">Last used</span>
        </div>
        {top.map((row) => {
          const total = row.sent + row.failed;
          const rateColor = row.successRate === null ? "#667085" : row.successRate >= 80 ? "#22C55E" : row.successRate >= 50 ? "#F59E0B" : "#EF4444";
          return (
            <div key={row.file} className="grid grid-cols-[minmax(130px,1.4fr)_72px_64px_106px_82px_76px] items-center gap-2 border-b border-hq-border/50 py-2.5 text-[12px] last:border-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_DOT[row.status] || "#667085" }} />
                <span className="truncate font-medium text-hq-text">{row.displayName}</span>
              </span>
              <span className="text-right tabular-nums text-hq-text">{row.sent.toLocaleString()}</span>
              <span className="text-right tabular-nums text-hq-sub">{row.failed.toLocaleString()}</span>
              <span className="flex items-center gap-2">
                <span className="w-10 text-right font-semibold tabular-nums" style={{ color: rateColor }}>{total > 0 && row.successRate !== null ? `${row.successRate}%` : "—"}</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-hq-bg"><span className="block h-full rounded-full" style={{ width: `${row.successRate || 0}%`, background: rateColor }} /></span>
              </span>
              <span className="inline-flex w-fit items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-1 capitalize text-hq-sub">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_DOT[row.status] || "#667085" }} />{row.status}
              </span>
              <span className="text-right text-[11px] text-hq-muted">{relativeTime(row.lastUsed)}</span>
            </div>
          );
        })}
      </div>

      <div className="space-y-3 sm:hidden">
        {top.map((row) => (
          <div key={row.file} className="rounded-[10px] border border-hq-border bg-hq-bg p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[13px] font-medium text-hq-text">{row.displayName}</span>
              <span className="text-[12px] font-semibold tabular-nums text-hq-success">{row.successRate == null ? "—" : `${row.successRate}%`}</span>
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-hq-muted">
              <span>{row.sent.toLocaleString()} delivered · {row.failed.toLocaleString()} failed</span>
              <span>{relativeTime(row.lastUsed)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end border-t border-hq-border/50 pt-3">
        {totalCount > top.length && <button onClick={onViewAll} className="text-[12px] text-hq-accent hover:underline">View all {totalCount} sessions</button>}
      </div>
    </div>
  );
}
