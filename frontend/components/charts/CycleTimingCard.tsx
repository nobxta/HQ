import { Timer } from "lucide-react";
import { type AnalyticsData } from "@/lib/hooks/useAdbotAnalytics";

export function CycleTimingCard({ cycle }: { cycle: AnalyticsData["cycle"] }) {
  if (cycle.status === "stopped" || (!cycle.lastCycleAt && !cycle.nextCycleAt)) {
    return null;
  }

  return (
    <div className="rounded-[16px] border border-[rgba(255,255,255,0.06)] bg-[#171722] p-4 transition-colors w-full mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Timer className="w-4 h-4 text-[#7C5CFF]" />
        <h3 className="text-[13px] font-semibold text-[#F4F7FB]">Cycle timing</h3>
      </div>
      
      <div className="relative flex items-center justify-between text-[11px] font-medium text-[#98A2B3] mb-1">
        <span>Last cycle</span>
        <span>Wait {cycle.gapSec}s</span>
        <span>Next cycle</span>
      </div>
      
      <div className="relative h-2 w-full rounded-full bg-[#111827] overflow-hidden my-2 border border-[rgba(255,255,255,0.05)]">
        <div className="absolute left-0 top-0 h-full w-[30%] bg-[#7C5CFF]/20 rounded-full" />
        <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[#7C5CFF] shadow-[0_0_8px_rgba(124,92,255,0.8)] animate-pulse" style={{ left: '50%' }} />
      </div>

      <div className="flex items-center justify-between text-[12px]">
        <span className="text-[#F4F7FB]">{cycle.lastCycleAt ? new Date(cycle.lastCycleAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—"}</span>
        <span className="text-[#F4F7FB]">{cycle.nextCycleAt ? new Date(cycle.nextCycleAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—"}</span>
      </div>
    </div>
  );
}
