"use client";
import { useState, useRef, useEffect } from "react";
import {
  MoreHorizontal, Eye, ExternalLink, ShieldCheck, Shield, LinkIcon,
  ArrowRightLeft, Star, Trash2, Power, Repeat, Unlink, Bot, Activity,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SessionOverviewItem } from "@/lib/types";
import { isAssigned } from "./shared";

export interface SessionActions {
  onDetails: (s: SessionOverviewItem) => void;
  onOpenClient: (s: SessionOverviewItem) => void;
  onOpenBot: (s: SessionOverviewItem) => void;
  onValidate: (s: SessionOverviewItem) => void;
  onSpambot: (s: SessionOverviewItem) => void;
  onAssign: (s: SessionOverviewItem) => void;
  onMove: (s: SessionOverviewItem) => void;
  onSetStatus: (s: SessionOverviewItem) => void;
  onStar: (s: SessionOverviewItem) => void;
  onDelete: (s: SessionOverviewItem) => void;
  onUnassign: (s: SessionOverviewItem) => void;
  onToggleEnabled: (s: SessionOverviewItem) => void;
  onReplace: (s: SessionOverviewItem) => void;
}

interface Item {
  label: string; icon: LucideIcon; fn: () => void; danger?: boolean; separator?: boolean;
}

export function buildMenuItems(s: SessionOverviewItem, a: SessionActions): Item[] {
  const items: Item[] = [
    { label: "View details", icon: Eye, fn: () => a.onDetails(s) },
    { label: "Open Telegram client", icon: ExternalLink, fn: () => a.onOpenClient(s) },
  ];

  if (isAssigned(s)) {
    items.push({ label: "Open assigned AdBot", icon: Bot, fn: () => a.onOpenBot(s) });
    items.push({ label: "Validate safely", icon: ShieldCheck, fn: () => a.onValidate(s) });
    items.push({ label: s.disabled ? "Enable (use in ads)" : "Disable (pause in ads)", icon: Power, fn: () => a.onToggleEnabled(s) });
    items.push({ label: "Replace session", icon: Repeat, fn: () => a.onReplace(s) });
    items.push({ label: "Change health status", icon: Activity, fn: () => a.onSetStatus(s) });
    items.push({ label: s.starred ? "Unstar" : "Star", icon: Star, fn: () => a.onStar(s) });
    items.push({ label: "Unassign", icon: Unlink, fn: () => a.onUnassign(s), danger: true, separator: true });
  } else {
    items.push({ label: "Validate", icon: ShieldCheck, fn: () => a.onValidate(s) });
    // SpamBot only meaningful on non-failure unassigned sessions
    if (s.pool === "free" || s.pool === "limited" || s.pool === "frozen") {
      items.push({ label: "SpamBot check", icon: Shield, fn: () => a.onSpambot(s) });
    }
    if (s.pool === "free") {
      items.push({ label: "Assign to AdBot", icon: LinkIcon, fn: () => a.onAssign(s) });
    }
    items.push({ label: "Move to pool", icon: ArrowRightLeft, fn: () => a.onMove(s) });
    items.push({ label: s.starred ? "Unstar" : "Star", icon: Star, fn: () => a.onStar(s) });
    items.push({ label: "Delete", icon: Trash2, fn: () => a.onDelete(s), danger: true, separator: true });
  }
  return items;
}

export default function SessionActionsMenu({
  session, actions, align = "right",
}: {
  session: SessionOverviewItem;
  actions: SessionActions;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", k); };
  }, [open]);

  const items = buildMenuItems(session, actions);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Session actions"
        aria-expanded={open}
        className="inline-flex items-center justify-center rounded-lg p-1.5 text-dark-500 hover:text-dark-200 hover:bg-dark-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 w-56 rounded-xl border border-dark-700 bg-dark-850 p-1 shadow-2xl z-40 animate-scale-in ${align === "right" ? "origin-top-right" : "origin-top-left"}`}
        >
          {items.map((it) => (
            <div key={it.label}>
              {it.separator && <div className="my-1 h-px bg-dark-700" />}
              <button
                onClick={() => { setOpen(false); it.fn(); }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-left transition-colors
                  ${it.danger ? "text-danger hover:bg-danger/10" : "text-dark-200 hover:bg-dark-700"}`}
              >
                <it.icon className={`h-4 w-4 ${it.danger ? "text-danger" : "text-dark-400"}`} /> {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
