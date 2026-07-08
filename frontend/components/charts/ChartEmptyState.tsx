import { AlertCircle } from "lucide-react";

export function ChartEmptyState({ title, hint, icon: Icon = AlertCircle }: { title: string; hint?: string; icon?: any }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
      <span className="w-10 h-10 rounded-[12px] bg-hq-elev border border-hq-border flex items-center justify-center mb-3">
        <Icon className="w-5 h-5 text-hq-muted" strokeWidth={1.75} />
      </span>
      <p className="text-[13px] text-hq-sub font-medium">{title}</p>
      {hint && <p className="text-[12px] text-hq-muted mt-1">{hint}</p>}
    </div>
  );
}
