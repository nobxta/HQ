"use client";
import { CheckCircle2 } from "lucide-react";
import type { BotFailureReasons } from "@/lib/hooks/useAdbots";

const REASON_COLORS: Record<string, string> = {
  flood_wait: "#F59E0B",
  peer_flood: "#F59E0B",
  banned: "#EF4444",
  auth: "#EF4444",
  frozen: "#EF4444",
  private: "#98A2B3",
  no_permission: "#98A2B3",
  topic_closed: "#38BDF8",
  payment_required: "#38BDF8",
  unknown: "#667085",
};

export default function FailureReasonsChart({ data, loading }: {
  data: BotFailureReasons | null | undefined;
  loading: boolean;
}) {
  if (loading && !data) {
    return (
      <div className="space-y-2.5">
        {[0, 1, 2].map((i) => <div key={i} className="h-6 animate-pulse rounded-[8px] bg-white/[0.04]" />)}
      </div>
    );
  }
  const reasons = (data?.reasons || []).slice(0, 6);
  if (reasons.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-[10px] border border-hq-border bg-hq-elev px-3 py-2.5">
        <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "#22C55E" }} strokeWidth={1.75} />
        <p className="text-[12px] text-hq-sub">No active failure pattern</p>
      </div>
    );
  }

  const max = Math.max(...reasons.map((r) => r.count), 1);

  return (
    <div className="space-y-2.5">
      {reasons.map((r) => {
        const color = REASON_COLORS[r.key] || "#667085";
        return (
          <div key={r.key} className="flex items-center gap-3">
            <span className="w-28 sm:w-32 shrink-0 text-[12px] text-hq-sub truncate" title={r.sessions.length ? `Accounts: ${r.sessions.join(", ")}` : undefined}>
              {r.label}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-hq-bg overflow-hidden">
              <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${(r.count / max) * 100}%`, background: color }} />
            </div>
            <span className="w-8 text-right text-[12px] font-medium text-hq-text tabular-nums shrink-0">{r.count}</span>
          </div>
        );
      })}
    </div>
  );
}
