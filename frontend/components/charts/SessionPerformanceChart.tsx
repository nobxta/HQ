import { BarChart2 } from "lucide-react";
import { ChartCard } from "./ChartCard";
import { ChartEmptyState } from "./ChartEmptyState";
import { type AnalyticsData } from "@/lib/hooks/useAdbotAnalytics";
import Link from "next/link";

export function SessionPerformanceChart({ 
  sessions, 
  onViewAll 
}: { 
  sessions: AnalyticsData["sessions"];
  onViewAll: () => void;
}) {
  const topSessions = sessions.slice(0, 6);
  const hasData = topSessions.length > 0;

  // Calculate the max total (sent + failed) to scale bars
  const maxTotal = hasData ? Math.max(...topSessions.map(s => s.sent + s.failed)) : 0;

  return (
    <ChartCard 
      title="Session performance" 
      subtitle="Messages sent and failed by account"
      action={
        sessions.length > 6 ? (
          <button onClick={onViewAll} className="text-[12px] text-[#7C5CFF] hover:text-[#9B7FFF] font-medium transition-colors">
            View all sessions
          </button>
        ) : undefined
      }
    >
      {!hasData ? (
        <ChartEmptyState title="No session data yet" hint="Assign sessions to see performance." icon={BarChart2} />
      ) : (
        <div className="flex flex-col gap-3.5 mt-2">
          {topSessions.map((s, i) => {
            const total = s.sent + s.failed;
            const sentPct = maxTotal > 0 ? (s.sent / maxTotal) * 100 : 0;
            const failedPct = maxTotal > 0 ? (s.failed / maxTotal) * 100 : 0;
            
            return (
              <div key={i} className="flex items-center gap-3 fade-in" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="w-[110px] sm:w-[140px] shrink-0 truncate">
                  <p className="text-[13px] text-hq-text font-medium truncate">{s.displayName}</p>
                  <p className="text-[11px] text-hq-muted font-mono truncate">{s.maskedAccount}</p>
                </div>
                
                <div className="flex-1 flex items-center h-4 rounded-full bg-hq-bg overflow-hidden border border-hq-border/30">
                  <div className="h-full bg-[#7C5CFF] transition-all duration-700" style={{ width: `${sentPct}%` }} />
                  <div className="h-full bg-[#EF4444] transition-all duration-700" style={{ width: `${failedPct}%` }} />
                </div>
                
                <div className="w-[45px] text-right shrink-0">
                  <p className="text-[12px] font-semibold" style={{ color: s.successRate !== null && s.successRate < 50 ? "#EF4444" : "#F4F7FB" }}>
                    {s.successRate !== null ? `${s.successRate}%` : "—"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}
