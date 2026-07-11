"use client";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, Shield, LinkIcon, ArrowRightLeft, Star, Trash2, Power, Unlink, X } from "lucide-react";
import type { SessionOverviewItem } from "@/lib/types";
import { Avatar, accountName } from "./shared";

export interface BulkHandlers {
  onValidate: () => void;
  onSpambot: () => void;
  onAssign: () => void;
  onMove: () => void;
  onStar: () => void;
  onDelete: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onUnassign: () => void;
  onClear: () => void;
}

function Btn({ icon: Icon, label, onClick, danger }: { icon: typeof Star; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors
        ${danger ? "text-danger hover:bg-danger/10" : "text-dark-200 hover:bg-dark-700"}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

export default function BulkActionBar({
  selected, handlers,
}: {
  selected: SessionOverviewItem[];
  handlers: BulkHandlers;
}) {
  const n = selected.length;
  const allFree = n > 0 && selected.every((s) => s.pool === "free");
  const allUnassigned = n > 0 && selected.every((s) => !s.bot_name);
  const bots = new Set(selected.map((s) => s.bot_name).filter(Boolean));
  const allAssignedSameBot = n > 0 && selected.every((s) => s.bot_name) && bots.size === 1;

  return (
    <AnimatePresence>
      {n > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="sticky bottom-3 z-30 mx-auto flex max-w-4xl flex-wrap items-center gap-2 rounded-xl border border-dark-600 bg-dark-850/95 backdrop-blur px-3 py-2 shadow-2xl"
        >
          <div className="flex items-center gap-2 pr-2 mr-1 border-r border-dark-700">
            <div className="flex -space-x-2">
              {selected.slice(0, 4).map((s) => (
                <div key={s.filename} className="ring-2 ring-dark-850 rounded-full"><Avatar name={accountName(s)} id={s.user_id} size={22} /></div>
              ))}
            </div>
            <span className="text-xs font-medium text-dark-200 tabular-nums">{n} selected</span>
          </div>

          {/* Shared-safe actions */}
          <Btn icon={ShieldCheck} label="Validate" onClick={handlers.onValidate} />
          <Btn icon={Star} label="Star" onClick={handlers.onStar} />

          {allFree && (
            <>
              <Btn icon={Shield} label="SpamBot" onClick={handlers.onSpambot} />
              <Btn icon={LinkIcon} label="Assign" onClick={handlers.onAssign} />
            </>
          )}
          {allUnassigned && <Btn icon={ArrowRightLeft} label="Move" onClick={handlers.onMove} />}
          {allUnassigned && <Btn icon={Trash2} label="Delete" onClick={handlers.onDelete} danger />}

          {allAssignedSameBot && (
            <>
              <Btn icon={Power} label="Enable" onClick={handlers.onEnable} />
              <Btn icon={Power} label="Disable" onClick={handlers.onDisable} />
              <Btn icon={Unlink} label="Unassign" onClick={handlers.onUnassign} danger />
            </>
          )}

          <button onClick={handlers.onClear} aria-label="Clear selection" className="ml-auto p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700">
            <X className="h-4 w-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
