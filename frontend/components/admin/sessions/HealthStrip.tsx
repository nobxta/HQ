"use client";
import type { SessionsOverviewSummary, SessionHealth } from "@/lib/types";
import { HEALTH_META } from "./shared";

const ORDER: SessionHealth[] = ["healthy", "limited", "frozen", "unauthorized", "dead", "unknown"];

export default function HealthStrip({
  summary, activeHealth, onPick,
}: {
  summary: SessionsOverviewSummary;
  activeHealth: SessionHealth | "";
  onPick: (h: SessionHealth) => void;
}) {
  const counts: Record<SessionHealth, number> = {
    healthy: summary.healthy, limited: summary.limited, frozen: summary.frozen,
    unauthorized: summary.unauthorized, dead: summary.dead, unknown: summary.unknown,
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dark-700/60 bg-dark-850 px-3 py-2">
      {ORDER.map((h) => {
        const m = HEALTH_META[h];
        const active = activeHealth === h;
        return (
          <button
            key={h}
            onClick={() => onPick(h)}
            aria-pressed={active}
            className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
              ${active ? "bg-dark-700 ring-1 ring-accent/40" : "hover:bg-dark-800"}`}
          >
            <span className={`h-2 w-2 rounded-full ${m.dot}`} aria-hidden />
            <span className="text-dark-300">{m.label}</span>
            <span className={`tabular-nums font-semibold ${counts[h] ? m.text : "text-dark-500"}`}>{counts[h]}</span>
          </button>
        );
      })}
    </div>
  );
}
