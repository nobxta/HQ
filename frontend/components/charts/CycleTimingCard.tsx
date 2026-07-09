"use client";
import { Timer } from "lucide-react";
import ChartEmptyState from "./ChartEmptyState";

function relTime(ts: number): string {
  const secs = Math.floor(Date.now() / 1000 - ts);
  if (secs < 0) return `in ${fmtDur(-secs)}`;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtDur(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 360) / 10}h`;
}

/* Slim operational timeline: last cycle → current wait → estimated next cycle. */
export default function CycleTimingCard({ lastCycleTs, cycleSec, gapSec, avgDurationSec, running }: {
  lastCycleTs: number;
  cycleSec: number;
  gapSec: number;
  avgDurationSec: number | null;
  running: boolean;
}) {
  if (!lastCycleTs) {
    return <ChartEmptyState icon={Timer} title="No cycles recorded yet" hint="Timing appears after the first posting cycle." height={140} />;
  }

  const now = Date.now() / 1000;
  const nextTs = lastCycleTs + cycleSec;
  const progress = cycleSec > 0 ? Math.min(Math.max((now - lastCycleTs) / cycleSec, 0), 1) : 0;
  const overdue = running && now > nextTs + cycleSec * 0.5;

  return (
    <div>
      {/* Timeline bar */}
      <div className="flex items-center justify-between text-[11px] text-hq-muted mb-1.5">
        <span>Last cycle</span>
        <span>{running ? "Next (est.)" : "Stopped"}</span>
      </div>
      <div className="h-1.5 rounded-full bg-hq-bg overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${progress * 100}%`, background: overdue ? "#F59E0B" : running ? "#7C5CFF" : "#667085" }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px] mt-1.5">
        <span className="text-hq-sub tabular-nums">{relTime(lastCycleTs)}</span>
        <span className="tabular-nums" style={{ color: overdue ? "#F59E0B" : "#98A2B3" }}>
          {running ? (now >= nextTs ? "due now" : relTime(nextTs)) : "—"}
        </span>
      </div>
      {overdue && <p className="text-[11px] mt-1" style={{ color: "#F59E0B" }}>Cycle overdue — check worker health</p>}

      <div className="mt-4 pt-3 border-t border-hq-border/50 grid grid-cols-3 gap-2">
        {([
          ["Cycle", cycleSec > 0 ? fmtDur(cycleSec) : "Not set"],
          ["Gap", gapSec > 0 ? `${gapSec}s` : "Not set"],
          ["Avg duration", avgDurationSec && avgDurationSec > 0 ? fmtDur(avgDurationSec) : "No data yet"],
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-hq-muted truncate">{k}</p>
            <p className="text-[13px] font-medium text-hq-text tabular-nums mt-0.5 truncate">{v}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
