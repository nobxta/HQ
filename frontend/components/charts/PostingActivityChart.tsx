"use client";
import {
  ResponsiveContainer, ComposedChart, Area, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
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
    <div className="h-[220px] sm:h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="sentFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.sent} stopOpacity={0.18} />
              <stop offset="100%" stopColor={COLORS.sent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
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
            tick={{ fill: COLORS.axis, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            width={44}
          />
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
                    { label: "Success", value: p.rate === null ? "—" : `${p.rate}%`, color: "#22C55E" },
                  ]}
                />
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="sent"
            name="Sent"
            stroke={COLORS.sent}
            strokeWidth={1.75}
            fill="url(#sentFill)"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: COLORS.sent }}
            animationDuration={300}
          />
          <Bar dataKey="failed" name="Failed" fill={COLORS.failed} maxBarSize={6} radius={[2, 2, 0, 0]} animationDuration={300} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
