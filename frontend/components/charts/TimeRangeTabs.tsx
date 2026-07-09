"use client";
import type { AnalyticsRange } from "@/lib/hooks/useAdbots";

const RANGES: Array<{ id: AnalyticsRange; label: string }> = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "lifetime", label: "Lifetime" },
];

export default function TimeRangeTabs({ value, onChange }: {
  value: AnalyticsRange;
  onChange: (r: AnalyticsRange) => void;
}) {
  return (
    <div className="flex items-center rounded-[10px] border border-hq-border bg-hq-bg p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.id}
          onClick={() => onChange(r.id)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded-[8px] transition-colors ${
            value === r.id ? "bg-hq-elev text-hq-text border border-hq-border" : "border border-transparent text-hq-muted hover:text-hq-sub"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
