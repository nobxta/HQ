"use client";
import { Send } from "lucide-react";
import ChartEmptyState from "./ChartEmptyState";

/* Compact delivery summary for the selected range — replaces the old donut. */
export default function DeliveryBreakdownCard({ sent, failed, loading }: {
  sent: number;
  failed: number;
  loading: boolean;
}) {
  const total = sent + failed;
  if (loading && total === 0) {
    return <div className="h-[150px] animate-pulse rounded-[12px] bg-white/[0.04]" />;
  }
  if (total === 0) {
    return <ChartEmptyState icon={Send} title="No deliveries in this range" hint="Counters appear once posts go out." height={150} />;
  }

  const successRate = Math.round((sent / total) * 1000) / 10;
  const failureRate = Math.round((failed / total) * 1000) / 10;
  const rateColor = successRate >= 80 ? "#22C55E" : successRate >= 50 ? "#F59E0B" : "#EF4444";

  return (
    <div>
      <p className="text-[26px] font-semibold leading-none tabular-nums" style={{ color: rateColor }}>
        {successRate}%
      </p>
      <p className="text-[11px] text-hq-muted mt-1">success rate</p>

      <div className="mt-4 space-y-2">
        {([
          ["Sent", sent.toLocaleString(), "#7C5CFF"],
          ["Failed", failed.toLocaleString(), "#EF4444"],
          ["Failure rate", `${failureRate}%`, "#F59E0B"],
        ] as [string, string, string][]).map(([label, value, color]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[12px] text-hq-muted">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
            <span className="text-[13px] font-medium text-hq-text tabular-nums">{value}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex h-1.5 rounded-full bg-hq-bg overflow-hidden">
        <div className="h-full transition-[width] duration-500 ease-out" style={{ width: `${(sent / total) * 100}%`, background: "#22C55E" }} />
        <div className="h-full transition-[width] duration-500 ease-out" style={{ width: `${(failed / total) * 100}%`, background: "#EF4444" }} />
      </div>
    </div>
  );
}
