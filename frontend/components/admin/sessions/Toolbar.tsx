"use client";
import { useState, useRef, useEffect } from "react";
import { Search, SlidersHorizontal, Columns3, Rows3, X, Check } from "lucide-react";
import { VIEW_DEFS, type SessionView, type SessionFilters, activeFilterCount } from "./views";
import { COLUMNS, type ColumnKey, type Density } from "./columns";

export default function Toolbar({
  view, viewCounts, onView,
  search, onSearch,
  filters, onOpenFilters, onRemoveFilter, onClearFilters,
  visible, onToggleColumn,
  density, onDensity,
}: {
  view: SessionView;
  viewCounts: Record<SessionView, number>;
  onView: (v: SessionView) => void;
  search: string;
  onSearch: (q: string) => void;
  filters: SessionFilters;
  onOpenFilters: () => void;
  onRemoveFilter: (key: keyof SessionFilters) => void;
  onClearFilters: () => void;
  visible: Record<ColumnKey, boolean>;
  onToggleColumn: (key: ColumnKey) => void;
  density: Density;
  onDensity: (d: Density) => void;
}) {
  const [colMenu, setColMenu] = useState(false);
  const [densMenu, setDensMenu] = useState(false);
  const colRef = useRef<HTMLDivElement>(null);
  const densRef = useRef<HTMLDivElement>(null);
  const fcount = activeFilterCount(filters);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (colRef.current && !colRef.current.contains(e.target as Node)) setColMenu(false);
      if (densRef.current && !densRef.current.contains(e.target as Node)) setDensMenu(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, []);

  const chips = buildChips(filters);

  return (
    <div className="space-y-3">
      {/* Operational views */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-dark-850 border border-dark-700/60 p-1">
        {VIEW_DEFS.map((v) => {
          const active = view === v.key;
          return (
            <button
              key={v.key}
              onClick={() => onView(v.key)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                ${active ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"}`}
            >
              {v.label}
              <span className={`tabular-nums rounded px-1 text-[10px] ${active ? "bg-white/20" : "bg-dark-700 text-dark-400"}`}>
                {viewCounts[v.key] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + tools */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search account, ID, session file or AdBot…"
            className="w-full rounded-lg border border-dark-700 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <button
          onClick={onOpenFilters}
          className="inline-flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-200 hover:bg-dark-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span className="hidden sm:inline">Filters</span>
          {fcount > 0 && <span className="rounded bg-accent px-1.5 text-[10px] font-semibold text-white">{fcount}</span>}
        </button>

        {/* Columns */}
        <div className="relative hidden md:block" ref={colRef}>
          <button
            onClick={() => setColMenu((v) => !v)}
            aria-label="Columns"
            className="inline-flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-200 hover:bg-dark-700 transition-colors"
          >
            <Columns3 className="h-4 w-4" /> <span className="hidden lg:inline">Columns</span>
          </button>
          {colMenu && (
            <div className="absolute right-0 mt-1.5 w-52 rounded-xl border border-dark-700 bg-dark-850 p-1 shadow-2xl z-30 animate-scale-in origin-top-right">
              {COLUMNS.map((c) => {
                const on = visible[c.key];
                return (
                  <button
                    key={c.key}
                    disabled={c.required}
                    onClick={() => onToggleColumn(c.key)}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm text-dark-200 hover:bg-dark-700 disabled:opacity-40 disabled:cursor-not-allowed text-left"
                  >
                    <span>{c.label}{c.required && <span className="text-[10px] text-dark-500 ml-1">req</span>}</span>
                    {on && <Check className="h-3.5 w-3.5 text-accent" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Density */}
        <div className="relative hidden md:block" ref={densRef}>
          <button
            onClick={() => setDensMenu((v) => !v)}
            aria-label="Density"
            className="inline-flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-dark-200 hover:bg-dark-700 transition-colors"
          >
            <Rows3 className="h-4 w-4" /> <span className="hidden lg:inline capitalize">{density}</span>
          </button>
          {densMenu && (
            <div className="absolute right-0 mt-1.5 w-40 rounded-xl border border-dark-700 bg-dark-850 p-1 shadow-2xl z-30 animate-scale-in origin-top-right">
              {(["comfortable", "compact"] as Density[]).map((d) => (
                <button
                  key={d}
                  onClick={() => { onDensity(d); setDensMenu(false); }}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm text-dark-200 hover:bg-dark-700 capitalize text-left"
                >
                  {d}{density === d && <Check className="h-3.5 w-3.5 text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-accent-200 animate-scale-in">
              {c.label}
              <button onClick={() => onRemoveFilter(c.key)} aria-label={`Remove ${c.label}`} className="hover:text-white">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button onClick={onClearFilters} className="text-[11px] text-dark-500 hover:text-dark-300 px-1">Clear all</button>
        </div>
      )}
    </div>
  );
}

function buildChips(f: SessionFilters): Array<{ key: keyof SessionFilters; label: string }> {
  const out: Array<{ key: keyof SessionFilters; label: string }> = [];
  if (f.pool) out.push({ key: "pool", label: `Pool: ${f.pool}` });
  if (f.health) out.push({ key: "health", label: `Health: ${f.health}` });
  if (f.assignment) out.push({ key: "assignment", label: `Assignment: ${f.assignment}` });
  if (f.bot) out.push({ key: "bot", label: `Bot: ${f.bot}` });
  if (f.botState) out.push({ key: "botState", label: `State: ${f.botState}` });
  if (f.enabled) out.push({ key: "enabled", label: `${f.enabled}` });
  if (f.validation) out.push({ key: "validation", label: `Validation: ${f.validation}` });
  if (f.starred) out.push({ key: "starred", label: "Starred" });
  return out;
}
