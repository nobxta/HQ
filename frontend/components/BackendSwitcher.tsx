"use client";
import { useEffect, useState } from "react";
import { Server, Check } from "lucide-react";
import {
  BACKEND_PRESETS,
  getApiBase,
  isLocalDevHost,
  setApiBase,
} from "@/lib/api-base";

/**
 * Local-dev-only backend picker. Renders nothing unless the page is served from a local
 * host (localhost / LAN), so it can never appear on the live public domain. Lets you flip
 * the frontend between the local FastAPI backend and the VPS backend without rebuilding.
 */
export default function BackendSwitcher() {
  const [mounted, setMounted] = useState(false);
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    setMounted(true);
    setCurrent(getApiBase());
  }, []);

  // Guard: only on local dev host, and only after mount (avoids SSR/hydration mismatch).
  if (!mounted || !isLocalDevHost()) return null;

  const select = (url: string) => {
    setApiBase(url);
    setCurrent(url);
  };

  const isCustom = !BACKEND_PRESETS.some((p) => p.url === current);

  return (
    <div className="w-full rounded-xl border border-dashed border-[#2AABEE]/40 bg-[#0e0e10] p-3.5 space-y-2.5">
      <div className="flex items-center gap-2 text-[#8b8b93]">
        <Server className="h-3.5 w-3.5" style={{ color: "#2AABEE" }} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          Backend (local testing only)
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {BACKEND_PRESETS.map((p) => {
          const active = current === p.url;
          return (
            <button
              key={p.url}
              type="button"
              onClick={() => select(p.url)}
              title={p.hint}
              className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-all ${
                active
                  ? "border-[#2AABEE] bg-[#2AABEE]/10"
                  : "border-[#1f1f22] bg-[#0a0a0a] hover:border-[#2AABEE]/40"
              }`}
            >
              <span className="flex items-center gap-1 text-xs font-semibold text-white">
                {active && <Check className="h-3 w-3" style={{ color: "#2AABEE" }} />}
                {p.label}
              </span>
              <span className="text-[10px] text-[#5d5d66] font-mono truncate w-full">
                {p.url.replace(/^https?:\/\//, "")}
              </span>
            </button>
          );
        })}
      </div>

      <input
        type="text"
        value={current}
        onChange={(e) => select(e.target.value.trim())}
        placeholder="or a custom URL…"
        spellCheck={false}
        className="w-full rounded-lg border border-[#1f1f22] bg-[#0a0a0a] px-2.5 py-1.5 text-[11px] text-white font-mono placeholder:text-[#5d5d66] focus:outline-none focus:border-[#2AABEE]/60"
      />

      <p className="text-[10px] text-[#5d5d66] leading-snug">
        {isCustom ? "Custom backend. " : ""}
        Only visible on localhost — hidden on the live site, so no one can repoint the
        production backend.
      </p>
    </div>
  );
}
