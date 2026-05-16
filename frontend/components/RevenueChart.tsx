"use client";
import { useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const ranges = ["7d", "30d", "90d"] as const;

interface RevenueChartProps {
  data?: Array<{ date: string; revenue: number; orders: number }>;
}

export default function RevenueChart({ data }: RevenueChartProps) {
  const [range, setRange] = useState<(typeof ranges)[number]>("30d");

  const chartData = data || [];

  return (
    <div className="rounded-2xl border border-dark-700/30 bg-dark-850 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-dark-800/50">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-accent/15 flex items-center justify-center">
            <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-dark-100">Revenue Overview</h3>
            <p className="text-[10px] text-dark-600">Real-time performance updates</p>
          </div>
        </div>

        {/* Period selector */}
        <div className="flex gap-0.5 rounded-xl bg-dark-800/80 p-1 border border-dark-700/30">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
                range === r
                  ? "bg-dark-700 text-white shadow-sm"
                  : "text-dark-500 hover:text-dark-300"
              }`}
            >
              {r === "7d" ? "Weekly" : r === "30d" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="px-5 pt-4 pb-2">
        <div className="h-72">
          {chartData.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-dark-500">
              <svg className="h-12 w-12 text-dark-700 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M3 3v18h18" /><path d="m7 14 4-4 4 4 5-5" />
              </svg>
              <p className="text-sm font-medium text-dark-400">Revenue Tracking</p>
              <p className="text-xs text-dark-600 mt-1">Data will appear once orders come in</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6c5ce7" stopOpacity={0.3} />
                    <stop offset="50%" stopColor="#6c5ce7" stopOpacity={0.1} />
                    <stop offset="100%" stopColor="#6c5ce7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e1e30" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="#4a4a5a"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  dy={8}
                />
                <YAxis
                  stroke="#4a4a5a"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  dx={-8}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#252533",
                    border: "1px solid rgba(108, 92, 231, 0.2)",
                    borderRadius: "12px",
                    fontSize: "12px",
                    padding: "12px 16px",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                  }}
                  labelStyle={{ color: "#acacbe", marginBottom: "4px" }}
                  cursor={{ stroke: "#6c5ce7", strokeWidth: 1, strokeDasharray: "4 4" }}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#6c5ce7"
                  strokeWidth={2.5}
                  fill="url(#revGradient)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#6c5ce7", stroke: "#252533", strokeWidth: 3 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
