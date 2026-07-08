import { AlertTriangle } from "lucide-react";
import { ChartCard } from "./ChartCard";
import { type AnalyticsData } from "@/lib/hooks/useAdbotAnalytics";

export function FailureReasonsChart({ reasons }: { reasons: AnalyticsData["failureReasons"] }) {
  if (reasons.length === 0) {
    return (
      <ChartCard title="Failure reasons">
        <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
          <AlertTriangle className="w-5 h-5 text-[#98A2B3] mb-2" />
          <p className="text-[13px] text-[#98A2B3] font-medium">No active failure pattern</p>
        </div>
      </ChartCard>
    );
  }

  const maxCount = Math.max(...reasons.map(r => r.count));

  return (
    <ChartCard title="Failure reasons">
      <div className="flex flex-col gap-3 mt-2">
        {reasons.slice(0, 4).map((r, i) => (
          <div key={i} className="flex flex-col gap-1 fade-in" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex justify-between items-center text-[12px]">
              <span className="text-[#F4F7FB] font-medium truncate pr-2">{r.reason}</span>
              <span className="text-[#98A2B3] tabular-nums shrink-0">{r.count.toLocaleString()}</span>
            </div>
            <div className="h-1 w-full rounded-full bg-[#111827] overflow-hidden border border-[rgba(255,255,255,0.05)]">
              <div 
                className="h-full transition-all duration-700" 
                style={{ 
                  width: `${(r.count / maxCount) * 100}%`,
                  background: r.reason === "FloodWait" ? "#F59E0B" : "#EF4444"
                }} 
              />
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
