import { PieChart as PieChartIcon } from "lucide-react";
import { ChartCard } from "./ChartCard";
import { type AnalyticsData } from "@/lib/hooks/useAdbotAnalytics";

export function DeliveryBreakdownCard({ delivery }: { delivery: AnalyticsData["delivery"] }) {
  const total = delivery.sent + delivery.failed;
  
  if (total === 0) {
    return (
      <ChartCard title="Delivery breakdown">
        <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
          <PieChartIcon className="w-5 h-5 text-[#98A2B3] mb-2" />
          <p className="text-[13px] text-[#98A2B3] font-medium">No posts delivered yet</p>
        </div>
      </ChartCard>
    );
  }

  const successPct = delivery.successRate ?? 0;
  const failPct = 100 - successPct;
  
  return (
    <ChartCard title="Delivery breakdown">
      <div className="flex flex-col h-full justify-center space-y-4 fade-in">
        <div className="flex flex-col">
          <span className="text-[28px] font-semibold text-[#F4F7FB] tabular-nums leading-none mb-1">
            {successPct}% <span className="text-[14px] text-[#98A2B3] font-normal">success rate</span>
          </span>
        </div>
        
        <div className="space-y-2.5">
          <div className="flex justify-between items-center text-[13px]">
            <span className="text-[#98A2B3] flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#7C5CFF]" /> Sent</span>
            <span className="font-semibold text-[#F4F7FB]">{delivery.sent.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center text-[13px]">
            <span className="text-[#98A2B3] flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#EF4444]" /> Failed</span>
            <span className="font-semibold text-[#F4F7FB]">{delivery.failed.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center text-[13px]">
            <span className="text-[#98A2B3] flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#F59E0B]" /> Failure rate</span>
            <span className="font-semibold text-[#F4F7FB]">{delivery.failureRate ?? 0}%</span>
          </div>
        </div>

        <div className="mt-2 h-1.5 w-full rounded-full bg-[#111827] overflow-hidden flex">
          <div className="h-full bg-[#7C5CFF] transition-all duration-700" style={{ width: `${successPct}%` }} />
          <div className="h-full bg-[#EF4444] transition-all duration-700" style={{ width: `${failPct}%` }} />
        </div>
      </div>
    </ChartCard>
  );
}
