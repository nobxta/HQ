import { type TimeRange } from "@/lib/hooks/useAdbotAnalytics";

export function TimeRangeTabs({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const tabs: { value: TimeRange; label: string }[] = [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "lifetime", label: "Lifetime" },
  ];

  return (
    <div className="flex items-center rounded-[10px] bg-hq-bg p-1 border border-hq-border">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded-[7px] transition-colors ${
            value === t.value
              ? "bg-hq-elev text-hq-text shadow-sm"
              : "text-hq-muted hover:text-hq-sub hover:bg-hq-elev/50"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
