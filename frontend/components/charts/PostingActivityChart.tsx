"use client";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from "recharts";
import type { BotAnalytics } from "@/lib/hooks/useAdbots";
import ChartTooltip from "./ChartTooltip";
import ChartEmptyState from "./ChartEmptyState";

const COLORS = { sent: "#7C5CFF", failed: "#EF4444", grid: "#2A3040", axis: "#98A2B3" };

/* Format a bucket timestamp for the X axis / tooltip based on bucket size. */
function formatBucket(ts: number, bucketSeconds: number, long = false): string {
  const d = new Date(ts * 1000);
  if (bucketSeconds < 86400) {
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return long ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}` : time;
  }
  const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return day;
}

export default function PostingActivityChart({ analytics, loading }: {
  analytics: BotAnalytics | null | undefined;
  loading: boolean;
}) {
  const points = analytics?.points || [];
  const bucket = analytics?.bucket_seconds || 3600;
  const hasData = points.some((p) => p.sent > 0 || p.failed > 0);

  if (loading && !analytics) {
    return <div className="h-[220px] sm:h-[300px] animate-pulse rounded-[12px] bg-white/[0.04]" />;
  }
  if (!hasData) {
    return (
      <div className="h-[220px] sm:h-[300px] flex items-center justify-center">
        <ChartEmptyState title="No posting activity yet" hint="Start the bot to generate analytics." height={200} />
      </div>
    );
  }

  const data = points.map((p) => {
    const total = p.sent + p.failed;
    return {
      ...p,
      label: formatBucket(p.ts, bucket),
      longLabel: formatBucket(p.ts, bucket, true),
      rate: total > 0 ? Math.round((p.sent / total) * 1000) / 10 : null,
    };
  });
  // Keep X labels readable: cap ticks to ~8 evenly spaced.
  const tickGap = Math.max(1, Math.ceil(data.length / 8));

  return (
    <div className="h-[240px] sm:h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
          <CartesianGrid stroke={COLORS.grid} strokeOpacity={0.5} vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="label"
            tick={{ fill: COLORS.axis, fontSize: 11 }}
            axisLine={{ stroke: COLORS.grid }}
            tickLine={false}
            interval={tickGap - 1}
            minTickGap={16}
          />
          <YAxis
            yAxisId="volume"
            tick={{ fill: COLORS.axis, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            width={48}
          />
          <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: COLORS.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
          <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11, color: COLORS.axis, paddingTop: 8 }} />
          <Tooltip
            cursor={{ stroke: COLORS.grid, strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p: any = payload[0].payload;
              return (
                <ChartTooltip
                  header={p.longLabel}
                  rows={[
                    { label: "Sent", value: p.sent.toLocaleString(), color: COLORS.sent },
                    { label: "Failed", value: p.failed.toLocaleString(), color: COLORS.failed },
                    { label: "Attempted", value: (p.sent + p.failed).toLocaleString(), color: COLORS.axis },
                    { label: "Success", value: p.rate === null ? "—" : `${p.rate}%`, color: "#22C55E" },
                  ]}
                />
              );
            }}
          />
          <Bar
            yAxisId="volume"
            dataKey="sent"
            name="Delivered"
            fill={COLORS.sent}
            stackId="volume"
            maxBarSize={28}
            animationDuration={300}
          />
          <Bar yAxisId="volume" dataKey="failed" name="Failed" fill={COLORS.failed} stackId="volume" maxBarSize={28} radius={[3, 3, 0, 0]} animationDuration={300} />
          <Line yAxisId="rate" type="linear" dataKey="rate" name="Success rate" stroke="#22C55E" strokeWidth={2} dot={false} activeDot={{ r: 3 }} connectNulls={false} animationDuration={300} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
