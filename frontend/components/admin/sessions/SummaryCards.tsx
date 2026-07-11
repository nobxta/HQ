"use client";
import { Boxes, PackageCheck, Radio, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SessionsOverviewSummary } from "@/lib/types";
import type { SessionView } from "./views";

interface CardDef {
  key: string;
  label: string;
  value: number;
  sub: string;
  icon: LucideIcon;
  tint: string;
  view: SessionView;
}

export default function SummaryCards({
  summary, activeView, onPick,
}: {
  summary: SessionsOverviewSummary;
  activeView: SessionView;
  onPick: (v: SessionView) => void;
}) {
  const cards: CardDef[] = [
    {
      key: "total", label: "Total Sessions", value: summary.total,
      sub: `${summary.assigned} assigned · ${summary.ready} available`,
      icon: Boxes, tint: "text-dark-200", view: "all",
    },
    {
      key: "ready", label: "Ready to Assign", value: summary.ready,
      sub: "Unassigned in the ready pool",
      icon: PackageCheck, tint: "text-emerald-400", view: "ready",
    },
    {
      key: "inuse", label: "In Use", value: summary.assigned,
      sub: `${summary.enabled} enabled · ${summary.disabled} disabled`,
      icon: Radio, tint: "text-accent-300", view: "assigned",
    },
    {
      key: "attention", label: "Needs Attention", value: summary.needs_attention,
      sub: summary.needs_attention ? "Dead, limited, frozen or unauthorized" : "No issues found",
      icon: AlertTriangle, tint: summary.needs_attention ? "text-amber-400" : "text-emerald-400",
      view: "needs_action",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {cards.map((c) => {
        const active = activeView === c.view;
        const Icon = c.icon;
        return (
          <div
            key={c.key}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            onClick={() => onPick(c.view)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.view); }
            }}
            className={`group relative rounded-xl border bg-dark-850 p-4 cursor-pointer transition-all duration-150
              hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
              ${active ? "border-accent/60 bg-dark-800" : "border-dark-700/60 hover:border-dark-600"}`}
          >
            <div className="flex items-start justify-between">
              <p className="text-xs font-medium text-dark-500">{c.label}</p>
              <Icon className={`h-4 w-4 ${c.tint} opacity-70`} aria-hidden />
            </div>
            <p className={`mt-2 text-[26px] leading-none font-bold tabular-nums ${c.tint}`}>{c.value}</p>
            <p className="mt-2 text-[11px] text-dark-500 line-clamp-1">{c.sub}</p>
            {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent/70" />}
          </div>
        );
      })}
    </div>
  );
}
