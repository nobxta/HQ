"use client";
import { BarChart3 } from "lucide-react";

export default function ChartEmptyState({ title, hint, height = 220, icon: Icon = BarChart3 }: {
  title: string;
  hint?: string;
  height?: number;
  icon?: any;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-4" style={{ height }}>
      <span className="w-9 h-9 rounded-[10px] bg-hq-elev border border-hq-border flex items-center justify-center mb-2.5">
        <Icon className="w-4 h-4 text-hq-muted" strokeWidth={1.75} />
      </span>
      <p className="text-[13px] text-hq-sub font-medium">{title}</p>
      {hint && <p className="text-[12px] text-hq-muted mt-1">{hint}</p>}
    </div>
  );
}
