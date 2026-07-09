"use client";
import { Smartphone } from "lucide-react";
import ChartEmptyState from "./ChartEmptyState";

const STATUS_DOT: Record<string, string> = {
  running: "#22C55E",
  paused: "#F59E0B",
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
}

/* Mask a phone/account id down to its last 4 digits. */
export function maskAccount(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 7) return `•••${digits.slice(-4)}`;
  return s;
}

export default function SessionPerformanceChart({ rows, loading, onViewAll, totalCount }: {
  rows: SessionPerfRow[];
  loading: boolean;
  onViewAll: () => void;
  totalCount: number;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded-[10px] bg-white/[0.04]" />)}
      </div>
    );
  }
  if (rows.length === 0) {
    return <ChartEmptyState icon={Smartphone} title="No sessions assigned" hint="Assign accounts from the Sessions tab." height={180} />;
  }

  const top = rows.slice(0, 6);
  const max = Math.max(...top.map((r) => r.sent + r.failed), 1);

  return (
    <div>
      <div className="space-y-3.5">
        {top.map((r) => {
          const total = r.sent + r.failed;
          const sentPct = (r.sent / max) * 100;
          const failedPct = (r.failed / max) * 100;
          const rateColor = r.successRate === null ? "#667085" : r.successRate >= 80 ? "#22C55E" : r.successRate >= 50 ? "#F59E0B" : "#EF4444";
          return (
            <div key={r.file} className="flex items-center gap-3">
              <div className="w-32 sm:w-40 shrink-0 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT[r.status] || "#667085" }} />
                  <span className="text-[13px] text-hq-text font-medium truncate">{r.displayName}</span>
                </div>
                {r.maskedId && <p className="text-[11px] text-hq-muted font-mono truncate pl-3">{r.maskedId}</p>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex h-2 rounded-full bg-hq-bg overflow-hidden" title={`${r.sent.toLocaleString()} sent · ${r.failed.toLocaleString()} failed`}>
                  <div className="h-full rounded-l-full transition-[width] duration-500 ease-out" style={{ width: `${sentPct}%`, background: "#7C5CFF" }} />
                  <div className="h-full transition-[width] duration-500 ease-out" style={{ width: `${failedPct}%`, background: "#EF4444" }} />
                </div>
              </div>
              <span className="w-12 text-right text-[12px] font-semibold tabular-nums shrink-0" style={{ color: rateColor }}>
                {total > 0 && r.successRate !== null ? `${r.successRate}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-hq-border/50">
        <div className="flex items-center gap-4 text-[11px] text-hq-muted">
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-[3px]" style={{ background: "#7C5CFF" }} />Sent</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-[3px]" style={{ background: "#EF4444" }} />Failed</span>
        </div>
        {totalCount > top.length && (
          <button onClick={onViewAll} className="text-[12px] text-hq-accent hover:underline">
            View all {totalCount} sessions
          </button>
        )}
      </div>
    </div>
  );
}
