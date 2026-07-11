"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { EMPTY_FILTERS, type SessionFilters } from "./views";
import type { SessionPool, SessionHealth } from "@/lib/types";

const POOLS: SessionPool[] = ["free", "assigned", "dead", "frozen", "limited", "unauth"];
const HEALTHS: SessionHealth[] = ["healthy", "limited", "frozen", "unauthorized", "dead", "unknown"];

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-dark-500">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs capitalize transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${active ? "border-accent bg-accent/15 text-accent-200" : "border-dark-700 text-dark-400 hover:border-dark-500"}`}
    >
      {children}
    </button>
  );
}

export default function FiltersPanel({
  open, onClose, value, onApply, bots,
}: {
  open: boolean;
  onClose: () => void;
  value: SessionFilters;
  onApply: (f: SessionFilters) => void;
  bots: string[];
}) {
  const [draft, setDraft] = useState<SessionFilters>(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);

  const set = <K extends keyof SessionFilters>(k: K, v: SessionFilters[K]) =>
    setDraft((d) => ({ ...d, [k]: d[k] === v ? (typeof v === "boolean" ? false : "") as SessionFilters[K] : v }));

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose}
          />
          <motion.aside
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[380px] flex-col border-l border-dark-700 bg-dark-900 shadow-2xl"
            role="dialog" aria-label="Filters"
          >
            <div className="flex items-center justify-between border-b border-dark-700 px-4 py-3">
              <p className="text-sm font-semibold text-dark-100">Filters</p>
              <button onClick={onClose} aria-label="Close filters" className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <Group label="Location / pool">
                {POOLS.map((p) => <Chip key={p} active={draft.pool === p} onClick={() => set("pool", p)}>{p}</Chip>)}
              </Group>
              <Group label="Health">
                {HEALTHS.map((h) => <Chip key={h} active={draft.health === h} onClick={() => set("health", h)}>{h}</Chip>)}
              </Group>
              <Group label="Assignment">
                <Chip active={draft.assignment === "assigned"} onClick={() => set("assignment", "assigned")}>Assigned</Chip>
                <Chip active={draft.assignment === "free"} onClick={() => set("assignment", "free")}>Unassigned</Chip>
              </Group>
              {bots.length > 0 && (
                <Group label="Assigned AdBot">
                  {bots.map((b) => <Chip key={b} active={draft.bot === b} onClick={() => set("bot", b)}>{b}</Chip>)}
                </Group>
              )}
              <Group label="Bot state">
                <Chip active={draft.botState === "running"} onClick={() => set("botState", "running")}>Running</Chip>
                <Chip active={draft.botState === "stopped"} onClick={() => set("botState", "stopped")}>Stopped</Chip>
              </Group>
              <Group label="Enabled / disabled">
                <Chip active={draft.enabled === "enabled"} onClick={() => set("enabled", "enabled")}>Enabled</Chip>
                <Chip active={draft.enabled === "disabled"} onClick={() => set("enabled", "disabled")}>Disabled</Chip>
              </Group>
              <Group label="Validation">
                <Chip active={draft.validation === "valid"} onClick={() => set("validation", "valid")}>Valid</Chip>
                <Chip active={draft.validation === "invalid"} onClick={() => set("validation", "invalid")}>Invalid</Chip>
                <Chip active={draft.validation === "unchecked"} onClick={() => set("validation", "unchecked")}>Unchecked</Chip>
              </Group>
              <Group label="Starred">
                <Chip active={draft.starred} onClick={() => set("starred", true)}>Starred only</Chip>
              </Group>
            </div>

            <div className="flex gap-2 border-t border-dark-700 p-3">
              <button
                onClick={() => setDraft(EMPTY_FILTERS)}
                className="flex-1 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-300 hover:bg-dark-700"
              >
                Clear all
              </button>
              <button
                onClick={() => { onApply(draft); onClose(); }}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-600"
              >
                Apply filters
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
