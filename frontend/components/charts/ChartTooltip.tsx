"use client";

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

/* Compact custom tooltip used by every Recharts chart on the Overview.
   Renders a muted header line plus dot-prefixed value rows. */
export default function ChartTooltip({ header, rows }: { header: string; rows: TooltipRow[] }) {
  return (
    <div
      className="rounded-[10px] text-[12px] leading-relaxed shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      style={{ background: "#111827", border: "1px solid #293244", padding: "10px 12px" }}
    >
      <p className="text-[11px] mb-1.5" style={{ color: "#98A2B3" }}>{header}</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.color || "#667085" }} />
          <span style={{ color: "#98A2B3" }}>{r.label}:</span>
          <span className="font-medium tabular-nums" style={{ color: "#F4F7FB" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
