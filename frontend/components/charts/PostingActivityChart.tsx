import { useState } from "react";
import { ResponsiveContainer, ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { Activity } from "lucide-react";
import { ChartCard } from "./ChartCard";
import { ChartEmptyState } from "./ChartEmptyState";
import { ChartTooltip } from "./ChartTooltip";
import { TimeRangeTabs } from "./TimeRangeTabs";
import { type TimeRange, type AnalyticsData } from "@/lib/hooks/useAdbotAnalytics";

export function PostingActivityChart({ 
  timeline, 
  range, 
  onRangeChange 
}: { 
  timeline: AnalyticsData["timeline"];
  range: TimeRange;
  onRangeChange: (v: TimeRange) => void;
}) {
  const hasData = timeline && timeline.length > 0 && timeline.some(t => t.sent > 0 || t.failed > 0 || t.flood > 0);

  return (
    <ChartCard 
      title="Posting activity" 
      subtitle="Sent, failed, and limited posts over time"
      action={<TimeRangeTabs value={range} onChange={onRangeChange} />}
      className="h-[300px] max-h-[300px] sm:h-[320px] sm:max-h-[320px]"
    >
      {!hasData ? (
        <ChartEmptyState title="No posting activity yet" hint="Start the bot to generate analytics." icon={Activity} />
      ) : (
        <div className="w-full h-full -ml-4 mt-2 fade-in">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={timeline} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#7C5CFF" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#7C5CFF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#2A3040" vertical={false} strokeDasharray="3 3" />
              <XAxis 
                dataKey="bucket" 
                stroke="#667085" 
                fontSize={11} 
                tickLine={false} 
                axisLine={false} 
                tickMargin={10}
                tickFormatter={(val) => {
                  if (range === "24h") return val.slice(11, 16); // just HH:MM
                  return val.slice(5, 10).replace("-", "/"); // MM/DD
                }}
              />
              <YAxis 
                stroke="#667085" 
                fontSize={11} 
                tickLine={false} 
                axisLine={false} 
                tickMargin={10}
                allowDecimals={false}
              />
              <Tooltip content={<ChartTooltip showSuccessRate />} cursor={{ fill: "rgba(255,255,255,0.02)" }} />
              
              <Bar dataKey="limited" name="Limited" stackId="a" fill="#F59E0B" maxBarSize={12} radius={[0, 0, 0, 0]} />
              <Bar dataKey="failed" name="Failed" stackId="a" fill="#EF4444" maxBarSize={12} radius={[4, 4, 0, 0]} />
              <Area type="monotone" dataKey="sent" name="Sent" stroke="#7C5CFF" strokeWidth={2} fillOpacity={1} fill="url(#colorSent)" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}
