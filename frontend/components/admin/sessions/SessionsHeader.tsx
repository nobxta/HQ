"use client";
import { useState, useRef, useEffect } from "react";
import { RefreshCw, Upload, MoreHorizontal, ShieldCheck, Shield, History } from "lucide-react";
import { timeAgo } from "@/lib/utils";

export default function SessionsHeader({
  lastSyncedSec, refreshing, onRefresh, onUpload,
  onValidateAllReady, onSpambotReady, onViewActivity,
}: {
  lastSyncedSec: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  onUpload: () => void;
  onValidateAllReady: () => void;
  onSpambotReady: () => void;
  onViewActivity: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menu]);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-[22px] sm:text-2xl font-bold text-dark-50">Sessions</h1>
        <p className="text-sm text-dark-500 mt-0.5">Manage session inventory, health, assignments and replacements.</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden sm:flex items-center gap-1.5 text-xs text-dark-500 mr-1">
          <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
          {lastSyncedSec != null ? `Last synced ${timeAgo(lastSyncedSec)}` : "Syncing…"}
        </span>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh sessions"
          className="inline-flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-200 hover:bg-dark-700 transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
        <button
          onClick={onUpload}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-lg shadow-accent/20 hover:bg-accent-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Upload className="h-4 w-4" /> Upload sessions
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenu((v) => !v)}
            aria-label="More actions"
            aria-expanded={menu}
            className="inline-flex items-center justify-center rounded-lg border border-dark-700 bg-dark-800 h-[38px] w-[38px] text-dark-300 hover:bg-dark-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && (
            <div className="absolute right-0 mt-1.5 w-60 rounded-xl border border-dark-700 bg-dark-850 p-1 shadow-2xl z-30 animate-scale-in origin-top-right">
              {[
                { label: "Validate all ready sessions", icon: ShieldCheck, fn: onValidateAllReady },
                { label: "SpamBot check ready sessions", icon: Shield, fn: onSpambotReady },
                { label: "View session audit activity", icon: History, fn: onViewActivity },
                { label: "Refresh data", icon: RefreshCw, fn: onRefresh },
              ].map((it) => (
                <button
                  key={it.label}
                  onClick={() => { setMenu(false); it.fn(); }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-dark-200 hover:bg-dark-700 transition-colors text-left"
                >
                  <it.icon className="h-4 w-4 text-dark-400" /> {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
