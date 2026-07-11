"use client";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import type { SessionsOverview } from "@/lib/types";

export default function AttentionBanner({
  overview, onReview,
}: {
  overview: SessionsOverview | undefined;
  onReview: () => void;
}) {
  const s = overview?.summary;
  const count = s?.needs_attention ?? 0;
  const parts: string[] = [];
  if (s) {
    if (s.unauthorized) parts.push(`${s.unauthorized} unauthorized`);
    if (s.frozen) parts.push(`${s.frozen} frozen`);
    if (s.limited) parts.push(`${s.limited} limited`);
    if (s.dead) parts.push(`${s.dead} dead`);
  }
  const detail = parts.length ? parts.join(" · ") : "Sessions require review";

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3"
          role="status"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 shrink-0">
            <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-dark-100">
              {count} session{count === 1 ? "" : "s"} need attention
            </p>
            <p className="text-xs text-dark-400 truncate">{detail}</p>
          </div>
          <button
            onClick={onReview}
            className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            Review sessions
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
